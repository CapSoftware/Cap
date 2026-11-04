use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const MAX_REQUEST_ID: usize = 128;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RawRequest {
    pub id: String,
    pub tool: String,
    #[serde(default)]
    pub args: Value,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Empty {}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ListFilesArgs {
    #[serde(default)]
    pub dir: Option<String>,
    #[serde(default)]
    pub limit: Option<u32>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum ReadEncoding {
    #[default]
    Auto,
    Hex,
    Base64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReadFileArgs {
    pub path: String,
    #[serde(default)]
    pub offset: Option<u64>,
    #[serde(default)]
    pub length: Option<u64>,
    #[serde(default)]
    pub encoding: Option<ReadEncoding>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PathArgs {
    pub path: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum JsonOpKind {
    Set,
    Remove,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct JsonOp {
    pub op: JsonOpKind,
    pub pointer: String,
    #[serde(default)]
    pub value: Option<Value>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct JsonEditArgs {
    pub path: String,
    #[serde(default)]
    pub ops: Option<Vec<JsonOp>>,
    #[serde(default)]
    pub ops_file: Option<String>,
}

pub const MAX_READ_FILES: usize = 200;
pub const MAX_READ_FILES_EACH: u64 = 65_536;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReadFilesArgs {
    pub paths: Vec<String>,
    #[serde(default)]
    pub max_bytes_each: Option<u64>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TruncateArgs {
    pub path: String,
    pub length: u64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReplaceArgs {
    pub path: String,
    pub sandbox_path: String,
}

#[derive(Debug, Clone)]
pub enum ToolCall {
    DescribeRecording,
    ListFiles(ListFilesArgs),
    ReadFile(ReadFileArgs),
    ReadFiles(ReadFilesArgs),
    InspectMedia(PathArgs),
    PullFile(PathArgs),
    StageJsonEdit(JsonEditArgs),
    StageTruncate(TruncateArgs),
    StageRemove(PathArgs),
    StageReplace(ReplaceArgs),
    ListStaged,
    DiscardStaged,
    ApplyAndVerify,
}

fn args<T: serde::de::DeserializeOwned>(value: Value) -> Result<T, String> {
    let value = if value.is_null() {
        Value::Object(Default::default())
    } else {
        value
    };
    serde_json::from_value(value).map_err(|error| format!("invalid arguments: {error}"))
}

impl ToolCall {
    pub fn parse(tool: &str, value: Value) -> Result<Self, String> {
        Ok(match tool {
            "describe_recording" => {
                args::<Empty>(value)?;
                Self::DescribeRecording
            }
            "list_files" => Self::ListFiles(args(value)?),
            "read_file" => Self::ReadFile(args(value)?),
            "inspect_media" => Self::InspectMedia(args(value)?),
            "pull_file" => Self::PullFile(args(value)?),
            "read_files" => {
                let parsed: ReadFilesArgs = args(value)?;
                if parsed.paths.is_empty() || parsed.paths.len() > MAX_READ_FILES {
                    return Err(format!(
                        "invalid arguments: paths must have 1 to {MAX_READ_FILES} entries"
                    ));
                }
                if parsed
                    .max_bytes_each
                    .is_some_and(|each| each == 0 || each > MAX_READ_FILES_EACH)
                {
                    return Err(format!(
                        "invalid arguments: maxBytesEach must be 1 to {MAX_READ_FILES_EACH}"
                    ));
                }
                Self::ReadFiles(parsed)
            }
            "stage_json_edit" => {
                let parsed: JsonEditArgs = args(value)?;
                if parsed.ops.is_some() == parsed.ops_file.is_some() {
                    return Err("invalid arguments: give exactly one of ops or opsFile".into());
                }
                Self::StageJsonEdit(parsed)
            }
            "stage_truncate" => Self::StageTruncate(args(value)?),
            "stage_remove" => Self::StageRemove(args(value)?),
            "stage_replace" => Self::StageReplace(args(value)?),
            "list_staged" => {
                args::<Empty>(value)?;
                Self::ListStaged
            }
            "discard_staged" => {
                args::<Empty>(value)?;
                Self::DiscardStaged
            }
            "apply_and_verify" => {
                args::<Empty>(value)?;
                Self::ApplyAndVerify
            }
            _ => return Err("unknown tool".into()),
        })
    }
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(untagged)]
pub enum ToolResult {
    Ok { id: String, ok: bool, result: Value },
    Err { id: String, ok: bool, error: String },
}

impl ToolResult {
    pub fn ok(id: String, result: Value) -> Self {
        Self::Ok {
            id,
            ok: true,
            result,
        }
    }

    pub fn err(id: String, error: impl Into<String>) -> Self {
        Self::Err {
            id,
            ok: false,
            error: error.into(),
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PollRequest<'a> {
    pub cursor: u64,
    pub results: &'a [ToolResult],
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PollResponse {
    pub cursor: u64,
    #[serde(default)]
    pub requests: Vec<Value>,
    #[serde(default)]
    pub events: Vec<Value>,
    #[serde(default)]
    pub done: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StepState {
    Running,
    Done,
    Failed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ActivityVerb {
    Read,
    Search,
    Run,
    Edit,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FinishOutcome {
    Fixed,
    CantFix,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum EventBody {
    Thought {
        text: String,
    },
    Step {
        id: String,
        title: String,
        #[serde(default)]
        detail: Option<String>,
        state: StepState,
    },
    Activity {
        verb: ActivityVerb,
        target: String,
    },
    Finish {
        outcome: FinishOutcome,
        #[serde(default)]
        summary: String,
    },
    Error {
        message: String,
    },
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Clone)]
pub struct Event {
    pub seq: u64,
    pub body: EventBody,
}

impl Event {
    pub fn parse(value: Value) -> Option<Self> {
        let seq = value.get("seq")?.as_u64()?;
        let body = serde_json::from_value(value).ok()?;
        Some(Self { seq, body })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn rejects_unknown_tools_and_fields() {
        assert_eq!(
            ToolCall::parse("run_shell", json!({"cmd": "rm -rf /"})).unwrap_err(),
            "unknown tool"
        );
        assert!(ToolCall::parse("read_file", json!({"path": "a.json", "follow": true})).is_err());
        assert!(ToolCall::parse("describe_recording", json!({"x": 1})).is_err());
        assert!(ToolCall::parse("stage_truncate", json!({"path": "a.m4s", "length": -1})).is_err());
        assert!(
            ToolCall::parse(
                "stage_json_edit",
                json!({"path": "a.json", "ops": [{"op": "move", "pointer": "/a"}]})
            )
            .is_err()
        );
        let raw: Result<RawRequest, _> = serde_json::from_value(
            json!({"id": "1", "tool": "list_files", "args": {}, "extra": 1}),
        );
        assert!(raw.is_err());
    }

    #[test]
    fn batch_reads_and_ops_files_are_validated() {
        let ToolCall::ReadFiles(read) = ToolCall::parse(
            "read_files",
            json!({"paths": ["a.json", "b.json"], "maxBytesEach": 1024}),
        )
        .unwrap() else {
            panic!("wrong tool");
        };
        assert_eq!(read.paths.len(), 2);
        assert_eq!(read.max_bytes_each, Some(1024));
        assert!(ToolCall::parse("read_files", json!({"paths": []})).is_err());
        assert!(ToolCall::parse("read_files", json!({"paths": vec!["a.json"; 201]})).is_err());
        assert!(
            ToolCall::parse("read_files", json!({"paths": ["a"], "maxBytesEach": 65537})).is_err()
        );
        assert!(ToolCall::parse("read_files", json!({"paths": ["a"], "maxBytesEach": 0})).is_err());
        assert!(ToolCall::parse("read_files", json!({"paths": ["a"], "encoding": "hex"})).is_err());

        let ops = json!([{"op": "set", "pointer": "/a", "value": 1}]);
        let out = "/vercel/sandbox/work/out/ops.json";
        assert!(matches!(
            ToolCall::parse("stage_json_edit", json!({"path": "a.json", "opsFile": out})).unwrap(),
            ToolCall::StageJsonEdit(JsonEditArgs {
                ops: None,
                ops_file: Some(_),
                ..
            })
        ));
        assert!(ToolCall::parse("stage_json_edit", json!({"path": "a.json", "ops": ops})).is_ok());
        let both = ToolCall::parse(
            "stage_json_edit",
            json!({"path": "a.json", "ops": ops, "opsFile": out}),
        )
        .unwrap_err();
        assert!(both.contains("exactly one"), "{both}");
        assert!(ToolCall::parse("stage_json_edit", json!({"path": "a.json"})).is_err());
    }

    #[test]
    fn parses_known_tools() {
        assert!(matches!(
            ToolCall::parse("describe_recording", Value::Null).unwrap(),
            ToolCall::DescribeRecording
        ));
        let ToolCall::ReadFile(read) = ToolCall::parse(
            "read_file",
            json!({"path": "recording-meta.json", "encoding": "hex", "length": 10}),
        )
        .unwrap() else {
            panic!("wrong tool");
        };
        assert_eq!(read.encoding, Some(ReadEncoding::Hex));
        assert!(matches!(
            ToolCall::parse(
                "stage_replace",
                json!({"path": "a.mp4", "sandboxPath": "/vercel/sandbox/work/out/a.mp4"})
            )
            .unwrap(),
            ToolCall::StageReplace(_)
        ));
    }

    #[test]
    fn results_serialize_to_the_wire_shape() {
        assert_eq!(
            serde_json::to_value(ToolResult::ok("a".into(), json!({"x": 1}))).unwrap(),
            json!({"id": "a", "ok": true, "result": {"x": 1}})
        );
        assert_eq!(
            serde_json::to_value(ToolResult::err("b".into(), "nope")).unwrap(),
            json!({"id": "b", "ok": false, "error": "nope"})
        );
    }

    #[test]
    fn events_tolerate_unknown_types() {
        let event = Event::parse(json!({"seq": 3, "type": "telemetry", "x": 1})).unwrap();
        assert!(matches!(event.body, EventBody::Unknown));
        let event = Event::parse(
            json!({"seq": 4, "type": "finish", "outcome": "cant_fix", "summary": "s"}),
        )
        .unwrap();
        assert!(matches!(
            event.body,
            EventBody::Finish {
                outcome: FinishOutcome::CantFix,
                ..
            }
        ));
        assert!(Event::parse(json!({"type": "thought", "text": "no seq"})).is_none());
    }
}
