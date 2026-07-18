use axum::{
    Json, Router,
    body::Bytes,
    extract::State as AxumState,
    http::{HeaderMap, HeaderName, HeaderValue, StatusCode, header},
    response::{IntoResponse, Response},
    routing::post,
};
use cap_recording::{RecordingMode, sources::screen_capture::ScreenCaptureTarget};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use serde_json::{Value, json};
use specta::Type;
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::Arc,
    time::{Duration, Instant},
};
use tauri::{AppHandle, Manager};
use tauri_plugin_store::StoreExt;
use tokio::{
    net::TcpListener,
    sync::{Mutex, RwLock, watch},
};
use tracing::{error, info, warn};

use crate::{
    permissions, recording, recording_settings, target_select_overlay, windows::ShowCapWindow,
};

const STORE_KEY: &str = "mcp";
const ENDPOINT_PATH: &str = "/mcp";
const PROTOCOL_VERSION: &str = "2025-11-25";
const SUPPORTED_PROTOCOL_VERSIONS: [&str; 2] = [PROTOCOL_VERSION, "2025-06-18"];
const SESSION_TTL: Duration = Duration::from_secs(30 * 60);
const SESSION_CLEANUP_INTERVAL: Duration = Duration::from_secs(60);

type SessionStore = Arc<RwLock<HashMap<String, McpSession>>>;

#[derive(Default)]
pub struct McpRuntimeState {
    server: Mutex<Option<McpServerHandle>>,
    sessions: SessionStore,
}

struct McpServerHandle {
    port: u16,
    shutdown: Option<watch::Sender<bool>>,
}

#[derive(Clone)]
struct HttpState {
    app: AppHandle,
    sessions: SessionStore,
}

#[derive(Clone)]
struct McpSession {
    protocol_version: String,
    last_activity: Instant,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", default)]
pub struct McpSettings {
    pub enabled: bool,
    pub token: Option<String>,
    pub port: Option<u16>,
    pub endpoint: Option<String>,
}

impl Default for McpSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            token: None,
            port: None,
            endpoint: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct McpServerConfig {
    pub enabled: bool,
    pub endpoint: Option<String>,
    pub token: Option<String>,
}

#[derive(Debug, Deserialize)]
struct JsonRpcMessage {
    jsonrpc: Option<String>,
    id: Option<Value>,
    method: Option<String>,
    params: Option<Value>,
}

enum RpcOutcome {
    Json {
        body: Value,
        session_id: Option<String>,
    },
    Accepted,
    HttpError {
        status: StatusCode,
        message: String,
    },
}

#[derive(Debug)]
enum ToolFailure {
    InvalidParams(String),
    Execution(String),
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct McpTool {
    name: &'static str,
    title: &'static str,
    description: &'static str,
    #[serde(rename = "inputSchema")]
    input_schema: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    annotations: Option<ToolAnnotations>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ToolAnnotations {
    #[serde(skip_serializing_if = "Option::is_none")]
    read_only_hint: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    destructive_hint: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    idempotent_hint: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    open_world_hint: Option<bool>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ToolCallParams {
    name: String,
    #[serde(default)]
    arguments: Value,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct StartRecordingArgs {
    capture_target: ScreenCaptureTarget,
    #[serde(default)]
    capture_system_audio: bool,
    mode: RecordingMode,
    #[serde(default)]
    organization_id: Option<String>,
}

#[derive(Deserialize)]
struct EmptyArgs {}

#[derive(Deserialize)]
struct PathArg {
    path: PathBuf,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ScreenshotPathArg {
    screenshot_path: PathBuf,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TextArg {
    text: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DeviceIdArg {
    device_id: String,
}

#[derive(Deserialize)]
struct NameArg {
    name: String,
}

#[derive(Deserialize)]
struct UrlArg {
    url: String,
}

#[derive(Deserialize)]
struct TargetArg {
    target: ScreenCaptureTarget,
}

#[derive(Deserialize)]
struct PermissionArg {
    permission: permissions::OSPermission,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PermissionsCheckArg {
    #[serde(default)]
    initial_check: bool,
}

#[derive(Deserialize)]
struct RecordingModeArg {
    mode: RecordingMode,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ShowWindowArg {
    window: String,
    #[serde(default)]
    page: Option<String>,
    #[serde(default)]
    centered: Option<bool>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TargetSelectArg {
    #[serde(default)]
    focused_target: Option<ScreenCaptureTarget>,
    #[serde(default)]
    specific_display_id: Option<String>,
    #[serde(default)]
    target_mode: Option<recording_settings::RecordingTargetMode>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DisplayInformationArg {
    display_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WindowIdArg {
    window_id: String,
}

pub fn init(app: &AppHandle) {
    app.manage(McpRuntimeState::default());

    let Ok(settings) = load_settings(app) else {
        return;
    };

    if settings.enabled {
        let app = app.clone();
        drop(tokio::spawn(async move {
            if let Err(err) = ensure_running(&app).await {
                warn!(error = %err, "Failed to start MCP server");
            }
        }));
    }
}

#[tauri::command]
#[specta::specta]
pub fn get_mcp_server_config(app: AppHandle) -> Result<McpServerConfig, String> {
    config_from_settings(&load_settings(&app)?)
}

#[tauri::command]
#[specta::specta]
pub async fn set_mcp_server_enabled(
    app: AppHandle,
    enabled: bool,
) -> Result<McpServerConfig, String> {
    let mut settings = load_settings(&app)?;
    settings.enabled = enabled;

    if enabled {
        ensure_token(&mut settings);
        save_settings(&app, &settings)?;
        ensure_running(&app).await?;
    } else {
        save_settings(&app, &settings)?;
        stop_running(&app).await?;
    }

    config_from_settings(&load_settings(&app)?)
}

#[tauri::command]
#[specta::specta]
pub async fn rotate_mcp_server_token(app: AppHandle) -> Result<McpServerConfig, String> {
    let mut settings = load_settings(&app)?;
    settings.token = Some(generate_token());
    save_settings(&app, &settings)?;

    if settings.enabled {
        stop_running(&app).await?;
        ensure_running(&app).await?;
    }

    config_from_settings(&load_settings(&app)?)
}

async fn ensure_running(app: &AppHandle) -> Result<(), String> {
    let runtime = app.state::<McpRuntimeState>();
    let mut settings = load_settings(app)?;

    if !settings.enabled {
        return Ok(());
    }

    ensure_token(&mut settings);

    let mut server = runtime.server.lock().await;
    if let Some(handle) = server.as_ref() {
        settings.port = Some(handle.port);
        settings.endpoint = Some(endpoint_for_port(handle.port));
        save_settings(app, &settings)?;
        return Ok(());
    }

    let listener = bind_listener(settings.port).await?;
    let port = listener
        .local_addr()
        .map_err(|err| format!("Failed to read MCP server address: {err}"))?
        .port();

    let (shutdown_tx, shutdown_rx) = watch::channel(false);
    let http_state = HttpState {
        app: app.clone(),
        sessions: runtime.sessions.clone(),
    };
    let router = Router::new()
        .route(
            ENDPOINT_PATH,
            post(post_mcp).get(get_mcp).delete(delete_mcp),
        )
        .with_state(http_state);

    let mut server_shutdown = shutdown_rx.clone();
    drop(tokio::spawn(async move {
        let server = axum::serve(listener, router).with_graceful_shutdown(async move {
            let _ = server_shutdown.changed().await;
        });

        if let Err(err) = server.await {
            error!(error = %err, "MCP server stopped with an error");
        }
    }));

    let sessions = runtime.sessions.clone();
    let mut cleanup_shutdown = shutdown_rx;
    drop(tokio::spawn(async move {
        let mut interval = tokio::time::interval(SESSION_CLEANUP_INTERVAL);
        interval.tick().await;

        loop {
            tokio::select! {
                _ = interval.tick() => prune_expired_sessions(&sessions, SESSION_TTL).await,
                _ = cleanup_shutdown.changed() => break,
            }
        }
    }));

    settings.port = Some(port);
    settings.endpoint = Some(endpoint_for_port(port));
    save_settings(app, &settings)?;

    *server = Some(McpServerHandle {
        port,
        shutdown: Some(shutdown_tx),
    });

    info!(endpoint = %endpoint_for_port(port), "MCP server started");
    Ok(())
}

async fn bind_listener(preferred_port: Option<u16>) -> Result<TcpListener, String> {
    if let Some(port) = preferred_port {
        match TcpListener::bind(("127.0.0.1", port)).await {
            Ok(listener) => return Ok(listener),
            Err(err) => warn!(port, error = %err, "Failed to reuse MCP server port"),
        }
    }

    TcpListener::bind(("127.0.0.1", 0))
        .await
        .map_err(|err| format!("Failed to bind MCP server: {err}"))
}

async fn stop_running(app: &AppHandle) -> Result<(), String> {
    let runtime = app.state::<McpRuntimeState>();

    if let Some(mut handle) = runtime.server.lock().await.take()
        && let Some(shutdown) = handle.shutdown.take()
    {
        let _ = shutdown.send(true);
    }

    runtime.sessions.write().await.clear();

    let mut settings = load_settings(app)?;
    settings.port = None;
    settings.endpoint = None;
    save_settings(app, &settings)
}

async fn post_mcp(
    AxumState(state): AxumState<HttpState>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    if let Err(response) = validate_http_gate(&state.app, &headers) {
        return response;
    }

    if let Err(response) = validate_protocol_header(&headers) {
        return response;
    }

    let message = match serde_json::from_slice::<JsonRpcMessage>(&body) {
        Ok(message) => message,
        Err(err) => {
            return json_response(rpc_error(None, -32700, format!("Parse error: {err}"), None));
        }
    };

    let session_id = header_string(&headers, mcp_session_id_header());
    match handle_rpc(
        Some(&state.app),
        state.sessions.clone(),
        message,
        session_id,
    )
    .await
    {
        RpcOutcome::Json { body, session_id } => {
            let mut response = Json(body).into_response();
            if let Some(session_id) = session_id {
                match HeaderValue::from_str(&session_id) {
                    Ok(value) => {
                        response
                            .headers_mut()
                            .insert(mcp_session_id_header(), value);
                    }
                    Err(err) => {
                        return http_json_error(
                            StatusCode::INTERNAL_SERVER_ERROR,
                            format!("Invalid MCP session id: {err}"),
                        );
                    }
                }
            }
            response
        }
        RpcOutcome::Accepted => StatusCode::ACCEPTED.into_response(),
        RpcOutcome::HttpError { status, message } => http_json_error(status, message),
    }
}

async fn get_mcp(AxumState(state): AxumState<HttpState>, headers: HeaderMap) -> Response {
    if let Err(response) = validate_http_gate(&state.app, &headers) {
        return response;
    }

    if let Err(response) = validate_protocol_header(&headers) {
        return response;
    }

    StatusCode::METHOD_NOT_ALLOWED.into_response()
}

async fn delete_mcp(AxumState(state): AxumState<HttpState>, headers: HeaderMap) -> Response {
    if let Err(response) = validate_http_gate(&state.app, &headers) {
        return response;
    }

    if let Err(response) = validate_protocol_header(&headers) {
        return response;
    }

    let Some(session_id) = header_string(&headers, mcp_session_id_header()) else {
        return http_json_error(StatusCode::BAD_REQUEST, "Missing MCP session id");
    };

    if state.sessions.write().await.remove(&session_id).is_some() {
        StatusCode::ACCEPTED.into_response()
    } else {
        http_json_error(StatusCode::NOT_FOUND, "MCP session not found")
    }
}

async fn handle_rpc(
    app: Option<&AppHandle>,
    sessions: SessionStore,
    message: JsonRpcMessage,
    session_id: Option<String>,
) -> RpcOutcome {
    if message.jsonrpc.as_deref() != Some("2.0") {
        return RpcOutcome::Json {
            body: rpc_error(message.id, -32600, "Invalid JSON-RPC request", None),
            session_id: None,
        };
    }

    let Some(method) = message.method.as_deref() else {
        return RpcOutcome::Accepted;
    };

    let Some(id) = message.id.clone() else {
        if method == "initialize" {
            return RpcOutcome::Accepted;
        }

        return validate_existing_session(&sessions, session_id)
            .await
            .map(|_| RpcOutcome::Accepted)
            .unwrap_or_else(|message| RpcOutcome::HttpError {
                status: StatusCode::BAD_REQUEST,
                message,
            });
    };

    if method == "initialize" {
        return handle_initialize(sessions, id, message.params).await;
    }

    let session = match validate_existing_session(&sessions, session_id).await {
        Ok(session) => session,
        Err(message) => {
            return RpcOutcome::HttpError {
                status: StatusCode::BAD_REQUEST,
                message,
            };
        }
    };

    if !is_supported_protocol_version(&session.protocol_version) {
        return RpcOutcome::HttpError {
            status: StatusCode::BAD_REQUEST,
            message: "Unsupported MCP protocol version".to_string(),
        };
    }

    match handle_request(app, method, message.params).await {
        Ok(result) => RpcOutcome::Json {
            body: rpc_result(id, result),
            session_id: None,
        },
        Err((code, message)) => RpcOutcome::Json {
            body: rpc_error(Some(id), code, message, None),
            session_id: None,
        },
    }
}

async fn handle_initialize(sessions: SessionStore, id: Value, params: Option<Value>) -> RpcOutcome {
    let requested_version = params
        .as_ref()
        .and_then(|params| params.get("protocolVersion"))
        .and_then(Value::as_str)
        .unwrap_or(PROTOCOL_VERSION);

    if !is_supported_protocol_version(requested_version) {
        return RpcOutcome::Json {
            body: rpc_error(
                Some(id),
                -32602,
                format!("Unsupported MCP protocol version: {requested_version}"),
                None,
            ),
            session_id: None,
        };
    }

    let session_id = uuid::Uuid::new_v4().to_string();
    sessions.write().await.insert(
        session_id.clone(),
        McpSession {
            protocol_version: requested_version.to_string(),
            last_activity: Instant::now(),
        },
    );

    RpcOutcome::Json {
        body: rpc_result(
            id,
            json!({
                "protocolVersion": requested_version,
                "capabilities": {
                    "tools": {
                        "listChanged": false
                    }
                },
                "serverInfo": {
                    "name": "cap-desktop",
                    "version": env!("CARGO_PKG_VERSION")
                }
            }),
        ),
        session_id: Some(session_id),
    }
}

async fn handle_request(
    app: Option<&AppHandle>,
    method: &str,
    params: Option<Value>,
) -> Result<Value, (i64, String)> {
    match method {
        "ping" => Ok(json!({})),
        "tools/list" => Ok(json!({ "tools": tool_definitions() })),
        "tools/call" => {
            let params = params.unwrap_or_else(|| json!({}));
            let call = serde_json::from_value::<ToolCallParams>(params)
                .map_err(|err| (-32602, format!("Invalid tools/call params: {err}")))?;
            let arguments = normalize_arguments(call.arguments);
            let Some(app) = app else {
                return Err((-32603, "Cap Desktop app handle is unavailable".to_string()));
            };

            match execute_tool(app, &call.name, arguments).await {
                Ok(value) => Ok(tool_result(value, false)),
                Err(ToolFailure::InvalidParams(message)) => Err((-32602, message)),
                Err(ToolFailure::Execution(message)) => Ok(tool_result(json!(message), true)),
            }
        }
        _ => Err((-32601, format!("Method not found: {method}"))),
    }
}

async fn execute_tool(app: &AppHandle, name: &str, arguments: Value) -> Result<Value, ToolFailure> {
    match name {
        "get_mcp_status" => {
            value_result(get_mcp_server_config(app.clone()).map(redacted_mcp_status))
        }
        "get_current_recording" => {
            let _: EmptyArgs = deserialize_arguments(arguments)?;
            value_result(
                crate::get_current_recording(app.state())
                    .await
                    .map_err(|_| "Failed to get current recording".to_string()),
            )
        }
        "start_recording" => {
            let args: StartRecordingArgs = deserialize_arguments(arguments)?;
            value_result(
                recording::start_recording(
                    app.clone(),
                    app.state(),
                    recording::StartRecordingInputs {
                        capture_target: args.capture_target,
                        capture_system_audio: args.capture_system_audio,
                        mode: args.mode,
                        organization_id: args.organization_id,
                    },
                )
                .await,
            )
        }
        "stop_recording" => {
            let _: EmptyArgs = deserialize_arguments(arguments)?;
            value_result(recording::stop_recording(app.clone(), app.state()).await)
        }
        "pause_recording" => {
            let _: EmptyArgs = deserialize_arguments(arguments)?;
            value_result(recording::pause_recording(app.clone(), app.state()).await)
        }
        "resume_recording" => {
            let _: EmptyArgs = deserialize_arguments(arguments)?;
            value_result(recording::resume_recording(app.clone(), app.state()).await)
        }
        "toggle_pause_recording" => {
            let _: EmptyArgs = deserialize_arguments(arguments)?;
            value_result(recording::toggle_pause_recording(app.clone(), app.state()).await)
        }
        "restart_recording" => {
            let _: EmptyArgs = deserialize_arguments(arguments)?;
            value_result(recording::restart_recording(app.clone(), app.state()).await)
        }
        "delete_recording" => {
            let _: EmptyArgs = deserialize_arguments(arguments)?;
            value_result(recording::delete_recording(app.clone(), app.state()).await)
        }
        "take_screenshot" => {
            let args: TargetArg = deserialize_arguments(arguments)?;
            value_result(recording::take_screenshot(app.clone(), args.target).await)
        }
        "list_capture_displays" => {
            let _: EmptyArgs = deserialize_arguments(arguments)?;
            value_result(Ok::<_, String>(recording::list_capture_displays().await))
        }
        "list_capture_windows" => {
            let _: EmptyArgs = deserialize_arguments(arguments)?;
            value_result(Ok::<_, String>(recording::list_capture_windows().await))
        }
        "list_displays_with_thumbnails" => {
            let _: EmptyArgs = deserialize_arguments(arguments)?;
            value_result(recording::list_displays_with_thumbnails().await)
        }
        "list_windows_with_thumbnails" => {
            let _: EmptyArgs = deserialize_arguments(arguments)?;
            value_result(recording::list_windows_with_thumbnails().await)
        }
        "open_target_select_overlays" => {
            let args: TargetSelectArg = deserialize_arguments(arguments)?;
            value_result(
                target_select_overlay::open_target_select_overlays(
                    app.clone(),
                    app.state(),
                    args.focused_target,
                    args.specific_display_id,
                    args.target_mode,
                )
                .await,
            )
        }
        "close_target_select_overlays" => {
            let _: EmptyArgs = deserialize_arguments(arguments)?;
            value_result(
                target_select_overlay::close_target_select_overlays(app.clone(), app.state()).await,
            )
        }
        "display_information" => {
            let args: DisplayInformationArg = deserialize_arguments(arguments)?;
            value_result(target_select_overlay::display_information(&args.display_id).await)
        }
        "get_window_icon" => {
            let args: WindowIdArg = deserialize_arguments(arguments)?;
            value_result(target_select_overlay::get_window_icon(&args.window_id).await)
        }
        "focus_window" => {
            let args: WindowIdArg = deserialize_arguments(arguments)?;
            let window_id = args
                .window_id
                .parse()
                .map_err(|err| ToolFailure::InvalidParams(format!("Invalid windowId: {err}")))?;
            value_result(target_select_overlay::focus_window(window_id).await)
        }
        "list_cameras" => {
            let _: EmptyArgs = deserialize_arguments(arguments)?;
            value_result(Ok::<_, String>(recording::list_cameras()))
        }
        "get_camera_formats" => {
            let args: DeviceIdArg = deserialize_arguments(arguments)?;
            value_result(Ok::<_, String>(recording::get_camera_formats(
                args.device_id,
            )))
        }
        "get_microphone_info" => {
            let args: NameArg = deserialize_arguments(arguments)?;
            value_result(Ok::<_, String>(recording::get_microphone_info(args.name)))
        }
        "list_audio_devices" => {
            let _: EmptyArgs = deserialize_arguments(arguments)?;
            value_result(
                crate::list_audio_devices()
                    .await
                    .map_err(|_| "Failed to list audio devices".to_string()),
            )
        }
        "get_devices_snapshot" => {
            let _: EmptyArgs = deserialize_arguments(arguments)?;
            value_result(Ok::<_, String>(crate::get_devices_snapshot().await))
        }
        "do_permissions_check" => {
            let args: PermissionsCheckArg = deserialize_arguments(arguments)?;
            value_result(Ok::<_, String>(permissions::do_permissions_check(
                args.initial_check,
            )))
        }
        "request_permission" => {
            let args: PermissionArg = deserialize_arguments(arguments)?;
            permissions::request_permission(app.clone(), args.permission).await;
            Ok(Value::Null)
        }
        "open_permission_settings" => {
            let args: PermissionArg = deserialize_arguments(arguments)?;
            permissions::open_permission_settings(app.clone(), args.permission);
            Ok(Value::Null)
        }
        "set_recording_mode" => {
            let args: RecordingModeArg = deserialize_arguments(arguments)?;
            value_result(recording_settings::set_recording_mode(
                app.clone(),
                args.mode,
            ))
        }
        "list_recordings" => {
            let _: EmptyArgs = deserialize_arguments(arguments)?;
            value_result(crate::list_recordings(app.clone()))
        }
        "list_screenshots" => {
            let _: EmptyArgs = deserialize_arguments(arguments)?;
            value_result(crate::list_screenshots(app.clone()))
        }
        "start_video_import" => {
            let args: PathArg = deserialize_arguments(arguments)?;
            value_result(crate::import::start_video_import(app.clone(), args.path).await)
        }
        "start_image_import" => {
            let args: PathArg = deserialize_arguments(arguments)?;
            value_result(crate::import::start_image_import(app.clone(), args.path).await)
        }
        "copy_video_to_clipboard" => {
            let args: PathArg = deserialize_arguments(arguments)?;
            value_result(
                crate::copy_video_to_clipboard(
                    app.clone(),
                    app.state(),
                    args.path.to_string_lossy().into_owned(),
                )
                .await,
            )
        }
        "copy_screenshot_to_clipboard" => {
            let args: PathArg = deserialize_arguments(arguments)?;
            value_result(
                crate::copy_screenshot_to_clipboard(
                    app.state(),
                    args.path.to_string_lossy().into_owned(),
                )
                .await,
            )
        }
        "write_clipboard_string" => {
            let args: TextArg = deserialize_arguments(arguments)?;
            value_result(crate::write_clipboard_string(app.state(), args.text).await)
        }
        "open_file_path" => {
            let args: PathArg = deserialize_arguments(arguments)?;
            value_result(crate::open_file_path(app.clone(), args.path).await)
        }
        "upload_screenshot" => {
            let args: ScreenshotPathArg = deserialize_arguments(arguments)?;
            upload_result(
                crate::upload_screenshot(app.clone(), app.state(), args.screenshot_path).await,
            )
        }
        "upload_logs" => {
            let _: EmptyArgs = deserialize_arguments(arguments)?;
            value_result(crate::upload_logs(app.clone()).await)
        }
        "get_system_diagnostics" => {
            let _: EmptyArgs = deserialize_arguments(arguments)?;
            value_result(Ok::<_, String>(crate::get_system_diagnostics()))
        }
        "show_window" => {
            let args: ShowWindowArg = deserialize_arguments(arguments)?;
            let window = basic_window(args)?;
            value_result(crate::show_window(app.clone(), window).await)
        }
        "focus_captures_panel" => {
            let _: EmptyArgs = deserialize_arguments(arguments)?;
            crate::focus_captures_panel(app.clone());
            Ok(Value::Null)
        }
        "open_external_link" => {
            let args: UrlArg = deserialize_arguments(arguments)?;
            value_result(crate::open_external_link(app.clone(), args.url))
        }
        _ => Err(ToolFailure::InvalidParams(format!("Unknown tool: {name}"))),
    }
}

fn basic_window(args: ShowWindowArg) -> Result<ShowCapWindow, ToolFailure> {
    match args.window.as_str() {
        "main" => Ok(ShowCapWindow::Main {
            init_target_mode: None,
        }),
        "settings" => Ok(ShowCapWindow::Settings { page: args.page }),
        "recordingsOverlay" => Ok(ShowCapWindow::RecordingsOverlay),
        "camera" => Ok(ShowCapWindow::Camera {
            centered: args.centered.unwrap_or(false),
        }),
        "upgrade" => Ok(ShowCapWindow::Upgrade),
        "modeSelect" => Ok(ShowCapWindow::ModeSelect),
        "onboarding" => Ok(ShowCapWindow::Onboarding),
        value => Err(ToolFailure::InvalidParams(format!(
            "Unsupported window: {value}"
        ))),
    }
}

fn deserialize_arguments<T: DeserializeOwned>(arguments: Value) -> Result<T, ToolFailure> {
    serde_json::from_value(arguments)
        .map_err(|err| ToolFailure::InvalidParams(format!("Invalid tool arguments: {err}")))
}

fn normalize_arguments(arguments: Value) -> Value {
    match arguments {
        Value::Null => json!({}),
        value => value,
    }
}

fn value_result<T: Serialize>(result: Result<T, String>) -> Result<Value, ToolFailure> {
    match result {
        Ok(value) => serde_json::to_value(value)
            .map_err(|err| ToolFailure::Execution(format!("Failed to serialize result: {err}"))),
        Err(err) => Err(ToolFailure::Execution(err)),
    }
}

fn redacted_mcp_status(config: McpServerConfig) -> Value {
    json!({
        "enabled": config.enabled,
        "endpoint": config.endpoint,
        "protocolVersion": PROTOCOL_VERSION,
        "tokenConfigured": config.token.is_some_and(|token| !token.is_empty()),
        "sessionTtlSeconds": SESSION_TTL.as_secs()
    })
}

fn upload_result(result: Result<crate::UploadResult, String>) -> Result<Value, ToolFailure> {
    match result {
        Ok(success @ crate::UploadResult::Success(_)) => value_result(Ok(success)),
        Ok(crate::UploadResult::NotAuthenticated) => Err(ToolFailure::Execution(
            "NotAuthenticated: Sign in to Cap before uploading a screenshot.".to_string(),
        )),
        Ok(crate::UploadResult::PlanCheckFailed) => Err(ToolFailure::Execution(
            "PlanCheckFailed: The current Cap plan cannot upload this screenshot.".to_string(),
        )),
        Ok(crate::UploadResult::UpgradeRequired) => Err(ToolFailure::Execution(
            "UpgradeRequired: Upgrade Cap before uploading this screenshot.".to_string(),
        )),
        Err(err) => Err(ToolFailure::Execution(err)),
    }
}

fn tool_result(value: Value, is_error: bool) -> Value {
    let text = match value {
        Value::String(ref text) if is_error => text.clone(),
        _ => serde_json::to_string_pretty(&value).unwrap_or_else(|err| {
            format!("Failed to serialize tool result for text fallback: {err}")
        }),
    };

    let mut result = json!({
        "content": [
            {
                "type": "text",
                "text": text
            }
        ],
        "isError": is_error
    });

    if !is_error {
        result["structuredContent"] = match value {
            object @ Value::Object(_) => object,
            value => json!({ "result": value }),
        };
    }

    result
}

fn validate_existing_session(
    sessions: &SessionStore,
    session_id: Option<String>,
) -> impl std::future::Future<Output = Result<McpSession, String>> + '_ {
    async move {
        let Some(session_id) = session_id else {
            return Err("Missing MCP session id".to_string());
        };

        let mut sessions = sessions.write().await;
        let Some(session) = sessions.get(&session_id) else {
            return Err("MCP session not found".to_string());
        };

        if session.last_activity.elapsed() >= SESSION_TTL {
            sessions.remove(&session_id);
            return Err("MCP session expired".to_string());
        }

        let session = sessions
            .get_mut(&session_id)
            .expect("validated MCP session disappeared");
        session.last_activity = Instant::now();
        Ok(session.clone())
    }
}

async fn prune_expired_sessions(sessions: &SessionStore, ttl: Duration) {
    sessions
        .write()
        .await
        .retain(|_, session| session.last_activity.elapsed() < ttl);
}

fn validate_http_gate(app: &AppHandle, headers: &HeaderMap) -> Result<(), Response> {
    validate_origin(headers)?;

    let settings = load_settings(app)
        .map_err(|err| http_json_error(StatusCode::INTERNAL_SERVER_ERROR, err))?;

    validate_authorization(&settings, headers)
}

fn validate_authorization(settings: &McpSettings, headers: &HeaderMap) -> Result<(), Response> {
    if !settings.enabled {
        return Err(http_json_error(
            StatusCode::FORBIDDEN,
            "MCP server is disabled",
        ));
    }

    let Some(token) = settings.token.as_deref().filter(|token| !token.is_empty()) else {
        return Err(http_json_error(
            StatusCode::FORBIDDEN,
            "MCP server token is not configured",
        ));
    };

    let Some(auth) = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
    else {
        return Err(http_json_error(
            StatusCode::UNAUTHORIZED,
            "Missing Authorization bearer token",
        ));
    };

    if auth.strip_prefix("Bearer ") != Some(token) {
        return Err(http_json_error(
            StatusCode::UNAUTHORIZED,
            "Invalid Authorization bearer token",
        ));
    }

    Ok(())
}

fn validate_origin(headers: &HeaderMap) -> Result<(), Response> {
    let Some(origin) = headers.get(header::ORIGIN).and_then(|v| v.to_str().ok()) else {
        return Ok(());
    };

    if is_local_origin(origin) {
        Ok(())
    } else {
        Err(http_json_error(
            StatusCode::FORBIDDEN,
            "Origin is not allowed for local MCP",
        ))
    }
}

fn is_local_origin(origin: &str) -> bool {
    let Some(rest) = origin
        .strip_prefix("http://")
        .or_else(|| origin.strip_prefix("https://"))
    else {
        return false;
    };

    let authority = rest.split('/').next().unwrap_or(rest);
    let host = if let Some(stripped) = authority.strip_prefix('[') {
        match stripped.split_once(']') {
            Some((host, port)) if port.is_empty() || valid_port_suffix(port) => host,
            _ => return false,
        }
    } else if let Some((host, port)) = authority.rsplit_once(':') {
        if port.parse::<u16>().is_ok() {
            host
        } else {
            authority
        }
    } else {
        authority
    };

    matches!(host, "localhost" | "127.0.0.1" | "::1")
}

fn valid_port_suffix(port: &str) -> bool {
    port.is_empty()
        || port
            .strip_prefix(':')
            .is_some_and(|v| v.parse::<u16>().is_ok())
}

fn validate_protocol_header(headers: &HeaderMap) -> Result<(), Response> {
    let Some(version) = headers
        .get(mcp_protocol_version_header())
        .and_then(|v| v.to_str().ok())
    else {
        return Ok(());
    };

    if is_supported_protocol_version(version) {
        Ok(())
    } else {
        Err(http_json_error(
            StatusCode::BAD_REQUEST,
            "Unsupported MCP protocol version",
        ))
    }
}

fn is_supported_protocol_version(version: &str) -> bool {
    SUPPORTED_PROTOCOL_VERSIONS.contains(&version)
}

fn mcp_session_id_header() -> HeaderName {
    HeaderName::from_static("mcp-session-id")
}

fn mcp_protocol_version_header() -> HeaderName {
    HeaderName::from_static("mcp-protocol-version")
}

fn header_string(headers: &HeaderMap, name: HeaderName) -> Option<String> {
    headers
        .get(name)
        .and_then(|value| value.to_str().ok())
        .map(str::to_string)
}

fn json_response(value: Value) -> Response {
    Json(value).into_response()
}

fn http_json_error(status: StatusCode, message: impl Into<String>) -> Response {
    (
        status,
        Json(json!({
            "error": message.into()
        })),
    )
        .into_response()
}

fn rpc_result(id: Value, result: Value) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "result": result
    })
}

fn rpc_error(
    id: Option<Value>,
    code: i64,
    message: impl Into<String>,
    data: Option<Value>,
) -> Value {
    let mut error = json!({
        "code": code,
        "message": message.into()
    });

    if let Some(data) = data {
        error["data"] = data;
    }

    json!({
        "jsonrpc": "2.0",
        "id": id.unwrap_or(Value::Null),
        "error": error
    })
}

fn load_settings(app: &AppHandle) -> Result<McpSettings, String> {
    match app.store("store").map(|store| store.get(STORE_KEY)) {
        Ok(Some(value)) => serde_json::from_value(value)
            .map_err(|err| format!("Failed to deserialize MCP settings: {err}")),
        Ok(None) => Ok(McpSettings::default()),
        Err(err) => Err(format!("Failed to load MCP settings: {err}")),
    }
}

fn save_settings(app: &AppHandle, settings: &McpSettings) -> Result<(), String> {
    let store = app.store("store").map_err(|err| err.to_string())?;
    store.set(STORE_KEY, json!(settings));
    store.save().map_err(|err| err.to_string())
}

fn config_from_settings(settings: &McpSettings) -> Result<McpServerConfig, String> {
    Ok(McpServerConfig {
        enabled: settings.enabled,
        endpoint: settings
            .port
            .map(endpoint_for_port)
            .or_else(|| settings.endpoint.clone()),
        token: settings.token.clone(),
    })
}

fn ensure_token(settings: &mut McpSettings) {
    if settings.token.as_deref().is_none_or(str::is_empty) {
        settings.token = Some(generate_token());
    }
}

fn generate_token() -> String {
    format!(
        "cap_mcp_{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    )
}

fn endpoint_for_port(port: u16) -> String {
    format!("http://127.0.0.1:{port}{ENDPOINT_PATH}")
}

fn tool_definitions() -> Vec<McpTool> {
    vec![
        read_only_tool(
            "get_mcp_status",
            "Get MCP Status",
            "Return the local MCP endpoint status.",
            no_args_schema(),
        ),
        read_only_tool(
            "get_current_recording",
            "Get Current Recording",
            "Return the active or pending recording, if any.",
            no_args_schema(),
        ),
        tool(
            "start_recording",
            "Start Recording",
            "Start a Cap recording for a display, window, area, or camera target.",
            start_recording_schema(),
            ToolAnnotations::mutating(),
        ),
        tool(
            "stop_recording",
            "Stop Recording",
            "Stop and finalize the current recording.",
            no_args_schema(),
            ToolAnnotations::mutating(),
        ),
        tool(
            "pause_recording",
            "Pause Recording",
            "Pause the current recording.",
            no_args_schema(),
            ToolAnnotations::mutating(),
        ),
        tool(
            "resume_recording",
            "Resume Recording",
            "Resume the current recording.",
            no_args_schema(),
            ToolAnnotations::mutating(),
        ),
        tool(
            "toggle_pause_recording",
            "Toggle Pause Recording",
            "Toggle the current recording between paused and recording states.",
            no_args_schema(),
            ToolAnnotations::mutating(),
        ),
        tool(
            "restart_recording",
            "Restart Recording",
            "Discard the current recording and start a new one with the same inputs.",
            no_args_schema(),
            ToolAnnotations::destructive(),
        ),
        tool(
            "delete_recording",
            "Delete Current Recording",
            "Discard and delete the current recording.",
            no_args_schema(),
            ToolAnnotations::destructive(),
        ),
        tool(
            "take_screenshot",
            "Take Screenshot",
            "Capture a screenshot for a display, window, or area target.",
            target_schema("target"),
            ToolAnnotations::mutating(),
        ),
        read_only_tool(
            "list_capture_displays",
            "List Capture Displays",
            "List displays available to Cap for capture.",
            no_args_schema(),
        ),
        read_only_tool(
            "list_capture_windows",
            "List Capture Windows",
            "List windows available to Cap for capture.",
            no_args_schema(),
        ),
        read_only_tool(
            "list_displays_with_thumbnails",
            "List Displays With Thumbnails",
            "List capturable displays with thumbnail images.",
            no_args_schema(),
        ),
        read_only_tool(
            "list_windows_with_thumbnails",
            "List Windows With Thumbnails",
            "List capturable windows with thumbnail images.",
            no_args_schema(),
        ),
        tool(
            "open_target_select_overlays",
            "Open Target Select Overlays",
            "Open Cap target selection overlays.",
            target_select_schema(),
            ToolAnnotations::mutating(),
        ),
        tool(
            "close_target_select_overlays",
            "Close Target Select Overlays",
            "Close Cap target selection overlays.",
            no_args_schema(),
            ToolAnnotations::mutating(),
        ),
        read_only_tool(
            "display_information",
            "Display Information",
            "Return display metadata for a display id.",
            string_arg_schema("displayId"),
        ),
        read_only_tool(
            "get_window_icon",
            "Get Window Icon",
            "Return a base64 window icon for a window id when available.",
            string_arg_schema("windowId"),
        ),
        tool(
            "focus_window",
            "Focus Window",
            "Focus a desktop window by id.",
            string_arg_schema("windowId"),
            ToolAnnotations::open_world(),
        ),
        read_only_tool(
            "list_cameras",
            "List Cameras",
            "List cameras visible to Cap.",
            no_args_schema(),
        ),
        read_only_tool(
            "get_camera_formats",
            "Get Camera Formats",
            "List supported formats for a camera device id.",
            string_arg_schema("deviceId"),
        ),
        read_only_tool(
            "get_microphone_info",
            "Get Microphone Info",
            "Return format details for a microphone name.",
            string_arg_schema("name"),
        ),
        read_only_tool(
            "list_audio_devices",
            "List Audio Devices",
            "List microphone device names visible to Cap.",
            no_args_schema(),
        ),
        read_only_tool(
            "get_devices_snapshot",
            "Get Devices Snapshot",
            "Return cameras, microphones, and permission state.",
            no_args_schema(),
        ),
        read_only_tool(
            "do_permissions_check",
            "Check Permissions",
            "Return Cap desktop capture permission status.",
            permissions_check_schema(),
        ),
        tool(
            "request_permission",
            "Request Permission",
            "Ask the OS for a Cap desktop permission.",
            permission_schema(),
            ToolAnnotations::open_world(),
        ),
        tool(
            "open_permission_settings",
            "Open Permission Settings",
            "Open the OS permission settings for a Cap permission.",
            permission_schema(),
            ToolAnnotations::open_world(),
        ),
        tool(
            "set_recording_mode",
            "Set Recording Mode",
            "Persist the default Cap recording mode.",
            recording_mode_schema(),
            ToolAnnotations::mutating(),
        ),
        read_only_tool(
            "list_recordings",
            "List Recordings",
            "List recordings in the Cap desktop library.",
            no_args_schema(),
        ),
        read_only_tool(
            "list_screenshots",
            "List Screenshots",
            "List screenshots in the Cap desktop library.",
            no_args_schema(),
        ),
        tool(
            "start_video_import",
            "Import Video",
            "Import a local video into Cap.",
            path_schema("path"),
            ToolAnnotations::mutating(),
        ),
        tool(
            "start_image_import",
            "Import Image",
            "Import a local image into Cap.",
            path_schema("path"),
            ToolAnnotations::mutating(),
        ),
        tool(
            "copy_video_to_clipboard",
            "Copy Video To Clipboard",
            "Copy a local video file path to the clipboard.",
            path_schema("path"),
            ToolAnnotations::open_world(),
        ),
        tool(
            "copy_screenshot_to_clipboard",
            "Copy Screenshot To Clipboard",
            "Copy a screenshot image to the clipboard.",
            path_schema("path"),
            ToolAnnotations::open_world(),
        ),
        tool(
            "write_clipboard_string",
            "Write Clipboard String",
            "Write text to the system clipboard.",
            string_arg_schema("text"),
            ToolAnnotations::open_world(),
        ),
        tool(
            "open_file_path",
            "Open File Path",
            "Open a local file or folder with the operating system.",
            path_schema("path"),
            ToolAnnotations::open_world(),
        ),
        tool(
            "upload_screenshot",
            "Upload Screenshot",
            "Upload a Cap screenshot and copy its share link.",
            path_schema("screenshotPath"),
            ToolAnnotations::network(),
        ),
        tool(
            "upload_logs",
            "Upload Logs",
            "Upload Cap desktop logs for diagnostics.",
            no_args_schema(),
            ToolAnnotations::network(),
        ),
        read_only_tool(
            "get_system_diagnostics",
            "Get System Diagnostics",
            "Return Cap system diagnostic information.",
            no_args_schema(),
        ),
        tool(
            "show_window",
            "Show Window",
            "Show a basic Cap desktop window.",
            show_window_schema(),
            ToolAnnotations::mutating(),
        ),
        tool(
            "focus_captures_panel",
            "Focus Captures Panel",
            "Focus the Cap captures panel.",
            no_args_schema(),
            ToolAnnotations::mutating(),
        ),
        tool(
            "open_external_link",
            "Open External Link",
            "Open an external URL through Cap Desktop.",
            string_arg_schema("url"),
            ToolAnnotations::open_world(),
        ),
    ]
}

fn tool(
    name: &'static str,
    title: &'static str,
    description: &'static str,
    input_schema: Value,
    annotations: ToolAnnotations,
) -> McpTool {
    McpTool {
        name,
        title,
        description,
        input_schema,
        annotations: Some(annotations),
    }
}

fn read_only_tool(
    name: &'static str,
    title: &'static str,
    description: &'static str,
    input_schema: Value,
) -> McpTool {
    tool(
        name,
        title,
        description,
        input_schema,
        ToolAnnotations::read_only(),
    )
}

impl ToolAnnotations {
    fn read_only() -> Self {
        Self {
            read_only_hint: Some(true),
            destructive_hint: Some(false),
            idempotent_hint: None,
            open_world_hint: Some(false),
        }
    }

    fn mutating() -> Self {
        Self {
            read_only_hint: Some(false),
            destructive_hint: Some(false),
            idempotent_hint: None,
            open_world_hint: Some(false),
        }
    }

    fn destructive() -> Self {
        Self {
            read_only_hint: Some(false),
            destructive_hint: Some(true),
            idempotent_hint: None,
            open_world_hint: Some(false),
        }
    }

    fn open_world() -> Self {
        Self {
            read_only_hint: Some(false),
            destructive_hint: Some(false),
            idempotent_hint: None,
            open_world_hint: Some(true),
        }
    }

    fn network() -> Self {
        Self {
            read_only_hint: Some(false),
            destructive_hint: Some(false),
            idempotent_hint: None,
            open_world_hint: Some(true),
        }
    }
}

fn no_args_schema() -> Value {
    object_schema(json!({}), Vec::<&str>::new())
}

fn object_schema(properties: Value, required: Vec<&str>) -> Value {
    json!({
        "type": "object",
        "properties": properties,
        "required": required,
        "additionalProperties": false
    })
}

fn string_arg_schema(name: &str) -> Value {
    object_schema(
        json!({
            name: {
                "type": "string"
            }
        }),
        vec![name],
    )
}

fn path_schema(name: &str) -> Value {
    object_schema(
        json!({
            name: {
                "type": "string",
                "description": "Absolute local filesystem path."
            }
        }),
        vec![name],
    )
}

fn target_schema(name: &str) -> Value {
    object_schema(
        json!({
            name: screen_capture_target_schema()
        }),
        vec![name],
    )
}

fn start_recording_schema() -> Value {
    object_schema(
        json!({
            "captureTarget": screen_capture_target_schema(),
            "captureSystemAudio": {
                "type": "boolean",
                "default": false
            },
            "mode": recording_mode_value_schema(),
            "organizationId": {
                "type": ["string", "null"]
            }
        }),
        vec!["captureTarget", "mode"],
    )
}

fn target_select_schema() -> Value {
    object_schema(
        json!({
            "focusedTarget": {
                "anyOf": [
                    screen_capture_target_schema(),
                    {
                        "type": "null"
                    }
                ]
            },
            "specificDisplayId": {
                "type": ["string", "null"]
            },
            "targetMode": {
                "type": ["string", "null"],
                "enum": ["display", "window", "area", "camera", null]
            }
        }),
        Vec::<&str>::new(),
    )
}

fn permissions_check_schema() -> Value {
    object_schema(
        json!({
            "initialCheck": {
                "type": "boolean",
                "default": false
            }
        }),
        Vec::<&str>::new(),
    )
}

fn permission_schema() -> Value {
    object_schema(
        json!({
            "permission": {
                "type": "string",
                "enum": ["screenRecording", "camera", "microphone", "accessibility"]
            }
        }),
        vec!["permission"],
    )
}

fn recording_mode_schema() -> Value {
    object_schema(
        json!({
            "mode": recording_mode_value_schema()
        }),
        vec!["mode"],
    )
}

fn recording_mode_value_schema() -> Value {
    json!({
        "type": "string",
        "enum": ["studio", "instant", "screenshot"]
    })
}

fn show_window_schema() -> Value {
    object_schema(
        json!({
            "window": {
                "type": "string",
                "enum": ["main", "settings", "recordingsOverlay", "camera", "upgrade", "modeSelect", "onboarding"]
            },
            "page": {
                "type": ["string", "null"]
            },
            "centered": {
                "type": ["boolean", "null"]
            }
        }),
        vec!["window"],
    )
}

fn screen_capture_target_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "variant": {
                "type": "string",
                "enum": ["window", "display", "area", "cameraOnly"]
            },
            "id": {
                "type": "string"
            },
            "screen": {
                "type": "string"
            },
            "bounds": logical_bounds_schema()
        },
        "required": ["variant"],
        "additionalProperties": false
    })
}

fn logical_bounds_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "position": {
                "type": "object",
                "properties": {
                    "x": {
                        "type": "number"
                    },
                    "y": {
                        "type": "number"
                    }
                },
                "required": ["x", "y"],
                "additionalProperties": false
            },
            "size": {
                "type": "object",
                "properties": {
                    "width": {
                        "type": "number"
                    },
                    "height": {
                        "type": "number"
                    }
                },
                "required": ["width", "height"],
                "additionalProperties": false
            }
        },
        "required": ["position", "size"],
        "additionalProperties": false
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(method: &str, id: i64, params: Value) -> JsonRpcMessage {
        JsonRpcMessage {
            jsonrpc: Some("2.0".to_string()),
            id: Some(json!(id)),
            method: Some(method.to_string()),
            params: Some(params),
        }
    }

    async fn initialized_session(sessions: SessionStore) -> String {
        match handle_rpc(
            None,
            sessions,
            request(
                "initialize",
                1,
                json!({ "protocolVersion": PROTOCOL_VERSION }),
            ),
            None,
        )
        .await
        {
            RpcOutcome::Json {
                body,
                session_id: Some(session_id),
            } => {
                assert_eq!(body["result"]["protocolVersion"], PROTOCOL_VERSION);
                session_id
            }
            _ => panic!("initialize did not return a session"),
        }
    }

    #[tokio::test]
    async fn initializes_with_session() {
        let sessions = Arc::new(RwLock::new(HashMap::new()));
        let session_id = initialized_session(sessions.clone()).await;

        assert!(sessions.read().await.contains_key(&session_id));
    }

    #[test]
    fn status_does_not_expose_token() {
        let status = redacted_mcp_status(McpServerConfig {
            enabled: true,
            endpoint: Some("http://127.0.0.1:1234/mcp".to_string()),
            token: Some("secret-token".to_string()),
        });

        assert_eq!(status["tokenConfigured"], true);
        assert!(status.get("token").is_none());
        assert!(!status.to_string().contains("secret-token"));
    }

    #[test]
    fn unauthenticated_upload_is_an_execution_failure() {
        assert!(matches!(
            upload_result(Ok(crate::UploadResult::NotAuthenticated)),
            Err(ToolFailure::Execution(message)) if message.starts_with("NotAuthenticated:")
        ));
    }

    #[test]
    fn wraps_array_structured_content_in_an_object() {
        let result = tool_result(json!([1, 2, 3]), false);

        assert_eq!(result["structuredContent"], json!({ "result": [1, 2, 3] }));
    }

    #[test]
    fn wraps_null_structured_content_in_an_object() {
        let result = tool_result(Value::Null, false);

        assert_eq!(result["structuredContent"], json!({ "result": null }));
    }

    #[test]
    fn preserves_object_structured_content() {
        let result = tool_result(json!({ "enabled": true }), false);

        assert_eq!(result["structuredContent"], json!({ "enabled": true }));
    }

    #[tokio::test]
    async fn prunes_expired_sessions() {
        let sessions = Arc::new(RwLock::new(HashMap::from([(
            "expired".to_string(),
            McpSession {
                protocol_version: PROTOCOL_VERSION.to_string(),
                last_activity: Instant::now(),
            },
        )])));

        prune_expired_sessions(&sessions, Duration::ZERO).await;

        assert!(sessions.read().await.is_empty());
    }

    #[tokio::test]
    async fn initializes_with_previous_protocol_version() {
        let sessions = Arc::new(RwLock::new(HashMap::new()));

        match handle_rpc(
            None,
            sessions,
            request("initialize", 1, json!({ "protocolVersion": "2025-06-18" })),
            None,
        )
        .await
        {
            RpcOutcome::Json { body, .. } => {
                assert_eq!(body["result"]["protocolVersion"], "2025-06-18");
            }
            _ => panic!("initialize did not accept previous protocol version"),
        }
    }

    #[tokio::test]
    async fn lists_tools_after_initialize() {
        let sessions = Arc::new(RwLock::new(HashMap::new()));
        let session_id = initialized_session(sessions.clone()).await;

        match handle_rpc(
            None,
            sessions,
            request("tools/list", 2, json!({})),
            Some(session_id),
        )
        .await
        {
            RpcOutcome::Json { body, .. } => {
                let names = body["result"]["tools"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .filter_map(|tool| tool["name"].as_str())
                    .collect::<Vec<_>>();
                assert!(names.contains(&"start_recording"));
                assert!(names.contains(&"take_screenshot"));
                assert!(names.contains(&"get_system_diagnostics"));
            }
            _ => panic!("tools/list did not return JSON"),
        }
    }

    #[tokio::test]
    async fn rejects_missing_session_for_non_initialize_request() {
        let sessions = Arc::new(RwLock::new(HashMap::new()));

        match handle_rpc(None, sessions, request("tools/list", 2, json!({})), None).await {
            RpcOutcome::HttpError { status, message } => {
                assert_eq!(status, StatusCode::BAD_REQUEST);
                assert_eq!(message, "Missing MCP session id");
            }
            _ => panic!("missing session did not return HTTP error"),
        }
    }

    #[tokio::test]
    async fn returns_method_not_found_for_unknown_method() {
        let sessions = Arc::new(RwLock::new(HashMap::new()));
        let session_id = initialized_session(sessions.clone()).await;

        match handle_rpc(
            None,
            sessions,
            request("unknown/method", 3, json!({})),
            Some(session_id),
        )
        .await
        {
            RpcOutcome::Json { body, .. } => {
                assert_eq!(body["error"]["code"], -32601);
            }
            _ => panic!("unknown method did not return JSON-RPC error"),
        }
    }

    #[tokio::test]
    async fn rejects_invalid_tool_schema() {
        let sessions = Arc::new(RwLock::new(HashMap::new()));
        let session_id = initialized_session(sessions.clone()).await;

        match handle_rpc(
            None,
            sessions,
            request(
                "tools/call",
                4,
                json!({
                    "name": "start_recording",
                    "arguments": {
                        "mode": "instant"
                    }
                }),
            ),
            Some(session_id),
        )
        .await
        {
            RpcOutcome::Json { body, .. } => {
                assert_eq!(body["error"]["code"], -32603);
            }
            _ => panic!("invalid schema did not return JSON-RPC error"),
        }
    }

    #[test]
    fn rejects_unauthorized_request() {
        let settings = McpSettings {
            enabled: true,
            token: Some("secret".to_string()),
            port: Some(1234),
            endpoint: Some(endpoint_for_port(1234)),
        };
        let headers = HeaderMap::new();

        assert!(validate_authorization(&settings, &headers).is_err());
    }

    #[test]
    fn rejects_unsupported_protocol_header() {
        let mut headers = HeaderMap::new();
        headers.insert(
            mcp_protocol_version_header(),
            HeaderValue::from_static("2024-11-05"),
        );

        assert!(validate_protocol_header(&headers).is_err());
    }

    #[test]
    fn rejects_non_local_origin() {
        let mut headers = HeaderMap::new();
        headers.insert(
            header::ORIGIN,
            HeaderValue::from_static("https://example.com"),
        );

        assert!(validate_origin(&headers).is_err());
    }

    #[test]
    fn accepts_local_origin() {
        let mut headers = HeaderMap::new();
        headers.insert(
            header::ORIGIN,
            HeaderValue::from_static("http://127.0.0.1:5173"),
        );

        assert!(validate_origin(&headers).is_ok());
    }
}
