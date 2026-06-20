use serde::{Deserialize, Serialize};
use specta::Type;
use std::collections::HashMap;

use cap_project::XY;

#[derive(Serialize, Deserialize, Type, Debug, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct AutomationsStore {
    #[serde(default)]
    pub version: u32,
    #[serde(default)]
    pub rules: Vec<AutomationRule>,
}

#[derive(Serialize, Deserialize, Type, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AutomationRule {
    pub id: String,
    pub name: String,
    #[serde(default = "default_true")]
    pub enabled: bool,
    pub trigger: Trigger,
    #[serde(default)]
    pub match_mode: MatchMode,
    #[serde(default)]
    pub conditions: Vec<Condition>,
    #[serde(default)]
    pub actions: Vec<Action>,
}

fn default_true() -> bool {
    true
}

#[derive(Serialize, Deserialize, Type, Debug, Clone, Copy, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub enum MatchMode {
    #[default]
    All,
    Any,
}

#[derive(Serialize, Deserialize, Type, Debug, Clone, Copy, PartialEq, Eq, Hash)]
#[serde(rename_all = "camelCase")]
pub enum Trigger {
    ScreenshotTaken,
    StudioRecordingFinished,
    InstantRecordingFinished,
    RecordingStarted,
    UploadCompleted,
    VideoImported,
    RecordingDeleted,
}

#[derive(Serialize, Deserialize, Type, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase", tag = "type")]
pub enum Condition {
    CaptureTargetIs { target: CaptureTargetKind },
    RecordingModeIs { mode: AutomationRecordingMode },
    DurationAtLeast { secs: f64 },
    DurationAtMost { secs: f64 },
    WindowTitleContains { pattern: String },
    OrganizationIs { id: String },
}

#[derive(Serialize, Deserialize, Type, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum CaptureTargetKind {
    Display,
    Window,
    Area,
}

#[derive(Serialize, Deserialize, Type, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum AutomationRecordingMode {
    Studio,
    Instant,
}

#[derive(Serialize, Deserialize, Type, Debug, Clone)]
#[serde(rename_all = "camelCase", tag = "type")]
pub enum Action {
    CopyToClipboard {
        #[serde(default)]
        source: ClipboardSource,
    },
    #[serde(rename_all = "camelCase")]
    SaveToLocation {
        dir: String,
        #[serde(default)]
        filename_template: Option<String>,
    },
    Export {
        profile: ExportProfile,
        #[serde(default)]
        destination: ExportDestination,
    },
    #[serde(rename_all = "camelCase")]
    Upload {
        #[serde(default)]
        organization_id: Option<String>,
        #[serde(default = "default_true")]
        copy_link: bool,
        #[serde(default)]
        open_in_browser: bool,
    },
    RevealInFileManager,
    OpenFile,
    #[serde(rename_all = "camelCase")]
    RunCommand {
        program: String,
        #[serde(default)]
        args: Vec<String>,
        #[serde(default)]
        cwd: Option<String>,
        #[serde(default)]
        env: HashMap<String, String>,
        #[serde(default)]
        use_shell: bool,
    },
    #[serde(rename_all = "camelCase")]
    Webhook {
        url: String,
        #[serde(default = "default_post")]
        method: String,
        #[serde(default)]
        headers: HashMap<String, String>,
        #[serde(default)]
        body_template: Option<String>,
    },
    RecognizeTextToClipboard,
    #[serde(rename_all = "camelCase")]
    Notify {
        #[serde(default = "default_notify_title")]
        title_template: String,
        #[serde(default)]
        body_template: String,
    },
    OpenEditor,
    SkipEditor,
    ApplyPreset {
        name: String,
    },
    DeleteLocalFiles,
}

fn default_post() -> String {
    "POST".to_string()
}

fn default_notify_title() -> String {
    "Cap Automation".to_string()
}

#[derive(Serialize, Deserialize, Type, Debug, Clone, Copy, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub enum ClipboardSource {
    #[default]
    Raw,
    Rendered,
}

#[derive(Serialize, Deserialize, Type, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ExportProfile {
    pub format: ExportFormat,
    #[serde(default = "default_fps")]
    pub fps: u32,
    #[serde(default = "default_resolution")]
    pub resolution_base: XY<u32>,
    #[serde(default)]
    pub compression: Option<AutomationExportCompression>,
    #[serde(default)]
    pub preset_name: Option<String>,
}

fn default_fps() -> u32 {
    30
}

fn default_resolution() -> XY<u32> {
    XY { x: 1920, y: 1080 }
}

#[derive(Serialize, Deserialize, Type, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ExportFormat {
    Mp4,
    Gif,
    Mov,
}

#[derive(Serialize, Deserialize, Type, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum AutomationExportCompression {
    Maximum,
    Social,
    Web,
    Potato,
}

#[derive(Serialize, Deserialize, Type, Debug, Clone, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ExportDestination {
    #[default]
    ProjectFolder,
    CustomPath {
        dir: String,
    },
}
