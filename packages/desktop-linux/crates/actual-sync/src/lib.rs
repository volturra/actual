//! A Rust implementation of Actual Budget's sync protocol, wire-compatible
//! with `@actual-app/crdt`, loot-core's sync engine and `actual-server`.
//!
//! - [`timestamp`]: HULC clock (`Timestamp.send` / `recv`)
//! - [`merkle`]: the base-3 minute trie used to find divergence
//! - [`value`]: `0:` / `N:` / `S:` tagged values
//! - [`store`]: the `messages_crdt` log and last-write-wins apply
//! - [`crypto`]: PBKDF2 + AES-256-GCM, compatible with loot-core
//! - [`client`]: the sync-server HTTP API
//! - [`sync`]: the full-sync loop
//! - [`files`]: downloading, importing and uploading budget files

pub mod client;
pub mod crypto;
pub mod files;
pub mod merkle;
pub mod murmur;
pub mod proto;
pub mod store;
pub mod sync;
pub mod timestamp;
pub mod value;

pub use merkle::Trie;
pub use store::{ApplyOutcome, Change, Message, Store};
pub use timestamp::{Clock, Timestamp};
pub use value::Value;

#[derive(Debug, thiserror::Error)]
pub enum SyncError {
    #[error("database error: {0}")]
    Db(#[from] rusqlite::Error),
    #[error(transparent)]
    Clock(#[from] timestamp::ClockError),
    #[error("a change could not be applied to the database: {0}")]
    InvalidSchema(String),
    #[error("this device is out of sync with the server")]
    OutOfSync,
    #[error("could not decrypt data{}", if *.missing_key { " (key not loaded)" } else { "" })]
    DecryptFailure { missing_key: bool },
    #[error("could not encrypt data{}", if *.missing_key { " (key not loaded)" } else { "" })]
    EncryptFailure { missing_key: bool },
    #[error("could not reach the server: {0}")]
    Network(String),
    #[error("not signed in, or the session expired")]
    Unauthorized,
    /// A reason string from the server, e.g. `file-has-reset`.
    #[error("server error: {0}")]
    Server(String),
    #[error("invalid response from server: {0}")]
    Protocol(String),
    #[error("file error: {0}")]
    File(String),
    #[error(transparent)]
    Io(#[from] std::io::Error),
}

impl SyncError {
    /// True when the budget was reset or re-keyed on the server and this
    /// copy must be re-downloaded.
    pub fn needs_redownload(&self) -> bool {
        matches!(self, SyncError::Server(r) if r == "file-has-reset" || r == "file-has-new-key")
    }

    /// Short machine-readable reason, matching the web client's subtypes.
    pub fn reason(&self) -> &str {
        match self {
            SyncError::Db(_) | SyncError::Io(_) | SyncError::File(_) => "internal",
            SyncError::Clock(timestamp::ClockError::Drift) => "clock-drift",
            SyncError::Clock(_) => "internal",
            SyncError::InvalidSchema(_) => "apply-failure",
            SyncError::OutOfSync => "out-of-sync",
            SyncError::DecryptFailure { .. } => "decrypt-failure",
            SyncError::EncryptFailure { .. } => "encrypt-failure",
            SyncError::Network(_) => "network",
            SyncError::Unauthorized => "unauthorized",
            SyncError::Server(r) => r,
            SyncError::Protocol(_) => "internal",
        }
    }
}
