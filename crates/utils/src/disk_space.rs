use std::collections::HashMap;
use std::io;
use std::path::{Path, PathBuf};

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
        self.recording_bytes.saturating_mul(3)
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

#[derive(Default)]
pub struct RecordingStorageMonitor {
    fragments: HashMap<PathBuf, FinalizedFragments>,
}

#[derive(Clone, Copy, Default)]
struct FinalizedFragments {
    last_index: Option<u64>,
    bytes: u64,
}

impl RecordingStorageMonitor {
    pub fn sample(&mut self, path: &Path) -> io::Result<RecordingStorage> {
        const MAX_CACHED_DIRECTORIES: usize = 256;
        let mut pending = vec![path.to_path_buf()];
        let mut recording_bytes = 0u64;
        while let Some(directory) = pending.pop() {
            let cached = self.fragments.get(&directory).copied().unwrap_or_default();
            let mut new_fragment_bytes = 0u64;
            let mut newest_fragment = None;
            let mut other_bytes = 0u64;
            for entry in std::fs::read_dir(&directory)? {
                let entry = entry?;
                let file_type = match entry.file_type() {
                    Ok(file_type) => file_type,
                    Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
                    Err(error) => return Err(error),
                };
                if file_type.is_dir() {
                    pending.push(entry.path());
                } else if file_type.is_file() {
                    let name = entry.file_name();
                    let fragment_index = name.to_str().and_then(|name| {
                        name.strip_prefix("segment_")?
                            .strip_suffix(".m4s")?
                            .parse::<u64>()
                            .ok()
                    });
                    if let Some(index) = fragment_index {
                        if cached.last_index.is_some_and(|last| index <= last) {
                            continue;
                        }
                        let bytes = match entry.metadata() {
                            Ok(metadata) => metadata.len(),
                            Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
                            Err(error) => return Err(error),
                        };
                        new_fragment_bytes = new_fragment_bytes.saturating_add(bytes);
                        if newest_fragment.is_none_or(|(newest, _)| index > newest) {
                            newest_fragment = Some((index, bytes));
                        }
                    } else {
                        match entry.metadata() {
                            Ok(metadata) => {
                                other_bytes = other_bytes.saturating_add(metadata.len());
                            }
                            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
                            Err(error) => return Err(error),
                        }
                    }
                }
            }
            recording_bytes = recording_bytes
                .saturating_add(cached.bytes)
                .saturating_add(new_fragment_bytes)
                .saturating_add(other_bytes);
            if let Some((index, bytes)) = newest_fragment
                && (self.fragments.contains_key(&directory)
                    || self.fragments.len() < MAX_CACHED_DIRECTORIES)
            {
                // DASH fragments are immutable once a later fragment exists. Keep
                // measuring the newest fragment and temporary files until then.
                let _ = self.fragments.insert(
                    directory,
                    FinalizedFragments {
                        last_index: index.checked_sub(1),
                        bytes: cached
                            .bytes
                            .saturating_add(new_fragment_bytes.saturating_sub(bytes)),
                    },
                );
            }
        }
        Ok(RecordingStorage {
            available_bytes: free_bytes_for_path(path)?,
            recording_bytes,
        })
    }
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
        assert_eq!(storage.finalization_bytes(), u64::MAX);
        assert_eq!(storage.status(), DiskSpaceStatus::Exhausted);
        assert!(!storage.can_finalize());
    }

    #[test]
    fn recording_storage_reserves_space_for_finalization() {
        let recording_bytes = 1024 * 1024 * 1024;
        let mut storage = RecordingStorage {
            available_bytes: recording_bytes * 3 + RECORDING_DISK_WARN_BYTES + 1,
            recording_bytes,
        };
        assert_eq!(storage.status(), DiskSpaceStatus::Ok);
        storage.available_bytes -= 1;
        assert_eq!(storage.status(), DiskSpaceStatus::Low);
        storage.available_bytes = recording_bytes * 3 + RECORDING_DISK_RESERVE_BYTES;
        assert_eq!(storage.status(), DiskSpaceStatus::Exhausted);
        assert!(storage.can_finalize());
        storage.available_bytes = recording_bytes * 2 + RECORDING_DISK_RESERVE_BYTES;
        assert!(!storage.can_finalize());
        storage.available_bytes = recording_bytes * 3 + RECORDING_DISK_RESERVE_BYTES / 2;
        assert!(!storage.can_finalize());
        storage.available_bytes += 1;
        assert!(storage.can_finalize());
        storage.available_bytes = recording_bytes * 3;
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

    #[test]
    fn monitor_counts_growing_fragments_temporary_files_and_other_tracks() {
        let directory = tempfile::tempdir().unwrap();
        let display = directory.path().join("display");
        std::fs::create_dir(&display).unwrap();
        std::fs::write(display.join("segment_999.m4s"), [0; 128]).unwrap();
        std::fs::write(display.join("segment_1000.m4s"), [0; 64]).unwrap();
        std::fs::write(display.join("segment_1001.m4s.tmp"), [0; 32]).unwrap();
        std::fs::write(directory.path().join("camera.mp4"), [0; 16]).unwrap();
        let mut monitor = RecordingStorageMonitor::default();
        assert_eq!(
            monitor.sample(directory.path()).unwrap().recording_bytes,
            240
        );
        assert_eq!(monitor.fragments.len(), 1);

        std::fs::write(display.join("segment_1000.m4s"), [0; 96]).unwrap();
        std::fs::rename(
            display.join("segment_1001.m4s.tmp"),
            display.join("segment_1001.m4s"),
        )
        .unwrap();
        std::fs::write(directory.path().join("camera.mp4"), [0; 32]).unwrap();
        assert_eq!(
            monitor.sample(directory.path()).unwrap().recording_bytes,
            288
        );
        assert_eq!(
            monitor.sample(directory.path()).unwrap().recording_bytes,
            recording_storage(directory.path()).unwrap().recording_bytes
        );

        std::fs::remove_file(display.join("segment_999.m4s")).unwrap();
        assert_eq!(
            monitor.sample(directory.path()).unwrap().recording_bytes,
            288
        );
    }

    #[test]
    fn monitor_reserves_finalization_space_for_large_recordings() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("segment_000.m4s");
        let file = std::fs::File::create(path).unwrap();
        file.set_len(1024 * 1024 * 1024).unwrap();
        let mut storage = RecordingStorageMonitor::default()
            .sample(directory.path())
            .unwrap();
        storage.available_bytes = 3 * storage.recording_bytes + RECORDING_DISK_RESERVE_BYTES;
        assert_eq!(storage.recording_bytes, 1024 * 1024 * 1024);
        assert_eq!(storage.status(), DiskSpaceStatus::Exhausted);
        assert!(storage.can_finalize());
    }

    #[test]
    fn monitor_bounds_cached_directories_without_missing_uncached_tracks() {
        let directory = tempfile::tempdir().unwrap();
        for index in 0..260 {
            let track = directory.path().join(index.to_string());
            std::fs::create_dir(&track).unwrap();
            std::fs::write(track.join("segment_000.m4s"), [0; 4]).unwrap();
            std::fs::write(track.join("segment_001.m4s"), [0; 8]).unwrap();
        }
        let mut monitor = RecordingStorageMonitor::default();
        for _ in 0..2 {
            assert_eq!(
                monitor.sample(directory.path()).unwrap().recording_bytes,
                3120
            );
            assert_eq!(monitor.fragments.len(), 256);
        }
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
