use std::path::{Path, PathBuf};

use cap_cloud_sharing::{SharingClient, feedback::valid_feedback_id};
use clap::{Args, Subcommand};
use serde_json::{Value, json};
use sha2::{Digest as _, Sha256};

use crate::write_json;

#[derive(Args)]
pub struct FeedbackArgs {
    #[command(subcommand)]
    command: FeedbackCommand,
}

#[derive(Subcommand)]
enum FeedbackCommand {
    /// List feedback reports on your Worm server, newest first
    List {
        #[arg(long)]
        cursor: Option<String>,
    },
    /// Download a report into a walk-shaped folder the walk processor and agent prompt can read
    Pull {
        id: String,
        /// Parent folder for the new report folder (default: the walk output folder)
        #[arg(long)]
        out: Option<PathBuf>,
    },
    /// Delete a report and its attachments from your Worm server
    Delete { id: String },
}

fn checked_id(id: &str) -> Result<&str, String> {
    if valid_feedback_id(id) {
        Ok(id)
    } else {
        Err("That is not a feedback report id.".into())
    }
}

fn walk_output_folder() -> PathBuf {
    let home = dirs::home_dir().unwrap_or_default();
    let config = std::env::var_os("CAP_UX_WALK_CONFIG_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| home.join(".config/ux-walk"))
        .join("config.json");
    let configured = std::fs::read(config)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
        .and_then(|value| value["outDir"].as_str().map(str::to_string))
        .filter(|dir| !dir.is_empty())
        .unwrap_or_else(|| "~/Movies/ux-walk".into());
    match configured.strip_prefix("~/") {
        Some(rest) => home.join(rest),
        None => PathBuf::from(configured),
    }
}

async fn attachment(
    client: &SharingClient,
    id: &str,
    report: &Value,
    part: &str,
) -> Result<Option<Vec<u8>>, String> {
    let meta = &report[part];
    let Some(expected) = meta["sha256"].as_str() else {
        return Ok(None);
    };
    let (_, bytes) = client
        .feedback_request("GET", &format!("/api/v1/feedback/{id}/{part}"))
        .await?;
    let actual = format!("{:x}", Sha256::digest(&bytes));
    if actual != expected || meta["size"].as_u64() != Some(bytes.len() as u64) {
        return Err(format!(
            "The {part} did not match its checksum; nothing was saved."
        ));
    }
    Ok(Some(bytes))
}

fn publish(
    parent: &Path,
    folder: &cap_cloud_sharing::feedback::WalkFolder,
) -> Result<PathBuf, String> {
    std::fs::create_dir_all(parent).map_err(|_| "Could not create the output folder.")?;
    let target = parent.join(&folder.session_dir);
    if target.exists() {
        return Err(format!("Already pulled: {}", target.display()));
    }
    let staging = parent.join(format!(
        ".feedback-{}-{}",
        std::process::id(),
        uuid::Uuid::new_v4()
    ));
    let result = (|| -> Result<(), String> {
        for (name, bytes) in &folder.files {
            let path = staging.join(name);
            if let Some(directory) = path.parent() {
                std::fs::create_dir_all(directory)
                    .map_err(|_| "Could not create the report folder.")?;
            }
            std::fs::write(&path, bytes).map_err(|_| "Could not save the report.")?;
        }
        std::fs::rename(&staging, &target).map_err(|_| "Could not publish the report folder.")?;
        Ok(())
    })();
    if result.is_err() {
        let _ = std::fs::remove_dir_all(&staging);
    }
    result.map(|()| target)
}

impl FeedbackArgs {
    pub async fn run(self) -> Result<(), String> {
        let client = SharingClient::configured_feedback()?;
        match self.command {
            FeedbackCommand::List { cursor } => {
                let resource = match cursor {
                    Some(cursor)
                        if cursor
                            .chars()
                            .all(|c| c.is_ascii_alphanumeric() || "-_=.".contains(c)) =>
                    {
                        format!("/api/v1/feedback?cursor={cursor}")
                    }
                    Some(_) => return Err("Invalid list cursor.".into()),
                    None => "/api/v1/feedback".into(),
                };
                let (_, bytes) = client.feedback_request("GET", &resource).await?;
                let value: Value = serde_json::from_slice(&bytes)
                    .map_err(|_| "Your Worm server returned invalid JSON.")?;
                write_json(&value)
            }
            FeedbackCommand::Pull { id, out } => {
                let id = checked_id(&id)?;
                let (_, bytes) = client
                    .feedback_request("GET", &format!("/api/v1/feedback/{id}"))
                    .await?;
                let report: Value = serde_json::from_slice(&bytes)
                    .map_err(|_| "Your Worm server returned an invalid report.")?;
                if report["id"].as_str() != Some(id) {
                    return Err("Your Worm server returned a different report.".into());
                }
                let screenshot = attachment(&client, id, &report, "screenshot").await?;
                let voice = attachment(&client, id, &report, "voice").await?;
                let created = report["createdAt"]
                    .as_i64()
                    .and_then(chrono::DateTime::from_timestamp_millis)
                    .unwrap_or_else(chrono::Utc::now);
                let stamp = created
                    .with_timezone(&chrono::Local)
                    .format("%Y-%m-%d-%H%M")
                    .to_string();
                let folder = cap_cloud_sharing::feedback::walk_folder(
                    &report,
                    &stamp,
                    &created.to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
                    &client.server(),
                    screenshot,
                    voice,
                )?;
                let target = publish(&out.unwrap_or_else(walk_output_folder), &folder)?;
                let chapter = target.join(&folder.chapter_dir);
                write_json(&json!({
                    "id": id,
                    "dir": target,
                    "chapterDir": chapter,
                    "summary": chapter.join("feedback.md"),
                    "voice": folder.has_voice,
                    "transcribe": folder.has_voice.then(|| format!("ux-walk process {}", chapter.display())),
                }))
            }
            FeedbackCommand::Delete { id } => {
                let id = checked_id(&id)?;
                client
                    .feedback_request("DELETE", &format!("/api/v1/feedback/{id}"))
                    .await?;
                write_json(&json!({ "id": id, "deleted": true }))
            }
        }
    }
}
