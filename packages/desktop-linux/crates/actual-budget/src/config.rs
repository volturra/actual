//! App configuration and secrets on disk (XDG dirs): the server URL, the
//! session token, and per-file encryption keys. Files holding secrets are
//! written with mode 0600.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use actual_sync::crypto::Key;

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct Config {
    pub server_url: Option<String>,
    pub token: Option<String>,
    pub last_budget: Option<String>,
    /// Encryption keys by cloud file id (like the web's `encrypt-keys`).
    #[serde(default)]
    pub keys: BTreeMap<String, Key>,
}

pub fn data_dir() -> PathBuf {
    if let Ok(d) = std::env::var("ACTUAL_LINUX_DATA_DIR") {
        return PathBuf::from(d);
    }
    let base = std::env::var_os("XDG_DATA_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".local/share")))
        .unwrap_or_else(|| PathBuf::from("."));
    base.join("actual-linux")
}

pub fn budgets_dir() -> PathBuf {
    data_dir().join("budgets")
}

fn config_path() -> PathBuf {
    data_dir().join("config.json")
}

impl Config {
    pub fn load() -> Config {
        Config::load_from(&config_path())
    }

    pub fn load_from(path: &Path) -> Config {
        fs::read_to_string(path).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default()
    }

    pub fn save(&self) -> std::io::Result<()> {
        self.save_to(&config_path())
    }

    pub fn save_to(&self, path: &Path) -> std::io::Result<()> {
        if let Some(dir) = path.parent() {
            fs::create_dir_all(dir)?;
        }
        let tmp = path.with_extension("json.tmp");
        {
            use std::io::Write;
            let mut opts = fs::OpenOptions::new();
            opts.write(true).create(true).truncate(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                opts.mode(0o600);
            }
            let mut f = opts.open(&tmp)?;
            f.write_all(serde_json::to_string_pretty(self).expect("config").as_bytes())?;
            f.sync_all()?;
        }
        fs::rename(tmp, path)
    }

    pub fn key_for(&self, cloud_file_id: Option<&str>) -> Option<Key> {
        cloud_file_id.and_then(|id| self.keys.get(id).cloned())
    }
}
