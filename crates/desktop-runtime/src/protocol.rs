use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const PROTOCOL_VERSION: u32 = 1;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ShellMessage {
    Hello {
        token: String,
        protocol_version: u32,
    },
    Invoke {
        id: u64,
        window_label: String,
        command: String,
        arguments: Value,
    },
    WindowState {
        label: String,
        state: WindowState,
    },
    WindowEvent {
        label: String,
        event: WindowEvent,
    },
    Event {
        event: String,
        #[serde(default)]
        payload: Value,
    },
    CursorPosition {
        x: f64,
        y: f64,
    },
    NativeResult {
        id: u64,
        result: std::result::Result<Value, String>,
    },
    Shutdown,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum BackendMessage {
    Ready {
        protocol_version: u32,
        commands: Vec<String>,
    },
    InvokeResult {
        id: u64,
        response: CommandResponse,
    },
    Event {
        event: String,
        payload: Value,
        target: Option<String>,
    },
    Channel(ChannelMessage),
    CreateWindow {
        options: WindowOptions,
    },
    DesktopOperation {
        label: String,
        operation: DesktopOperation,
    },
    NativeOperation {
        operation: String,
        payload: Value,
    },
    NativeRequest {
        id: u64,
        operation: String,
        payload: Value,
    },
    ShutdownComplete,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum CommandResponse {
    Ok { value: Value },
    Error { error: String },
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChannelMessage {
    pub channel_id: u64,
    pub index: u64,
    pub message: Option<Value>,
    pub end: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowOptions {
    pub label: String,
    pub route: String,
    pub title: String,
    pub x: Option<f64>,
    pub y: Option<f64>,
    pub width: f64,
    pub height: f64,
    pub min_width: Option<f64>,
    pub min_height: Option<f64>,
    pub transparent: bool,
    pub decorations: bool,
    pub resizable: bool,
    pub always_on_top: bool,
    pub visible_on_all_workspaces: bool,
    pub skip_taskbar: bool,
    pub content_protected: bool,
    pub focus: bool,
    pub visible: bool,
    pub initialization: Value,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowState {
    #[serde(default)]
    pub native_window_id: Option<u64>,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub visible: bool,
    pub focused: bool,
    pub minimized: bool,
    pub maximized: bool,
    pub fullscreen: bool,
    pub always_on_top: bool,
    pub scale_factor: f64,
    #[serde(default)]
    pub monitor: Option<WindowMonitorState>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowMonitorState {
    pub name: Option<String>,
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub work_x: i32,
    pub work_y: i32,
    pub work_width: u32,
    pub work_height: u32,
    pub scale_factor: f64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum WindowEvent {
    CloseRequested,
    Destroyed,
    Focused { focused: bool },
    Moved { x: f64, y: f64 },
    Resized { width: f64, height: f64 },
    ScaleFactorChanged { scale_factor: f64 },
    ThemeChanged { theme: String },
    DragDrop { paths: Vec<String> },
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum DesktopOperation {
    Show,
    Hide,
    Close,
    Destroy,
    Focus,
    Minimize,
    Unminimize,
    Maximize,
    Unmaximize,
    SetFullscreen {
        fullscreen: bool,
    },
    SetAlwaysOnTop {
        always_on_top: bool,
    },
    SetContentProtected {
        enabled: bool,
    },
    SetPosition {
        x: f64,
        y: f64,
        physical: bool,
    },
    SetSize {
        width: f64,
        height: f64,
        physical: bool,
    },
    SetMinSize {
        width: Option<f64>,
        height: Option<f64>,
        physical: bool,
    },
    SetTitle {
        title: String,
    },
    SetResizable {
        resizable: bool,
    },
    SetIgnoreCursorEvents {
        ignore: bool,
    },
    SetOpacity {
        opacity: f64,
    },
    SetTheme {
        theme: String,
    },
    SetTrafficLightPosition {
        x: Option<f64>,
        y: Option<f64>,
    },
    RequestUserAttention {
        critical: bool,
    },
    SetProgress {
        progress: Option<f64>,
    },
}
