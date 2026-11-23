use std::{
    collections::{BTreeMap, HashMap},
    fs,
    io::{Read, Write},
    net::{Ipv4Addr, TcpListener, TcpStream},
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};

use cap_calendar::{
    CalendarEvent, CalendarInfo, HttpMethod, HttpRequestSpec,
    google::{
        GoogleOptions, google_calendar_list_request, google_events_request,
        parse_google_calendar_list, parse_google_events_with,
    },
    graph::{
        GraphOptions, graph_calendar_view_request, graph_calendars_request, parse_graph_calendars,
        parse_graph_events_with,
    },
    oauth::{self, AuthError, OAuthClient, Pkce},
};
use chrono::{DateTime, Utc};
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};

use super::persist;

pub use cap_calendar::oauth::OAuthProvider as Provider;

const ACCOUNTS_FILE: &str = "calendar-accounts.json";
const SIGN_IN_TIMEOUT: Duration = Duration::from_secs(300);
const ACCEPT_POLL: Duration = Duration::from_millis(40);
const REQUEST_LIMIT: usize = 16 * 1024;
const RESPONSE_LIMIT: usize = 8 * 1024 * 1024;
const MAX_CALENDARS: usize = 12;
const MAX_PAGES: usize = 8;
const TOKEN_MARGIN: Duration = Duration::from_secs(90);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ConnectError {
    NotConfigured,
    Cancelled,
    Denied,
    Network,
    Rejected,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum ConnectState {
    #[default]
    Idle,
    WaitingForBrowser(Provider),
    Finishing(Provider),
    Failed(Provider, ConnectError),
}

impl ConnectState {
    pub fn busy(self) -> Option<Provider> {
        match self {
            Self::WaitingForBrowser(provider) | Self::Finishing(provider) => Some(provider),
            Self::Idle | Self::Failed(..) => None,
        }
    }
}

fn setting(runtime: &str, built_in: Option<&'static str>) -> Option<String> {
    std::env::var(runtime)
        .ok()
        .or_else(|| built_in.map(str::to_string))
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

pub fn client_id(provider: Provider) -> Option<String> {
    match provider {
        Provider::Google => setting(
            "CAP_GOOGLE_CALENDAR_CLIENT_ID",
            option_env!("CAP_GOOGLE_CALENDAR_CLIENT_ID"),
        ),
        Provider::Microsoft => setting(
            "CAP_MICROSOFT_CALENDAR_CLIENT_ID",
            option_env!("CAP_MICROSOFT_CALENDAR_CLIENT_ID"),
        ),
    }
}

pub fn configured(provider: Provider) -> bool {
    client_id(provider).is_some()
}

fn client(provider: Provider) -> Option<OAuthClient> {
    let id = client_id(provider)?;
    Some(match provider {
        // Google issues a "secret" to installed-app clients and requires it at
        // the token endpoint; it identifies the app and protects nothing, PKCE
        // does that.
        Provider::Google => OAuthClient::google(
            id,
            setting(
                "CAP_GOOGLE_CALENDAR_CLIENT_SECRET",
                option_env!("CAP_GOOGLE_CALENDAR_CLIENT_SECRET"),
            ),
        ),
        Provider::Microsoft => OAuthClient::microsoft(id),
    })
}

fn random(len: usize) -> Result<Vec<u8>, ConnectError> {
    let mut bytes = vec![0u8; len];
    getrandom::getrandom(&mut bytes).map_err(|_| ConnectError::Rejected)?;
    Ok(bytes)
}

pub struct Connected {
    pub provider: Provider,
    pub email: String,
    pub refresh_token: String,
}

#[derive(Clone, Default)]
pub struct Cancel(Arc<AtomicBool>);

impl Cancel {
    pub fn cancel(&self) {
        self.0.store(true, Ordering::Relaxed);
    }

    fn cancelled(&self) -> bool {
        self.0.load(Ordering::Relaxed)
    }
}

pub struct Pending {
    provider: Provider,
    client: OAuthClient,
    listener: TcpListener,
    redirect_uri: String,
    state: String,
    verifier: String,
    pub authorize_url: String,
    pub cancel: Cancel,
}

impl Pending {
    pub fn new(provider: Provider) -> Result<Self, ConnectError> {
        let client = client(provider).ok_or(ConnectError::NotConfigured)?;
        let listener =
            TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).map_err(|_| ConnectError::Rejected)?;
        listener
            .set_nonblocking(true)
            .map_err(|_| ConnectError::Rejected)?;
        let port = listener
            .local_addr()
            .map_err(|_| ConnectError::Rejected)?
            .port();
        // Microsoft only treats `localhost` as a loopback redirect whose port
        // may vary; Google documents the literal address.
        let redirect_uri = match provider {
            Provider::Google => format!("http://127.0.0.1:{port}"),
            Provider::Microsoft => format!("http://localhost:{port}"),
        };
        let pkce = Pkce::from_random(&random(64)?).map_err(|_| ConnectError::Rejected)?;
        let state = oauth::state_from_random(&random(24)?).map_err(|_| ConnectError::Rejected)?;
        let authorize_url =
            oauth::authorize_url(&client, &redirect_uri, &state, &pkce.challenge, None);
        Ok(Self {
            provider,
            client,
            listener,
            redirect_uri,
            state,
            verifier: pkce.verifier,
            authorize_url,
            cancel: Cancel::default(),
        })
    }

    pub async fn finish(self) -> Result<Connected, ConnectError> {
        let Self {
            provider,
            client,
            listener,
            redirect_uri,
            state,
            verifier,
            cancel,
            ..
        } = self;
        let code = tokio::task::spawn_blocking(move || wait_for_code(&listener, &state, &cancel))
            .await
            .map_err(|_| ConnectError::Rejected)??;
        let http = http_client().map_err(|_| ConnectError::Network)?;
        let spec = oauth::token_request(&client, &code, &verifier, &redirect_uri);
        let (_, body) = send(&http, &spec, None)
            .await
            .map_err(|_| ConnectError::Network)?;
        let tokens = oauth::parse_token_response(&body).map_err(|error| {
            tracing::warn!(?provider, %error, "calendar sign-in was rejected");
            match error {
                AuthError::AccessDenied => ConnectError::Denied,
                _ => ConnectError::Rejected,
            }
        })?;
        let Some(refresh_token) = tokens.refresh_token else {
            tracing::warn!(?provider, "calendar sign-in returned no refresh token");
            return Err(ConnectError::Rejected);
        };
        Ok(Connected {
            provider,
            email: tokens.id_token_email.unwrap_or_default(),
            refresh_token,
        })
    }
}

fn respond(stream: &mut TcpStream, status: &str, page: &str) {
    let _ = write!(
        stream,
        "HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n{page}",
        page.len()
    );
    let _ = stream.flush();
}

fn request_target(stream: &mut TcpStream) -> Option<String> {
    stream.set_nonblocking(false).ok()?;
    stream.set_read_timeout(Some(Duration::from_secs(5))).ok()?;
    let mut buffer = Vec::with_capacity(2048);
    let mut chunk = [0u8; 2048];
    while !buffer.windows(2).any(|pair| pair == b"\r\n") {
        if buffer.len() >= REQUEST_LIMIT {
            return None;
        }
        match stream.read(&mut chunk) {
            Ok(0) | Err(_) => return None,
            Ok(read) => buffer.extend_from_slice(&chunk[..read]),
        }
    }
    let line = buffer.split(|byte| *byte == b'\r').next()?;
    let line = std::str::from_utf8(line).ok()?;
    let mut parts = line.split(' ');
    (parts.next()? == "GET").then_some(())?;
    parts.next().map(str::to_string)
}

fn wait_for_code(
    listener: &TcpListener,
    state: &str,
    cancel: &Cancel,
) -> Result<String, ConnectError> {
    let deadline = Instant::now() + SIGN_IN_TIMEOUT;
    loop {
        if cancel.cancelled() || Instant::now() >= deadline {
            return Err(ConnectError::Cancelled);
        }
        let mut stream = match listener.accept() {
            Ok((stream, _)) => stream,
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                std::thread::sleep(ACCEPT_POLL);
                continue;
            }
            Err(_) => return Err(ConnectError::Rejected),
        };
        let Some(target) = request_target(&mut stream) else {
            continue;
        };
        let (path, query) = target.split_once('?').unwrap_or((target.as_str(), ""));
        if path != "/" || query.is_empty() {
            respond(&mut stream, "404 Not Found", &crate::local_page::unknown());
            continue;
        }
        match oauth::parse_redirect(query, state) {
            Ok(code) => {
                respond(
                    &mut stream,
                    "200 OK",
                    &crate::local_page::calendar_connected(),
                );
                return Ok(code.code);
            }
            Err(AuthError::AccessDenied) => {
                respond(
                    &mut stream,
                    "200 OK",
                    &crate::local_page::calendar_not_connected(),
                );
                return Err(ConnectError::Denied);
            }
            Err(AuthError::Provider { error, .. }) => {
                tracing::warn!(error, "calendar sign-in redirect carried an error");
                respond(
                    &mut stream,
                    "200 OK",
                    &crate::local_page::calendar_not_connected(),
                );
                return Err(ConnectError::Rejected);
            }
            Err(_) => respond(
                &mut stream,
                "400 Bad Request",
                &crate::local_page::unknown(),
            ),
        }
    }
}

fn http_client() -> Result<reqwest::Client, reqwest::Error> {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(45))
        .redirect(reqwest::redirect::Policy::none())
        .user_agent(concat!("Cap/", env!("CARGO_PKG_VERSION")))
        .build()
}

#[derive(Debug)]
enum SendError {
    Network(reqwest::Error),
    TooLarge,
}

async fn send(
    http: &reqwest::Client,
    spec: &HttpRequestSpec,
    bearer: Option<&str>,
) -> Result<(u16, String), SendError> {
    let url = spec.url_with_query();
    let mut request = match spec.method {
        HttpMethod::Get => http.get(url),
        HttpMethod::Post => http.post(url).form(&spec.form),
    };
    for (name, value) in &spec.headers {
        if !name.eq_ignore_ascii_case("content-type") {
            request = request.header(name, value);
        }
    }
    if let Some(token) = bearer {
        request = request.bearer_auth(token);
    }
    let response = request.send().await.map_err(SendError::Network)?;
    let status = response.status().as_u16();
    let mut body = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(SendError::Network)?;
        if body.len() + chunk.len() > RESPONSE_LIMIT {
            return Err(SendError::TooLarge);
        }
        body.extend_from_slice(&chunk);
    }
    Ok((status, String::from_utf8_lossy(&body).into_owned()))
}

#[derive(Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct Stored {
    refresh_token: String,
}

#[derive(Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct AccountsFile {
    accounts: BTreeMap<String, Stored>,
}

fn accounts_path(dir: &Path) -> PathBuf {
    dir.join(ACCOUNTS_FILE)
}

fn read_accounts(dir: &Path) -> AccountsFile {
    persist::read_store(&accounts_path(dir)).unwrap_or_default()
}

fn write_accounts(dir: &Path, file: &AccountsFile) -> std::io::Result<()> {
    persist::atomic_write_private(&accounts_path(dir), &serde_json::to_vec_pretty(file)?)
}

/// Held for every change to the accounts file and the access token cache, so
/// a refresh that finishes as its account is removed cannot bring it back.
fn accounts_lock() -> std::sync::MutexGuard<'static, ()> {
    static LOCK: Mutex<()> = Mutex::new(());
    LOCK.lock().unwrap_or_else(|e| e.into_inner())
}

pub fn store_refresh_token(dir: &Path, id: &str, refresh_token: &str) -> std::io::Result<()> {
    let _held = accounts_lock();
    let mut file = read_accounts(dir);
    file.accounts.insert(
        id.to_string(),
        Stored {
            refresh_token: refresh_token.to_string(),
        },
    );
    write_accounts(dir, &file)
}

pub fn forget(dir: &Path, id: &str) {
    let _held = accounts_lock();
    access_tokens()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove(id);
    let mut file = read_accounts(dir);
    if file.accounts.remove(id).is_some()
        && let Err(error) = write_accounts(dir, &file)
    {
        tracing::warn!(%error, "could not update the calendar accounts file");
    }
}

fn refresh_token(dir: &Path, id: &str) -> Option<String> {
    read_accounts(dir)
        .accounts
        .remove(id)
        .map(|stored| stored.refresh_token)
        .filter(|token| !token.is_empty())
}

fn access_tokens() -> &'static Mutex<HashMap<String, (String, Instant)>> {
    static TOKENS: std::sync::OnceLock<Mutex<HashMap<String, (String, Instant)>>> =
        std::sync::OnceLock::new();
    TOKENS.get_or_init(Default::default)
}

#[derive(Debug, PartialEq, Eq)]
pub enum FetchError {
    SignInAgain,
    NotConfigured,
    Offline,
    Server(String),
}

async fn access_token(
    http: &reqwest::Client,
    dir: &Path,
    id: &str,
    client: &OAuthClient,
) -> Result<String, FetchError> {
    if let Some((token, expires)) = access_tokens()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(id)
        && *expires > Instant::now()
    {
        return Ok(token.clone());
    }
    let refresh = refresh_token(dir, id).ok_or(FetchError::SignInAgain)?;
    let spec = oauth::refresh_request(client, &refresh);
    let (status, body) = send(http, &spec, None).await.map_err(|error| match error {
        SendError::Network(_) => FetchError::Offline,
        SendError::TooLarge => FetchError::Server("oversized token response".into()),
    })?;
    let tokens = match oauth::parse_token_response(&body) {
        Ok(tokens) => tokens,
        Err(AuthError::Provider { error, .. })
            if matches!(error.as_str(), "invalid_grant" | "interaction_required") =>
        {
            return Err(FetchError::SignInAgain);
        }
        Err(AuthError::AccessDenied) => return Err(FetchError::SignInAgain),
        Err(error) => {
            return Err(FetchError::Server(format!(
                "token refresh failed with {status}: {error}"
            )));
        }
    };
    if !keep_refreshed(dir, id, &refresh, &tokens) {
        return Err(FetchError::SignInAgain);
    }
    Ok(tokens.access_token)
}

/// Saves what a refresh returned, unless the account was removed while it
/// ran: then nothing is saved or cached and this returns false.
fn keep_refreshed(dir: &Path, id: &str, refresh: &str, tokens: &oauth::Tokens) -> bool {
    let _held = accounts_lock();
    let mut file = read_accounts(dir);
    let Some(stored) = file.accounts.get_mut(id) else {
        return false;
    };
    if let Some(rotated) = tokens.refresh_token.as_deref().filter(|t| *t != refresh) {
        stored.refresh_token = rotated.to_string();
        if let Err(error) = write_accounts(dir, &file) {
            tracing::warn!(%error, "could not save the rotated calendar token");
        }
    }
    let lifetime = Duration::from_secs(tokens.expires_in.unwrap_or(600));
    access_tokens()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(
            id.to_string(),
            (
                tokens.access_token.clone(),
                Instant::now() + lifetime.saturating_sub(TOKEN_MARGIN),
            ),
        );
    true
}

async fn get_json(
    http: &reqwest::Client,
    spec: &HttpRequestSpec,
    token: &str,
    id: &str,
) -> Result<String, FetchError> {
    let (status, body) = send(http, spec, Some(token))
        .await
        .map_err(|error| match error {
            SendError::Network(_) => FetchError::Offline,
            SendError::TooLarge => FetchError::Server("oversized calendar response".into()),
        })?;
    match status {
        200..=299 => Ok(body),
        401 => {
            access_tokens()
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .remove(id);
            Err(FetchError::SignInAgain)
        }
        403 => Err(FetchError::SignInAgain),
        _ => Err(FetchError::Server(format!(
            "the calendar service answered {status}"
        ))),
    }
}

pub struct AccountFetch {
    pub events: Vec<CalendarEvent>,
    pub calendars: Vec<(CalendarInfo, bool)>,
}

fn shape(error: cap_calendar::Error) -> FetchError {
    FetchError::Server(error.to_string())
}

pub async fn fetch(
    dir: &Path,
    id: &str,
    provider: Provider,
    email: &str,
    window: std::ops::Range<DateTime<Utc>>,
) -> Result<AccountFetch, FetchError> {
    let client = client(provider).ok_or(FetchError::NotConfigured)?;
    let http = http_client().map_err(|_| FetchError::Offline)?;
    let token = access_token(&http, dir, id, &client).await?;
    let self_emails: Vec<String> = Some(email.to_string())
        .filter(|email| !email.is_empty())
        .into_iter()
        .collect();

    let mut calendars = Vec::new();
    let mut next: Option<String> = None;
    for _ in 0..MAX_PAGES {
        let spec = match provider {
            Provider::Google => google_calendar_list_request(next.as_deref()),
            Provider::Microsoft => graph_calendars_request(next.as_deref()).map_err(shape)?,
        };
        let body = get_json(&http, &spec, &token, id).await?;
        let page = match provider {
            Provider::Google => parse_google_calendar_list(&body),
            Provider::Microsoft => parse_graph_calendars(&body),
        }
        .map_err(shape)?;
        calendars.extend(page.items);
        next = page.next;
        if next.is_none() {
            break;
        }
    }

    // Google marks the calendars ticked in its own sidebar; Outlook has no
    // such flag, so every calendar of the account counts there.
    let mut chosen: Vec<(CalendarInfo, bool)> = calendars
        .into_iter()
        .map(|calendar| {
            let wanted = match provider {
                Provider::Google => calendar.selected || calendar.primary,
                Provider::Microsoft => true,
            };
            (calendar, wanted)
        })
        .collect();
    chosen.sort_by_key(|(calendar, wanted)| (!wanted, !calendar.primary));
    for (index, (_, wanted)) in chosen.iter_mut().enumerate() {
        *wanted &= index < MAX_CALENDARS;
    }

    let mut events = Vec::new();
    for (calendar, _) in chosen.iter().filter(|(_, wanted)| *wanted) {
        let mut next: Option<String> = None;
        for _ in 0..MAX_PAGES {
            let spec = match provider {
                Provider::Google => google_events_request(&calendar.id, &window, next.as_deref()),
                Provider::Microsoft => {
                    graph_calendar_view_request(Some(&calendar.id), &window, next.as_deref())
                        .map_err(shape)?
                }
            };
            let body = get_json(&http, &spec, &token, id).await?;
            let page = match provider {
                Provider::Google => parse_google_events_with(
                    &body,
                    &calendar.id,
                    &GoogleOptions {
                        self_emails: self_emails.clone(),
                        ..GoogleOptions::default()
                    },
                ),
                Provider::Microsoft => parse_graph_events_with(
                    &body,
                    &calendar.id,
                    &GraphOptions {
                        self_emails: self_emails.clone(),
                        ..GraphOptions::default()
                    },
                ),
            }
            .map_err(shape)?;
            events.extend(keep_for_account(calendar, email, &self_emails, page.items));
            next = page.next;
            if next.is_none() {
                break;
            }
        }
    }
    Ok(AccountFetch {
        events,
        calendars: chosen,
    })
}

/// A calendar shared by someone else (a coworker's, ticked in Google's
/// sidebar) only adds the meetings the user is on, so their private meetings
/// never become the user's prompts or notes.
fn keep_for_account(
    calendar: &CalendarInfo,
    account_email: &str,
    self_emails: &[String],
    events: Vec<CalendarEvent>,
) -> Vec<CalendarEvent> {
    if calendar.is_own(account_email) {
        return events;
    }
    events
        .into_iter()
        .filter_map(|mut event| event.mark_self_by_email(self_emails).then_some(event))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_shared_calendar_adds_only_the_meetings_the_user_is_on() {
        use cap_calendar::{Person, Response};
        let me = "me@example.com";
        let selfs = vec![me.to_string()];
        let person = |email: &str, is_self: bool, response: Response| Person {
            name: None,
            email: Some(email.into()),
            is_self,
            response,
        };
        let event = |id: &str, organizer: Person, attendees: Vec<Person>| CalendarEvent {
            id: id.into(),
            organizer: Some(organizer),
            attendees,
            ..CalendarEvent::default()
        };
        // On the boss's calendar Google marks the boss as `self`.
        let boss = |response| person("boss@example.com", true, response);
        let private = event("private", boss(Response::Accepted), vec![]);
        let invited = event(
            "invited",
            boss(Response::Accepted),
            vec![
                boss(Response::Accepted),
                person("ME@example.com", false, Response::Declined),
            ],
        );
        let organized = event(
            "organized",
            person(me, false, Response::Unknown),
            vec![boss(Response::Accepted)],
        );
        let shared = CalendarInfo {
            id: "boss@example.com".into(),
            access_role: Some("writer".into()),
            owner_email: Some("boss@example.com".into()),
            ..CalendarInfo::default()
        };

        let kept = keep_for_account(
            &shared,
            me,
            &selfs,
            vec![private.clone(), invited.clone(), organized],
        );
        let ids: Vec<&str> = kept.iter().map(|e| e.id.as_str()).collect();
        assert_eq!(
            ids,
            ["invited", "organized"],
            "the boss's private meeting stays out"
        );
        let selves = |e: &CalendarEvent| -> Vec<bool> {
            e.organizer
                .iter()
                .chain(&e.attendees)
                .map(|p| p.is_self)
                .collect()
        };
        assert_eq!(
            selves(&kept[0]),
            [false, false, true],
            "the user, not the boss, is You"
        );
        assert_eq!(
            kept[0].self_response,
            Response::Declined,
            "the user's own answer"
        );
        assert_eq!(selves(&kept[1]), [true, false]);
        assert_eq!(kept[1].self_response, Response::Accepted);

        let own_calendars = [
            CalendarInfo {
                primary: true,
                ..shared.clone()
            },
            CalendarInfo {
                access_role: Some("owner".into()),
                ..shared.clone()
            },
            CalendarInfo {
                owner_email: Some("Me@Example.com".into()),
                ..shared.clone()
            },
        ];
        for own in own_calendars {
            assert_eq!(
                keep_for_account(&own, me, &selfs, vec![private.clone(), invited.clone()]),
                vec![private.clone(), invited.clone()],
                "the user's own calendar keeps every event as it was: {own:?}"
            );
        }
        assert!(
            keep_for_account(&shared, "", &[], vec![invited]).is_empty(),
            "without the account's address a shared calendar adds nothing"
        );
    }

    fn listener() -> (TcpListener, u16) {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        listener.set_nonblocking(true).unwrap();
        let port = listener.local_addr().unwrap().port();
        (listener, port)
    }

    fn get(port: u16, target: &str) -> String {
        let mut stream = TcpStream::connect((Ipv4Addr::LOCALHOST, port)).unwrap();
        write!(stream, "GET {target} HTTP/1.1\r\nHost: localhost\r\n\r\n").unwrap();
        let mut response = String::new();
        let _ = stream.read_to_string(&mut response);
        response
    }

    fn serve(
        state: &'static str,
    ) -> (
        u16,
        Cancel,
        std::thread::JoinHandle<Result<String, ConnectError>>,
    ) {
        let (listener, port) = listener();
        let cancel = Cancel::default();
        let handle = std::thread::spawn({
            let cancel = cancel.clone();
            move || wait_for_code(&listener, state, &cancel)
        });
        (port, cancel, handle)
    }

    fn refreshed(access: &str, rotated: Option<&str>) -> oauth::Tokens {
        oauth::Tokens {
            access_token: access.to_string(),
            refresh_token: rotated.map(str::to_string),
            expires_in: Some(3600),
            id_token_email: None,
            scope: None,
        }
    }

    fn cached(id: &str) -> bool {
        access_tokens()
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .contains_key(id)
    }

    #[test]
    fn a_refresh_that_finishes_after_the_account_is_removed_saves_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let id = "removed-mid-refresh";
        store_refresh_token(dir.path(), id, "old-refresh").unwrap();
        forget(dir.path(), id);
        assert!(!keep_refreshed(
            dir.path(),
            id,
            "old-refresh",
            &refreshed("access", Some("new-refresh"))
        ));
        assert!(
            refresh_token(dir.path(), id).is_none(),
            "no token written back"
        );
        assert!(!cached(id), "no access token kept");
    }

    #[test]
    fn a_refresh_for_a_connected_account_keeps_the_rotated_token() {
        let dir = tempfile::tempdir().unwrap();
        let id = "still-connected";
        store_refresh_token(dir.path(), id, "old-refresh").unwrap();
        assert!(keep_refreshed(
            dir.path(),
            id,
            "old-refresh",
            &refreshed("access", Some("new-refresh"))
        ));
        assert_eq!(
            refresh_token(dir.path(), id).as_deref(),
            Some("new-refresh")
        );
        assert!(cached(id));
        forget(dir.path(), id);
        assert!(!cached(id));
    }

    #[test]
    fn the_redirect_with_the_right_state_yields_the_code() {
        let (port, _cancel, handle) = serve("expected-state");
        let response = get(port, "/?code=abc123&state=expected-state");
        assert!(response.starts_with("HTTP/1.1 200 OK"));
        assert!(response.contains("Calendar connected"));
        assert!(!response.contains("abc123"));
        let (head, body) = response.split_once("\r\n\r\n").unwrap();
        assert!(head.contains("Content-Type: text/html; charset=utf-8"));
        assert!(head.contains(&format!("Content-Length: {}\r\n", body.len())));
        assert!(body.contains("<svg class=\"mark\"") && body.contains("badge done"));
        assert_eq!(handle.join().unwrap(), Ok("abc123".to_string()));
    }

    #[test]
    fn stray_and_forged_requests_are_ignored_until_the_real_one() {
        let (port, _cancel, handle) = serve("expected-state");
        assert!(get(port, "/favicon.ico").starts_with("HTTP/1.1 404"));
        assert!(get(port, "/").starts_with("HTTP/1.1 404"));
        assert!(get(port, "/?code=evil&state=wrong").starts_with("HTTP/1.1 400"));
        assert!(get(port, "/?code=evil").starts_with("HTTP/1.1 400"));
        assert!(get(port, "/other?code=evil&state=expected-state").starts_with("HTTP/1.1 404"));
        let mut post = TcpStream::connect((Ipv4Addr::LOCALHOST, port)).unwrap();
        write!(
            post,
            "POST /?code=evil&state=expected-state HTTP/1.1\r\n\r\n"
        )
        .unwrap();
        drop(post);
        assert!(get(port, "/?code=real&state=expected-state").starts_with("HTTP/1.1 200"));
        assert_eq!(handle.join().unwrap(), Ok("real".to_string()));
    }

    #[test]
    fn a_denied_consent_ends_the_wait() {
        let (port, _cancel, handle) = serve("expected-state");
        let response = get(port, "/?error=access_denied&state=expected-state");
        assert!(response.contains("Nothing was connected"));
        assert_eq!(handle.join().unwrap(), Err(ConnectError::Denied));
    }

    #[test]
    fn cancelling_ends_the_wait() {
        let (_port, cancel, handle) = serve("expected-state");
        cancel.cancel();
        assert_eq!(handle.join().unwrap(), Err(ConnectError::Cancelled));
    }

    #[test]
    fn an_oversized_request_line_is_dropped() {
        let (port, _cancel, handle) = serve("expected-state");
        let mut stream = TcpStream::connect((Ipv4Addr::LOCALHOST, port)).unwrap();
        let _ = stream.write_all(&vec![b'a'; REQUEST_LIMIT + 4096]);
        drop(stream);
        assert!(get(port, "/?code=ok&state=expected-state").starts_with("HTTP/1.1 200"));
        assert_eq!(handle.join().unwrap(), Ok("ok".to_string()));
    }

    /// The refresh tokens are owner-only from the first byte: the temp file
    /// is created 0600 (not chmodded after the rename), and the folder that
    /// holds it is 0700 even when an older build made it 0755.
    #[cfg(unix)]
    #[test]
    fn the_token_file_is_never_readable_by_others_while_it_is_written() {
        use std::os::unix::fs::PermissionsExt;
        let root = tempfile::tempdir().unwrap();
        let dir = root.path().join("meetings");
        fs::create_dir_all(&dir).unwrap();
        fs::set_permissions(&dir, fs::Permissions::from_mode(0o755)).unwrap();
        let (seen, watch) = persist::private_watch();
        persist::watch_temp_files(Some(watch));
        let stored = store_refresh_token(&dir, "account-1", "refresh-a");
        persist::watch_temp_files(None);
        stored.unwrap();
        assert_eq!(
            *seen.borrow(),
            vec![(0o600, 0)],
            "temp file mode and size when created"
        );
        assert_eq!(persist::mode(&accounts_path(&dir)), 0o600);
        assert_eq!(persist::mode(&dir), 0o700);
        assert_eq!(
            refresh_token(&dir, "account-1").as_deref(),
            Some("refresh-a")
        );
    }

    #[test]
    fn tokens_are_stored_privately_and_forgotten() {
        let dir = tempfile::tempdir().unwrap();
        store_refresh_token(dir.path(), "account-1", "refresh-a").unwrap();
        store_refresh_token(dir.path(), "account-2", "refresh-b").unwrap();
        assert_eq!(
            refresh_token(dir.path(), "account-1").as_deref(),
            Some("refresh-a")
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(accounts_path(dir.path()))
                .unwrap()
                .permissions()
                .mode();
            assert_eq!(mode & 0o777, 0o600);
        }
        forget(dir.path(), "account-1");
        assert_eq!(refresh_token(dir.path(), "account-1"), None);
        assert_eq!(
            refresh_token(dir.path(), "account-2").as_deref(),
            Some("refresh-b")
        );
    }

    #[test]
    fn an_unconfigured_provider_cannot_start() {
        if !configured(Provider::Microsoft) {
            assert!(matches!(
                Pending::new(Provider::Microsoft),
                Err(ConnectError::NotConfigured)
            ));
        }
    }
}
