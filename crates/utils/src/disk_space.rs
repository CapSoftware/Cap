use std::io;
use std::path::Path;

pub const LOW_DISK_WARN_BYTES: u64 = 200 * 1024 * 1024;
pub const LOW_DISK_STOP_BYTES: u64 = 50 * 1024 * 1024;
pub const RECORDING_DISK_WARN_BYTES: u64 = 2 * 1024 * 1024 * 1024;
pub const RECORDING_DISK_RESERVE_BYTES: u64 = 512 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RecordingStorage {
    pub available_bytes: u64,
    pub recording_bytes: u64,
}

impl RecordingStorage {
    pub fn finalization_bytes(self) -> u64 {
        self.recording_bytes.saturating_mul(2)
    }

    pub fn status(self) -> DiskSpaceStatus {
        let remaining = self
            .available_bytes
            .saturating_sub(self.finalization_bytes());
        if remaining <= RECORDING_DISK_RESERVE_BYTES {
            DiskSpaceStatus::Exhausted
        } else if remaining <= RECORDING_DISK_WARN_BYTES {
            DiskSpaceStatus::Low
        } else {
            DiskSpaceStatus::Ok
        }
    }

    pub fn can_finalize(self) -> bool {
        self.available_bytes
            > self
                .finalization_bytes()
                .saturating_add(RECORDING_DISK_RESERVE_BYTES / 2)
    }
}

pub fn recording_storage(path: &Path) -> io::Result<RecordingStorage> {
    let mut pending = vec![path.to_path_buf()];
    let mut recording_bytes = 0u64;
    while let Some(directory) = pending.pop() {
        for entry in std::fs::read_dir(directory)? {
            let entry = entry?;
            let file_type = entry.file_type()?;
            if file_type.is_dir() {
                pending.push(entry.path());
            } else if file_type.is_file() {
                recording_bytes = recording_bytes.saturating_add(entry.metadata()?.len());
            }
        }
    }
    Ok(RecordingStorage {
        available_bytes: free_bytes_for_path(path)?,
        recording_bytes,
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DiskSpaceStatus {
    Ok,
    Low,
    Exhausted,
}

impl DiskSpaceStatus {
    pub fn from_bytes(bytes_free: u64) -> Self {
        if bytes_free <= LOW_DISK_STOP_BYTES {
            DiskSpaceStatus::Exhausted
        } else if bytes_free <= LOW_DISK_WARN_BYTES {
            DiskSpaceStatus::Low
        } else {
            DiskSpaceStatus::Ok
        }
    }
}

#[cfg(unix)]
pub fn free_bytes_for_path(path: &Path) -> io::Result<u64> {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;

    let probe_path = resolve_existing_ancestor(path);
    let c_path = CString::new(probe_path.as_os_str().as_bytes())
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidInput, e))?;

    let mut stat: libc::statvfs = unsafe { std::mem::zeroed() };
    let rc = unsafe { libc::statvfs(c_path.as_ptr(), &mut stat) };
    if rc != 0 {
        return Err(io::Error::last_os_error());
    }

    let bavail = stat.f_bavail as u64;
    let frsize = if stat.f_frsize == 0 {
        stat.f_bsize
    } else {
        stat.f_frsize
    };
    Ok(bavail.saturating_mul(frsize))
}

#[cfg(windows)]
pub fn free_bytes_for_path(path: &Path) -> io::Result<u64> {
    use std::os::windows::ffi::OsStrExt;
    use windows::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;
    use windows::core::PCWSTR;

    let probe_path = resolve_existing_ancestor(path);
    let mut wide: Vec<u16> = probe_path.as_os_str().encode_wide().collect();
    if wide.last().copied() != Some(0) {
        wide.push(0);
    }

    let mut free_bytes_available_to_caller: u64 = 0;
    let mut total_number_of_bytes: u64 = 0;
    let mut total_number_of_free_bytes: u64 = 0;

    unsafe {
        GetDiskFreeSpaceExW(
            PCWSTR(wide.as_ptr()),
            Some(&mut free_bytes_available_to_caller),
            Some(&mut total_number_of_bytes),
            Some(&mut total_number_of_free_bytes),
        )
        .map_err(|e| io::Error::other(e.to_string()))?;
    }

    Ok(free_bytes_available_to_caller)
}

fn resolve_existing_ancestor(path: &Path) -> std::path::PathBuf {
    let mut candidate: std::path::PathBuf = path.to_path_buf();
    loop {
        if candidate.exists() {
            return candidate;
        }
        if !candidate.pop() {
            return std::env::temp_dir();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recording_storage_warns_and_stops_before_the_drive_is_full() {
        let status = |available_bytes| {
            RecordingStorage {
                available_bytes,
                recording_bytes: 0,
            }
            .status()
        };
        assert_eq!(status(RECORDING_DISK_WARN_BYTES + 1), DiskSpaceStatus::Ok);
        assert_eq!(status(RECORDING_DISK_WARN_BYTES), DiskSpaceStatus::Low);
        assert_eq!(
            status(RECORDING_DISK_RESERVE_BYTES + 1),
            DiskSpaceStatus::Low
        );
        assert_eq!(
            status(RECORDING_DISK_RESERVE_BYTES),
            DiskSpaceStatus::Exhausted
        );
        assert_eq!(status(139_771_904), DiskSpaceStatus::Exhausted);
        assert_eq!(status(0), DiskSpaceStatus::Exhausted);
    }

    #[test]
    fn recording_storage_saturates_large_finalization_requirements() {
        let storage = RecordingStorage {
            available_bytes: u64::MAX,
            recording_bytes: u64::MAX,
        };
        assert_eq!(storage.status(), DiskSpaceStatus::Exhausted);
        assert!(!storage.can_finalize());
    }

    #[test]
    fn recording_storage_reserves_space_for_finalization() {
        let recording_bytes = 1024 * 1024 * 1024;
        let mut storage = RecordingStorage {
            available_bytes: recording_bytes * 2 + RECORDING_DISK_WARN_BYTES + 1,
            recording_bytes,
        };
        assert_eq!(storage.status(), DiskSpaceStatus::Ok);
        storage.available_bytes -= 1;
        assert_eq!(storage.status(), DiskSpaceStatus::Low);
        storage.available_bytes = recording_bytes * 2 + RECORDING_DISK_RESERVE_BYTES;
        assert_eq!(storage.status(), DiskSpaceStatus::Exhausted);
        assert!(storage.can_finalize());
        storage.available_bytes = recording_bytes * 2;
        assert!(!storage.can_finalize());
    }

    #[test]
    fn recording_storage_accounts_for_every_track() {
        let directory = tempfile::tempdir().unwrap();
        let segment = directory.path().join("segment-0");
        std::fs::create_dir(&segment).unwrap();
        std::fs::write(segment.join("display.m4s"), [0; 128]).unwrap();
        std::fs::write(segment.join("camera.m4s"), [0; 64]).unwrap();
        std::fs::write(directory.path().join("recording-meta.json"), [0; 16]).unwrap();
        assert_eq!(
            recording_storage(directory.path()).unwrap().recording_bytes,
            208
        );
    }

    #[cfg(unix)]
    #[test]
    fn recording_storage_does_not_follow_symbolic_links() {
        let directory = tempfile::tempdir().unwrap();
        std::os::unix::fs::symlink(directory.path(), directory.path().join("loop")).unwrap();
        assert_eq!(
            recording_storage(directory.path()).unwrap().recording_bytes,
            0
        );
    }

    #[test]
    fn status_from_bytes() {
        assert_eq!(DiskSpaceStatus::from_bytes(u64::MAX), DiskSpaceStatus::Ok);
        assert_eq!(
            DiskSpaceStatus::from_bytes(LOW_DISK_WARN_BYTES + 1),
            DiskSpaceStatus::Ok
        );
        assert_eq!(
            DiskSpaceStatus::from_bytes(LOW_DISK_WARN_BYTES),
            DiskSpaceStatus::Low
        );
        assert_eq!(
            DiskSpaceStatus::from_bytes(LOW_DISK_STOP_BYTES + 1),
            DiskSpaceStatus::Low
        );
        assert_eq!(
            DiskSpaceStatus::from_bytes(LOW_DISK_STOP_BYTES),
            DiskSpaceStatus::Exhausted
        );
        assert_eq!(DiskSpaceStatus::from_bytes(0), DiskSpaceStatus::Exhausted);
    }

    #[test]
    fn free_bytes_on_temp_dir_is_positive() {
        let dir = tempfile::tempdir().unwrap();
        let bytes = free_bytes_for_path(dir.path()).expect("statvfs should succeed on temp dir");
        assert!(bytes > 0);
    }

    #[test]
    fn free_bytes_on_missing_path_walks_up_to_existing_ancestor() {
        let dir = tempfile::tempdir().unwrap();
        let nested = dir.path().join("nope").join("also-nope").join("nada");
        let bytes = free_bytes_for_path(&nested).expect("should fall back to existing ancestor");
        assert!(bytes > 0);
    }
}
