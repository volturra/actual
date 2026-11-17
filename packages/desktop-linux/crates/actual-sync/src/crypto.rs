//! Budget encryption, compatible with loot-core `server/encryption`:
//! PBKDF2-HMAC-SHA512 (10,000 rounds) over the password with the *base64 salt
//! string's bytes* as salt, giving an AES-256-GCM key; 12-byte IVs and
//! 16-byte tags kept separate from the ciphertext.

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use rand::RngCore;
use serde::{Deserialize, Serialize};

pub const ALGORITHM: &str = "aes-256-gcm";
const PBKDF2_ROUNDS: u32 = 10_000;

#[derive(Debug, thiserror::Error)]
pub enum CryptoError {
    #[error("missing-key")]
    MissingKey,
    #[error("unsupported crypto algorithm: {0}")]
    UnsupportedAlgorithm(String),
    #[error("decrypt-failure")]
    Decrypt,
    #[error("invalid key: {0}")]
    InvalidKey(String),
}

/// An AES-256 master key with the id the server knows it by.
#[derive(Clone, Serialize, Deserialize)]
pub struct Key {
    pub id: String,
    pub base64: String,
}

impl std::fmt::Debug for Key {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Key").field("id", &self.id).finish_non_exhaustive()
    }
}

/// Metadata sent alongside encrypted files and test messages.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct EncryptMeta {
    pub key_id: String,
    pub algorithm: String,
    pub iv: String,
    pub auth_tag: String,
}

pub struct Encrypted {
    pub value: Vec<u8>,
    pub iv: Vec<u8>,
    pub auth_tag: Vec<u8>,
}

impl Encrypted {
    pub fn meta(&self, key_id: &str) -> EncryptMeta {
        EncryptMeta {
            key_id: key_id.to_string(),
            algorithm: ALGORITHM.to_string(),
            iv: B64.encode(&self.iv),
            auth_tag: B64.encode(&self.auth_tag),
        }
    }
}

impl Key {
    pub fn from_password(id: &str, password: &str, salt: &str) -> Key {
        let mut raw = [0u8; 32];
        pbkdf2::pbkdf2_hmac::<sha2::Sha512>(password.as_bytes(), salt.as_bytes(), PBKDF2_ROUNDS, &mut raw);
        Key { id: id.to_string(), base64: B64.encode(raw) }
    }

    fn cipher(&self) -> Result<Aes256Gcm, CryptoError> {
        let raw = B64.decode(&self.base64).map_err(|e| CryptoError::InvalidKey(e.to_string()))?;
        Aes256Gcm::new_from_slice(&raw).map_err(|e| CryptoError::InvalidKey(e.to_string()))
    }

    pub fn encrypt(&self, plaintext: &[u8]) -> Result<Encrypted, CryptoError> {
        let mut iv = [0u8; 12];
        rand::thread_rng().fill_bytes(&mut iv);
        let mut out = self
            .cipher()?
            .encrypt(Nonce::from_slice(&iv), Payload { msg: plaintext, aad: &[] })
            .map_err(|_| CryptoError::Decrypt)?;
        let tag = out.split_off(out.len() - 16);
        Ok(Encrypted { value: out, iv: iv.to_vec(), auth_tag: tag })
    }

    pub fn decrypt(&self, ciphertext: &[u8], iv: &[u8], auth_tag: &[u8]) -> Result<Vec<u8>, CryptoError> {
        if iv.len() != 12 {
            return Err(CryptoError::Decrypt);
        }
        let mut buf = Vec::with_capacity(ciphertext.len() + auth_tag.len());
        buf.extend_from_slice(ciphertext);
        buf.extend_from_slice(auth_tag);
        self.cipher()?
            .decrypt(Nonce::from_slice(iv), Payload { msg: &buf, aad: &[] })
            .map_err(|_| CryptoError::Decrypt)
    }

    pub fn decrypt_with_meta(&self, ciphertext: &[u8], meta: &EncryptMeta) -> Result<Vec<u8>, CryptoError> {
        if meta.algorithm != ALGORITHM {
            return Err(CryptoError::UnsupportedAlgorithm(meta.algorithm.clone()));
        }
        let iv = B64.decode(&meta.iv).map_err(|_| CryptoError::Decrypt)?;
        let tag = B64.decode(&meta.auth_tag).map_err(|_| CryptoError::Decrypt)?;
        self.decrypt(ciphertext, &iv, &tag)
    }
}

/// The `test` blob the server stores for a key, used to check a password.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct KeyTest {
    pub value: String,
    pub meta: EncryptMeta,
}

impl KeyTest {
    pub fn verify(&self, key: &Key) -> bool {
        let Ok(value) = B64.decode(&self.value) else { return false };
        key.decrypt_with_meta(&value, &self.meta).is_ok()
    }
}

pub fn random_salt() -> String {
    let mut salt = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut salt);
    B64.encode(salt)
}

pub fn b64() -> &'static base64::engine::GeneralPurpose {
    &B64
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encrypt_roundtrip() {
        let key = Key::from_password("k1", "hunter2", "c2FsdA==");
        let enc = key.encrypt(b"hello").unwrap();
        assert_eq!(enc.auth_tag.len(), 16);
        assert_eq!(key.decrypt(&enc.value, &enc.iv, &enc.auth_tag).unwrap(), b"hello");
        let other = Key::from_password("k1", "wrong", "c2FsdA==");
        assert!(other.decrypt(&enc.value, &enc.iv, &enc.auth_tag).is_err());
    }

    #[test]
    fn pbkdf2_matches_node() {
        // node -e "console.log(require('crypto').pbkdf2Sync('hunter2','c2FsdA==',10000,32,'sha512').toString('base64'))"
        let key = Key::from_password("k", "hunter2", "c2FsdA==");
        assert_eq!(key.base64, include_str!("../tests/fixtures/pbkdf2-hunter2.txt").trim());
    }
}
