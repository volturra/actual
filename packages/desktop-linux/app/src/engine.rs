//! The engine thread owns the open budget (its CRDT clock and write
//! connection) and the server client. The UI never writes to the database
//! itself: it sends jobs here, one at a time, and refreshes from its own
//! read-only connection when the engine reports what changed. This mirrors
//! loot-core's split between the UI and its backend worker, and keeps the
//! clock single-owner so local timestamps stay monotonic.

use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

use actual_budget::{BudgetError, Changed};
use actual_budget::Budget;
use actual_sync::client::ServerClient;
use actual_sync::SyncError;

/// Delay between an edit and the sync that sends it (`FULL_SYNC_DELAY`).
const SYNC_DELAY: Duration = Duration::from_millis(1000);
/// Background sync interval to pick up other devices' changes.
const SYNC_INTERVAL: Duration = Duration::from_secs(60);

pub struct EngineState {
    pub budget: Budget,
    pub client: Option<ServerClient>,
}

pub type Job = Box<dyn FnOnce(&mut EngineState) -> Result<Changed, BudgetError> + Send>;

enum Msg {
    Job(Job, Option<String>),
    Sync,
    SetOnline(bool),
    Shutdown,
}

#[derive(Debug, Clone)]
pub enum SyncStatus {
    Syncing,
    Synced,
    Offline(String),
    /// Signed out or session expired.
    NeedsLogin,
    /// The file was reset or re-keyed on the server.
    NeedsRedownload,
    Error(String),
}

#[derive(Debug)]
pub enum Event {
    Changed(Changed),
    Sync(SyncStatus),
    Error(String),
    Undo { can_undo: bool, can_redo: bool },
}

#[derive(Clone)]
pub struct Engine {
    tx: mpsc::Sender<Msg>,
}

impl Engine {
    pub fn start(state: EngineState, events: async_channel::Sender<Event>) -> Engine {
        let (tx, rx) = mpsc::channel::<Msg>();
        thread::Builder::new()
            .name("actual-engine".into())
            .spawn(move || run(state, rx, events))
            .expect("spawn engine");
        Engine { tx }
    }

    /// Runs `job` on the engine. `label` names the action in error toasts.
    pub fn run(&self, label: &str, job: impl FnOnce(&mut EngineState) -> Result<Changed, BudgetError> + Send + 'static) {
        let _ = self.tx.send(Msg::Job(Box::new(job), Some(label.to_string())));
    }

    pub fn sync_now(&self) {
        let _ = self.tx.send(Msg::Sync);
    }

    pub fn set_online(&self, online: bool) {
        let _ = self.tx.send(Msg::SetOnline(online));
    }

    pub fn shutdown(&self) {
        let _ = self.tx.send(Msg::Shutdown);
    }
}

fn run(mut state: EngineState, rx: mpsc::Receiver<Msg>, events: async_channel::Sender<Event>) {
    let send = |e: Event| {
        let _ = events.send_blocking(e);
    };
    let mut online = true;
    let mut next_sync: Option<Instant> = Some(Instant::now());
    let mut last_sync = Instant::now();

    loop {
        let timeout = match next_sync {
            Some(t) => t.saturating_duration_since(Instant::now()),
            None => SYNC_INTERVAL.saturating_sub(last_sync.elapsed()),
        };
        let msg = match rx.recv_timeout(timeout) {
            Ok(m) => Some(m),
            Err(mpsc::RecvTimeoutError::Timeout) => None,
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        };
        match msg {
            Some(Msg::Shutdown) => {
                // Push pending local changes before exiting.
                if online {
                    do_sync(&mut state, &send);
                }
                break;
            }
            Some(Msg::SetOnline(o)) => {
                online = o;
                if online {
                    next_sync = Some(Instant::now());
                } else {
                    send(Event::Sync(SyncStatus::Offline("Working offline".into())));
                }
            }
            Some(Msg::Job(job, label)) => {
                match job(&mut state) {
                    Ok(changed) => {
                        if !changed.tables.is_empty() {
                            send(Event::Changed(changed));
                            next_sync = Some(Instant::now() + SYNC_DELAY);
                        }
                    }
                    Err(e) => {
                        let what = label.unwrap_or_default();
                        send(Event::Error(if what.is_empty() { e.to_string() } else { format!("{what}: {e}") }));
                    }
                }
                send(Event::Undo { can_undo: state.budget.can_undo(), can_redo: state.budget.can_redo() });
            }
            Some(Msg::Sync) => next_sync = Some(Instant::now()),
            None => {
                if online {
                    do_sync(&mut state, &send);
                }
                last_sync = Instant::now();
                next_sync = None;
            }
        }
    }
}

fn do_sync(state: &mut EngineState, send: &impl Fn(Event)) {
    let Some(client) = state.client.clone() else { return };
    if !state.budget.is_synced() {
        return;
    }
    send(Event::Sync(SyncStatus::Syncing));
    match state.budget.sync(&client) {
        Ok((_, changed)) => {
            if !changed.tables.is_empty() {
                send(Event::Changed(changed));
            }
            send(Event::Sync(SyncStatus::Synced));
        }
        Err(BudgetError::Sync(e)) => send(Event::Sync(status_for(&e))),
        Err(e) => send(Event::Sync(SyncStatus::Error(e.to_string()))),
    }
}

fn status_for(e: &SyncError) -> SyncStatus {
    match e {
        SyncError::Network(_) => SyncStatus::Offline("Can't reach the server; changes are saved locally".into()),
        SyncError::Unauthorized => SyncStatus::NeedsLogin,
        e if e.needs_redownload() => SyncStatus::NeedsRedownload,
        SyncError::DecryptFailure { .. } | SyncError::EncryptFailure { .. } => {
            SyncStatus::Error("This budget is encrypted. Enter its password to sync.".into())
        }
        SyncError::Clock(_) => SyncStatus::Error(
            "Your computer's clock is more than 5 minutes off from other devices. Fix the clock to sync.".into(),
        ),
        SyncError::OutOfSync => SyncStatus::Error("This device is out of sync. Re-download the budget from the server.".into()),
        SyncError::Server(r) if r == "file-needs-upload" || r == "file-old-version" || r == "file-key-mismatch" => {
            SyncStatus::Error("The server copy needs attention in the Actual web app (it was reset or is an old format).".into())
        }
        other => SyncStatus::Error(other.to_string()),
    }
}
