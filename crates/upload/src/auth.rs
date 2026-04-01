use crate::error::AuthError;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone)]
pub struct AuthConfig {
    pub server_url: String,
    pub api_key: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ConfigFile {
    auth: Option<AuthSection>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct AuthSection {
    server_url: String,
    api_key: String,
}

fn config_dir() -> Result<PathBuf, AuthError> {
    dirs::config_dir()
        .map(|d| d.join("cap"))
        .ok_or(AuthError::NoConfigDir)
}

fn config_path() -> Result<PathBuf, AuthError> {
    config_dir().map(|d| d.join("config.toml"))
}

impl AuthConfig {
    pub fn resolve() -> Result<Self, AuthError> {
        if let Some(config) = Self::from_env() {
            return Ok(config);
        }
        if let Some(config) = Self::from_config_file()? {
            return Ok(config);
        }
        Err(AuthError::NotConfigured)
    }

    pub fn from_env() -> Option<Self> {
        let api_key = std::env::var("CAP_API_KEY").ok()?;
        let server_url = std::env::var("CAP_SERVER_URL").ok()?;
        Some(Self {
            server_url,
            api_key,
        })
    }

    pub fn from_config_file() -> Result<Option<Self>, AuthError> {
        let path = config_path()?;
        Self::from_config_file_at(&path)
    }

    fn from_config_file_at(path: &Path) -> Result<Option<Self>, AuthError> {
        if !path.exists() {
            return Ok(None);
        }
        let contents = std::fs::read_to_string(path).map_err(|e| AuthError::ConfigRead {
            path: path.to_path_buf(),
            source: e,
        })?;
        let config: ConfigFile = toml::from_str(&contents).map_err(|e| AuthError::ConfigParse {
            path: path.to_path_buf(),
            source: e,
        })?;
        Ok(config.auth.map(|a| Self {
            server_url: a.server_url,
            api_key: a.api_key,
        }))
    }

    pub fn save(server_url: &str, api_key: &str) -> Result<PathBuf, AuthError> {
        let path = config_path()?;
        Self::save_to(&path, server_url, api_key)
    }

    fn save_to(path: &Path, server_url: &str, api_key: &str) -> Result<PathBuf, AuthError> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| AuthError::ConfigWrite {
                path: path.to_path_buf(),
                source: e,
            })?;
        }
        let config = ConfigFile {
            auth: Some(AuthSection {
                server_url: server_url.to_string(),
                api_key: api_key.to_string(),
            }),
        };
        let contents = toml::to_string_pretty(&config).expect("AuthSection is always serializable");
        std::fs::write(path, contents).map_err(|e| AuthError::ConfigWrite {
            path: path.to_path_buf(),
            source: e,
        })?;
        Ok(path.to_path_buf())
    }

    pub fn remove() -> Result<(), AuthError> {
        let path = config_path()?;
        Self::remove_at(&path)
    }

    fn remove_at(path: &Path) -> Result<(), AuthError> {
        if !path.exists() {
            return Ok(());
        }
        let contents = std::fs::read_to_string(path).map_err(|e| AuthError::ConfigRead {
            path: path.to_path_buf(),
            source: e,
        })?;
        let mut config: ConfigFile =
            toml::from_str(&contents).map_err(|e| AuthError::ConfigParse {
                path: path.to_path_buf(),
                source: e,
            })?;
        config.auth = None;
        let contents = toml::to_string_pretty(&config).expect("ConfigFile is always serializable");
        std::fs::write(path, contents).map_err(|e| AuthError::ConfigWrite {
            path: path.to_path_buf(),
            source: e,
        })?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn env_vars_override_config_file() {
        let tmp = TempDir::new().unwrap();
        let config_path = tmp.path().join("config.toml");
        AuthConfig::save_to(&config_path, "https://file.example.com", "file-key").unwrap();

        std::env::set_var("CAP_API_KEY", "env-key");
        std::env::set_var("CAP_SERVER_URL", "https://env.example.com");

        let from_env = AuthConfig::from_env().unwrap();
        assert_eq!(from_env.api_key, "env-key");
        assert_eq!(from_env.server_url, "https://env.example.com");

        std::env::remove_var("CAP_API_KEY");
        std::env::remove_var("CAP_SERVER_URL");
    }

    #[test]
    fn config_file_round_trip() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("config.toml");

        AuthConfig::save_to(&path, "https://cap.example.com", "test-key-123").unwrap();

        let loaded = AuthConfig::from_config_file_at(&path).unwrap().unwrap();
        assert_eq!(loaded.server_url, "https://cap.example.com");
        assert_eq!(loaded.api_key, "test-key-123");
    }

    #[test]
    fn missing_config_returns_none() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("nonexistent.toml");
        let result = AuthConfig::from_config_file_at(&path).unwrap();
        assert!(result.is_none());
    }

    #[test]
    fn remove_clears_auth_section() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("config.toml");

        AuthConfig::save_to(&path, "https://cap.example.com", "key").unwrap();
        AuthConfig::remove_at(&path).unwrap();

        let loaded = AuthConfig::from_config_file_at(&path).unwrap();
        assert!(loaded.is_none());
    }

    #[test]
    fn missing_both_sources_returns_not_configured() {
        std::env::remove_var("CAP_API_KEY");
        std::env::remove_var("CAP_SERVER_URL");
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("nonexistent.toml");
        let result = AuthConfig::from_config_file_at(&path).unwrap();
        assert!(result.is_none());
    }
}
