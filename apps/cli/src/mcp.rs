use std::io::Write;

use serde::Deserialize;
use serde_json::{Value, json};
use tokio::io::AsyncBufReadExt;

const DESKTOP_BUNDLE_IDS: [&str; 2] = ["so.cap.desktop", "so.cap.desktop.dev"];
const PROTOCOL_VERSION: &str = "2025-11-25";

#[derive(clap::Args)]
pub struct McpArgs {}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct DesktopMcpSettings {
    enabled: bool,
    token: Option<String>,
    port: Option<u16>,
}

impl Default for DesktopMcpSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            token: None,
            port: None,
        }
    }
}

struct McpEndpoint {
    endpoint: String,
    token: String,
}

impl McpArgs {
    pub async fn run(self) -> Result<(), String> {
        run_stdio().await
    }
}

async fn run_stdio() -> Result<(), String> {
    let endpoint = load_endpoint();
    let client = reqwest::Client::builder()
        .no_proxy()
        .build()
        .map_err(|err| format!("Failed to create MCP HTTP client: {err}"))?;
    let mut session_id: Option<String> = None;
    let mut lines = tokio::io::BufReader::new(tokio::io::stdin()).lines();

    while let Some(line) = lines
        .next_line()
        .await
        .map_err(|err| format!("Failed to read MCP stdin: {err}"))?
    {
        if line.trim().is_empty() {
            continue;
        }

        let id = request_id(&line);
        let result = match &endpoint {
            Ok(endpoint) => forward_message(&client, endpoint, &line, session_id.as_deref()).await,
            Err(message) => Err(message.clone()),
        };

        match result {
            Ok(ForwardedResponse::Accepted) => {}
            Ok(ForwardedResponse::Json {
                body,
                next_session_id,
            }) => {
                if let Some(next_session_id) = next_session_id {
                    session_id = Some(next_session_id);
                }
                write_json_line(&body)?;
            }
            Err(message) => {
                if let Some(id) = id {
                    write_json_line(&json_rpc_error(
                        id,
                        -32000,
                        format!(
                            "{message}. Launch Cap Desktop and enable MCP before using cap mcp."
                        ),
                    ))?;
                }
            }
        }
    }

    if let (Ok(endpoint), Some(session_id)) = (&endpoint, session_id.as_deref())
        && let Err(err) = delete_session(&client, endpoint, session_id).await
    {
        eprintln!("Failed to close Cap Desktop MCP session: {err}");
    }

    Ok(())
}

enum ForwardedResponse {
    Accepted,
    Json {
        body: Value,
        next_session_id: Option<String>,
    },
}

async fn forward_message(
    client: &reqwest::Client,
    endpoint: &McpEndpoint,
    line: &str,
    session_id: Option<&str>,
) -> Result<ForwardedResponse, String> {
    let mut request = client
        .post(&endpoint.endpoint)
        .bearer_auth(&endpoint.token)
        .header("Accept", "application/json, text/event-stream")
        .header("Content-Type", "application/json")
        .header("MCP-Protocol-Version", PROTOCOL_VERSION)
        .body(line.to_string());

    if let Some(session_id) = session_id {
        request = request.header("Mcp-Session-Id", session_id);
    }

    let response = request
        .send()
        .await
        .map_err(|err| format!("Cap Desktop MCP endpoint is unavailable: {err}"))?;

    if response.status() == reqwest::StatusCode::ACCEPTED {
        return Ok(ForwardedResponse::Accepted);
    }

    let status = response.status();
    let next_session_id = response
        .headers()
        .get("Mcp-Session-Id")
        .and_then(|value| value.to_str().ok())
        .map(str::to_string);
    let body = response
        .json::<Value>()
        .await
        .map_err(|err| format!("Cap Desktop returned invalid MCP JSON: {err}"))?;

    if !status.is_success() {
        return Err(format!(
            "Cap Desktop MCP request failed with {status}: {body}"
        ));
    }

    Ok(ForwardedResponse::Json {
        body,
        next_session_id,
    })
}

async fn delete_session(
    client: &reqwest::Client,
    endpoint: &McpEndpoint,
    session_id: &str,
) -> Result<(), String> {
    let response = delete_session_request(client, endpoint, session_id)
        .send()
        .await
        .map_err(|err| format!("Failed to delete MCP session: {err}"))?;

    if matches!(
        response.status(),
        reqwest::StatusCode::ACCEPTED | reqwest::StatusCode::NOT_FOUND
    ) {
        Ok(())
    } else {
        Err(format!(
            "Cap Desktop returned {} while deleting the MCP session",
            response.status()
        ))
    }
}

fn delete_session_request(
    client: &reqwest::Client,
    endpoint: &McpEndpoint,
    session_id: &str,
) -> reqwest::RequestBuilder {
    client
        .delete(&endpoint.endpoint)
        .bearer_auth(&endpoint.token)
        .header("MCP-Protocol-Version", PROTOCOL_VERSION)
        .header("Mcp-Session-Id", session_id)
}

fn load_endpoint() -> Result<McpEndpoint, String> {
    let data_dir = dirs::data_dir().ok_or("Cap Desktop data directory was not found")?;

    for bundle_id in DESKTOP_BUNDLE_IDS {
        let path = data_dir.join(bundle_id).join("store");
        let Ok(bytes) = std::fs::read(&path) else {
            continue;
        };
        let store: Value = serde_json::from_slice(&bytes)
            .map_err(|err| format!("Failed to parse Cap Desktop store: {err}"))?;
        let settings = store
            .get("mcp")
            .cloned()
            .map(serde_json::from_value::<DesktopMcpSettings>)
            .transpose()
            .map_err(|err| format!("Failed to parse Cap Desktop MCP settings: {err}"))?
            .unwrap_or_default();

        if !settings.enabled {
            continue;
        }

        let token = settings
            .token
            .filter(|token| !token.is_empty())
            .ok_or("Cap Desktop MCP token is missing")?;
        let port = settings.port.ok_or("Cap Desktop MCP port is missing")?;

        return Ok(McpEndpoint {
            endpoint: format!("http://127.0.0.1:{port}/mcp"),
            token,
        });
    }

    Err("Cap Desktop MCP is not enabled or no running endpoint was found".to_string())
}

fn request_id(line: &str) -> Option<Value> {
    serde_json::from_str::<Value>(line)
        .ok()
        .and_then(|value| value.get("id").cloned())
}

fn json_rpc_error(id: Value, code: i64, message: String) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "error": {
            "code": code,
            "message": message
        }
    })
}

fn write_json_line(value: &Value) -> Result<(), String> {
    let mut stdout = std::io::stdout().lock();
    serde_json::to_writer(&mut stdout, value)
        .map_err(|err| format!("Failed to write MCP stdout: {err}"))?;
    stdout
        .write_all(b"\n")
        .map_err(|err| format!("Failed to write MCP stdout: {err}"))?;
    stdout
        .flush()
        .map_err(|err| format!("Failed to flush MCP stdout: {err}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_authenticated_session_delete_request() {
        let client = reqwest::Client::builder().no_proxy().build().unwrap();
        let endpoint = McpEndpoint {
            endpoint: "http://127.0.0.1:1234/mcp".to_string(),
            token: "test-token".to_string(),
        };
        let request = delete_session_request(&client, &endpoint, "test-session")
            .build()
            .unwrap();

        assert_eq!(request.method(), reqwest::Method::DELETE);
        assert_eq!(request.url().as_str(), endpoint.endpoint);
        assert_eq!(
            request.headers().get("authorization").unwrap(),
            "Bearer test-token"
        );
        assert_eq!(
            request.headers().get("mcp-protocol-version").unwrap(),
            PROTOCOL_VERSION
        );
        assert_eq!(
            request.headers().get("mcp-session-id").unwrap(),
            "test-session"
        );
    }
}
