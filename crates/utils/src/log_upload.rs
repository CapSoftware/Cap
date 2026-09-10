use serde::Serialize;
use std::{
    io::{Read, Seek, SeekFrom},
    path::Path,
};

pub const MAX_LOG_BYTES: usize = 512 * 1024;
pub const MAX_REQUEST_BYTES: usize = 4 * 1024 * 1024;
const REQUEST_HEADROOM: usize = 64 * 1024;
const MAX_METADATA_BYTES: usize = 512 * 1024;
const MAX_REPORT_BYTES: usize = 2 * 1024 * 1024;
const OMITTED_ATTACHMENT: &str = r#"{"capLogUploadOmission":"size_limit"}"#;
const MAX_FILES: usize = 2;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogBundle {
    #[serde(skip_serializing)]
    pub text: String,
    #[serde(skip_serializing)]
    ordinary_end: usize,
    pub files: Vec<LogFile>,
    pub directory_entries_scanned: usize,
    pub directory_available: bool,
}

pub struct PreparedUpload {
    pub log: String,
    pub context: String,
    pub diagnostics: Option<String>,
    pub report: Option<String>,
}

fn bound_attachment(value: String, limit: usize) -> String {
    if value.len() > limit {
        OMITTED_ATTACHMENT.to_string()
    } else {
        value
    }
}

fn bound_tail(text: &mut String, limit: usize) -> usize {
    if text.len() <= limit {
        return 0;
    }
    let marker = "[Earlier bytes omitted to fit the upload budget]\n";
    let mut start = text
        .len()
        .saturating_sub(limit.saturating_sub(marker.len()));
    while !text.is_char_boundary(start) {
        start += 1;
    }
    start = text[start..]
        .find('\n')
        .map_or(text.len(), |offset| start + offset + 1);
    text.drain(..start);
    if limit >= marker.len() {
        text.insert_str(0, marker);
    }
    start
}

pub fn prepare_upload(
    log: LogBundle,
    mut context: serde_json::Value,
    diagnostics: Option<&str>,
    report: Option<&str>,
    redact: impl Fn(&str) -> String,
) -> PreparedUpload {
    let diagnostics = diagnostics.map(|value| bound_attachment(redact(value), MAX_METADATA_BYTES));
    let report = report.map(|value| bound_attachment(redact(value), MAX_REPORT_BYTES));
    let mut ordinary = redact(&log.text[..log.ordinary_end]);
    let mut journal = redact(&log.text[log.ordinary_end..]);
    if let Some(object) = context.as_object_mut() {
        let _ = object.insert(
            "logCoverage".into(),
            serde_json::to_value(&log).unwrap_or_default(),
        );
    }
    let mut context = bound_attachment(
        redact(&serde_json::to_string(&context).unwrap_or_default()),
        MAX_METADATA_BYTES,
    );
    let metadata_bytes = context.len()
        + diagnostics.as_ref().map_or(0, String::len)
        + report.as_ref().map_or(0, String::len);
    let log_budget = MAX_REQUEST_BYTES.saturating_sub(REQUEST_HEADROOM + metadata_bytes);
    let omitted_ordinary = bound_tail(&mut ordinary, MAX_LOG_BYTES.min(log_budget));
    let omitted_journal = bound_tail(&mut journal, log_budget.saturating_sub(ordinary.len()));
    let omitted = omitted_ordinary.saturating_add(omitted_journal);
    if omitted > 0
        && let Ok(serde_json::Value::Object(mut object)) = serde_json::from_str(&context)
    {
        let _ = object.insert("redactedLogBytesOmittedForUpload".into(), omitted.into());
        context = bound_attachment(
            serde_json::to_string(&object).unwrap_or_default(),
            MAX_METADATA_BYTES,
        );
    }
    ordinary.push_str(&journal);
    PreparedUpload {
        log: ordinary,
        context,
        diagnostics,
        report,
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogFile {
    pub name: String,
    pub original_bytes: u64,
    pub bytes_read: usize,
    pub truncated: bool,
    pub readable: bool,
}

fn read_tail(path: &Path, budget: usize) -> std::io::Result<(String, u64, usize)> {
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW);
    }
    let mut file = options.open(path)?;
    let metadata = file.metadata()?;
    if !metadata.is_file() {
        return Err(std::io::Error::other("Log is not a regular file"));
    }
    let length = metadata.len();
    let offset = length.saturating_sub(budget as u64);
    file.seek(SeekFrom::Start(offset))?;
    let mut bytes = Vec::new();
    file.take(length.saturating_sub(offset))
        .read_to_end(&mut bytes)?;
    let bytes_read = bytes.len();
    let start = if offset > 0 {
        bytes
            .iter()
            .position(|byte| *byte == b'\n')
            .map_or(bytes.len(), |index| index + 1)
    } else {
        0
    };
    let mut text = String::from_utf8_lossy(&bytes[start..]).into_owned();
    if text.len() > budget {
        let mut end = budget;
        while !text.is_char_boundary(end) {
            end = end.saturating_sub(1);
        }
        text.truncate(end);
    }
    Ok((text, length, bytes_read))
}

pub fn collect(dir: &Path, prefix: &str) -> LogBundle {
    let mut bundle = LogBundle {
        text: String::new(),
        ordinary_end: 0,
        files: Vec::new(),
        directory_entries_scanned: 0,
        directory_available: false,
    };
    let Ok(entries) = std::fs::read_dir(dir) else {
        bundle.text.push_str("Log directory is unavailable.\n");
        return bundle;
    };
    bundle.directory_available = true;
    let mut candidates = Vec::new();
    for entry in entries {
        bundle.directory_entries_scanned = bundle.directory_entries_scanned.saturating_add(1);
        let Ok(entry) = entry else { continue };
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        let Some(suffix) = name.strip_prefix(prefix) else {
            continue;
        };
        if !suffix
            .bytes()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'.' | b'-'))
            || !entry.file_type().is_ok_and(|kind| kind.is_file())
        {
            continue;
        }
        candidates.push((name.to_string(), entry.path()));
        candidates.sort_unstable_by(|left, right| right.0.cmp(&left.0));
        candidates.truncate(MAX_FILES);
    }
    let normal_budget = MAX_LOG_BYTES / candidates.len().max(1);
    let mut selected: Vec<_> = candidates
        .into_iter()
        .rev()
        .map(|(name, path)| (name, path, normal_budget))
        .collect();
    for suffix in ["diagnostic-previous.jsonl", "diagnostic-current.jsonl"] {
        let name = format!("{prefix}.{suffix}");
        let path = dir.join(&name);
        if std::fs::symlink_metadata(&path).is_ok_and(|metadata| metadata.file_type().is_file()) {
            selected.push((
                name,
                path,
                crate::diagnostic_writer::MAX_FILE_BYTES as usize,
            ));
        }
    }
    for (name, path, budget) in selected {
        let is_journal = name.ends_with(".jsonl");
        match read_tail(&path, budget) {
            Ok((text, original_bytes, bytes_read)) => {
                bundle.text.push_str(&format!("\n--- {name} ---\n"));
                if original_bytes > bytes_read as u64 {
                    bundle.text.push_str("[Earlier log bytes omitted]\n");
                }
                bundle.text.push_str(&text);
                bundle.files.push(LogFile {
                    name,
                    original_bytes,
                    bytes_read,
                    truncated: original_bytes > bytes_read as u64,
                    readable: true,
                });
            }
            Err(_) => {
                bundle
                    .text
                    .push_str(&format!("\n--- {name}: unavailable ---\n"));
                bundle.files.push(LogFile {
                    name,
                    original_bytes: 0,
                    bytes_read: 0,
                    truncated: false,
                    readable: false,
                });
            }
        }
        if !is_journal {
            bundle.ordinary_end = bundle.text.len();
        }
    }
    if bundle.files.is_empty() {
        bundle.text.push_str("No matching log files were found.\n");
    }
    bundle
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn retained_history_fits_with_large_metadata_and_recent_events() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("cap.log"), "ordinary error\n").unwrap();
        for suffix in ["previous", "current"] {
            let mut text =
                "event\n".repeat(crate::diagnostic_writer::MAX_FILE_BYTES as usize / 6 - 10);
            text.push_str(&format!("latest {suffix}\n"));
            std::fs::write(
                dir.path()
                    .join(format!("cap.log.diagnostic-{suffix}.jsonl")),
                text,
            )
            .unwrap();
        }
        let bundle = collect(dir.path(), "cap.log");
        assert!(bundle.text.len() > 2 * crate::diagnostic_writer::MAX_FILE_BYTES as usize - 1024);
        let diagnostics =
            serde_json::json!({ "data": "d".repeat(MAX_METADATA_BYTES - 1024) }).to_string();
        let report = serde_json::json!({ "data": "r".repeat(MAX_REPORT_BYTES - 1024) }).to_string();
        let context = serde_json::json!({ "data": "c".repeat(MAX_METADATA_BYTES - 4096) });
        let prepared = prepare_upload(
            bundle,
            context,
            Some(&diagnostics),
            Some(&report),
            str::to_string,
        );
        let total = prepared.log.len()
            + prepared.context.len()
            + prepared.diagnostics.as_ref().unwrap().len()
            + prepared.report.as_ref().unwrap().len();
        assert!(total < MAX_REQUEST_BYTES);
        assert!(prepared.log.contains("ordinary error"));
        assert!(prepared.log.ends_with("latest current\n"));
        let context: serde_json::Value = serde_json::from_str(&prepared.context).unwrap();
        assert!(
            context["redactedLogBytesOmittedForUpload"]
                .as_u64()
                .unwrap()
                > 0
        );
    }

    #[test]
    fn redaction_expansion_and_oversized_optional_reports_cannot_overfill_an_upload() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("cap.log"), "a\n".repeat(MAX_LOG_BYTES / 2)).unwrap();
        let bundle = collect(dir.path(), "cap.log");
        let prepared = prepare_upload(
            bundle,
            serde_json::json!({}),
            None,
            Some(&"x".repeat(MAX_REPORT_BYTES + 1)),
            |value| value.replace('a', "[REDACTED]"),
        );
        assert!(prepared.log.len() <= MAX_LOG_BYTES);
        assert_eq!(prepared.report.as_deref(), Some(OMITTED_ATTACHMENT));
        assert!(prepared.log.contains("[REDACTED]"));
    }

    #[test]
    fn reads_only_the_tail_of_a_large_file() {
        let mut file = tempfile::NamedTempFile::new().unwrap();
        file.as_file_mut().set_len(4 * 1024 * 1024 * 1024).unwrap();
        file.seek(SeekFrom::End(0)).unwrap();
        file.write_all(b"\nlast event\n").unwrap();
        let (text, length, read) = read_tail(file.path(), 1024).unwrap();
        assert!(length > 4 * 1024 * 1024 * 1024);
        assert_eq!(read, 1024);
        assert_eq!(text, "last event\n");
    }

    #[test]
    fn collects_two_recent_files_with_a_fixed_read_budget() {
        let dir = tempfile::tempdir().unwrap();
        for day in ["2026-09-06", "2026-09-07", "2026-09-08"] {
            std::fs::write(dir.path().join(format!("cap-desktop.log.{day}")), "event\n").unwrap();
        }
        std::fs::write(dir.path().join("cap-desktop.log.secret-title"), "private").unwrap();
        let bundle = collect(dir.path(), "cap-desktop.log");
        assert_eq!(bundle.files.len(), 2);
        assert!(bundle.files[1].name.ends_with("2026-09-08"));
        assert!(!bundle.text.contains("private"));
        assert!(
            bundle
                .files
                .iter()
                .map(|file| file.bytes_read)
                .sum::<usize>()
                <= MAX_LOG_BYTES
        );
    }

    #[test]
    fn handles_partial_utf8_missing_logs_and_scan_limits() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("cap.log");
        std::fs::write(&path, "éééé\ncomplete\n").unwrap();
        assert_eq!(read_tail(&path, 12).unwrap().0, "complete\n");
        for index in 0..150 {
            std::fs::write(dir.path().join(format!("unrelated-{index}")), "").unwrap();
        }
        let bundle = collect(dir.path(), "cap.log");
        assert_eq!(bundle.directory_entries_scanned, 151);
        assert!(bundle.files.iter().any(|file| file.name == "cap.log"));
        assert!(!collect(&dir.path().join("missing"), "cap.log").directory_available);
    }
}
