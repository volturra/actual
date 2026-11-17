//! The start window: sign in to a sync server, then pick a budget to open
//! (downloading it the first time, and unlocking it if it's encrypted).
//! Budgets already on this computer open offline too.

use std::rc::Rc;

use adw::prelude::*;

use actual_budget::config::{self, Config};
use actual_sync::client::{RemoteFile, ServerClient};
use actual_sync::crypto::Key;
use actual_sync::files::{self, BudgetDir, Metadata};
use actual_sync::SyncError;

use super::background;

/// A budget the user chose, ready to open.
pub struct OpenRequest {
    pub dir: BudgetDir,
    pub key: Option<Key>,
    pub client: Option<ServerClient>,
}

struct Setup {
    window: adw::Window,
    toasts: adw::ToastOverlay,
    stack: gtk::Stack,
    url: adw::EntryRow,
    password: adw::PasswordEntryRow,
    sign_in: gtk::Button,
    list: adw::PreferencesGroup,
    list_rows: std::cell::RefCell<Vec<adw::ActionRow>>,
    server_label: gtk::Label,
    spinner: gtk::Spinner,
    client: std::cell::RefCell<Option<ServerClient>>,
    /// Opens the budget; false when the open one can't be left yet.
    on_open: Box<dyn Fn(OpenRequest) -> bool>,
    /// Closes the budget that's open, before its files are replaced; false
    /// when it can't be left yet.
    close_current: Box<dyn Fn() -> bool>,
}

fn friendly(e: &SyncError) -> String {
    match e {
        SyncError::Network(_) => "Couldn't reach the server. Check the address and your connection.".into(),
        SyncError::Unauthorized => "The password is incorrect.".into(),
        SyncError::DecryptFailure { .. } => "Couldn't decrypt this budget with that password.".into(),
        other => other.to_string(),
    }
}

/// Shows the start window. `on_open` runs (and the window closes) once a
/// budget is ready.
pub fn show(
    gtk_app: &adw::Application,
    parent: Option<&gtk::Window>,
    on_open: impl Fn(OpenRequest) -> bool + 'static,
    close_current: impl Fn() -> bool + 'static,
) {
    let window = adw::Window::builder().application(gtk_app).title("Open a budget — Actual").default_width(560).default_height(640).build();
    window.set_widget_name("setup");
    if let Some(p) = parent {
        window.set_transient_for(Some(p));
        window.set_modal(true);
    }
    let toasts = adw::ToastOverlay::new();
    let stack = gtk::Stack::new();
    stack.set_transition_type(gtk::StackTransitionType::SlideLeftRight);
    toasts.set_child(Some(&stack));
    let toolbar = adw::ToolbarView::new();
    toolbar.add_top_bar(&adw::HeaderBar::new());
    toolbar.set_content(Some(&toasts));
    window.set_content(Some(&toolbar));

    // --- server page
    let cfg = Config::load();
    let server_page = gtk::Box::new(gtk::Orientation::Vertical, 18);
    server_page.set_margin_start(32);
    server_page.set_margin_end(32);
    server_page.set_margin_top(24);
    server_page.set_margin_bottom(24);
    let title = gtk::Label::new(Some("Actual"));
    title.add_css_class("welcome-title");
    let sub = gtk::Label::new(Some("Sign in to your sync server to open a budget. Your budget syncs with the web app and your other devices."));
    sub.set_wrap(true);
    sub.set_justify(gtk::Justification::Center);
    sub.add_css_class("dim-label");
    server_page.append(&title);
    server_page.append(&sub);
    let group = adw::PreferencesGroup::new();
    let url = adw::EntryRow::builder().title("Server URL").build();
    url.set_text(cfg.server_url.as_deref().unwrap_or("http://localhost:5006"));
    let password = adw::PasswordEntryRow::builder().title("Password").build();
    group.add(&url);
    group.add(&password);
    server_page.append(&group);
    let sign_in = gtk::Button::with_label("Sign in");
    sign_in.add_css_class("suggested-action");
    sign_in.add_css_class("pill");
    sign_in.set_halign(gtk::Align::Center);
    server_page.append(&sign_in);
    let spinner = gtk::Spinner::new();
    server_page.append(&spinner);
    let offline = gtk::Button::with_label("Open a budget on this computer");
    offline.add_css_class("flat");
    offline.set_halign(gtk::Align::Center);
    offline.set_visible(!files::list_local(&config::budgets_dir()).is_empty());
    server_page.append(&offline);
    stack.add_named(&server_page, Some("server"));

    // --- budget list page
    let list_page = gtk::Box::new(gtk::Orientation::Vertical, 12);
    list_page.set_margin_start(24);
    list_page.set_margin_end(24);
    list_page.set_margin_top(18);
    list_page.set_margin_bottom(18);
    let head = gtk::Box::new(gtk::Orientation::Horizontal, 8);
    let server_label = gtk::Label::builder().xalign(0.0).hexpand(true).build();
    server_label.add_css_class("dim-label");
    server_label.set_ellipsize(gtk::pango::EllipsizeMode::Middle);
    let refresh = gtk::Button::from_icon_name("view-refresh-symbolic");
    refresh.set_tooltip_text(Some("Refresh"));
    refresh.add_css_class("flat");
    let change = gtk::Button::with_label("Change server");
    change.add_css_class("flat");
    head.append(&server_label);
    head.append(&refresh);
    head.append(&change);
    list_page.append(&head);
    let list = adw::PreferencesGroup::builder().title("Budgets").build();
    let scroll = gtk::ScrolledWindow::builder().child(&list).vexpand(true).hscrollbar_policy(gtk::PolicyType::Never).build();
    list_page.append(&scroll);
    stack.add_named(&list_page, Some("budgets"));

    let s = Rc::new(Setup {
        window,
        toasts,
        stack,
        url,
        password,
        sign_in,
        list,
        list_rows: Default::default(),
        server_label,
        spinner,
        client: Default::default(),
        on_open: Box::new(on_open),
        close_current: Box::new(close_current),
    });

    let w = Rc::downgrade(&s);
    let do_sign_in = move || {
        if let Some(s) = w.upgrade() {
            s.sign_in();
        }
    };
    let f = do_sign_in.clone();
    s.sign_in.connect_clicked(move |_| f());
    let f = do_sign_in;
    s.password.connect_entry_activated(move |_| f());
    let w = Rc::downgrade(&s);
    offline.connect_clicked(move |_| {
        if let Some(s) = w.upgrade() {
            *s.client.borrow_mut() = None;
            s.server_label.set_text("Not signed in — budgets on this computer");
            s.populate(Vec::new());
            s.stack.set_visible_child_name("budgets");
        }
    });
    let w = Rc::downgrade(&s);
    change.connect_clicked(move |_| {
        if let Some(s) = w.upgrade() {
            s.stack.set_visible_child_name("server");
        }
    });
    let w = Rc::downgrade(&s);
    refresh.connect_clicked(move |_| {
        if let Some(s) = w.upgrade() {
            s.load_files();
        }
    });

    // Reuse a saved session when there is one.
    if let (Some(u), Some(t)) = (cfg.server_url.clone(), cfg.token.clone()) {
        if let Ok(c) = ServerClient::new(&u) {
            let client = c.with_token(t);
            *s.client.borrow_mut() = Some(client.clone());
            s.server_label.set_text(&u);
            s.stack.set_visible_child_name("budgets");
            s.load_files();
        }
    }
    s.window.present();
    // Keep the setup state alive as long as its window.
    let keep = s.clone();
    s.window.connect_close_request(move |_| {
        let _ = &keep;
        glib::Propagation::Proceed
    });
}

impl Setup {
    fn toast(&self, msg: &str) {
        self.toasts.add_toast(adw::Toast::new(msg));
    }

    fn busy(&self, on: bool) {
        self.spinner.set_spinning(on);
        self.sign_in.set_sensitive(!on);
        self.window.set_sensitive(!on);
    }

    fn sign_in(self: &Rc<Self>) {
        let mut url = self.url.text().trim().trim_end_matches('/').to_string();
        if url.is_empty() {
            self.toast("Enter your server's address.");
            return;
        }
        if !url.starts_with("http://") && !url.starts_with("https://") {
            url = format!("https://{url}");
        }
        let password = self.password.text().to_string();
        self.busy(true);
        let w = Rc::downgrade(self);
        let u = url.clone();
        background(
            move || -> Result<ServerClient, SyncError> {
                let mut c = ServerClient::new(&u)?;
                c.login_password(&password)?;
                Ok(c)
            },
            move |res| {
                let Some(s) = w.upgrade() else { return };
                s.busy(false);
                match res {
                    Ok(client) => {
                        let mut cfg = Config::load();
                        cfg.server_url = Some(url.clone());
                        cfg.token = client.token().map(str::to_string);
                        if let Err(e) = cfg.save() {
                            s.toast(&format!("Couldn't save settings: {e}"));
                        }
                        s.password.set_text("");
                        *s.client.borrow_mut() = Some(client);
                        s.server_label.set_text(&url);
                        s.stack.set_visible_child_name("budgets");
                        s.load_files();
                    }
                    Err(e) => s.toast(&friendly(&e)),
                }
            },
        );
    }

    fn load_files(self: &Rc<Self>) {
        let Some(client) = self.client.borrow().clone() else {
            self.populate(Vec::new());
            return;
        };
        self.busy(true);
        let w = Rc::downgrade(self);
        background(
            move || client.list_files(),
            move |res| {
                let Some(s) = w.upgrade() else { return };
                s.busy(false);
                match res {
                    Ok(files) => s.populate(files.into_iter().filter(|f| f.deleted == 0).collect()),
                    Err(SyncError::Unauthorized) => {
                        s.toast("Your session ended. Sign in again.");
                        s.stack.set_visible_child_name("server");
                    }
                    Err(e) => {
                        s.toast(&friendly(&e));
                        s.populate(Vec::new());
                    }
                }
            },
        );
    }

    fn populate(self: &Rc<Self>, remote: Vec<RemoteFile>) {
        for r in self.list_rows.borrow_mut().drain(..) {
            self.list.remove(&r);
        }
        let local = files::list_local(&config::budgets_dir());
        let signed_in = self.client.borrow().is_some();
        let mut rows = Vec::new();
        for f in &remote {
            let here = local.iter().find(|(_, m)| m.cloud_file_id() == Some(f.file_id.as_str()));
            let mut bits = Vec::new();
            if f.encrypt_key_id.is_some() {
                bits.push("Encrypted");
            }
            bits.push(if here.is_some() { "On this computer" } else { "On the server" });
            let row = adw::ActionRow::builder().title(glib::markup_escape_text(&f.name).as_str()).subtitle(bits.join(" · ")).activatable(true).build();
            row.add_suffix(&gtk::Image::from_icon_name(if here.is_some() { "go-next-symbolic" } else { "folder-download-symbolic" }));
            let w = Rc::downgrade(self);
            let file = f.clone();
            row.connect_activated(move |_| {
                if let Some(s) = w.upgrade() {
                    s.open_remote(file.clone());
                }
            });
            self.list.add(&row);
            rows.push(row);
        }
        for (dir, meta) in local {
            let on_server = meta.cloud_file_id().is_some_and(|id| remote.iter().any(|f| f.file_id == id));
            if on_server {
                continue;
            }
            let sub = match (meta.cloud_file_id(), signed_in) {
                (Some(_), true) => "On this computer · not found on this server",
                (Some(_), false) => "On this computer · syncs when signed in",
                (None, _) => "On this computer only",
            };
            let row = adw::ActionRow::builder()
                .title(glib::markup_escape_text(meta.budget_name()).as_str())
                .subtitle(sub)
                .activatable(true)
                .build();
            row.add_suffix(&gtk::Image::from_icon_name("go-next-symbolic"));
            let w = Rc::downgrade(self);
            row.connect_activated(move |_| {
                if let Some(s) = w.upgrade() {
                    s.open_local(dir.clone(), meta.clone());
                }
            });
            self.list.add(&row);
            rows.push(row);
        }
        if rows.is_empty() {
            let row = adw::ActionRow::builder()
                .title(if signed_in { "No budgets on this server yet" } else { "No budgets on this computer" })
                .subtitle(if signed_in { "Create one in the Actual web app, then refresh." } else { "Sign in to a server to download one." })
                .build();
            self.list.add(&row);
            rows.push(row);
        }
        *self.list_rows.borrow_mut() = rows;
    }

    fn open_local(self: &Rc<Self>, dir: BudgetDir, meta: Metadata) {
        let cfg = Config::load();
        let key = cfg.key_for(meta.cloud_file_id());
        let client = if meta.cloud_file_id().is_some() {
            self.client.borrow().clone().or_else(|| {
                let (u, t) = (cfg.server_url.as_deref()?, cfg.token.clone()?);
                ServerClient::new(u).ok().map(|c| c.with_token(t))
            })
        } else {
            None
        };
        self.finish(OpenRequest { dir, key, client });
    }

    fn open_remote(self: &Rc<Self>, file: RemoteFile) {
        let Some(client) = self.client.borrow().clone() else { return };
        let cfg = Config::load();
        let key = match (&file.encrypt_key_id, cfg.keys.get(&file.file_id)) {
            (None, _) => None,
            (Some(kid), Some(k)) if &k.id == kid => Some(k.clone()),
            (Some(_), _) => {
                self.ask_password(file, client);
                return;
            }
        };
        self.download(file, client, key);
    }

    fn ask_password(self: &Rc<Self>, file: RemoteFile, client: ServerClient) {
        let entry = gtk::PasswordEntry::builder().show_peek_icon(true).build();
        entry.set_activates_default(true);
        let d = adw::AlertDialog::new(
            Some("Encrypted budget"),
            Some(&format!("“{}” is end-to-end encrypted. Enter its encryption password.", file.name)),
        );
        d.add_responses(&[("cancel", "Cancel"), ("ok", "Unlock")]);
        d.set_response_appearance("ok", adw::ResponseAppearance::Suggested);
        d.set_default_response(Some("ok"));
        d.set_close_response("cancel");
        d.set_extra_child(Some(&entry));
        let w = Rc::downgrade(self);
        d.connect_response(Some("ok"), move |_, _| {
            let Some(s) = w.upgrade() else { return };
            let pw = entry.text().to_string();
            let (c, fid) = (client.clone(), file.file_id.clone());
            let file = file.clone();
            let client = client.clone();
            s.busy(true);
            let w = Rc::downgrade(&s);
            background(
                move || actual_budget::unlock_key(&c, &fid, &pw),
                move |res| {
                    let Some(s) = w.upgrade() else { return };
                    s.busy(false);
                    match res {
                        Ok(key) => {
                            let mut cfg = Config::load();
                            cfg.keys.insert(file.file_id.clone(), key.clone());
                            if let Err(e) = cfg.save() {
                                s.toast(&format!("Couldn't save the key: {e}"));
                            }
                            s.download(file, client, Some(key));
                        }
                        Err(e) => s.toast(&e.to_string()),
                    }
                },
            );
        });
        d.present(Some(&self.window));
    }

    fn download(self: &Rc<Self>, file: RemoteFile, client: ServerClient, key: Option<Key>) {
        let root = config::budgets_dir();
        let mut replace = None;
        if let Some(dir) = actual_budget::find_local_by_cloud_id(&root, &file.file_id) {
            // A reset or a new encryption key on the server gives the file a
            // new group (or key) id; the local copy then can't sync and is
            // replaced. Otherwise it's opened and syncs up to date.
            let current = dir.read_meta().ok().is_some_and(|m| {
                m.group_id() == file.group_id.as_deref() && m.encrypt_key_id() == file.encrypt_key_id.as_deref()
            });
            if current {
                return self.finish(OpenRequest { dir, key, client: Some(client) });
            }
            replace = dir.path.file_name().map(|n| n.to_string_lossy().to_string());
            if !(self.close_current)() {
                self.toast("Fix or clear the transaction being edited first.");
                return;
            }
        }
        self.busy(true);
        self.toast(&format!("Downloading “{}”…", file.name));
        let w = Rc::downgrade(self);
        let (c, k) = (client.clone(), key.clone());
        background(
            move || {
                std::fs::create_dir_all(&root).map_err(SyncError::from)?;
                files::download(&c, &root, &file.file_id, k.as_ref(), replace.as_deref())
            },
            move |res| {
                let Some(s) = w.upgrade() else { return };
                s.busy(false);
                match res {
                    Ok(dir) => s.finish(OpenRequest { dir, key, client: Some(client) }),
                    Err(e) => s.toast(&friendly(&e)),
                }
            },
        );
    }

    fn finish(&self, req: OpenRequest) {
        if (self.on_open)(req) {
            self.window.close();
        } else {
            self.toast("Fix or clear the transaction being edited first.");
        }
    }
}
