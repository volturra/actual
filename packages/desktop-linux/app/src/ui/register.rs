//! The account register: a header with the account's cleared, uncleared
//! and working balances (YNAB4's header strip), a transaction editor bar,
//! and the transaction list with a running balance. Selecting a row loads it
//! into the editor; Enter saves, Escape cancels, Delete removes.

use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::rc::{Rc, Weak};

use adw::prelude::*;
use chrono::{Datelike, NaiveDate};

use actual_budget::model::{self, Transaction};
use actual_budget::month::Month;
use actual_budget::ops::{self, NewTransaction, SplitLine, TransactionUpdate};
use actual_budget::BudgetError;

use super::autocomplete::{Autocomplete, Choice};
use super::{dialogs, App, View};

#[derive(Clone, Debug, Default)]
struct Row {
    id: String,
    /// The split parent this line belongs to.
    parent: Option<String>,
    is_parent: bool,
    is_child: bool,
    date: String,
    account: String,
    payee: String,
    category: String,
    notes: String,
    amount: i64,
    balance: Option<i64>,
    cleared: bool,
    reconciled: bool,
    split_error: bool,
}

/// What the editor holds: the transaction being edited (`None` = new) and
/// its split lines, if it's a split.
#[derive(Default)]
struct EditState {
    id: Option<String>,
    original: Option<Transaction>,
    /// The editor's fields as loaded, to tell whether the user changed them.
    loaded: String,
    splits: Option<Vec<SplitLine>>,
}

struct Editor {
    root: gtk::Box,
    heading: gtk::Label,
    account: gtk::DropDown,
    account_ids: RefCell<Vec<String>>,
    date: gtk::Entry,
    payee: Autocomplete,
    category: Autocomplete,
    split_button: gtk::Button,
    notes: gtk::Entry,
    outflow: gtk::Entry,
    inflow: gtk::Entry,
    cleared: gtk::CheckButton,
    delete: gtk::Button,
    save: gtk::Button,
    state: RefCell<EditState>,
}

pub struct Register {
    app: Weak<App>,
    root: gtk::Box,
    title: gtk::Label,
    cleared_label: gtk::Label,
    uncleared_label: gtk::Label,
    working_label: gtk::Label,
    balances: gtk::Box,
    reconcile: gtk::Button,
    account_menu: gtk::MenuButton,
    search: gtk::SearchEntry,
    filter_bar: gtk::Box,
    filter_label: gtk::Label,
    store: gtk::gio::ListStore,
    selection: gtk::SingleSelection,
    view: gtk::ColumnView,
    account_col: gtk::ColumnViewColumn,
    balance_col: gtk::ColumnViewColumn,
    editor: Editor,
    account: RefCell<Option<String>>,
    filter: RefCell<Option<(String, Option<Month>)>>,
    keep_filter: Cell<bool>,
    rows: RefCell<Vec<Row>>,
    loading: Cell<bool>,
    quiet_save: Cell<bool>,
}

// ---------------------------------------------------------------- dates

/// Formats `YYYY-MM-DD` in the budget's `dateFormat` preference.
fn format_date(iso: &str, pref: &str) -> String {
    let Ok(d) = NaiveDate::parse_from_str(iso, "%Y-%m-%d") else { return iso.to_string() };
    d.format(&chrono_pattern(pref)).to_string()
}

fn chrono_pattern(pref: &str) -> String {
    pref.replace("yyyy", "%Y").replace("MM", "%m").replace("dd", "%d")
}

/// Parses a typed date in the preferred order, ISO, or a short form like
/// `5/11` (this year), the way the web date picker is forgiving.
fn parse_date(input: &str, pref: &str) -> Option<String> {
    let s = input.trim();
    if s.is_empty() {
        return None;
    }
    for pat in [chrono_pattern(pref), "%Y-%m-%d".into()] {
        // `%Y` also accepts "26"; leave two-digit years to the short form.
        if let Some(d) = NaiveDate::parse_from_str(s, &pat).ok().filter(|d| d.year() >= 1000) {
            return Some(d.format("%Y-%m-%d").to_string());
        }
    }
    // Short forms without a year, in the preferred day/month order.
    let parts: Vec<&str> = s.split(|c: char| !c.is_ascii_digit()).filter(|p| !p.is_empty()).collect();
    let day_first = pref.find("dd") < pref.find("MM");
    let year_first = pref.starts_with("yyyy");
    let today = chrono::Local::now().date_naive();
    let (y, m, d) = match parts.as_slice() {
        [a, b] if !year_first => {
            let (a, b) = (a.parse().ok()?, b.parse().ok()?);
            if day_first { (today.year(), b, a) } else { (today.year(), a, b) }
        }
        [a, b] => (today.year(), a.parse().ok()?, b.parse().ok()?),
        [a, b, c] if !year_first => {
            let (a, b, mut c): (u32, u32, i32) = (a.parse().ok()?, b.parse().ok()?, c.parse().ok()?);
            if c < 100 {
                c += 2000;
            }
            if day_first { (c, b, a) } else { (c, a, b) }
        }
        [a] => (today.year(), today.month(), a.parse().ok()?),
        _ => return None,
    };
    NaiveDate::from_ymd_opt(y, m, d).map(|d| d.format("%Y-%m-%d").to_string())
}

// ------------------------------------------------------------- columns

fn column(
    title: &str,
    width: i32,
    expand: bool,
    xalign: f32,
    text: impl Fn(&Row, &App) -> (String, Vec<&'static str>) + 'static,
    app: Weak<App>,
) -> gtk::ColumnViewColumn {
    let factory = gtk::SignalListItemFactory::new();
    factory.connect_setup(move |_, item| {
        let item = item.downcast_ref::<gtk::ListItem>().expect("list item");
        let l = gtk::Label::builder().xalign(xalign).build();
        l.set_ellipsize(gtk::pango::EllipsizeMode::End);
        item.set_child(Some(&l));
    });
    factory.connect_bind(move |_, item| {
        let item = item.downcast_ref::<gtk::ListItem>().expect("list item");
        let (Some(label), Some(obj), Some(app)) = (
            item.child().and_downcast::<gtk::Label>(),
            item.item().and_downcast::<glib::BoxedAnyObject>(),
            app.upgrade(),
        ) else {
            return;
        };
        let row = obj.borrow::<Row>();
        let (t, classes) = text(&row, &app);
        label.set_text(&t);
        label.set_tooltip_text(if t.len() > 24 { Some(&t) } else { None });
        for c in ["negative", "dim-label", "split-child", "split-error", "tnum", "reg-transfer"] {
            label.remove_css_class(c);
        }
        for c in classes {
            label.add_css_class(c);
        }
    });
    let col = gtk::ColumnViewColumn::new(Some(title), Some(factory));
    if width > 0 {
        col.set_fixed_width(width);
    }
    col.set_expand(expand);
    col.set_resizable(true);
    col
}

impl Register {
    pub fn new(app: &Rc<App>) -> Rc<Register> {
        let root = gtk::Box::new(gtk::Orientation::Vertical, 0);

        // Header: account name, balances, actions.
        let header = gtk::Box::new(gtk::Orientation::Horizontal, 16);
        header.add_css_class("account-header");
        let title = gtk::Label::builder().xalign(0.0).hexpand(true).build();
        title.add_css_class("title-1");
        title.set_ellipsize(gtk::pango::EllipsizeMode::End);
        header.append(&title);

        let balances = gtk::Box::new(gtk::Orientation::Horizontal, 10);
        let bal = |caption: &str| {
            let b = gtk::Box::new(gtk::Orientation::Vertical, 0);
            let v = gtk::Label::new(None);
            v.add_css_class("account-balance");
            v.add_css_class("tnum");
            let c = gtk::Label::new(Some(caption));
            c.add_css_class("caption");
            c.add_css_class("dim-label");
            b.append(&v);
            b.append(&c);
            (b, v)
        };
        let (cb, cleared_label) = bal("Cleared balance");
        let (ub, uncleared_label) = bal("Uncleared");
        let (wb, working_label) = bal("Working balance");
        let op = |s: &str| {
            let l = gtk::Label::new(Some(s));
            l.add_css_class("title-3");
            l.add_css_class("dim-label");
            l
        };
        balances.append(&cb);
        balances.append(&op("+"));
        balances.append(&ub);
        balances.append(&op("="));
        balances.append(&wb);
        header.append(&balances);

        let reconcile = gtk::Button::with_label("Reconcile");
        reconcile.set_valign(gtk::Align::Center);
        header.append(&reconcile);
        let account_menu = gtk::MenuButton::builder().icon_name("view-more-symbolic").valign(gtk::Align::Center).build();
        account_menu.add_css_class("flat");
        header.append(&account_menu);
        root.append(&header);

        // Toolbar: add, search, filter chip.
        let toolbar = gtk::Box::new(gtk::Orientation::Horizontal, 8);
        toolbar.add_css_class("register-toolbar");
        let add = gtk::Button::with_label("+ Add transaction");
        add.add_css_class("suggested-action");
        add.set_tooltip_text(Some("Ctrl+N"));
        toolbar.append(&add);
        let filter_bar = gtk::Box::new(gtk::Orientation::Horizontal, 4);
        filter_bar.add_css_class("filter-chip");
        let filter_label = gtk::Label::new(None);
        let clear_filter = gtk::Button::from_icon_name("window-close-symbolic");
        clear_filter.add_css_class("flat");
        clear_filter.add_css_class("circular");
        filter_bar.append(&filter_label);
        filter_bar.append(&clear_filter);
        filter_bar.set_visible(false);
        toolbar.append(&filter_bar);
        let spacer = gtk::Box::new(gtk::Orientation::Horizontal, 0);
        spacer.set_hexpand(true);
        toolbar.append(&spacer);
        let search = gtk::SearchEntry::builder().placeholder_text("Search").width_chars(24).build();
        toolbar.append(&search);
        root.append(&toolbar);

        let editor = Editor::new();
        root.append(&editor.root);

        let store = gtk::gio::ListStore::new::<glib::BoxedAnyObject>();
        let selection = gtk::SingleSelection::new(Some(store.clone()));
        selection.set_autoselect(false);
        selection.set_can_unselect(true);
        let view = gtk::ColumnView::new(Some(selection.clone()));
        view.add_css_class("register");
        view.set_show_row_separators(true);
        view.set_reorderable(false);

        let w = app.weak();
        let date_col = column(
            "Date",
            110,
            false,
            0.0,
            |r, app| {
                if r.is_child {
                    return (String::new(), vec![]);
                }
                let pref = app.date_format.borrow().clone();
                (format_date(&r.date, &pref), vec!["tnum"])
            },
            w.clone(),
        );
        let account_col = column("Account", 150, false, 0.0, |r, _| (if r.is_child { String::new() } else { r.account.clone() }, vec![]), w.clone());
        let payee_col = column(
            "Payee",
            200,
            true,
            0.0,
            |r, _| {
                if r.is_child {
                    (format!("↳ {}", r.payee), vec!["split-child"])
                } else {
                    (r.payee.clone(), vec![])
                }
            },
            w.clone(),
        );
        let category_col = column(
            "Category",
            200,
            true,
            0.0,
            |r, _| {
                if r.split_error {
                    return (r.category.clone(), vec!["split-error"]);
                }
                let dim = r.is_parent || r.category.starts_with("Transfer") || r.category == "Off budget";
                (r.category.clone(), if dim { vec!["dim-label"] } else { vec![] })
            },
            w.clone(),
        );
        let memo_col = column("Memo", 160, true, 0.0, |r, _| (r.notes.clone(), vec!["dim-label"]), w.clone());
        let out_col = column(
            "Outflow",
            110,
            false,
            1.0,
            |r, app| (if r.amount < 0 { app.fmt.get().format(-r.amount) } else { String::new() }, vec!["tnum"]),
            w.clone(),
        );
        let in_col = column(
            "Inflow",
            110,
            false,
            1.0,
            |r, app| (if r.amount > 0 { app.fmt.get().format(r.amount) } else { String::new() }, vec!["tnum"]),
            w.clone(),
        );
        let balance_col = column(
            "Balance",
            120,
            false,
            1.0,
            |r, app| match r.balance {
                Some(b) => (app.fmt.get().format(b), if b < 0 { vec!["tnum", "negative"] } else { vec!["tnum"] }),
                None => (String::new(), vec![]),
            },
            w.clone(),
        );

        // Cleared: a small toggle button, "C" cleared / "R" reconciled.
        let factory = gtk::SignalListItemFactory::new();
        let wc = app.weak();
        factory.connect_setup(move |_, item| {
            let item = item.downcast_ref::<gtk::ListItem>().expect("list item");
            let b = gtk::Button::builder().css_classes(["flat", "cleared-toggle"]).build();
            b.set_focusable(false);
            let li = item.downgrade();
            let wc = wc.clone();
            b.connect_clicked(move |_| {
                let (Some(li), Some(app)) = (li.upgrade(), wc.upgrade()) else { return };
                let Some(obj) = li.item().and_downcast::<glib::BoxedAnyObject>() else { return };
                let row = obj.borrow::<Row>().clone();
                toggle_cleared(&app, &row);
            });
            item.set_child(Some(&b));
        });
        factory.connect_bind(|_, item| {
            let item = item.downcast_ref::<gtk::ListItem>().expect("list item");
            let (Some(b), Some(obj)) = (item.child().and_downcast::<gtk::Button>(), item.item().and_downcast::<glib::BoxedAnyObject>())
            else {
                return;
            };
            let row = obj.borrow::<Row>();
            b.set_visible(!row.is_child);
            b.set_label(if row.reconciled { "R" } else if row.cleared { "C" } else { "·" });
            b.set_tooltip_text(Some(if row.reconciled {
                "Reconciled"
            } else if row.cleared {
                "Cleared (click to unclear)"
            } else {
                "Uncleared (click to clear)"
            }));
            for c in ["is-cleared", "is-reconciled"] {
                b.remove_css_class(c);
            }
            if row.reconciled {
                b.add_css_class("is-reconciled");
            } else if row.cleared {
                b.add_css_class("is-cleared");
            }
        });
        let cleared_col = gtk::ColumnViewColumn::new(Some("✓"), Some(factory));
        cleared_col.set_fixed_width(44);

        for c in [&date_col, &account_col, &payee_col, &category_col, &memo_col, &out_col, &in_col, &cleared_col, &balance_col] {
            view.append_column(c);
        }

        let scroll = gtk::ScrolledWindow::builder().child(&view).vexpand(true).build();
        root.append(&scroll);

        let reg = Rc::new(Register {
            app: app.weak(),
            root,
            title,
            cleared_label,
            uncleared_label,
            working_label,
            balances,
            reconcile,
            account_menu,
            search,
            filter_bar,
            filter_label,
            store,
            selection,
            view,
            account_col,
            balance_col,
            editor,
            account: RefCell::new(None),
            filter: RefCell::new(None),
            keep_filter: Cell::new(false),
            rows: RefCell::new(Vec::new()),
            loading: Cell::new(false),
            quiet_save: Cell::new(false),
        });

        let w = Rc::downgrade(&reg);
        reg.selection.connect_selected_notify(move |sel| {
            let Some(r) = w.upgrade() else { return };
            if r.loading.get() {
                return;
            }
            let pos = sel.selected();
            if pos == gtk::INVALID_LIST_POSITION {
                return;
            }
            let row = r.rows.borrow().get(pos as usize).cloned();
            if let Some(row) = row {
                let target = row.parent.clone().unwrap_or(row.id.clone());
                if r.editor.state.borrow().id.as_deref() == Some(target.as_str()) {
                    return;
                }
                // Moving to another row saves what was typed (like leaving a
                // row in the web register).
                if r.editor_dirty() && !r.save_quiet() {
                    // Keep the unsaved edit on screen (and selected).
                    let cur = r.editor.state.borrow().id.clone();
                    let pos = cur.and_then(|id| r.rows.borrow().iter().position(|x| x.id == id));
                    r.loading.set(true);
                    sel.set_selected(pos.map(|p| p as u32).unwrap_or(gtk::INVALID_LIST_POSITION));
                    r.loading.set(false);
                    return;
                }
                r.edit(Some(target));
            }
        });
        // Enter or double-click on a row: start editing it.
        let w = Rc::downgrade(&reg);
        reg.view.connect_activate(move |_, _| {
            if let Some(r) = w.upgrade() {
                r.editor.payee.widget().grab_focus();
            }
        });
        let w = Rc::downgrade(&reg);
        add.connect_clicked(move |_| {
            if let Some(r) = w.upgrade() {
                r.new_transaction();
            }
        });
        let w = Rc::downgrade(&reg);
        reg.search.connect_search_changed(move |_| {
            if let Some(r) = w.upgrade() {
                r.refresh();
            }
        });
        let w = Rc::downgrade(&reg);
        clear_filter.connect_clicked(move |_| {
            if let Some(r) = w.upgrade() {
                *r.filter.borrow_mut() = None;
                r.refresh();
            }
        });
        let w = Rc::downgrade(&reg);
        reg.reconcile.connect_clicked(move |_| {
            if let Some(r) = w.upgrade() {
                r.reconcile_dialog();
            }
        });
        reg.wire_editor();

        // Ctrl+N new, Delete removes the selected transaction.
        let keys = gtk::EventControllerKey::new();
        let w = Rc::downgrade(&reg);
        keys.connect_key_pressed(move |_, key, _, mods| {
            let Some(r) = w.upgrade() else { return glib::Propagation::Proceed };
            let ctrl = mods.contains(gtk::gdk::ModifierType::CONTROL_MASK);
            match key {
                gtk::gdk::Key::n if ctrl => {
                    r.new_transaction();
                    glib::Propagation::Stop
                }
                gtk::gdk::Key::f if ctrl => {
                    r.search.grab_focus();
                    glib::Propagation::Stop
                }
                _ => glib::Propagation::Proceed,
            }
        });
        reg.root.add_controller(keys);
        let keys = gtk::EventControllerKey::new();
        let w = Rc::downgrade(&reg);
        keys.connect_key_pressed(move |_, key, _, _| {
            let Some(r) = w.upgrade() else { return glib::Propagation::Proceed };
            if key == gtk::gdk::Key::Delete {
                r.delete_selected();
                return glib::Propagation::Stop;
            }
            glib::Propagation::Proceed
        });
        reg.view.add_controller(keys);

        reg
    }

    pub fn widget(&self) -> &gtk::Box {
        &self.root
    }

    /// Shows one account (`Some`) or all accounts (`None`).
    pub fn show_account(self: &Rc<Self>, id: Option<String>) {
        if !self.keep_filter.replace(false) {
            *self.filter.borrow_mut() = None;
        }
        if self.editor_dirty() {
            self.save_quiet();
        }
        let changed = *self.account.borrow() != id;
        *self.account.borrow_mut() = id;
        if changed {
            self.search.set_text("");
        }
        self.refresh();
        self.new_transaction_quiet();
    }

    /// Limits the list to one category (and month), for "Show transactions"
    /// on a budget cell. Takes effect on the next `show_account`.
    pub fn set_filter_category(&self, category: Option<String>, month: Option<Month>) {
        *self.filter.borrow_mut() = category.map(|c| (c, month));
        self.keep_filter.set(true);
    }

    pub fn refresh(self: &Rc<Self>) {
        let Some(app) = self.app.upgrade() else { return };
        let account = self.account.borrow().clone();
        let accounts = model::accounts(&app.db).unwrap_or_default();
        let acct = account.as_ref().and_then(|id| accounts.iter().find(|a| &a.id == id));
        if account.is_some() && acct.is_none() {
            // Deleted elsewhere: fall back to the budget.
            *self.account.borrow_mut() = None;
            let app2 = app.clone();
            glib::idle_add_local_once(move || app2.show(View::Budget));
            return;
        }
        let fmt = app.fmt.get();
        let (cleared, uncleared) = match acct {
            Some(a) => (a.cleared, a.uncleared),
            None => accounts.iter().filter(|a| !a.closed).fold((0, 0), |(c, u), a| (c + a.cleared, u + a.uncleared)),
        };
        self.title.set_text(acct.map(|a| a.name.as_str()).unwrap_or("All accounts"));
        self.cleared_label.set_text(&fmt.format(cleared));
        self.uncleared_label.set_text(&fmt.format(uncleared));
        self.working_label.set_text(&fmt.format(cleared + uncleared));
        for (l, v) in [(&self.cleared_label, cleared), (&self.uncleared_label, uncleared), (&self.working_label, cleared + uncleared)] {
            if v < 0 {
                l.add_css_class("negative");
            } else {
                l.remove_css_class("negative");
            }
        }
        self.balances.set_visible(true);
        self.reconcile.set_visible(acct.is_some_and(|a| !a.closed) && app.writable);
        self.account_col.set_visible(account.is_none());
        self.build_account_menu(&app, acct);

        // Name lookups.
        let groups = model::category_groups(&app.db).unwrap_or_default();
        let cat_names: HashMap<String, String> =
            groups.iter().flat_map(|g| g.categories.iter().map(|c| (c.id.clone(), c.name.clone()))).collect();
        let payees = model::payees(&app.db).unwrap_or_default();
        let payee_names: HashMap<String, (String, bool)> =
            payees.iter().map(|p| (p.id.clone(), (p.name.clone(), p.transfer_acct.is_some()))).collect();
        let acct_names: HashMap<String, (String, bool)> = accounts.iter().map(|a| (a.id.clone(), (a.name.clone(), a.offbudget))).collect();

        let txs = model::transactions(&app.db, account.as_deref()).unwrap_or_default();
        let filter = self.filter.borrow().clone();
        let query = self.search.text().to_lowercase();

        let to_row = |t: &Transaction, parent: Option<&Transaction>| -> Row {
            let (payee, is_transfer) = t
                .payee
                .as_ref()
                .and_then(|p| payee_names.get(p))
                .map(|(n, tr)| (if *tr { format!("Transfer: {n}") } else { n.clone() }, *tr))
                .unwrap_or_default();
            let acct_off = t.account.as_ref().and_then(|a| acct_names.get(a)).map(|(_, off)| *off).unwrap_or(false);
            let category = if t.is_parent {
                if t.error.is_some() {
                    format!("Split — {} left to assign", fmt.format(t.split_remainder()))
                } else {
                    format!("Split ({})", t.subtransactions.len())
                }
            } else if let Some(c) = t.category.as_ref() {
                cat_names.get(c).cloned().unwrap_or_else(|| "(deleted category)".into())
            } else if is_transfer && t.category.is_none() {
                "Transfer".into()
            } else if acct_off {
                "Off budget".into()
            } else {
                String::new()
            };
            Row {
                id: t.id.clone(),
                parent: parent.map(|p| p.id.clone()),
                is_parent: t.is_parent,
                is_child: parent.is_some(),
                date: t.date.clone(),
                account: t.account.as_ref().and_then(|a| acct_names.get(a)).map(|(n, _)| n.clone()).unwrap_or_default(),
                payee,
                category,
                notes: t.notes.clone().unwrap_or_default(),
                amount: t.amount,
                balance: None,
                cleared: t.cleared,
                reconciled: t.reconciled,
                split_error: t.is_parent && t.error.is_some(),
            }
        };

        let mut rows: Vec<Row> = Vec::new();
        for t in &txs {
            if let Some((cat, month)) = &filter {
                if let Some(m) = month {
                    if !t.date.starts_with(&m.to_string()) {
                        continue;
                    }
                }
                if t.is_parent {
                    for c in t.subtransactions.iter().filter(|c| c.category.as_ref() == Some(cat)) {
                        let mut r = to_row(c, None);
                        r.date = t.date.clone();
                        r.parent = Some(t.id.clone());
                        r.cleared = t.cleared;
                        r.reconciled = t.reconciled;
                        rows.push(r);
                    }
                } else if t.category.as_ref() == Some(cat) {
                    rows.push(to_row(t, None));
                }
                continue;
            }
            rows.push(to_row(t, None));
            for c in &t.subtransactions {
                rows.push(to_row(c, Some(t)));
            }
        }
        if !query.is_empty() {
            let fmtq = |a: i64| fmt.format(a.abs()).to_lowercase();
            let mut keep_parents: Vec<String> = Vec::new();
            let matches = |r: &Row| {
                r.payee.to_lowercase().contains(&query)
                    || r.category.to_lowercase().contains(&query)
                    || r.notes.to_lowercase().contains(&query)
                    || r.account.to_lowercase().contains(&query)
                    || fmtq(r.amount).contains(&query)
            };
            for r in &rows {
                if matches(r) {
                    keep_parents.push(r.parent.clone().unwrap_or(r.id.clone()));
                }
            }
            rows.retain(|r| keep_parents.contains(r.parent.as_ref().unwrap_or(&r.id)));
        }

        // Running balance: only for a whole, unfiltered single account.
        let show_balance = account.is_some() && filter.is_none() && query.is_empty();
        self.balance_col.set_visible(show_balance);
        if show_balance {
            let mut running = 0i64;
            for r in rows.iter_mut().rev() {
                if !r.is_child {
                    running += r.amount;
                    r.balance = Some(running);
                }
            }
        }

        match &filter {
            Some((cat, month)) => {
                let name = cat_names.get(cat).cloned().unwrap_or_default();
                let label = match month {
                    Some(m) => format!("{name} · {} {}", m.name(), m.year),
                    None => name,
                };
                self.filter_label.set_text(&label);
                self.filter_bar.set_visible(true);
            }
            None => self.filter_bar.set_visible(false),
        }

        // Keep the selection on the same transaction across refreshes.
        let selected_id = self.editor.state.borrow().id.clone();
        self.loading.set(true);
        let objs: Vec<glib::BoxedAnyObject> = rows.iter().cloned().map(glib::BoxedAnyObject::new).collect();
        self.store.splice(0, self.store.n_items(), &objs);
        let pos = selected_id.as_ref().and_then(|id| rows.iter().position(|r| &r.id == id));
        self.selection.set_selected(pos.map(|p| p as u32).unwrap_or(gtk::INVALID_LIST_POSITION));
        *self.rows.borrow_mut() = rows;
        self.loading.set(false);

        self.refresh_editor_choices(&app, &groups, &payees, &accounts);
        // The edited transaction may have changed (sync, undo) or vanished.
        if let Some(id) = selected_id {
            match model::transaction(&app.db, &id).ok().flatten() {
                Some(t) if Some(&t) != self.editor.state.borrow().original.as_ref() && !self.editor_dirty() => {
                    self.edit(Some(id))
                }
                None => self.new_transaction_quiet(),
                _ => {}
            }
        }
    }

    fn build_account_menu(self: &Rc<Self>, app: &Rc<App>, acct: Option<&model::Account>) {
        let Some(a) = acct.cloned() else {
            self.account_menu.set_visible(false);
            return;
        };
        self.account_menu.set_visible(true);
        let b = gtk::Box::new(gtk::Orientation::Vertical, 0);
        let pop = gtk::Popover::builder().child(&b).build();
        let mut items: Vec<(String, Box<dyn Fn()>)> = Vec::new();
        let writable = app.writable;
        let mk = |label: &str, f: Box<dyn Fn()>| (label.to_string(), f);
        if writable {
            let (ap, id, name) = (app.weak(), a.id.clone(), a.name.clone());
            items.push(mk(
                "Rename account…",
                Box::new(move || {
                    let id = id.clone();
                    let Some(ap) = ap.upgrade() else { return };
                    dialogs::prompt_text(&ap, "Rename account", "Name", &name, "Rename", move |app, new| {
                        let cs = ops::update_account(&id, Some(&new), None);
                        app.engine.run("Rename account", move |s| s.budget.apply(cs));
                    })
                }),
            ));
        }
        let (ap, id, name) = (app.weak(), a.id.clone(), a.name.clone());
        items.push(mk(
            "Account notes…",
            Box::new(move || {
                if let Some(ap) = ap.upgrade() {
                    dialogs::edit_note(&ap, &id, &format!("Notes for {name}"))
                }
            }),
        ));
        if writable {
            let (wap, id) = (app.weak(), a.id.clone());
            if a.closed {
                items.push(mk(
                    "Reopen account",
                    Box::new(move || {
                        let cs = ops::reopen_account(&id);
                        if let Some(ap) = wap.upgrade() {
                            ap.engine.run("Reopen account", move |s| s.budget.apply(cs));
                        }
                    }),
                ));
            } else {
                items.push(mk("Close account…", Box::new(move || {
                    if let Some(ap) = wap.upgrade() {
                        dialogs::close_account(&ap, &id)
                    }
                })));
            }
        }
        for (label, f) in items {
            let btn = gtk::Button::builder().label(label).css_classes(["flat"]).build();
            if let Some(l) = btn.child().and_downcast::<gtk::Label>() {
                l.set_xalign(0.0);
            }
            let p = pop.downgrade();
            btn.connect_clicked(move |_| {
                if let Some(p) = p.upgrade() {
                    p.popdown();
                }
                f();
            });
            b.append(&btn);
        }
        self.account_menu.set_popover(Some(&pop));
    }

    fn refresh_editor_choices(
        &self,
        app: &App,
        groups: &[model::CategoryGroup],
        payees: &[model::Payee],
        accounts: &[model::Account],
    ) {
        let current = self.account.borrow().clone();
        let mut payee_choices: Vec<Choice> = payees
            .iter()
            .filter(|p| p.transfer_acct.is_none())
            .map(|p| Choice {
                id: p.id.clone(),
                label: p.name.clone(),
                detail: if p.favorite { "★".into() } else { String::new() },
                hidden: false,
            })
            .collect();
        payee_choices.sort_by_key(|c| (c.detail.is_empty(), c.label.to_lowercase()));
        for p in payees.iter().filter(|p| p.transfer_acct.is_some()) {
            let acct = accounts.iter().find(|a| Some(&a.id) == p.transfer_acct.as_ref());
            // Closed accounts (and this one) aren't offered, but existing
            // transfers to them still display and save unchanged.
            let hidden = acct.is_none_or(|a| a.closed || Some(&a.id) == current.as_ref());
            payee_choices.push(Choice { id: p.id.clone(), label: format!("Transfer: {}", p.name), detail: "Transfer".into(), hidden });
        }
        self.editor.payee.set_choices(payee_choices);

        let mut cat_choices = Vec::new();
        for g in groups {
            for c in &g.categories {
                cat_choices.push(Choice {
                    id: c.id.clone(),
                    label: c.name.clone(),
                    detail: g.name.clone(),
                    hidden: c.hidden || g.hidden,
                });
            }
        }
        self.editor.category.set_choices(cat_choices);

        // Every account, so a transaction in a closed one keeps its account;
        // closed ones are marked.
        let names: Vec<String> =
            accounts.iter().map(|a| if a.closed { format!("{} (closed)", a.name) } else { a.name.clone() }).collect();
        let names: Vec<&str> = names.iter().map(String::as_str).collect();
        let ids: Vec<String> = accounts.iter().map(|a| a.id.clone()).collect();
        if *self.editor.account_ids.borrow() != ids {
            self.editor.account.set_model(Some(&gtk::StringList::new(&names)));
            *self.editor.account_ids.borrow_mut() = ids;
        }
        let ro = !app.writable;
        for w in [
            self.editor.date.upcast_ref::<gtk::Widget>(),
            self.editor.payee.widget().upcast_ref(),
            self.editor.notes.upcast_ref(),
            self.editor.outflow.upcast_ref(),
            self.editor.inflow.upcast_ref(),
        ] {
            w.set_sensitive(!ro);
        }
        self.editor.root.set_visible(!ro);
    }

    fn account_off_budget(&self, app: &App, account: &str) -> bool {
        app.db
            .query_row("SELECT offbudget FROM accounts WHERE id = ?", [account], |r| r.get::<_, Option<i64>>(0))
            .ok()
            .flatten()
            .unwrap_or(0)
            != 0
    }

    fn selected_account(&self) -> Option<String> {
        let idx = self.editor.account.selected();
        self.editor.account_ids.borrow().get(idx as usize).cloned()
    }

    /// Enables the category field unless the transaction can't have one: an
    /// off-budget account, a split, or a transfer between two accounts on the
    /// same side of the budget.
    fn update_category_state(&self) {
        let Some(app) = self.app.upgrade() else { return };
        let e = &self.editor;
        let is_split = e.state.borrow().splits.as_ref().is_some_and(|s| !s.is_empty());
        let account = self.selected_account();
        let off = account.as_deref().is_some_and(|a| self.account_off_budget(&app, a));
        let transfer_same_side = e.payee.selected().filter(|c| c.detail == "Transfer").and_then(|c| {
            app.db
                .query_row("SELECT transfer_acct FROM payees WHERE id = ?", [&c.id], |r| r.get::<_, Option<String>>(0))
                .ok()
                .flatten()
                .map(|other| self.account_off_budget(&app, &other) == off)
        });
        let can = app.writable && !is_split && !off && transfer_same_side != Some(true);
        e.category.widget().set_sensitive(can);
        if is_split {
            let n = e.state.borrow().splits.as_ref().map(Vec::len).unwrap_or(0);
            e.category.widget().set_text(&format!("Split ({n})"));
        } else if !can {
            e.category.set(None);
            e.category.widget().set_placeholder_text(Some(if off { "Off budget" } else { "Transfer (no category)" }));
        } else {
            e.category.widget().set_placeholder_text(Some("Category"));
        }
        e.split_button.set_sensitive(app.writable && !off);
    }

    /// Clears the editor for a new transaction and focuses it.
    fn new_transaction(self: &Rc<Self>) {
        self.new_transaction_quiet();
        self.editor.date.grab_focus();
        self.editor.date.select_region(0, -1);
    }

    fn new_transaction_quiet(self: &Rc<Self>) {
        let Some(app) = self.app.upgrade() else { return };
        let e = &self.editor;
        *e.state.borrow_mut() = EditState::default();
        self.loading.set(true);
        self.selection.set_selected(gtk::INVALID_LIST_POSITION);
        self.loading.set(false);
        e.heading.set_text("New transaction");
        let pref = app.date_format.borrow().clone();
        e.date.set_text(&format_date(&actual_budget::month::today(), &pref));
        e.payee.set(None);
        e.category.set(None);
        e.notes.set_text("");
        e.outflow.set_text("");
        e.inflow.set_text("");
        e.cleared.set_active(false);
        e.delete.set_visible(false);
        let current = self.account.borrow().clone();
        let idx = current.and_then(|id| e.account_ids.borrow().iter().position(|a| *a == id));
        let first_open = model::accounts(&app.db).ok().and_then(|a| {
            let ids = e.account_ids.borrow();
            a.iter().filter(|a| !a.closed).find_map(|a| ids.iter().position(|x| *x == a.id))
        });
        e.account.set_selected(idx.or(first_open).unwrap_or(0) as u32);
        self.update_category_state();
        let snap = self.snapshot();
        e.state.borrow_mut().loaded = snap;
    }

    /// Loads a transaction into the editor.
    fn edit(self: &Rc<Self>, id: Option<String>) {
        let Some(app) = self.app.upgrade() else { return };
        let Some(id) = id else { return self.new_transaction_quiet() };
        let Some(t) = model::transaction(&app.db, &id).ok().flatten() else { return };
        let e = &self.editor;
        let pref = app.date_format.borrow().clone();
        e.heading.set_text(if t.reconciled { "Edit transaction (reconciled)" } else { "Edit transaction" });
        e.date.set_text(&format_date(&t.date, &pref));
        e.payee.set_by_id(t.payee.as_deref());
        e.category.set_by_id(t.category.as_deref());
        e.notes.set_text(t.notes.as_deref().unwrap_or(""));
        let fmt = app.fmt.get();
        e.outflow.set_text(&if t.amount < 0 { fmt.format(-t.amount) } else { String::new() });
        e.inflow.set_text(&if t.amount > 0 { fmt.format(t.amount) } else { String::new() });
        e.cleared.set_active(t.cleared);
        e.delete.set_visible(app.writable);
        let idx = t.account.as_ref().and_then(|a| e.account_ids.borrow().iter().position(|x| x == a));
        if let Some(i) = idx {
            e.account.set_selected(i as u32);
        }
        let splits = if t.is_parent {
            Some(
                t.subtransactions
                    .iter()
                    .map(|c| SplitLine {
                        id: Some(c.id.clone()),
                        amount: c.amount,
                        payee: c.payee.clone(),
                        category: c.category.clone(),
                        notes: c.notes.clone(),
                    })
                    .collect(),
            )
        } else {
            None
        };
        *e.state.borrow_mut() = EditState { id: Some(id), original: Some(t), splits, loaded: String::new() };
        self.update_category_state();
        let snap = self.snapshot();
        e.state.borrow_mut().loaded = snap;
    }

    fn wire_editor(self: &Rc<Self>) {
        let e = &self.editor;
        let w = Rc::downgrade(self);
        let save = move || {
            if let Some(r) = w.upgrade() {
                r.save();
            }
        };
        let save = Rc::new(save);
        for entry in [&e.date, &e.notes, &e.outflow, &e.inflow] {
            let s = save.clone();
            entry.connect_activate(move |_| s());
        }
        let s = save.clone();
        e.payee.widget().connect_activate(move |_| s());
        let s = save.clone();
        e.category.widget().connect_activate(move |_| s());
        let s = save.clone();
        e.save.connect_clicked(move |_| s());
        // Typing in one amount column clears the other.
        let inflow = e.inflow.clone();
        e.outflow.connect_changed(move |o| {
            if !o.text().is_empty() && o.state_flags().contains(gtk::StateFlags::FOCUS_WITHIN) {
                inflow.set_text("");
            }
        });
        let outflow = e.outflow.clone();
        e.inflow.connect_changed(move |i| {
            if !i.text().is_empty() && i.state_flags().contains(gtk::StateFlags::FOCUS_WITHIN) {
                outflow.set_text("");
            }
        });
        let w = Rc::downgrade(self);
        e.payee.connect_pick(move |_| {
            if let Some(r) = w.upgrade() {
                r.payee_picked();
            }
        });
        let w = Rc::downgrade(self);
        e.account.connect_selected_notify(move |_| {
            if let Some(r) = w.upgrade() {
                r.update_category_state();
            }
        });
        let w = Rc::downgrade(self);
        e.delete.connect_clicked(move |_| {
            if let Some(r) = w.upgrade() {
                r.delete_editing();
            }
        });
        let w = Rc::downgrade(self);
        e.split_button.connect_clicked(move |_| {
            if let Some(r) = w.upgrade() {
                r.split_dialog();
            }
        });
        // Escape cancels the edit.
        let keys = gtk::EventControllerKey::new();
        let w = Rc::downgrade(self);
        keys.connect_key_pressed(move |_, key, _, _| {
            let Some(r) = w.upgrade() else { return glib::Propagation::Proceed };
            if key == gtk::gdk::Key::Escape {
                r.new_transaction_quiet();
                r.view.grab_focus();
                return glib::Propagation::Stop;
            }
            glib::Propagation::Proceed
        });
        e.root.add_controller(keys);
    }

    /// After picking a payee on a new transaction, prefill the category from
    /// that payee's most recent transaction (like the web's payee rules).
    fn payee_picked(&self) {
        self.update_category_state();
        let Some(app) = self.app.upgrade() else { return };
        let e = &self.editor;
        if e.state.borrow().id.is_some() || !e.category.widget().is_sensitive() || e.category.selected().is_some() {
            return;
        }
        let Some(p) = e.payee.selected() else { return };
        let last: Option<String> = app
            .db
            .query_row(
                "SELECT category FROM rs_transactions WHERE payee = ? AND category IS NOT NULL AND is_parent = 0
                  ORDER BY date DESC, sort_order DESC LIMIT 1",
                [&p.id],
                |r| r.get(0),
            )
            .ok();
        if let Some(c) = last {
            e.category.set_by_id(Some(&c));
        }
    }

    fn snapshot(&self) -> String {
        let e = &self.editor;
        format!(
            "{}|{}|{}|{}|{}|{}|{}|{}|{:?}",
            e.account.selected(),
            e.date.text(),
            e.payee.text(),
            e.category.text(),
            e.notes.text(),
            e.outflow.text(),
            e.inflow.text(),
            e.cleared.is_active(),
            e.state.borrow().splits,
        )
    }

    /// Whether the editor holds changes the user hasn't saved.
    fn editor_dirty(&self) -> bool {
        let app_writable = self.app.upgrade().is_some_and(|a| a.writable);
        let e = &self.editor;
        // An untouched new transaction (no payee, no amount) is not worth
        // saving even if its date or account changed.
        let empty_new = e.state.borrow().id.is_none()
            && e.payee.text().trim().is_empty()
            && e.outflow.text().trim().is_empty()
            && e.inflow.text().trim().is_empty();
        app_writable && !empty_new && self.snapshot() != e.state.borrow().loaded
    }

    /// Saves without moving focus or resetting the editor for the next entry.
    fn save_quiet(self: &Rc<Self>) -> bool {
        self.quiet_save.set(true);
        let ok = self.save();
        self.quiet_save.set(false);
        ok
    }

    /// Queues the editor's transaction for saving. Returns false (after a
    /// toast) when the input can't be saved.
    fn save(self: &Rc<Self>) -> bool {
        let Some(app) = self.app.upgrade() else { return false };
        if !app.writable {
            return false;
        }
        let e = &self.editor;
        let fmt = app.fmt.get();
        let pref = app.date_format.borrow().clone();
        let Some(date) = parse_date(&e.date.text(), &pref) else {
            app.toast("Enter a valid date.");
            e.date.grab_focus();
            return false;
        };
        if actual_budget::month::date_to_db(&date).is_none() {
            app.toast("Dates before 1995 aren't supported.");
            return false;
        }
        let parse = |entry: &gtk::Entry| -> Option<i64> {
            let t = entry.text();
            if t.trim().is_empty() { Some(0) } else { fmt.parse(&t) }
        };
        let (Some(out), Some(inn)) = (parse(&e.outflow), parse(&e.inflow)) else {
            app.toast("That isn't a valid amount.");
            return false;
        };
        let amount = inn - out;
        let Some(account) = self.selected_account() else {
            app.toast("Add an account first.");
            return false;
        };
        // A typed name that isn't an existing payee creates one.
        let payee_text = e.payee.text().trim().to_string();
        let payee_pick = e.payee.selected().filter(|c| c.label == payee_text).map(|c| c.id);
        let category = if e.category.widget().is_sensitive() {
            match e.category.selected() {
                Some(c) if c.label == e.category.text() => Some(c.id),
                _ if e.category.text().trim().is_empty() => None,
                _ => {
                    app.toast("Pick a category from the list.");
                    e.category.widget().grab_focus();
                    return false;
                }
            }
        } else {
            None
        };
        let notes = Some(e.notes.text().to_string()).filter(|n| !n.trim().is_empty());
        let cleared = e.cleared.is_active();
        let state = e.state.borrow();
        let id = state.id.clone();
        let splits = state.splits.clone();
        let original = state.original.clone();
        drop(state);

        app.engine.run("Save transaction", move |s| {
            let conn = s.budget.conn();
            let mut cs = ops::ChangeSet::new();
            let payee = match (payee_pick, payee_text.is_empty()) {
                (Some(p), _) => Some(p),
                (None, true) => None,
                (None, false) => {
                    let (pid, pcs) = ops::get_or_create_payee(conn, &payee_text)?;
                    cs.extend(pcs);
                    Some(pid)
                }
            };
            match id {
                None => {
                    let tx = NewTransaction {
                        id: None,
                        account,
                        date,
                        amount,
                        payee,
                        category,
                        notes,
                        cleared,
                        starting_balance_flag: false,
                        splits: splits.unwrap_or_default(),
                        sort_order: None,
                    };
                    let (ids, tcs) = ops::insert_transaction(&tx)?;
                    cs.extend(tcs);
                    s.budget.edit_transactions(cs, ids, Vec::new())
                }
                Some(id) => {
                    let orig = original.ok_or_else(|| BudgetError::Invalid("Transaction not found.".into()))?;
                    let u = TransactionUpdate {
                        account: Some(account).filter(|a| Some(a) != orig.account.as_ref()),
                        date: Some(date).filter(|d| *d != orig.date),
                        amount: Some(amount).filter(|a| *a != orig.amount),
                        payee: Some(payee).filter(|p| *p != orig.payee),
                        // A split's category lives on its lines, unless it's
                        // being turned back into a normal transaction.
                        category: if orig.is_parent && splits.as_ref().is_none_or(|l| !l.is_empty()) {
                            None
                        } else {
                            Some(category).filter(|c| *c != orig.category)
                        },
                        notes: Some(notes).filter(|n| n.as_deref().unwrap_or("") != orig.notes.as_deref().unwrap_or("")),
                        cleared: Some(cleared).filter(|c| *c != orig.cleared),
                        reconciled: None,
                    };
                    let mut changed = vec![id.clone()];
                    changed.extend(orig.subtransactions.iter().map(|c| c.id.clone()));
                    if !u.is_empty() {
                        cs.extend(ops::update_transaction(conn, &id, &u)?);
                    }
                    let new_lines = splits.unwrap_or_default();
                    let old_lines: Vec<SplitLine> = orig
                        .subtransactions
                        .iter()
                        .map(|c| SplitLine {
                            id: Some(c.id.clone()),
                            amount: c.amount,
                            payee: c.payee.clone(),
                            category: c.category.clone(),
                            notes: c.notes.clone(),
                        })
                        .collect();
                    let mut deleted = Vec::new();
                    if new_lines != old_lines {
                        // Written after the parent's own edit in the same
                        // batch; the split error uses the parent's new amount.
                        // A new parent payee reaches lines that followed the
                        // old one (as update_transaction does for unchanged lines).
                        let mut new_lines = new_lines.clone();
                        if let Some(p) = &u.payee {
                            for l in new_lines.iter_mut() {
                                if l.payee.is_none() || l.payee == orig.payee {
                                    l.payee = p.clone();
                                }
                            }
                        }
                        let (scs, removed) = ops::set_splits_with_amount(conn, &id, &new_lines, u.amount)?;
                        cs.extend(scs);
                        if matches!(u.payee, Some(None)) {
                            for l in new_lines.iter().filter(|l| l.payee.is_none()) {
                                cs.set("transactions", l.id.as_deref().unwrap_or_default(), vec![("description", actual_sync::value::Value::Null)]);
                            }
                        }
                        // New lines copy the parent's stored date and account;
                        // give them the edited ones.
                        for l in new_lines.iter().filter(|l| !old_lines.iter().any(|o| o.id == l.id)) {
                            let lid = l.id.clone().unwrap_or_default();
                            if let Some(d) = u.date.as_deref().and_then(actual_budget::month::date_to_db) {
                                cs.set("transactions", &lid, vec![("date", d.into())]);
                            }
                            if let Some(a) = &u.account {
                                cs.set("transactions", &lid, vec![("acct", a.as_str().into())]);
                            }
                        }
                        changed.retain(|c| !removed.contains(c));
                        changed.extend(new_lines.iter().filter_map(|l| l.id.clone()));
                        deleted = removed;
                    }
                    if cs.is_empty() {
                        return Ok(Default::default());
                    }
                    s.budget.edit_transactions(cs, changed, deleted)
                }
            }
        });
        if self.editor.state.borrow().id.is_some() || self.quiet_save.get() {
            // What's in the editor is now what's saved; the next Changed
            // event reloads it from the database (or after an undo).
            let snap = self.snapshot();
            self.editor.state.borrow_mut().loaded = snap;
            return true;
        }
        // Ready for the next one, keeping the date (YNAB4 habit).
        let date = self.editor.date.text();
        self.new_transaction_quiet();
        self.editor.date.set_text(&date);
        let snap = self.snapshot();
        self.editor.state.borrow_mut().loaded = snap;
        self.editor.payee.widget().grab_focus();
        true
    }

    fn delete_editing(self: &Rc<Self>) {
        let id = self.editor.state.borrow().id.clone();
        if let Some(id) = id {
            self.delete_ids(id);
            self.new_transaction_quiet();
        }
    }

    fn delete_selected(self: &Rc<Self>) {
        let pos = self.selection.selected();
        let row = self.rows.borrow().get(pos as usize).cloned();
        if let Some(row) = row {
            // Deleting a split line edits its parent's split.
            if let Some(parent) = row.parent.clone() {
                self.edit(Some(parent));
                let mut st = self.editor.state.borrow_mut();
                if let Some(lines) = st.splits.as_mut() {
                    lines.retain(|l| l.id.as_deref() != Some(&row.id));
                }
                drop(st);
                self.save();
                return;
            }
            self.delete_ids(row.id);
            self.new_transaction_quiet();
        }
    }

    fn delete_ids(&self, id: String) {
        let Some(app) = self.app.upgrade() else { return };
        if !app.writable {
            return;
        }
        app.engine.run("Delete transaction", move |s| {
            let (ids, cs) = ops::delete_transaction(s.budget.conn(), &id)?;
            s.budget.edit_transactions(cs, Vec::new(), ids)
        });
    }

    /// Edits the split lines of the transaction in the editor. The lines
    /// are saved with the transaction.
    fn split_dialog(self: &Rc<Self>) {
        let Some(app) = self.app.upgrade() else { return };
        let fmt = app.fmt.get();
        let parse = |entry: &gtk::Entry| -> Option<i64> {
            let t = entry.text();
            if t.trim().is_empty() { Some(0) } else { fmt.parse(&t) }
        };
        let total = match (parse(&self.editor.outflow), parse(&self.editor.inflow)) {
            (Some(o), Some(i)) => i - o,
            _ => {
                app.toast("Enter the transaction's total first.");
                return;
            }
        };
        let mut lines = self.editor.state.borrow().splits.clone().unwrap_or_default();
        if lines.is_empty() {
            let cat = self.editor.category.selected().map(|c| c.id);
            lines.push(SplitLine { id: Some(ops::new_id()), amount: total, payee: None, category: cat, notes: None });
            lines.push(SplitLine { id: Some(ops::new_id()), amount: 0, payee: None, category: None, notes: None });
        }

        let categories = self.editor.category.clone();
        let list = gtk::Box::new(gtk::Orientation::Vertical, 6);
        let remainder = gtk::Label::builder().xalign(1.0).build();
        remainder.add_css_class("tnum");
        type LineWidgets = (Option<String>, Autocomplete, gtk::Entry, gtk::Entry, gtk::Entry, gtk::Box);
        let widgets: Rc<RefCell<Vec<LineWidgets>>> = Rc::new(RefCell::new(Vec::new()));

        let update_remainder = {
            let widgets = widgets.clone();
            let remainder = remainder.clone();
            Rc::new(move || {
                let sum: i64 = widgets
                    .borrow()
                    .iter()
                    .map(|(_, _, _, o, i, _)| {
                        let p = |e: &gtk::Entry| if e.text().trim().is_empty() { 0 } else { fmt.parse(&e.text()).unwrap_or(0) };
                        p(i) - p(o)
                    })
                    .sum();
                let left = total - sum;
                remainder.set_text(&if left == 0 {
                    "Fully assigned".to_string()
                } else {
                    format!("{} left to assign", fmt.format(left))
                });
                if left == 0 {
                    remainder.remove_css_class("split-error");
                } else {
                    remainder.add_css_class("split-error");
                }
            })
        };

        let add_line = {
            let widgets = widgets.clone();
            let list = list.clone();
            let update = update_remainder.clone();
            let choices = categories.clone();
            Rc::new(move |line: SplitLine| {
                let row = gtk::Box::new(gtk::Orientation::Horizontal, 6);
                let cat = Autocomplete::new("Category");
                cat.set_choices(choices.choices());
                cat.set_by_id(line.category.as_deref());
                cat.widget().set_width_chars(22);
                let memo = gtk::Entry::builder().placeholder_text("Memo").text(line.notes.clone().unwrap_or_default()).hexpand(true).build();
                let out = gtk::Entry::builder().placeholder_text("Outflow").width_chars(10).xalign(1.0).build();
                let inn = gtk::Entry::builder().placeholder_text("Inflow").width_chars(10).xalign(1.0).build();
                if line.amount < 0 {
                    out.set_text(&fmt.format(-line.amount));
                } else if line.amount > 0 {
                    inn.set_text(&fmt.format(line.amount));
                }
                for e in [&out, &inn] {
                    let u = update.clone();
                    e.connect_changed(move |_| u());
                }
                let remove = gtk::Button::from_icon_name("list-remove-symbolic");
                remove.add_css_class("flat");
                row.append(cat.widget());
                row.append(&memo);
                row.append(&out);
                row.append(&inn);
                row.append(&remove);
                list.append(&row);
                let ws = widgets.clone();
                let lst = list.downgrade();
                let u = update.clone();
                let r2 = row.downgrade();
                remove.connect_clicked(move |_| {
                    let (Some(lst), Some(r2)) = (lst.upgrade(), r2.upgrade()) else { return };
                    lst.remove(&r2);
                    ws.borrow_mut().retain(|w| w.5 != r2);
                    u();
                });
                widgets.borrow_mut().push((line.id.clone(), cat, memo, out, inn, row));
            })
        };
        for l in lines {
            add_line(l);
        }
        update_remainder();

        let content = gtk::Box::new(gtk::Orientation::Vertical, 10);
        content.set_width_request(640);
        content.append(&list);
        let bottom = gtk::Box::new(gtk::Orientation::Horizontal, 6);
        let add = gtk::Button::with_label("+ Add split line");
        add.add_css_class("flat");
        let al = add_line.clone();
        add.connect_clicked(move |_| al(SplitLine { id: Some(ops::new_id()), amount: 0, payee: None, category: None, notes: None }));
        bottom.append(&add);
        remainder.set_hexpand(true);
        bottom.append(&remainder);
        content.append(&bottom);

        let d = adw::AlertDialog::new(Some("Split transaction"), Some(&format!("Total {}", fmt.format(total))));
        d.add_responses(&[("cancel", "Cancel"), ("unsplit", "Remove split"), ("ok", "Done")]);
        d.set_response_appearance("ok", adw::ResponseAppearance::Suggested);
        d.set_response_appearance("unsplit", adw::ResponseAppearance::Destructive);
        d.set_close_response("cancel");
        d.set_default_response(Some("ok"));
        d.set_extra_child(Some(&content));
        let line_payees: std::collections::HashMap<String, Option<String>> = self
            .editor
            .state
            .borrow()
            .splits
            .iter()
            .flatten()
            .filter_map(|l| Some((l.id.clone()?, l.payee.clone())))
            .collect();
        let w = Rc::downgrade(self);
        d.connect_response(None, move |_, resp| {
            // Drop the line widgets (and the closures that reference them).
            let lines = std::mem::take(&mut *widgets.borrow_mut());
            let Some(r) = w.upgrade() else { return };
            match resp {
                "ok" => {
                    let mut out = Vec::new();
                    for (id, cat, memo, o, i, _) in lines.iter() {
                        let p = |e: &gtk::Entry| if e.text().trim().is_empty() { 0 } else { fmt.parse(&e.text()).unwrap_or(0) };
                        let category = cat.selected().filter(|c| c.label == cat.text()).map(|c| c.id);
                        let amount = p(i) - p(o);
                        if amount == 0 && category.is_none() && memo.text().is_empty() {
                            continue;
                        }
                        out.push(SplitLine {
                            id: id.clone().or_else(|| Some(ops::new_id())),
                            amount,
                            payee: id.as_ref().and_then(|i| line_payees.get(i).cloned().flatten()),
                            category,
                            notes: Some(memo.text().to_string()).filter(|n| !n.is_empty()),
                        });
                    }
                    r.editor.state.borrow_mut().splits = Some(out);
                    r.update_category_state();
                }
                "unsplit" => {
                    r.editor.state.borrow_mut().splits = Some(Vec::new());
                    r.editor.category.set(None);
                    r.update_category_state();
                }
                _ => {}
            }
        });
        d.present(Some(&app.window));
    }

    /// YNAB4-style reconcile: confirm the cleared balance matches the bank
    /// statement; if not, add an adjustment, then lock cleared transactions.
    fn reconcile_dialog(self: &Rc<Self>) {
        let Some(app) = self.app.upgrade() else { return };
        let Some(account) = self.account.borrow().clone() else { return };
        let accounts = model::accounts(&app.db).unwrap_or_default();
        let Some(acct) = accounts.into_iter().find(|a| a.id == account) else { return };
        let fmt = app.fmt.get();
        let entry = gtk::Entry::builder().text(fmt.format(acct.cleared)).xalign(1.0).build();
        let b = gtk::Box::new(gtk::Orientation::Vertical, 6);
        let l = gtk::Label::builder().label("Your bank statement's balance").xalign(0.0).build();
        l.add_css_class("caption-heading");
        b.append(&l);
        b.append(&entry);
        let d = adw::AlertDialog::new(
            Some("Reconcile account"),
            Some(&format!("The cleared balance in Actual is {}.", fmt.format(acct.cleared))),
        );
        d.add_responses(&[("cancel", "Cancel"), ("ok", "Reconcile")]);
        d.set_response_appearance("ok", adw::ResponseAppearance::Suggested);
        d.set_default_response(Some("ok"));
        d.set_close_response("cancel");
        d.set_extra_child(Some(&b));
        entry.set_activates_default(true);
        let weak = app.weak();
        let cleared = acct.cleared;
        let entry2 = entry.clone();
        d.connect_response(Some("ok"), move |_, _| {
            let Some(app) = weak.upgrade() else { return };
            let Some(target) = app.fmt.get().parse(&entry2.text()) else {
                app.toast("That isn't a valid amount.");
                return;
            };
            let diff = target - cleared;
            let account = account.clone();
            if diff != 0 {
                let fmt = app.fmt.get();
                app.toast(&format!("Added a {} balance adjustment", fmt.format(diff)));
            }
            app.engine.run("Reconcile", move |s| {
                if diff != 0 {
                    let mut cs = ops::ChangeSet::new();
                    let (pid, pcs) = ops::get_or_create_payee(s.budget.conn(), "Reconciliation balance adjustment")?;
                    cs.extend(pcs);
                    let tx = NewTransaction {
                        id: None,
                        account: account.clone(),
                        date: actual_budget::month::today(),
                        amount: diff,
                        payee: Some(pid),
                        category: None,
                        notes: None,
                        cleared: true,
                        starting_balance_flag: false,
                        splits: Vec::new(),
                        sort_order: None,
                    };
                    let (ids, tcs) = ops::insert_transaction(&tx)?;
                    cs.extend(tcs);
                    s.budget.edit_transactions(cs, ids, Vec::new())?;
                }
                let cs = ops::reconcile_account(s.budget.conn(), &account)?;
                s.budget.apply(cs)
            });
        });
        d.present(Some(&app.window));
        entry.grab_focus();
    }
}

fn toggle_cleared(app: &Rc<App>, row: &Row) {
    if !app.writable || row.is_child {
        return;
    }
    // A split line shown on its own (category filter) clears its parent.
    let row = &Row { id: row.parent.clone().unwrap_or(row.id.clone()), ..row.clone() };
    if row.reconciled {
        app.toast("This transaction is reconciled. Edit it to change it.");
        return;
    }
    let id = row.id.clone();
    let cleared = !row.cleared;
    app.engine.run("Clear transaction", move |s| {
        let u = TransactionUpdate { cleared: Some(cleared), ..Default::default() };
        let cs = ops::update_transaction(s.budget.conn(), &id, &u)?;
        s.budget.edit_transactions(cs, vec![id], Vec::new())
    });
}

impl Editor {
    fn new() -> Editor {
        let root = gtk::Box::new(gtk::Orientation::Vertical, 6);
        root.add_css_class("register-editor");
        let heading = gtk::Label::builder().label("New transaction").xalign(0.0).build();
        heading.add_css_class("caption-heading");
        root.append(&heading);

        // Two rows so the editor fits a narrow window: who/what on top,
        // memo and money below (with the actions at the end).
        let top = gtk::Box::new(gtk::Orientation::Horizontal, 6);
        let account = gtk::DropDown::from_strings(&[]);
        account.set_tooltip_text(Some("Account"));
        account.set_size_request(150, -1);
        let date = gtk::Entry::builder().placeholder_text("Date").width_chars(11).build();
        let payee = Autocomplete::new("Payee");
        payee.set_allow_create(true);
        payee.widget().set_width_chars(14);
        let category = Autocomplete::new("Category");
        category.widget().set_width_chars(14);
        let split_button = gtk::Button::from_icon_name("view-list-symbolic");
        split_button.set_tooltip_text(Some("Split across categories"));
        split_button.add_css_class("flat");
        top.append(&account);
        top.append(&date);
        top.append(payee.widget());
        top.append(category.widget());
        top.append(&split_button);
        root.append(&top);

        let bottom = gtk::Box::new(gtk::Orientation::Horizontal, 6);
        let notes = gtk::Entry::builder().placeholder_text("Memo").hexpand(true).width_chars(10).build();
        let outflow = gtk::Entry::builder().placeholder_text("Outflow").width_chars(10).xalign(1.0).build();
        let inflow = gtk::Entry::builder().placeholder_text("Inflow").width_chars(10).xalign(1.0).build();
        let cleared = gtk::CheckButton::builder().label("Cleared").build();
        let delete = gtk::Button::with_label("Delete");
        delete.add_css_class("destructive-action");
        delete.add_css_class("flat");
        delete.set_visible(false);
        let save = gtk::Button::with_label("Save");
        save.add_css_class("suggested-action");
        save.set_tooltip_text(Some("Enter"));
        bottom.append(&notes);
        bottom.append(&outflow);
        bottom.append(&inflow);
        bottom.append(&cleared);
        bottom.append(&delete);
        bottom.append(&save);
        root.append(&bottom);
        // Ctrl+Z in the editor undoes the last saved change, not typing.
        for e in [&date, payee.widget(), category.widget(), &notes, &outflow, &inflow] {
            e.set_enable_undo(false);
        }

        Editor {
            root,
            heading,
            account,
            account_ids: RefCell::new(Vec::new()),
            date,
            payee,
            category,
            split_button,
            notes,
            outflow,
            inflow,
            cleared,
            delete,
            save,
            state: RefCell::new(EditState::default()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dates_parse_in_the_preferred_order() {
        assert_eq!(parse_date("11/05/2026", "MM/dd/yyyy").as_deref(), Some("2026-11-05"));
        assert_eq!(parse_date("05/11/2026", "dd/MM/yyyy").as_deref(), Some("2026-11-05"));
        assert_eq!(parse_date("2026-11-05", "dd.MM.yyyy").as_deref(), Some("2026-11-05"));
        assert_eq!(parse_date("5.11.26", "dd.MM.yyyy").as_deref(), Some("2026-11-05"));
        assert_eq!(parse_date("13/13/2026", "MM/dd/yyyy"), None);
        assert_eq!(format_date("2026-11-05", "dd.MM.yyyy"), "05.11.2026");
    }
}
