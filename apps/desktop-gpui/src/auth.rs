use std::collections::HashMap;
use std::future::Future;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::pin::pin;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use futures_util::future::{Either, select};
use serde_json::{Value, json};

use crate::store::{self, DEFAULT_SERVER_URL};

pub const PRICING_URL: &str = "https://cap.so/pricing?ref=desktop";

const CALLBACK_HTML: &str = r#"<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Cache-Control" content="no-store, no-cache, must-revalidate">
  <title>Signed in — Cap</title>
  <style>
    html { height: 100%; }
    body { min-height: 100%; margin: 0; padding: 24px; box-sizing: border-box; display: flex; align-items: center; justify-content: center; text-align: center; font-family: system-ui, sans-serif; background: #f8f9fa; color: #12161f; }
    main { width: 100%; max-width: 400px; }
    h1 { margin: 0 0 12px; font-size: 24px; line-height: 32px; font-weight: 600; letter-spacing: -0.02em; }
    p { margin: 0; font-size: 15px; line-height: 24px; color: #5d6470; }
    @media (prefers-color-scheme: dark) {
      body { background: #18181b; color: #f4f4f5; }
      p { color: #a1a1aa; }
    }
  </style>
</head>
<body>
  <main>
    <h1>You’re signed in</h1>
    <p>You can close this tab and return to Cap.</p>
  </main>
</body>
</html>
"#;

pub const SIGN_IN_TIMEOUT: Duration = Duration::from_secs(15 * 60);

/// How long the loopback server keeps answering after sign-in completes. The
/// web's desktop redirect page tries the deep link first and then navigates to
/// the loopback URL ~1.8s later whether or not the deep link worked, so a
/// server that closed on the deep link would leave the browser on a
/// "connection refused" page.
const CALLBACK_LINGER: Duration = Duration::from_secs(30);

const NOT_FOUND_HTML: &str = "<!DOCTYPE html><html><body>Not found</body></html>";

static DEEP_LINK: OnceLock<Mutex<Option<DeepLinkSlot>>> = OnceLock::new();
static NEXT_SESSION_ID: AtomicU64 = AtomicU64::new(1);

struct DeepLinkSlot {
    session: u64,
    tx: flume::Sender<String>,
}

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
    Status(reqwest::StatusCode, String),
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
            Self::Status(_, message) | Self::Other(message) => message.clone(),
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
    id: u64,
    local: Option<flume::Receiver<AuthParams>>,
    deep: flume::Receiver<String>,
    callback: Arc<CallbackControl>,
}

#[derive(Default)]
struct CallbackControl {
    stop: AtomicBool,
    completed: AtomicBool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SignInWaitError {
    TimedOut,
}

/// Start one sign-in attempt: a loopback callback server, a deep-link slot,
/// and the browser URL that leads back to either. Dropping the session tears
/// both down.
pub fn begin_sign_in() -> SignInSession {
    let server = server_url();
    let local_only = should_use_local_server_session(&server);
    let id = NEXT_SESSION_ID.fetch_add(1, Ordering::Relaxed);
    let callback = Arc::new(CallbackControl::default());

    // Without a port the server redirects straight to the `cap-desktop://`
    // deep link, so a failed bind degrades to the deep-link path instead of
    // failing sign-in outright.
    let local = match start_local_callback(callback.clone()) {
        Ok(local) => Some(local),
        Err(error) => {
            tracing::warn!(
                "sign-in loopback server unavailable, using the deep link only: {error}"
            );
            None
        }
    };

    let (deep_tx, deep_rx) = flume::bounded(8);
    *deep_link_slot()
        .lock()
        .unwrap_or_else(|error| error.into_inner()) = Some(DeepLinkSlot {
        session: id,
        tx: deep_tx,
    });

    SignInSession {
        url: sign_in_request_url(&server, local.as_ref().map(|local| local.port), local_only),
        id,
        local: local.map(|local| local.complete),
        deep: deep_rx,
        callback,
    }
}

fn sign_in_request_url(server: &str, port: Option<u16>, local_only: bool) -> String {
    let mut url = format!("{server}/api/desktop/session/request?type=api_key");
    if let Some(port) = port {
        url.push_str(&format!("&port={port}"));
    }
    url.push_str(if local_only {
        "&platform=web"
    } else {
        "&platform=desktop"
    });
    url
}

impl SignInSession {
    /// Resolve with whichever callback arrives first -- the loopback request or
    /// the `cap-desktop://` deep link -- or time out.
    pub async fn wait(
        &self,
        timeout: impl Future<Output = ()>,
    ) -> Result<AuthParams, SignInWaitError> {
        let local = async {
            match &self.local {
                Some(local) => match local.recv_async().await {
                    Ok(params) => params,
                    Err(_) => std::future::pending().await,
                },
                None => std::future::pending().await,
            }
        };
        let deep = async {
            loop {
                match self.deep.recv_async().await {
                    Ok(url) => {
                        if let Some(params) = parse_auth_params(&url) {
                            break params;
                        }
                    }
                    Err(_) => std::future::pending::<()>().await,
                }
            }
        };
        let local = pin!(local);
        let deep = pin!(deep);
        let timeout = pin!(timeout);
        match select(select(local, deep), timeout).await {
            Either::Left((Either::Left((params, _)) | Either::Right((params, _)), _)) => Ok(params),
            Either::Right(_) => Err(SignInWaitError::TimedOut),
        }
    }

    pub fn mark_completed(&self) {
        self.callback.completed.store(true, Ordering::Release);
    }
}

impl Drop for SignInSession {
    fn drop(&mut self) {
        if !self.callback.completed.load(Ordering::Acquire) {
            self.callback.stop.store(true, Ordering::Release);
        }
        let mut slot = deep_link_slot()
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if slot.as_ref().is_some_and(|slot| slot.session == self.id) {
            *slot = None;
        }
    }
}

pub fn submit_deep_link(url: &str) {
    let slot = deep_link_slot();
    let guard = slot.lock().unwrap_or_else(|error| error.into_inner());
    if let Some(slot) = guard.as_ref() {
        let _ = slot.tx.try_send(url.to_string());
    }
}

pub fn sign_out() -> bool {
    store::set_auth(None)
}

pub fn apply_desktop_headers(mut request: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
    request = request
        .header("X-Cap-Desktop-Version", env!("CARGO_PKG_VERSION"))
        .header("X-Cap-Desktop-Features", "googleDriveUpload,gpui");
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

#[derive(Clone)]
pub(crate) struct UploadRequestContext {
    server_url: String,
    owner_id: String,
}

tokio::task_local! {
    static UPLOAD_REQUEST: UploadRequestContext;
}

impl UploadRequestContext {
    pub(crate) fn for_upload(
        server_url: &str,
        owner_id: Option<&str>,
    ) -> Result<Self, AuthApiError> {
        let context = Self {
            server_url: server_url.to_string(),
            owner_id: owner_id
                .filter(|id| !id.is_empty())
                .ok_or(AuthApiError::InvalidAuthentication)?
                .to_string(),
        };
        context.credentials()?;
        Ok(context)
    }

    fn credentials_from(
        &self,
        current_server: &str,
        current_auth: &serde_json::Map<String, Value>,
    ) -> Result<String, AuthApiError> {
        if !has_same_origin(current_server, &self.server_url)
            || current_auth.get("user_id").and_then(Value::as_str) != Some(self.owner_id.as_str())
        {
            return Err(AuthApiError::InvalidAuthentication);
        }
        current_auth
            .get("secret")
            .and_then(Value::as_object)
            .and_then(|secret| secret.get("api_key").or_else(|| secret.get("token")))
            .and_then(Value::as_str)
            .filter(|token| !token.is_empty())
            .map(str::to_string)
            .ok_or(AuthApiError::InvalidAuthentication)
    }

    fn credentials(&self) -> Result<String, AuthApiError> {
        self.credentials_from(&server_url(), &store::store_section("auth"))
    }

    pub(crate) async fn run<F: std::future::Future>(self, future: F) -> F::Output {
        UPLOAD_REQUEST.scope(self, future).await
    }
}

/// Idle API connections are dropped after 4 s, before the 5 s keep-alive
/// timeout of a self-hosted Node server, so a request is never sent on a
/// connection the server is closing.
pub(crate) const API_POOL_IDLE_TIMEOUT: Duration = Duration::from_secs(4);
/// The shared API client is rebuilt this often, so system proxy changes still
/// apply. It is wall clock time, which counts a sleep where the pool's idle
/// clock does not, so calls after a longer sleep start on new connections.
const API_CLIENT_MAX_AGE: Duration = Duration::from_secs(30);

fn api_client_builder() -> reqwest::ClientBuilder {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(45))
}

/// Multipart uploads hold their own client and drop it when the upload ends,
/// so a later upload never starts on a pooled connection from an earlier
/// network (#2522).
pub fn api_client() -> Result<reqwest::Client, AuthApiError> {
    api_client_builder()
        .build()
        .map_err(|error| AuthApiError::Other(error.to_string()))
}

static SHARED_API_CLIENT: Mutex<Option<(std::time::SystemTime, reqwest::Client)>> =
    Mutex::new(None);

/// Held by every test that resets the shared client or counts its
/// connections, so a reset on one thread cannot land in another's count.
#[cfg(test)]
pub(crate) static SHARED_API_CLIENT_TEST_LOCK: tokio::sync::Mutex<()> =
    tokio::sync::Mutex::const_new(());

/// Drops the shared client, as quitting the app does, for tests that model a
/// relaunch.
#[cfg(test)]
pub(crate) fn reset_shared_api_client() {
    *SHARED_API_CLIENT
        .lock()
        .unwrap_or_else(|error| error.into_inner()) = None;
}

/// The client `authed_request` uses. Calls close together, like Instant
/// presigns about once a second or the requests after a recording stops,
/// reuse its open connections instead of each paying a TCP and TLS handshake.
fn shared_api_client() -> Result<reqwest::Client, AuthApiError> {
    let mut shared = SHARED_API_CLIENT
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    if let Some((built, client)) = shared.as_ref()
        && built.elapsed().is_ok_and(|age| age < API_CLIENT_MAX_AGE)
    {
        return Ok(client.clone());
    }
    let client = api_client_builder()
        .pool_idle_timeout(API_POOL_IDLE_TIMEOUT)
        .build()
        .map_err(|error| AuthApiError::Other(error.to_string()))?;
    *shared = Some((std::time::SystemTime::now(), client.clone()));
    Ok(client)
}

pub async fn authed_request(
    method: reqwest::Method,
    path: &str,
    body: Option<Value>,
) -> Result<reqwest::Response, AuthApiError> {
    authed_request_with(&shared_api_client()?, method, path, body).await
}

pub async fn authed_request_with(
    client: &reqwest::Client,
    method: reqwest::Method,
    path: &str,
    body: Option<Value>,
) -> Result<reqwest::Response, AuthApiError> {
    let (server, token) = if let Ok(context) = UPLOAD_REQUEST.try_with(Clone::clone) {
        let token = context.credentials()?;
        (context.server_url, token)
    } else {
        let auth = store::auth_snapshot();
        (
            server_url(),
            auth.token.ok_or(AuthApiError::InvalidAuthentication)?,
        )
    };
    let url = format!("{server}{path}");
    let mut request = client.request(method, url);
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
    let account = auth_identity(&store::store_section("auth"));

    let mut plan = None;
    if !snapshot.plan_manual {
        match authed_request(reqwest::Method::GET, "/api/desktop/plan", None).await {
            Ok(response) if response.status().is_success() => {
                if let Ok(body) = response.json::<Value>().await
                    && let Some(upgraded) = body.get("upgraded").and_then(Value::as_bool)
                {
                    plan = Some(json!({
                        "upgraded": upgraded,
                        "manual": false,
                        "last_checked": chrono::Utc::now().timestamp() as i32,
                    }));
                }
            }
            Ok(response) => tracing::warn!("Plan fetch returned {}", response.status()),
            Err(error) => tracing::warn!("Failed to fetch plan: {error}"),
        }
    }

    let mut organizations = None;
    let mut organizations_failed = false;
    match authed_request(reqwest::Method::GET, "/api/desktop/organizations", None).await {
        Ok(response) if response.status().is_success() => {
            if let Ok(orgs) = response.json::<Value>().await {
                organizations = Some(orgs);
            }
        }
        Ok(response) => tracing::warn!("Organizations fetch returned {}", response.status()),
        Err(error) => {
            tracing::warn!("Failed to fetch organizations: {error}");
            organizations_failed = true;
        }
    }

    // Merged into the auth section as it is on disk now, and only if it still
    // belongs to the account these responses are for: a sign-out or account
    // switch during the requests must not be overwritten by the old session.
    let mut stale = false;
    let persisted = store::update_store_section("auth", |auth| {
        if account.is_none() || auth_identity(auth) != account {
            stale = true;
            return false;
        }
        if let Some(plan) = plan {
            auth.insert("plan".into(), plan);
        }
        let now = json!(chrono::Utc::now().timestamp() as i32);
        if let Some(orgs) = organizations {
            auth.insert("organizations".into(), orgs);
            auth.insert("organizations_updated_at".into(), now);
        } else if organizations_failed
            && auth
                .get("organizations")
                .and_then(Value::as_array)
                .is_none_or(Vec::is_empty)
        {
            auth.insert("organizations_updated_at".into(), now);
        }
        true
    });
    if stale {
        return Err(AuthApiError::InvalidAuthentication);
    }
    if !persisted {
        return Err(AuthApiError::Other("Failed to persist auth plan".into()));
    }
    Ok(())
}

fn auth_identity(auth: &serde_json::Map<String, Value>) -> Option<(Value, Value)> {
    Some((auth.get("user_id")?.clone(), auth.get("secret")?.clone()))
}

struct LocalCallback {
    port: u16,
    complete: flume::Receiver<AuthParams>,
}

const MAX_CALLBACK_CONNECTIONS: usize = 8;
const CALLBACK_REQUEST_DEADLINE: Duration = Duration::from_secs(30);

fn start_local_callback(control: Arc<CallbackControl>) -> std::io::Result<LocalCallback> {
    let listener = TcpListener::bind("127.0.0.1:0")?;
    listener.set_nonblocking(true)?;
    let port = listener.local_addr()?.port();
    let (tx, rx) = flume::bounded(1);
    std::thread::Builder::new()
        .name("cap-sign-in-callback".into())
        .spawn(move || serve_local_callback(listener, port, &control, &tx))?;
    Ok(LocalCallback { port, complete: rx })
}

fn serve_local_callback(
    listener: TcpListener,
    port: u16,
    control: &CallbackControl,
    tx: &flume::Sender<AuthParams>,
) {
    let started = Instant::now();
    let mut completed_at = None;
    let active = Arc::new(AtomicUsize::new(0));
    loop {
        if control.stop.load(Ordering::Acquire) {
            return;
        }
        if control.completed.load(Ordering::Acquire)
            && completed_at.get_or_insert_with(Instant::now).elapsed() >= CALLBACK_LINGER
        {
            return;
        }
        if started.elapsed() >= SIGN_IN_TIMEOUT + CALLBACK_LINGER {
            return;
        }
        match listener.accept() {
            Ok((stream, _)) => {
                // A browser needs one or two connections; anything local
                // holding more open must not pin a thread each.
                if active.load(Ordering::Acquire) >= MAX_CALLBACK_CONNECTIONS {
                    drop(stream);
                    continue;
                }
                active.fetch_add(1, Ordering::AcqRel);
                let tx = tx.clone();
                let connection_active = active.clone();
                let spawned = std::thread::Builder::new()
                    .name("cap-sign-in-request".into())
                    .spawn(move || {
                        handle_callback_connection(stream, port, &tx);
                        connection_active.fetch_sub(1, Ordering::AcqRel);
                    });
                if let Err(error) = spawned {
                    active.fetch_sub(1, Ordering::AcqRel);
                    tracing::warn!("sign-in callback connection thread: {error}");
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                std::thread::sleep(Duration::from_millis(50));
            }
            Err(error) => {
                tracing::warn!("sign-in callback accept: {error}");
                std::thread::sleep(Duration::from_millis(50));
            }
        }
    }
}

fn handle_callback_connection(mut stream: TcpStream, port: u16, tx: &flume::Sender<AuthParams>) {
    // BSD sockets inherit O_NONBLOCK from the listener, so on macOS a stream
    // accepted from the non-blocking listener reads WouldBlock until the
    // browser's request bytes land. Treating that as a failed read dropped the
    // callback and left sign-in waiting forever.
    if stream.set_nonblocking(false).is_err()
        || stream
            .set_read_timeout(Some(Duration::from_secs(5)))
            .is_err()
        || stream
            .set_write_timeout(Some(Duration::from_secs(5)))
            .is_err()
    {
        return;
    }
    let deadline = Instant::now() + CALLBACK_REQUEST_DEADLINE;
    let Some(target) = read_request_target(&mut stream, deadline) else {
        return;
    };
    let params = parse_auth_params(&format!("http://127.0.0.1:{port}{target}"));
    let (status, body) = if params.is_some() {
        ("200 OK", CALLBACK_HTML)
    } else {
        ("404 Not Found", NOT_FOUND_HTML)
    };
    if let Some(params) = params {
        let _ = tx.try_send(params);
    }
    let response = format!(
        "HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\nCache-Control: no-store, no-cache, must-revalidate\r\nPragma: no-cache\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    let _ = stream.write_all(response.as_bytes());
    let _ = stream.flush();
    let _ = stream.shutdown(std::net::Shutdown::Write);
}

/// The request target of an HTTP/1 request, after reading the whole header
/// block: closing a socket with unread request bytes makes the kernel answer
/// with a reset, which browsers show as an error page instead of ours.
fn read_request_target(stream: &mut impl Read, deadline: Instant) -> Option<String> {
    const MAX_HEADER_BYTES: usize = 32 * 1024;
    let mut request = Vec::with_capacity(1024);
    let mut chunk = [0u8; 4096];
    while !request.windows(4).any(|window| window == b"\r\n\r\n") {
        if request.len() > MAX_HEADER_BYTES || Instant::now() >= deadline {
            return None;
        }
        match stream.read(&mut chunk) {
            Ok(0) => break,
            Ok(read) => request.extend_from_slice(&chunk[..read]),
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => {}
            Err(_) => break,
        }
    }
    let request = String::from_utf8_lossy(&request);
    let mut parts = request.lines().next()?.split_whitespace();
    let _method = parts.next()?;
    let target = parts.next()?;
    target.starts_with('/').then(|| target.to_string())
}

fn deep_link_slot() -> &'static Mutex<Option<DeepLinkSlot>> {
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

    fn request(port: u16, delay: Duration, request: &str) -> String {
        let mut stream = TcpStream::connect(("127.0.0.1", port)).unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(10)))
            .unwrap();
        let (head, tail) = request.split_at(request.len() / 2);
        std::thread::sleep(delay);
        stream.write_all(head.as_bytes()).unwrap();
        std::thread::sleep(delay);
        stream.write_all(tail.as_bytes()).unwrap();
        let mut response = String::new();
        stream.read_to_string(&mut response).unwrap();
        response
    }

    #[test]
    fn loopback_callback_survives_a_slow_browser_and_keeps_serving() {
        let control = Arc::new(CallbackControl::default());
        let local = start_local_callback(control.clone()).unwrap();

        let unrelated = request(
            local.port,
            Duration::ZERO,
            "GET /favicon.ico HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n",
        );
        assert!(unrelated.starts_with("HTTP/1.1 404"), "{unrelated}");
        assert!(local.complete.try_recv().is_err());

        let callback = request(
            local.port,
            Duration::from_millis(300),
            "GET /?type=api_key&api_key=key-1&user_id=user-1 HTTP/1.1\r\nHost: 127.0.0.1\r\nAccept: text/html\r\n\r\n",
        );
        assert!(callback.starts_with("HTTP/1.1 200"), "{callback}");
        assert!(callback.contains("signed in"));
        assert_eq!(
            local.complete.recv_timeout(Duration::from_secs(5)).unwrap(),
            AuthParams::ApiKey {
                api_key: "key-1".into(),
                user_id: "user-1".into(),
            }
        );

        control.completed.store(true, Ordering::Release);
        let fallback = request(
            local.port,
            Duration::ZERO,
            "GET /?type=api_key&api_key=key-1&user_id=user-1 HTTP/1.1\r\n\r\n",
        );
        assert!(fallback.starts_with("HTTP/1.1 200"), "{fallback}");
        control.stop.store(true, Ordering::Release);
    }

    fn far_future() -> Instant {
        Instant::now() + Duration::from_secs(60)
    }

    #[test]
    fn a_request_past_its_deadline_is_dropped() {
        let mut slow = "GET /?api_key=k HTTP/1.1\r\n\r\n".as_bytes();
        assert_eq!(read_request_target(&mut slow, Instant::now()), None);
    }

    #[test]
    fn request_target_needs_a_path() {
        let mut ok = "GET /?api_key=k HTTP/1.1\r\nHost: x\r\n\r\n".as_bytes();
        assert_eq!(
            read_request_target(&mut ok, far_future()).as_deref(),
            Some("/?api_key=k")
        );
        let mut absolute = "GET http://evil/ HTTP/1.1\r\n\r\n".as_bytes();
        assert_eq!(read_request_target(&mut absolute, far_future()), None);
        let mut empty = "".as_bytes();
        assert_eq!(read_request_target(&mut empty, far_future()), None);
    }

    #[test]
    fn sign_in_url_omits_a_missing_port() {
        assert_eq!(
            sign_in_request_url("https://cap.so", Some(4280), false),
            "https://cap.so/api/desktop/session/request?type=api_key&port=4280&platform=desktop"
        );
        assert_eq!(
            sign_in_request_url("http://localhost:3000", None, true),
            "http://localhost:3000/api/desktop/session/request?type=api_key&platform=web"
        );
    }

    #[test]
    fn a_finished_session_only_clears_its_own_deep_link_slot() {
        let (old_tx, old_rx) = flume::bounded(1);
        let old = SignInSession {
            url: String::new(),
            id: u64::MAX - 1,
            local: None,
            deep: old_rx,
            callback: Arc::new(CallbackControl::default()),
        };
        drop(old_tx);
        let (new_tx, new_rx) = flume::bounded(1);
        *deep_link_slot().lock().unwrap() = Some(DeepLinkSlot {
            session: u64::MAX,
            tx: new_tx,
        });
        drop(old);
        submit_deep_link("cap-desktop://signin?api_key=k&user_id=u");
        assert_eq!(
            new_rx.try_recv().unwrap(),
            "cap-desktop://signin?api_key=k&user_id=u"
        );
        *deep_link_slot().lock().unwrap() = None;
    }

    #[test]
    fn plan_refresh_identity_tracks_account_and_credential() {
        let signed_in = json!({"user_id":"u","secret":{"api_key":"k"},"plan":null});
        let refreshed_plan =
            json!({"user_id":"u","secret":{"api_key":"k"},"plan":{"upgraded":true}});
        let other_key = json!({"user_id":"u","secret":{"api_key":"k2"}});
        let identity = |value: &Value| auth_identity(value.as_object().unwrap());
        assert!(identity(&signed_in).is_some());
        assert_eq!(identity(&signed_in), identity(&refreshed_plan));
        assert_ne!(identity(&signed_in), identity(&other_key));
        assert_eq!(identity(&json!({})), None);
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

#[cfg(test)]
mod upload_context_tests {
    use super::*;

    #[test]
    fn upload_credentials_refresh_only_for_the_same_account_and_server() {
        let context = UploadRequestContext {
            server_url: "https://original.invalid".into(),
            owner_id: "owner".into(),
        };
        let original = json!({"user_id":"owner","secret":{"api_key":"original-credential"}})
            .as_object()
            .unwrap()
            .clone();
        assert_eq!(
            context
                .credentials_from("https://original.invalid", &original)
                .unwrap(),
            "original-credential"
        );
        let refreshed = json!({"user_id":"owner","secret":{"api_key":"refreshed-credential"}})
            .as_object()
            .unwrap()
            .clone();
        assert_eq!(
            context
                .credentials_from("https://original.invalid", &refreshed)
                .unwrap(),
            "refreshed-credential"
        );
        assert_eq!(
            context
                .credentials_from("https://original.invalid:443", &refreshed)
                .unwrap(),
            "refreshed-credential"
        );
        assert!(
            context
                .credentials_from("https://changed.invalid", &refreshed)
                .is_err()
        );
        let different_owner =
            json!({"user_id":"another-owner","secret":{"api_key":"different-credential"}})
                .as_object()
                .unwrap()
                .clone();
        assert!(
            context
                .credentials_from("https://original.invalid", &different_owner)
                .is_err()
        );
        assert!(
            context
                .credentials_from("https://original.invalid", &serde_json::Map::new())
                .is_err()
        );
    }
}
