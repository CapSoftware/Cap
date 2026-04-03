use cap_upload::{AuthConfig, CapClient};
use clap::{Args, Subcommand};

#[derive(Args)]
pub struct FeedbackArgs {
    message: String,
}

#[derive(Args)]
pub struct DebugArgs {
    #[command(subcommand)]
    command: DebugCommands,
}

#[derive(Subcommand)]
enum DebugCommands {
    Upload,
    Logs,
}

pub fn log_dir() -> std::path::PathBuf {
    dirs::config_dir()
        .unwrap_or_else(|| std::path::PathBuf::from("."))
        .join("cap")
        .join("logs")
}

pub fn log_path() -> std::path::PathBuf {
    log_dir().join("cap-cli.log")
}

impl FeedbackArgs {
    pub async fn run(self, json: bool) -> Result<(), String> {
        let auth = AuthConfig::resolve().map_err(|e| e.to_string())?;
        let client = CapClient::new(auth).map_err(|e| e.to_string())?;

        let os = std::env::consts::OS;
        let version = env!("CARGO_PKG_VERSION");

        client
            .submit_feedback(&self.message, os, version)
            .await
            .map_err(|e| format!("Failed to submit feedback: {e}"))?;

        if json {
            println!("{}", serde_json::json!({"status": "submitted"}));
        } else {
            eprintln!("Feedback submitted. Thank you!");
        }
        Ok(())
    }
}

impl DebugArgs {
    pub async fn run(self, json: bool) -> Result<(), String> {
        match self.command {
            DebugCommands::Upload => debug_upload(json).await,
            DebugCommands::Logs => debug_logs(json),
        }
    }
}

async fn debug_upload(json: bool) -> Result<(), String> {
    let path = log_path();

    let log_data = match std::fs::read(&path) {
        Ok(data) => {
            let max_size = 1024 * 1024;
            if data.len() > max_size {
                data[data.len() - max_size..].to_vec()
            } else {
                data
            }
        }
        Err(_) => {
            return Err(format!(
                "No log file found at {}. Run a command first to generate logs.",
                path.display()
            ));
        }
    };

    let os = std::env::consts::OS;
    let version = env!("CARGO_PKG_VERSION");

    let auth = AuthConfig::resolve().ok();
    let client = match auth {
        Some(auth) => CapClient::new(auth).map_err(|e| e.to_string())?,
        None => {
            return Err("Authentication required. Run 'cap auth login' first.".to_string());
        }
    };

    client
        .upload_debug_logs(log_data, os, version, "{}")
        .await
        .map_err(|e| format!("Failed to upload logs: {e}"))?;

    if json {
        println!("{}", serde_json::json!({"status": "uploaded"}));
    } else {
        eprintln!("Debug logs uploaded successfully.");
    }
    Ok(())
}

fn debug_logs(json: bool) -> Result<(), String> {
    let path = log_path();
    let exists = path.exists();

    if json {
        println!(
            "{}",
            serde_json::json!({
                "path": path.display().to_string(),
                "exists": exists,
            })
        );
    } else {
        eprintln!("Log file: {}", path.display());
        if exists {
            let meta = std::fs::metadata(&path).ok();
            if let Some(meta) = meta {
                eprintln!("Size: {} bytes", meta.len());
            }
        } else {
            eprintln!("(file does not exist yet)");
        }
    }
    Ok(())
}
