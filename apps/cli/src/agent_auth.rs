use std::{io::IsTerminal, time::Duration};

use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use clap::{Args, ValueEnum};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use url::Url;

use crate::{
    OutputFormat,
    credentials::{self, AgentCredentialSource, StoredAgentCredential},
    resolve_format, write_json,
};

#[derive(Args)]
pub struct LoginArgs {
    #[arg(long, value_enum, default_value_t = LoginProfile::Creator)]
    profile: LoginProfile,
    #[arg(long)]
    no_open: bool,
    #[arg(
        long,
        help = "Allow a permission-restricted file fallback on macOS or Linux when the OS credential store is unavailable"
    )]
    allow_file_credential: bool,
    #[arg(long, default_value_t = 300)]
    timeout: u64,
    #[arg(long, value_enum, default_value_t = OutputFormat::Text)]
    format: OutputFormat,
}

#[derive(Clone, Copy, ValueEnum)]
enum LoginProfile {
    Creator,
    Admin,
    Full,
}

impl LoginProfile {
    const fn scopes(self) -> &'static str {
        const CREATOR: &str = "caps:read caps:comment caps:write profile:read profile:write caps:upload caps:process caps:delete library:read library:write analytics:read notifications:read notifications:write";
        const ADMIN: &str = "caps:read caps:comment caps:write profile:read profile:write caps:upload caps:process caps:delete library:read library:write analytics:read organizations:read organizations:manage organizations:members notifications:read notifications:write integrations:read integrations:write billing:read billing:write";
        const FULL: &str = "caps:read caps:comment caps:write profile:read profile:write caps:upload caps:process caps:delete library:read library:write analytics:read organizations:read organizations:manage organizations:members notifications:read notifications:write integrations:read integrations:write billing:read billing:write developer:read developer:write developer:secrets";
        match self {
            Self::Creator => CREATOR,
            Self::Admin => ADMIN,
            Self::Full => FULL,
        }
    }
}

#[derive(Args)]
pub struct LogoutArgs {
    #[arg(long, value_enum, default_value_t = OutputFormat::Text)]
    format: OutputFormat,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LoginResult {
    authenticated: bool,
    server: String,
    expires_at: String,
    scopes: Vec<String>,
    storage: credentials::AgentCredentialStorage,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LogoutResult {
    authenticated: bool,
    revoked: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TokenRequest<'a> {
    code: &'a str,
    code_verifier: &'a str,
    redirect_uri: &'a str,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TokenResponse {
    access_token: String,
    expires_at: String,
    scopes: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RevokeResponse {
    revoked: bool,
}

fn random_base64url() -> String {
    let first = uuid::Uuid::new_v4();
    let second = uuid::Uuid::new_v4();
    let mut bytes = [0_u8; 32];
    bytes[..16].copy_from_slice(first.as_bytes());
    bytes[16..].copy_from_slice(second.as_bytes());
    URL_SAFE_NO_PAD.encode(bytes)
}

fn code_challenge(verifier: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
}

fn api_error(status: reqwest::StatusCode, body: &str) -> String {
    let value = serde_json::from_str::<serde_json::Value>(body).ok();
    let code = value
        .as_ref()
        .and_then(|value| value.get("code"))
        .and_then(serde_json::Value::as_str);
    let message = value
        .as_ref()
        .and_then(|value| value.get("message"))
        .and_then(serde_json::Value::as_str);
    match (code, message) {
        (Some(code), Some(message)) => format!("{code}: {message}"),
        _ => format!("Cap returned HTTP {status}"),
    }
}

fn auth_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|_| "Failed to initialize secure authentication".to_string())
}

const fn is_agent_credential_source(source: AgentCredentialSource) -> bool {
    matches!(
        source,
        AgentCredentialSource::Env | AgentCredentialSource::Keyring | AgentCredentialSource::File
    )
}

const fn should_delete_persistent_credentials(source: AgentCredentialSource) -> bool {
    matches!(
        source,
        AgentCredentialSource::Keyring | AgentCredentialSource::File
    )
}

async fn wait_for_callback(
    listener: tokio::net::TcpListener,
    expected_state: &str,
    timeout: Duration,
) -> Result<String, String> {
    let (mut stream, _) = tokio::time::timeout(timeout, listener.accept())
        .await
        .map_err(|_| "Timed out waiting for browser approval".to_string())?
        .map_err(|error| format!("Failed to receive browser approval: {error}"))?;
    let mut buffer = Vec::new();
    loop {
        let mut chunk = [0_u8; 1_024];
        let length = stream
            .read(&mut chunk)
            .await
            .map_err(|error| format!("Failed to read browser approval: {error}"))?;
        if length == 0 {
            return Err("Browser approval ended before the request was complete".to_string());
        }
        buffer.extend_from_slice(&chunk[..length]);
        if buffer.len() > 16 * 1024 {
            return Err("Browser approval request was too large".to_string());
        }
        if buffer.windows(4).any(|window| window == b"\r\n\r\n") {
            break;
        }
    }
    let request = std::str::from_utf8(&buffer)
        .map_err(|_| "Browser approval was not valid HTTP".to_string())?;
    let request_line = request
        .lines()
        .next()
        .ok_or_else(|| "Browser approval was not valid HTTP".to_string())?;
    let method = request_line
        .split_whitespace()
        .next()
        .ok_or_else(|| "Browser approval was not valid HTTP".to_string())?;
    if method != "GET" {
        let body = "Authorization request used an invalid HTTP method.\n";
        let response = format!(
            "HTTP/1.1 405 Method Not Allowed\r\nAllow: GET\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        );
        stream
            .write_all(response.as_bytes())
            .await
            .map_err(|error| error.to_string())?;
        return Err("Browser approval used an invalid HTTP method".to_string());
    }
    let target = request_line
        .split_whitespace()
        .nth(1)
        .ok_or_else(|| "Browser approval was not valid HTTP".to_string())?;
    let callback = Url::parse(&format!("http://127.0.0.1{target}"))
        .map_err(|_| "Browser approval callback was invalid".to_string())?;
    if callback.path() != "/callback" {
        return Err("Browser approval callback had an invalid path".to_string());
    }
    let state = callback
        .query_pairs()
        .find_map(|(key, value)| (key == "state").then(|| value.into_owned()))
        .ok_or_else(|| "Browser approval callback did not include state".to_string())?;
    if state != expected_state {
        return Err("Browser approval state did not match".to_string());
    }
    if let Some(error) = callback
        .query_pairs()
        .find_map(|(key, value)| (key == "error").then(|| value.into_owned()))
    {
        let body = "Authorization was cancelled.\n";
        let response = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        );
        stream
            .write_all(response.as_bytes())
            .await
            .map_err(|write_error| write_error.to_string())?;
        return Err(format!("Authorization was declined: {error}"));
    }
    let code = callback
        .query_pairs()
        .find_map(|(key, value)| (key == "code").then(|| value.into_owned()))
        .ok_or_else(|| "Browser approval callback did not include a code".to_string())?;
    let body = "Authorization complete. You can close this window.\n";
    let response = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    stream
        .write_all(response.as_bytes())
        .await
        .map_err(|error| error.to_string())?;
    Ok(code)
}

impl LoginArgs {
    pub async fn run(self, global_json: bool) -> Result<(), String> {
        let format = resolve_format(global_json, self.format);
        let result = self.run_inner(format).await;
        if let Err(error) = &result
            && format == OutputFormat::Json
        {
            let _ = write_json(&serde_json::json!({ "error": error }));
        }
        result
    }

    async fn run_inner(self, format: OutputFormat) -> Result<(), String> {
        if self.timeout == 0 || self.timeout > 900 {
            return Err("--timeout must be between 1 and 900 seconds".to_string());
        }
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .map_err(|error| format!("Failed to create the login callback: {error}"))?;
        let port = listener
            .local_addr()
            .map_err(|error| error.to_string())?
            .port();
        let redirect_uri = format!("http://127.0.0.1:{port}/callback");
        let verifier = random_base64url();
        let state = random_base64url();
        let server = credentials::agent_server_url()?;
        let mut authorize_url = Url::parse(&format!("{server}/cli/authorize"))
            .map_err(|_| "CAP_SERVER_URL is not a valid URL".to_string())?;
        authorize_url
            .query_pairs_mut()
            .append_pair("client_id", "cap-cli")
            .append_pair("redirect_uri", &redirect_uri)
            .append_pair("response_type", "code")
            .append_pair("state", &state)
            .append_pair("code_challenge", &code_challenge(&verifier))
            .append_pair("code_challenge_method", "S256")
            .append_pair("scope", self.profile.scopes());

        if self.no_open {
            eprintln!("Open this URL to authorize Cap CLI:\n{authorize_url}");
        } else if let Err(error) = open::that(authorize_url.as_str()) {
            eprintln!("Could not open a browser ({error}). Open this URL:\n{authorize_url}");
        } else {
            eprintln!("Waiting for browser approval...");
        }

        let code = wait_for_callback(listener, &state, Duration::from_secs(self.timeout)).await?;
        let client = auth_client()?;
        let response = client
            .post(format!("{server}/api/v1/auth/token"))
            .json(&TokenRequest {
                code: &code,
                code_verifier: &verifier,
                redirect_uri: &redirect_uri,
            })
            .send()
            .await
            .map_err(|error| format!("Failed to exchange the authorization code: {error}"))?;
        let status = response.status();
        let body = response
            .text()
            .await
            .map_err(|error| format!("Failed to read the token response: {error}"))?;
        if !status.is_success() {
            return Err(api_error(status, &body));
        }
        let token: TokenResponse =
            serde_json::from_str(&body).map_err(|_| "Cap returned an invalid token".to_string())?;
        let storage = credentials::store_agent(
            &StoredAgentCredential {
                access_token: token.access_token.clone(),
                expires_at: token.expires_at.clone(),
                scopes: token.scopes.clone(),
                server: server.clone(),
            },
            self.allow_file_credential,
        );
        let storage = match storage {
            Ok(storage) => storage,
            Err(error) => {
                let _ = client
                    .post(format!("{server}/api/v1/auth/revoke"))
                    .bearer_auth(&token.access_token)
                    .send()
                    .await;
                return Err(error);
            }
        };
        let result = LoginResult {
            authenticated: true,
            server,
            expires_at: token.expires_at,
            scopes: token.scopes,
            storage,
        };
        match format {
            OutputFormat::Json => write_json(&result),
            OutputFormat::Text => {
                println!("Cap CLI is authorized.");
                println!("server: {}", result.server);
                println!("expires: {}", result.expires_at);
                Ok(())
            }
        }
    }
}

impl LogoutArgs {
    pub async fn run(self, global_json: bool) -> Result<(), String> {
        let format = resolve_format(global_json, self.format);
        let result = self.run_inner(format).await;
        if let Err(error) = &result
            && format == OutputFormat::Json
        {
            let _ = write_json(&serde_json::json!({ "error": error }));
        }
        result
    }

    async fn run_inner(self, format: OutputFormat) -> Result<(), String> {
        let credentials = credentials::resolve_agent()?;
        if !is_agent_credential_source(credentials.source) {
            return Err(
                "No Cap CLI agent credential is stored. CAP_API_KEY and Cap Desktop login are not changed by `cap auth logout`."
                    .to_string(),
            );
        }
        let revocable = credentials.access_token.starts_with("cap_cli_");
        let revoked = if revocable {
            let response = auth_client()?
                .post(format!("{}/api/v1/auth/revoke", credentials.server))
                .bearer_auth(&credentials.access_token)
                .send()
                .await
                .map_err(|error| format!("Failed to revoke the Cap credential: {error}"))?;
            if response.status().is_success() {
                response
                    .json::<RevokeResponse>()
                    .await
                    .map_err(|_| "Cap returned an invalid revocation response".to_string())?
                    .revoked
            } else if response.status() == reqwest::StatusCode::UNAUTHORIZED {
                false
            } else {
                let status = response.status();
                let body = response.text().await.unwrap_or_default();
                return Err(api_error(status, &body));
            }
        } else {
            false
        };
        if should_delete_persistent_credentials(credentials.source) {
            credentials::delete_agent()?;
        }
        let result = LogoutResult {
            authenticated: false,
            revoked,
        };
        match format {
            OutputFormat::Json => write_json(&result),
            OutputFormat::Text => {
                if credentials.source == AgentCredentialSource::Env {
                    println!("Cap CLI environment credential revoked.");
                    if std::io::stdin().is_terminal() {
                        println!("Unset CAP_AGENT_TOKEN to remove it from this shell.");
                    }
                } else {
                    println!("Cap CLI credential removed.");
                }
                Ok(())
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pkce_values_have_the_required_shape() {
        let verifier = random_base64url();
        assert_eq!(verifier.len(), 43);
        assert_eq!(code_challenge(&verifier).len(), 43);
    }

    #[test]
    fn login_profiles_are_incremental() {
        let creator = LoginProfile::Creator.scopes();
        let admin = LoginProfile::Admin.scopes();
        let full = LoginProfile::Full.scopes();
        assert!(creator.contains("caps:upload"));
        assert!(!creator.contains("organizations:manage"));
        assert!(admin.contains("organizations:manage"));
        assert!(!admin.contains("developer:secrets"));
        assert!(full.contains("developer:secrets"));
    }

    #[test]
    fn errors_never_echo_unknown_response_bodies() {
        let error = api_error(reqwest::StatusCode::BAD_GATEWAY, "secret upstream body");
        assert_eq!(error, "Cap returned HTTP 502 Bad Gateway");
        assert!(!error.contains("secret"));
    }

    #[test]
    fn logout_never_claims_legacy_credentials() {
        assert!(is_agent_credential_source(AgentCredentialSource::Env));
        assert!(is_agent_credential_source(AgentCredentialSource::Keyring));
        assert!(is_agent_credential_source(AgentCredentialSource::File));
        assert!(!is_agent_credential_source(
            AgentCredentialSource::LegacyEnv
        ));
        assert!(!is_agent_credential_source(AgentCredentialSource::Desktop));
        assert!(!should_delete_persistent_credentials(
            AgentCredentialSource::Env
        ));
        assert!(should_delete_persistent_credentials(
            AgentCredentialSource::Keyring
        ));
        assert!(should_delete_persistent_credentials(
            AgentCredentialSource::File
        ));
    }

    #[tokio::test]
    async fn callback_accepts_fragmented_loopback_requests() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let callback = tokio::spawn(wait_for_callback(
            listener,
            "expected_state",
            Duration::from_secs(2),
        ));
        let mut client = tokio::net::TcpStream::connect(address).await.unwrap();
        client
            .write_all(b"GET /callback?state=expected_state")
            .await
            .unwrap();
        tokio::task::yield_now().await;
        client
            .write_all(b"&code=one_time_code HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n")
            .await
            .unwrap();
        assert_eq!(callback.await.unwrap().unwrap(), "one_time_code");
    }

    #[tokio::test]
    async fn callback_rejects_non_get_requests_with_http_response() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let callback = tokio::spawn(wait_for_callback(
            listener,
            "expected_state",
            Duration::from_secs(2),
        ));
        let mut client = tokio::net::TcpStream::connect(address).await.unwrap();
        client
            .write_all(b"POST /callback HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n")
            .await
            .unwrap();
        let mut response = String::new();
        client.read_to_string(&mut response).await.unwrap();
        assert!(response.starts_with("HTTP/1.1 405 Method Not Allowed\r\n"));
        assert!(response.contains("\r\nAllow: GET\r\n"));
        assert!(response.ends_with("Authorization request used an invalid HTTP method.\n"));
        assert_eq!(
            callback.await.unwrap().unwrap_err(),
            "Browser approval used an invalid HTTP method"
        );
    }
}
