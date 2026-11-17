//! Small modal dialogs: text and amount prompts, notes, deleting categories
//! and groups, adding and closing accounts, and signing in again.

use std::cell::Cell;
use std::rc::Rc;

use adw::prelude::*;

use actual_budget::config::Config;
use actual_budget::model;
use actual_budget::ops::{self, NewTransaction};
use actual_budget::{BudgetError, Changed};

use super::App;

/// Shows an alert with an optional extra widget. `on_ok` runs when the
/// confirm button is pressed (or Enter in `activate`); returning `false`
/// keeps the dialog open so the user can fix their input.
fn ask(
    app: &Rc<App>,
    title: &str,
    body: &str,
    extra: Option<&gtk::Widget>,
    ok_label: &str,
    destructive: bool,
    activate: Option<&gtk::Entry>,
    on_ok: impl Fn(&Rc<App>) -> bool + 'static,
) -> adw::AlertDialog {
    let d = adw::AlertDialog::new(Some(title), if body.is_empty() { None } else { Some(body) });
    d.add_responses(&[("cancel", "Cancel"), ("ok", ok_label)]);
    d.set_response_appearance(
        "ok",
        if destructive { adw::ResponseAppearance::Destructive } else { adw::ResponseAppearance::Suggested },
    );
    d.set_default_response(Some("ok"));
    d.set_close_response("cancel");
    if let Some(w) = extra {
        d.set_extra_child(Some(w));
    }
    let on_ok = Rc::new(on_ok);
    let weak = app.weak();
    // Responses always close an AlertDialog, so validation failures are
    // handled by intercepting the button: run the check first, then close.
    d.set_response_enabled("ok", true);
    let done = Rc::new(Cell::new(false));
    {
        let on_ok = on_ok.clone();
        let weak = weak.clone();
        let done = done.clone();
        d.connect_response(Some("ok"), move |d, _| {
            if done.get() {
                return;
            }
            let Some(app) = weak.upgrade() else { return };
            if !on_ok(&app) {
                // Re-open with the same content so the input isn't lost.
                let d = d.clone();
                let app2 = app.clone();
                glib::idle_add_local_once(move || d.present(Some(&app2.window)));
            } else {
                done.set(true);
            }
        });
    }
    if let Some(entry) = activate {
        let d2 = d.downgrade();
        entry.connect_activate(move |_| {
            if done.get() {
                return;
            }
            let Some(app) = weak.upgrade() else { return };
            if on_ok(&app) {
                done.set(true);
                if let Some(d) = d2.upgrade() {
                    d.force_close();
                }
            }
        });
    }
    d.present(Some(&app.window));
    if let Some(entry) = activate {
        entry.grab_focus();
    }
    d
}

fn labelled(label: &str, w: &impl IsA<gtk::Widget>) -> gtk::Box {
    let b = gtk::Box::new(gtk::Orientation::Vertical, 4);
    let l = gtk::Label::builder().label(label).xalign(0.0).build();
    l.add_css_class("caption-heading");
    b.append(&l);
    b.append(w);
    b
}

/// Asks for a line of text; `cb` gets the trimmed value if it isn't empty.
pub fn prompt_text(
    app: &Rc<App>,
    title: &str,
    label: &str,
    initial: &str,
    action: &str,
    cb: impl Fn(&Rc<App>, String) + 'static,
) {
    let entry = gtk::Entry::builder().text(initial).build();
    let extra = labelled(label, &entry);
    let e = entry.clone();
    ask(app, title, "", Some(extra.upcast_ref()), action, false, Some(&entry), move |app| {
        let v = e.text().trim().to_string();
        if v.is_empty() {
            app.toast("Enter a name.");
            return false;
        }
        cb(app, v);
        true
    });
}

/// Asks for an amount in the budget's number format (arithmetic allowed).
pub fn prompt_amount(app: &Rc<App>, title: &str, label: &str, cb: impl Fn(&Rc<App>, i64) + 'static) {
    let entry = gtk::Entry::builder().input_purpose(gtk::InputPurpose::Number).build();
    let extra = labelled(label, &entry);
    let e = entry.clone();
    ask(app, title, "", Some(extra.upcast_ref()), "OK", false, Some(&entry), move |app| {
        match app.fmt.get().parse(&e.text()) {
            Some(v) => {
                cb(app, v);
                true
            }
            None => {
                app.toast("That isn't a valid amount.");
                false
            }
        }
    });
}

/// Edits a note (`notes` table, keyed by category id, account id or
/// `budget-YYYY-MM`).
pub fn edit_note(app: &Rc<App>, id: &str, title: &str) {
    let current = model::note(&app.db, id).ok().flatten().unwrap_or_default();
    let buf = gtk::TextBuffer::new(None);
    buf.set_text(&current);
    let view = gtk::TextView::with_buffer(&buf);
    view.set_wrap_mode(gtk::WrapMode::WordChar);
    view.set_top_margin(6);
    view.set_bottom_margin(6);
    view.set_left_margin(6);
    view.set_right_margin(6);
    let scroll = gtk::ScrolledWindow::builder().child(&view).min_content_height(160).min_content_width(360).build();
    scroll.add_css_class("card");
    let id = id.to_string();
    let writable = app.writable;
    ask(app, title, "", Some(scroll.upcast_ref()), "Save", false, None, move |app| {
        if !writable {
            return true;
        }
        let text = buf.text(&buf.start_iter(), &buf.end_iter(), false).to_string();
        if text == current {
            return true;
        }
        let cs = ops::set_note(&id, &text);
        app.engine.run("Save note", move |s| s.budget.apply(cs));
        true
    });
    view.grab_focus();
}

/// A drop-down of (id, label) choices; index 0 may be a "none" entry.
fn choice_dropdown(labels: &[String]) -> gtk::DropDown {
    let strs: Vec<&str> = labels.iter().map(String::as_str).collect();
    let dd = gtk::DropDown::from_strings(&strs);
    dd.set_enable_search(labels.len() > 12);
    dd
}

fn category_in_use(app: &App, ids: &[String]) -> bool {
    ids.iter().any(|id| {
        let tx: i64 = app
            .db
            .query_row("SELECT COUNT(*) FROM rs_transactions WHERE category = ?", [id], |r| r.get(0))
            .unwrap_or(0);
        let budgeted: i64 = app
            .db
            .query_row("SELECT COUNT(*) FROM zero_budgets WHERE category = ? AND amount != 0", [id], |r| r.get(0))
            .unwrap_or(0);
        tx > 0 || budgeted > 0
    })
}

/// Deleting a category that has transactions or budgets asks where to move
/// them, like the web's "confirm category delete" modal.
pub fn delete_category(app: &Rc<App>, id: &str) {
    let groups = model::category_groups(&app.db).unwrap_or_default();
    let Some(cat) = groups.iter().flat_map(|g| &g.categories).find(|c| c.id == id).cloned() else { return };
    let ids = vec![cat.id.clone()];
    confirm_delete(app, &format!("Delete “{}”?", cat.name), cat.is_income, &groups, &ids, move |app, target| {
        let id = cat.id.clone();
        app.engine.run("Delete category", move |s| {
            let env = s.budget.envelope()?;
            let cs = ops::delete_category(s.budget.conn(), &env, &id, target.as_deref())?;
            s.budget.apply(cs)
        });
    });
}

pub fn delete_group(app: &Rc<App>, id: &str) {
    let groups = model::category_groups(&app.db).unwrap_or_default();
    let Some(group) = groups.iter().find(|g| g.id == id).cloned() else { return };
    let ids: Vec<String> = group.categories.iter().map(|c| c.id.clone()).collect();
    confirm_delete(app, &format!("Delete the group “{}”?", group.name), group.is_income, &groups, &ids, move |app, target| {
        let id = group.id.clone();
        app.engine.run("Delete group", move |s| {
            let env = s.budget.envelope()?;
            let cs = ops::delete_category_group(s.budget.conn(), &env, &id, target.as_deref())?;
            s.budget.apply(cs)
        });
    });
}

fn confirm_delete(
    app: &Rc<App>,
    title: &str,
    is_income: bool,
    groups: &[model::CategoryGroup],
    deleting: &[String],
    cb: impl Fn(&Rc<App>, Option<String>) + 'static,
) {
    if !category_in_use(app, deleting) {
        ask(app, title, "", None, "Delete", true, None, move |app| {
            cb(app, None);
            true
        });
        return;
    }
    let mut targets: Vec<(String, String)> = Vec::new();
    for g in groups.iter().filter(|g| g.is_income == is_income) {
        for c in &g.categories {
            if !deleting.contains(&c.id) {
                targets.push((c.id.clone(), format!("{} › {}", g.name, c.name)));
            }
        }
    }
    // Income categories must be moved somewhere (their transactions would
    // otherwise drop out of "Available funds"); expense ones may be left
    // uncategorized.
    let mut labels: Vec<String> = Vec::new();
    if !is_income {
        labels.push("Leave transactions uncategorized".into());
    }
    labels.extend(targets.iter().map(|(_, l)| l.clone()));
    if labels.is_empty() {
        app.toast("Create another income category to move these transactions to first.");
        return;
    }
    let dd = choice_dropdown(&labels);
    let extra = labelled("Move its transactions and budgets to", &dd);
    let body = "This category has transactions or budgeted amounts.";
    ask(app, title, body, Some(extra.upcast_ref()), "Delete", true, None, move |app| {
        let idx = dd.selected() as usize;
        let target = if is_income { targets.get(idx) } else if idx == 0 { None } else { targets.get(idx - 1) };
        cb(app, target.map(|(id, _)| id.clone()));
        true
    });
}

pub fn add_account(app: &Rc<App>) {
    let name = gtk::Entry::new();
    let balance = gtk::Entry::builder().placeholder_text(app.fmt.get().format(0)).build();
    let off = gtk::CheckButton::with_label("Off budget (tracking only, e.g. investments, mortgage)");
    let b = gtk::Box::new(gtk::Orientation::Vertical, 12);
    b.append(&labelled("Account name", &name));
    b.append(&labelled("Current balance", &balance));
    b.append(&off);
    let (n, bal) = (name.clone(), balance.clone());
    ask(app, "Add account", "", Some(b.upcast_ref()), "Create", false, Some(&name), move |app| {
        let nm = n.text().trim().to_string();
        if nm.is_empty() {
            app.toast("Give the account a name.");
            return false;
        }
        let text = bal.text();
        let amount = if text.trim().is_empty() { Some(0) } else { app.fmt.get().parse(&text) };
        let Some(amount) = amount else {
            app.toast("That isn't a valid balance.");
            return false;
        };
        let offbudget = off.is_active();
        app.engine.run("Add account", move |s| {
            let (_, cs) = ops::create_account(s.budget.conn(), &nm, amount, offbudget)?;
            s.budget.apply(cs)
        });
        true
    });
}

/// Closing an account with money in it offers to transfer the balance to
/// another account first (the web's "close account" modal).
pub fn close_account(app: &Rc<App>, id: &str) {
    let accounts = model::accounts(&app.db).unwrap_or_default();
    let Some(acct) = accounts.iter().find(|a| a.id == id).cloned() else { return };
    let id = acct.id.clone();
    if acct.balance == 0 {
        ask(app, &format!("Close “{}”?", acct.name), "", None, "Close account", true, None, move |app| {
            let id = id.clone();
            app.engine.run("Close account", move |s| {
                let cs = ops::close_account(s.budget.conn(), &id, false)?;
                s.budget.apply(cs)
            });
            true
        });
        return;
    }
    let others: Vec<model::Account> = accounts.into_iter().filter(|a| a.id != acct.id && !a.closed).collect();
    let mut labels = vec!["Don't transfer — delete the account and its transactions".to_string()];
    labels.extend(others.iter().map(|a| a.name.clone()));
    let dd = choice_dropdown(&labels);
    if !others.is_empty() {
        dd.set_selected(1);
    }
    let extra = labelled("Transfer the balance to", &dd);
    let body = format!("This account has a balance of {}.", app.fmt.get().format(acct.balance));
    let balance = acct.balance;
    ask(app, &format!("Close “{}”?", acct.name), &body, Some(extra.upcast_ref()), "Close account", true, None, move |app| {
        let idx = dd.selected() as usize;
        let target = if idx == 0 { None } else { others.get(idx - 1).map(|a| a.id.clone()) };
        let id = id.clone();
        app.engine.run("Close account", move |s| {
            if let Some(target) = &target {
                let payee = ops::transfer_payee(s.budget.conn(), target)?
                    .ok_or_else(|| BudgetError::Invalid("The other account has no transfer payee.".into()))?;
                let tx = NewTransaction {
                    id: None,
                    account: id.clone(),
                    date: actual_budget::month::today(),
                    amount: -balance,
                    payee: Some(payee),
                    category: None,
                    notes: Some("Closing account".into()),
                    cleared: true,
                    starting_balance_flag: false,
                    splits: Vec::new(),
                    sort_order: None,
                };
                let (ids, cs) = ops::insert_transaction(&tx)?;
                s.budget.edit_transactions(cs, ids, Vec::new())?;
            }
            match target {
                Some(_) => {
                    let mut cs = ops::ChangeSet::new();
                    cs.set("accounts", &id, vec![("closed", true.into())]);
                    s.budget.apply(cs)
                }
                None => {
                    let cs = ops::close_account(s.budget.conn(), &id, true)?;
                    s.budget.apply(cs)
                }
            }
        });
        true
    });
}

thread_local! {
    static RELOGIN_OPEN: Cell<bool> = const { Cell::new(false) };
}

/// The server rejected our token: ask for the password and sync again.
pub fn relogin(app: &Rc<App>) {
    if RELOGIN_OPEN.with(Cell::get) {
        return;
    }
    RELOGIN_OPEN.with(|c| c.set(true));
    let entry = gtk::PasswordEntry::builder().show_peek_icon(true).build();
    let extra = labelled("Server password", &entry);
    let e = entry.clone();
    let d = adw::AlertDialog::new(Some("Sign in again"), Some("Your session on the sync server ended. Changes are kept on this computer until you sign in."));
    d.add_responses(&[("later", "Work offline"), ("ok", "Sign in")]);
    d.set_response_appearance("ok", adw::ResponseAppearance::Suggested);
    d.set_default_response(Some("ok"));
    d.set_close_response("later");
    d.set_extra_child(Some(&extra));
    let weak = app.weak();
    let handled = Rc::new(Cell::new(false));
    let h = handled.clone();
    let submit = Rc::new(move |app: &Rc<App>| {
        if h.replace(true) {
            return;
        }
        let pw = e.text().to_string();
        app.engine.run("Sign in", move |s| {
            let client = s.client.as_mut().ok_or_else(|| BudgetError::Invalid("No server is configured.".into()))?;
            let token = client.login_password(&pw)?;
            let mut cfg = Config::load();
            cfg.token = Some(token);
            cfg.save().map_err(|e| BudgetError::Invalid(format!("Couldn't save the sign-in: {e}")))?;
            Ok(Changed::default())
        });
        app.engine.sync_now();
    });
    {
        let weak = weak.clone();
        let submit = submit.clone();
        let handled = handled.clone();
        d.connect_response(None, move |_, resp| {
            RELOGIN_OPEN.with(|c| c.set(false));
            let Some(app) = weak.upgrade() else { return };
            if resp == "ok" {
                submit(&app);
            } else if !handled.replace(true) {
                app.engine.set_online(false);
            }
        });
    }
    let d2 = d.downgrade();
    entry.connect_activate(move |_| {
        RELOGIN_OPEN.with(|c| c.set(false));
        if let Some(app) = weak.upgrade() {
            submit(&app);
        }
        if let Some(d) = d2.upgrade() {
            d.force_close();
        }
    });
    d.present(Some(&app.window));
    entry.grab_focus();
}

/// Asks to pick one of `options`; `cb` gets its index.
pub fn prompt_choice(
    app: &Rc<App>,
    title: &str,
    label: &str,
    options: &[String],
    action: &str,
    cb: impl Fn(&Rc<App>, usize) + 'static,
) {
    let dd = choice_dropdown(options);
    let extra = labelled(label, &dd);
    ask(app, title, "", Some(extra.upcast_ref()), action, false, None, move |app| {
        cb(app, dd.selected() as usize);
        true
    });
}

/// Asks for an amount and one of `options` (e.g. "move 50 to Groceries").
pub fn prompt_amount_choice(
    app: &Rc<App>,
    title: &str,
    initial: i64,
    label: &str,
    options: &[String],
    action: &str,
    cb: impl Fn(&Rc<App>, i64, usize) + 'static,
) {
    let entry = gtk::Entry::builder().text(app.fmt.get().format(initial)).xalign(1.0).build();
    entry.set_enable_undo(false);
    let dd = choice_dropdown(options);
    let b = gtk::Box::new(gtk::Orientation::Vertical, 12);
    b.append(&labelled("Amount", &entry));
    b.append(&labelled(label, &dd));
    let e = entry.clone();
    ask(app, title, "", Some(b.upcast_ref()), action, false, Some(&entry), move |app| match app.fmt.get().parse(&e.text()) {
        Some(v) if v > 0 => {
            cb(app, v, dd.selected() as usize);
            true
        }
        _ => {
            app.toast("Enter an amount above zero.");
            false
        }
    });
}

/// The server copy was reset or re-keyed: this copy can't sync any more and
/// has to be replaced with a fresh download.
pub fn redownload(app: &Rc<App>) {
    let d = adw::AlertDialog::new(
        Some("This budget was reset on the server"),
        Some(
            "Another device reset sync or changed the encryption password. Download the server's copy to keep syncing. \
             Changes made here since the last sync will be replaced.",
        ),
    );
    d.add_responses(&[("later", "Not now"), ("ok", "Download again")]);
    d.set_response_appearance("ok", adw::ResponseAppearance::Suggested);
    d.set_default_response(Some("ok"));
    d.set_close_response("later");
    let weak = app.weak();
    d.connect_response(Some("ok"), move |_, _| {
        if let Some(app) = weak.upgrade() {
            if let Some(f) = app.on_redownload.borrow().as_ref() {
                f();
            }
        }
    });
    d.present(Some(&app.window));
}
