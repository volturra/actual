//! The main window: account sidebar on the left, budget or register on the
//! right, a header bar with undo/redo and sync status.

pub mod autocomplete;
pub mod budget;
pub mod dialogs;
pub mod register;
pub mod setup;

use std::cell::{Cell, RefCell};
use std::rc::{Rc, Weak};

use adw::prelude::*;
use rusqlite::Connection;

use actual_budget::format::AmountFormat;
use actual_budget::{model, schema};

use crate::engine::{Engine, Event, SyncStatus};

#[derive(Clone, Debug, PartialEq)]
pub enum View {
    Budget,
    /// `None` is "All accounts".
    Account(Option<String>),
}

pub struct App {
    pub window: adw::ApplicationWindow,
    pub engine: Engine,
    pub db: Connection,
    pub fmt: Cell<AmountFormat>,
    pub writable: bool,
    view: RefCell<View>,
    toasts: adw::ToastOverlay,
    stack: gtk::Stack,
    sidebar_list: gtk::ListBox,
    sync_button: gtk::Button,
    sync_label: gtk::Label,
    undo_button: gtk::Button,
    redo_button: gtk::Button,
    pub budget_view: RefCell<Option<Rc<budget::BudgetView>>>,
    pub register: RefCell<Option<Rc<register::Register>>>,
    pub on_switch_budget: RefCell<Option<Box<dyn Fn()>>>,
    sidebar_rows: RefCell<Vec<View>>,
    populating: Cell<bool>,
    last_sync_text: RefCell<String>,
    /// Re-downloads the open budget (after a reset on the server).
    pub on_redownload: RefCell<Option<Box<dyn Fn()>>>,
    /// The budget's `dateFormat` preference.
    pub date_format: RefCell<String>,
}

pub type AppRc = Rc<App>;

/// Runs `work` on a worker thread and `done` with its result back on the
/// GTK main thread (for network calls outside the engine).
pub fn background<T: Send + 'static>(work: impl FnOnce() -> T + Send + 'static, done: impl FnOnce(T) + 'static) {
    let (tx, rx) = async_channel::bounded(1);
    std::thread::spawn(move || {
        let _ = tx.send_blocking(work());
    });
    glib::spawn_future_local(async move {
        if let Ok(v) = rx.recv().await {
            done(v);
        }
    });
}

pub fn amount_label(app: &App, cents: i64) -> gtk::Label {
    let l = gtk::Label::new(Some(&app.fmt.get().format(cents)));
    l.add_css_class("tnum");
    l
}

impl App {
    pub fn new(
        gtk_app: &adw::Application,
        engine: Engine,
        db: Connection,
        events: async_channel::Receiver<Event>,
        compat: schema::Compatibility,
        name: String,
    ) -> AppRc {
        let window = adw::ApplicationWindow::builder()
            .application(gtk_app)
            .title(format!("{name} — Actual"))
            .default_width(1320)
            .default_height(860)
            .build();

        let header = adw::HeaderBar::new();
        let undo_button = gtk::Button::from_icon_name("edit-undo-symbolic");
        undo_button.set_tooltip_text(Some("Undo (Ctrl+Z)"));
        undo_button.set_sensitive(false);
        let redo_button = gtk::Button::from_icon_name("edit-redo-symbolic");
        redo_button.set_tooltip_text(Some("Redo (Ctrl+Shift+Z)"));
        redo_button.set_sensitive(false);
        header.pack_start(&undo_button);
        header.pack_start(&redo_button);

        let sync_box = gtk::Box::new(gtk::Orientation::Horizontal, 6);
        let sync_label = gtk::Label::new(Some(""));
        sync_label.add_css_class("dim-label");
        let sync_button = gtk::Button::from_icon_name("view-refresh-symbolic");
        sync_button.set_tooltip_text(Some("Sync now"));
        sync_box.append(&sync_label);
        sync_box.append(&sync_button);
        header.pack_end(&sync_box);

        let menu = gtk::gio::Menu::new();
        menu.append(Some("Switch budget…"), Some("app.switch-budget"));
        menu.append(Some("Keyboard shortcuts"), Some("app.shortcuts"));
        menu.append(Some("About"), Some("app.about"));
        let menu_button = gtk::MenuButton::builder().icon_name("open-menu-symbolic").menu_model(&menu).build();
        header.pack_end(&menu_button);

        let sidebar_list = gtk::ListBox::new();
        sidebar_list.set_selection_mode(gtk::SelectionMode::Single);
        let sidebar_scroll = gtk::ScrolledWindow::builder()
            .child(&sidebar_list)
            .hscrollbar_policy(gtk::PolicyType::Never)
            .vexpand(true)
            .build();
        let sidebar = gtk::Box::new(gtk::Orientation::Vertical, 0);
        sidebar.add_css_class("sidebar-pane");
        sidebar.set_width_request(260);
        let budget_title = gtk::Label::builder().label(&name).xalign(0.0).margin_start(18).margin_top(14).margin_bottom(6).build();
        budget_title.add_css_class("title-3");
        budget_title.set_ellipsize(gtk::pango::EllipsizeMode::End);
        sidebar.append(&budget_title);
        sidebar.append(&sidebar_scroll);
        let add_account = gtk::Button::builder().label("+ Add account").css_classes(["flat"]).margin_bottom(8).margin_start(8).margin_end(8).build();
        sidebar.append(&add_account);

        let stack = gtk::Stack::new();
        stack.set_hexpand(true);
        stack.set_transition_type(gtk::StackTransitionType::Crossfade);

        let content = gtk::Box::new(gtk::Orientation::Vertical, 0);
        if let Some(msg) = compat.describe() {
            let banner = adw::Banner::new(&msg);
            banner.set_revealed(true);
            content.append(&banner);
        }
        content.append(&stack);

        let paned = gtk::Paned::new(gtk::Orientation::Horizontal);
        paned.set_start_child(Some(&sidebar));
        paned.set_end_child(Some(&content));
        paned.set_resize_start_child(false);
        paned.set_shrink_start_child(false);
        paned.set_position(260);

        let toasts = adw::ToastOverlay::new();
        toasts.set_child(Some(&paned));
        let toolbar = adw::ToolbarView::new();
        toolbar.add_top_bar(&header);
        toolbar.set_content(Some(&toasts));
        window.set_content(Some(&toolbar));

        let writable = compat.is_writable();
        let app = Rc::new(App {
            window,
            engine,
            db,
            fmt: Cell::new(AmountFormat::default()),
            writable,
            view: RefCell::new(View::Budget),
            toasts,
            stack,
            sidebar_list,
            sync_button,
            sync_label,
            undo_button,
            redo_button,
            budget_view: RefCell::new(None),
            register: RefCell::new(None),
            on_switch_budget: RefCell::new(None),
            sidebar_rows: RefCell::new(Vec::new()),
            populating: Cell::new(false),
            last_sync_text: RefCell::new(String::new()),
            on_redownload: RefCell::new(None),
            date_format: RefCell::new("MM/dd/yyyy".into()),
        });
        app.load_format();

        let bv = budget::BudgetView::new(&app);
        app.stack.add_named(bv.widget(), Some("budget"));
        *app.budget_view.borrow_mut() = Some(bv);
        let reg = register::Register::new(&app);
        app.stack.add_named(reg.widget(), Some("register"));
        *app.register.borrow_mut() = Some(reg);

        let weak = Rc::downgrade(&app);
        app.sidebar_list.connect_row_selected(move |_, row| {
            let (Some(app), Some(row)) = (weak.upgrade(), row) else { return };
            if app.populating.get() {
                return;
            }
            let idx = row.index();
            let view = app.sidebar_rows.borrow().get(idx as usize).cloned();
            if let Some(v) = view {
                app.show(v);
            }
        });
        let weak = Rc::downgrade(&app);
        app.sync_button.connect_clicked(move |_| {
            if let Some(app) = weak.upgrade() {
                // Also leaves "work offline" mode.
                app.engine.set_online(true);
            }
        });
        let weak = Rc::downgrade(&app);
        app.undo_button.connect_clicked(move |_| {
            if let Some(app) = weak.upgrade() {
                app.undo();
            }
        });
        let weak = Rc::downgrade(&app);
        app.redo_button.connect_clicked(move |_| {
            if let Some(app) = weak.upgrade() {
                app.redo();
            }
        });
        let weak = Rc::downgrade(&app);
        add_account.connect_clicked(move |_| {
            if let Some(app) = weak.upgrade() {
                dialogs::add_account(&app);
            }
        });
        add_account.set_sensitive(writable);

        // Window-level shortcuts (Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y / F5).
        let keys = gtk::EventControllerKey::new();
        let weak = Rc::downgrade(&app);
        keys.connect_key_pressed(move |_, key, _, mods| {
            let Some(app) = weak.upgrade() else { return glib::Propagation::Proceed };
            let ctrl = mods.contains(gtk::gdk::ModifierType::CONTROL_MASK);
            let shift = mods.contains(gtk::gdk::ModifierType::SHIFT_MASK);
            // Leave undo to text fields that keep their own history (notes,
            // names); budget cells and the register editor turn theirs off.
            let in_text = gtk::prelude::GtkWindowExt::focus(&app.window)
                .and_then(|w| w.downcast::<gtk::Text>().ok())
                .is_some_and(|t| t.enables_undo());
            match key {
                gtk::gdk::Key::z | gtk::gdk::Key::Z if ctrl && !in_text => {
                    if shift {
                        app.redo()
                    } else {
                        app.undo()
                    }
                    glib::Propagation::Stop
                }
                gtk::gdk::Key::y if ctrl && !in_text => {
                    app.redo();
                    glib::Propagation::Stop
                }
                gtk::gdk::Key::F5 => {
                    app.engine.sync_now();
                    glib::Propagation::Stop
                }
                _ => glib::Propagation::Proceed,
            }
        });
        // Capture: see the keys before the focused text field does.
        keys.set_propagation_phase(gtk::PropagationPhase::Capture);
        app.window.add_controller(keys);

        let weak = Rc::downgrade(&app);
        glib::spawn_future_local(async move {
            while let Ok(event) = events.recv().await {
                let Some(app) = weak.upgrade() else { break };
                app.handle(event);
            }
        });

        let engine = app.engine.clone();
        let weak = Rc::downgrade(&app);
        let discard = Rc::new(Cell::new(false));
        app.window.connect_close_request(move |w| {
            // Queue the register's unsaved edit before the engine stops.
            if let Some(a) = weak.upgrade() {
                if let Some(r) = a.register.borrow().clone() {
                    if !r.save_pending() && !discard.get() {
                        // An edit that can't be saved: ask before losing it.
                        let d = adw::AlertDialog::new(
                            Some("Discard the unsaved transaction?"),
                            Some("The transaction being edited has a value that can't be saved."),
                        );
                        d.add_responses(&[("keep", "Keep editing"), ("discard", "Discard")]);
                        d.set_response_appearance("discard", adw::ResponseAppearance::Destructive);
                        d.set_close_response("keep");
                        let (w2, discard) = (w.clone(), discard.clone());
                        d.connect_response(Some("discard"), move |_, _| {
                            discard.set(true);
                            w2.close();
                        });
                        d.present(Some(w));
                        return glib::Propagation::Stop;
                    }
                }
                if let Some(b) = a.budget_view.borrow().clone() {
                    b.commit_pending();
                }
            }
            engine.shutdown_wait(std::time::Duration::from_secs(5));
            glib::Propagation::Proceed
        });

        app.refresh_sidebar();
        app.show(View::Budget);
        app
    }

    pub fn weak(self: &Rc<Self>) -> Weak<App> {
        Rc::downgrade(self)
    }

    fn load_format(&self) {
        let pref = |k| model::preference(&self.db, k).ok().flatten();
        self.fmt.set(AmountFormat {
            format: actual_budget::format::NumberFormat::from_pref(pref("numberFormat").as_deref()),
            hide_fraction: pref("hideFraction").as_deref() == Some("true"),
        });
        *self.date_format.borrow_mut() = pref("dateFormat").unwrap_or_else(|| "MM/dd/yyyy".into());
    }

    pub fn toast(&self, msg: &str) {
        let t = adw::Toast::new(msg);
        t.set_timeout(5);
        self.toasts.add_toast(t);
    }

    pub fn undo(&self) {
        self.engine.run("Undo", |s| s.budget.undo());
    }

    pub fn redo(&self) {
        self.engine.run("Redo", |s| s.budget.redo());
    }

    pub fn current_view(&self) -> View {
        self.view.borrow().clone()
    }

    pub fn show(self: &Rc<Self>, view: View) {
        *self.view.borrow_mut() = view.clone();
        match &view {
            View::Budget => {
                self.stack.set_visible_child_name("budget");
                if let Some(bv) = self.budget_view.borrow().as_ref() {
                    bv.refresh();
                }
            }
            View::Account(id) => {
                self.stack.set_visible_child_name("register");
                if let Some(r) = self.register.borrow().as_ref() {
                    r.show_account(id.clone());
                }
            }
        }
        self.select_sidebar(&view);
    }

    fn select_sidebar(&self, view: &View) {
        let idx = self.sidebar_rows.borrow().iter().position(|v| v == view);
        self.populating.set(true);
        match idx.and_then(|i| self.sidebar_list.row_at_index(i as i32)) {
            Some(row) => self.sidebar_list.select_row(Some(&row)),
            None => self.sidebar_list.unselect_all(),
        }
        self.populating.set(false);
    }

    fn handle(self: &Rc<Self>, event: Event) {
        match event {
            Event::Changed(changed) => {
                if changed.touches("preferences") {
                    self.load_format();
                }
                self.refresh_sidebar();
                match self.current_view() {
                    View::Budget => {
                        if let Some(bv) = self.budget_view.borrow().as_ref() {
                            bv.refresh();
                        }
                    }
                    View::Account(_) => {
                        if let Some(r) = self.register.borrow().as_ref() {
                            r.refresh();
                        }
                    }
                }
            }
            Event::Error(msg) => self.toast(&msg),
            Event::Undo { can_undo, can_redo } => {
                self.undo_button.set_sensitive(can_undo && self.writable);
                self.redo_button.set_sensitive(can_redo && self.writable);
            }
            Event::Sync(status) => {
                let (text, tip) = match &status {
                    SyncStatus::Syncing => ("Syncing…".into(), String::new()),
                    SyncStatus::Synced => (format!("Synced {}", chrono::Local::now().format("%H:%M")), String::new()),
                    SyncStatus::Offline(m) => ("Offline".into(), m.clone()),
                    SyncStatus::NeedsLogin => ("Signed out".into(), "Sign in again to sync".into()),
                    SyncStatus::NeedsRedownload => (
                        "Reset on server".into(),
                        "This budget was reset or re-keyed on the server. Use Switch budget to download it again.".into(),
                    ),
                    SyncStatus::Error(m) => ("Sync error".into(), m.clone()),
                };
                self.sync_label.set_text(&text);
                self.sync_label.set_tooltip_text(if tip.is_empty() { None } else { Some(&tip) });
                // Retries repeat the same status; only announce changes.
                let key = format!("{text}\n{tip}");
                let changed = *self.last_sync_text.borrow() != key;
                if matches!(status, SyncStatus::Syncing) {
                    return;
                }
                *self.last_sync_text.borrow_mut() = key;
                if !changed {
                    return;
                }
                match status {
                    SyncStatus::Error(_) => self.toast(&tip),
                    SyncStatus::NeedsLogin => dialogs::relogin(self),
                    SyncStatus::NeedsRedownload => dialogs::redownload(self),
                    _ => {}
                }
            }
        }
    }

    pub fn refresh_sidebar(&self) {
        let accounts = model::accounts(&self.db).unwrap_or_default();
        self.populating.set(true);
        while let Some(row) = self.sidebar_list.row_at_index(0) {
            self.sidebar_list.remove(&row);
        }
        let mut rows = Vec::new();
        let fmt = self.fmt.get();

        let nav = |label: &str| {
            let l = gtk::Label::builder().label(label).xalign(0.0).build();
            l.add_css_class("sidebar-nav");
            gtk::ListBoxRow::builder().child(&l).build()
        };
        self.sidebar_list.append(&nav("Budget"));
        rows.push(View::Budget);

        let total: i64 = accounts.iter().filter(|a| !a.closed).map(|a| a.balance).sum();
        let all = account_row("All accounts", total, &fmt, true);
        self.sidebar_list.append(&all);
        rows.push(View::Account(None));

        let sections: [(&str, Box<dyn Fn(&model::Account) -> bool>); 3] = [
            ("ON BUDGET", Box::new(|a: &model::Account| !a.offbudget && !a.closed)),
            ("OFF BUDGET", Box::new(|a: &model::Account| a.offbudget && !a.closed)),
            ("CLOSED", Box::new(|a: &model::Account| a.closed)),
        ];
        for (title, pred) in sections {
            let list: Vec<&model::Account> = accounts.iter().filter(|a| pred(a)).collect();
            if list.is_empty() {
                continue;
            }
            let sum: i64 = list.iter().map(|a| a.balance).sum();
            let head = gtk::Box::new(gtk::Orientation::Horizontal, 6);
            let hl = gtk::Label::builder().label(title).xalign(0.0).hexpand(true).build();
            hl.add_css_class("sidebar-heading");
            head.append(&hl);
            if title != "CLOSED" {
                let s = gtk::Label::new(Some(&fmt.format(sum)));
                s.add_css_class("sidebar-heading");
                head.append(&s);
            }
            let hrow = gtk::ListBoxRow::builder().child(&head).selectable(false).activatable(false).build();
            self.sidebar_list.append(&hrow);
            rows.push(View::Account(Some(String::from("__heading__"))));
            for a in list {
                self.sidebar_list.append(&account_row(&a.name, a.balance, &fmt, false));
                rows.push(View::Account(Some(a.id.clone())));
            }
        }
        *self.sidebar_rows.borrow_mut() = rows;
        self.populating.set(false);
        let v = self.current_view();
        self.select_sidebar(&v);
    }
}

fn account_row(name: &str, balance: i64, fmt: &AmountFormat, bold: bool) -> gtk::ListBoxRow {
    let b = gtk::Box::new(gtk::Orientation::Horizontal, 8);
    let n = gtk::Label::builder().label(name).xalign(0.0).hexpand(true).build();
    n.set_ellipsize(gtk::pango::EllipsizeMode::End);
    let amt = gtk::Label::new(Some(&fmt.format(balance)));
    amt.add_css_class("sidebar-amount");
    if balance < 0 {
        amt.add_css_class("negative");
    }
    if bold {
        n.add_css_class("sidebar-total");
        amt.add_css_class("sidebar-total");
    }
    b.append(&n);
    b.append(&amt);
    gtk::ListBoxRow::builder().child(&b).build()
}
