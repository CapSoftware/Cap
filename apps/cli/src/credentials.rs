//! Resolves the credentials `cap upload` needs without making an agent hunt for an API key.
//!
//! Priority: explicit `CAP_API_KEY`/`CAP_SERVER_URL` env vars (for CI/headless), then the login the
//! desktop app already stored. The CLI is the same product as Cap Desktop, so if the user is signed
//! in there, `cap upload` just works — no key to copy, no env var to set. The desktop persists its
//! auth as plain JSON via tauri-plugin-store, so we read it directly without any Tauri dependency.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

#[cfg(unix)]
use crate::atomic;
use crate::{OutputFormat, write_json};

pub const DEFAULT_SERVER: &str = "https://cap.so";
const AGENT_KEYRING_SERVICE: &str = "so.cap.cli";
const AGENT_KEYRING_USER: &str = "agent-api";
const AGENT_GRANTS_KEYRING_USER: &str = "agent-access-grants";
// Prod first, then the dev bundle, so a released install wins on a machine that has both.
const DESKTOP_BUNDLE_IDS: [&str; 2] = ["so.cap.desktop", "so.cap.desktop.dev"];

#[derive(Serialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum CredentialSource {
    /// CAP_API_KEY env var.
    Env,
    /// The login stored by Cap Desktop.
    Desktop,
}

pub struct Credentials {
    pub api_key: String,
    pub server: String,
    pub source: CredentialSource,
    pub user_id: Option<String>,
}

fn load_desktop_store() -> Option<Value> {
    let data_dir = dirs::data_dir()?;
    DESKTOP_BUNDLE_IDS.into_iter().find_map(|id| {
        let bytes = std::fs::read(data_dir.join(id).join("store")).ok()?;
        let store: Value = serde_json::from_slice(&bytes).ok()?;
        // Only accept a store that actually carries an auth secret.
        store
            .get("auth")
            .and_then(|auth| auth.get("secret"))
            .is_some()
            .then_some(store)
    })
}

fn store_api_key(store: &Value) -> Option<String> {
    let secret = store.get("auth")?.get("secret")?;
    // ApiKey { api_key } or Session { token } — both are sent as `Authorization: Bearer <value>`.
    secret
        .get("api_key")
        .or_else(|| secret.get("token"))
        .and_then(Value::as_str)
        .map(str::to_string)
}

fn store_server(store: &Value) -> Option<String> {
    store
        .get("general_settings")?
        .get("serverUrl")?
        .as_str()
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn normalize_server(server: String) -> String {
    server.trim_end_matches('/').to_string()
}

fn validate_agent_server(server: String) -> Result<String, String> {
    let server = normalize_server(server);
    let url = url::Url::parse(&server).map_err(|_| "The Cap server URL is invalid".to_string())?;
    if !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(
            "The Cap server URL cannot include credentials, a query, or a fragment".to_string(),
        );
    }
    let hostname = url
        .host_str()
        .ok_or_else(|| "The Cap server URL must include a host".to_string())?;
    let is_loopback = matches!(hostname, "localhost" | "127.0.0.1" | "::1" | "[::1]");
    if url.scheme() != "https" && !(url.scheme() == "http" && is_loopback) {
        return Err(
            "Cap CLI agent credentials require HTTPS. HTTP is allowed only for loopback development servers."
                .to_string(),
        );
    }
    Ok(server)
}

fn env_var(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|v| !v.is_empty())
}

pub fn server_url() -> String {
    normalize_server(
        env_var("CAP_SERVER_URL")
            .or_else(|| load_desktop_store().as_ref().and_then(store_server))
            .unwrap_or_else(|| DEFAULT_SERVER.to_string()),
    )
}

pub fn agent_server_url() -> Result<String, String> {
    validate_agent_server(server_url())
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredAgentCredential {
    pub access_token: String,
    pub expires_at: String,
    pub scopes: Vec<String>,
    pub server: String,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredAgentAccessGrant {
    access_grant: String,
    expires_at: String,
}

#[derive(Default, Serialize, Deserialize)]
struct StoredAgentAccessGrants {
    grants: BTreeMap<String, StoredAgentAccessGrant>,
}

#[derive(Clone)]
pub struct AgentAccessGrant {
    pub value: String,
    pub expires_at: chrono::DateTime<chrono::Utc>,
}

#[derive(Serialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum AgentCredentialSource {
    Env,
    Keyring,
    File,
    LegacyEnv,
    Desktop,
}

pub struct AgentCredentials {
    pub access_token: String,
    pub server: String,
    pub source: AgentCredentialSource,
}

#[derive(Serialize, Clone, Copy)]
#[serde(rename_all = "camelCase")]
pub enum AgentCredentialStorage {
    Keyring,
    PermissionRestrictedFile,
}

const fn file_fallback_supported() -> bool {
    cfg!(unix)
}

fn agent_credential_path() -> Result<std::path::PathBuf, String> {
    dirs::config_dir()
        .map(|path| path.join("cap").join("agent-credentials.json"))
        .ok_or_else(|| "Could not locate the user configuration directory".to_string())
}

fn agent_grants_path() -> Result<std::path::PathBuf, String> {
    dirs::config_dir()
        .map(|path| path.join("cap").join("agent-access-grants.json"))
        .ok_or_else(|| "Could not locate the user configuration directory".to_string())
}

fn load_agent_keyring() -> Result<StoredAgentCredential, String> {
    let entry = keyring::Entry::new(AGENT_KEYRING_SERVICE, AGENT_KEYRING_USER)
        .map_err(|error| error.to_string())?;
    let value = entry.get_password().map_err(|error| error.to_string())?;
    serde_json::from_str(&value).map_err(|error| error.to_string())
}

#[cfg(unix)]
fn load_agent_file() -> Result<StoredAgentCredential, String> {
    let bytes = std::fs::read(agent_credential_path()?).map_err(|error| error.to_string())?;
    serde_json::from_slice(&bytes).map_err(|error| error.to_string())
}

#[cfg(not(unix))]
fn load_agent_file() -> Result<StoredAgentCredential, String> {
    Err("File credential fallback is unavailable on this platform".to_string())
}

#[cfg(unix)]
fn write_agent_file(credential: &StoredAgentCredential) -> Result<(), String> {
    let path = agent_credential_path()?;
    let parent = path
        .parent()
        .ok_or_else(|| "Agent credential path has no parent directory".to_string())?;
    std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(parent, std::fs::Permissions::from_mode(0o700))
        .map_err(|error| error.to_string())?;
    let temporary = path.with_extension(format!("tmp-{}", uuid::Uuid::new_v4()));
    let bytes = serde_json::to_vec(credential).map_err(|error| error.to_string())?;
    std::fs::write(&temporary, bytes).map_err(|error| error.to_string())?;
    std::fs::set_permissions(&temporary, std::fs::Permissions::from_mode(0o600))
        .map_err(|error| error.to_string())?;
    if let Err(error) = atomic::replace(&temporary, &path) {
        let _ = std::fs::remove_file(&temporary);
        return Err(error.to_string());
    }
    Ok(())
}

#[cfg(not(unix))]
fn write_agent_file(_credential: &StoredAgentCredential) -> Result<(), String> {
    Err(
        "File credential fallback is unavailable on this platform. Use the OS credential store or CAP_AGENT_TOKEN."
            .to_string(),
    )
}

#[cfg(unix)]
fn write_restricted_file(path: &std::path::Path, bytes: &[u8]) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "Credential path has no parent directory".to_string())?;
    std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(parent, std::fs::Permissions::from_mode(0o700))
        .map_err(|error| error.to_string())?;
    let temporary = path.with_extension(format!("tmp-{}", uuid::Uuid::new_v4()));
    std::fs::write(&temporary, bytes).map_err(|error| error.to_string())?;
    std::fs::set_permissions(&temporary, std::fs::Permissions::from_mode(0o600))
        .map_err(|error| error.to_string())?;
    if let Err(error) = atomic::replace(&temporary, path) {
        let _ = std::fs::remove_file(&temporary);
        return Err(error.to_string());
    }
    Ok(())
}

#[cfg(not(unix))]
fn write_restricted_file(_path: &std::path::Path, _bytes: &[u8]) -> Result<(), String> {
    Err(
        "File credential fallback is unavailable on this platform. Use the OS credential store or CAP_AGENT_TOKEN."
            .to_string(),
    )
}

fn load_agent_access_grants() -> StoredAgentAccessGrants {
    let keyring = keyring::Entry::new(AGENT_KEYRING_SERVICE, AGENT_GRANTS_KEYRING_USER)
        .and_then(|entry| entry.get_password())
        .ok()
        .and_then(|value| serde_json::from_str(&value).ok());
    if let Some(grants) = keyring {
        return grants;
    }
    #[cfg(unix)]
    {
        std::fs::read(agent_grants_path().unwrap_or_default())
            .ok()
            .and_then(|value| serde_json::from_slice(&value).ok())
            .unwrap_or_default()
    }
    #[cfg(not(unix))]
    {
        StoredAgentAccessGrants::default()
    }
}

pub fn agent_access_grant(video_id: &str) -> Option<AgentAccessGrant> {
    let grant = load_agent_access_grants().grants.remove(video_id)?;
    let expires_at = chrono::DateTime::parse_from_rfc3339(&grant.expires_at)
        .ok()?
        .with_timezone(&chrono::Utc);
    (expires_at > chrono::Utc::now()).then_some(AgentAccessGrant {
        value: grant.access_grant,
        expires_at,
    })
}

pub fn store_agent_access_grant(
    video_id: &str,
    access_grant: String,
    expires_at: String,
    allow_file_fallback: bool,
) -> Result<AgentCredentialStorage, String> {
    let mut grants = load_agent_access_grants();
    grants.grants.retain(|_, grant| {
        chrono::DateTime::parse_from_rfc3339(&grant.expires_at)
            .is_ok_and(|expires_at| expires_at > chrono::Utc::now())
    });
    grants.grants.insert(
        video_id.to_string(),
        StoredAgentAccessGrant {
            access_grant,
            expires_at,
        },
    );
    let serialized = serde_json::to_string(&grants).map_err(|error| error.to_string())?;
    let keyring_result = keyring::Entry::new(AGENT_KEYRING_SERVICE, AGENT_GRANTS_KEYRING_USER)
        .and_then(|entry| entry.set_password(&serialized));
    if keyring_result.is_ok() {
        let _ = std::fs::remove_file(agent_grants_path()?);
        return Ok(AgentCredentialStorage::Keyring);
    }
    if !allow_file_fallback {
        return Err(
            "The OS credential store is unavailable. Re-run with --allow-file-credential to acknowledge storing the access grant in a permission-restricted file."
                .to_string(),
        );
    }
    if !file_fallback_supported() {
        return Err(
            "File credential fallback is unavailable on this platform. Use the OS credential store or CAP_AGENT_TOKEN."
                .to_string(),
        );
    }
    write_restricted_file(&agent_grants_path()?, serialized.as_bytes())?;
    Ok(AgentCredentialStorage::PermissionRestrictedFile)
}

pub fn store_agent(
    credential: &StoredAgentCredential,
    allow_file_fallback: bool,
) -> Result<AgentCredentialStorage, String> {
    validate_agent_server(credential.server.clone())?;
    let serialized = serde_json::to_string(credential).map_err(|error| error.to_string())?;
    let keyring_result = keyring::Entry::new(AGENT_KEYRING_SERVICE, AGENT_KEYRING_USER)
        .and_then(|entry| entry.set_password(&serialized));
    if keyring_result.is_ok() {
        let _ = std::fs::remove_file(agent_credential_path()?);
        return Ok(AgentCredentialStorage::Keyring);
    }
    if !allow_file_fallback {
        return Err(
            "The OS credential store is unavailable. Re-run with --allow-file-credential to acknowledge storing the token in a permission-restricted file."
                .to_string(),
        );
    }
    if !file_fallback_supported() {
        return Err(
            "File credential fallback is unavailable on this platform. Use the OS credential store or CAP_AGENT_TOKEN."
                .to_string(),
        );
    }
    write_agent_file(credential)?;
    Ok(AgentCredentialStorage::PermissionRestrictedFile)
}

pub fn resolve_agent() -> Result<AgentCredentials, String> {
    let server = server_url();
    if let Some(access_token) = env_var("CAP_AGENT_TOKEN") {
        return Ok(AgentCredentials {
            access_token,
            server: validate_agent_server(server)?,
            source: AgentCredentialSource::Env,
        });
    }
    if let Ok(stored) = load_agent_keyring() {
        return Ok(AgentCredentials {
            access_token: stored.access_token,
            server: validate_agent_server(stored.server)?,
            source: AgentCredentialSource::Keyring,
        });
    }
    if let Ok(stored) = load_agent_file() {
        return Ok(AgentCredentials {
            access_token: stored.access_token,
            server: validate_agent_server(stored.server)?,
            source: AgentCredentialSource::File,
        });
    }
    let legacy = resolve()?;
    let source = match legacy.source {
        CredentialSource::Env => AgentCredentialSource::LegacyEnv,
        CredentialSource::Desktop => AgentCredentialSource::Desktop,
    };
    Ok(AgentCredentials {
        access_token: legacy.api_key,
        server: legacy.server,
        source,
    })
}

pub fn delete_agent() -> Result<(), String> {
    if let Ok(entry) = keyring::Entry::new(AGENT_KEYRING_SERVICE, AGENT_KEYRING_USER) {
        let _ = entry.delete_credential();
    }
    if let Ok(entry) = keyring::Entry::new(AGENT_KEYRING_SERVICE, AGENT_GRANTS_KEYRING_USER) {
        let _ = entry.delete_credential();
    }
    for path in [agent_credential_path()?, agent_grants_path()?] {
        match std::fs::remove_file(path) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.to_string()),
        }
    }
    Ok(())
}

/// Resolve the upload credential and target server. Returns a clear, actionable error when neither an
/// env var nor a desktop login is available.
pub fn resolve() -> Result<Credentials, String> {
    let store = load_desktop_store();
    let server = server_url();

    if let Some(api_key) = env_var("CAP_API_KEY") {
        return Ok(Credentials {
            api_key,
            server,
            source: CredentialSource::Env,
            user_id: None,
        });
    }

    if let Some(store) = &store
        && let Some(api_key) = store_api_key(store)
    {
        let user_id = store
            .get("auth")
            .and_then(|auth| auth.get("user_id"))
            .and_then(Value::as_str)
            .map(str::to_string);
        return Ok(Credentials {
            api_key,
            server,
            source: CredentialSource::Desktop,
            user_id,
        });
    }

    Err(
        "Not signed in. Sign in to Cap Desktop (the CLI reuses its login), or set CAP_API_KEY to a \
         Cap auth key from Settings."
            .to_string(),
    )
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AuthStatus {
    authenticated: bool,
    credential_present: bool,
    server_verified: bool,
    verification_status: AuthVerificationStatus,
    source: AuthStatusSource,
    server: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    user_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    expires_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    scopes: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    hint: Option<String>,
}

#[derive(Serialize, Clone, Copy)]
#[serde(rename_all = "snake_case")]
enum AuthVerificationStatus {
    Verified,
    Rejected,
    Unavailable,
    LocalOnly,
    Missing,
}

#[derive(Serialize, Clone, Copy)]
#[serde(rename_all = "camelCase")]
enum AuthStatusSource {
    Env,
    Keyring,
    File,
    Desktop,
    None,
}

enum StatusCredentials {
    Agent(AgentCredentials),
    Legacy(Credentials),
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AgentServerStatus {
    authenticated: bool,
    expires_at: Option<String>,
    scopes: Vec<String>,
}

struct AgentVerification {
    authenticated: bool,
    server_verified: bool,
    status: AuthVerificationStatus,
    expires_at: Option<String>,
    scopes: Option<Vec<String>>,
    hint: Option<String>,
}

async fn verify_agent_status(credentials: &AgentCredentials) -> AgentVerification {
    let client = match reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(5))
        .build()
    {
        Ok(client) => client,
        Err(_) => {
            return AgentVerification {
                authenticated: false,
                server_verified: false,
                status: AuthVerificationStatus::Unavailable,
                expires_at: None,
                scopes: None,
                hint: Some("Could not initialize secure authentication verification".to_string()),
            };
        }
    };
    let response = match client
        .get(format!("{}/api/v1/auth/status", credentials.server))
        .bearer_auth(&credentials.access_token)
        .send()
        .await
    {
        Ok(response) => response,
        Err(_) => {
            return AgentVerification {
                authenticated: false,
                server_verified: false,
                status: AuthVerificationStatus::Unavailable,
                expires_at: None,
                scopes: None,
                hint: Some(
                    "The credential is present, but the Cap server could not be reached"
                        .to_string(),
                ),
            };
        }
    };
    if response.status() == reqwest::StatusCode::UNAUTHORIZED {
        return AgentVerification {
            authenticated: false,
            server_verified: true,
            status: AuthVerificationStatus::Rejected,
            expires_at: None,
            scopes: None,
            hint: Some(
                "The Cap server rejected this credential. Run `cap auth login` again".to_string(),
            ),
        };
    }
    if !response.status().is_success() {
        return AgentVerification {
            authenticated: false,
            server_verified: false,
            status: AuthVerificationStatus::Unavailable,
            expires_at: None,
            scopes: None,
            hint: Some(format!(
                "The credential is present, but Cap could not verify it (HTTP {})",
                response.status()
            )),
        };
    }
    let status = match response.json::<AgentServerStatus>().await {
        Ok(status) => status,
        Err(_) => {
            return AgentVerification {
                authenticated: false,
                server_verified: false,
                status: AuthVerificationStatus::Unavailable,
                expires_at: None,
                scopes: None,
                hint: Some("Cap returned an invalid authentication status".to_string()),
            };
        }
    };
    AgentVerification {
        authenticated: status.authenticated,
        server_verified: true,
        status: if status.authenticated {
            AuthVerificationStatus::Verified
        } else {
            AuthVerificationStatus::Rejected
        },
        expires_at: status.expires_at,
        scopes: Some(status.scopes),
        hint: (!status.authenticated).then(|| {
            "The Cap server rejected this credential. Run `cap auth login` again".to_string()
        }),
    }
}

fn resolve_status() -> Result<StatusCredentials, String> {
    let agent = resolve_agent();
    if env_var("CAP_AGENT_TOKEN").is_some() {
        return agent.map(StatusCredentials::Agent);
    }
    let legacy = resolve();
    if matches!(
        legacy.as_ref().map(|credentials| credentials.source),
        Ok(CredentialSource::Env)
    ) {
        return legacy.map(StatusCredentials::Legacy);
    }
    match agent {
        Ok(credentials)
            if matches!(
                credentials.source,
                AgentCredentialSource::Keyring | AgentCredentialSource::File
            ) =>
        {
            Ok(StatusCredentials::Agent(credentials))
        }
        _ => legacy.map(StatusCredentials::Legacy),
    }
}

/// `cap auth status` — report whether a credential is available and where it came from, without ever
/// printing the secret. Lets an agent check before attempting an upload.
pub async fn status(format: OutputFormat) -> Result<(), String> {
    let status = match resolve_status() {
        Ok(StatusCredentials::Agent(creds)) => {
            let verification = verify_agent_status(&creds).await;
            AuthStatus {
                authenticated: verification.authenticated,
                credential_present: true,
                server_verified: verification.server_verified,
                verification_status: verification.status,
                source: match creds.source {
                    AgentCredentialSource::Env => AuthStatusSource::Env,
                    AgentCredentialSource::Keyring => AuthStatusSource::Keyring,
                    AgentCredentialSource::File => AuthStatusSource::File,
                    AgentCredentialSource::LegacyEnv => AuthStatusSource::Env,
                    AgentCredentialSource::Desktop => AuthStatusSource::Desktop,
                },
                server: creds.server,
                user_id: None,
                expires_at: verification.expires_at,
                scopes: verification.scopes,
                hint: verification.hint,
            }
        }
        Ok(StatusCredentials::Legacy(creds)) => AuthStatus {
            authenticated: true,
            credential_present: true,
            server_verified: false,
            verification_status: AuthVerificationStatus::LocalOnly,
            source: match creds.source {
                CredentialSource::Env => AuthStatusSource::Env,
                CredentialSource::Desktop => AuthStatusSource::Desktop,
            },
            server: creds.server,
            user_id: creds.user_id,
            expires_at: None,
            scopes: None,
            hint: None,
        },
        Err(hint) => {
            let server = normalize_server(
                env_var("CAP_SERVER_URL")
                    .or_else(|| load_desktop_store().as_ref().and_then(store_server))
                    .unwrap_or_else(|| DEFAULT_SERVER.to_string()),
            );
            AuthStatus {
                authenticated: false,
                credential_present: false,
                server_verified: false,
                verification_status: AuthVerificationStatus::Missing,
                source: AuthStatusSource::None,
                server,
                user_id: None,
                expires_at: None,
                scopes: None,
                hint: Some(hint),
            }
        }
    };

    match format {
        OutputFormat::Json => write_json(&status),
        OutputFormat::Text => {
            if status.authenticated {
                let source = match status.source {
                    AuthStatusSource::Env => "environment credential",
                    AuthStatusSource::Keyring => "OS credential store",
                    AuthStatusSource::File => "permission-restricted file",
                    AuthStatusSource::Desktop => "Cap Desktop login",
                    AuthStatusSource::None => "none",
                };
                println!("authenticated: yes (via {source})");
                println!("server: {}", status.server);
            } else if status.credential_present {
                println!("credential: present");
                if status.server_verified {
                    println!("authenticated: no (server rejected credential)");
                } else {
                    println!("authenticated: unknown (server verification unavailable)");
                }
                println!("server: {}", status.server);
                if let Some(hint) = &status.hint {
                    println!("{hint}");
                }
            } else {
                println!("authenticated: no");
                println!("server: {}", status.server);
                if let Some(hint) = &status.hint {
                    println!("{hint}");
                }
            }
            Ok(())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn agent_servers_require_https_except_for_loopback_development() {
        assert_eq!(
            validate_agent_server("https://cap.so/".to_string()).unwrap(),
            "https://cap.so"
        );
        assert!(validate_agent_server("http://127.0.0.1:3000".to_string()).is_ok());
        assert!(validate_agent_server("http://[::1]:3000".to_string()).is_ok());
        assert!(validate_agent_server("http://localhost:3000".to_string()).is_ok());
        for server in [
            "http://cap.so",
            "ftp://cap.so",
            "https://user:secret@cap.so",
            "https://cap.so?token=secret",
            "https://cap.so#secret",
        ] {
            assert!(validate_agent_server(server.to_string()).is_err());
        }
    }

    #[test]
    fn file_fallback_is_only_available_where_permissions_are_enforced() {
        assert_eq!(file_fallback_supported(), cfg!(unix));
    }
}
