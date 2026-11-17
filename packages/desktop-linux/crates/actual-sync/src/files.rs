//! Budget files on disk and on the server, compatible with loot-core
//! `cloud-storage.ts`: a budget is a directory with `db.sqlite` and
//! `metadata.json`; on the server it is a zip of the two, optionally
//! AES-256-GCM encrypted as a whole.

use std::fs;
use std::io::{Cursor, Read, Write};
use std::path::{Path, PathBuf};

use serde_json::{Map, Value as Json};

use crate::client::ServerClient;
use crate::crypto::{EncryptMeta, Key};
use crate::SyncError;

/// Refuse archives that would unpack to more than this.
const MAX_UNZIPPED_BYTES: u64 = 2 * 1024 * 1024 * 1024;

/// `metadata.json`: the budget's local prefs. Unknown keys are preserved.
#[derive(Clone, Debug, Default)]
pub struct Metadata(pub Map<String, Json>);

impl Metadata {
    pub fn str(&self, key: &str) -> Option<&str> {
        self.0.get(key).and_then(Json::as_str)
    }
    pub fn bool(&self, key: &str) -> bool {
        self.0.get(key).and_then(Json::as_bool).unwrap_or(false)
    }
    pub fn set(&mut self, key: &str, value: impl Into<Json>) {
        self.0.insert(key.to_string(), value.into());
    }
    pub fn id(&self) -> Option<&str> {
        self.str("id")
    }
    pub fn budget_name(&self) -> &str {
        self.str("budgetName").unwrap_or("Budget")
    }
    pub fn cloud_file_id(&self) -> Option<&str> {
        self.str("cloudFileId")
    }
    pub fn group_id(&self) -> Option<&str> {
        self.str("groupId")
    }
    pub fn encrypt_key_id(&self) -> Option<&str> {
        self.str("encryptKeyId")
    }
    pub fn last_synced_timestamp(&self) -> Option<&str> {
        self.str("lastSyncedTimestamp")
    }
}

/// A budget directory on disk.
#[derive(Clone, Debug)]
pub struct BudgetDir {
    pub path: PathBuf,
}

impl BudgetDir {
    pub fn new(path: impl Into<PathBuf>) -> Self {
        BudgetDir { path: path.into() }
    }
    pub fn db_path(&self) -> PathBuf {
        self.path.join("db.sqlite")
    }
    pub fn meta_path(&self) -> PathBuf {
        self.path.join("metadata.json")
    }
    pub fn read_meta(&self) -> Result<Metadata, SyncError> {
        let text = fs::read_to_string(self.meta_path())?;
        match serde_json::from_str(&text) {
            Ok(Json::Object(map)) => Ok(Metadata(map)),
            _ => Err(SyncError::File("invalid metadata.json".into())),
        }
    }
    /// Writes atomically so a crash never leaves a truncated file.
    pub fn write_meta(&self, meta: &Metadata) -> Result<(), SyncError> {
        let tmp = self.path.join("metadata.json.tmp");
        fs::write(&tmp, serde_json::to_vec_pretty(&Json::Object(meta.0.clone())).expect("json"))?;
        fs::rename(tmp, self.meta_path())?;
        Ok(())
    }
}

/// Lists local budgets under a root directory.
pub fn list_local(root: &Path) -> Vec<(BudgetDir, Metadata)> {
    let mut out = Vec::new();
    let Ok(entries) = fs::read_dir(root) else { return out };
    for e in entries.flatten() {
        let dir = BudgetDir::new(e.path());
        if dir.db_path().exists() {
            if let Ok(meta) = dir.read_meta() {
                out.push((dir, meta));
            }
        }
    }
    out.sort_by(|a, b| a.1.budget_name().cmp(b.1.budget_name()));
    out
}

/// Unpacks a budget zip: both files must come from the same directory,
/// preferring the archive root.
pub fn unzip_budget(buffer: &[u8]) -> Result<(Vec<u8>, Vec<u8>), SyncError> {
    let mut archive = zip::ZipArchive::new(Cursor::new(buffer)).map_err(|_| SyncError::File("not-zip-file".into()))?;
    let names: Vec<String> = archive.file_names().map(str::to_string).collect();
    let total: u64 = (0..archive.len())
        .filter_map(|i| archive.by_index(i).ok().map(|f| f.size()))
        .sum();
    if total > MAX_UNZIPPED_BYTES {
        return Err(SyncError::File("zip-too-large".into()));
    }
    let dirs_with = |file: &str| -> Vec<String> {
        names
            .iter()
            .filter(|n| *n == file || n.ends_with(&format!("/{file}")))
            .map(|n| n[..n.len() - file.len()].to_string())
            .collect()
    };
    let db_dirs = dirs_with("db.sqlite");
    let meta_dirs = dirs_with("metadata.json");
    let shared: Vec<&String> = db_dirs.iter().filter(|d| meta_dirs.contains(d)).collect();
    let dir = if shared.iter().any(|d| d.is_empty()) {
        String::new()
    } else if shared.len() == 1 {
        shared[0].clone()
    } else {
        return Err(SyncError::File("invalid-zip-file".into()));
    };
    let mut read = |name: String| -> Result<Vec<u8>, SyncError> {
        let mut f = archive.by_name(&name).map_err(|e| SyncError::File(e.to_string()))?;
        let mut buf = Vec::new();
        f.read_to_end(&mut buf)?;
        Ok(buf)
    };
    let db = read(format!("{dir}db.sqlite"))?;
    let meta = read(format!("{dir}metadata.json"))?;
    Ok((db, meta))
}

pub fn zip_budget(db: &[u8], meta: &[u8]) -> Result<Vec<u8>, SyncError> {
    let mut buf = Cursor::new(Vec::new());
    {
        let mut w = zip::ZipWriter::new(&mut buf);
        let opts = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
        w.start_file("db.sqlite", opts).map_err(|e| SyncError::File(e.to_string()))?;
        w.write_all(db)?;
        w.start_file("metadata.json", opts).map_err(|e| SyncError::File(e.to_string()))?;
        w.write_all(meta)?;
        w.finish().map_err(|e| SyncError::File(e.to_string()))?;
    }
    Ok(buf.into_inner())
}

fn today() -> String {
    chrono::Local::now().format("%Y-%m-%d").to_string()
}

/// Downloads a budget from the server into `root/<local id>` (or replaces
/// `local_id` if given, keeping the directory and its backups). The key
/// must already be verified when the file is encrypted.
pub fn download(
    client: &ServerClient,
    root: &Path,
    file_id: &str,
    key: Option<&Key>,
    local_id: Option<&str>,
) -> Result<BudgetDir, SyncError> {
    let info = client.file_info(file_id)?;
    if info.file_id != file_id {
        return Err(SyncError::File("mismatched-cloud-file".into()));
    }
    let mut buffer = client.download_file(file_id)?;
    if let Some(meta) = &info.encrypt_meta {
        let key = match key {
            Some(k) if k.id == meta.key_id => k,
            _ => return Err(SyncError::DecryptFailure { missing_key: true }),
        };
        buffer = key.decrypt_with_meta(&buffer, meta).map_err(|_| SyncError::DecryptFailure { missing_key: false })?;
    }
    let (db, meta_bytes) = unzip_budget(&buffer)?;
    let mut meta = match serde_json::from_slice(&meta_bytes) {
        Ok(Json::Object(m)) => Metadata(m),
        _ => return Err(SyncError::File("invalid-meta-file".into())),
    };

    let id = match local_id {
        Some(id) => {
            let existing = BudgetDir::new(root.join(id)).read_meta()?;
            if existing.cloud_file_id() != Some(file_id) {
                return Err(SyncError::File("mismatched-cloud-file".into()));
            }
            id.to_string()
        }
        None => uuid::Uuid::new_v4().to_string(),
    };
    meta.set("id", id.clone());
    meta.set("cloudFileId", file_id);
    meta.set("groupId", info.group_id.clone().map(Json::from).unwrap_or(Json::Null));
    meta.set("lastUploaded", today());
    meta.set(
        "encryptKeyId",
        info.encrypt_meta.as_ref().map(|m| Json::from(m.key_id.clone())).unwrap_or(Json::Null),
    );
    // A downloaded copy must get its own node id on first open.
    meta.set("resetClock", true);

    let dir = BudgetDir::new(root.join(&id));
    fs::create_dir_all(&dir.path)?;
    let tmp = dir.path.join("db.sqlite.download");
    fs::write(&tmp, db)?;
    for suffix in ["-wal", "-shm", "-journal"] {
        let _ = fs::remove_file(dir.path.join(format!("db.sqlite{suffix}")));
    }
    fs::rename(&tmp, dir.db_path())?;
    dir.write_meta(&meta)?;
    Ok(dir)
}

/// Builds the upload zip like `exportBuffer`: the derived cache is dropped
/// and the metadata is marked so downloaders reset their clock.
pub fn export_zip(dir: &BudgetDir) -> Result<Vec<u8>, SyncError> {
    let tmp = tempfile_path(&dir.path, "export.sqlite");
    let _ = fs::remove_file(&tmp);
    {
        let conn = rusqlite::Connection::open(dir.db_path())?;
        conn.execute("VACUUM INTO ?", [tmp.to_string_lossy().as_ref()])?;
    }
    let bytes = {
        let conn = rusqlite::Connection::open(&tmp)?;
        let _ = conn.execute_batch("DELETE FROM kvcache; DELETE FROM kvcache_key;");
        conn.execute_batch("PRAGMA journal_mode = DELETE;")?;
        drop(conn);
        fs::read(&tmp)?
    };
    let _ = fs::remove_file(&tmp);
    let mut meta = dir.read_meta()?;
    meta.set("resetClock", true);
    let meta_bytes = serde_json::to_vec(&Json::Object(meta.0)).expect("json");
    zip_budget(&bytes, &meta_bytes)
}

fn tempfile_path(dir: &Path, name: &str) -> PathBuf {
    dir.join(format!(".{}-{}", uuid::Uuid::new_v4().simple(), name))
}

/// Uploads the whole budget file (`upload` in cloud-storage.ts). Returns the
/// group id; the caller saves it with `lastUploaded` and `cloudFileId`.
pub fn upload(client: &ServerClient, dir: &BudgetDir, key: Option<&Key>) -> Result<(String, String), SyncError> {
    let meta = dir.read_meta()?;
    let zipped = export_zip(dir)?;
    let (content, encrypt_meta): (Vec<u8>, Option<EncryptMeta>) = match meta.encrypt_key_id() {
        Some(key_id) => {
            let key = match key {
                Some(k) if k.id == key_id => k,
                _ => return Err(SyncError::EncryptFailure { missing_key: true }),
            };
            let enc = key.encrypt(&zipped).map_err(|_| SyncError::EncryptFailure { missing_key: false })?;
            let m = enc.meta(&key.id);
            (enc.value, Some(m))
        }
        None => (zipped, None),
    };
    let file_id = meta.cloud_file_id().map(str::to_string).unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let group_id = client.upload_file(&file_id, meta.budget_name(), meta.group_id(), encrypt_meta.as_ref(), content)?;
    Ok((file_id, group_id))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn zip_roundtrip() {
        let z = zip_budget(b"db", b"{}").unwrap();
        assert_eq!(unzip_budget(&z).unwrap(), (b"db".to_vec(), b"{}".to_vec()));
    }

    #[test]
    fn zip_in_subdir() {
        let mut buf = Cursor::new(Vec::new());
        {
            let mut w = zip::ZipWriter::new(&mut buf);
            let o = zip::write::SimpleFileOptions::default();
            w.start_file("My-Budget/db.sqlite", o).unwrap();
            w.write_all(b"db").unwrap();
            w.start_file("My-Budget/metadata.json", o).unwrap();
            w.write_all(b"{}").unwrap();
            w.finish().unwrap();
        }
        assert_eq!(unzip_budget(buf.get_ref()).unwrap().0, b"db");
        assert!(unzip_budget(b"nope").is_err());
    }
}
