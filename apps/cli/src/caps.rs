use std::{
    collections::HashMap,
    io::{IsTerminal, Read},
    path::{Path, PathBuf},
    sync::{Arc, RwLock},
    time::{Duration, Instant},
};

use clap::{ArgGroup, Args, Subcommand, ValueEnum};
use futures::StreamExt;
use reqwest::{Method, Response, StatusCode};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use tokio::io::AsyncWriteExt;
use url::Url;

use crate::{OutputFormat, atomic, confirmation, credentials, resolve_format, write_json};

#[derive(Args)]
pub struct CapsArgs {
    #[command(subcommand)]
    command: CapsCommands,
}

#[derive(Subcommand)]
enum CapsCommands {
    List(ListArgs),
    Get(TargetArgs),
    Context(TargetArgs),
    Status(TargetArgs),
    Wait(WaitArgs),
    Process(ProcessArgs),
    Import(ImportArgs),
    Transcript(TranscriptArgs),
    TranscriptReplace(TranscriptReplaceArgs),
    Download(DownloadArgs),
    Duplicate(CapOperationArgs),
    Delete(CapOperationArgs),
    Password(PasswordArgs),
    Unlock(UnlockArgs),
    Comments(CommentsArgs),
    Reactions(ReactionsArgs),
    Update(UpdateArgs),
    Sharing(SharingArgs),
    Settings(SettingsArgs),
    Date(DateArgs),
    Move(MoveArgs),
    Shares(SharesArgs),
}

#[derive(Clone, Copy, ValueEnum)]
enum CapsScope {
    All,
    Owned,
    Shared,
}

impl CapsScope {
    const fn as_str(self) -> &'static str {
        match self {
            Self::All => "all",
            Self::Owned => "owned",
            Self::Shared => "shared",
        }
    }
}

#[derive(Args)]
struct ListArgs {
    #[arg(long, value_enum, default_value_t = CapsScope::All)]
    scope: CapsScope,
    #[arg(long)]
    organization: Option<String>,
    #[arg(long)]
    folder: Option<String>,
    #[arg(long)]
    search: Option<String>,
    #[arg(long)]
    updated_after: Option<String>,
    #[arg(long)]
    cursor: Option<String>,
    #[arg(long, default_value_t = 50, value_parser = clap::value_parser!(u16).range(1..=100))]
    limit: u16,
    #[arg(long, value_enum, default_value_t = OutputFormat::Text)]
    format: OutputFormat,
}

#[derive(Args)]
struct TargetArgs {
    cap: String,
    #[arg(long, value_enum, default_value_t = OutputFormat::Text)]
    format: OutputFormat,
}

#[derive(Clone, Copy, ValueEnum)]
enum WaitFor {
    Transcript,
    Ai,
    All,
}

#[derive(Clone, Copy, ValueEnum)]
enum ProcessTarget {
    Transcript,
    Ai,
    All,
}

impl ProcessTarget {
    const fn as_str(self) -> &'static str {
        match self {
            Self::Transcript => "transcript",
            Self::Ai => "ai",
            Self::All => "all",
        }
    }
}

#[derive(Args)]
struct ProcessArgs {
    cap: String,
    #[arg(long, value_enum, default_value_t = ProcessTarget::All)]
    target: ProcessTarget,
    #[arg(long)]
    retry: bool,
    #[arg(long)]
    yes: bool,
    #[arg(long, value_enum, default_value_t = OutputFormat::Text)]
    format: OutputFormat,
}

#[derive(Args)]
struct ImportArgs {
    #[command(subcommand)]
    command: ImportCommands,
}

#[derive(Subcommand)]
enum ImportCommands {
    Loom(LoomImportArgs),
}

#[derive(Args)]
struct LoomImportArgs {
    loom_url: String,
    #[arg(long)]
    organization: String,
    #[arg(long)]
    owner_email: Option<String>,
    #[arg(long)]
    space: Option<String>,
    #[arg(long)]
    wait: bool,
    #[arg(long, default_value_t = 600)]
    timeout: u64,
    #[arg(long)]
    yes: bool,
    #[arg(long, value_enum, default_value_t = OutputFormat::Text)]
    format: OutputFormat,
}

#[derive(Args)]
struct WaitArgs {
    cap: String,
    #[arg(long, value_enum, default_value_t = WaitFor::All)]
    r#for: WaitFor,
    #[arg(long, default_value_t = 600)]
    timeout: u64,
    #[arg(long, value_enum, default_value_t = OutputFormat::Text)]
    format: OutputFormat,
}

#[derive(Clone, Copy, ValueEnum)]
enum TranscriptFormat {
    Text,
    Json,
    Vtt,
}

impl TranscriptFormat {
    const fn as_str(self) -> &'static str {
        match self {
            Self::Text => "text",
            Self::Json => "json",
            Self::Vtt => "vtt",
        }
    }
}

#[derive(Args)]
struct TranscriptArgs {
    cap: String,
    #[arg(long, value_enum, default_value_t = TranscriptFormat::Text)]
    format: TranscriptFormat,
    #[arg(long)]
    output: PathBuf,
}

#[derive(Args)]
struct TranscriptReplaceArgs {
    cap: String,
    #[arg(long)]
    input: PathBuf,
    #[arg(long)]
    expected_revision: Option<String>,
    #[arg(long)]
    yes: bool,
    #[arg(long, value_enum, default_value_t = OutputFormat::Text)]
    format: OutputFormat,
}

#[derive(Args)]
struct DownloadArgs {
    cap: String,
    #[arg(long)]
    output: PathBuf,
}

#[derive(Args)]
struct CapOperationArgs {
    cap: String,
    #[arg(long)]
    wait: bool,
    #[arg(long, default_value_t = 600)]
    timeout: u64,
    #[arg(long)]
    yes: bool,
    #[arg(long, value_enum, default_value_t = OutputFormat::Text)]
    format: OutputFormat,
}

#[derive(Args)]
struct PasswordArgs {
    #[command(subcommand)]
    command: PasswordCommands,
}

#[derive(Subcommand)]
enum PasswordCommands {
    Set(PasswordSetArgs),
    Clear(PasswordClearArgs),
}

#[derive(Args)]
struct PasswordSetArgs {
    cap: String,
    #[arg(long)]
    password_stdin: bool,
    #[arg(long)]
    yes: bool,
    #[arg(long, value_enum, default_value_t = OutputFormat::Text)]
    format: OutputFormat,
}

#[derive(Args)]
struct PasswordClearArgs {
    cap: String,
    #[arg(long)]
    yes: bool,
    #[arg(long, value_enum, default_value_t = OutputFormat::Text)]
    format: OutputFormat,
}

#[derive(Args)]
struct UnlockArgs {
    cap: String,
    #[arg(long)]
    password_stdin: bool,
    #[arg(
        long,
        help = "Allow a permission-restricted file fallback on macOS or Linux when the OS credential store is unavailable"
    )]
    allow_file_credential: bool,
    #[arg(long, value_enum, default_value_t = OutputFormat::Text)]
    format: OutputFormat,
}

#[derive(Args)]
struct CommentsArgs {
    #[command(subcommand)]
    command: CommentsCommands,
}

#[derive(Subcommand)]
enum CommentsCommands {
    Add(CommentAddArgs),
    Reply(CommentReplyArgs),
    Delete(CommentDeleteArgs),
}

#[derive(Args)]
struct CommentAddArgs {
    cap: String,
    content: String,
    #[arg(long)]
    timestamp_ms: Option<u64>,
    #[arg(long)]
    yes: bool,
    #[arg(long, value_enum, default_value_t = OutputFormat::Text)]
    format: OutputFormat,
}

#[derive(Args)]
struct CommentReplyArgs {
    cap: String,
    comment_id: String,
    content: String,
    #[arg(long)]
    timestamp_ms: Option<u64>,
    #[arg(long)]
    yes: bool,
    #[arg(long, value_enum, default_value_t = OutputFormat::Text)]
    format: OutputFormat,
}

#[derive(Args)]
struct CommentDeleteArgs {
    cap: String,
    comment_id: String,
    #[arg(long)]
    yes: bool,
    #[arg(long, value_enum, default_value_t = OutputFormat::Text)]
    format: OutputFormat,
}

#[derive(Args)]
struct ReactionsArgs {
    #[command(subcommand)]
    command: ReactionsCommands,
}

#[derive(Subcommand)]
enum ReactionsCommands {
    Add(ReactionAddArgs),
}

#[derive(Args)]
struct ReactionAddArgs {
    cap: String,
    reaction: String,
    #[arg(long)]
    timestamp_ms: Option<u64>,
    #[arg(long)]
    yes: bool,
    #[arg(long, value_enum, default_value_t = OutputFormat::Text)]
    format: OutputFormat,
}

#[derive(Args)]
struct UpdateArgs {
    cap: String,
    #[arg(long)]
    title: String,
    #[arg(long)]
    yes: bool,
    #[arg(long, value_enum, default_value_t = OutputFormat::Text)]
    format: OutputFormat,
}

#[derive(Args)]
struct SharingArgs {
    #[command(subcommand)]
    command: SharingCommands,
}

#[derive(Subcommand)]
enum SharingCommands {
    Set(SharingSetArgs),
}

#[derive(Args)]
#[command(group(ArgGroup::new("visibility").required(true).args(["public", "private"])))]
struct SharingSetArgs {
    cap: String,
    #[arg(long)]
    public: bool,
    #[arg(long)]
    private: bool,
    #[arg(long)]
    yes: bool,
    #[arg(long, value_enum, default_value_t = OutputFormat::Text)]
    format: OutputFormat,
}

#[derive(Args)]
struct SettingsArgs {
    #[command(subcommand)]
    command: SettingsCommands,
}

#[derive(Subcommand)]
enum SettingsCommands {
    Get(TargetArgs),
    Set(SettingsSetArgs),
}

#[derive(Args)]
struct SettingsSetArgs {
    cap: String,
    #[arg(long)]
    disable_summary: Option<bool>,
    #[arg(long)]
    disable_captions: Option<bool>,
    #[arg(long)]
    disable_chapters: Option<bool>,
    #[arg(long)]
    disable_reactions: Option<bool>,
    #[arg(long)]
    disable_transcript: Option<bool>,
    #[arg(long)]
    disable_comments: Option<bool>,
    #[arg(long)]
    default_playback_speed: Option<f64>,
    #[arg(long)]
    yes: bool,
    #[arg(long, value_enum, default_value_t = OutputFormat::Text)]
    format: OutputFormat,
}

#[derive(Args)]
struct DateArgs {
    #[command(subcommand)]
    command: DateCommands,
}

#[derive(Subcommand)]
enum DateCommands {
    Set(DateSetArgs),
}

#[derive(Args)]
struct DateSetArgs {
    cap: String,
    created_at: String,
    #[arg(long)]
    yes: bool,
    #[arg(long, value_enum, default_value_t = OutputFormat::Text)]
    format: OutputFormat,
}

#[derive(Clone, Copy, ValueEnum)]
enum CapContainer {
    Personal,
    Organization,
    Space,
}

impl CapContainer {
    const fn as_str(self) -> &'static str {
        match self {
            Self::Personal => "personal",
            Self::Organization => "organization",
            Self::Space => "space",
        }
    }
}

#[derive(Args)]
struct MoveArgs {
    cap: String,
    #[arg(long, value_enum)]
    container: CapContainer,
    #[arg(long)]
    organization: String,
    #[arg(long)]
    space: Option<String>,
    #[arg(long)]
    folder: Option<String>,
    #[arg(long)]
    root: bool,
    #[arg(long)]
    yes: bool,
    #[arg(long, value_enum, default_value_t = OutputFormat::Text)]
    format: OutputFormat,
}

#[derive(Args)]
struct SharesArgs {
    #[command(subcommand)]
    command: ShareCommands,
}

#[derive(Subcommand)]
enum ShareCommands {
    List(TargetArgs),
    Organization(OrganizationSharesArgs),
    Space(SpaceSharesArgs),
}

#[derive(Args)]
struct OrganizationSharesArgs {
    #[command(subcommand)]
    command: OrganizationShareCommands,
}

#[derive(Subcommand)]
enum OrganizationShareCommands {
    Add(OrganizationShareArgs),
    Remove(OrganizationShareRemoveArgs),
}

#[derive(Args)]
struct OrganizationShareArgs {
    cap: String,
    organization: String,
    #[arg(long)]
    folder: Option<String>,
    #[arg(long)]
    yes: bool,
    #[arg(long, value_enum, default_value_t = OutputFormat::Text)]
    format: OutputFormat,
}

#[derive(Args)]
struct OrganizationShareRemoveArgs {
    cap: String,
    organization: String,
    #[arg(long)]
    yes: bool,
    #[arg(long, value_enum, default_value_t = OutputFormat::Text)]
    format: OutputFormat,
}

#[derive(Args)]
struct SpaceSharesArgs {
    #[command(subcommand)]
    command: SpaceShareCommands,
}

#[derive(Subcommand)]
enum SpaceShareCommands {
    Add(SpaceShareArgs),
    Remove(SpaceShareRemoveArgs),
}

#[derive(Args)]
struct SpaceShareArgs {
    cap: String,
    space: String,
    #[arg(long)]
    folder: Option<String>,
    #[arg(long)]
    yes: bool,
    #[arg(long, value_enum, default_value_t = OutputFormat::Text)]
    format: OutputFormat,
}

#[derive(Args)]
struct SpaceShareRemoveArgs {
    cap: String,
    space: String,
    #[arg(long)]
    yes: bool,
    #[arg(long, value_enum, default_value_t = OutputFormat::Text)]
    format: OutputFormat,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentApiError {
    pub code: String,
    pub message: String,
    pub retryable: bool,
    pub retry_after_ms: Option<u64>,
    pub request_id: Option<String>,
}

impl std::fmt::Display for AgentApiError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for AgentApiError {}

impl AgentApiError {
    fn local(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.to_string(),
            message: message.into(),
            retryable: false,
            retry_after_ms: None,
            request_id: None,
        }
    }
}

#[derive(Clone)]
pub struct AgentClient {
    http: reqwest::Client,
    access_token: String,
    server: String,
    access_grants: Arc<RwLock<HashMap<String, credentials::AgentAccessGrant>>>,
    access_grant_checks: Arc<RwLock<HashMap<String, Instant>>>,
    reload_access_grants: bool,
}

#[derive(Clone, Copy)]
enum AgentRequestBody<'a> {
    Json(&'a Value),
    Text(&'a str),
}

impl AgentClient {
    pub fn from_credentials() -> Result<Self, AgentApiError> {
        let credential = credentials::resolve_agent()
            .map_err(|message| AgentApiError::local("AUTH_REQUIRED", message))?;
        let mut client = Self::new(credential.server, credential.access_token)?;
        client.reload_access_grants = true;
        Ok(client)
    }

    pub fn new(server: String, access_token: String) -> Result<Self, AgentApiError> {
        let parsed = Url::parse(&server)
            .map_err(|_| AgentApiError::local("INVALID_REQUEST", "Invalid Cap server URL"))?;
        if parsed.scheme() != "http" && parsed.scheme() != "https" {
            return Err(AgentApiError::local(
                "INVALID_REQUEST",
                "Cap server URL must use HTTP or HTTPS",
            ));
        }
        let http = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(10))
            .read_timeout(Duration::from_secs(60))
            .user_agent(concat!("cap-cli/", env!("CARGO_PKG_VERSION")))
            .build()
            .map_err(|error| AgentApiError::local("TEMPORARY_UNAVAILABLE", error.to_string()))?;
        Ok(Self {
            http,
            access_token,
            server: server.trim_end_matches('/').to_string(),
            access_grants: Arc::new(RwLock::new(HashMap::new())),
            access_grant_checks: Arc::new(RwLock::new(HashMap::new())),
            reload_access_grants: false,
        })
    }

    fn endpoint(&self, path: &str) -> String {
        format!("{}/api/v1{path}", self.server)
    }

    async fn parse_error(response: Response) -> AgentApiError {
        let status = response.status();
        let body = response.bytes().await.unwrap_or_default();
        serde_json::from_slice::<AgentApiError>(&body).unwrap_or_else(|_| {
            AgentApiError::local(
                if status == StatusCode::UNAUTHORIZED {
                    "AUTH_REQUIRED"
                } else if status == StatusCode::TOO_MANY_REQUESTS {
                    "RATE_LIMITED"
                } else {
                    "TEMPORARY_UNAVAILABLE"
                },
                format!("Cap returned HTTP {status}"),
            )
        })
    }

    async fn request(
        &self,
        method: Method,
        path: &str,
        body: Option<AgentRequestBody<'_>>,
        idempotency_key: Option<&str>,
        user_confirmed: bool,
    ) -> Result<Response, AgentApiError> {
        let mut attempt = 0_u32;
        loop {
            let mut request = self
                .http
                .request(method.clone(), self.endpoint(path))
                .bearer_auth(&self.access_token);
            match body {
                Some(AgentRequestBody::Json(body)) => request = request.json(body),
                Some(AgentRequestBody::Text(body)) => {
                    request = request
                        .header("Content-Type", "text/plain; charset=utf-8")
                        .body(body.to_string());
                }
                None => {}
            }
            if let Some(grant) = self.access_grant_for_path(path) {
                request = request.header("X-Cap-Access-Grant", grant);
            }
            if let Some(key) = idempotency_key {
                request = request.header("Idempotency-Key", key);
            }
            if user_confirmed {
                request = request.header("X-Cap-Confirmation", "user");
            }
            let response = match request.send().await {
                Ok(response) => response,
                Err(error) => {
                    let error = AgentApiError {
                        code: "TEMPORARY_UNAVAILABLE".to_string(),
                        message: error.to_string(),
                        retryable: true,
                        retry_after_ms: Some(500),
                        request_id: None,
                    };
                    if attempt >= 2 {
                        return Err(error);
                    }
                    tokio::time::sleep(Duration::from_millis(error.retry_after_ms.unwrap_or(500)))
                        .await;
                    attempt += 1;
                    continue;
                }
            };
            if response.status().is_success() {
                return Ok(response);
            }
            let status = response.status();
            let error = Self::parse_error(response).await;
            let retryable = error.retryable
                || status == StatusCode::TOO_MANY_REQUESTS
                || status.is_server_error();
            if !retryable || attempt >= 2 {
                return Err(error);
            }
            let delay = error
                .retry_after_ms
                .unwrap_or(200_u64.saturating_mul(1_u64 << attempt))
                .min(5_000);
            tokio::time::sleep(Duration::from_millis(delay)).await;
            attempt += 1;
        }
    }

    pub async fn get_json(&self, path: &str) -> Result<Value, AgentApiError> {
        self.request(Method::GET, path, None, None, false)
            .await?
            .json()
            .await
            .map_err(|error| AgentApiError::local("TEMPORARY_UNAVAILABLE", error.to_string()))
    }

    pub async fn mutate_json(
        &self,
        method: Method,
        path: &str,
        body: &Value,
    ) -> Result<Value, AgentApiError> {
        let idempotency_key = uuid::Uuid::new_v4().to_string();
        self.request(
            method,
            path,
            Some(AgentRequestBody::Json(body)),
            Some(&idempotency_key),
            false,
        )
        .await?
        .json()
        .await
        .map_err(|error| AgentApiError::local("TEMPORARY_UNAVAILABLE", error.to_string()))
    }

    pub async fn mutate_json_confirmed(
        &self,
        method: Method,
        path: &str,
        body: &Value,
    ) -> Result<Value, AgentApiError> {
        let idempotency_key = uuid::Uuid::new_v4().to_string();
        self.request(
            method,
            path,
            Some(AgentRequestBody::Json(body)),
            Some(&idempotency_key),
            true,
        )
        .await?
        .json()
        .await
        .map_err(|error| AgentApiError::local("TEMPORARY_UNAVAILABLE", error.to_string()))
    }

    async fn mutate_text_confirmed(
        &self,
        method: Method,
        path: &str,
        body: &str,
    ) -> Result<Value, AgentApiError> {
        let idempotency_key = uuid::Uuid::new_v4().to_string();
        self.request(
            method,
            path,
            Some(AgentRequestBody::Text(body)),
            Some(&idempotency_key),
            true,
        )
        .await?
        .json()
        .await
        .map_err(|error| AgentApiError::local("TEMPORARY_UNAVAILABLE", error.to_string()))
    }

    async fn stream_authorized(&self, path: &str, output: &Path) -> Result<u64, AgentApiError> {
        let response = self.request(Method::GET, path, None, None, false).await?;
        stream_response(response, output).await
    }

    async fn unlock_json(&self, id: &str, password: &str) -> Result<Value, AgentApiError> {
        self.request(
            Method::POST,
            &format!("/caps/{id}/unlock"),
            Some(AgentRequestBody::Text(password)),
            None,
            false,
        )
        .await?
        .json()
        .await
        .map_err(|error| AgentApiError::local("TEMPORARY_UNAVAILABLE", error.to_string()))
    }

    fn access_grant_for_path(&self, path: &str) -> Option<String> {
        let id = path
            .strip_prefix("/caps/")?
            .split(['/', '?'])
            .next()
            .filter(|id| !id.is_empty())?;
        if let Some(grant) = self
            .access_grants
            .read()
            .ok()
            .and_then(|grants| grants.get(id).cloned())
            .filter(|grant| grant.expires_at > chrono::Utc::now())
        {
            return Some(grant.value);
        }
        if !self.reload_access_grants {
            return None;
        }
        if self
            .access_grant_checks
            .read()
            .ok()
            .and_then(|checks| checks.get(id).copied())
            .is_some_and(|checked_at| checked_at.elapsed() < Duration::from_secs(1))
        {
            return None;
        }
        if let Ok(mut checks) = self.access_grant_checks.write() {
            checks.insert(id.to_string(), Instant::now());
        }
        let grant = credentials::agent_access_grant(id)?;
        if let Ok(mut grants) = self.access_grants.write() {
            grants.insert(id.to_string(), grant.clone());
        }
        Some(grant.value)
    }
}

pub fn cap_id(value: &str) -> Result<String, AgentApiError> {
    let id = if value.starts_with("http://") || value.starts_with("https://") {
        let url = Url::parse(value)
            .map_err(|_| AgentApiError::local("INVALID_REQUEST", "Invalid Cap URL"))?;
        let segments = url
            .path_segments()
            .ok_or_else(|| AgentApiError::local("INVALID_REQUEST", "Invalid Cap URL"))?
            .filter(|segment| !segment.is_empty())
            .collect::<Vec<_>>();
        match segments.as_slice() {
            [kind, id] if matches!(*kind, "s" | "watch" | "embed" | "c") => (*id).to_string(),
            [id] => (*id).to_string(),
            _ => {
                return Err(AgentApiError::local(
                    "INVALID_REQUEST",
                    "URL does not identify a Cap",
                ));
            }
        }
    } else {
        value.to_string()
    };
    if id.len() < 5
        || id.len() > 128
        || !id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
    {
        return Err(AgentApiError::local(
            "INVALID_REQUEST",
            "Cap ID contains invalid characters",
        ));
    }
    Ok(id)
}

fn encode_query(parameters: &[(&str, Option<String>)]) -> String {
    let mut serializer = url::form_urlencoded::Serializer::new(String::new());
    for (key, value) in parameters {
        if let Some(value) = value {
            serializer.append_pair(key, value);
        }
    }
    serializer.finish()
}

async fn stream_response(response: Response, output: &Path) -> Result<u64, AgentApiError> {
    if let Some(parent) = output.parent()
        && !parent.as_os_str().is_empty()
    {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|error| AgentApiError::local("TEMPORARY_UNAVAILABLE", error.to_string()))?;
    }
    let temporary = output.with_extension(format!("part-{}", uuid::Uuid::new_v4()));
    let mut file = tokio::fs::File::create(&temporary)
        .await
        .map_err(|error| AgentApiError::local("TEMPORARY_UNAVAILABLE", error.to_string()))?;
    let mut stream = response.bytes_stream();
    let mut written = 0_u64;
    let write_result = async {
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|error| {
                AgentApiError::local("TEMPORARY_UNAVAILABLE", error.to_string())
            })?;
            file.write_all(&chunk).await.map_err(|error| {
                AgentApiError::local("TEMPORARY_UNAVAILABLE", error.to_string())
            })?;
            written = written.saturating_add(chunk.len() as u64);
        }
        file.flush()
            .await
            .map_err(|error| AgentApiError::local("TEMPORARY_UNAVAILABLE", error.to_string()))
    }
    .await;
    drop(file);
    if let Err(error) = write_result {
        let _ = tokio::fs::remove_file(&temporary).await;
        return Err(error);
    }
    if let Err(error) = atomic::replace(&temporary, output) {
        let _ = tokio::fs::remove_file(&temporary).await;
        return Err(AgentApiError::local(
            "TEMPORARY_UNAVAILABLE",
            error.to_string(),
        ));
    }
    Ok(written)
}

fn print_value(value: &Value, format: OutputFormat) -> Result<(), String> {
    match format {
        OutputFormat::Json => write_json(value),
        OutputFormat::Text => {
            println!(
                "{}",
                serde_json::to_string_pretty(value).map_err(|error| error.to_string())?
            );
            Ok(())
        }
    }
}

fn wait_complete(status: &Value, wait_for: WaitFor) -> Result<bool, AgentApiError> {
    let state = |key: &str| {
        status
            .get(key)
            .and_then(|value| value.get("status"))
            .and_then(Value::as_str)
    };
    let complete = |key| match state(key) {
        Some("complete" | "skipped" | "no_audio" | "unavailable") => Ok(true),
        Some("error") => Err(AgentApiError::local(
            "NOT_READY",
            format!("{key} processing failed"),
        )),
        Some(_) => Ok(false),
        None => Err(AgentApiError::local(
            "TEMPORARY_UNAVAILABLE",
            "Cap returned an invalid status",
        )),
    };
    match wait_for {
        WaitFor::Transcript => complete("transcript"),
        WaitFor::Ai => complete("ai"),
        WaitFor::All => Ok(complete("transcript")? && complete("ai")?),
    }
}

pub fn opaque_id(value: &str, field: &str) -> Result<String, AgentApiError> {
    if value.is_empty()
        || value.len() > 128
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
    {
        return Err(AgentApiError::local(
            "INVALID_REQUEST",
            format!("{field} contains invalid characters"),
        ));
    }
    Ok(value.to_string())
}

fn read_unlock_password(password_stdin: bool) -> Result<String, AgentApiError> {
    let password = if password_stdin {
        let mut value = String::new();
        std::io::stdin()
            .lock()
            .take(1_025)
            .read_to_string(&mut value)
            .map_err(|error| AgentApiError::local("INVALID_REQUEST", error.to_string()))?;
        if let Some(value) = value.strip_suffix('\n') {
            value.strip_suffix('\r').unwrap_or(value).to_string()
        } else {
            value
        }
    } else {
        if !std::io::stdin().is_terminal() {
            return Err(AgentApiError::local(
                "INVALID_REQUEST",
                "Non-interactive unlock requires --password-stdin",
            ));
        }
        rpassword::prompt_password("Cap password: ")
            .map_err(|error| AgentApiError::local("INVALID_REQUEST", error.to_string()))?
    };
    if password.is_empty() || password.len() > 512 {
        return Err(AgentApiError::local(
            "INVALID_REQUEST",
            "Password must be between 1 and 512 bytes",
        ));
    }
    Ok(password)
}

async fn run_cap_operation(
    client: &AgentClient,
    args: CapOperationArgs,
    deleting: bool,
    global_json: bool,
) -> Result<(), AgentApiError> {
    let id = cap_id(&args.cap)?;
    confirmation::require(
        args.yes,
        if deleting {
            "Permanently delete the Cap and its media"
        } else {
            "Duplicate the Cap and its media"
        },
    )
    .map_err(|message| AgentApiError::local("INVALID_REQUEST", message))?;
    let path = if deleting {
        format!("/caps/{id}")
    } else {
        format!("/caps/{id}/duplicate")
    };
    let value = client
        .mutate_json_confirmed(
            if deleting {
                Method::DELETE
            } else {
                Method::POST
            },
            &path,
            &json!({}),
        )
        .await?;
    let value = if args.wait {
        let operation_id = value.get("id").and_then(Value::as_str).ok_or_else(|| {
            AgentApiError::local("TEMPORARY_UNAVAILABLE", "Cap returned an invalid operation")
        })?;
        crate::jobs::wait_operation(client, operation_id, args.timeout).await?
    } else {
        value
    };
    print_value(&value, resolve_format(global_json, args.format))
        .map_err(|message| AgentApiError::local("TEMPORARY_UNAVAILABLE", message))
}

impl CapsArgs {
    fn output_format(&self, global_json: bool) -> OutputFormat {
        let local = match &self.command {
            CapsCommands::List(args) => args.format,
            CapsCommands::Get(args) | CapsCommands::Context(args) | CapsCommands::Status(args) => {
                args.format
            }
            CapsCommands::Wait(args) => args.format,
            CapsCommands::Process(args) => args.format,
            CapsCommands::Import(args) => match &args.command {
                ImportCommands::Loom(args) => args.format,
            },
            CapsCommands::Transcript(_) | CapsCommands::Download(_) => OutputFormat::Text,
            CapsCommands::TranscriptReplace(args) => args.format,
            CapsCommands::Duplicate(args) | CapsCommands::Delete(args) => args.format,
            CapsCommands::Password(args) => match &args.command {
                PasswordCommands::Set(args) => args.format,
                PasswordCommands::Clear(args) => args.format,
            },
            CapsCommands::Unlock(args) => args.format,
            CapsCommands::Comments(args) => match &args.command {
                CommentsCommands::Add(args) => args.format,
                CommentsCommands::Reply(args) => args.format,
                CommentsCommands::Delete(args) => args.format,
            },
            CapsCommands::Reactions(args) => match &args.command {
                ReactionsCommands::Add(args) => args.format,
            },
            CapsCommands::Update(args) => args.format,
            CapsCommands::Sharing(args) => match &args.command {
                SharingCommands::Set(args) => args.format,
            },
            CapsCommands::Settings(args) => match &args.command {
                SettingsCommands::Get(args) => args.format,
                SettingsCommands::Set(args) => args.format,
            },
            CapsCommands::Date(args) => match &args.command {
                DateCommands::Set(args) => args.format,
            },
            CapsCommands::Move(args) => args.format,
            CapsCommands::Shares(args) => match &args.command {
                ShareCommands::List(args) => args.format,
                ShareCommands::Organization(args) => match &args.command {
                    OrganizationShareCommands::Add(args) => args.format,
                    OrganizationShareCommands::Remove(args) => args.format,
                },
                ShareCommands::Space(args) => match &args.command {
                    SpaceShareCommands::Add(args) => args.format,
                    SpaceShareCommands::Remove(args) => args.format,
                },
            },
        };
        resolve_format(global_json, local)
    }

    pub async fn run(self, global_json: bool) -> Result<(), String> {
        let output_format = self.output_format(global_json);
        let result = self.run_inner(global_json).await;
        if let Err(error) = &result
            && output_format == OutputFormat::Json
        {
            let _ = write_json(error);
        }
        result.map_err(|error| error.to_string())
    }

    async fn run_inner(self, global_json: bool) -> Result<(), AgentApiError> {
        let client = AgentClient::from_credentials()?;
        match self.command {
            CapsCommands::List(args) => {
                let query = encode_query(&[
                    ("scope", Some(args.scope.as_str().to_string())),
                    ("organizationId", args.organization),
                    ("folderId", args.folder),
                    ("search", args.search),
                    ("updatedAfter", args.updated_after),
                    ("cursor", args.cursor),
                    ("limit", Some(args.limit.to_string())),
                ]);
                let value = client.get_json(&format!("/caps?{query}")).await?;
                let format = resolve_format(global_json, args.format);
                if format == OutputFormat::Text {
                    let caps = value.get("caps").and_then(Value::as_array).ok_or_else(|| {
                        AgentApiError::local(
                            "TEMPORARY_UNAVAILABLE",
                            "Cap returned an invalid list",
                        )
                    })?;
                    for cap in caps {
                        println!(
                            "{}\t{}\t{}",
                            cap.get("id").and_then(Value::as_str).unwrap_or(""),
                            cap.get("title").and_then(Value::as_str).unwrap_or(""),
                            cap.get("updatedAt").and_then(Value::as_str).unwrap_or("")
                        );
                    }
                    if let Some(cursor) = value.get("nextCursor").and_then(Value::as_str) {
                        println!("next cursor: {cursor}");
                    }
                    Ok(())
                } else {
                    print_value(&value, format)
                        .map_err(|message| AgentApiError::local("TEMPORARY_UNAVAILABLE", message))
                }
            }
            CapsCommands::Get(args) => {
                let id = cap_id(&args.cap)?;
                let value = client.get_json(&format!("/caps/{id}")).await?;
                print_value(&value, resolve_format(global_json, args.format))
                    .map_err(|message| AgentApiError::local("TEMPORARY_UNAVAILABLE", message))
            }
            CapsCommands::Context(args) => {
                let id = cap_id(&args.cap)?;
                let value = client.get_json(&format!("/caps/{id}/context")).await?;
                print_value(&value, resolve_format(global_json, args.format))
                    .map_err(|message| AgentApiError::local("TEMPORARY_UNAVAILABLE", message))
            }
            CapsCommands::Status(args) => {
                let id = cap_id(&args.cap)?;
                let value = client.get_json(&format!("/caps/{id}/status")).await?;
                print_value(&value, resolve_format(global_json, args.format))
                    .map_err(|message| AgentApiError::local("TEMPORARY_UNAVAILABLE", message))
            }
            CapsCommands::Wait(args) => {
                if args.timeout == 0 || args.timeout > 86_400 {
                    return Err(AgentApiError::local(
                        "INVALID_REQUEST",
                        "--timeout must be between 1 and 86400 seconds",
                    ));
                }
                let id = cap_id(&args.cap)?;
                let started = tokio::time::Instant::now();
                let deadline = started + Duration::from_secs(args.timeout);
                let mut attempt = 0_u32;
                loop {
                    let value = client.get_json(&format!("/caps/{id}/status")).await?;
                    if wait_complete(&value, args.r#for)? {
                        return print_value(&value, resolve_format(global_json, args.format))
                            .map_err(|message| {
                                AgentApiError::local("TEMPORARY_UNAVAILABLE", message)
                            });
                    }
                    if tokio::time::Instant::now() >= deadline {
                        return Err(AgentApiError {
                            code: "NOT_READY".to_string(),
                            message: "Timed out waiting for Cap processing".to_string(),
                            retryable: true,
                            retry_after_ms: Some(2_000),
                            request_id: value
                                .get("requestId")
                                .and_then(Value::as_str)
                                .map(str::to_string),
                        });
                    }
                    let base = 500_u64.saturating_mul(1_u64 << attempt.min(4));
                    let jitter = u64::from(uuid::Uuid::new_v4().as_bytes()[0]);
                    tokio::time::sleep(Duration::from_millis((base + jitter).min(10_000))).await;
                    attempt = attempt.saturating_add(1);
                }
            }
            CapsCommands::Process(args) => {
                let id = cap_id(&args.cap)?;
                confirmation::require(
                    args.yes,
                    "Start paid Cap processing when work is not already complete",
                )
                .map_err(|message| AgentApiError::local("INVALID_REQUEST", message))?;
                let value = client
                    .mutate_json_confirmed(
                        Method::POST,
                        &format!("/caps/{id}/process"),
                        &json!({
                            "target": args.target.as_str(),
                            "retry": args.retry,
                        }),
                    )
                    .await?;
                print_value(&value, resolve_format(global_json, args.format))
                    .map_err(|message| AgentApiError::local("TEMPORARY_UNAVAILABLE", message))
            }
            CapsCommands::Import(args) => match args.command {
                ImportCommands::Loom(args) => {
                    if args.timeout == 0 || args.timeout > 86_400 {
                        return Err(AgentApiError::local(
                            "INVALID_REQUEST",
                            "--timeout must be between 1 and 86400 seconds",
                        ));
                    }
                    confirmation::require(
                        args.yes,
                        if args.owner_email.is_some() || args.space.is_some() {
                            "Import the Loom video and apply the requested organization assignment"
                        } else {
                            "Import the Loom video into Cap"
                        },
                    )
                    .map_err(|message| AgentApiError::local("INVALID_REQUEST", message))?;
                    let organization = opaque_id(&args.organization, "Organization ID")?;
                    let value = client
                        .mutate_json_confirmed(
                            Method::POST,
                            &format!("/organizations/{organization}/imports/loom"),
                            &json!({
                                "loomUrl": args.loom_url,
                                "ownerEmail": args.owner_email,
                                "spaceName": args.space,
                            }),
                        )
                        .await?;
                    let value = if args.wait {
                        let operation_id =
                            value.get("id").and_then(Value::as_str).ok_or_else(|| {
                                AgentApiError::local(
                                    "TEMPORARY_UNAVAILABLE",
                                    "Cap returned an invalid Loom import operation",
                                )
                            })?;
                        crate::jobs::wait_operation(&client, operation_id, args.timeout).await?
                    } else {
                        value
                    };
                    print_value(&value, resolve_format(global_json, args.format))
                        .map_err(|message| AgentApiError::local("TEMPORARY_UNAVAILABLE", message))
                }
            },
            CapsCommands::Transcript(args) => {
                let id = cap_id(&args.cap)?;
                let path = format!("/caps/{id}/transcript?format={}", args.format.as_str());
                let bytes = client.stream_authorized(&path, &args.output).await?;
                let result = json!({
                    "id": id,
                    "path": args.output,
                    "format": args.format.as_str(),
                    "bytes": bytes,
                });
                print_value(
                    &result,
                    if global_json {
                        OutputFormat::Json
                    } else {
                        OutputFormat::Text
                    },
                )
                .map_err(|message| AgentApiError::local("TEMPORARY_UNAVAILABLE", message))
            }
            CapsCommands::TranscriptReplace(args) => {
                let id = cap_id(&args.cap)?;
                let metadata = tokio::fs::metadata(&args.input)
                    .await
                    .map_err(|error| AgentApiError::local("INVALID_REQUEST", error.to_string()))?;
                if metadata.len() > 12 * 1024 * 1024 {
                    return Err(AgentApiError::local(
                        "INVALID_REQUEST",
                        "Transcript JSON must not exceed 12 MiB",
                    ));
                }
                let input = tokio::fs::read(&args.input)
                    .await
                    .map_err(|error| AgentApiError::local("INVALID_REQUEST", error.to_string()))?;
                let document: Value = serde_json::from_slice(&input)
                    .map_err(|error| AgentApiError::local("INVALID_REQUEST", error.to_string()))?;
                let expected_revision = args
                    .expected_revision
                    .or_else(|| {
                        document
                            .get("revision")
                            .and_then(Value::as_str)
                            .map(str::to_string)
                    })
                    .ok_or_else(|| {
                        AgentApiError::local(
                            "INVALID_REQUEST",
                            "Provide --expected-revision or a transcript JSON revision",
                        )
                    })?;
                let cues = document.get("cues").cloned().ok_or_else(|| {
                    AgentApiError::local("INVALID_REQUEST", "Transcript JSON must contain cues")
                })?;
                confirmation::require(args.yes, "Replace the Cap transcript")
                    .map_err(|message| AgentApiError::local("INVALID_REQUEST", message))?;
                let value = client
                    .mutate_json_confirmed(
                        Method::PUT,
                        &format!("/caps/{id}/transcript"),
                        &json!({
                            "expectedRevision": expected_revision,
                            "cues": cues,
                        }),
                    )
                    .await?;
                print_value(&value, resolve_format(global_json, args.format))
                    .map_err(|message| AgentApiError::local("TEMPORARY_UNAVAILABLE", message))
            }
            CapsCommands::Download(args) => {
                let id = cap_id(&args.cap)?;
                let info = client.get_json(&format!("/caps/{id}/download")).await?;
                let url = info.get("url").and_then(Value::as_str).ok_or_else(|| {
                    AgentApiError::local(
                        "TEMPORARY_UNAVAILABLE",
                        "Cap returned an invalid download",
                    )
                })?;
                let response = client.http.get(url).send().await.map_err(|error| {
                    AgentApiError::local("TEMPORARY_UNAVAILABLE", error.to_string())
                })?;
                if !response.status().is_success() {
                    return Err(AgentApiError::local(
                        "TEMPORARY_UNAVAILABLE",
                        format!("Download returned HTTP {}", response.status()),
                    ));
                }
                let bytes = stream_response(response, &args.output).await?;
                let result = json!({ "id": id, "path": args.output, "bytes": bytes });
                print_value(
                    &result,
                    if global_json {
                        OutputFormat::Json
                    } else {
                        OutputFormat::Text
                    },
                )
                .map_err(|message| AgentApiError::local("TEMPORARY_UNAVAILABLE", message))
            }
            CapsCommands::Duplicate(args) => {
                run_cap_operation(&client, args, false, global_json).await
            }
            CapsCommands::Delete(args) => run_cap_operation(&client, args, true, global_json).await,
            CapsCommands::Password(args) => {
                let (value, format) = match args.command {
                    PasswordCommands::Set(args) => {
                        let id = cap_id(&args.cap)?;
                        confirmation::require(args.yes, "Set the Cap password")
                            .map_err(|message| AgentApiError::local("INVALID_REQUEST", message))?;
                        let password = read_unlock_password(args.password_stdin)?;
                        let value = client
                            .mutate_text_confirmed(
                                Method::PUT,
                                &format!("/caps/{id}/password"),
                                &password,
                            )
                            .await?;
                        drop(password);
                        (value, args.format)
                    }
                    PasswordCommands::Clear(args) => {
                        let id = cap_id(&args.cap)?;
                        confirmation::require(args.yes, "Clear the Cap password")
                            .map_err(|message| AgentApiError::local("INVALID_REQUEST", message))?;
                        let value = client
                            .mutate_text_confirmed(Method::PUT, &format!("/caps/{id}/password"), "")
                            .await?;
                        (value, args.format)
                    }
                };
                print_value(&value, resolve_format(global_json, format))
                    .map_err(|message| AgentApiError::local("TEMPORARY_UNAVAILABLE", message))
            }
            CapsCommands::Unlock(args) => {
                let id = cap_id(&args.cap)?;
                let password = read_unlock_password(args.password_stdin)?;
                let response = client.unlock_json(&id, &password).await?;
                drop(password);
                let access_grant = response
                    .get("accessGrant")
                    .and_then(Value::as_str)
                    .ok_or_else(|| {
                        AgentApiError::local(
                            "TEMPORARY_UNAVAILABLE",
                            "Cap returned an invalid access grant",
                        )
                    })?;
                let expires_at = response
                    .get("expiresAt")
                    .and_then(Value::as_str)
                    .ok_or_else(|| {
                        AgentApiError::local(
                            "TEMPORARY_UNAVAILABLE",
                            "Cap returned an invalid access grant expiry",
                        )
                    })?;
                credentials::store_agent_access_grant(
                    &id,
                    access_grant.to_string(),
                    expires_at.to_string(),
                    args.allow_file_credential,
                )
                .map_err(|message| AgentApiError::local("TEMPORARY_UNAVAILABLE", message))?;
                print_value(
                    &json!({ "id": id, "unlocked": true, "expiresAt": expires_at }),
                    resolve_format(global_json, args.format),
                )
                .map_err(|message| AgentApiError::local("TEMPORARY_UNAVAILABLE", message))
            }
            CapsCommands::Comments(args) => {
                let (value, format) = match args.command {
                    CommentsCommands::Add(args) => {
                        let id = cap_id(&args.cap)?;
                        confirmation::require(args.yes, "Post the comment")
                            .map_err(|message| AgentApiError::local("INVALID_REQUEST", message))?;
                        let value = client
                            .mutate_json_confirmed(
                                Method::POST,
                                &format!("/caps/{id}/comments"),
                                &json!({
                                    "content": args.content,
                                    "timestampMs": args.timestamp_ms,
                                }),
                            )
                            .await?;
                        (value, args.format)
                    }
                    CommentsCommands::Reply(args) => {
                        let id = cap_id(&args.cap)?;
                        let comment_id = opaque_id(&args.comment_id, "Comment ID")?;
                        confirmation::require(args.yes, "Post the reply")
                            .map_err(|message| AgentApiError::local("INVALID_REQUEST", message))?;
                        let value = client
                            .mutate_json_confirmed(
                                Method::POST,
                                &format!("/caps/{id}/comments/{comment_id}/replies"),
                                &json!({
                                    "content": args.content,
                                    "timestampMs": args.timestamp_ms,
                                }),
                            )
                            .await?;
                        (value, args.format)
                    }
                    CommentsCommands::Delete(args) => {
                        let id = cap_id(&args.cap)?;
                        let comment_id = opaque_id(&args.comment_id, "Comment ID")?;
                        confirmation::require(args.yes, "Delete the comment")
                            .map_err(|message| AgentApiError::local("INVALID_REQUEST", message))?;
                        let value = client
                            .mutate_json(
                                Method::DELETE,
                                &format!("/caps/{id}/comments/{comment_id}"),
                                &json!({}),
                            )
                            .await?;
                        (value, args.format)
                    }
                };
                print_value(&value, resolve_format(global_json, format))
                    .map_err(|message| AgentApiError::local("TEMPORARY_UNAVAILABLE", message))
            }
            CapsCommands::Reactions(args) => {
                let (value, format) = match args.command {
                    ReactionsCommands::Add(args) => {
                        let id = cap_id(&args.cap)?;
                        confirmation::require(args.yes, "Post the reaction")
                            .map_err(|message| AgentApiError::local("INVALID_REQUEST", message))?;
                        let value = client
                            .mutate_json_confirmed(
                                Method::POST,
                                &format!("/caps/{id}/reactions"),
                                &json!({
                                    "content": args.reaction,
                                    "timestampMs": args.timestamp_ms,
                                }),
                            )
                            .await?;
                        (value, args.format)
                    }
                };
                print_value(&value, resolve_format(global_json, format))
                    .map_err(|message| AgentApiError::local("TEMPORARY_UNAVAILABLE", message))
            }
            CapsCommands::Update(args) => {
                let id = cap_id(&args.cap)?;
                confirmation::require(args.yes, "Change the Cap title")
                    .map_err(|message| AgentApiError::local("INVALID_REQUEST", message))?;
                let value = client
                    .mutate_json_confirmed(
                        Method::PATCH,
                        &format!("/caps/{id}"),
                        &json!({ "title": args.title }),
                    )
                    .await?;
                print_value(&value, resolve_format(global_json, args.format))
                    .map_err(|message| AgentApiError::local("TEMPORARY_UNAVAILABLE", message))
            }
            CapsCommands::Sharing(args) => {
                let (value, format) = match args.command {
                    SharingCommands::Set(args) => {
                        let id = cap_id(&args.cap)?;
                        confirmation::require(args.yes, "Change the Cap visibility")
                            .map_err(|message| AgentApiError::local("INVALID_REQUEST", message))?;
                        let value = client
                            .mutate_json_confirmed(
                                Method::PATCH,
                                &format!("/caps/{id}"),
                                &json!({ "public": args.public && !args.private }),
                            )
                            .await?;
                        (value, args.format)
                    }
                };
                print_value(&value, resolve_format(global_json, format))
                    .map_err(|message| AgentApiError::local("TEMPORARY_UNAVAILABLE", message))
            }
            CapsCommands::Settings(args) => match args.command {
                SettingsCommands::Get(args) => {
                    let id = cap_id(&args.cap)?;
                    let value = client.get_json(&format!("/caps/{id}/settings")).await?;
                    print_value(&value, resolve_format(global_json, args.format))
                        .map_err(|message| AgentApiError::local("TEMPORARY_UNAVAILABLE", message))
                }
                SettingsCommands::Set(args) => {
                    let id = cap_id(&args.cap)?;
                    let mut body = Map::new();
                    for (key, value) in [
                        ("disableSummary", args.disable_summary),
                        ("disableCaptions", args.disable_captions),
                        ("disableChapters", args.disable_chapters),
                        ("disableReactions", args.disable_reactions),
                        ("disableTranscript", args.disable_transcript),
                        ("disableComments", args.disable_comments),
                    ] {
                        if let Some(value) = value {
                            body.insert(key.to_string(), Value::Bool(value));
                        }
                    }
                    if let Some(value) = args.default_playback_speed {
                        body.insert("defaultPlaybackSpeed".to_string(), json!(value));
                    }
                    if body.is_empty() {
                        return Err(AgentApiError::local(
                            "INVALID_REQUEST",
                            "Provide at least one Cap setting",
                        ));
                    }
                    confirmation::require(args.yes, "Update the Cap viewer settings")
                        .map_err(|message| AgentApiError::local("INVALID_REQUEST", message))?;
                    let value = client
                        .mutate_json(
                            Method::PATCH,
                            &format!("/caps/{id}/settings"),
                            &Value::Object(body),
                        )
                        .await?;
                    print_value(&value, resolve_format(global_json, args.format))
                        .map_err(|message| AgentApiError::local("TEMPORARY_UNAVAILABLE", message))
                }
            },
            CapsCommands::Date(args) => match args.command {
                DateCommands::Set(args) => {
                    let id = cap_id(&args.cap)?;
                    confirmation::require(args.yes, "Change the Cap recording date")
                        .map_err(|message| AgentApiError::local("INVALID_REQUEST", message))?;
                    let value = client
                        .mutate_json(
                            Method::PATCH,
                            &format!("/caps/{id}/date"),
                            &json!({ "createdAt": args.created_at }),
                        )
                        .await?;
                    print_value(&value, resolve_format(global_json, args.format))
                        .map_err(|message| AgentApiError::local("TEMPORARY_UNAVAILABLE", message))
                }
            },
            CapsCommands::Move(args) => {
                let id = cap_id(&args.cap)?;
                let organization_id = opaque_id(&args.organization, "Organization ID")?;
                let space_id = args
                    .space
                    .as_deref()
                    .map(|space| opaque_id(space, "Space ID"))
                    .transpose()?;
                let folder_id = if args.root {
                    None
                } else {
                    args.folder
                        .as_deref()
                        .map(|folder| opaque_id(folder, "Folder ID"))
                        .transpose()?
                };
                confirmation::require(args.yes, "Move the Cap")
                    .map_err(|message| AgentApiError::local("INVALID_REQUEST", message))?;
                let value = client
                    .mutate_json(
                        Method::PATCH,
                        &format!("/caps/{id}/location"),
                        &json!({
                            "container": args.container.as_str(),
                            "organizationId": organization_id,
                            "spaceId": space_id,
                            "folderId": folder_id,
                        }),
                    )
                    .await?;
                print_value(&value, resolve_format(global_json, args.format))
                    .map_err(|message| AgentApiError::local("TEMPORARY_UNAVAILABLE", message))
            }
            CapsCommands::Shares(args) => {
                let (value, format) = match args.command {
                    ShareCommands::List(args) => {
                        let id = cap_id(&args.cap)?;
                        let value = client.get_json(&format!("/caps/{id}/shares")).await?;
                        (value, args.format)
                    }
                    ShareCommands::Organization(args) => match args.command {
                        OrganizationShareCommands::Add(args) => {
                            let id = cap_id(&args.cap)?;
                            let organization = opaque_id(&args.organization, "Organization ID")?;
                            let folder = args
                                .folder
                                .as_deref()
                                .map(|value| opaque_id(value, "Folder ID"))
                                .transpose()?;
                            confirmation::require(args.yes, "Share the Cap with the organization")
                                .map_err(|message| {
                                    AgentApiError::local("INVALID_REQUEST", message)
                                })?;
                            let value = client
                                .mutate_json(
                                    Method::PUT,
                                    &format!("/caps/{id}/shares/organizations/{organization}"),
                                    &json!({ "folderId": folder }),
                                )
                                .await?;
                            (value, args.format)
                        }
                        OrganizationShareCommands::Remove(args) => {
                            let id = cap_id(&args.cap)?;
                            let organization = opaque_id(&args.organization, "Organization ID")?;
                            confirmation::require(args.yes, "Remove the organization share")
                                .map_err(|message| {
                                    AgentApiError::local("INVALID_REQUEST", message)
                                })?;
                            let value = client
                                .mutate_json(
                                    Method::DELETE,
                                    &format!("/caps/{id}/shares/organizations/{organization}"),
                                    &json!({}),
                                )
                                .await?;
                            (value, args.format)
                        }
                    },
                    ShareCommands::Space(args) => match args.command {
                        SpaceShareCommands::Add(args) => {
                            let id = cap_id(&args.cap)?;
                            let space = opaque_id(&args.space, "Space ID")?;
                            let folder = args
                                .folder
                                .as_deref()
                                .map(|value| opaque_id(value, "Folder ID"))
                                .transpose()?;
                            confirmation::require(args.yes, "Share the Cap with the space")
                                .map_err(|message| {
                                    AgentApiError::local("INVALID_REQUEST", message)
                                })?;
                            let value = client
                                .mutate_json(
                                    Method::PUT,
                                    &format!("/caps/{id}/shares/spaces/{space}"),
                                    &json!({ "folderId": folder }),
                                )
                                .await?;
                            (value, args.format)
                        }
                        SpaceShareCommands::Remove(args) => {
                            let id = cap_id(&args.cap)?;
                            let space = opaque_id(&args.space, "Space ID")?;
                            confirmation::require(args.yes, "Remove the space share").map_err(
                                |message| AgentApiError::local("INVALID_REQUEST", message),
                            )?;
                            let value = client
                                .mutate_json(
                                    Method::DELETE,
                                    &format!("/caps/{id}/shares/spaces/{space}"),
                                    &json!({}),
                                )
                                .await?;
                            (value, args.format)
                        }
                    },
                };
                print_value(&value, resolve_format(global_json, format))
                    .map_err(|message| AgentApiError::local("TEMPORARY_UNAVAILABLE", message))
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    async fn read_request(stream: &mut tokio::net::TcpStream) -> String {
        let mut bytes = Vec::new();
        let mut buffer = [0_u8; 1_024];
        loop {
            let read = stream.read(&mut buffer).await.unwrap();
            if read == 0 {
                break;
            }
            bytes.extend_from_slice(&buffer[..read]);
            if let Some(headers_end) = bytes.windows(4).position(|window| window == b"\r\n\r\n") {
                let headers = String::from_utf8_lossy(&bytes[..headers_end + 4]);
                let content_length = headers
                    .lines()
                    .find_map(|line| {
                        line.to_ascii_lowercase()
                            .strip_prefix("content-length:")
                            .and_then(|value| value.trim().parse::<usize>().ok())
                    })
                    .unwrap_or(0);
                if bytes.len() >= headers_end + 4 + content_length {
                    break;
                }
            }
        }
        String::from_utf8(bytes).unwrap()
    }

    async fn mock_response(stream: &mut tokio::net::TcpStream, status: &str, body: &str) {
        stream
            .write_all(
                format!(
                    "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                )
                .as_bytes(),
            )
            .await
            .unwrap();
    }

    #[test]
    fn accepts_ids_and_known_cap_urls() {
        assert_eq!(cap_id("cap_12345").unwrap(), "cap_12345");
        assert_eq!(cap_id("https://cap.so/s/cap_12345").unwrap(), "cap_12345");
        assert_eq!(
            cap_id("https://videos.example.com/cap_12345").unwrap(),
            "cap_12345"
        );
        assert!(cap_id("https://cap.so/settings/billing").is_err());
    }

    #[test]
    fn terminal_wait_states_do_not_start_work() {
        assert!(
            wait_complete(
                &json!({"transcript":{"status":"complete"}}),
                WaitFor::Transcript
            )
            .unwrap()
        );
        assert!(wait_complete(&json!({"ai":{"status":"skipped"}}), WaitFor::Ai).unwrap());
        assert!(
            wait_complete(&json!({"ai":{"status":"processing"}}), WaitFor::Ai)
                .is_ok_and(|done| !done)
        );
    }

    #[tokio::test]
    async fn mutation_retries_reuse_the_same_idempotency_key() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let mut keys = Vec::new();
            for attempt in 0..2 {
                let (mut stream, _) = listener.accept().await.unwrap();
                let request = read_request(&mut stream).await;
                let key = request
                    .lines()
                    .find_map(|line| {
                        line.to_ascii_lowercase()
                            .strip_prefix("idempotency-key:")
                            .map(str::trim)
                            .map(str::to_string)
                    })
                    .unwrap();
                keys.push(key);
                if attempt == 0 {
                    mock_response(
                        &mut stream,
                        "503 Service Unavailable",
                        r#"{"code":"TEMPORARY_UNAVAILABLE","message":"retry","retryable":true,"retryAfterMs":1,"requestId":"request_1"}"#,
                    )
                    .await;
                } else {
                    mock_response(&mut stream, "200 OK", r#"{"ok":true}"#).await;
                }
            }
            keys
        });
        let client = AgentClient::new(format!("http://{address}"), "token".to_string()).unwrap();
        let value = client
            .mutate_json(
                Method::POST,
                "/caps/cap_test/comments",
                &json!({"content":"ok"}),
            )
            .await
            .unwrap();
        assert_eq!(value["ok"], true);
        let keys = server.await.unwrap();
        assert_eq!(keys.len(), 2);
        assert_eq!(keys[0], keys[1]);
    }

    #[tokio::test]
    async fn mutation_transport_retries_reuse_the_same_idempotency_key() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let mut keys = Vec::new();
            for attempt in 0..2 {
                let (mut stream, _) = listener.accept().await.unwrap();
                let request = read_request(&mut stream).await;
                keys.push(
                    request
                        .lines()
                        .find_map(|line| {
                            line.to_ascii_lowercase()
                                .strip_prefix("idempotency-key:")
                                .map(str::trim)
                                .map(str::to_string)
                        })
                        .unwrap(),
                );
                if attempt == 1 {
                    mock_response(&mut stream, "200 OK", r#"{"ok":true}"#).await;
                }
            }
            keys
        });
        let client = AgentClient::new(format!("http://{address}"), "token".to_string()).unwrap();
        let value = client
            .mutate_json(
                Method::POST,
                "/caps/cap_test/comments",
                &json!({"content":"ok"}),
            )
            .await
            .unwrap();
        assert_eq!(value["ok"], true);
        let keys = server.await.unwrap();
        assert_eq!(keys.len(), 2);
        assert_eq!(keys[0], keys[1]);
    }

    #[tokio::test]
    async fn access_grants_are_sent_only_as_headers() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let request = read_request(&mut stream).await;
            mock_response(&mut stream, "200 OK", r#"{"ok":true}"#).await;
            request
        });
        let client = AgentClient::new(format!("http://{address}"), "token".to_string()).unwrap();
        client.access_grants.write().unwrap().insert(
            "cap_test".to_string(),
            credentials::AgentAccessGrant {
                value: "encrypted_access_grant".to_string(),
                expires_at: chrono::Utc::now() + chrono::Duration::minutes(1),
            },
        );
        client.get_json("/caps/cap_test/context").await.unwrap();
        let request = server.await.unwrap();
        assert!(request.contains("x-cap-access-grant: encrypted_access_grant"));
        assert!(!request.contains("password"));
    }
}
