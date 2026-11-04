use std::path::PathBuf;

use serde_json::{Value, json};

use super::bridge::BridgeClient;
use super::paths::{RelPath, display_bytes};
use super::protocol::{ReadEncoding, ToolCall};
use super::session::{ToolVerb, TraceState};
use super::workspace::{Verifier, Workspace};

const MAX_PULL_FILE: u64 = 4 * 1024 * 1024 * 1024;
const MAX_PULL_TOTAL: u64 = 8 * 1024 * 1024 * 1024;
const MAX_REPLACE: u64 = 4 * 1024 * 1024 * 1024;

pub struct ToolContext {
    pub operation: &'static str,
    pub error_message: String,
    pub kind: &'static str,
    pub verifier: Verifier,
    pub pulled_bytes: u64,
}

pub struct ToolRow {
    pub verb: ToolVerb,
    pub target: String,
}

pub struct ToolFinish {
    pub state: TraceState,
    pub meta: Option<String>,
    pub fixed_path: Option<PathBuf>,
}

pub fn row_for(call: &ToolCall) -> ToolRow {
    if let ToolCall::ReadFiles(args) = call {
        return ToolRow {
            verb: ToolVerb::Read,
            target: format!("{} files", args.paths.len()),
        };
    }
    let (verb, target) = match call {
        ToolCall::ReadFiles(_) => (ToolVerb::Read, String::new()),
        ToolCall::DescribeRecording => (ToolVerb::Describe, String::new()),
        ToolCall::ListFiles(args) => (ToolVerb::List, args.dir.clone().unwrap_or_default()),
        ToolCall::ReadFile(args) => (ToolVerb::Read, args.path.clone()),
        ToolCall::InspectMedia(args) => (ToolVerb::Inspect, args.path.clone()),
        ToolCall::PullFile(args) => (ToolVerb::Pull, args.path.clone()),
        ToolCall::StageJsonEdit(args) => (ToolVerb::Edit, args.path.clone()),
        ToolCall::StageTruncate(args) => (ToolVerb::Truncate, args.path.clone()),
        ToolCall::StageRemove(args) => (ToolVerb::Remove, args.path.clone()),
        ToolCall::StageReplace(args) => (ToolVerb::Replace, args.path.clone()),
        ToolCall::ListStaged => (ToolVerb::List, String::new()),
        ToolCall::DiscardStaged => (ToolVerb::Remove, String::new()),
        ToolCall::ApplyAndVerify => (ToolVerb::Verify, String::new()),
    };
    let target = match RelPath::parse(&target) {
        Ok(rel) => rel.as_str().to_string(),
        Err(_) if target.is_empty() => target,
        Err(_) => String::new(),
    };
    ToolRow {
        verb,
        target: super::sanitize::truncate(&target, super::sanitize::TARGET_LIMIT),
    }
}

fn rel(path: &str) -> Result<RelPath, String> {
    RelPath::parse(path)
}

async fn blocking<T: Send + 'static>(
    mut workspace: Workspace,
    work: impl FnOnce(&mut Workspace) -> T + Send + 'static,
) -> (Workspace, T) {
    let handle = tokio::task::spawn_blocking(move || {
        let result = work(&mut workspace);
        (workspace, result)
    });
    match handle.await {
        Ok(pair) => pair,
        Err(error) => std::panic::resume_unwind(error.into_panic()),
    }
}

fn meta_for(call: &ToolCall, result: &Value) -> Option<String> {
    match call {
        ToolCall::ReadFile(_) => result["length"].as_u64().map(display_bytes),
        ToolCall::ReadFiles(_) => result["files"].as_array().map(|files| {
            let read = files
                .iter()
                .filter(|file| file.get("error").is_none())
                .count();
            format!("{read}/{} read", files.len())
        }),
        ToolCall::InspectMedia(_) => {
            if result["allZero"].as_bool() == Some(true) {
                Some("all zeros".into())
            } else {
                result["boxes"]
                    .as_array()
                    .map(|boxes| format!("{} boxes", boxes.len()))
            }
        }
        ToolCall::ListFiles(_) => result["entries"]
            .as_array()
            .map(|entries| format!("{} items", entries.len())),
        ToolCall::PullFile(_) | ToolCall::StageReplace(_) => {
            result["size"].as_u64().map(display_bytes)
        }
        ToolCall::StageTruncate(_) | ToolCall::StageRemove(_) => result["removedBytes"]
            .as_u64()
            .map(|bytes| format!("-{}", display_bytes(bytes))),
        ToolCall::StageJsonEdit(_) => Some("staged".into()),
        ToolCall::ListStaged => result["changes"]
            .as_array()
            .map(|changes| format!("{} staged", changes.len())),
        ToolCall::DiscardStaged => result["discarded"]
            .as_u64()
            .map(|count| format!("{count} discarded")),
        ToolCall::ApplyAndVerify | ToolCall::DescribeRecording => None,
    }
}

pub async fn execute(
    workspace: Workspace,
    call: ToolCall,
    context: &mut ToolContext,
    bridge: &BridgeClient,
) -> (Workspace, Result<Value, String>, ToolFinish) {
    let (workspace, result, fixed_path, attempt) = match call.clone() {
        ToolCall::DescribeRecording => {
            let (files, total, media) = workspace.stats();
            let result = Ok(json!({
                "operation": context.operation,
                "errorMessage": workspace.redactor().text(&context.error_message),
                "appVersion": env!("CARGO_PKG_VERSION"),
                "os": std::env::consts::OS,
                "kind": context.kind,
                "fileCount": files,
                "totalBytes": total,
                "mediaBytes": media,
            }));
            (workspace, result, None, None)
        }
        ToolCall::ListFiles(args) => {
            let (workspace, result) = blocking(workspace, move |ws| {
                ws.list(args.dir.as_deref(), args.limit)
            })
            .await;
            (workspace, result, None, None)
        }
        ToolCall::ReadFile(args) => {
            let (workspace, result) = blocking(workspace, move |ws| {
                ws.read(
                    &rel(&args.path)?,
                    args.offset,
                    args.length,
                    args.encoding.unwrap_or(ReadEncoding::Auto),
                )
            })
            .await;
            (workspace, result, None, None)
        }
        ToolCall::InspectMedia(args) => {
            let (workspace, result) =
                blocking(workspace, move |ws| ws.inspect(&rel(&args.path)?)).await;
            (workspace, result, None, None)
        }
        ToolCall::PullFile(args) => {
            let path = args.path.clone();
            let (workspace, source) = blocking(workspace, move |ws| prepare_pull(ws, &path)).await;
            let result = match source {
                Ok((rel_path, source, length, temp)) => {
                    if length > MAX_PULL_FILE {
                        Err("file is larger than 4 GiB".to_string())
                    } else if context.pulled_bytes.saturating_add(length) > MAX_PULL_TOTAL {
                        Err("session pull limit of 8 GiB reached".to_string())
                    } else {
                        let uploaded = bridge
                            .upload_pulled(rel_path.as_str(), source, length)
                            .await;
                        if let Some(temp) = temp {
                            std::fs::remove_file(temp).ok();
                        }
                        uploaded.map(|size| {
                            context.pulled_bytes += size;
                            json!({
                                "sandboxPath": format!("/vercel/sandbox/work/recording/{}", rel_path.as_str()),
                                "size": size,
                            })
                        })
                    }
                }
                Err(error) => Err(error),
            };
            (workspace, result, None, None)
        }
        ToolCall::ReadFiles(args) => {
            let max_each = args
                .max_bytes_each
                .unwrap_or(super::protocol::MAX_READ_FILES_EACH);
            let (workspace, result) = blocking(workspace, move |ws| {
                Ok::<_, String>(ws.read_many(&args.paths, max_each))
            })
            .await;
            (workspace, result, None, None)
        }
        ToolCall::StageJsonEdit(args) => {
            let mut workspace = workspace;
            let ops = match (args.ops, args.ops_file) {
                (Some(ops), _) => Ok(ops),
                (None, Some(ops_file)) => load_ops_file(&mut workspace, bridge, &ops_file).await,
                (None, None) => Err("give exactly one of ops or opsFile".to_string()),
            };
            let result = match ops {
                Ok(ops) => {
                    let path = args.path;
                    let (returned, result) =
                        blocking(workspace, move |ws| ws.stage_json_edit(&rel(&path)?, &ops)).await;
                    workspace = returned;
                    result
                }
                Err(error) => Err(error),
            };
            (workspace, result, None, None)
        }
        ToolCall::StageTruncate(args) => {
            let (workspace, result) = blocking(workspace, move |ws| {
                ws.stage_truncate(&rel(&args.path)?, args.length)
            })
            .await;
            (workspace, result, None, None)
        }
        ToolCall::StageRemove(args) => {
            let (workspace, result) =
                blocking(workspace, move |ws| ws.stage_remove(&rel(&args.path)?)).await;
            (workspace, result, None, None)
        }
        ToolCall::StageReplace(args) => {
            let mut workspace = workspace;
            let prepared = (|| {
                if workspace.is_fixed() {
                    return Err("already repaired".to_string());
                }
                let target = rel(&args.path)?;
                if !target.is_media() {
                    return Err(
                        "only media files can be replaced; edit JSON with stage_json_edit"
                            .to_string(),
                    );
                }
                super::bridge::validate_out_path(&args.sandbox_path)?;
                Ok((target, workspace.incoming_path()?))
            })();
            let result = match prepared {
                Ok((target, incoming)) => match bridge
                    .download_out(&args.sandbox_path, incoming.clone(), MAX_REPLACE)
                    .await
                {
                    Ok(_) => {
                        let (returned, result) =
                            blocking(workspace, move |ws| ws.stage_replace(&target, &incoming))
                                .await;
                        workspace = returned;
                        result
                    }
                    Err(error) => {
                        std::fs::remove_file(&incoming).ok();
                        Err(error)
                    }
                },
                Err(error) => Err(error),
            };
            (workspace, result, None, None)
        }
        ToolCall::ListStaged => {
            let result = Ok(workspace.list_staged());
            (workspace, result, None, None)
        }
        ToolCall::DiscardStaged => {
            let mut workspace = workspace;
            let result = if workspace.is_fixed() {
                Err("already repaired".to_string())
            } else {
                workspace.discard()
            };
            (workspace, result, None, None)
        }
        ToolCall::ApplyAndVerify => {
            let verifier = context.verifier.clone();
            let (workspace, outcome) =
                blocking(workspace, move |ws| ws.apply_and_verify(&verifier)).await;
            match outcome {
                Ok(outcome) => {
                    let attempt = super::workspace::MAX_ATTEMPTS - outcome.attempts_left;
                    let result = Ok(json!({
                        "fixed": outcome.fixed,
                        "error": outcome.error,
                        "attemptsLeft": outcome.attempts_left,
                    }));
                    (
                        workspace,
                        result,
                        outcome.project_path,
                        Some((attempt, outcome.fixed)),
                    )
                }
                Err(error) => (workspace, Err(error), None, None),
            }
        }
    };
    let state = match (&result, attempt) {
        (Ok(_), Some((_, false))) => TraceState::Failed,
        (Ok(_), _) => TraceState::Done,
        (Err(_), _) => TraceState::Failed,
    };
    let meta = match (&result, attempt) {
        (_, Some((attempt, _))) => Some(format!("attempt {attempt}")),
        (Ok(value), None) => meta_for(&call, value),
        (Err(_), None) => None,
    };
    (
        workspace,
        result,
        ToolFinish {
            state,
            meta,
            fixed_path,
        },
    )
}

async fn load_ops_file(
    workspace: &mut Workspace,
    bridge: &BridgeClient,
    ops_file: &str,
) -> Result<Vec<super::protocol::JsonOp>, String> {
    if workspace.is_fixed() {
        return Err("already repaired".into());
    }
    super::bridge::validate_out_path(ops_file)?;
    let incoming = workspace.incoming_path()?;
    let downloaded = bridge
        .download_out(ops_file, incoming.clone(), super::workspace::MAX_OPS_FILE)
        .await;
    let bytes =
        downloaded.and_then(|_| std::fs::read(&incoming).map_err(|error| error.to_string()));
    std::fs::remove_file(&incoming).ok();
    parse_ops_file(&bytes?)
}

pub fn parse_ops_file(bytes: &[u8]) -> Result<Vec<super::protocol::JsonOp>, String> {
    serde_json::from_slice(bytes)
        .map_err(|error| format!("opsFile must be a JSON array of ops: {error}"))
}

fn prepare_pull(
    ws: &mut Workspace,
    path: &str,
) -> Result<(RelPath, PathBuf, u64, Option<PathBuf>), String> {
    let target = rel(path)?;
    if !target.is_media() && !target.is_json() {
        return Err("only media and JSON files can be pulled; use read_file for others".into());
    }
    if target.is_json() {
        let bytes = ws.redacted_json(&target)?;
        let temp = ws.incoming_path()?;
        std::fs::write(&temp, &bytes).map_err(|error| error.to_string())?;
        let length = bytes.len() as u64;
        return Ok((target, temp.clone(), length, Some(temp)));
    }
    let (source, length) = ws
        .effective(&target)?
        .ok_or_else(|| "file does not exist".to_string())?;
    Ok((target, source, length, None))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    async fn serve(listener: tokio::net::TcpListener, bodies: Arc<Mutex<Vec<Vec<u8>>>>) {
        loop {
            let Ok((mut stream, _)) = listener.accept().await else {
                return;
            };
            let body = bodies.lock().unwrap().remove(0);
            tokio::spawn(async move {
                let mut head = Vec::new();
                let mut chunk = [0u8; 4096];
                while !head.windows(4).any(|window| window == b"\r\n\r\n") {
                    match stream.read(&mut chunk).await {
                        Ok(0) | Err(_) => return,
                        Ok(read) => head.extend_from_slice(&chunk[..read]),
                    }
                }
                assert!(String::from_utf8_lossy(&head).starts_with("GET /v1/files/out?path="));
                let reply = format!(
                    "HTTP/1.1 200 OK\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
                    body.len()
                );
                stream.write_all(reply.as_bytes()).await.ok();
                stream.write_all(&body).await.ok();
            });
        }
    }

    #[test]
    fn ops_files_download_validate_and_apply() {
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
            .unwrap();
        let bundle = crate::repair::workspace::tests::fixture("opsfile");
        let manifest = "content/segments/segment-0/display/manifest.json";
        let bodies = Arc::new(Mutex::new(vec![
            br#"[{"op":"set","pointer":"/segments/0/path","value":"<recording>/content/x.m4s"}]"#
                .to_vec(),
            br#"{"op":"set","pointer":"/a","value":1}"#.to_vec(),
            br#"[{"op":"set","pointer":"/segments/1/is_complete","value":false,"extra":1}]"#
                .to_vec(),
            br#"[{"op":"set","pointer":"/segments/1/is_complete","value":false},{"op":"set","pointer":"/segments/0/duration","value":2.0}]"#
                .to_vec(),
        ]));
        let listener = runtime
            .block_on(tokio::net::TcpListener::bind("127.0.0.1:0"))
            .unwrap();
        let address = listener.local_addr().unwrap();
        runtime.spawn(serve(listener, bodies.clone()));
        let bridge =
            BridgeClient::new(&format!("http://{address}"), &"t".repeat(64), true).unwrap();
        let mut context = ToolContext {
            operation: "open",
            error_message: String::new(),
            kind: "studio",
            verifier: Arc::new(|path: &std::path::Path| Ok(path.to_path_buf())),
            pulled_bytes: 0,
        };
        let mut workspace = Workspace::open(
            crate::repair::paths::Bundle::open(&bundle).unwrap(),
            "rpr_opsfile",
            "open",
            crate::repair::redact::Redactor::for_bundle(&bundle),
        )
        .unwrap();
        let mut run = |workspace: Workspace, ops_file: &str| {
            let call = ToolCall::parse(
                "stage_json_edit",
                json!({"path": manifest, "opsFile": ops_file}),
            )
            .unwrap();
            let (workspace, result, _) =
                runtime.block_on(execute(workspace, call, &mut context, &bridge));
            (workspace, result)
        };
        let out = "/vercel/sandbox/work/out/ops.json";
        let (returned, result) = run(workspace, out);
        assert!(result.unwrap_err().contains("placeholders"));
        let (returned, result) = run(returned, out);
        assert!(result.unwrap_err().contains("JSON array"));
        let (returned, result) = run(returned, out);
        assert!(result.unwrap_err().contains("unknown field"));
        let (returned, result) = run(returned, "/vercel/sandbox/work/recording/x.json");
        assert!(result.unwrap_err().contains("must be under"));
        let (returned, result) = run(returned, out);
        assert_eq!(result.unwrap(), json!({"staged": true}));
        workspace = returned;
        assert!(bodies.lock().unwrap().is_empty());

        let read = workspace
            .read(
                &RelPath::parse(manifest).unwrap(),
                None,
                None,
                ReadEncoding::Auto,
            )
            .unwrap();
        let value: Value = serde_json::from_str(read["data"].as_str().unwrap()).unwrap();
        assert_eq!(value["segments"][1]["is_complete"], json!(false));
        assert_eq!(value["segments"][0]["duration"], json!(2.0));
        let tmp = bundle.join(".cap-repair/rpr_opsfile/tmp");
        assert_eq!(std::fs::read_dir(tmp).unwrap().count(), 0);
        workspace.close();
        drop(runtime);
        std::fs::remove_dir_all(bundle.parent().unwrap()).ok();
    }

    #[test]
    fn batch_read_rows_name_the_file_count() {
        let call = ToolCall::parse(
            "read_files",
            json!({"paths": ["a.json", "b.json", "c.json"]}),
        )
        .unwrap();
        let row = row_for(&call);
        assert_eq!(row.verb, ToolVerb::Read);
        assert_eq!(row.target, "3 files");
    }
}
