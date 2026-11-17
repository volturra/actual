//! A blocking client for the actual-server HTTP API used by sync.

use std::time::Duration;

use reqwest::blocking::{Client, Response};
use reqwest::header::CONTENT_TYPE;
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::crypto::{EncryptMeta, KeyTest};
use crate::SyncError;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteFile {
    #[serde(default)]
    pub deleted: i64,
    pub file_id: String,
    pub group_id: Option<String>,
    pub name: String,
    pub encrypt_key_id: Option<String>,
    #[serde(default)]
    pub owner: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileInfo {
    #[serde(default)]
    pub deleted: i64,
    pub file_id: String,
    pub group_id: Option<String>,
    pub name: String,
    pub encrypt_meta: Option<EncryptMeta>,
}

#[derive(Clone, Debug, Deserialize)]
pub struct KeyInfo {
    pub id: Option<String>,
    pub salt: Option<String>,
    pub test: Option<String>,
}

impl KeyInfo {
    pub fn key_test(&self) -> Option<KeyTest> {
        serde_json::from_str(self.test.as_deref()?).ok()
    }
}

#[derive(Clone, Debug, Deserialize)]
pub struct LoginMethod {
    pub method: String,
    #[serde(default)]
    pub active: serde_json::Value,
    #[serde(rename = "displayName", default)]
    pub display_name: Option<String>,
}

#[derive(Clone)]
pub struct ServerClient {
    base: String,
    http: Client,
    token: Option<String>,
}

impl ServerClient {
    /// `base` is the server root, e.g. `https://budget.example.com`.
    pub fn new(base: &str) -> Result<ServerClient, SyncError> {
        let http = Client::builder()
            .timeout(Duration::from_secs(120))
            .connect_timeout(Duration::from_secs(15))
            .user_agent(concat!("actual-linux/", env!("CARGO_PKG_VERSION")))
            .build()
            .map_err(|e| SyncError::Network(e.to_string()))?;
        Ok(ServerClient { base: base.trim_end_matches('/').to_string(), http, token: None })
    }

    pub fn with_token(mut self, token: impl Into<String>) -> Self {
        self.token = Some(token.into());
        self
    }

    pub fn set_token(&mut self, token: Option<String>) {
        self.token = token;
    }

    pub fn token(&self) -> Option<&str> {
        self.token.as_deref()
    }

    pub fn base(&self) -> &str {
        &self.base
    }

    fn url(&self, path: &str) -> String {
        format!("{}{}", self.base, path)
    }

    fn token_header(&self) -> &str {
        self.token.as_deref().unwrap_or("")
    }

    /// Checks status like loot-core's `throwIfNot200` and returns the body.
    fn check(res: Response) -> Result<Vec<u8>, SyncError> {
        let status = res.status();
        let is_json = res
            .headers()
            .get(CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .is_some_and(|v| v.to_ascii_lowercase().contains("application/json"));
        let tunnel_error = res.headers().contains_key("ngrok-error-code");
        let body = res.bytes().map_err(|e| SyncError::Network(e.to_string()))?.to_vec();
        if status.as_u16() == 200 {
            return Ok(body);
        }
        if status.as_u16() == 500 {
            return Err(SyncError::Server("internal".into()));
        }
        if is_json {
            let v: serde_json::Value = serde_json::from_slice(&body).unwrap_or_default();
            let reason = v.get("reason").and_then(|r| r.as_str()).unwrap_or("unknown");
            let details = v.get("details").and_then(|r| r.as_str());
            return Err(match (reason, details) {
                ("unauthorized", Some("token-not-found")) | ("token-expired", _) | ("unauthorized", _) => {
                    SyncError::Unauthorized
                }
                _ => SyncError::Server(reason.to_string()),
            });
        }
        if tunnel_error {
            return Err(SyncError::Network("tunnel error".into()));
        }
        Err(SyncError::Server(String::from_utf8_lossy(&body).trim().to_string()))
    }

    fn unwrap_ok<T: DeserializeOwned>(body: &[u8]) -> Result<T, SyncError> {
        let v: serde_json::Value =
            serde_json::from_slice(body).map_err(|e| SyncError::Protocol(format!("parse-json: {e}")))?;
        if v.get("status").and_then(|s| s.as_str()) != Some("ok") {
            let reason = v
                .get("description")
                .or_else(|| v.get("reason"))
                .and_then(|r| r.as_str())
                .unwrap_or("unknown");
            return Err(SyncError::Server(reason.to_string()));
        }
        serde_json::from_value(v.get("data").cloned().unwrap_or(serde_json::Value::Null))
            .map_err(|e| SyncError::Protocol(e.to_string()))
    }

    fn net(e: reqwest::Error) -> SyncError {
        SyncError::Network(e.to_string())
    }

    pub fn post_json<T: DeserializeOwned>(&self, path: &str, body: serde_json::Value) -> Result<T, SyncError> {
        let res = self
            .http
            .post(self.url(path))
            .header("X-ACTUAL-TOKEN", self.token_header())
            .json(&body)
            .send()
            .map_err(Self::net)?;
        Self::unwrap_ok(&Self::check(res)?)
    }

    fn get_json<T: DeserializeOwned>(&self, path: &str, file_id: Option<&str>) -> Result<T, SyncError> {
        let mut req = self.http.get(self.url(path)).header("X-ACTUAL-TOKEN", self.token_header());
        if let Some(id) = file_id {
            req = req.header("X-ACTUAL-FILE-ID", id);
        }
        Self::unwrap_ok(&Self::check(req.send().map_err(Self::net)?)?)
    }

    pub fn needs_bootstrap(&self) -> Result<serde_json::Value, SyncError> {
        self.get_json("/account/needs-bootstrap", None)
    }

    pub fn login_methods(&self) -> Result<Vec<LoginMethod>, SyncError> {
        #[derive(Deserialize)]
        struct R {
            methods: Vec<LoginMethod>,
        }
        let res = self.http.get(self.url("/account/login-methods")).send().map_err(Self::net)?;
        let body = Self::check(res)?;
        let v: serde_json::Value = serde_json::from_slice(&body).map_err(|e| SyncError::Protocol(e.to_string()))?;
        let r: R = serde_json::from_value(v).map_err(|e| SyncError::Protocol(e.to_string()))?;
        Ok(r.methods)
    }

    /// Password login; stores and returns the session token.
    pub fn login_password(&mut self, password: &str) -> Result<String, SyncError> {
        #[derive(Deserialize)]
        struct R {
            token: String,
        }
        let res = self
            .http
            .post(self.url("/account/login"))
            .json(&json!({ "loginMethod": "password", "password": password }))
            .send()
            .map_err(Self::net)?;
        // The server answers a wrong password with 400 `invalid-password`,
        // which `check` already turns into an error.
        let wrong = |e: SyncError| match e {
            SyncError::Server(reason) if reason == "invalid-password" => SyncError::InvalidPassword,
            other => other,
        };
        let r: R = Self::unwrap_ok(&Self::check(res).map_err(wrong)?).map_err(wrong)?;
        self.token = Some(r.token.clone());
        Ok(r.token)
    }

    pub fn validate(&self) -> Result<serde_json::Value, SyncError> {
        self.get_json("/account/validate", None)
    }

    pub fn list_files(&self) -> Result<Vec<RemoteFile>, SyncError> {
        self.get_json("/sync/list-user-files", None)
    }

    pub fn file_info(&self, file_id: &str) -> Result<FileInfo, SyncError> {
        self.get_json("/sync/get-user-file-info", Some(file_id))
    }

    pub fn download_file(&self, file_id: &str) -> Result<Vec<u8>, SyncError> {
        let res = self
            .http
            .get(self.url("/sync/download-user-file"))
            .header("X-ACTUAL-TOKEN", self.token_header())
            .header("X-ACTUAL-FILE-ID", file_id)
            .send()
            .map_err(Self::net)?;
        Self::check(res)
    }

    pub fn get_key(&self, file_id: &str) -> Result<KeyInfo, SyncError> {
        self.post_json("/sync/user-get-key", json!({ "token": self.token_header(), "fileId": file_id }))
    }

    pub fn create_key(&self, file_id: &str, key_id: &str, salt: &str, test_content: &str) -> Result<(), SyncError> {
        let _: serde_json::Value = self.post_json(
            "/sync/user-create-key",
            json!({
                "token": self.token_header(),
                "fileId": file_id,
                "keyId": key_id,
                "keySalt": salt,
                "testContent": test_content,
            }),
        )?;
        Ok(())
    }

    pub fn reset_file(&self, file_id: &str) -> Result<(), SyncError> {
        let _: serde_json::Value =
            self.post_json("/sync/reset-user-file", json!({ "token": self.token_header(), "fileId": file_id }))?;
        Ok(())
    }

    /// Uploads a (possibly encrypted) zip. Returns the server's group id.
    pub fn upload_file(
        &self,
        file_id: &str,
        name: &str,
        group_id: Option<&str>,
        encrypt_meta: Option<&EncryptMeta>,
        content: Vec<u8>,
    ) -> Result<String, SyncError> {
        let mut req = self
            .http
            .post(self.url("/sync/upload-user-file"))
            .header("Content-Type", "application/encrypted-file")
            .header("X-ACTUAL-TOKEN", self.token_header())
            .header("X-ACTUAL-FILE-ID", file_id)
            .header("X-ACTUAL-NAME", encode_uri_component(name))
            .header("X-ACTUAL-FORMAT", "2");
        if let Some(meta) = encrypt_meta {
            req = req.header("X-ACTUAL-ENCRYPT-META", serde_json::to_string(meta).expect("meta"));
        }
        if let Some(g) = group_id {
            req = req.header("X-ACTUAL-GROUP-ID", g);
        }
        let res = req.body(content).send().map_err(Self::net)?;
        let body = Self::check(res)?;
        let v: serde_json::Value = serde_json::from_slice(&body).map_err(|e| SyncError::Protocol(e.to_string()))?;
        if v.get("status").and_then(|s| s.as_str()) != Some("ok") {
            return Err(SyncError::Server("internal".into()));
        }
        Ok(v.get("groupId").and_then(|g| g.as_str()).unwrap_or_default().to_string())
    }

    /// POSTs a protobuf `SyncRequest` and returns the `SyncResponse` bytes.
    pub fn sync(&self, body: Vec<u8>) -> Result<Vec<u8>, SyncError> {
        let res = self
            .http
            .post(self.url("/sync/sync"))
            .header("Content-Type", "application/actual-sync")
            .header("X-ACTUAL-TOKEN", self.token_header())
            .body(body)
            .send()
            .map_err(Self::net)?;
        Self::check(res)
    }
}

/// JavaScript's `encodeURIComponent`.
pub fn encode_uri_component(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        let unreserved = b.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&b);
        if unreserved {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    #[test]
    fn encode_uri() {
        assert_eq!(super::encode_uri_component("My Budget/€"), "My%20Budget%2F%E2%82%AC");
    }
}
