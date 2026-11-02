pub mod recovery;

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::Duration;

use reqwest::{Client, Response, Url};
use serde::{Deserialize, Serialize};
use tokio::io::AsyncReadExt as _;

static SAVE_REVISION: AtomicU64 = AtomicU64::new(0);

const SERVICE: &str = "com.cantrell.cap-ux.sharing";
const MAX_SIZE: u64 = 20 * 1024 * 1024 * 1024;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub enabled: bool,
    pub backup_enabled: bool,
    pub endpoint: String,
    pub expires_in_days: u32,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            enabled: false,
            backup_enabled: false,
            endpoint: String::new(),
            expires_in_days: 7,
        }
    }
}

pub fn config_path() -> Result<PathBuf, String> {
    if let Some(path) = std::env::var_os("CAP_UX_SHARING_CONFIG") {
        return Ok(PathBuf::from(path));
    }
    dirs::home_dir()
        .map(|home| home.join(".config/cap-ux/sharing.json"))
        .ok_or_else(|| "Home folder is unavailable.".into())
}

pub fn load() -> Result<Settings, String> {
    let path = config_path()?;
    match std::fs::read(path) {
        Ok(bytes) => {
            serde_json::from_slice(&bytes).map_err(|_| "Sharing settings could not be read.".into())
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Settings::default()),
        Err(_) => Err("Sharing settings could not be opened.".into()),
    }
}

pub fn endpoint(value: &str) -> Result<Url, String> {
    let mut url =
        Url::parse(value.trim()).map_err(|_| "Enter a sharing server URL.".to_string())?;
    let host = url.host_str().unwrap_or_default();
    let loopback = matches!(host, "localhost" | "127.0.0.1" | "::1" | "[::1]");
    let cap_service = ["cap.so", "cap.link", "cap.watch", "cap.me"]
        .iter()
        .any(|domain| host == *domain || host.ends_with(&format!(".{domain}")));
    if cap_service
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || url.path() != "/"
        || host.is_empty()
        || !(url.scheme() == "https" || (url.scheme() == "http" && loopback))
    {
        return Err("Use your sharing server's HTTPS origin, without a path, credentials, query or fragment. HTTP is available for localhost development.".into());
    }
    url.set_path("/");
    Ok(url)
}

pub fn is_owned_link(link: &str) -> bool {
    Url::parse(link).is_ok_and(|url| {
        url.path().starts_with("/s/")
            && url.fragment().is_some_and(|value| value.len() == 64)
            && endpoint(&url.origin().ascii_serialization()).is_ok()
    })
}

pub fn validate_configured_link(link: &str) -> Result<(), String> {
    let settings = load()?;
    let configured = endpoint(&settings.endpoint)?;
    let url = Url::parse(link).map_err(|_| "Invalid sharing link.")?;
    if !is_owned_link(link) || url.origin() != configured.origin() {
        return Err(
            "Select the server that owns this link in Sharing settings before revoking it.".into(),
        );
    }
    Ok(())
}

pub fn save(settings: &Settings) -> Result<(), String> {
    if settings.enabled || settings.backup_enabled || !settings.endpoint.trim().is_empty() {
        endpoint(&settings.endpoint)?;
    }
    if !(1..=30).contains(&settings.expires_in_days) {
        return Err("Choose an expiry between 1 and 30 days.".into());
    }
    let path = config_path()?;
    let parent = path
        .parent()
        .ok_or("Sharing settings path has no parent.")?;
    std::fs::create_dir_all(parent).map_err(|_| "Could not create the sharing settings folder.")?;
    let bytes =
        serde_json::to_vec_pretty(settings).map_err(|_| "Could not encode sharing settings.")?;
    let temporary = path.with_file_name(format!(
        ".sharing-{}-{}.tmp",
        std::process::id(),
        SAVE_REVISION.fetch_add(1, Ordering::Relaxed)
    ));
    let mut options = std::fs::OpenOptions::new();
    options.create_new(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt as _;
        options.mode(0o600);
    }
    use std::io::Write as _;
    let mut file = options
        .open(&temporary)
        .map_err(|_| "Could not save sharing settings.")?;
    file.write_all(&bytes)
        .and_then(|()| file.sync_all())
        .map_err(|_| "Could not save sharing settings.")?;
    std::fs::rename(temporary, path).map_err(|_| "Could not replace sharing settings.".into())
}

fn entry(server: &str) -> Result<keyring::Entry, String> {
    let account = endpoint(server)?.origin().ascii_serialization();
    keyring::Entry::new(SERVICE, &account)
        .map_err(|_| "Could not open the sharing credential store.".into())
}

pub fn set_token(server: &str, value: &str) -> Result<(), String> {
    if value.trim().len() < 32 {
        return Err("Use the upload credential provided by your sharing server.".into());
    }
    entry(server)?
        .set_password(value.trim())
        .map_err(|_| "Could not save the sharing credential in the system credential store.".into())
}

pub fn has_token(server: &str) -> bool {
    entry(server)
        .and_then(|entry| entry.get_password().map_err(|_| String::new()))
        .is_ok()
}

pub fn remove_token(server: &str) -> Result<(), String> {
    match entry(server)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(_) => Err("Could not remove the sharing credential.".into()),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Prepared {
    id: String,
    part_size: usize,
    share_path: String,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Part {
    part_number: u32,
    etag: String,
}

#[derive(Deserialize)]
struct Completed {
    id: String,
    ready: bool,
}

#[derive(Serialize)]
pub struct SharedItem {
    pub id: String,
    pub link: String,
}

pub struct SharingClient {
    http: Client,
    base: Url,
    token: String,
    days: u32,
}

impl SharingClient {
    pub fn configured() -> Result<Self, String> {
        let settings = load()?;
        if !settings.enabled {
            return Err("Cloud sharing is off. Choose your server in Settings → Sharing. Your recording is saved locally.".into());
        }
        let base = endpoint(&settings.endpoint)?;
        let token = std::env::var("CAP_UX_UPLOAD_TOKEN")
            .ok()
            .filter(|value| !value.is_empty())
            .or_else(|| entry(base.as_str()).ok()?.get_password().ok())
            .ok_or("Add your server's upload credential in Settings → Sharing.")?;
        Self::with_credentials(settings, token)
    }

    fn with_credentials(settings: Settings, token: String) -> Result<Self, String> {
        let base = endpoint(&settings.endpoint)?;
        let http = Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(15))
            .timeout(Duration::from_secs(300))
            .build()
            .map_err(|_| "Could not initialize sharing.")?;
        Ok(Self {
            http,
            base,
            token,
            days: settings.expires_in_days.clamp(1, 30),
        })
    }

    fn url(&self, path: &str) -> Url {
        self.base
            .join(path)
            .expect("sharing paths are relative constants")
    }

    pub async fn upload_file(
        &self,
        path: &Path,
        title: &str,
        content_type: &str,
        progress: impl Fn(f64),
        cancel: &AtomicBool,
    ) -> Result<SharedItem, String> {
        let mut file = tokio::fs::File::open(path)
            .await
            .map_err(|_| "Could not open the file for sharing.")?;
        let size = file
            .metadata()
            .await
            .map_err(|_| "Could not read the file size.")?
            .len();
        if size == 0 || size > MAX_SIZE {
            return Err("Share a video or image smaller than 20 GB.".into());
        }
        cancelled(cancel)?;
        let prepared: Prepared = decode(self.http.post(self.url("api/v1/shares")).bearer_auth(&self.token)
            .json(&serde_json::json!({ "title": title.chars().take(240).collect::<String>(), "contentType": content_type, "size": size, "expiresInDays": self.days }))
            .send().await.map_err(|_| "Could not reach your sharing server.")?).await?;
        let prefix = format!("/s/{}#", prepared.id);
        let capability = prepared
            .share_path
            .strip_prefix(&prefix)
            .ok_or("The sharing server returned an invalid link.")?;
        if prepared.id.len() != 36
            || !prepared
                .id
                .chars()
                .all(|c| c.is_ascii_hexdigit() || c == '-')
            || capability.len() != 64
            || !capability.chars().all(|c| c.is_ascii_hexdigit())
            || !(5 * 1024 * 1024..=8 * 1024 * 1024).contains(&prepared.part_size)
        {
            return Err("The sharing server returned an unsupported upload session.".into());
        }
        let result = async {
            let mut sent = 0;
            let mut parts = Vec::new();
            while sent < size {
                cancelled(cancel)?;
                let length = (size - sent).min(prepared.part_size as u64) as usize;
                let mut bytes = vec![0; length];
                file.read_exact(&mut bytes)
                    .await
                    .map_err(|_| "The file changed or could not be read during upload.")?;
                let number = parts.len() + 1;
                let part: Part = decode(
                    self.http
                        .put(self.url(&format!("api/v1/shares/{}/parts/{number}", prepared.id)))
                        .bearer_auth(&self.token)
                        .body(bytes)
                        .send()
                        .await
                        .map_err(|_| "Uploading a media part failed.")?,
                )
                .await?;
                if part.part_number as usize != number {
                    return Err("The sharing server confirmed the wrong part.".into());
                }
                parts.push(part);
                sent += length as u64;
                progress(sent as f64 / size as f64 * 0.95);
            }
            cancelled(cancel)?;
            let completed: Completed = decode(
                self.http
                    .post(self.url(&format!("api/v1/shares/{}/complete", prepared.id)))
                    .bearer_auth(&self.token)
                    .json(&serde_json::json!({ "parts": parts }))
                    .send()
                    .await
                    .map_err(|_| "Could not finish sharing.")?,
            )
            .await?;
            if !completed.ready || completed.id != prepared.id {
                return Err("The server has not confirmed this upload.".into());
            }
            cancelled(cancel)?;
            let verified = self
                .http
                .head(self.url(&format!("api/v1/shares/{}/media", prepared.id)))
                .bearer_auth(capability)
                .send()
                .await
                .map_err(|_| "Could not verify the shared recording.")?;
            if !verified.status().is_success()
                || verified
                    .headers()
                    .get(reqwest::header::CONTENT_LENGTH)
                    .and_then(|value| value.to_str().ok())
                    .and_then(|value| value.parse::<u64>().ok())
                    != Some(size)
            {
                return Err(
                    "The shared recording could not be verified. Your local file is safe.".into(),
                );
            }
            cancelled(cancel)?;
            progress(1.0);
            Ok(SharedItem {
                id: prepared.id.clone(),
                link: self
                    .base
                    .join(&prepared.share_path)
                    .map_err(|_| "Invalid sharing link.")?
                    .to_string(),
            })
        }
        .await;
        if result.is_err() {
            let _ = self.revoke(&prepared.id).await;
        }
        result
    }

    pub async fn revoke(&self, id: &str) -> Result<(), String> {
        if id.len() != 36 || !id.chars().all(|c| c.is_ascii_hexdigit() || c == '-') {
            return Err("Invalid share id.".into());
        }
        let id = id.to_ascii_lowercase();
        let response = self
            .http
            .delete(self.url(&format!("api/v1/shares/{id}")))
            .bearer_auth(&self.token)
            .send()
            .await
            .map_err(|_| "Could not reach your sharing server.")?;
        if response.status().is_success() || response.status() == 404 {
            Ok(())
        } else {
            Err("The server could not revoke this link.".into())
        }
    }
}

fn cancelled(cancel: &AtomicBool) -> Result<(), String> {
    if cancel.load(Ordering::Acquire) {
        Err("Export cancelled".into())
    } else {
        Ok(())
    }
}

async fn decode<T: serde::de::DeserializeOwned>(mut response: Response) -> Result<T, String> {
    if !response.status().is_success() {
        return Err(format!(
            "Your sharing server returned {}. Check its upload credential and configuration.",
            response.status().as_u16()
        ));
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "Could not read the sharing response.")?
    {
        if bytes.len() + chunk.len() > 256 * 1024 {
            return Err("Sharing response exceeded its size limit.".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes)
        .map_err(|_| "The server does not support this sharing protocol.".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    use std::io::{Read as _, Write as _};
    use std::net::TcpListener;
    use std::sync::Arc;
    use std::thread;

    fn fixture_server(responses: Vec<String>) -> (String, thread::JoinHandle<Vec<String>>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = format!("http://{}", listener.local_addr().unwrap());
        let handle = thread::spawn(move || {
            let mut requests = Vec::new();
            for response in responses {
                listener.set_nonblocking(true).unwrap();
                let deadline = std::time::Instant::now() + Duration::from_secs(5);
                let (mut stream, _) = loop {
                    match listener.accept() {
                        Ok(stream) => break stream,
                        Err(error)
                            if error.kind() == std::io::ErrorKind::WouldBlock
                                && std::time::Instant::now() < deadline =>
                        {
                            thread::sleep(Duration::from_millis(5))
                        }
                        Err(error) => panic!("Expected sharing request did not arrive: {error}"),
                    }
                };
                stream.set_nonblocking(false).unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(5)))
                    .unwrap();
                let mut bytes = Vec::new();
                let header_end = loop {
                    let mut buffer = [0; 4096];
                    let length = stream.read(&mut buffer).unwrap();
                    assert!(length > 0);
                    bytes.extend_from_slice(&buffer[..length]);
                    if let Some(index) = bytes.windows(4).position(|window| window == b"\r\n\r\n") {
                        break index + 4;
                    }
                };
                let header = String::from_utf8_lossy(&bytes[..header_end]).to_string();
                let length = header
                    .lines()
                    .find_map(|line| {
                        line.to_ascii_lowercase()
                            .strip_prefix("content-length:")
                            .and_then(|value| value.trim().parse::<usize>().ok())
                    })
                    .unwrap_or(0);
                while bytes.len() < header_end + length {
                    let mut buffer = [0; 4096];
                    let length = stream.read(&mut buffer).unwrap();
                    assert!(length > 0);
                    bytes.extend_from_slice(&buffer[..length]);
                }
                requests.push(header);
                stream.write_all(response.as_bytes()).unwrap();
            }
            requests
        });
        (address, handle)
    }

    fn http(body: serde_json::Value) -> String {
        let body = serde_json::to_string(&body).unwrap();
        format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        )
    }

    fn prepared() -> String {
        http(
            serde_json::json!({ "id": "00000000-0000-0000-0000-000000000000", "partSize": 8388608, "sharePath": format!("/s/00000000-0000-0000-0000-000000000000#{}", "a".repeat(64)) }),
        )
    }

    #[tokio::test]
    async fn cancellation_revokes_remote_attempt_and_preserves_source() {
        let (server, handle) = fixture_server(vec![
            prepared(),
            http(serde_json::json!({"partNumber": 1, "etag": "synthetic"})),
            "HTTP/1.1 204 No Content\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".into(),
        ]);
        let client = SharingClient::with_credentials(
            Settings {
                enabled: true,
                backup_enabled: false,
                endpoint: server,
                expires_in_days: 7,
            },
            "synthetic-owner-token-with-32-characters".into(),
        )
        .unwrap();
        let file = tempfile::NamedTempFile::new().unwrap();
        std::fs::write(file.path(), b"synthetic media").unwrap();
        let cancel = Arc::new(AtomicBool::new(false));
        let progress_cancel = cancel.clone();
        let result = client
            .upload_file(
                file.path(),
                "Synthetic",
                "video/mp4",
                move |_| {
                    progress_cancel.store(true, Ordering::Release);
                },
                &cancel,
            )
            .await;
        assert_eq!(result.err().as_deref(), Some("Export cancelled"));
        assert_eq!(std::fs::read(file.path()).unwrap(), b"synthetic media");
        let requests = handle.join().unwrap();
        assert!(requests[0].starts_with("POST /api/v1/shares "));
        assert!(requests[1].starts_with("PUT /api/v1/shares/"));
        assert!(requests[2].starts_with("DELETE /api/v1/shares/"));
    }

    #[tokio::test]
    async fn wrong_completion_receipt_is_never_reported_as_success() {
        let (server, handle) = fixture_server(vec![
            prepared(),
            http(serde_json::json!({"partNumber": 1, "etag": "synthetic"})),
            http(serde_json::json!({"id": "a-different-upload", "ready": true})),
            "HTTP/1.1 204 No Content\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".into(),
        ]);
        let client = SharingClient::with_credentials(
            Settings {
                enabled: true,
                backup_enabled: false,
                endpoint: server,
                expires_in_days: 7,
            },
            "synthetic-owner-token-with-32-characters".into(),
        )
        .unwrap();
        let file = tempfile::NamedTempFile::new().unwrap();
        std::fs::write(file.path(), b"synthetic media").unwrap();
        let result = client
            .upload_file(
                file.path(),
                "Synthetic",
                "video/mp4",
                |_| {},
                &AtomicBool::new(false),
            )
            .await;
        assert_eq!(
            result.err().as_deref(),
            Some("The server has not confirmed this upload.")
        );
        let requests = handle.join().unwrap();
        assert_eq!(requests.len(), 4);
        assert!(requests[3].starts_with("DELETE /api/v1/shares/"));
        assert!(file.path().is_file());
    }

    #[test]
    fn endpoint_refuses_credentials_untrusted_schemes_and_upstream_services() {
        for value in [
            "https://cap.so",
            "https://api.cap.so",
            "https://cap.link",
            "http://example.com",
            "https://user:secret@example.com",
            "https://example.com/a",
            "https://example.com?token=x",
            "https://example.com#x",
        ] {
            assert!(endpoint(value).is_err(), "{value}");
        }
        for value in [
            "https://demo.jacks.med",
            "https://own.example",
            "http://127.0.0.1:8192",
        ] {
            assert!(endpoint(value).is_ok(), "{value}");
        }
        assert!(!Settings::default().enabled);
        assert!(Settings::default().endpoint.is_empty());
    }
}
