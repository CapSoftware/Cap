use cap_upload::AuthConfig;
use clap::{Args, Subcommand};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

#[derive(Args)]
pub struct AuthArgs {
    #[command(subcommand)]
    command: AuthCommands,
}

#[derive(Subcommand)]
enum AuthCommands {
    Login(LoginArgs),
    Logout,
    Status,
}

#[derive(Args)]
struct LoginArgs {
    #[arg(long, default_value = "https://cap.so")]
    server: String,
    #[arg(long)]
    api_key: Option<String>,
}

impl AuthArgs {
    pub async fn run(self, json: bool) -> Result<(), String> {
        match self.command {
            AuthCommands::Login(args) => login(args, json).await,
            AuthCommands::Logout => logout(json),
            AuthCommands::Status => status(json),
        }
    }
}

async fn login(args: LoginArgs, json: bool) -> Result<(), String> {
    let server_url = args.server.trim_end_matches('/').to_string();

    if let Some(api_key) = args.api_key {
        let path =
            AuthConfig::save(&server_url, &api_key).map_err(|e| format!("Failed to save: {e}"))?;

        if json {
            println!(
                "{}",
                serde_json::json!({
                    "status": "logged_in",
                    "server_url": server_url,
                    "config_path": path.display().to_string()
                })
            );
        } else {
            eprintln!("Logged in to {server_url}");
            eprintln!("Config saved to {}", path.display());
        }
        return Ok(());
    }

    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|e| format!("Failed to bind local listener: {e}"))?;
    let port = listener
        .local_addr()
        .map_err(|e| format!("Failed to get port: {e}"))?
        .port();

    let auth_url = format!(
        "{}/api/desktop/session/request?type=api_key&port={}&platform=web",
        server_url, port
    );

    eprintln!("Opening browser for login...");
    eprintln!("If the browser does not open, visit: {auth_url}");

    if open::that(&auth_url).is_err() {
        eprintln!("Could not open browser automatically.");
    }

    eprintln!("Waiting for authentication...");

    let (mut stream, _addr) =
        tokio::time::timeout(std::time::Duration::from_secs(300), listener.accept())
            .await
            .map_err(|_| "Login timed out after 5 minutes. Please try again.".to_string())?
            .map_err(|e| format!("Failed to accept connection: {e}"))?;

    let mut buf = vec![0u8; 4096];
    let n = stream
        .read(&mut buf)
        .await
        .map_err(|e| format!("Failed to read: {e}"))?;
    let request = String::from_utf8_lossy(&buf[..n]);

    let api_key = extract_query_param(&request, "api_key");
    let user_id = extract_query_param(&request, "user_id");

    let response_body = if api_key.is_some() {
        "Authentication successful! You can close this tab."
    } else {
        "Authentication failed. Please try again."
    };

    let response = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        response_body.len(),
        response_body
    );

    stream
        .write_all(response.as_bytes())
        .await
        .map_err(|e| format!("Failed to write response: {e}"))?;

    let api_key = api_key.ok_or("Server did not return an API key")?;

    let path = AuthConfig::save(&server_url, &api_key)
        .map_err(|e| format!("Failed to save credentials: {e}"))?;

    if json {
        println!(
            "{}",
            serde_json::json!({
                "status": "logged_in",
                "server_url": server_url,
                "user_id": user_id,
                "config_path": path.display().to_string()
            })
        );
    } else {
        eprintln!("Logged in to {server_url}");
        if let Some(uid) = user_id {
            eprintln!("User: {uid}");
        }
        eprintln!("Config saved to {}", path.display());
    }

    Ok(())
}

fn logout(json: bool) -> Result<(), String> {
    AuthConfig::remove().map_err(|e| format!("Failed to remove credentials: {e}"))?;

    if json {
        println!("{}", serde_json::json!({"status": "logged_out"}));
    } else {
        eprintln!("Logged out successfully.");
    }
    Ok(())
}

fn status(json: bool) -> Result<(), String> {
    match AuthConfig::resolve() {
        Ok(config) => {
            if json {
                println!(
                    "{}",
                    serde_json::json!({
                        "status": "logged_in",
                        "server_url": config.server_url,
                    })
                );
            } else {
                eprintln!("Logged in to {}", config.server_url);
            }
            Ok(())
        }
        Err(_) => {
            if json {
                println!("{}", serde_json::json!({"status": "not_logged_in"}));
            } else {
                eprintln!(
                    "Not logged in. Run \"cap auth login --server URL\" or set CAP_API_KEY and CAP_SERVER_URL environment variables."
                );
            }
            Ok(())
        }
    }
}

fn extract_query_param(request: &str, param: &str) -> Option<String> {
    let first_line = request.lines().next()?;
    let path = first_line.split_whitespace().nth(1)?;
    let query = path.split('?').nth(1)?;
    for pair in query.split('&') {
        let mut kv = pair.splitn(2, '=');
        if let (Some(key), Some(value)) = (kv.next(), kv.next()) {
            if key == param {
                return Some(
                    percent_encoding::percent_decode_str(value)
                        .decode_utf8_lossy()
                        .to_string(),
                );
            }
        }
    }
    None
}
