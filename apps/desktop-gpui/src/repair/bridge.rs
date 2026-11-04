use std::io::{Read, Write};
use std::path::PathBuf;
use std::time::Duration;

use futures_util::StreamExt;

use super::protocol::{PollRequest, PollResponse, ToolResult};

pub const SANDBOX_OUT_PREFIX: &str = "/vercel/sandbox/work/out/";
const POLL_TIMEOUT: Duration = Duration::from_secs(40);
const TRANSFER_TIMEOUT: Duration = Duration::from_secs(60 * 60);
const CHUNK: usize = 1024 * 1024;

#[derive(Debug)]
pub enum BridgeError {
    Unauthorized,
    Transient(String),
}

#[derive(Clone)]
pub struct BridgeClient {
    base: reqwest::Url,
    token: String,
    poll_client: reqwest::Client,
    transfer_client: reqwest::Client,
}

impl BridgeClient {
    pub fn new(base: &str, token: &str, allow_loopback_http: bool) -> Result<Self, String> {
        let base = reqwest::Url::parse(base)
            .map_err(|_| "invalid repair workspace address".to_string())?;
        let loopback = matches!(base.host_str(), Some("127.0.0.1") | Some("localhost"));
        if base.scheme() != "https" && !(allow_loopback_http && loopback && base.scheme() == "http")
        {
            return Err("repair workspace address must use https".into());
        }
        if token.len() < 16 || !token.chars().all(|ch| ch.is_ascii_alphanumeric()) {
            return Err("invalid repair workspace token".into());
        }
        let poll_client = reqwest::Client::builder()
            .timeout(POLL_TIMEOUT)
            .connect_timeout(Duration::from_secs(15))
            .build()
            .map_err(|error| error.to_string())?;
        let transfer_client = reqwest::Client::builder()
            .timeout(TRANSFER_TIMEOUT)
            .connect_timeout(Duration::from_secs(15))
            .build()
            .map_err(|error| error.to_string())?;
        Ok(Self {
            base,
            token: token.to_string(),
            poll_client,
            transfer_client,
        })
    }

    fn url(&self, path: &str) -> reqwest::Url {
        let mut url = self.base.clone();
        url.set_path(path);
        url.set_query(None);
        url
    }

    pub async fn poll(
        &self,
        cursor: u64,
        results: &[ToolResult],
    ) -> Result<PollResponse, BridgeError> {
        let response = self
            .poll_client
            .post(self.url("/v1/poll"))
            .bearer_auth(&self.token)
            .json(&PollRequest { cursor, results })
            .send()
            .await
            .map_err(|error| BridgeError::Transient(error.without_url().to_string()))?;
        let status = response.status();
        if status == reqwest::StatusCode::UNAUTHORIZED || status == reqwest::StatusCode::FORBIDDEN {
            return Err(BridgeError::Unauthorized);
        }
        if !status.is_success() {
            return Err(BridgeError::Transient(format!("status {status}")));
        }
        response
            .json::<PollResponse>()
            .await
            .map_err(|error| BridgeError::Transient(error.without_url().to_string()))
    }

    pub async fn upload_pulled(
        &self,
        rel: &str,
        source: PathBuf,
        length: u64,
    ) -> Result<u64, String> {
        let mut url = self.url("/v1/files/pulled");
        url.query_pairs_mut().append_pair("path", rel);
        let file = std::fs::File::open(&source).map_err(|error| error.to_string())?;
        let stream = futures_util::stream::unfold(Some(file.take(length)), |state| async move {
            let mut reader = state?;
            let chunk = tokio::task::spawn_blocking(move || {
                let mut buffer = vec![0u8; CHUNK];
                let read = reader.read(&mut buffer);
                (reader, read, buffer)
            })
            .await;
            match chunk {
                Ok((_, Ok(0), _)) => None,
                Ok((reader, Ok(read), mut buffer)) => {
                    buffer.truncate(read);
                    Some((Ok(bytes::Bytes::from(buffer)), Some(reader)))
                }
                Ok((_, Err(error), _)) => Some((Err(error), None)),
                Err(error) => Some((Err(std::io::Error::other(error.to_string())), None)),
            }
        });
        let response = self
            .transfer_client
            .put(url)
            .bearer_auth(&self.token)
            .header(reqwest::header::CONTENT_LENGTH, length)
            .header(reqwest::header::CONTENT_TYPE, "application/octet-stream")
            .body(reqwest::Body::wrap_stream(stream))
            .send()
            .await
            .map_err(|error| format!("upload failed: {}", error.without_url()))?;
        if !response.status().is_success() {
            return Err(format!("upload failed with status {}", response.status()));
        }
        let body: serde_json::Value = response
            .json()
            .await
            .map_err(|error| format!("upload failed: {}", error.without_url()))?;
        body.get("size")
            .and_then(serde_json::Value::as_u64)
            .ok_or_else(|| "upload response had no size".to_string())
    }

    pub async fn download_out(
        &self,
        sandbox_path: &str,
        dest: PathBuf,
        max: u64,
    ) -> Result<u64, String> {
        validate_out_path(sandbox_path)?;
        let mut url = self.url("/v1/files/out");
        url.query_pairs_mut().append_pair("path", sandbox_path);
        let response = self
            .transfer_client
            .get(url)
            .bearer_auth(&self.token)
            .send()
            .await
            .map_err(|error| format!("download failed: {}", error.without_url()))?;
        if !response.status().is_success() {
            return Err(format!("download failed with status {}", response.status()));
        }
        if response.content_length().is_some_and(|length| length > max) {
            return Err("replacement file is too large".into());
        }
        let mut file = std::fs::File::create(&dest).map_err(|error| error.to_string())?;
        let mut written = 0u64;
        let mut body = response.bytes_stream();
        let result = async {
            while let Some(chunk) = body.next().await {
                let chunk =
                    chunk.map_err(|error| format!("download failed: {}", error.without_url()))?;
                written += chunk.len() as u64;
                if written > max {
                    return Err("replacement file is too large".to_string());
                }
                file.write_all(&chunk).map_err(|error| error.to_string())?;
            }
            file.sync_all().map_err(|error| error.to_string())?;
            Ok(written)
        }
        .await;
        if result.is_err() {
            drop(file);
            std::fs::remove_file(&dest).ok();
        }
        result
    }
}

pub fn validate_out_path(path: &str) -> Result<(), String> {
    let Some(rest) = path.strip_prefix(SANDBOX_OUT_PREFIX) else {
        return Err(format!("sandboxPath must be under {SANDBOX_OUT_PREFIX}"));
    };
    if rest.is_empty()
        || rest.len() > 1024
        || rest
            .split('/')
            .any(|part| part.is_empty() || part == "." || part == "..")
        || rest.chars().any(|ch| ch.is_control() || ch == '\\')
    {
        return Err("invalid sandboxPath".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn out_paths_are_confined() {
        assert!(validate_out_path("/vercel/sandbox/work/out/fixed.m4s").is_ok());
        assert!(validate_out_path("/vercel/sandbox/work/out/a/b.mp4").is_ok());
        for bad in [
            "/vercel/sandbox/work/out/",
            "/vercel/sandbox/work/out/../recording/x",
            "/vercel/sandbox/work/recording/x",
            "/etc/passwd",
            "/vercel/sandbox/work/out//x",
        ] {
            assert!(validate_out_path(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn bridge_requires_https_outside_tests() {
        let token = "a".repeat(64);
        assert!(BridgeClient::new("http://evil.example", &token, false).is_err());
        assert!(BridgeClient::new("http://127.0.0.1:9", &token, false).is_err());
        assert!(BridgeClient::new("http://127.0.0.1:9", &token, true).is_ok());
        assert!(BridgeClient::new("https://x.vercel.run", "short", false).is_err());
        assert!(BridgeClient::new("https://x.vercel.run", &token, false).is_ok());
    }
}
