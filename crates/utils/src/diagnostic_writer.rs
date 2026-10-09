use std::{
    fs::{File, OpenOptions},
    io::{self, Write},
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
};

pub const RECORD_PREFIX: &[u8] = b"CAP_DIAGNOSTIC ";
pub const MAX_RECORD_BYTES: usize = 4096;
pub const MAX_FILE_BYTES: u64 = 4_500_000 / 2;
static WRITE_FAILURES: AtomicU64 = AtomicU64::new(0);

pub fn write_failures() -> u64 {
    WRITE_FAILURES.load(Ordering::Relaxed)
}

pub struct DiagnosticWriter<W, J = Journal> {
    ordinary: W,
    journal: J,
}

impl<W> DiagnosticWriter<W> {
    pub fn new(ordinary: W, directory: &Path, prefix: &str) -> Self {
        Self {
            ordinary,
            journal: Journal {
                current: directory.join(format!("{prefix}.diagnostic-current.jsonl")),
                previous: directory.join(format!("{prefix}.diagnostic-previous.jsonl")),
                file: None,
                bytes: 0,
                disabled: false,
            },
        }
    }
}

impl<W: Write, J: Write> Write for DiagnosticWriter<W, J> {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        if bytes.starts_with(RECORD_PREFIX) {
            if bytes.len() > MAX_RECORD_BYTES || self.journal.write_all(bytes).is_err() {
                WRITE_FAILURES.fetch_add(1, Ordering::Relaxed);
            }
            Ok(bytes.len())
        } else {
            self.ordinary.write(bytes)
        }
    }

    fn flush(&mut self) -> io::Result<()> {
        if self.journal.flush().is_err() {
            WRITE_FAILURES.fetch_add(1, Ordering::Relaxed);
        }
        self.ordinary.flush()
    }
}

pub struct Journal {
    current: PathBuf,
    previous: PathBuf,
    file: Option<File>,
    bytes: u64,
    disabled: bool,
}

fn reject_non_regular(path: &Path) -> io::Result<()> {
    match std::fs::symlink_metadata(path) {
        Ok(metadata) if !metadata.file_type().is_file() => Err(io::Error::other(
            "Diagnostic destination is not a regular file",
        )),
        Err(error) if error.kind() != io::ErrorKind::NotFound => Err(error),
        _ => Ok(()),
    }
}

impl Journal {
    fn open(&mut self) -> io::Result<()> {
        reject_non_regular(&self.current)?;
        let mut options = OpenOptions::new();
        options.create(true).append(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
        }
        let mut file = options.open(&self.current)?;
        self.bytes = file.metadata()?.len();
        if self.bytes > 0 && self.bytes < MAX_FILE_BYTES {
            file.write_all(b"\n")?;
            self.bytes += 1;
        }
        self.file = Some(file);
        Ok(())
    }

    fn append(&mut self, bytes: &[u8]) -> io::Result<()> {
        if self.file.is_none() {
            self.open()?;
        }
        if self.bytes.saturating_add(bytes.len() as u64) > MAX_FILE_BYTES {
            self.file = None;
            reject_non_regular(&self.previous)?;
            match std::fs::remove_file(&self.previous) {
                Err(error) if error.kind() != io::ErrorKind::NotFound => return Err(error),
                _ => {}
            }
            std::fs::rename(&self.current, &self.previous)?;
            self.open()?;
        }
        if let Some(file) = &mut self.file {
            file.write_all(bytes)?;
            self.bytes = self.bytes.saturating_add(bytes.len() as u64);
        }
        Ok(())
    }
}

impl Write for Journal {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        if self.disabled {
            return Err(io::Error::other("Diagnostic journal is unavailable"));
        }
        if bytes.len() > MAX_RECORD_BYTES {
            return Err(io::Error::other(
                "Diagnostic record exceeded its size limit",
            ));
        }
        if let Err(error) = self.append(bytes) {
            self.disabled = true;
            self.file = None;
            return Err(error);
        }
        Ok(bytes.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_stalled_disk_worker_drops_queued_records_without_blocking_the_caller() {
        struct StalledWriter(std::sync::mpsc::Receiver<()>);
        impl Write for StalledWriter {
            fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
                let _ = self.0.recv();
                Ok(bytes.len())
            }
            fn flush(&mut self) -> io::Result<()> {
                Ok(())
            }
        }
        let (release, blocked) = std::sync::mpsc::channel();
        let (mut writer, guard) = tracing_appender::non_blocking::NonBlockingBuilder::default()
            .buffered_lines_limit(1)
            .lossy(true)
            .finish(StalledWriter(blocked));
        let errors = writer.error_counter();
        for _ in 0..1000 {
            writer.write_all(b"CAP_DIAGNOSTIC {}\n").unwrap();
        }
        assert!(errors.dropped_lines() > 0);
        drop(release);
        drop(guard);
    }

    #[test]
    fn interrupted_record_does_not_corrupt_the_next_process_record() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("cap-test.log.diagnostic-current.jsonl");
        std::fs::write(&path, b"CAP_DIAGNOSTIC {\"partial\":").unwrap();
        let mut writer = DiagnosticWriter::new(Vec::new(), dir.path(), "cap-test.log");
        writer
            .write_all(b"CAP_DIAGNOSTIC {\"complete\":true}\n")
            .unwrap();
        let text = std::fs::read_to_string(path).unwrap();
        let complete = text
            .lines()
            .filter_map(|line| line.strip_prefix("CAP_DIAGNOSTIC "))
            .filter_map(|line| serde_json::from_str::<serde_json::Value>(line).ok())
            .collect::<Vec<_>>();
        assert_eq!(complete, vec![serde_json::json!({"complete": true})]);
    }

    #[test]
    fn rotation_bounds_storage_and_preserves_the_previous_file() {
        let dir = tempfile::tempdir().unwrap();
        let mut writer = DiagnosticWriter::new(Vec::new(), dir.path(), "cap-test.log");
        let mut record = RECORD_PREFIX.to_vec();
        record.extend(std::iter::repeat_n(
            b'x',
            MAX_RECORD_BYTES - record.len() - 1,
        ));
        record.push(b'\n');
        for _ in 0..(MAX_FILE_BYTES as usize / MAX_RECORD_BYTES) * 3 + 1 {
            writer.write_all(&record).unwrap();
        }
        writer.write_all(b"ordinary log\n").unwrap();
        assert_eq!(writer.ordinary, b"ordinary log\n");
        let files: Vec<_> = std::fs::read_dir(dir.path()).unwrap().collect();
        assert_eq!(files.len(), 2);
        for file in files {
            let metadata = file.unwrap().metadata().unwrap();
            assert!(metadata.len() <= MAX_FILE_BYTES);
        }
    }

    #[test]
    fn disk_failure_does_not_fail_or_swallow_ordinary_logging() {
        struct FullDisk;
        impl Write for FullDisk {
            fn write(&mut self, _: &[u8]) -> io::Result<usize> {
                Err(io::Error::from_raw_os_error(28))
            }
            fn flush(&mut self) -> io::Result<()> {
                Err(io::Error::from_raw_os_error(28))
            }
        }
        let mut writer = DiagnosticWriter {
            ordinary: Vec::new(),
            journal: FullDisk,
        };
        writer.write_all(b"CAP_DIAGNOSTIC {}\n").unwrap();
        writer.write_all(b"recording is still running\n").unwrap();
        writer.flush().unwrap();
        assert_eq!(writer.ordinary, b"recording is still running\n");
    }

    #[test]
    fn unavailable_destination_disables_only_diagnostic_writes() {
        let dir = tempfile::tempdir().unwrap();
        let blocked = dir.path().join("cap-test.log.diagnostic-current.jsonl");
        std::fs::create_dir(&blocked).unwrap();
        let mut writer = DiagnosticWriter::new(Vec::new(), dir.path(), "cap-test.log");
        writer.write_all(b"CAP_DIAGNOSTIC {}\n").unwrap();
        assert!(writer.journal.disabled);
        writer.write_all(b"ordinary log").unwrap();
        assert!(blocked.is_dir());
        assert_eq!(writer.ordinary, b"ordinary log");
    }

    #[cfg(unix)]
    #[test]
    fn diagnostic_files_never_follow_a_symlink() {
        let dir = tempfile::tempdir().unwrap();
        let original = dir.path().join("original");
        std::fs::write(&original, "preserve me").unwrap();
        std::os::unix::fs::symlink(
            &original,
            dir.path().join("cap-test.log.diagnostic-current.jsonl"),
        )
        .unwrap();
        let mut writer = DiagnosticWriter::new(Vec::new(), dir.path(), "cap-test.log");
        writer.write_all(b"CAP_DIAGNOSTIC {}\n").unwrap();
        assert!(writer.journal.disabled);
        assert_eq!(std::fs::read_to_string(original).unwrap(), "preserve me");
    }
}
