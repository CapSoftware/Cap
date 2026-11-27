use std::{
    collections::HashMap,
    future::Future,
    io::Read,
    net::{Ipv4Addr, TcpListener},
    path::{Path, PathBuf},
    sync::{LazyLock, Mutex, MutexGuard},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use cap_calendar::oauth::{self, AuthError, OAuthClient, Pkce};
use cap_gdrive::{
    DEFAULT_FOLDER_NAME, DRIVE_FILE_SCOPE, DriveError, Endpoints, StaticToken, TokenSource, api,
};
use gpui::{App, Global, Task};
use serde_json::Value;

use crate::i18n::tr;
use crate::meetings::accounts::{self, Cancel, ConnectError, LoopbackPages, Provider, SendError};
use crate::meetings::persist;

pub(crate) const DIR: &str = "google-drive";
pub(crate) const FILE: &str = "account.json";

const VERSION: u32 = 1;
const CLIENT_FILE_LIMIT: u64 = 64 * 1024;
const TOKEN_MARGIN: Duration = Duration::from_secs(90);
const DEFAULT_TOKEN_LIFETIME: u64 = 600;
const API_BASE_VAR: &str = "CAP_GDRIVE_API_BASE";
const REDACTED: &str = "<redacted>";

const DRIVE_PAGES: LoopbackPages = LoopbackPages {
    connected: crate::local_page::drive_connected,
    not_connected: crate::local_page::drive_not_connected,
    flow: "drive",
};

static ACCESS: LazyLock<Mutex<HashMap<PathBuf, (String, Instant)>>> =
    LazyLock::new(Default::default);
static STATUS: LazyLock<Mutex<HashMap<PathBuf, DriveStatus>>> = LazyLock::new(Default::default);

pub(crate) fn default_dir() -> PathBuf {
    crate::store::app_data_dir().join(DIR)
}

pub(crate) fn file_path(dir: &Path) -> PathBuf {
    dir.join(FILE)
}

#[derive(Clone, Debug, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub(crate) struct AccountFile {
    pub version: u32,
    pub client: Option<StoredClient>,
    pub account: Option<StoredAccount>,
    pub folder: StoredFolder,
}

#[derive(Clone, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub(crate) struct StoredClient {
    pub client_id: String,
    pub client_secret: Option<String>,
}

impl std::fmt::Debug for StoredClient {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("StoredClient")
            .field("client_id", &self.client_id)
            .field(
                "client_secret",
                &self.client_secret.as_ref().map(|_| REDACTED),
            )
            .finish()
    }
}

#[derive(Clone, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub(crate) struct StoredAccount {
    pub email: Option<String>,
    pub refresh_token: String,
    pub scope: String,
    pub connected_at_ms: i64,
}

impl std::fmt::Debug for StoredAccount {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("StoredAccount")
            .field("email", &self.email)
            .field("refresh_token", &REDACTED)
            .field("scope", &self.scope)
            .field("connected_at_ms", &self.connected_at_ms)
            .finish()
    }
}

#[derive(Debug, PartialEq, Eq)]
pub(super) enum RefreshFailure {
    Error(DriveError),
    Superseded(DriveError),
}

#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub(crate) struct StoredFolder {
    pub name: String,
    pub id: Option<String>,
}

impl Default for StoredFolder {
    fn default() -> Self {
        Self {
            name: DEFAULT_FOLDER_NAME.into(),
            id: None,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum DriveStatus {
    NotConfigured,
    Disconnected,
    Connected { email: Option<String> },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ClientFileError {
    Unreadable,
    NotJson,
    NotDesktopClient,
    MissingField,
}

fn file_lock() -> MutexGuard<'static, ()> {
    static LOCK: Mutex<()> = Mutex::new(());
    LOCK.lock().unwrap_or_else(|e| e.into_inner())
}

fn access() -> MutexGuard<'static, HashMap<PathBuf, (String, Instant)>> {
    ACCESS.lock().unwrap_or_else(|e| e.into_inner())
}

fn statuses() -> MutexGuard<'static, HashMap<PathBuf, DriveStatus>> {
    STATUS.lock().unwrap_or_else(|e| e.into_inner())
}

pub(crate) fn load(dir: &Path) -> AccountFile {
    let path = file_path(dir);
    tighten(&path);
    persist::read_store(&path).unwrap_or_default()
}

#[cfg(unix)]
fn tighten(path: &Path) {
    use std::os::unix::fs::PermissionsExt;
    let Ok(meta) = std::fs::symlink_metadata(path) else {
        return;
    };
    if meta.is_file()
        && meta.permissions().mode() & 0o077 != 0
        && let Err(error) = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
    {
        tracing::warn!(%error, "could not make the Google Drive account file private");
    }
}

#[cfg(not(unix))]
fn tighten(_path: &Path) {}

fn update_locked(dir: &Path, change: impl FnOnce(&mut AccountFile)) -> std::io::Result<()> {
    let path = file_path(dir);
    let mut file = load(dir);
    change(&mut file);
    file.version = VERSION;
    let result = serde_json::to_vec_pretty(&file)
        .map_err(std::io::Error::from)
        .and_then(|bytes| persist::atomic_write_private(&path, &bytes));
    statuses().remove(&path);
    result
}

fn update(dir: &Path, change: impl FnOnce(&mut AccountFile)) -> std::io::Result<()> {
    let _held = file_lock();
    update_locked(dir, change)
}

fn non_empty(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

pub(crate) fn pick_client(stored: Option<&StoredClient>) -> Option<OAuthClient> {
    let stored = stored?;
    let client_id = non_empty(Some(&stored.client_id))?;
    Some(OAuthClient::google(
        client_id,
        non_empty(stored.client_secret.as_deref()),
    ))
}

pub(crate) fn client(dir: &Path) -> Option<OAuthClient> {
    pick_client(load(dir).client.as_ref())
}

pub(crate) fn parse_client_file(bytes: &[u8]) -> Result<StoredClient, ClientFileError> {
    if bytes.len() as u64 > CLIENT_FILE_LIMIT {
        return Err(ClientFileError::Unreadable);
    }
    let value: Value = serde_json::from_slice(bytes).map_err(|_| ClientFileError::NotJson)?;
    let installed = value.get("installed");
    if installed.is_none() && value.get("web").is_some() {
        return Err(ClientFileError::NotDesktopClient);
    }
    let field = |name: &str| non_empty(installed.and_then(|i| i.get(name)).and_then(Value::as_str));
    let client_id = field("client_id").ok_or(ClientFileError::MissingField)?;
    Ok(StoredClient {
        client_id,
        client_secret: field("client_secret"),
    })
}

pub(crate) fn import_client_file(dir: &Path, file: &Path) -> Result<StoredClient, ClientFileError> {
    let mut bytes = Vec::new();
    std::fs::File::open(file)
        .and_then(|opened| opened.take(CLIENT_FILE_LIMIT + 1).read_to_end(&mut bytes))
        .map_err(|_| ClientFileError::Unreadable)?;
    let client = parse_client_file(&bytes)?;
    save_client(dir, &client.client_id, client.client_secret.as_deref()).map_err(|error| {
        tracing::warn!(%error, "could not save the Google Drive client");
        ClientFileError::Unreadable
    })?;
    Ok(client)
}

pub(crate) fn client_file_error_message(error: ClientFileError) -> String {
    match error {
        ClientFileError::Unreadable => {
            tr::settings::integrations::drive_direct::import_unreadable()
        }
        ClientFileError::NotJson => tr::settings::integrations::drive_direct::import_not_json(),
        ClientFileError::NotDesktopClient => {
            tr::settings::integrations::drive_direct::import_not_desktop()
        }
        ClientFileError::MissingField => {
            tr::settings::integrations::drive_direct::import_missing_field()
        }
    }
    .into()
}

pub(crate) fn save_client(
    dir: &Path,
    client_id: &str,
    client_secret: Option<&str>,
) -> std::io::Result<()> {
    let client_id = client_id.trim().to_string();
    let client_secret = non_empty(client_secret);
    let _held = file_lock();
    let mut forgot_account = false;
    let result = update_locked(dir, |file| {
        let same = file
            .client
            .as_ref()
            .is_some_and(|stored| stored.client_id.trim() == client_id);
        if !same {
            forgot_account = file.account.take().is_some();
        }
        file.client = (!client_id.is_empty()).then_some(StoredClient {
            client_id,
            client_secret,
        });
    });
    if forgot_account {
        forget_access(dir);
    }
    result
}

pub(crate) fn clear_client(dir: &Path) -> std::io::Result<()> {
    let _held = file_lock();
    let result = update_locked(dir, |file| {
        file.client = None;
        file.account = None;
    });
    forget_access(dir);
    result
}

pub(crate) fn save_folder(dir: &Path, folder: &StoredFolder) -> std::io::Result<()> {
    let folder = StoredFolder {
        name: non_empty(Some(&folder.name)).unwrap_or_else(|| DEFAULT_FOLDER_NAME.into()),
        id: non_empty(folder.id.as_deref()),
    };
    update(dir, |file| file.folder = folder)
}

pub(super) fn save_account(dir: &Path, account: &StoredAccount) -> std::io::Result<()> {
    let _held = file_lock();
    let result = update_locked(dir, |file| file.account = Some(account.clone()));
    forget_access(dir);
    result
}

fn status_of(file: &AccountFile) -> DriveStatus {
    if pick_client(file.client.as_ref()).is_none() {
        return DriveStatus::NotConfigured;
    }
    match &file.account {
        Some(account) if !account.refresh_token.is_empty() => DriveStatus::Connected {
            email: account.email.clone(),
        },
        _ => DriveStatus::Disconnected,
    }
}

pub(crate) fn status(dir: &Path) -> DriveStatus {
    let path = file_path(dir);
    if let Some(status) = statuses().get(&path) {
        return status.clone();
    }
    let _held = file_lock();
    let status = status_of(&load(dir));
    statuses().insert(path, status.clone());
    status
}

pub(super) fn revoke_allowed(drive_client_id: &str, calendar_client_id: Option<&str>) -> bool {
    calendar_client_id.is_none_or(|calendar| calendar.trim() != drive_client_id.trim())
}

pub(crate) fn shares_client_with_calendar(dir: &Path) -> bool {
    client(dir).is_some_and(|drive| {
        !revoke_allowed(
            &drive.client_id,
            accounts::client_id(Provider::Google).as_deref(),
        )
    })
}

pub(crate) fn endpoints() -> Endpoints {
    if cfg!(debug_assertions)
        && let Some(base) = non_empty(std::env::var(API_BASE_VAR).ok().as_deref())
    {
        return Endpoints::local(&base);
    }
    Endpoints::google()
}

pub(super) fn cache_deadline(now: Instant, expires_in: Option<u64>) -> Instant {
    now + Duration::from_secs(expires_in.unwrap_or(DEFAULT_TOKEN_LIFETIME))
        .saturating_sub(TOKEN_MARGIN)
}

pub(super) fn cache_access(dir: &Path, token: &str, expires_in: Option<u64>) {
    access().insert(
        file_path(dir),
        (
            token.to_string(),
            cache_deadline(Instant::now(), expires_in),
        ),
    );
}

pub(super) fn cached_access(dir: &Path) -> Option<String> {
    access()
        .get(&file_path(dir))
        .filter(|(_, until)| *until > Instant::now())
        .map(|(token, _)| token.clone())
}

fn forget_access(dir: &Path) {
    access().remove(&file_path(dir));
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| i64::try_from(elapsed.as_millis()).unwrap_or(i64::MAX))
        .unwrap_or(0)
}

fn connect_error(error: ConnectError) -> DriveError {
    match error {
        ConnectError::Cancelled => DriveError::Cancelled,
        ConnectError::Denied => DriveError::Denied,
        ConnectError::NotConfigured => DriveError::NotConfigured,
        ConnectError::Network => DriveError::Offline,
        ConnectError::Rejected => DriveError::Protocol("sign-in was rejected".into()),
    }
}

fn send_error(error: SendError) -> DriveError {
    match error {
        SendError::Network(_) => DriveError::Offline,
        SendError::TooLarge => DriveError::Protocol("oversized token response".into()),
    }
}

fn save_error(error: std::io::Error) -> DriveError {
    DriveError::Protocol(format!("could not save the Google Drive account: {error}"))
}

fn token_client() -> Result<reqwest::Client, DriveError> {
    accounts::http_client().map_err(|error| DriveError::Protocol(error.to_string()))
}

pub(crate) struct DriveConnect {
    pub authorize_url: String,
    pub cancel: Cancel,
    client: OAuthClient,
    listener: TcpListener,
    redirect_uri: String,
    state: String,
    verifier: String,
    endpoints: Endpoints,
    dir: PathBuf,
    code_received: Option<tokio::sync::oneshot::Sender<()>>,
}

impl DriveConnect {
    pub(crate) fn new(dir: PathBuf, endpoints: Endpoints) -> Result<Self, DriveError> {
        let client = client(&dir).ok_or(DriveError::NotConfigured)?;
        let listen_error = |error: std::io::Error| {
            DriveError::Protocol(format!("could not listen for the sign-in: {error}"))
        };
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).map_err(listen_error)?;
        listener.set_nonblocking(true).map_err(listen_error)?;
        let port = listener.local_addr().map_err(listen_error)?.port();
        let redirect_uri = format!("http://127.0.0.1:{port}");
        let random = |len| accounts::random(len).map_err(connect_error);
        let auth_error = |error: AuthError| DriveError::Protocol(error.to_string());
        let pkce = Pkce::from_random(&random(64)?).map_err(auth_error)?;
        let state = oauth::state_from_random(&random(24)?).map_err(auth_error)?;
        let url = oauth::authorize_url_with_scopes(
            &client,
            DRIVE_FILE_SCOPE,
            &redirect_uri,
            &state,
            &pkce.challenge,
            None,
        );
        let authorize_url = match url.strip_prefix(oauth::GOOGLE_AUTHORIZE_URL) {
            Some(query) => format!("{}{query}", endpoints.authorize),
            None => url,
        };
        Ok(Self {
            authorize_url,
            cancel: Cancel::default(),
            client,
            listener,
            redirect_uri,
            state,
            verifier: pkce.verifier,
            endpoints,
            dir,
            code_received: None,
        })
    }

    pub(crate) async fn finish(self) -> Result<DriveStatus, DriveError> {
        let Self {
            cancel,
            client,
            listener,
            redirect_uri,
            state,
            verifier,
            endpoints,
            dir,
            code_received,
            ..
        } = self;
        let code = tokio::task::spawn_blocking(move || {
            accounts::wait_for_code(&listener, &state, &cancel, &DRIVE_PAGES)
        })
        .await
        .map_err(|error| DriveError::Protocol(error.to_string()))?
        .map_err(connect_error)?;
        if let Some(code_received) = code_received {
            let _ = code_received.send(());
        }
        let http = token_client()?;
        let mut spec = oauth::token_request(&client, &code, &verifier, &redirect_uri);
        spec.url = endpoints.token.clone();
        let (_, body) = accounts::send(&http, &spec, None)
            .await
            .map_err(send_error)?;
        let tokens = oauth::parse_token_response(&body).map_err(|error| {
            tracing::warn!(%error, "Google Drive sign-in was rejected");
            match error {
                AuthError::AccessDenied => DriveError::Denied,
                other => DriveError::Protocol(other.to_string()),
            }
        })?;
        if !oauth::grants_scope(client.provider, tokens.scope.as_deref(), DRIVE_FILE_SCOPE) {
            tracing::warn!("Google Drive sign-in did not grant drive.file");
            return Err(DriveError::Denied);
        }
        let Some(refresh_token) = tokens.refresh_token.clone() else {
            return Err(DriveError::Protocol(
                "Google returned no refresh token".into(),
            ));
        };
        save_account(
            &dir,
            &StoredAccount {
                email: tokens.id_token_email.clone(),
                refresh_token,
                scope: tokens
                    .scope
                    .clone()
                    .unwrap_or_else(|| DRIVE_FILE_SCOPE.into()),
                connected_at_ms: now_ms(),
            },
        )
        .map_err(save_error)?;
        cache_access(&dir, &tokens.access_token, tokens.expires_in);
        let drive = api::DriveHttp::new()?;
        match api::about(&drive, &endpoints, &tokens.access_token).await {
            Ok(user) => {
                if let Some(email) = user.email
                    && let Err(error) = update(&dir, |file| {
                        if let Some(account) = file.account.as_mut() {
                            account.email = Some(email);
                        }
                    })
                {
                    tracing::warn!(%error, "could not save the Google Drive account's email");
                }
            }
            Err(error) => tracing::warn!(%error, "could not read the Google Drive account's email"),
        }
        let folder = load(&dir).folder;
        let folder_id = api::ensure_folder(
            &drive,
            &endpoints,
            &StaticToken(tokens.access_token),
            &folder.name,
            folder.id.as_deref(),
        )
        .await?;
        save_folder(
            &dir,
            &StoredFolder {
                name: folder.name,
                id: Some(folder_id),
            },
        )
        .map_err(save_error)?;
        Ok(status(&dir))
    }
}

pub(crate) async fn disconnect(dir: &Path, endpoints: &Endpoints) -> Result<(), DriveError> {
    let calendar_client_id = accounts::client_id(Provider::Google);
    disconnect_with(dir, endpoints, calendar_client_id.as_deref()).await
}

pub(super) async fn disconnect_with(
    dir: &Path,
    endpoints: &Endpoints,
    calendar_client_id: Option<&str>,
) -> Result<(), DriveError> {
    let file = load(dir);
    if let Some(account) = file.account.as_ref()
        && let Some(drive) = pick_client(file.client.as_ref())
    {
        if revoke_allowed(&drive.client_id, calendar_client_id) {
            match api::DriveHttp::new() {
                Ok(http) => {
                    if let Err(error) = api::revoke(&http, endpoints, &account.refresh_token).await
                    {
                        tracing::warn!(%error, "could not revoke the Google Drive token");
                    }
                }
                Err(error) => tracing::warn!(%error, "could not revoke the Google Drive token"),
            }
        } else {
            tracing::info!(
                "Google Drive shares Calendar's client; forgetting its token without revoking it"
            );
        }
    }
    let _held = file_lock();
    let result = update_locked(dir, |file| {
        file.account = None;
        file.folder.id = None;
    });
    forget_access(dir);
    result.map_err(save_error)
}

pub(crate) struct AccountTokens {
    dir: PathBuf,
    endpoints: Endpoints,
    http: reqwest::Client,
    client: OAuthClient,
}

impl AccountTokens {
    pub(crate) fn new(dir: PathBuf, endpoints: Endpoints) -> Result<Self, DriveError> {
        let client = client(&dir).ok_or(DriveError::NotConfigured)?;
        Ok(Self {
            dir,
            endpoints,
            http: token_client()?,
            client,
        })
    }

    async fn fetch(&self, force_refresh: bool) -> Result<String, DriveError> {
        if !force_refresh && let Some(token) = cached_access(&self.dir) {
            return Ok(token);
        }
        let refresh = saved_refresh(&self.dir).ok_or(DriveError::NotConnected)?;
        self.refresh_with(&refresh).await
    }

    pub(super) async fn refresh_with(&self, refresh: &str) -> Result<String, DriveError> {
        match self.refresh_once(refresh).await {
            Ok(token) => Ok(token),
            Err(RefreshFailure::Error(error)) => Err(error),
            Err(RefreshFailure::Superseded(_)) => {
                let newer = saved_refresh(&self.dir).ok_or(DriveError::NotConnected)?;
                self.refresh_once(&newer)
                    .await
                    .map_err(|failure| match failure {
                        RefreshFailure::Error(error) | RefreshFailure::Superseded(error) => error,
                    })
            }
        }
    }

    async fn refresh_once(&self, refresh: &str) -> Result<String, RefreshFailure> {
        let mut spec = oauth::refresh_request(&self.client, refresh);
        spec.url = self.endpoints.token.clone();
        let (status, body) = accounts::send(&self.http, &spec, None)
            .await
            .map_err(|error| RefreshFailure::Error(send_error(error)))?;
        match oauth::parse_token_response(&body) {
            Ok(tokens) if keep_refreshed(&self.dir, refresh, &tokens) => Ok(tokens.access_token),
            Ok(_) => Err(RefreshFailure::Error(DriveError::NotConnected)),
            Err(error) => Err(refresh_failed(&self.dir, refresh, status, error)),
        }
    }
}

fn saved_refresh(dir: &Path) -> Option<String> {
    load(dir)
        .account
        .map(|account| account.refresh_token)
        .filter(|token| !token.is_empty())
}

impl TokenSource for AccountTokens {
    fn access_token(
        &self,
        force_refresh: bool,
    ) -> impl Future<Output = Result<String, DriveError>> + Send {
        self.fetch(force_refresh)
    }
}

pub(super) fn refresh_failed(
    dir: &Path,
    refresh: &str,
    status: u16,
    error: AuthError,
) -> RefreshFailure {
    let code = match &error {
        AuthError::AccessDenied => "access_denied",
        AuthError::Provider { error, .. } => error.as_str(),
        _ => "",
    };
    let mapped = match code {
        "invalid_grant" | "interaction_required" | "access_denied" => DriveError::SignInAgain,
        "deleted_client" | "invalid_client" => DriveError::NotConfigured,
        "admin_policy_enforced" => return RefreshFailure::Error(DriveError::AdminBlocked),
        _ if (200..300).contains(&status) => {
            return RefreshFailure::Error(DriveError::Protocol(error.to_string()));
        }
        _ => {
            return RefreshFailure::Error(DriveError::Server {
                status,
                reason: error.to_string(),
            });
        }
    };
    let _held = file_lock();
    match load(dir).account {
        Some(saved) if saved.refresh_token == refresh => {
            tracing::warn!(code, "Google Drive refresh failed; forgetting the account");
            if let Err(error) = update_locked(dir, |file| file.account = None) {
                tracing::warn!(%error, "could not clear the Google Drive account");
            }
            forget_access(dir);
            RefreshFailure::Error(mapped)
        }
        Some(saved) if !saved.refresh_token.is_empty() => RefreshFailure::Superseded(mapped),
        _ => RefreshFailure::Error(DriveError::NotConnected),
    }
}

fn keep_refreshed(dir: &Path, refresh: &str, tokens: &oauth::Tokens) -> bool {
    let _held = file_lock();
    let Some(stored) = load(dir).account else {
        return false;
    };
    if stored.refresh_token != refresh {
        return true;
    }
    if let Some(rotated) = tokens.refresh_token.as_deref().filter(|t| *t != refresh)
        && let Err(error) = update_locked(dir, |file| {
            if let Some(account) = file.account.as_mut() {
                account.refresh_token = rotated.to_string();
            }
        })
    {
        tracing::warn!(%error, "could not save the rotated Google Drive token");
    }
    cache_access(dir, &tokens.access_token, tokens.expires_in);
    true
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) enum ConnectState {
    #[default]
    Idle,
    WaitingForBrowser,
    Finishing,
    Failed(DriveError),
}

#[derive(Default)]
struct DriveAuth {
    state: ConnectState,
    cancel: Option<Cancel>,
    task: Option<Task<()>>,
    attempt: u64,
}

impl Global for DriveAuth {}

fn set_state(cx: &mut App, attempt: Option<u64>, state: ConnectState) {
    let auth = cx.default_global::<DriveAuth>();
    if attempt.is_some_and(|attempt| attempt != auth.attempt) {
        return;
    }
    auth.state = state;
    cx.refresh_windows();
}

pub(crate) fn connect(cx: &mut App) {
    if matches!(
        connect_state(cx),
        ConnectState::WaitingForBrowser | ConnectState::Finishing
    ) {
        return;
    }
    let mut pending = match DriveConnect::new(default_dir(), endpoints()) {
        Ok(pending) => pending,
        Err(error) => {
            set_state(cx, None, ConnectState::Failed(error));
            return;
        }
    };
    let (code_received, code_arrived) = tokio::sync::oneshot::channel();
    pending.code_received = Some(code_received);
    cx.open_url(&pending.authorize_url);
    let auth = cx.default_global::<DriveAuth>();
    auth.attempt += 1;
    let attempt = auth.attempt;
    auth.cancel = Some(pending.cancel.clone());
    auth.state = ConnectState::WaitingForBrowser;
    let task = cx.spawn(async move |cx| {
        let finish = gpui_tokio::Tokio::spawn(cx, pending.finish());
        if code_arrived.await.is_ok() {
            cx.update(|cx| set_state(cx, Some(attempt), ConnectState::Finishing));
        }
        let state = match finish.await {
            Ok(Ok(_)) | Ok(Err(DriveError::Cancelled)) => ConnectState::Idle,
            Ok(Err(error)) => ConnectState::Failed(error),
            Err(error) => ConnectState::Failed(DriveError::Protocol(error.to_string())),
        };
        cx.update(|cx| {
            let auth = cx.default_global::<DriveAuth>();
            if auth.attempt != attempt {
                return;
            }
            auth.cancel = None;
            auth.task = None;
            auth.state = state;
            cx.refresh_windows();
        });
    });
    cx.default_global::<DriveAuth>().task = Some(task);
    cx.refresh_windows();
}

pub(crate) fn cancel_connect(cx: &mut App) {
    let auth = cx.default_global::<DriveAuth>();
    if let Some(cancel) = auth.cancel.take() {
        cancel.cancel();
    }
    auth.task = None;
    auth.attempt += 1;
    if auth.state != ConnectState::Idle {
        auth.state = ConnectState::Idle;
        cx.refresh_windows();
    }
}

pub(crate) fn connect_state(cx: &App) -> ConnectState {
    cx.try_global::<DriveAuth>()
        .map(|auth| auth.state.clone())
        .unwrap_or_default()
}

pub(crate) fn disconnect_in_background(cx: &mut App) {
    cancel_connect(cx);
    let dir = default_dir();
    let endpoints = endpoints();
    let work = gpui_tokio::Tokio::spawn(cx, async move { disconnect(&dir, &endpoints).await });
    cx.spawn(async move |cx| {
        let state = match work.await {
            Ok(Ok(())) => ConnectState::Idle,
            Ok(Err(error)) => ConnectState::Failed(error),
            Err(error) => ConnectState::Failed(DriveError::Protocol(error.to_string())),
        };
        cx.update(|cx| set_state(cx, None, state));
    })
    .detach();
}
