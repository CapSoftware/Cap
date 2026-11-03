use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::Deserialize;
use serde_json::json;

const BLOCK: u64 = 512;
const ROOT_NAME: &str = "recording.cap";
const USTAR_SIZE_LIMIT: u64 = 0o77777777777;
const URL_BATCH: usize = 50;
const PART_ATTEMPTS: u32 = 4;
const MIN_PART: u64 = 5 * 1024 * 1024;
const MAX_PART: u64 = 512 * 1024 * 1024;
const MAX_PARTS: u64 = 10_000;

#[derive(Debug, Clone)]
struct TarEntry {
    name: String,
    source: Option<PathBuf>,
    size: u64,
    mtime: u64,
}

fn pad(len: u64) -> u64 {
    (BLOCK - len % BLOCK) % BLOCK
}

fn pax_record(key: &str, value: &str) -> String {
    let base = key.len() + value.len() + 3;
    let mut length = base + 1;
    while length != base + length.to_string().len() {
        length = base + length.to_string().len();
    }
    format!("{length} {key}={value}\n")
}

fn needs_pax(entry: &TarEntry) -> bool {
    entry.name.len() > 100 || !entry.name.is_ascii() || entry.size > USTAR_SIZE_LIMIT
}

fn pax_body(entry: &TarEntry) -> String {
    let mut body = pax_record("path", &entry.name);
    if entry.size > USTAR_SIZE_LIMIT {
        body.push_str(&pax_record("size", &entry.size.to_string()));
    }
    body
}

fn octal(field: &mut [u8], value: u64) {
    let digits = field.len() - 1;
    let text = format!("{value:0digits$o}");
    let bytes = text.as_bytes();
    let start = bytes.len().saturating_sub(digits);
    field[..digits].copy_from_slice(&bytes[start..]);
    field[digits] = 0;
}

fn header(name: &str, size: u64, mtime: u64, typeflag: u8) -> [u8; 512] {
    let mut block = [0u8; 512];
    let short: String = if name.len() <= 100 && name.is_ascii() {
        name.to_string()
    } else {
        let ascii: String = name
            .chars()
            .map(|ch| {
                if ch.is_ascii() && !ch.is_ascii_control() {
                    ch
                } else {
                    '_'
                }
            })
            .collect();
        ascii
            .chars()
            .rev()
            .take(100)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect()
    };
    block[..short.len()].copy_from_slice(short.as_bytes());
    let mode = if typeflag == b'5' { 0o755 } else { 0o644 };
    octal(&mut block[100..108], mode);
    octal(&mut block[108..116], 0);
    octal(&mut block[116..124], 0);
    octal(&mut block[124..136], size.min(USTAR_SIZE_LIMIT));
    octal(&mut block[136..148], mtime.min(USTAR_SIZE_LIMIT));
    block[148..156].fill(b' ');
    block[156] = typeflag;
    block[257..263].copy_from_slice(b"ustar\0");
    block[263..265].copy_from_slice(b"00");
    let sum: u64 = block.iter().map(|byte| *byte as u64).sum();
    let text = format!("{sum:06o}\0 ");
    block[148..156].copy_from_slice(text.as_bytes());
    block
}

impl TarEntry {
    fn is_dir(&self) -> bool {
        self.source.is_none()
    }

    fn encoded_len(&self) -> u64 {
        let pax = if needs_pax(self) {
            let body = pax_body(self).len() as u64;
            BLOCK + body + pad(body)
        } else {
            0
        };
        pax + BLOCK + self.size + pad(self.size)
    }

    fn header_bytes(&self) -> Vec<u8> {
        let mut out = Vec::new();
        if needs_pax(self) {
            let body = pax_body(self);
            out.extend_from_slice(&header(
                "././@PaxHeader",
                body.len() as u64,
                self.mtime,
                b'x',
            ));
            out.extend_from_slice(body.as_bytes());
            out.extend(std::iter::repeat_n(0u8, pad(body.len() as u64) as usize));
        }
        out.extend_from_slice(&header(
            &self.name,
            self.size,
            self.mtime,
            if self.is_dir() { b'5' } else { b'0' },
        ));
        out
    }
}

pub struct TarPlan {
    entries: Vec<TarEntry>,
}

impl TarPlan {
    pub fn build(root: &Path) -> std::io::Result<Self> {
        let mut entries = vec![TarEntry {
            name: format!("{ROOT_NAME}/"),
            source: None,
            size: 0,
            mtime: 0,
        }];
        visit(root, root, &mut entries)?;
        Ok(Self { entries })
    }

    pub fn total_size(&self) -> u64 {
        self.entries.iter().map(TarEntry::encoded_len).sum::<u64>() + 2 * BLOCK
    }

    pub fn reader(self) -> TarReader {
        TarReader {
            entries: self.entries.into_iter(),
            pending: Vec::new(),
            pending_offset: 0,
            current: None,
            remaining: 0,
            padding: 0,
            finished: false,
        }
    }
}

fn visit(root: &Path, dir: &Path, entries: &mut Vec<TarEntry>) -> std::io::Result<()> {
    let mut children: Vec<_> = std::fs::read_dir(dir)?.filter_map(Result::ok).collect();
    children.sort_by_key(|entry| entry.file_name());
    for child in children {
        let path = child.path();
        let metadata = path.symlink_metadata()?;
        if metadata.file_type().is_symlink() {
            continue;
        }
        let Ok(rel) = path.strip_prefix(root) else {
            continue;
        };
        let rel = rel.to_string_lossy().replace('\\', "/");
        let mtime = metadata
            .modified()
            .ok()
            .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
            .map_or(0, |elapsed| elapsed.as_secs());
        if metadata.is_dir() {
            entries.push(TarEntry {
                name: format!("{ROOT_NAME}/{rel}/"),
                source: None,
                size: 0,
                mtime,
            });
            visit(root, &path, entries)?;
        } else if metadata.is_file() {
            entries.push(TarEntry {
                name: format!("{ROOT_NAME}/{rel}"),
                source: Some(path),
                size: metadata.len(),
                mtime,
            });
        }
    }
    Ok(())
}

pub struct TarReader {
    entries: std::vec::IntoIter<TarEntry>,
    pending: Vec<u8>,
    pending_offset: usize,
    current: Option<std::fs::File>,
    remaining: u64,
    padding: u64,
    finished: bool,
}

impl Read for TarReader {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        loop {
            if buf.is_empty() {
                return Ok(0);
            }
            if self.pending_offset < self.pending.len() {
                let available = &self.pending[self.pending_offset..];
                let count = available.len().min(buf.len());
                buf[..count].copy_from_slice(&available[..count]);
                self.pending_offset += count;
                return Ok(count);
            }
            if self.remaining > 0 {
                let want = (self.remaining.min(buf.len() as u64)) as usize;
                let read = match self.current.as_mut() {
                    Some(file) => file.read(&mut buf[..want])?,
                    None => 0,
                };
                let count = if read == 0 {
                    self.current = None;
                    buf[..want].fill(0);
                    want
                } else {
                    read
                };
                self.remaining -= count as u64;
                return Ok(count);
            }
            if self.padding > 0 {
                let count = (self.padding.min(buf.len() as u64)) as usize;
                buf[..count].fill(0);
                self.padding -= count as u64;
                return Ok(count);
            }
            self.current = None;
            match self.entries.next() {
                Some(entry) => {
                    self.pending = entry.header_bytes();
                    self.pending_offset = 0;
                    self.remaining = entry.size;
                    self.padding = pad(entry.size);
                    self.current = match &entry.source {
                        Some(path) if entry.size > 0 => std::fs::File::open(path).ok(),
                        _ => None,
                    };
                }
                None if !self.finished => {
                    self.finished = true;
                    self.pending = vec![0u8; (2 * BLOCK) as usize];
                    self.pending_offset = 0;
                }
                None => return Ok(0),
            }
        }
    }
}

#[derive(Debug, Clone)]
pub struct SubmissionInfo {
    pub operation: &'static str,
    pub error_message: String,
    pub diagnosis: Option<String>,
    pub session_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateResponse {
    submission_id: String,
    upload_id: String,
    part_size: u64,
}

#[derive(Deserialize)]
struct PartUrls {
    urls: std::collections::HashMap<String, String>,
}

async fn api_post(path: &str, body: serde_json::Value) -> Result<serde_json::Value, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(60))
        .build()
        .map_err(|error| error.to_string())?;
    let response =
        crate::auth::authed_request_with(&client, reqwest::Method::POST, path, Some(body))
            .await
            .map_err(|error| match error {
                crate::auth::AuthApiError::InvalidAuthentication => {
                    "Sign in to Cap to send recordings".to_string()
                }
                crate::auth::AuthApiError::Timeout => "Cap did not respond in time".to_string(),
                _ => "Could not reach Cap".to_string(),
            })?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!("Cap returned an error ({status})"));
    }
    response
        .json()
        .await
        .map_err(|_| "Cap returned an unexpected response".to_string())
}

pub async fn send(
    root: PathBuf,
    info: SubmissionInfo,
    cancelled: impl Fn() -> bool,
    progress: impl Fn(u64, u64),
) -> Result<(), String> {
    let plan = tokio::task::spawn_blocking(move || TarPlan::build(&root))
        .await
        .map_err(|error| error.to_string())?
        .map_err(|error| format!("Could not read the recording: {error}"))?;
    let total = plan.total_size();
    progress(0, total);
    let created: CreateResponse = serde_json::from_value(
        api_post(
            "/api/desktop/repair/submissions",
            json!({
                "sizeBytes": total,
                "operation": info.operation,
                "appVersion": env!("CARGO_PKG_VERSION"),
                "os": std::env::consts::OS,
                "errorMessage": super::sanitize::truncate(&info.error_message, 4000),
                "diagnosis": info.diagnosis.as_deref().map(|text| super::sanitize::truncate(text, 4000)),
                "sessionId": info.session_id,
            }),
        )
        .await?,
    )
    .map_err(|_| "Cap returned an unexpected response".to_string())?;
    let part_size = created.part_size;
    if !(MIN_PART..=MAX_PART).contains(&part_size) || total.div_ceil(part_size) > MAX_PARTS {
        return Err("Cap returned an invalid upload size".into());
    }
    if !created
        .submission_id
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || ch == '_' || ch == '-')
    {
        return Err("Cap returned an invalid submission".into());
    }
    let parts_path = format!(
        "/api/desktop/repair/submissions/{}/parts",
        created.submission_id
    );
    let part_count = total.div_ceil(part_size);
    let put_client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30 * 60))
        .connect_timeout(Duration::from_secs(20))
        .build()
        .map_err(|error| error.to_string())?;
    let mut reader = Some(plan.reader());
    let mut etags: Vec<serde_json::Value> = Vec::new();
    let mut sent = 0u64;
    let mut part = 1u64;
    while part <= part_count {
        let batch: Vec<u64> = (part..=part_count.min(part + URL_BATCH as u64 - 1)).collect();
        let fetch_urls = |numbers: Vec<u64>| {
            let parts_path = parts_path.clone();
            let upload_id = created.upload_id.clone();
            async move {
                let urls: PartUrls = serde_json::from_value(
                    api_post(
                        &parts_path,
                        json!({ "uploadId": upload_id, "partNumbers": numbers }),
                    )
                    .await?,
                )
                .map_err(|_| "Cap returned an unexpected response".to_string())?;
                Ok::<_, String>(urls.urls)
            }
        };
        let mut urls = fetch_urls(batch.clone()).await?;
        for number in batch {
            if cancelled() {
                return Err("cancelled".into());
            }
            let length = part_size.min(total - (number - 1) * part_size);
            let taken = reader
                .take()
                .ok_or_else(|| "archive reader lost".to_string())?;
            let (returned, buffer) = tokio::task::spawn_blocking(move || {
                let mut taken = taken;
                let mut buffer = vec![0u8; length as usize];
                let result = taken.read_exact(&mut buffer).map(|()| buffer);
                (taken, result)
            })
            .await
            .map_err(|error| error.to_string())?;
            reader = Some(returned);
            let buffer = bytes::Bytes::from(
                buffer.map_err(|error| format!("Could not read the recording: {error}"))?,
            );
            let mut attempt = 0;
            let etag = loop {
                attempt += 1;
                let url = urls
                    .get(&number.to_string())
                    .cloned()
                    .ok_or_else(|| "Cap did not return an upload address".to_string())?;
                if !url.starts_with("https://") {
                    return Err("Cap returned an insecure upload address".into());
                }
                let outcome = put_client
                    .put(&url)
                    .header(reqwest::header::CONTENT_LENGTH, buffer.len())
                    .body(buffer.clone())
                    .send()
                    .await;
                match outcome {
                    Ok(response) if response.status().is_success() => {
                        let Some(etag) = response
                            .headers()
                            .get(reqwest::header::ETAG)
                            .and_then(|value| value.to_str().ok())
                        else {
                            return Err("Upload did not return a receipt".into());
                        };
                        break etag.to_string();
                    }
                    Ok(response) if response.status() == reqwest::StatusCode::FORBIDDEN => {
                        if attempt >= PART_ATTEMPTS {
                            return Err("Upload was refused".into());
                        }
                        urls.extend(fetch_urls(vec![number]).await?);
                    }
                    _ if attempt >= PART_ATTEMPTS => {
                        return Err("Upload failed; check your connection and try again".into());
                    }
                    _ => {}
                }
                tokio::time::sleep(Duration::from_secs(1 << (attempt - 1))).await;
            };
            etags.push(json!({ "partNumber": number, "etag": etag }));
            sent += length;
            progress(sent, total);
        }
        part += URL_BATCH as u64;
    }
    api_post(
        &format!(
            "/api/desktop/repair/submissions/{}/complete",
            created.submission_id
        ),
        json!({ "uploadId": created.upload_id, "parts": etags }),
    )
    .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Parsed {
        name: String,
        typeflag: u8,
        data: Vec<u8>,
    }

    fn parse(archive: &[u8]) -> Vec<Parsed> {
        let mut out = Vec::new();
        let mut offset = 0usize;
        let mut pax_path: Option<String> = None;
        while offset + 512 <= archive.len() {
            let block = &archive[offset..offset + 512];
            if block.iter().all(|byte| *byte == 0) {
                break;
            }
            let stored: u64 = u64::from_str_radix(
                std::str::from_utf8(&block[148..154])
                    .unwrap()
                    .trim_matches(['\0', ' ']),
                8,
            )
            .unwrap();
            let mut copy = block.to_vec();
            copy[148..156].fill(b' ');
            assert_eq!(stored, copy.iter().map(|byte| *byte as u64).sum::<u64>());
            assert_eq!(&block[257..263], b"ustar\0");
            let name_end = block[..100]
                .iter()
                .position(|byte| *byte == 0)
                .unwrap_or(100);
            let name = String::from_utf8(block[..name_end].to_vec()).unwrap();
            let size_text = std::str::from_utf8(&block[124..135]).unwrap();
            let size = u64::from_str_radix(size_text, 8).unwrap() as usize;
            let typeflag = block[156];
            let data = archive[offset + 512..offset + 512 + size].to_vec();
            offset += 512 + size + pad(size as u64) as usize;
            if typeflag == b'x' {
                let text = String::from_utf8(data).unwrap();
                let record = text.lines().find(|line| line.contains(" path=")).unwrap();
                let (length, rest) = record.split_once(' ').unwrap();
                assert_eq!(length.parse::<usize>().unwrap(), record.len() + 1);
                pax_path = Some(rest.strip_prefix("path=").unwrap().to_string());
                continue;
            }
            out.push(Parsed {
                name: pax_path.take().unwrap_or(name),
                typeflag,
                data,
            });
        }
        out
    }

    #[test]
    fn tar_round_trips_with_exact_size_and_pax_paths() {
        let root = std::env::temp_dir().join(format!(
            "cap-repair-tar-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let deep = root
            .join("content/segments/segment-0/display")
            .join("x".repeat(90));
        std::fs::create_dir_all(&deep).unwrap();
        std::fs::write(root.join("recording-meta.json"), b"{\"a\":1}").unwrap();
        std::fs::write(deep.join("fragment_é.m4s"), vec![7u8; 1500]).unwrap();
        std::fs::write(root.join("empty.json"), b"").unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink("/etc/passwd", root.join("link")).unwrap();

        let plan = TarPlan::build(&root).unwrap();
        let total = plan.total_size();
        let mut archive = Vec::new();
        plan.reader().read_to_end(&mut archive).unwrap();
        assert_eq!(archive.len() as u64, total);
        assert_eq!(total % 512, 0);

        let entries = parse(&archive);
        let names: Vec<&str> = entries.iter().map(|entry| entry.name.as_str()).collect();
        assert!(names.contains(&"recording.cap/"));
        assert!(names.contains(&"recording.cap/recording-meta.json"));
        assert!(!names.iter().any(|name| name.ends_with("/link")));
        let long = entries
            .iter()
            .find(|entry| entry.name.ends_with("fragment_é.m4s"))
            .unwrap();
        assert!(long.name.len() > 100);
        assert_eq!(long.data, vec![7u8; 1500]);
        assert_eq!(long.typeflag, b'0');
        let meta = entries
            .iter()
            .find(|entry| entry.name.ends_with("recording-meta.json"))
            .unwrap();
        assert_eq!(meta.data, b"{\"a\":1}");
        assert!(entries.iter().any(|entry| entry.typeflag == b'5'));
        std::fs::remove_dir_all(root).ok();
    }

    #[test]
    fn shrinking_files_keep_the_declared_size() {
        let root =
            std::env::temp_dir().join(format!("cap-repair-tar-shrink-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("a.m4s"), vec![1u8; 2000]).unwrap();
        let plan = TarPlan::build(&root).unwrap();
        let total = plan.total_size();
        std::fs::write(root.join("a.m4s"), vec![1u8; 10]).unwrap();
        let mut archive = Vec::new();
        plan.reader().read_to_end(&mut archive).unwrap();
        assert_eq!(archive.len() as u64, total);
        std::fs::remove_dir_all(root).ok();
    }

    #[test]
    fn pax_record_length_counts_itself() {
        for value in ["a", &"b".repeat(95), &"c".repeat(994)] {
            let record = pax_record("path", value);
            let (length, _) = record.split_once(' ').unwrap();
            assert_eq!(length.parse::<usize>().unwrap(), record.len());
        }
    }
}
