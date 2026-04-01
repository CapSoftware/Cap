use cap_upload::{AuthConfig, CapClient};
use clap::Args;

#[derive(Args)]
pub struct ListArgs {
    #[arg(long)]
    org: Option<String>,
    #[arg(long, default_value = "20")]
    limit: u32,
    #[arg(long, default_value = "0")]
    offset: u32,
}

#[derive(Args)]
pub struct GetArgs {
    video_id: String,
}

#[derive(Args)]
pub struct DeleteArgs {
    video_id: String,
}

#[derive(Args)]
pub struct OpenArgs {
    video_id: String,
}

#[derive(Args)]
pub struct InfoArgs {
    video_id: String,
}

#[derive(Args)]
pub struct TranscriptArgs {
    video_id: String,
}

#[derive(Args)]
pub struct PasswordArgs {
    video_id: String,
    #[arg(long)]
    remove: bool,
    #[arg(long)]
    set: Option<String>,
}

impl ListArgs {
    pub async fn run(self, json: bool) -> Result<(), String> {
        let auth = AuthConfig::resolve().map_err(|e| e.to_string())?;
        let client = CapClient::new(auth).map_err(|e| e.to_string())?;

        let resp = client
            .list_videos(self.org.as_deref(), self.limit, self.offset)
            .await
            .map_err(|e| e.to_string())?;

        if json {
            let enriched: Vec<_> = resp
                .data
                .iter()
                .map(|v| {
                    let mut obj = serde_json::to_value(v).unwrap();
                    obj.as_object_mut()
                        .unwrap()
                        .insert("share_url".into(), client.share_url(&v.id).into());
                    obj
                })
                .collect();
            println!("{}", serde_json::to_string_pretty(&enriched).unwrap());
        } else if resp.data.is_empty() {
            eprintln!("No videos found.");
        } else {
            for v in &resp.data {
                let dur = v.duration.map_or("--".to_string(), |d| {
                    format!("{}m{}s", d as u64 / 60, d as u64 % 60)
                });
                println!(
                    "{}  {}  {}  {}",
                    v.id,
                    dur,
                    v.name.as_deref().unwrap_or("(untitled)"),
                    client.share_url(&v.id)
                );
            }
            eprintln!("Showing {}/{} videos", resp.data.len(), resp.total);
        }
        Ok(())
    }
}

impl GetArgs {
    pub async fn run(self, json: bool) -> Result<(), String> {
        let args = InfoArgs {
            video_id: self.video_id,
        };
        args.run(json).await
    }
}

impl DeleteArgs {
    pub async fn run(self, json: bool) -> Result<(), String> {
        let auth = AuthConfig::resolve().map_err(|e| e.to_string())?;
        let client = CapClient::new(auth).map_err(|e| e.to_string())?;

        client
            .delete_video(&self.video_id)
            .await
            .map_err(|e| e.to_string())?;

        if json {
            println!(
                "{}",
                serde_json::json!({
                    "status": "deleted",
                    "video_id": self.video_id,
                })
            );
        } else {
            eprintln!("Video {} deleted.", self.video_id);
        }
        Ok(())
    }
}

impl OpenArgs {
    pub async fn run(self, json: bool) -> Result<(), String> {
        let auth = AuthConfig::resolve().map_err(|e| e.to_string())?;
        let client = CapClient::new(auth).map_err(|e| e.to_string())?;

        let url = client.share_url(&self.video_id);

        if json {
            println!(
                "{}",
                serde_json::json!({
                    "video_id": self.video_id,
                    "share_url": url,
                })
            );
        } else {
            eprintln!("Opening {url}");
            if open::that(&url).is_err() {
                eprintln!("Could not open browser. Visit: {url}");
            }
        }
        Ok(())
    }
}

impl InfoArgs {
    pub async fn run(self, json: bool) -> Result<(), String> {
        let auth = AuthConfig::resolve().map_err(|e| e.to_string())?;
        let client = CapClient::new(auth).map_err(|e| e.to_string())?;

        let info = client
            .get_video_info(&self.video_id)
            .await
            .map_err(|e| e.to_string())?;

        let url = client.share_url(&self.video_id);

        if json {
            let mut obj = serde_json::to_value(&info).unwrap();
            obj.as_object_mut()
                .unwrap()
                .insert("share_url".into(), url.clone().into());
            println!("{}", serde_json::to_string_pretty(&obj).unwrap());
        } else {
            println!("{}", info.name.as_deref().unwrap_or("(untitled)"));
            println!("  URL: {url}");
            if let Some(dur) = info.duration {
                let mins = dur as u64 / 60;
                let secs = dur as u64 % 60;
                println!("  Duration: {mins}m {secs}s");
            }
            if let (Some(w), Some(h)) = (info.width, info.height) {
                println!("  Resolution: {w}x{h}");
            }
            if let Some(status) = &info.transcription_status {
                println!("  Transcription: {status}");
            }
            if info.has_password {
                println!("  Password: set");
            }
            if let Some(title) = &info.ai_title {
                println!("  AI Title: {title}");
            }
            if let Some(summary) = &info.summary {
                println!("  Summary: {summary}");
            }
            if let Some(chapters) = &info.chapters {
                println!("  Chapters:");
                for ch in chapters {
                    let mins = ch.start as u64 / 60;
                    let secs = ch.start as u64 % 60;
                    println!("    [{mins}:{secs:02}] {}", ch.title);
                }
            }
        }
        Ok(())
    }
}

impl TranscriptArgs {
    pub async fn run(self, json: bool) -> Result<(), String> {
        let auth = AuthConfig::resolve().map_err(|e| e.to_string())?;
        let client = CapClient::new(auth).map_err(|e| e.to_string())?;

        let vtt = client
            .get_transcript(&self.video_id)
            .await
            .map_err(|e| e.to_string())?;

        if json {
            println!(
                "{}",
                serde_json::json!({
                    "video_id": self.video_id,
                    "format": "vtt",
                    "content": vtt,
                })
            );
        } else {
            println!("{vtt}");
        }
        Ok(())
    }
}

impl PasswordArgs {
    pub async fn run(self, json: bool) -> Result<(), String> {
        let auth = AuthConfig::resolve().map_err(|e| e.to_string())?;
        let client = CapClient::new(auth).map_err(|e| e.to_string())?;

        if self.remove {
            client
                .set_video_password(&self.video_id, None)
                .await
                .map_err(|e| e.to_string())?;
            if json {
                println!(
                    "{}",
                    serde_json::json!({"status": "removed", "video_id": self.video_id})
                );
            } else {
                eprintln!("Password removed from video {}.", self.video_id);
            }
        } else if let Some(ref pw) = self.set {
            client
                .set_video_password(&self.video_id, Some(pw))
                .await
                .map_err(|e| e.to_string())?;
            if json {
                println!(
                    "{}",
                    serde_json::json!({"status": "set", "video_id": self.video_id})
                );
            } else {
                eprintln!("Password set on video {}.", self.video_id);
            }
        } else {
            return Err(
                "Specify --set <password> to set a password or --remove to remove it.".to_string(),
            );
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn password_args_requires_set_or_remove() {
        let args = PasswordArgs {
            video_id: "test123".to_string(),
            remove: false,
            set: None,
        };
        let result = args.run(false).await;
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("--set"));
    }
}
