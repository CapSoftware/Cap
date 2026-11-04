use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use futures_util::future::{Either, select};
use serde::Deserialize;
use serde_json::{Value, json};

use super::bridge::{BridgeClient, BridgeError};
use super::paths::Bundle;
use super::protocol::{
    ActivityVerb, Event, EventBody, FinishOutcome, MAX_REQUEST_ID, RawRequest, StepState, ToolCall,
    ToolResult,
};
use super::redact::Redactor;
use super::sanitize;
use super::submission::{self, SubmissionInfo};
use super::tools::{self, ToolContext};
use super::workspace::{Verifier, Workspace};

const CREATE_TIMEOUT: Duration = Duration::from_secs(150);
const STOP_TIMEOUT: Duration = Duration::from_secs(15);
const CONNECTION_GRACE: Duration = Duration::from_secs(60);
const MAX_REQUESTS: usize = 2000;
const MAX_TRACE: usize = 400;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RepairOperation {
    Recover,
    Open,
}

impl RepairOperation {
    pub fn wire(self) -> &'static str {
        match self {
            Self::Recover => "recover",
            Self::Open => "open",
        }
    }
}

#[derive(Debug, Clone)]
pub struct RepairRequest {
    pub project_path: PathBuf,
    pub operation: RepairOperation,
    pub error_message: String,
    pub display_name: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TraceState {
    Running,
    Done,
    Failed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ToolVerb {
    Describe,
    List,
    Read,
    Inspect,
    Pull,
    Edit,
    Truncate,
    Remove,
    Replace,
    Verify,
    SourceRead,
    Search,
    Run,
    Write,
}

#[derive(Debug, Clone)]
pub enum TraceItem {
    Thought {
        text: String,
    },
    Step {
        id: String,
        title: String,
        detail: Option<String>,
        state: TraceState,
    },
    Tool {
        verb: ToolVerb,
        target: String,
        meta: Option<String>,
        state: TraceState,
    },
}

#[derive(Debug, Clone)]
pub enum RepairPhase {
    SignInRequired,
    Connecting,
    Working,
    Verifying,
    Fixed {
        project_path: PathBuf,
        summary: String,
    },
    CantFix {
        summary: String,
    },
    Failed {
        message: String,
    },
    Sending {
        sent_bytes: u64,
        total_bytes: u64,
    },
    Sent,
    SendFailed {
        message: String,
    },
    Cancelled,
}

impl RepairPhase {
    fn is_active(&self) -> bool {
        matches!(
            self,
            Self::Connecting | Self::Working | Self::Verifying | Self::Sending { .. }
        )
    }
}

#[derive(Debug, Clone)]
pub struct RepairSnapshot {
    pub phase: RepairPhase,
    pub trace: Vec<TraceItem>,
    pub started_at: Instant,
    pub finished_at: Option<Instant>,
    pub recording_bytes: u64,
}

#[derive(Clone)]
pub enum SessionSource {
    Server,
    Direct {
        url: String,
        token: String,
        allow_http: bool,
    },
}

#[derive(Default)]
struct Extra {
    session_id: Option<String>,
    diagnosis: Option<String>,
    bundle_root: Option<PathBuf>,
}

struct Inner {
    request: RepairRequest,
    state: Mutex<RepairSnapshot>,
    notify_tx: flume::Sender<()>,
    notify_rx: flume::Receiver<()>,
    cancelled: AtomicBool,
    cancel_tx: flume::Sender<()>,
    cancel_rx: flume::Receiver<()>,
    sending: AtomicBool,
    runtime: tokio::runtime::Handle,
    source: SessionSource,
    extra: Mutex<Extra>,
}

#[derive(Clone)]
pub struct RepairController {
    inner: Arc<Inner>,
}

impl Inner {
    fn update(&self, change: impl FnOnce(&mut RepairSnapshot)) {
        {
            let mut state = self
                .state
                .lock()
                .unwrap_or_else(|poison| poison.into_inner());
            change(&mut state);
            if !state.phase.is_active() && state.finished_at.is_none() {
                state.finished_at = Some(Instant::now());
            }
            if state.phase.is_active() {
                state.finished_at = None;
            }
            if state.trace.len() > MAX_TRACE {
                let excess = state.trace.len() - MAX_TRACE;
                state.trace.drain(..excess);
            }
        }
        let _ = self.notify_tx.try_send(());
    }

    fn set_phase(&self, phase: RepairPhase) {
        self.update(|state| state.phase = phase);
    }

    fn phase(&self) -> RepairPhase {
        self.state
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .phase
            .clone()
    }

    fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::SeqCst)
    }

    fn push_trace(&self, item: TraceItem) -> usize {
        let mut index = 0;
        self.update(|state| {
            state.trace.push(item);
            index = state.trace.len() - 1;
        });
        index
    }
}

impl RepairController {
    pub fn snapshot(&self) -> RepairSnapshot {
        self.inner
            .state
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .clone()
    }

    pub fn updates(&self) -> flume::Receiver<()> {
        self.inner.notify_rx.clone()
    }

    pub fn request(&self) -> &RepairRequest {
        &self.inner.request
    }

    pub fn cancel(&self) {
        if !self.inner.phase().is_active() {
            return;
        }
        self.inner.cancelled.store(true, Ordering::SeqCst);
        let _ = self.inner.cancel_tx.try_send(());
    }

    pub fn send_to_cap(&self) {
        if !matches!(
            self.inner.phase(),
            RepairPhase::CantFix { .. }
                | RepairPhase::Failed { .. }
                | RepairPhase::SendFailed { .. }
        ) {
            return;
        }
        if !super::availability::current().is_some_and(|config| config.submissions) {
            return;
        }
        if self.inner.sending.swap(true, Ordering::SeqCst) {
            return;
        }
        self.inner.cancelled.store(false, Ordering::SeqCst);
        while self.inner.cancel_rx.try_recv().is_ok() {}
        let inner = self.inner.clone();
        self.inner.runtime.spawn(async move {
            run_submission(&inner).await;
            inner.sending.store(false, Ordering::SeqCst);
        });
    }
}

pub fn start(request: RepairRequest, cx: &mut gpui::App) -> RepairController {
    let runtime = gpui_tokio::Tokio::handle(cx);
    let source = direct_source_from_env().unwrap_or(SessionSource::Server);
    let verifier = live_verifier(&request);
    start_on(request, runtime, source, verifier)
}

fn direct_source_from_env() -> Option<SessionSource> {
    if !cfg!(debug_assertions) {
        return None;
    }
    let value = std::env::var("CAP_REPAIR_DIRECT_BRIDGE").ok()?;
    let (url, token) = value.trim().split_once(' ')?;
    Some(SessionSource::Direct {
        url: url.to_string(),
        token: token.trim().to_string(),
        allow_http: true,
    })
}

fn live_verifier(request: &RepairRequest) -> Verifier {
    let path = request.project_path.clone();
    match request.operation {
        RepairOperation::Recover => Arc::new(move |_: &std::path::Path| {
            let recovered = crate::library::recover_incomplete_recording(&path)?;
            let studio = cap_project::RecordingMeta::load_for_project(&recovered)
                .is_ok_and(|meta| meta.studio_meta().is_some());
            if studio {
                crate::editor_window::preflight(&recovered)?;
            }
            Ok(recovered)
        }),
        RepairOperation::Open => Arc::new(move |_: &std::path::Path| {
            crate::editor_window::preflight(&path).map(|_| path.clone())
        }),
    }
}

pub fn start_on(
    request: RepairRequest,
    runtime: tokio::runtime::Handle,
    source: SessionSource,
    verifier: Verifier,
) -> RepairController {
    let (notify_tx, notify_rx) = flume::bounded(1);
    let (cancel_tx, cancel_rx) = flume::bounded(1);
    let inner = Arc::new(Inner {
        request,
        state: Mutex::new(RepairSnapshot {
            phase: RepairPhase::Connecting,
            trace: Vec::new(),
            started_at: Instant::now(),
            finished_at: None,
            recording_bytes: 0,
        }),
        notify_tx,
        notify_rx,
        cancelled: AtomicBool::new(false),
        cancel_tx,
        cancel_rx,
        sending: AtomicBool::new(false),
        runtime: runtime.clone(),
        source,
        extra: Mutex::new(Extra::default()),
    });
    let driver = inner.clone();
    runtime.spawn(async move { drive(driver, verifier).await });
    RepairController { inner }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreatedSession {
    session_id: String,
    bridge_url: String,
    bridge_token: String,
}

enum CreateError {
    SignIn,
    Message(String),
}

const UNAVAILABLE: &str =
    "Fixing recordings isn't available right now. You can send this recording to Cap instead.";
const BUSY: &str =
    "Fixing recordings is busy right now. Try again later, or send this recording to Cap instead.";
const UNREACHABLE: &str = "Couldn't reach Cap. Check your connection and try again.";
const LOST: &str = "Lost connection to the repair workspace.";

async fn create_session(operation: RepairOperation) -> Result<CreatedSession, CreateError> {
    let client = reqwest::Client::builder()
        .timeout(CREATE_TIMEOUT)
        .build()
        .map_err(|_| CreateError::Message(UNREACHABLE.into()))?;
    let response = crate::auth::authed_request_with(
        &client,
        reqwest::Method::POST,
        "/api/desktop/repair/sessions",
        Some(json!({
            "operation": operation.wire(),
            "appVersion": env!("CARGO_PKG_VERSION"),
            "os": std::env::consts::OS,
        })),
    )
    .await
    .map_err(|error| match error {
        crate::auth::AuthApiError::InvalidAuthentication => CreateError::SignIn,
        _ => CreateError::Message(UNREACHABLE.into()),
    })?;
    let status = response.status();
    if status == reqwest::StatusCode::TOO_MANY_REQUESTS {
        return Err(CreateError::Message(BUSY.into()));
    }
    if !status.is_success() {
        return Err(CreateError::Message(UNAVAILABLE.into()));
    }
    let created: CreatedSession = response
        .json()
        .await
        .map_err(|_| CreateError::Message(UNAVAILABLE.into()))?;
    if created.session_id.is_empty()
        || created.session_id.len() > 64
        || !created
            .session_id
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '_' || ch == '-')
    {
        return Err(CreateError::Message(UNAVAILABLE.into()));
    }
    Ok(created)
}

async fn stop_session(session_id: &str) {
    let Ok(client) = reqwest::Client::builder().timeout(STOP_TIMEOUT).build() else {
        return;
    };
    let path = format!("/api/desktop/repair/sessions/{session_id}/stop");
    if let Err(error) =
        crate::auth::authed_request_with(&client, reqwest::Method::POST, &path, Some(json!({})))
            .await
    {
        tracing::debug!(?error, "repair session stop failed");
    }
}

fn kind_of(path: &std::path::Path) -> &'static str {
    match cap_project::RecordingMeta::load_for_project(path) {
        Ok(meta) if meta.studio_meta().is_some() => "studio",
        Ok(_) => "instant",
        Err(_) => "unknown",
    }
}

fn new_repair_id() -> String {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_nanos());
    format!("{nanos:x}{:x}", std::process::id())
}

async fn drive(inner: Arc<Inner>, verifier: Verifier) {
    if matches!(inner.source, SessionSource::Server)
        && crate::store::auth_snapshot().token.is_none()
    {
        inner.set_phase(RepairPhase::SignInRequired);
        return;
    }
    let request = inner.request.clone();
    let opened = tokio::task::spawn_blocking(move || {
        let bundle = Bundle::open(&request.project_path)?;
        let redactor = Redactor::for_bundle(bundle.root()).with_extra(&request.display_name);
        let kind = kind_of(bundle.root());
        let workspace =
            Workspace::open(bundle, &new_repair_id(), request.operation.wire(), redactor)?;
        Ok::<_, String>((workspace, kind))
    })
    .await
    .unwrap_or_else(|error| Err(error.to_string()));
    let (workspace, kind) = match opened {
        Ok(opened) => opened,
        Err(error) => {
            inner.set_phase(RepairPhase::Failed {
                message: format!(
                    "Couldn't read this recording: {}",
                    sanitize::clean(&error, 200)
                ),
            });
            return;
        }
    };
    {
        let mut extra = inner
            .extra
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        extra.bundle_root = Some(workspace.bundle().root().to_path_buf());
    }
    let (_, total_bytes, _) = workspace.stats();
    inner.update(|state| state.recording_bytes = total_bytes);

    let (url, token, allow_http) = match inner.source.clone() {
        SessionSource::Direct {
            url,
            token,
            allow_http,
        } => (url, token, allow_http),
        SessionSource::Server => {
            let create = Box::pin(create_session(inner.request.operation));
            let cancel = Box::pin(inner.cancel_rx.recv_async());
            match select(create, cancel).await {
                Either::Left((Ok(created), _)) => {
                    inner
                        .extra
                        .lock()
                        .unwrap_or_else(|poison| poison.into_inner())
                        .session_id = Some(created.session_id.clone());
                    if inner.is_cancelled() {
                        stop_session(&created.session_id).await;
                        inner.set_phase(RepairPhase::Cancelled);
                        return;
                    }
                    (created.bridge_url, created.bridge_token, false)
                }
                Either::Left((Err(CreateError::SignIn), _)) => {
                    inner.set_phase(RepairPhase::SignInRequired);
                    return;
                }
                Either::Left((Err(CreateError::Message(message)), _)) => {
                    inner.set_phase(RepairPhase::Failed { message });
                    return;
                }
                Either::Right(_) => {
                    inner.set_phase(RepairPhase::Cancelled);
                    return;
                }
            }
        }
    };
    let bridge = match BridgeClient::new(&url, &token, allow_http) {
        Ok(bridge) => bridge,
        Err(_) => {
            finish_session(&inner).await;
            inner.set_phase(RepairPhase::Failed {
                message: UNAVAILABLE.into(),
            });
            return;
        }
    };
    inner.set_phase(RepairPhase::Working);
    let context = ToolContext {
        operation: inner.request.operation.wire(),
        error_message: inner.request.error_message.clone(),
        kind,
        verifier,
        pulled_bytes: 0,
    };
    let outcome = run_loop(&inner, workspace, context, bridge).await;
    finish_session(&inner).await;
    let phase = match (outcome.verified, outcome.end) {
        (Some(project_path), _) => RepairPhase::Fixed {
            project_path,
            summary: outcome.summary.unwrap_or_default(),
        },
        (None, LoopEnd::Cancelled) => RepairPhase::Cancelled,
        (None, LoopEnd::Done) => match (outcome.runner_error, outcome.finish) {
            (_, Some((FinishOutcome::CantFix, summary))) => RepairPhase::CantFix { summary },
            (_, Some((FinishOutcome::Fixed, _))) => RepairPhase::CantFix {
                summary: String::new(),
            },
            (Some(message), None) => RepairPhase::Failed { message },
            (None, None) => RepairPhase::CantFix {
                summary: String::new(),
            },
        },
        (None, LoopEnd::Lost(message)) => RepairPhase::Failed { message },
    };
    let diagnosis = match &phase {
        RepairPhase::CantFix { summary } if !summary.is_empty() => Some(summary.clone()),
        RepairPhase::Failed { message } => Some(message.clone()),
        _ => None,
    };
    inner
        .extra
        .lock()
        .unwrap_or_else(|poison| poison.into_inner())
        .diagnosis = diagnosis;
    inner.set_phase(phase);
}

async fn finish_session(inner: &Arc<Inner>) {
    let session_id = inner
        .extra
        .lock()
        .unwrap_or_else(|poison| poison.into_inner())
        .session_id
        .clone();
    if let Some(session_id) = session_id {
        stop_session(&session_id).await;
    }
}

enum LoopEnd {
    Done,
    Cancelled,
    Lost(String),
}

struct LoopOutcome {
    end: LoopEnd,
    verified: Option<PathBuf>,
    finish: Option<(FinishOutcome, String)>,
    summary: Option<String>,
    runner_error: Option<String>,
}

enum RequestState {
    Running,
    Answered(ToolResult),
}

struct WorkerMessage {
    result: ToolResult,
    fixed_path: Option<PathBuf>,
}

async fn worker(
    inner: Arc<Inner>,
    mut workspace: Workspace,
    mut context: ToolContext,
    bridge: BridgeClient,
    jobs: flume::Receiver<(String, ToolCall)>,
    results: flume::Sender<WorkerMessage>,
) -> Workspace {
    while let Ok((id, call)) = jobs.recv_async().await {
        if inner.is_cancelled() {
            continue;
        }
        let row = tools::row_for(&call);
        let index = inner.push_trace(TraceItem::Tool {
            verb: row.verb,
            target: row.target,
            meta: None,
            state: TraceState::Running,
        });
        let verifying = matches!(call, ToolCall::ApplyAndVerify);
        if verifying {
            inner.set_phase(RepairPhase::Verifying);
        }
        let (returned, result, finish) =
            tools::execute(workspace, call, &mut context, &bridge).await;
        workspace = returned;
        inner.update(|state| {
            if let Some(TraceItem::Tool {
                meta,
                state: row_state,
                ..
            }) = state.trace.get_mut(index)
            {
                *meta = finish.meta.clone();
                *row_state = finish.state;
            }
            if verifying && matches!(state.phase, RepairPhase::Verifying) {
                state.phase = RepairPhase::Working;
            }
        });
        let result = match result {
            Ok(value) => ToolResult::ok(id, value),
            Err(error) => ToolResult::err(id, workspace.redactor().text(&error)),
        };
        if results
            .send(WorkerMessage {
                result,
                fixed_path: finish.fixed_path,
            })
            .is_err()
        {
            break;
        }
    }
    workspace
}

fn record(
    message: WorkerMessage,
    pending: &mut Vec<ToolResult>,
    requests: &mut HashMap<String, RequestState>,
    outcome: &mut LoopOutcome,
) {
    if let Some(path) = message.fixed_path {
        outcome.verified = Some(path);
    }
    let id = match &message.result {
        ToolResult::Ok { id, .. } | ToolResult::Err { id, .. } => id.clone(),
    };
    requests.insert(id, RequestState::Answered(message.result.clone()));
    pending.push(message.result);
}

fn request_id(value: &Value) -> Option<String> {
    let id = value.get("id")?.as_str()?;
    (!id.is_empty() && id.len() <= MAX_REQUEST_ID).then(|| id.to_string())
}

fn apply_event(inner: &Inner, body: EventBody, outcome: &mut LoopOutcome) {
    match body {
        EventBody::Thought { text } => {
            let text = sanitize::clean(&text, sanitize::THOUGHT_LIMIT);
            if !text.is_empty() {
                inner.push_trace(TraceItem::Thought { text });
            }
        }
        EventBody::Step {
            id,
            title,
            detail,
            state,
        } => {
            let id = sanitize::truncate(&id, 64);
            let title = sanitize::clean(&title, sanitize::TITLE_LIMIT);
            if title.is_empty() {
                return;
            }
            let detail = detail
                .map(|detail| sanitize::clean(&detail, sanitize::DETAIL_LIMIT))
                .filter(|detail| !detail.is_empty());
            let state = match state {
                StepState::Running => TraceState::Running,
                StepState::Done => TraceState::Done,
                StepState::Failed => TraceState::Failed,
            };
            inner.update(|snapshot| {
                let existing = snapshot.trace.iter_mut().rev().find(
                    |item| matches!(item, TraceItem::Step { id: existing, .. } if *existing == id),
                );
                match existing {
                    Some(TraceItem::Step {
                        title: old_title,
                        detail: old_detail,
                        state: old_state,
                        ..
                    }) => {
                        *old_title = title;
                        *old_detail = detail;
                        *old_state = state;
                    }
                    _ => snapshot.trace.push(TraceItem::Step {
                        id,
                        title,
                        detail,
                        state,
                    }),
                }
            });
        }
        EventBody::Activity { verb, target } => {
            let target = sanitize::clean(&target, sanitize::TARGET_LIMIT);
            let verb = match verb {
                ActivityVerb::Read => ToolVerb::SourceRead,
                ActivityVerb::Search => ToolVerb::Search,
                ActivityVerb::Run => ToolVerb::Run,
                ActivityVerb::Edit => ToolVerb::Write,
            };
            inner.push_trace(TraceItem::Tool {
                verb,
                target,
                meta: None,
                state: TraceState::Done,
            });
        }
        EventBody::Finish {
            outcome: finish,
            summary,
        } => {
            let summary = sanitize::clean(&summary, sanitize::SUMMARY_LIMIT);
            outcome.summary = Some(summary.clone());
            outcome.finish = Some((finish, summary));
        }
        EventBody::Error { message } => {
            let message = sanitize::clean(&message, 300);
            outcome.runner_error = Some(if message.is_empty() {
                "The repair agent stopped unexpectedly.".into()
            } else {
                message
            });
        }
        EventBody::Unknown => {}
    }
}

async fn run_loop(
    inner: &Arc<Inner>,
    workspace: Workspace,
    context: ToolContext,
    bridge: BridgeClient,
) -> LoopOutcome {
    let (job_tx, job_rx) = flume::unbounded();
    let (result_tx, result_rx) = flume::unbounded::<WorkerMessage>();
    let worker_handle = tokio::spawn(worker(
        inner.clone(),
        workspace,
        context,
        bridge.clone(),
        job_rx,
        result_tx,
    ));
    let mut outcome = LoopOutcome {
        end: LoopEnd::Done,
        verified: None,
        finish: None,
        summary: None,
        runner_error: None,
    };
    let mut requests: HashMap<String, RequestState> = HashMap::new();
    let mut pending: Vec<ToolResult> = Vec::new();
    let mut cursor = 0u64;
    let mut failing_since: Option<Instant> = None;
    let mut backoff = Duration::from_millis(500);

    loop {
        if inner.is_cancelled() {
            outcome.end = LoopEnd::Cancelled;
            break;
        }
        while let Ok(message) = result_rx.try_recv() {
            record(message, &mut pending, &mut requests, &mut outcome);
        }
        let sent = pending.clone();
        let poll = Box::pin(bridge.poll(cursor, &sent));
        let wake = Box::pin(select(
            Box::pin(result_rx.recv_async()),
            Box::pin(inner.cancel_rx.recv_async()),
        ));
        match select(poll, wake).await {
            Either::Left((Ok(response), _)) => {
                failing_since = None;
                backoff = Duration::from_millis(500);
                pending.drain(..sent.len().min(pending.len()));
                for value in response.events {
                    let Some(event) = Event::parse(value) else {
                        continue;
                    };
                    if event.seq <= cursor {
                        continue;
                    }
                    cursor = event.seq;
                    apply_event(inner, event.body, &mut outcome);
                }
                cursor = cursor.max(response.cursor);
                for value in response.requests {
                    let Some(id) = request_id(&value) else {
                        continue;
                    };
                    match requests.get(&id) {
                        Some(RequestState::Answered(result)) => {
                            if !pending.contains(result) {
                                pending.push(result.clone());
                            }
                            continue;
                        }
                        Some(RequestState::Running) => continue,
                        None => {}
                    }
                    let parsed = serde_json::from_value::<RawRequest>(value)
                        .map_err(|_| "invalid request".to_string())
                        .and_then(|raw| {
                            if raw.id == id {
                                ToolCall::parse(&raw.tool, raw.args)
                            } else {
                                Err("invalid request".to_string())
                            }
                        });
                    let parsed = if requests.len() >= MAX_REQUESTS {
                        Err("request limit reached".to_string())
                    } else {
                        parsed
                    };
                    match parsed {
                        Ok(call) => {
                            requests.insert(id.clone(), RequestState::Running);
                            if job_tx.send((id, call)).is_err() {
                                outcome.end = LoopEnd::Lost(LOST.into());
                                break;
                            }
                        }
                        Err(error) => {
                            let result = ToolResult::err(id.clone(), error);
                            requests.insert(id, RequestState::Answered(result.clone()));
                            pending.push(result);
                        }
                    }
                }
                if matches!(outcome.end, LoopEnd::Lost(_)) {
                    break;
                }
                if response.done {
                    outcome.end = LoopEnd::Done;
                    break;
                }
            }
            Either::Left((Err(BridgeError::Unauthorized), _)) => {
                outcome.end = LoopEnd::Lost(LOST.into());
                break;
            }
            Either::Left((Err(BridgeError::Transient(error)), _)) => {
                tracing::debug!(%error, "repair bridge poll failed");
                let since = *failing_since.get_or_insert_with(Instant::now);
                if since.elapsed() > CONNECTION_GRACE {
                    outcome.end = LoopEnd::Lost(LOST.into());
                    break;
                }
                let sleep = Box::pin(tokio::time::sleep(backoff));
                let cancel = Box::pin(inner.cancel_rx.recv_async());
                if let Either::Right(_) = select(sleep, cancel).await {
                    outcome.end = LoopEnd::Cancelled;
                    break;
                }
                backoff = (backoff * 2).min(Duration::from_secs(5));
            }
            Either::Right((Either::Left((Ok(message), _)), _)) => {
                record(message, &mut pending, &mut requests, &mut outcome);
            }
            Either::Right((Either::Left((Err(_), _)), _)) => {
                outcome.end = LoopEnd::Lost("The repair stopped unexpectedly.".into());
                break;
            }
            Either::Right((Either::Right(_), _)) => {
                outcome.end = LoopEnd::Cancelled;
                break;
            }
        }
    }
    drop(job_tx);
    let workspace = worker_handle.await;
    while let Ok(message) = result_rx.try_recv() {
        if let Some(path) = message.fixed_path {
            outcome.verified = Some(path);
        }
    }
    match workspace {
        Ok(mut workspace) => {
            tokio::task::spawn_blocking(move || workspace.close())
                .await
                .ok();
        }
        Err(error) => {
            tracing::warn!(%error, "repair worker stopped");
            if outcome.verified.is_none() && !matches!(outcome.end, LoopEnd::Cancelled) {
                outcome.end = LoopEnd::Lost("The repair stopped unexpectedly.".into());
            }
        }
    }
    outcome
}

async fn run_submission(inner: &Arc<Inner>) {
    let (root, info) = {
        let extra = inner
            .extra
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        let root = extra
            .bundle_root
            .clone()
            .unwrap_or_else(|| inner.request.project_path.clone());
        let redactor = Redactor::for_bundle(&root).with_extra(&inner.request.display_name);
        (
            root,
            SubmissionInfo {
                operation: inner.request.operation.wire(),
                error_message: redactor.text(&inner.request.error_message),
                diagnosis: extra.diagnosis.clone(),
                session_id: extra.session_id.clone(),
            },
        )
    };
    inner.set_phase(RepairPhase::Sending {
        sent_bytes: 0,
        total_bytes: 0,
    });
    let progress_inner = inner.clone();
    let cancel_inner = inner.clone();
    let result = submission::send(
        root,
        info,
        move || cancel_inner.is_cancelled(),
        move |sent, total| {
            progress_inner.set_phase(RepairPhase::Sending {
                sent_bytes: sent,
                total_bytes: total,
            });
        },
    )
    .await;
    match result {
        Ok(()) => inner.set_phase(RepairPhase::Sent),
        Err(_) if inner.is_cancelled() => inner.set_phase(RepairPhase::Cancelled),
        Err(message) => inner.set_phase(RepairPhase::SendFailed { message }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    #[derive(Default)]
    struct MockLog {
        requests: Vec<Value>,
        events: Vec<Value>,
        done: bool,
    }

    struct MockBridge {
        script: Mutex<Vec<Value>>,
        received: Mutex<Vec<Value>>,
        polls: AtomicUsize,
        log: Mutex<MockLog>,
    }

    fn ready_reply(reply: &Value) -> bool {
        reply["requests"]
            .as_array()
            .is_some_and(|items| !items.is_empty())
            || reply["events"]
                .as_array()
                .is_some_and(|items| !items.is_empty())
            || reply["done"] == json!(true)
    }

    async fn read_request(stream: &mut tokio::net::TcpStream) -> Option<(String, Vec<u8>)> {
        let mut buffer = Vec::new();
        let mut chunk = [0u8; 8192];
        loop {
            let read = stream.read(&mut chunk).await.ok()?;
            if read == 0 {
                return None;
            }
            buffer.extend_from_slice(&chunk[..read]);
            if let Some(end) = buffer.windows(4).position(|window| window == b"\r\n\r\n") {
                let head = String::from_utf8_lossy(&buffer[..end]).to_string();
                let length = head
                    .lines()
                    .find_map(|line| {
                        let (name, value) = line.split_once(':')?;
                        name.eq_ignore_ascii_case("content-length")
                            .then(|| value.trim().parse::<usize>().ok())?
                    })
                    .unwrap_or(0);
                let mut body = buffer[end + 4..].to_vec();
                while body.len() < length {
                    let read = stream.read(&mut chunk).await.ok()?;
                    if read == 0 {
                        break;
                    }
                    body.extend_from_slice(&chunk[..read]);
                }
                return Some((head, body));
            }
        }
    }

    async fn serve(listener: tokio::net::TcpListener, mock: Arc<MockBridge>) {
        loop {
            let Ok((mut stream, _)) = listener.accept().await else {
                return;
            };
            let mock = mock.clone();
            tokio::spawn(async move {
                let Some((head, body)) = read_request(&mut stream).await else {
                    return;
                };
                assert!(
                    head.contains("authorization: Bearer")
                        || head.contains("Authorization: Bearer")
                );
                let request: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
                let cursor = request["cursor"].as_u64().unwrap_or(0);
                mock.received.lock().unwrap().push(request);
                mock.polls.fetch_add(1, Ordering::SeqCst);
                let answered: Vec<String> = mock
                    .received
                    .lock()
                    .unwrap()
                    .iter()
                    .flat_map(|poll| poll["results"].as_array().cloned().unwrap_or_default())
                    .filter_map(|result| result["id"].as_str().map(str::to_string))
                    .collect();
                let reply = {
                    let mut script = mock.script.lock().unwrap();
                    let mut log = mock.log.lock().unwrap();
                    let ready = script.first().is_some_and(|entry| {
                        entry["after"]
                            .as_str()
                            .is_none_or(|id| answered.iter().any(|answered| answered == id))
                    });
                    if ready {
                        let entry = script.remove(0);
                        log.requests
                            .extend(entry["requests"].as_array().cloned().unwrap_or_default());
                        log.events
                            .extend(entry["events"].as_array().cloned().unwrap_or_default());
                        log.done |= entry["done"] == json!(true);
                    }
                    let requests: Vec<Value> = log
                        .requests
                        .iter()
                        .filter(|request| {
                            !answered
                                .iter()
                                .any(|id| request["id"].as_str() == Some(id.as_str()))
                        })
                        .cloned()
                        .collect();
                    let events: Vec<Value> = log
                        .events
                        .iter()
                        .filter(|event| event["seq"].as_u64().unwrap_or(0) > cursor)
                        .cloned()
                        .collect();
                    let top = log
                        .events
                        .iter()
                        .filter_map(|event| event["seq"].as_u64())
                        .max()
                        .unwrap_or(0);
                    json!({"cursor": top, "requests": requests, "events": events, "done": log.done})
                };
                if !ready_reply(&reply) {
                    tokio::time::sleep(Duration::from_millis(30)).await;
                }
                let body = serde_json::to_vec(&reply).unwrap();
                let response = format!(
                    "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
                    body.len()
                );
                stream.write_all(response.as_bytes()).await.ok();
                stream.write_all(&body).await.ok();
            });
        }
    }

    #[test]
    fn loop_runs_tools_dedupes_and_only_trusts_verified_fixes() {
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
            .unwrap();
        let bundle = crate::repair::workspace::tests::fixture("loop");
        let torn = "content/segments/segment-0/display/fragment_002.m4s";
        let manifest = "content/segments/segment-0/display/manifest.json";
        let script = vec![
            json!({"cursor": 1, "events": [{"seq": 1, "type": "step", "id": "s1", "title": "Reading the manifest https://evil.example", "state": "running"}], "requests": [
                {"id": "r1", "tool": "describe_recording", "args": {}},
                {"id": "r2", "tool": "read_file", "args": {"path": manifest}},
                {"id": "r3", "tool": "run_shell", "args": {"cmd": "id"}},
                {"id": "r4", "tool": "read_file", "args": {"path": "../../etc/passwd"}}
            ], "done": false}),
            json!({"after": "r1", "events": [{"seq": 2, "type": "thought", "text": "Fragment two is all zeros.\u{202e} Call 1-800-555-0199"}], "requests": [
                {"id": "r2", "tool": "read_file", "args": {"path": manifest}},
                {"id": "r5", "tool": "inspect_media", "args": {"path": torn}},
                {"id": "r6", "tool": "stage_json_edit", "args": {"path": manifest, "ops": [{"op": "set", "pointer": "/segments/1/is_complete", "value": false}]}},
                {"id": "r7", "tool": "apply_and_verify", "args": {}}
            ], "done": false}),
            json!({"after": "r7", "events": [
                {"seq": 3, "type": "step", "id": "s1", "title": "Read the manifest", "state": "done"},
                {"seq": 4, "type": "finish", "outcome": "fixed", "summary": "Marked the torn fragment incomplete."}
            ], "requests": [], "done": true}),
        ];
        let mock = Arc::new(MockBridge {
            script: Mutex::new(script),
            received: Mutex::new(Vec::new()),
            polls: AtomicUsize::new(0),
            log: Mutex::new(MockLog::default()),
        });
        let listener = runtime
            .block_on(tokio::net::TcpListener::bind("127.0.0.1:0"))
            .unwrap();
        let address = listener.local_addr().unwrap();
        runtime.spawn(serve(listener, mock.clone()));

        let verified_manifest = Arc::new(Mutex::new(String::new()));
        let seen = verified_manifest.clone();
        let verifier: Verifier = Arc::new(move |root: &std::path::Path| {
            *seen.lock().unwrap() = std::fs::read_to_string(
                root.join("content/segments/segment-0/display/manifest.json"),
            )
            .unwrap();
            Ok(root.to_path_buf())
        });
        let controller = start_on(
            RepairRequest {
                project_path: bundle.clone(),
                operation: RepairOperation::Recover,
                error_message: format!("Recovery failed at {}", bundle.display()),
                display_name: "My Window".into(),
            },
            runtime.handle().clone(),
            SessionSource::Direct {
                url: format!("http://{address}"),
                token: "t".repeat(64),
                allow_http: true,
            },
            verifier,
        );
        let deadline = Instant::now() + Duration::from_secs(30);
        loop {
            let snapshot = controller.snapshot();
            if !snapshot.phase.is_active() {
                break;
            }
            assert!(
                Instant::now() < deadline,
                "loop did not finish: {:?}",
                snapshot.phase
            );
            std::thread::sleep(Duration::from_millis(50));
        }
        let snapshot = controller.snapshot();
        let RepairPhase::Fixed { summary, .. } = &snapshot.phase else {
            panic!("expected fixed, got {:?}", snapshot.phase);
        };
        assert_eq!(summary, "Marked the torn fragment incomplete.");
        assert!(verified_manifest.lock().unwrap().contains("false"));
        assert!(snapshot.finished_at.is_some());

        let steps: Vec<_> = snapshot
            .trace
            .iter()
            .filter_map(|item| match item {
                TraceItem::Step { title, state, .. } => Some((title.clone(), *state)),
                _ => None,
            })
            .collect();
        assert_eq!(
            steps,
            vec![("Read the manifest".to_string(), TraceState::Done)]
        );
        let thought = snapshot
            .trace
            .iter()
            .find_map(|item| match item {
                TraceItem::Thought { text } => Some(text.clone()),
                _ => None,
            })
            .unwrap();
        assert!(
            !thought.contains("555") && !thought.contains('\u{202e}'),
            "{thought}"
        );
        let reads = snapshot
            .trace
            .iter()
            .filter(|item| {
                matches!(
                    item,
                    TraceItem::Tool {
                        verb: ToolVerb::Read,
                        ..
                    }
                )
            })
            .count();
        assert_eq!(reads, 2);
        assert!(snapshot.trace.iter().any(|item| matches!(
            item,
            TraceItem::Tool {
                verb: ToolVerb::Verify,
                state: TraceState::Done,
                ..
            }
        )));

        let received = mock.received.lock().unwrap().clone();
        let results: Vec<Value> = received
            .iter()
            .flat_map(|poll| poll["results"].as_array().cloned().unwrap_or_default())
            .collect();
        let by_id = |id: &str| {
            results
                .iter()
                .filter(|r| r["id"] == json!(id))
                .cloned()
                .collect::<Vec<_>>()
        };
        assert_eq!(by_id("r3")[0]["error"], json!("unknown tool"));
        assert_eq!(by_id("r4")[0]["ok"], json!(false));
        assert_eq!(by_id("r1")[0]["result"]["kind"], json!("unknown"));
        assert!(
            !by_id("r1")[0]["result"]["errorMessage"]
                .as_str()
                .unwrap()
                .contains("My Window")
        );
        let manifest_read = &by_id("r2")[0]["result"];
        assert_eq!(manifest_read["encoding"], json!("utf8"));
        assert_eq!(by_id("r7")[0]["result"]["fixed"], json!(true));
        assert!(by_id("r5")[0]["result"]["allZero"].as_bool().unwrap());
        assert!(
            !bundle
                .join(".cap-repair")
                .read_dir()
                .unwrap()
                .any(|entry| { entry.unwrap().path().join("staged").exists() })
        );
        drop(runtime);
        std::fs::remove_dir_all(bundle.parent().unwrap()).ok();
    }

    fn phase_name(phase: &RepairPhase) -> &'static str {
        match phase {
            RepairPhase::SignInRequired => "sign_in_required",
            RepairPhase::Connecting => "connecting",
            RepairPhase::Working => "working",
            RepairPhase::Verifying => "verifying",
            RepairPhase::Fixed { .. } => "fixed",
            RepairPhase::CantFix { .. } => "cant_fix",
            RepairPhase::Failed { .. } => "failed",
            RepairPhase::Sending { .. } => "sending",
            RepairPhase::Sent => "sent",
            RepairPhase::SendFailed { .. } => "send_failed",
            RepairPhase::Cancelled => "cancelled",
        }
    }

    fn describe_item(item: &TraceItem) -> String {
        match item {
            TraceItem::Thought { text } => format!("THOUGHT {text}"),
            TraceItem::Step {
                id,
                title,
                detail,
                state,
            } => format!(
                "STEP {id} [{state:?}] {title}{}",
                detail
                    .as_deref()
                    .map(|detail| format!(" | {detail}"))
                    .unwrap_or_default()
            ),
            TraceItem::Tool {
                verb,
                target,
                meta,
                state,
            } => format!(
                "TOOL [{state:?}] {verb:?} {target}{}",
                meta.as_deref()
                    .map(|meta| format!(" ({meta})"))
                    .unwrap_or_default()
            ),
        }
    }

    #[test]
    #[ignore = "drives a live repair sandbox; set CAP_REPAIR_LIVE_* and CAP_REPAIR_DIRECT_BRIDGE"]
    fn live_bundle() {
        let bundle = PathBuf::from(
            std::env::var("CAP_REPAIR_LIVE_BUNDLE").expect("CAP_REPAIR_LIVE_BUNDLE is required"),
        );
        let operation = match std::env::var("CAP_REPAIR_LIVE_OP").as_deref() {
            Ok("recover") => RepairOperation::Recover,
            Ok("open") => RepairOperation::Open,
            other => panic!("CAP_REPAIR_LIVE_OP must be recover or open, got {other:?}"),
        };
        let given_error = std::env::var("CAP_REPAIR_LIVE_ERROR").unwrap_or_default();
        let source = direct_source_from_env()
            .expect("CAP_REPAIR_DIRECT_BRIDGE must be \"<https url> <token>\"");
        if operation == RepairOperation::Recover {
            let dirs = crate::library::known_recordings_dirs();
            assert!(
                dirs.iter().any(|dir| bundle.starts_with(dir)),
                "the real recover verifier only accepts bundles inside a recordings dir; set CAP_GPUI_RECORDINGS_DIR to the bundle's parent (known: {dirs:?})"
            );
        }
        let request = RepairRequest {
            display_name: bundle
                .file_stem()
                .map(|stem| stem.to_string_lossy().into_owned())
                .unwrap_or_default(),
            project_path: bundle.clone(),
            operation,
            error_message: given_error.clone(),
        };
        let verifier = live_verifier(&request);
        let request = if given_error.trim().is_empty() {
            match verifier(&bundle) {
                Ok(path) => {
                    println!("LIVE_ALREADY_OK {}", path.display());
                    return;
                }
                Err(error) => {
                    println!("LIVE_INITIAL_ERROR {error}");
                    RepairRequest {
                        error_message: error,
                        ..request
                    }
                }
            }
        } else {
            request
        };
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(4)
            .enable_all()
            .build()
            .unwrap();
        let controller = start_on(request, runtime.handle().clone(), source, verifier);
        let updates = controller.updates();
        let deadline = Instant::now() + Duration::from_secs(30 * 60);
        let mut printed: Vec<String> = Vec::new();
        let mut last_phase = String::new();
        let snapshot = loop {
            let snapshot = controller.snapshot();
            let phase = format!("{:?}", snapshot.phase);
            if phase != last_phase {
                println!("PHASE {phase}");
                last_phase = phase;
            }
            printed.truncate(snapshot.trace.len());
            for (index, item) in snapshot.trace.iter().enumerate() {
                let line = describe_item(item);
                if printed.get(index) != Some(&line) {
                    println!("[{index:03}] {line}");
                    if index < printed.len() {
                        printed[index] = line;
                    } else {
                        printed.push(line);
                    }
                }
            }
            if !snapshot.phase.is_active() {
                break snapshot;
            }
            if Instant::now() > deadline {
                controller.cancel();
                panic!("live repair did not settle within 30 minutes");
            }
            let _ = updates.recv_timeout(Duration::from_secs(1));
        };
        let (summary, project_path) = match &snapshot.phase {
            RepairPhase::Fixed {
                project_path,
                summary,
            } => (summary.clone(), Some(project_path.display().to_string())),
            RepairPhase::CantFix { summary } => (summary.clone(), None),
            RepairPhase::Failed { message } | RepairPhase::SendFailed { message } => {
                (message.clone(), None)
            }
            _ => (String::new(), None),
        };
        println!("FINAL {:?}", snapshot.phase);
        println!(
            "LIVE_RESULT {}",
            json!({
                "phase": phase_name(&snapshot.phase),
                "summary": summary,
                "projectPath": project_path,
                "elapsedSecs": snapshot
                    .finished_at
                    .unwrap_or_else(Instant::now)
                    .duration_since(snapshot.started_at)
                    .as_secs(),
                "traceItems": snapshot.trace.len(),
            })
        );
        drop(runtime);
    }

    #[test]
    fn unverified_fix_claims_become_cant_fix() {
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
            .unwrap();
        let bundle = crate::repair::workspace::tests::fixture("claim");
        let mock = Arc::new(MockBridge {
            script: Mutex::new(vec![json!({"cursor": 1, "events": [
                {"seq": 1, "type": "finish", "outcome": "fixed", "summary": "All fixed, trust me"}
            ], "requests": [], "done": true})]),
            received: Mutex::new(Vec::new()),
            polls: AtomicUsize::new(0),
            log: Mutex::new(MockLog::default()),
        });
        let listener = runtime
            .block_on(tokio::net::TcpListener::bind("127.0.0.1:0"))
            .unwrap();
        let address = listener.local_addr().unwrap();
        runtime.spawn(serve(listener, mock));
        let controller = start_on(
            RepairRequest {
                project_path: bundle.clone(),
                operation: RepairOperation::Open,
                error_message: "broken".into(),
                display_name: "x".into(),
            },
            runtime.handle().clone(),
            SessionSource::Direct {
                url: format!("http://{address}"),
                token: "t".repeat(64),
                allow_http: true,
            },
            Arc::new(|_: &std::path::Path| Err("still broken".into())),
        );
        let deadline = Instant::now() + Duration::from_secs(15);
        while controller.snapshot().phase.is_active() {
            assert!(Instant::now() < deadline);
            std::thread::sleep(Duration::from_millis(20));
        }
        assert!(matches!(
            controller.snapshot().phase,
            RepairPhase::CantFix { ref summary } if summary.is_empty()
        ));
        drop(runtime);
        std::fs::remove_dir_all(bundle.parent().unwrap()).ok();
    }
}
