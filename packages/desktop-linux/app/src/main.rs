//! Actual for Linux: a native GTK client for Actual Budget that syncs with
//! an Actual sync server alongside the web app.

// GTK signal plumbing is naturally closure- and argument-heavy.
#![allow(clippy::type_complexity, clippy::too_many_arguments)]

mod engine;
mod ui;

use std::cell::RefCell;

use adw::prelude::*;
use rusqlite::{Connection, OpenFlags};

use actual_budget::config::{self, Config};
use actual_budget::{schema, Budget};
use actual_sync::client::ServerClient;
use actual_sync::crypto::Key;
use actual_sync::files::BudgetDir;

use engine::{Engine, EngineState};
use ui::setup::OpenRequest;

const APP_ID: &str = "org.actualbudget.ActualLinux";

thread_local! {
    static CURRENT: RefCell<Option<ui::AppRc>> = const { RefCell::new(None) };
}

fn main() -> glib::ExitCode {
    let args: Vec<String> = std::env::args().collect();
    if args.iter().any(|a| a == "--help" || a == "-h") {
        println!(
            "Usage: actual-linux [--data-dir DIR]\n\n\
             A native Linux client for Actual Budget.\n\n\
             Budgets and settings live in $XDG_DATA_HOME/actual-linux\n\
             (override with --data-dir or ACTUAL_LINUX_DATA_DIR)."
        );
        return glib::ExitCode::SUCCESS;
    }
    if args.iter().any(|a| a == "--version" || a == "-V") {
        println!("actual-linux {}", env!("CARGO_PKG_VERSION"));
        return glib::ExitCode::SUCCESS;
    }
    if let Some(i) = args.iter().position(|a| a == "--data-dir") {
        match args.get(i + 1) {
            // Set before any other thread starts.
            Some(d) => unsafe { std::env::set_var("ACTUAL_LINUX_DATA_DIR", d) },
            None => {
                eprintln!("--data-dir needs a directory");
                return glib::ExitCode::FAILURE;
            }
        }
    }

    let app = adw::Application::builder().application_id(APP_ID).build();
    app.connect_startup(|app| {
        let css = gtk::CssProvider::new();
        css.load_from_string(include_str!("style.css"));
        if let Some(display) = gtk::gdk::Display::default() {
            gtk::style_context_add_provider_for_display(&display, &css, gtk::STYLE_PROVIDER_PRIORITY_APPLICATION);
        }
        install_actions(app);
    });
    app.connect_activate(|app| {
        if let Some(cur) = CURRENT.with(|c| c.borrow().clone()) {
            cur.window.present();
            return;
        }
        let cfg = Config::load();
        let last = cfg.last_budget.as_ref().map(|id| BudgetDir::new(config::budgets_dir().join(id)));
        if let Some(dir) = last.filter(|d| d.db_path().exists()) {
            let meta = dir.read_meta().ok();
            let cloud = meta.as_ref().and_then(|m| m.cloud_file_id().map(str::to_string));
            let key = cfg.key_for(cloud.as_deref());
            let client = cloud.as_ref().and_then(|_| saved_client(&cfg));
            if open_budget(app, OpenRequest { dir, key, client }).is_ok() {
                return;
            }
        }
        show_setup(app, None);
    });
    // GTK would reject our own flags; it gets only the program name.
    app.run_with_args(&args[..1])
}

fn saved_client(cfg: &Config) -> Option<ServerClient> {
    let (url, token) = (cfg.server_url.as_deref()?, cfg.token.clone()?);
    ServerClient::new(url).ok().map(|c| c.with_token(token))
}

fn show_setup(app: &adw::Application, parent: Option<&gtk::Window>) {
    let a = app.clone();
    ui::setup::show(app, parent, move |req| {
        // Close the budget that's open (its engine pushes pending changes).
        if let Some(cur) = CURRENT.with(|c| c.borrow_mut().take()) {
            cur.window.close();
        }
        if let Err(e) = open_budget(&a, req) {
            let a2 = a.clone();
            glib::idle_add_local_once(move || {
                show_setup(&a2, None);
                let d = adw::AlertDialog::new(Some("Couldn't open the budget"), Some(&e));
                d.add_response("ok", "OK");
                if let Some(w) = a2.active_window() {
                    d.present(Some(&w));
                }
            });
        }
    }, || {
        if let Some(cur) = CURRENT.with(|c| c.borrow_mut().take()) {
            cur.window.close();
        }
    });
}

fn open_budget(app: &adw::Application, req: OpenRequest) -> Result<(), String> {
    let OpenRequest { dir, key, client } = req;
    let key_copy = key.clone();
    let budget = Budget::open(dir.clone(), key).map_err(|e| e.to_string())?;
    let name = budget.name().to_string();
    let compat = budget.compat.clone();

    // The UI reads through its own connection; only the engine writes.
    let db = Connection::open_with_flags(
        dir.db_path(),
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX | OpenFlags::SQLITE_OPEN_URI,
    )
    .map_err(|e| e.to_string())?;
    schema::create_views(&db).map_err(|e| e.to_string())?;

    let mut cfg = Config::load();
    cfg.last_budget = dir.path.file_name().map(|n| n.to_string_lossy().to_string());
    let _ = cfg.save();

    let client = if budget.meta.cloud_file_id().is_some() { client } else { None };
    let client_copy = client.clone();
    let (tx, rx) = async_channel::unbounded();
    let engine = Engine::start(EngineState { budget, client }, tx);
    let ui = ui::App::new(app, engine.clone(), db, rx, compat, name);

    let a = app.clone();
    let w = ui.window.clone();
    *ui.on_switch_budget.borrow_mut() = Some(Box::new(move || show_setup(&a, Some(w.upcast_ref()))));

    let (a, d, k, c) = (app.clone(), dir.clone(), key_copy, client_copy);
    *ui.on_redownload.borrow_mut() = Some(Box::new(move || redownload(&a, d.clone(), k.clone(), c.clone())));

    // Follow the network: go offline quietly, sync as soon as it's back.
    let monitor = gtk::gio::NetworkMonitor::default();
    let e = engine.clone();
    let handler = RefCell::new(Some(monitor.connect_network_available_notify(move |m| e.set_online(m.is_network_available()))));
    ui.window.connect_destroy(move |_| {
        if let Some(h) = handler.take() {
            monitor.disconnect(h);
        }
    });

    ui.window.present();
    CURRENT.with(|c| *c.borrow_mut() = Some(ui));
    Ok(())
}

/// Replaces the open budget with the server's copy (after a reset there).
fn redownload(app: &adw::Application, dir: BudgetDir, key: Option<Key>, client: Option<ServerClient>) {
    let Some(client) = client else { return show_setup(app, None) };
    let Some(cloud) = dir.read_meta().ok().and_then(|m| m.cloud_file_id().map(str::to_string)) else {
        return show_setup(app, None);
    };
    if let Some(cur) = CURRENT.with(|c| c.borrow_mut().take()) {
        cur.window.close();
    }
    let local_id = dir.path.file_name().map(|n| n.to_string_lossy().to_string());
    let root = dir.path.parent().map(|p| p.to_path_buf()).unwrap_or_else(config::budgets_dir);
    let a = app.clone();
    let (c2, k2) = (client.clone(), key.clone());
    ui::background(
        move || actual_sync::files::download(&c2, &root, &cloud, k2.as_ref(), local_id.as_deref()),
        move |res| {
            let err = match res {
                Ok(dir) => match open_budget(&a, OpenRequest { dir, key, client: Some(client) }) {
                    Ok(()) => return,
                    Err(e) => e,
                },
                // A new encryption password: the setup window asks for it.
                Err(actual_sync::SyncError::DecryptFailure { .. }) => {
                    "The budget's encryption password changed. Pick the budget again to enter it.".to_string()
                }
                Err(e) => e.to_string(),
            };
            show_setup(&a, None);
            let d = adw::AlertDialog::new(Some("Couldn't download the budget"), Some(&err));
            d.add_response("ok", "OK");
            if let Some(w) = a.active_window() {
                d.present(Some(&w));
            }
        },
    );
}

fn install_actions(app: &adw::Application) {
    let switch = gtk::gio::SimpleAction::new("switch-budget", None);
    let a = app.clone();
    switch.connect_activate(move |_, _| {
        let cur = CURRENT.with(|c| c.borrow().clone());
        match cur {
            Some(cur) => {
                if let Some(f) = cur.on_switch_budget.borrow().as_ref() {
                    f();
                }
            }
            None => show_setup(&a, None),
        }
    });
    app.add_action(&switch);

    let shortcuts = gtk::gio::SimpleAction::new("shortcuts", None);
    let a = app.clone();
    shortcuts.connect_activate(move |_, _| {
        let text = "Ctrl+Z  Undo\nCtrl+Shift+Z / Ctrl+Y  Redo\nF5  Sync now\n\
                    Alt+Left / Alt+Right  Previous / next month\n\
                    Enter  Save the cell and move down\nEscape  Cancel the edit\n\
                    Ctrl+N  New transaction\nCtrl+F  Search transactions\n\
                    Delete  Delete the selected transaction";
        let d = adw::AlertDialog::new(Some("Keyboard shortcuts"), Some(text));
        d.add_response("ok", "Close");
        if let Some(w) = a.active_window() {
            d.present(Some(&w));
        }
    });
    app.add_action(&shortcuts);

    let about = gtk::gio::SimpleAction::new("about", None);
    let a = app.clone();
    about.connect_activate(move |_, _| {
        let d = adw::AboutDialog::builder()
            .application_name("Actual for Linux")
            .application_icon("accessories-calculator")
            .version(env!("CARGO_PKG_VERSION"))
            .comments("A native desktop client for Actual Budget that syncs with your Actual server.")
            .website("https://actualbudget.org")
            .license_type(gtk::License::MitX11)
            .build();
        if let Some(w) = a.active_window() {
            d.present(Some(&w));
        }
    });
    app.add_action(&about);
    app.set_accels_for_action("app.switch-budget", &["<Control>o"]);
}
