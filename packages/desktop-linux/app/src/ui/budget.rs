//! The budget screen: month columns side by side (YNAB4 style) with a To
//! Be Budgeted banner per month and a grid of Budgeted / Activity /
//! Available per category. Budgeted cells are edited in place; Enter moves
//! down like a spreadsheet.

use std::cell::{Cell, RefCell};
use std::collections::HashSet;
use std::rc::{Rc, Weak};

use adw::prelude::*;

use actual_budget::envelope::{self, EnvelopeBudget};
use actual_budget::month::Month;
use actual_budget::ops;

use super::{dialogs, App};

const CAT_W: i32 = 260;
const COL_W: i32 = 118;

pub struct BudgetView {
    app: Weak<App>,
    root: gtk::Box,
    banners: gtk::Box,
    grid_holder: gtk::ScrolledWindow,
    month_label: gtk::Label,
    start: Cell<Month>,
    count: Cell<usize>,
    show_hidden: Cell<bool>,
    collapsed: RefCell<HashSet<String>>,
    /// (category, month) to focus after the next rebuild.
    focus_next: RefCell<Option<(String, Month)>>,
    /// Budget-cell entries in display order, per month, for Enter-to-next.
    entries: RefCell<Vec<(String, Month, gtk::Entry)>>,
    data: RefCell<Option<EnvelopeBudget>>,
}

pub fn menu_popover(parent: &impl IsA<gtk::Widget>, items: Vec<(String, Box<dyn Fn()>)>) -> gtk::Popover {
    let b = gtk::Box::new(gtk::Orientation::Vertical, 0);
    let pop = gtk::Popover::builder().child(&b).has_arrow(true).build();
    pop.set_parent(parent);
    for (label, f) in items {
        let btn = gtk::Button::builder().label(label).css_classes(["flat"]).build();
        if let Some(l) = btn.child().and_downcast::<gtk::Label>() {
            l.set_xalign(0.0);
        }
        let p = pop.clone();
        btn.connect_clicked(move |_| {
            p.popdown();
            f();
        });
        b.append(&btn);
    }
    pop.connect_closed(|p| {
        let p = p.clone();
        glib::idle_add_local_once(move || p.unparent());
    });
    pop
}

impl BudgetView {
    pub fn new(app: &Rc<App>) -> Rc<BudgetView> {
        let root = gtk::Box::new(gtk::Orientation::Vertical, 0);

        let bar = gtk::Box::new(gtk::Orientation::Horizontal, 6);
        bar.set_margin_top(8);
        bar.set_margin_start(12);
        bar.set_margin_end(12);
        let prev = gtk::Button::from_icon_name("go-previous-symbolic");
        prev.set_tooltip_text(Some("Previous month"));
        let next = gtk::Button::from_icon_name("go-next-symbolic");
        next.set_tooltip_text(Some("Next month"));
        let today = gtk::Button::with_label("This month");
        let month_label = gtk::Label::new(None);
        month_label.add_css_class("title-3");
        bar.append(&prev);
        bar.append(&month_label);
        bar.append(&next);
        bar.append(&today);
        let spacer = gtk::Box::new(gtk::Orientation::Horizontal, 0);
        spacer.set_hexpand(true);
        bar.append(&spacer);
        let months_toggle = gtk::Box::new(gtk::Orientation::Horizontal, 0);
        months_toggle.add_css_class("linked");
        let mut first_btn: Option<gtk::ToggleButton> = None;
        let mut month_btns = Vec::new();
        for n in 1..=3 {
            let b = gtk::ToggleButton::with_label(&format!("{n} mo"));
            b.set_tooltip_text(Some(&format!("Show {n} month(s)")));
            if let Some(f) = &first_btn {
                b.set_group(Some(f));
            } else {
                first_btn = Some(b.clone());
            }
            months_toggle.append(&b);
            month_btns.push(b);
        }
        bar.append(&months_toggle);
        let hidden_toggle = gtk::ToggleButton::with_label("Show hidden");
        bar.append(&hidden_toggle);
        let add_group = gtk::Button::with_label("+ Category group");
        add_group.set_sensitive(app.writable);
        bar.append(&add_group);
        root.append(&bar);

        let banners = gtk::Box::new(gtk::Orientation::Horizontal, 0);
        root.append(&banners);

        let grid_holder = gtk::ScrolledWindow::builder()
            .vexpand(true)
            .hscrollbar_policy(gtk::PolicyType::Automatic)
            .build();
        root.append(&grid_holder);

        let view = Rc::new(BudgetView {
            app: Rc::downgrade(app),
            root,
            banners,
            grid_holder,
            month_label,
            start: Cell::new(Month::current()),
            count: Cell::new(2),
            show_hidden: Cell::new(false),
            collapsed: RefCell::new(HashSet::new()),
            focus_next: RefCell::new(None),
            entries: RefCell::new(Vec::new()),
            data: RefCell::new(None),
        });
        month_btns[1].set_active(true);

        let w = Rc::downgrade(&view);
        prev.connect_clicked(move |_| {
            if let Some(v) = w.upgrade() {
                v.start.set(v.start.get().prev());
                v.rebuild();
            }
        });
        let w = Rc::downgrade(&view);
        next.connect_clicked(move |_| {
            if let Some(v) = w.upgrade() {
                v.start.set(v.start.get().next());
                v.rebuild();
            }
        });
        let w = Rc::downgrade(&view);
        today.connect_clicked(move |_| {
            if let Some(v) = w.upgrade() {
                v.start.set(Month::current());
                v.rebuild();
            }
        });
        for (i, b) in month_btns.iter().enumerate() {
            let w = Rc::downgrade(&view);
            b.connect_toggled(move |b| {
                if b.is_active() {
                    if let Some(v) = w.upgrade() {
                        v.count.set(i + 1);
                        v.rebuild();
                    }
                }
            });
        }
        let w = Rc::downgrade(&view);
        hidden_toggle.connect_toggled(move |b| {
            if let Some(v) = w.upgrade() {
                v.show_hidden.set(b.is_active());
                v.rebuild();
            }
        });
        let w = Rc::downgrade(&view);
        add_group.connect_clicked(move |_| {
            let Some(v) = w.upgrade() else { return };
            let Some(app) = v.app.upgrade() else { return };
            dialogs::prompt_text(&app, "New category group", "Name", "", "Create", move |app, name| {
                app.engine.run("Create group", move |s| {
                    let (_, cs) = ops::create_category_group(s.budget.conn(), &name, false)?;
                    s.budget.apply(cs)
                });
            });
        });

        // Ctrl+Left/Right page months.
        let keys = gtk::EventControllerKey::new();
        let w = Rc::downgrade(&view);
        keys.connect_key_pressed(move |_, key, _, mods| {
            let Some(v) = w.upgrade() else { return glib::Propagation::Proceed };
            if !mods.contains(gtk::gdk::ModifierType::ALT_MASK) {
                return glib::Propagation::Proceed;
            }
            match key {
                gtk::gdk::Key::Left => {
                    v.start.set(v.start.get().prev());
                    v.rebuild();
                    glib::Propagation::Stop
                }
                gtk::gdk::Key::Right => {
                    v.start.set(v.start.get().next());
                    v.rebuild();
                    glib::Propagation::Stop
                }
                _ => glib::Propagation::Proceed,
            }
        });
        view.root.add_controller(keys);
        view
    }

    pub fn widget(&self) -> &gtk::Box {
        &self.root
    }

    /// Recomputes the budget and redraws.
    pub fn refresh(self: &Rc<Self>) {
        let Some(app) = self.app.upgrade() else { return };
        match envelope::compute(&app.db, Month::current()) {
            Ok(b) => *self.data.borrow_mut() = Some(b),
            Err(e) => app.toast(&format!("Could not compute budget: {e}")),
        }
        self.rebuild();
    }

    fn months(&self) -> Vec<Month> {
        (0..self.count.get()).map(|i| self.start.get().plus(i as i32)).collect()
    }

    fn rebuild(self: &Rc<Self>) {
        let Some(app) = self.app.upgrade() else { return };
        let budget_type = actual_budget::model::preference(&app.db, "budgetType").ok().flatten();
        if budget_type.as_deref() == Some("tracking") {
            let page = adw::StatusPage::builder()
                .title("Tracking budgets aren't supported yet")
                .description("This budget uses tracking budgeting. Accounts and transactions work; use the web app for the budget page.")
                .icon_name("dialog-information-symbolic")
                .build();
            self.grid_holder.set_child(Some(&page));
            return;
        }
        let data_ref = self.data.borrow();
        let Some(data) = data_ref.as_ref() else { return };
        let months = self.months();
        let first = months[0];
        let last = *months.last().expect("months");
        self.month_label.set_text(&if first == last {
            format!("{} {}", first.name(), first.year)
        } else {
            format!("{} {} – {} {}", first.short_name(), first.year, last.short_name(), last.year)
        });

        // Banners
        while let Some(c) = self.banners.first_child() {
            self.banners.remove(&c);
        }
        let pad = gtk::Box::new(gtk::Orientation::Horizontal, 0);
        pad.set_size_request(CAT_W, -1);
        self.banners.append(&pad);
        for &m in &months {
            self.banners.append(&self.banner(&app, data, m));
        }

        // Grid
        let grid = gtk::Grid::new();
        grid.add_css_class("budget-grid");
        grid.set_column_spacing(0);
        let mut row = 0;
        let head = gtk::Label::builder().label("CATEGORY").xalign(0.0).build();
        head.add_css_class("budget-colhead");
        head.set_size_request(CAT_W, -1);
        grid.attach(&head, 0, row, 1, 1);
        for (i, _) in months.iter().enumerate() {
            for (j, t) in ["BUDGETED", "ACTIVITY", "AVAILABLE"].iter().enumerate() {
                let l = gtk::Label::builder().label(*t).xalign(1.0).build();
                l.add_css_class("budget-colhead");
                l.set_size_request(COL_W, -1);
                grid.attach(&l, 1 + (i * 3 + j) as i32, row, 1, 1);
            }
        }
        row += 1;

        let mut entries = Vec::new();
        let show_hidden = self.show_hidden.get();
        for g in data.groups.iter().filter(|g| !g.is_income) {
            if g.hidden && !show_hidden {
                continue;
            }
            row = self.group_row(&app, &grid, row, g, &months, data);
            if self.collapsed.borrow().contains(&g.id) {
                continue;
            }
            for c in &g.categories {
                if c.hidden && !show_hidden {
                    continue;
                }
                let dim = c.hidden || g.hidden;
                let name = gtk::Label::builder().label(&c.name).xalign(0.0).build();
                name.set_ellipsize(gtk::pango::EllipsizeMode::End);
                name.add_css_class("budget-cat");
                if dim {
                    name.add_css_class("hidden-cat");
                }
                name.set_size_request(CAT_W, -1);
                self.category_menu(&app, &name, c.id.clone(), c.name.clone(), c.hidden);
                grid.attach(&name, 0, row, 1, 1);
                for (i, &m) in months.iter().enumerate() {
                    let cm = data.category(m, &c.id);
                    let col = 1 + (i * 3) as i32;
                    let entry = gtk::Entry::builder().text(app.fmt.get().format(cm.budgeted)).xalign(1.0).build();
                    entry.add_css_class("budget-input");
                    entry.set_width_chars(9);
                    entry.set_editable(app.writable);
                    let cell = gtk::Box::new(gtk::Orientation::Horizontal, 0);
                    cell.add_css_class("budget-cell");
                    cell.add_css_class("month-start");
                    if dim {
                        cell.add_css_class("hidden-cat");
                    }
                    cell.set_size_request(COL_W, -1);
                    entry.set_hexpand(true);
                    cell.append(&entry);
                    grid.attach(&cell, col, row, 1, 1);
                    self.wire_budget_entry(&app, &entry, c.id.clone(), m, cm.budgeted);
                    entries.push((c.id.clone(), m, entry));

                    let act = super::amount_label(&app, cm.spent);
                    act.set_xalign(1.0);
                    act.add_css_class("budget-cell");
                    act.set_size_request(COL_W, -1);
                    if dim {
                        act.add_css_class("hidden-cat");
                    }
                    grid.attach(&act, col + 1, row, 1, 1);

                    let pill = gtk::Button::with_label(&app.fmt.get().format(cm.balance));
                    pill.add_css_class("pill");
                    pill.add_css_class(match cm.balance {
                        b if b > 0 => "positive",
                        0 => "zero",
                        _ => "negative",
                    });
                    if cm.carryover {
                        pill.add_css_class("carry");
                        pill.set_tooltip_text(Some("Overspending rolls over to next month"));
                    }
                    pill.set_halign(gtk::Align::End);
                    let pc = gtk::Box::new(gtk::Orientation::Horizontal, 0);
                    pc.add_css_class("budget-cell");
                    pc.set_size_request(COL_W, -1);
                    pc.set_halign(gtk::Align::Fill);
                    let sp = gtk::Box::new(gtk::Orientation::Horizontal, 0);
                    sp.set_hexpand(true);
                    pc.append(&sp);
                    pc.append(&pill);
                    grid.attach(&pc, col + 2, row, 1, 1);
                    let w = Rc::downgrade(self);
                    let cat = c.id.clone();
                    pill.connect_clicked(move |p| {
                        if let Some(v) = w.upgrade() {
                            v.balance_popover(p, &cat, m);
                        }
                    });
                }
                row += 1;
            }
        }

        // Income section (read-only totals, like YNAB4's Income row)
        if let Some(inc) = data.groups.iter().find(|g| g.is_income) {
            let l = gtk::Label::builder().label(&inc.name).xalign(0.0).build();
            l.add_css_class("budget-group");
            l.set_size_request(CAT_W, -1);
            grid.attach(&l, 0, row, 1, 1);
            for (i, &m) in months.iter().enumerate() {
                let s = data.month(m).cloned().unwrap_or_default();
                let filler = gtk::Label::new(Some(""));
                filler.add_css_class("budget-group");
                grid.attach(&filler, 1 + (i * 3) as i32, row, 1, 1);
                let a = super::amount_label(&app, s.total_income);
                a.set_xalign(1.0);
                a.add_css_class("budget-group");
                grid.attach(&a, 2 + (i * 3) as i32, row, 2, 1);
            }
            row += 1;
            for c in &inc.categories {
                if c.hidden && !show_hidden {
                    continue;
                }
                let name = gtk::Label::builder().label(&c.name).xalign(0.0).build();
                name.add_css_class("budget-cat");
                name.set_size_request(CAT_W, -1);
                self.category_menu(&app, &name, c.id.clone(), c.name.clone(), c.hidden);
                grid.attach(&name, 0, row, 1, 1);
                for (i, &m) in months.iter().enumerate() {
                    let cm = data.category(m, &c.id);
                    let filler = gtk::Label::new(Some(""));
                    filler.add_css_class("budget-cell");
                    grid.attach(&filler, 1 + (i * 3) as i32, row, 1, 1);
                    let a = super::amount_label(&app, cm.spent);
                    a.set_xalign(1.0);
                    a.add_css_class("budget-cell");
                    grid.attach(&a, 2 + (i * 3) as i32, row, 2, 1);
                }
                row += 1;
            }
            let _ = row;
        }

        drop(data_ref);
        self.grid_holder.set_child(Some(&grid));
        *self.entries.borrow_mut() = entries;
        if let Some((cat, m)) = self.focus_next.borrow_mut().take() {
            let target = self.entries.borrow().iter().find(|(c, mm, _)| *c == cat && *mm == m).map(|(_, _, e)| e.clone());
            if let Some(e) = target {
                e.grab_focus();
            }
        }
    }

    fn banner(self: &Rc<Self>, app: &Rc<App>, data: &EnvelopeBudget, m: Month) -> gtk::Box {
        let s = data.month(m).cloned().unwrap_or_default();
        let fmt = app.fmt.get();
        let b = gtk::Box::new(gtk::Orientation::Vertical, 2);
        b.add_css_class("month-banner");
        b.set_size_request(COL_W * 3 - 12, -1);
        b.add_css_class(match s.to_budget {
            t if t < 0 => "tbb-negative",
            0 => "tbb-zero",
            _ => "tbb-positive",
        });
        let top = gtk::Box::new(gtk::Orientation::Horizontal, 6);
        let name = gtk::Label::builder().label(format!("{} {}", m.name(), m.year)).xalign(0.0).hexpand(true).build();
        name.add_css_class("month-name");
        top.append(&name);
        let menu_btn = gtk::Button::from_icon_name("view-more-symbolic");
        menu_btn.add_css_class("flat");
        menu_btn.set_tooltip_text(Some("Month actions"));
        menu_btn.set_sensitive(app.writable);
        top.append(&menu_btn);
        b.append(&top);
        let amount = gtk::Label::builder().label(fmt.format(s.to_budget)).xalign(0.0).build();
        amount.add_css_class("tbb-amount");
        b.append(&amount);
        let label = gtk::Label::builder()
            .label(if s.to_budget < 0 { "Overbudgeted" } else { "To Be Budgeted" })
            .xalign(0.0)
            .build();
        b.append(&label);
        let in_range = data.months.contains(&m);
        let lines = [
            (format!("Funds for {}", m.short_name()), s.available_funds),
            (format!("Overspent in {}", m.prev().short_name()), s.last_month_overspent),
            (format!("Budgeted in {}", m.short_name()), s.total_budgeted),
            (format!("For {}", m.next().short_name()), -s.buffered_selected),
        ];
        for (t, v) in lines {
            let r = gtk::Box::new(gtk::Orientation::Horizontal, 6);
            r.add_css_class("breakdown");
            r.append(&gtk::Label::builder().label(&t).xalign(0.0).hexpand(true).build());
            r.append(&gtk::Label::new(Some(&fmt.format(v))));
            b.append(&r);
        }
        if !in_range {
            b.set_tooltip_text(Some("Outside this budget's range; amounts appear once it has activity nearby."));
        }
        let w = Rc::downgrade(self);
        menu_btn.connect_clicked(move |btn| {
            let Some(v) = w.upgrade() else { return };
            let Some(app) = v.app.upgrade() else { return };
            let mk = |label: &str, f: Box<dyn Fn()>| (label.to_string(), f);
            let a1 = app.clone();
            let a2 = app.clone();
            let a3 = app.clone();
            let a4 = app.clone();
            let a5 = app.clone();
            let a6 = app.clone();
            let pop = menu_popover(
                btn,
                vec![
                    mk("Copy last month's budget", Box::new(move || {
                        a1.engine.run("Copy last month", move |s| {
                            let cs = ops::copy_previous_month(s.budget.conn(), m)?;
                            s.budget.apply(cs)
                        })
                    })),
                    mk("Budget 3-month average", Box::new(move || {
                        a2.engine.run("3-month average", move |s| {
                            let env = s.budget.envelope()?;
                            let cs = ops::set_n_month_avg(s.budget.conn(), &env, m, 3)?;
                            s.budget.apply(cs)
                        })
                    })),
                    mk("Set all budgets to zero", Box::new(move || {
                        a3.engine.run("Set to zero", move |s| {
                            let cs = ops::set_zero(s.budget.conn(), m)?;
                            s.budget.apply(cs)
                        })
                    })),
                    mk("Hold for next month…", Box::new(move || {
                        dialogs::prompt_amount(&a4, "Hold for next month", "Amount to hold", move |app, amount| {
                            app.engine.run("Hold", move |s| {
                                let env = s.budget.envelope()?;
                                let cs = ops::hold_for_next_month(s.budget.conn(), &env, m, amount)?;
                                if cs.is_empty() {
                                    return Err(actual_budget::BudgetError::Invalid("There's nothing left to hold this month.".into()));
                                }
                                s.budget.apply(cs)
                            });
                        })
                    })),
                    mk("Reset hold", Box::new(move || {
                        a5.engine.run("Reset hold", move |s| {
                            let cs = ops::reset_hold(s.budget.conn(), m)?;
                            s.budget.apply(cs)
                        })
                    })),
                    mk("Month notes…", Box::new(move || dialogs::edit_note(&a6, &format!("budget-{m}"), &format!("Notes for {} {}", m.name(), m.year)))),
                ],
            );
            pop.popup();
        });
        b
    }

    fn group_row(self: &Rc<Self>, app: &Rc<App>, grid: &gtk::Grid, row: i32, g: &actual_budget::model::CategoryGroup, months: &[Month], data: &EnvelopeBudget) -> i32 {
        let collapsed = self.collapsed.borrow().contains(&g.id);
        let hb = gtk::Box::new(gtk::Orientation::Horizontal, 4);
        hb.add_css_class("budget-group");
        hb.set_size_request(CAT_W, -1);
        let arrow = gtk::Button::from_icon_name(if collapsed { "pan-end-symbolic" } else { "pan-down-symbolic" });
        arrow.add_css_class("flat");
        arrow.add_css_class("circular");
        let name = gtk::Label::builder().label(&g.name).xalign(0.0).hexpand(true).build();
        name.set_ellipsize(gtk::pango::EllipsizeMode::End);
        hb.append(&arrow);
        hb.append(&name);
        let add = gtk::Button::from_icon_name("list-add-symbolic");
        add.add_css_class("flat");
        add.set_tooltip_text(Some("Add category"));
        add.set_sensitive(app.writable);
        hb.append(&add);
        grid.attach(&hb, 0, row, 1, 1);
        let w = Rc::downgrade(self);
        let gid = g.id.clone();
        arrow.connect_clicked(move |_| {
            if let Some(v) = w.upgrade() {
                {
                    let mut c = v.collapsed.borrow_mut();
                    if !c.remove(&gid) {
                        c.insert(gid.clone());
                    }
                }
                v.rebuild();
            }
        });
        let gid = g.id.clone();
        let a = app.clone();
        add.connect_clicked(move |_| {
            let gid = gid.clone();
            dialogs::prompt_text(&a, "New category", "Name", "", "Create", move |app, name| {
                let gid = gid.clone();
                app.engine.run("Create category", move |s| {
                    let (_, cs) = ops::create_category(s.budget.conn(), &name, &gid)?;
                    s.budget.apply(cs)
                });
            });
        });
        self.group_menu(app, &hb, g.id.clone(), g.name.clone(), g.hidden);
        for (i, &m) in months.iter().enumerate() {
            let gm = data.month(m).and_then(|s| s.groups.get(&g.id)).cloned().unwrap_or_default();
            for (j, v) in [gm.budgeted, gm.spent, gm.balance].into_iter().enumerate() {
                let l = super::amount_label(app, v);
                l.set_xalign(1.0);
                l.add_css_class("budget-group");
                l.set_size_request(COL_W, -1);
                grid.attach(&l, 1 + (i * 3 + j) as i32, row, 1, 1);
            }
        }
        row + 1
    }

    fn wire_budget_entry(self: &Rc<Self>, app: &Rc<App>, entry: &gtk::Entry, cat: String, m: Month, current: i64) {
        let fmt = app.fmt.get();
        let commit = {
            let w = Rc::downgrade(self);
            let cat = cat.clone();
            Rc::new(move |e: &gtk::Entry, move_down: bool| {
                let Some(v) = w.upgrade() else { return };
                let Some(app) = v.app.upgrade() else { return };
                let text = e.text().to_string();
                let parsed = if text.trim().is_empty() { Some(0) } else { fmt.parse(&text) };
                if move_down {
                    let entries = v.entries.borrow();
                    let pos = entries.iter().position(|(c, mm, _)| *c == cat && *mm == m);
                    let next = pos.and_then(|p| entries.iter().skip(p + 1).find(|(_, mm, _)| *mm == m));
                    *v.focus_next.borrow_mut() = next.map(|(c, mm, _)| (c.clone(), *mm));
                    if let Some((_, _, ne)) = next {
                        ne.grab_focus();
                    }
                }
                match parsed {
                    Some(amount) if amount != current && app.writable => {
                        let cat = cat.clone();
                        app.engine.run("Budget", move |s| {
                            let cs = ops::set_budget(s.budget.conn(), m, &cat, amount)?;
                            s.budget.apply(cs)
                        });
                    }
                    Some(_) => e.set_text(&fmt.format(current)),
                    None => {
                        app.toast(&format!("“{text}” isn't an amount"));
                        e.set_text(&fmt.format(current));
                    }
                }
            })
        };
        let c = commit.clone();
        entry.connect_activate(move |e| c(e, true));
        let focus = gtk::EventControllerFocus::new();
        let e2 = entry.clone();
        focus.connect_enter(move |_| {
            let e = e2.clone();
            glib::idle_add_local_once(move || e.select_region(0, -1));
        });
        let e3 = entry.clone();
        let c = commit.clone();
        let done = Rc::new(Cell::new(false));
        let d = done.clone();
        focus.connect_leave(move |_| {
            if !d.get() && e3.text() != fmt.format(current) {
                d.set(true);
                c(&e3, false);
            }
        });
        entry.add_controller(focus);
        let keys = gtk::EventControllerKey::new();
        let e4 = entry.clone();
        keys.connect_key_pressed(move |_, key, _, _| {
            if key == gtk::gdk::Key::Escape {
                e4.set_text(&fmt.format(current));
                e4.select_region(0, -1);
                return glib::Propagation::Stop;
            }
            glib::Propagation::Proceed
        });
        entry.add_controller(keys);
    }

    fn balance_popover(self: &Rc<Self>, pill: &gtk::Button, cat: &str, m: Month) {
        let Some(app) = self.app.upgrade() else { return };
        if !app.writable {
            return;
        }
        let data_ref = self.data.borrow();
        let Some(data) = data_ref.as_ref() else { return };
        let cm = data.category(m, cat);
        let fmt = app.fmt.get();
        let b = gtk::Box::new(gtk::Orientation::Vertical, 8);
        b.set_margin_top(8);
        b.set_margin_bottom(8);
        b.set_margin_start(8);
        b.set_margin_end(8);
        let pop = gtk::Popover::builder().child(&b).build();
        pop.set_parent(pill);
        pop.connect_closed(|p| {
            let p = p.clone();
            glib::idle_add_local_once(move || p.unparent());
        });

        // Targets: To Be Budgeted plus every visible expense category.
        let mut names = vec!["To Be Budgeted".to_string()];
        let mut ids: Vec<Option<String>> = vec![None];
        for g in data.groups.iter().filter(|g| !g.is_income) {
            for c in &g.categories {
                if c.id != cat && !c.hidden {
                    names.push(format!("{}: {}", g.name, c.name));
                    ids.push(Some(c.id.clone()));
                }
            }
        }
        let names_ref: Vec<&str> = names.iter().map(String::as_str).collect();

        if cm.balance < 0 {
            let t = gtk::Label::builder().label("Cover overspending from").xalign(0.0).build();
            t.add_css_class("heading");
            b.append(&t);
            let from = gtk::DropDown::from_strings(&names_ref);
            from.set_enable_search(true);
            b.append(&from);
            let btn = gtk::Button::with_label(&format!("Cover {}", fmt.format(-cm.balance)));
            btn.add_css_class("suggested-action");
            b.append(&btn);
            let ids2 = ids.clone();
            let a = app.clone();
            let p = pop.clone();
            let cat2 = cat.to_string();
            btn.connect_clicked(move |_| {
                let from = ids2.get(from.selected() as usize).cloned().flatten();
                let cat = cat2.clone();
                a.engine.run("Cover overspending", move |s| {
                    let env = s.budget.envelope()?;
                    let cs = ops::cover_overspending(s.budget.conn(), &env, m, &cat, from.as_deref(), None)?;
                    if cs.is_empty() {
                        return Err(actual_budget::BudgetError::Invalid("Nothing available to cover with there.".into()));
                    }
                    s.budget.apply(cs)
                });
                p.popdown();
            });
            b.append(&gtk::Separator::new(gtk::Orientation::Horizontal));
        }

        let t = gtk::Label::builder().label("Move money to").xalign(0.0).build();
        t.add_css_class("heading");
        b.append(&t);
        let amount = gtk::Entry::builder().text(fmt.format(cm.balance.max(0))).xalign(1.0).build();
        b.append(&amount);
        let to = gtk::DropDown::from_strings(&names_ref);
        to.set_enable_search(true);
        b.append(&to);
        let mv = gtk::Button::with_label("Move");
        b.append(&mv);
        let a = app.clone();
        let p = pop.clone();
        let cat2 = cat.to_string();
        let ids2 = ids.clone();
        mv.connect_clicked(move |_| {
            let Some(cents) = fmt.parse(&amount.text()) else {
                a.toast("Enter an amount to move");
                return;
            };
            let to = ids2.get(to.selected() as usize).cloned().flatten();
            let cat = cat2.clone();
            a.engine.run("Move money", move |s| {
                let env = s.budget.envelope()?;
                let cs = ops::transfer_category(s.budget.conn(), &env, m, cents, &cat, to.as_deref())?;
                s.budget.apply(cs)
            });
            p.popdown();
        });

        b.append(&gtk::Separator::new(gtk::Orientation::Horizontal));
        let carry = gtk::CheckButton::with_label("Roll overspending into next month");
        carry.set_active(cm.carryover);
        b.append(&carry);
        let a = app.clone();
        let cat2 = cat.to_string();
        carry.connect_toggled(move |c| {
            let flag = c.is_active();
            let cat = cat2.clone();
            a.engine.run("Rollover", move |s| {
                let env = s.budget.envelope()?;
                let cs = ops::set_category_carryover(s.budget.conn(), &env, m, &cat, flag)?;
                s.budget.apply(cs)
            });
        });
        let a = app.clone();
        let cat2 = cat.to_string();
        let hist = gtk::Button::with_label("Show transactions");
        hist.add_css_class("flat");
        let p = pop.clone();
        hist.connect_clicked(move |_| {
            p.popdown();
            if let Some(r) = a.register.borrow().as_ref() {
                r.set_filter_category(Some(cat2.clone()), Some(m));
            }
            a.show(super::View::Account(None));
        });
        b.append(&hist);
        drop(data_ref);
        pop.popup();
    }

    fn category_menu(self: &Rc<Self>, app: &Rc<App>, widget: &impl IsA<gtk::Widget>, id: String, name: String, hidden: bool) {
        if !app.writable {
            return;
        }
        let click = gtk::GestureClick::new();
        click.set_button(0);
        let w = Rc::downgrade(self);
        let widget2 = widget.clone().upcast::<gtk::Widget>();
        click.connect_pressed(move |g, n, _, _| {
            let is_menu = g.current_button() == 3;
            if !(is_menu || n == 2) {
                return;
            }
            let Some(v) = w.upgrade() else { return };
            let Some(app) = v.app.upgrade() else { return };
            let (id1, id2, id3) = (id.clone(), id.clone(), id.clone());
            let n1 = name.clone();
            let (a1, a2, a3) = (app.clone(), app.clone(), app.clone());
            let pop = menu_popover(
                &widget2,
                vec![
                    ("Rename…".to_string(), Box::new(move || {
                        let id = id1.clone();
                        dialogs::prompt_text(&a1, "Rename category", "Name", &n1, "Rename", move |app, new| {
                            let cs = ops::update_category(&id, Some(&new), None);
                            app.engine.run("Rename", move |s| s.budget.apply(cs));
                        })
                    })),
                    (if hidden { "Show" } else { "Hide" }.to_string(), Box::new(move || {
                        let cs = ops::update_category(&id2, None, Some(!hidden));
                        a2.engine.run("Hide category", move |s| s.budget.apply(cs));
                    })),
                    ("Delete…".to_string(), Box::new(move || dialogs::delete_category(&a3, &id3))),
                ],
            );
            pop.popup();
        });
        widget.add_controller(click);
    }

    fn group_menu(self: &Rc<Self>, app: &Rc<App>, widget: &gtk::Box, id: String, name: String, hidden: bool) {
        if !app.writable {
            return;
        }
        let click = gtk::GestureClick::new();
        click.set_button(3);
        let a = app.clone();
        let widget2 = widget.clone();
        click.connect_pressed(move |_, _, _, _| {
            let (id1, id2, id3) = (id.clone(), id.clone(), id.clone());
            let n1 = name.clone();
            let (a1, a2, a3) = (a.clone(), a.clone(), a.clone());
            let pop = menu_popover(
                &widget2,
                vec![
                    ("Rename group…".to_string(), Box::new(move || {
                        let id = id1.clone();
                        dialogs::prompt_text(&a1, "Rename group", "Name", &n1, "Rename", move |app, new| {
                            let cs = ops::update_category_group(&id, Some(&new), None);
                            app.engine.run("Rename group", move |s| s.budget.apply(cs));
                        })
                    })),
                    (if hidden { "Show group" } else { "Hide group" }.to_string(), Box::new(move || {
                        let cs = ops::update_category_group(&id2, None, Some(!hidden));
                        a2.engine.run("Hide group", move |s| s.budget.apply(cs));
                    })),
                    ("Delete group…".to_string(), Box::new(move || dialogs::delete_group(&a3, &id3))),
                ],
            );
            pop.popup();
        });
        widget.add_controller(click);
    }
}
