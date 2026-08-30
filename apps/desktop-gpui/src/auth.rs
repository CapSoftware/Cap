use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde_json::{Value, json};

use crate::store::{self, DEFAULT_SERVER_URL};

const CALLBACK_HTML: &str = r#"<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Cache-Control" content="no-store, no-cache, must-revalidate">
  <title>Cap Auth</title>
  <style>
    html, body { width: 100%; height: 100%; margin: 0; font-family: sans-serif; }
    body { display: flex; align-items: center; justify-center; text-align: center; background: #f8f9fa; }
    p { font-size: 21px; line-height: 26px; color: #12161F; }
  </style>
</head>
<body>
  <p>You are now signed in. Please re-open the Cap desktop app to continue.</p>
</body>
</html>
"#;

static DEEP_LINK: OnceLock<Mutex<Option<flume::Sender<String>>>> = OnceLock::new();

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AuthParams {
    ApiKey {
        api_key: String,
        user_id: String,
    },
    Session {
        token: String,
        user_id: String,
        expires: i64,
    },
}

#[derive(Debug)]
pub enum AuthApiError {
    InvalidAuthentication,
    UpgradeRequired,
    Timeout,
    Other(String),
}

impl AuthApiError {
    pub fn message(&self) -> String {
        match self {
            Self::InvalidAuthentication => {
                "User is not authenticated or credentials have expired!".into()
            }
            Self::UpgradeRequired => {
                "User needs to upgrade their account to use this feature!".into()
            }
            Self::Timeout => "The request has timed out".into(),
            Self::Other(message) => message.clone(),
        }
    }
}

impl std::fmt::Display for AuthApiError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message())
    }
}

pub struct SignInSession {
    pub url: String,
    local: flume::Receiver<Option<AuthParams>>,
    deep: flume::Receiver<String>,
    cancel: ArcAtomic,
}

type ArcAtomic = std::sync::Arc<AtomicBool>;

pub fn begin_sign_in(cancel: ArcAtomic) -> Result<SignInSession, String> {
    let server_url = store::GeneralSettings::load().server_url;
    let local_only = should_use_local_server_session(&server_url);
    let local = start_local_callback(cancel.clone())?;
    let (deep_tx, deep_rx) = flume::bounded(1);
    *deep_link_slot()
        .lock()
        .unwrap_or_else(|error| error.into_inner()) = Some(deep_tx);

    let mut request = format!("{server_url}/api/desktop/session/request?type=api_key");
    request.push_str(&format!("&port={}", local.port));
    request.push_str(&format!(
        "&platform={}",
        if local_only { "web" } else { "desktop" }
    ));

    Ok(SignInSession {
        url: request,
        local: local.complete,
        deep: deep_rx,
        cancel,
    })
}

impl SignInSession {
    pub fn complete(self) -> Result<bool, String> {
        let result = wait_for_auth(self.local, self.deep, self.cancel.clone());
        *deep_link_slot()
            .lock()
            .unwrap_or_else(|error| error.into_inner()) = None;
        if self.cancel.load(Ordering::Relaxed) {
            return Ok(false);
        }
        let Some(params) = result? else {
            return Ok(false);
        };
        process_auth_data(params)?;
        Ok(true)
    }
}

pub fn submit_deep_link(url: &str) {
    let slot = deep_link_slot();
    let guard = slot.lock().unwrap_or_else(|error| error.into_inner());
    if let Some(tx) = guard.as_ref() {
        let _ = tx.send(url.to_string());
    }
}

pub fn sign_out() -> bool {
    store::set_auth(None)
}

pub fn apply_desktop_headers(mut request: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
    request = request
        .header("X-Cap-Desktop-Version", env!("CARGO_PKG_VERSION"))
        .header("X-Cap-Desktop-Features", "googleDriveUpload");
    if let Ok(secret) = std::env::var("VITE_VERCEL_AUTOMATION_BYPASS_SECRET")
        && !secret.is_empty()
    {
        request = request.header("x-vercel-protection-bypass", secret);
    }
    request
}

pub fn server_url() -> String {
    let url = store::GeneralSettings::load().server_url;
    if url.trim().is_empty() {
        DEFAULT_SERVER_URL.to_string()
    } else {
        url.trim_end_matches('/').to_string()
    }
}

pub fn is_server_url_custom() -> bool {
    !has_same_origin(&server_url(), DEFAULT_SERVER_URL)
}

pub async fn authed_request(
    method: reqwest::Method,
    path: &str,
    body: Option<Value>,
) -> Result<reqwest::Response, AuthApiError> {
    let auth = store::auth_snapshot();
    let Some(token) = auth.token else {
        return Err(AuthApiError::InvalidAuthentication);
    };
    let url = format!("{}{path}", server_url());
    let mut request = reqwest::Client::new().request(method, url);
    request = apply_desktop_headers(request).bearer_auth(token);
    if let Some(body) = body {
        request = request
            .header("Content-Type", "application/json")
            .json(&body);
    }
    let response = request.send().await.map_err(|error| {
        if error.is_timeout() {
            AuthApiError::Timeout
        } else {
            AuthApiError::Other(error.to_string())
        }
    })?;
    if response.status() == reqwest::StatusCode::UNAUTHORIZED {
        return Err(AuthApiError::InvalidAuthentication);
    }
    Ok(response)
}

pub fn process_auth_data(params: AuthParams) -> Result<(), String> {
    let (secret, user_id) = match params {
        AuthParams::ApiKey { api_key, user_id } => (json!({ "api_key": api_key }), user_id),
        AuthParams::Session {
            token,
            user_id,
            expires,
        } => (json!({ "token": token, "expires": expires }), user_id),
    };
    if !store::set_auth(Some(json!({
        "secret": secret,
        "user_id": user_id,
        "plan": null,
    }))) {
        return Err("Failed to persist auth session".into());
    }
    Ok(())
}

pub async fn update_auth_plan() -> Result<(), AuthApiError> {
    let snapshot = store::auth_snapshot();
    if !snapshot.signed_in() {
        return Err(AuthApiError::InvalidAuthentication);
    }

    let mut auth = store::store_section("auth");
    if !snapshot.plan_manual {
        match authed_request(reqwest::Method::GET, "/api/desktop/plan", None).await {
            Ok(response) if response.status().is_success() => {
                if let Ok(body) = response.json::<Value>().await
                    && let Some(upgraded) = body.get("upgraded").and_then(Value::as_bool)
                {
                    auth.insert(
                        "plan".into(),
                        json!({
                            "upgraded": upgraded,
                            "manual": false,
                            "last_checked": chrono::Utc::now().timestamp() as i32,
                        }),
                    );
                }
            }
            Ok(response) => tracing::warn!("Plan fetch returned {}", response.status()),
            Err(error) => tracing::warn!("Failed to fetch plan: {error}"),
        }
    }

    match authed_request(reqwest::Method::GET, "/api/desktop/organizations", None).await {
        Ok(response) if response.status().is_success() => {
            if let Ok(orgs) = response.json::<Value>().await {
                auth.insert("organizations".into(), orgs);
                auth.insert(
                    "organizations_updated_at".into(),
                    json!(chrono::Utc::now().timestamp() as i32),
                );
            }
        }
        Ok(response) => tracing::warn!("Organizations fetch returned {}", response.status()),
        Err(error) => {
            tracing::warn!("Failed to fetch organizations: {error}");
            if auth
                .get("organizations")
                .and_then(Value::as_array)
                .is_none_or(Vec::is_empty)
            {
                auth.insert(
                    "organizations_updated_at".into(),
                    json!(chrono::Utc::now().timestamp() as i32),
                );
            }
        }
    }

    if !store::set_auth(Some(Value::Object(auth))) {
        return Err(AuthApiError::Other("Failed to persist auth plan".into()));
    }
    Ok(())
}

fn wait_for_auth(
    local: flume::Receiver<Option<AuthParams>>,
    deep: flume::Receiver<String>,
    cancel: ArcAtomic,
) -> Result<Option<AuthParams>, String> {
    let deadline = Instant::now() + Duration::from_secs(10 * 60);
    loop {
        if cancel.load(Ordering::Relaxed) {
            return Ok(None);
        }
        if Instant::now() >= deadline {
            return Err("Sign in timed out".into());
        }
        match local.try_recv() {
            Ok(value) => return Ok(value),
            Err(flume::TryRecvError::Disconnected) => return Ok(None),
            Err(flume::TryRecvError::Empty) => {}
        }
        match deep.try_recv() {
            Ok(url) => {
                if let Some(params) = parse_auth_params(&url) {
                    return Ok(Some(params));
                }
            }
            Err(flume::TryRecvError::Disconnected) => {}
            Err(flume::TryRecvError::Empty) => {}
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}

struct LocalCallback {
    port: u16,
    complete: flume::Receiver<Option<AuthParams>>,
}

fn start_local_callback(cancel: ArcAtomic) -> Result<LocalCallback, String> {
    let listener = TcpListener::bind("127.0.0.1:0").map_err(|error| error.to_string())?;
    listener
        .set_nonblocking(true)
        .map_err(|error| error.to_string())?;
    let port = listener
        .local_addr()
        .map_err(|error| error.to_string())?
        .port();
    let (tx, rx) = flume::bounded(1);
    std::thread::spawn(move || {
        let started = Instant::now();
        loop {
            if cancel.load(Ordering::Relaxed) {
                let _ = tx.send(None);
                return;
            }
            if started.elapsed() > Duration::from_secs(10 * 60) {
                let _ = tx.send(None);
                return;
            }
            match listener.accept() {
                Ok((mut stream, _)) => {
                    let mut buffer = [0u8; 4096];
                    let read = match stream.read(&mut buffer) {
                        Ok(read) => read,
                        Err(_) => continue,
                    };
                    let request = String::from_utf8_lossy(&buffer[..read]);
                    let path = request.lines().next().and_then(|line| {
                        let mut parts = line.split_whitespace();
                        let _method = parts.next()?;
                        parts.next()
                    });
                    let url = path
                        .map(|path| format!("http://127.0.0.1:{port}{path}"))
                        .unwrap_or_default();
                    let body = CALLBACK_HTML;
                    let response = format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nCache-Control: no-store, no-cache, must-revalidate\r\nPragma: no-cache\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                        body.len()
                    );
                    let _ = stream.write_all(response.as_bytes());
                    let _ = stream.flush();
                    if url.contains("token") || url.contains("api_key") {
                        let _ = tx.send(parse_auth_params(&url));
                        return;
                    }
                }
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    std::thread::sleep(Duration::from_millis(50));
                }
                Err(_) => {
                    let _ = tx.send(None);
                    return;
                }
            }
        }
    });
    Ok(LocalCallback { port, complete: rx })
}

fn deep_link_slot() -> &'static Mutex<Option<flume::Sender<String>>> {
    DEEP_LINK.get_or_init(|| Mutex::new(None))
}

pub fn should_use_local_server_session(configured: &str) -> bool {
    if cfg!(debug_assertions) {
        return true;
    }
    !has_same_origin(configured, DEFAULT_SERVER_URL)
}

pub fn has_same_origin(left: &str, right: &str) -> bool {
    match (origin_of(left), origin_of(right)) {
        (Some(left), Some(right)) => left == right,
        _ => false,
    }
}

fn origin_of(value: &str) -> Option<String> {
    let url = reqwest::Url::parse(value).ok()?;
    Some(url.origin().ascii_serialization())
}

pub fn parse_auth_params(url: &str) -> Option<AuthParams> {
    let parsed = reqwest::Url::parse(url).ok()?;
    let query = query_map(&parsed);
    if let Some(api_key) = query.get("api_key")
        && let Some(user_id) = query.get("user_id")
    {
        return Some(AuthParams::ApiKey {
            api_key: api_key.clone(),
            user_id: user_id.clone(),
        });
    }
    if let Some(token) = query.get("token")
        && let Some(user_id) = query.get("user_id")
    {
        let expires = query
            .get("expires")
            .and_then(|value| value.parse().ok())
            .unwrap_or(0);
        return Some(AuthParams::Session {
            token: token.clone(),
            user_id: user_id.clone(),
            expires,
        });
    }
    None
}

fn query_map(url: &reqwest::Url) -> HashMap<String, String> {
    url.query_pairs()
        .map(|(key, value)| (key.into_owned(), value.into_owned()))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_api_key_callback() {
        let params =
            parse_auth_params("http://127.0.0.1:4280/?type=api_key&api_key=key-1&user_id=user-1")
                .expect("api key");
        assert_eq!(
            params,
            AuthParams::ApiKey {
                api_key: "key-1".into(),
                user_id: "user-1".into(),
            }
        );
    }

    #[test]
    fn parses_session_deep_link() {
        let params = parse_auth_params("cap-desktop://auth?token=tok&user_id=user-2&expires=9")
            .expect("session");
        assert_eq!(
            params,
            AuthParams::Session {
                token: "tok".into(),
                user_id: "user-2".into(),
                expires: 9,
            }
        );
    }

    #[test]
    fn ignores_unrelated_urls() {
        assert!(parse_auth_params("http://127.0.0.1:1/health").is_none());
    }

    #[test]
    fn local_session_for_custom_origin() {
        assert!(should_use_local_server_session("http://localhost:3000"));
        assert!(has_same_origin("https://cap.so/", "https://cap.so"));
        assert!(!has_same_origin("https://cap.so", "http://localhost:3000"));
    }
}
