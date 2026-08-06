use std::time::Duration;

use clap::{Args, Subcommand};
use serde_json::Value;

use crate::{
    OutputFormat,
    agent_client::print_value,
    caps::{AgentApiError, AgentClient, opaque_id},
    resolve_format,
};

#[derive(Args)]
pub struct JobsArgs {
    #[command(subcommand)]
    command: JobsCommands,
}

#[derive(Subcommand)]
enum JobsCommands {
    Get(JobTargetArgs),
    Wait(JobWaitArgs),
}

#[derive(Args)]
struct JobTargetArgs {
    operation_id: String,
    #[arg(long, value_enum, default_value_t = OutputFormat::Text)]
    format: OutputFormat,
}

#[derive(Args)]
struct JobWaitArgs {
    operation_id: String,
    #[arg(long, default_value_t = 600)]
    timeout: u64,
    #[arg(long, value_enum, default_value_t = OutputFormat::Text)]
    format: OutputFormat,
}

fn local_error(code: &str, message: impl Into<String>) -> AgentApiError {
    AgentApiError {
        code: code.to_string(),
        message: message.into(),
        retryable: false,
        retry_after_ms: None,
        request_id: None,
    }
}

pub async fn wait_operation(
    client: &AgentClient,
    operation_id: &str,
    timeout: u64,
) -> Result<Value, AgentApiError> {
    if timeout == 0 || timeout > 86_400 {
        return Err(local_error(
            "INVALID_REQUEST",
            "--timeout must be between 1 and 86400 seconds",
        ));
    }
    let operation_id = opaque_id(operation_id, "Operation ID")?;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(timeout);
    let mut attempt = 0_u32;
    loop {
        let operation = client
            .get_json(&format!("/operations/{operation_id}"))
            .await?;
        match operation.get("state").and_then(Value::as_str) {
            Some("succeeded") => return Ok(operation),
            Some("failed") => {
                let message = operation
                    .get("error")
                    .and_then(|error| error.get("message"))
                    .and_then(Value::as_str)
                    .unwrap_or("Cap operation failed");
                return Err(local_error("OPERATION_FAILED", message));
            }
            Some("queued" | "running") => {}
            _ => {
                return Err(local_error(
                    "TEMPORARY_UNAVAILABLE",
                    "Cap returned an invalid operation state",
                ));
            }
        }
        if tokio::time::Instant::now() >= deadline {
            return Err(AgentApiError {
                code: "NOT_READY".to_string(),
                message: "Timed out waiting for the Cap operation".to_string(),
                retryable: true,
                retry_after_ms: Some(2_000),
                request_id: operation
                    .get("requestId")
                    .and_then(Value::as_str)
                    .map(str::to_string),
            });
        }
        let delay = 500_u64.saturating_mul(1_u64 << attempt.min(4));
        tokio::time::sleep(Duration::from_millis(delay.min(10_000))).await;
        attempt = attempt.saturating_add(1);
    }
}

impl JobsArgs {
    pub async fn run(self, global_json: bool) -> Result<(), String> {
        let client = AgentClient::from_credentials().map_err(|error| error.to_string())?;
        match self.command {
            JobsCommands::Get(args) => {
                let operation_id = opaque_id(&args.operation_id, "Operation ID")
                    .map_err(|error| error.to_string())?;
                let value = client
                    .get_json(&format!("/operations/{operation_id}"))
                    .await
                    .map_err(|error| error.to_string())?;
                print_value(&value, resolve_format(global_json, args.format))
            }
            JobsCommands::Wait(args) => {
                let value = wait_operation(&client, &args.operation_id, args.timeout)
                    .await
                    .map_err(|error| error.to_string())?;
                print_value(&value, resolve_format(global_json, args.format))
            }
        }
    }
}
