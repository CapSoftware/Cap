use std::collections::HashMap;
use std::io;
use std::path::{Path, PathBuf};

pub const LOW_DISK_WARN_BYTES: u64 = 200 * 1024 * 1024;
pub const LOW_DISK_STOP_BYTES: u64 = 50 * 1024 * 1024;
pub const RECORDING_DISK_WARN_BYTES: u64 = 2 * 1024 * 1024 * 1024;
pub const RECORDING_DISK_RESERVE_BYTES: u64 = 512 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FinalizationKind {
    Studio,
    Instant,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RecordingStorage {
    pub available_bytes: u64,
    pub recording_bytes: u64,
    pub finalization_copies: u64,
}

impl RecordingStorage {
    pub fn finalization_bytes(self) -> u64 {
        self.recording_bytes
            .saturating_mul(self.finalization_copies)
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

// Saving can write up to three recording-sized files beside the recording: a
// staged copy, the joined output and, after a failed seek check, a repaired
// output. A Studio save on APFS clones the staged copy for free.
fn finalization_copies(kind: FinalizationKind, clones_files: bool) -> u64 {
    if kind == FinalizationKind::Studio && clones_files {
        2
    } else {
        3
    }
}

fn volume_clones_files(path: &Path, kind: FinalizationKind) -> bool {
    kind == FinalizationKind::Studio && volume_is_apfs(path)
}

#[cfg(target_os = "macos")]
fn volume_is_apfs(path: &Path) -> bool {
    use std::ffi::{CStr, CString};
    use std::os::unix::ffi::OsStrExt;

    let probe_path = resolve_existing_ancestor(path);
    let Ok(c_path) = CString::new(probe_path.as_os_str().as_bytes()) else {
        return false;
    };
    let mut stat: libc::statfs = unsafe { std::mem::zeroed() };
    if unsafe { libc::statfs(c_path.as_ptr(), &mut stat) } != 0 {
        return false;
    }
    unsafe { CStr::from_ptr(stat.f_fstypename.as_ptr()) }.to_bytes() == b"apfs"
}

#[cfg(not(target_os = "macos"))]
fn volume_is_apfs(_path: &Path) -> bool {
    false
}

pub fn recording_storage(path: &Path, kind: FinalizationKind) -> io::Result<RecordingStorage> {
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
        finalization_copies: finalization_copies(kind, volume_clones_files(path, kind)),
    })
}

pub struct RecordingStorageMonitor {
    fragments: HashMap<PathBuf, FinalizedFragments>,
    kind: FinalizationKind,
    clones_files: Option<bool>,
}

#[derive(Clone, Copy, Default)]
struct FinalizedFragments {
    last_index: Option<u64>,
    bytes: u64,
}

impl RecordingStorageMonitor {
    pub fn new(kind: FinalizationKind) -> Self {
        Self {
            fragments: HashMap::new(),
            kind,
            clones_files: None,
        }
    }

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
        let kind = self.kind;
        let clones_files = *self
            .clones_files
            .get_or_insert_with(|| volume_clones_files(path, kind));
        Ok(RecordingStorage {
            available_bytes: free_bytes_for_path(path)?,
            recording_bytes,
            finalization_copies: finalization_copies(self.kind, clones_files),
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

    let probe_path = extended_length_path(existing_directory(path));
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

// GetDiskFreeSpaceExW takes the string as written and fails with
// ERROR_PATH_NOT_FOUND once it reaches 260 UTF-16 units (259 when it ends in
// a separator), where std::fs has already switched to the extended-length
// form by itself. A recordings folder that long could not start a recording
// and a project folder that long failed the stop. The switch happens at the
// length std uses, and shorter paths are passed through as written.
#[cfg(windows)]
fn extended_length_path(path: PathBuf) -> PathBuf {
    use std::ffi::OsString;
    use std::os::windows::ffi::{OsStrExt, OsStringExt};
    use std::path::{Component, Prefix};

    const LEGACY_MAX_PATH: usize = 248;

    let Ok(absolute) = std::path::absolute(&path) else {
        return path;
    };
    let units: Vec<u16> = absolute.as_os_str().encode_wide().collect();
    if units.len() + 1 < LEGACY_MAX_PATH {
        return path;
    }
    let (prefix, rest) = match absolute.components().next() {
        Some(Component::Prefix(prefix)) => match prefix.kind() {
            Prefix::Disk(_) => (r"\\?\", &units[..]),
            Prefix::UNC(..) => (r"\\?\UNC\", &units[2..]),
            _ => return path,
        },
        _ => return path,
    };
    let end = rest
        .iter()
        .rposition(|unit| *unit != u16::from(b'\\'))
        .map_or(0, |last| last + 1);
    let mut extended = OsString::from(prefix);
    extended.push(OsString::from_wide(&rest[..end]));
    PathBuf::from(extended)
}

// GetDiskFreeSpaceExW only takes a directory and fails on a file, which is
// what an export passes when it overwrites an earlier export.
#[cfg(windows)]
fn existing_directory(path: &Path) -> PathBuf {
    let existing = resolve_existing_ancestor(path);
    if existing.is_dir() {
        return existing;
    }
    match existing.parent() {
        Some(parent) if !parent.as_os_str().is_empty() => parent.to_path_buf(),
        Some(_) => PathBuf::from("."),
        None => existing,
    }
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

    const GIB: u64 = 1024 * 1024 * 1024;

    #[test]
    fn recording_storage_warns_and_stops_before_the_drive_is_full() {
        let status = |available_bytes| {
            RecordingStorage {
                available_bytes,
                recording_bytes: 0,
                finalization_copies: 3,
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
            finalization_copies: 3,
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
            finalization_copies: 3,
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
    fn only_a_studio_save_on_a_cloning_volume_reserves_two_copies() {
        for (kind, clones_files, copies) in [
            (FinalizationKind::Studio, true, 2),
            (FinalizationKind::Studio, false, 3),
            (FinalizationKind::Instant, true, 3),
            (FinalizationKind::Instant, false, 3),
        ] {
            assert_eq!(finalization_copies(kind, clones_files), copies);
        }
        let directory = tempfile::tempdir().unwrap();
        assert!(!volume_clones_files(
            directory.path(),
            FinalizationKind::Instant
        ));
        if cfg!(not(target_os = "macos")) {
            assert!(!volume_clones_files(
                directory.path(),
                FinalizationKind::Studio
            ));
        }
        for kind in [FinalizationKind::Studio, FinalizationKind::Instant] {
            assert_eq!(
                recording_storage(directory.path(), kind)
                    .unwrap()
                    .finalization_copies,
                finalization_copies(kind, volume_clones_files(directory.path(), kind))
            );
            assert_eq!(
                RecordingStorageMonitor::new(kind)
                    .sample(directory.path())
                    .unwrap()
                    .finalization_copies,
                finalization_copies(kind, volume_clones_files(directory.path(), kind))
            );
        }
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn the_system_volume_clones_files() {
        assert!(volume_is_apfs(Path::new("/")));
    }

    #[test]
    fn three_copies_give_the_same_answers_as_before() {
        fn main_status(available_bytes: u64, recording_bytes: u64) -> DiskSpaceStatus {
            let remaining = available_bytes.saturating_sub(recording_bytes.saturating_mul(3));
            if remaining <= RECORDING_DISK_RESERVE_BYTES {
                DiskSpaceStatus::Exhausted
            } else if remaining <= RECORDING_DISK_WARN_BYTES {
                DiskSpaceStatus::Low
            } else {
                DiskSpaceStatus::Ok
            }
        }
        fn main_can_finalize(available_bytes: u64, recording_bytes: u64) -> bool {
            available_bytes
                > recording_bytes
                    .saturating_mul(3)
                    .saturating_add(RECORDING_DISK_RESERVE_BYTES / 2)
        }
        for recording_bytes in [0, 1, GIB, 7 * GIB + 3, u64::MAX / 4, u64::MAX] {
            let save = recording_bytes.saturating_mul(3);
            let mut available = vec![0, 1, u64::MAX, u64::MAX - 1, 100 * GIB];
            for threshold in [
                RECORDING_DISK_RESERVE_BYTES / 2,
                RECORDING_DISK_RESERVE_BYTES,
                RECORDING_DISK_WARN_BYTES,
            ] {
                let edge = save.saturating_add(threshold);
                available.extend([edge.saturating_sub(1), edge, edge.saturating_add(1)]);
            }
            for available_bytes in available {
                let storage = RecordingStorage {
                    available_bytes,
                    recording_bytes,
                    finalization_copies: 3,
                };
                assert_eq!(
                    storage.status(),
                    main_status(available_bytes, recording_bytes),
                    "{available_bytes} free, {recording_bytes} recorded"
                );
                assert_eq!(
                    storage.can_finalize(),
                    main_can_finalize(available_bytes, recording_bytes),
                    "{available_bytes} free, {recording_bytes} recorded"
                );
            }
        }
    }

    #[test]
    fn two_copies_stop_later_and_still_save() {
        let recording_bytes = GIB;
        let at = |available_bytes| RecordingStorage {
            available_bytes,
            recording_bytes,
            finalization_copies: 2,
        };
        let main_stop = 3 * recording_bytes + RECORDING_DISK_RESERVE_BYTES;
        assert_eq!(at(main_stop).status(), DiskSpaceStatus::Low);
        let stop = at(2 * recording_bytes + RECORDING_DISK_RESERVE_BYTES);
        assert_eq!(stop.status(), DiskSpaceStatus::Exhausted);
        assert!(stop.can_finalize());
        assert!(!at(2 * recording_bytes + RECORDING_DISK_RESERVE_BYTES / 2).can_finalize());
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
            recording_storage(directory.path(), FinalizationKind::Studio)
                .unwrap()
                .recording_bytes,
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
        let mut monitor = RecordingStorageMonitor::new(FinalizationKind::Studio);
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
            recording_storage(directory.path(), FinalizationKind::Studio)
                .unwrap()
                .recording_bytes
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
        let mut storage = RecordingStorageMonitor::new(FinalizationKind::Studio)
            .sample(directory.path())
            .unwrap();
        storage.available_bytes =
            storage.finalization_copies * storage.recording_bytes + RECORDING_DISK_RESERVE_BYTES;
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
        let mut monitor = RecordingStorageMonitor::new(FinalizationKind::Studio);
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
            recording_storage(directory.path(), FinalizationKind::Studio)
                .unwrap()
                .recording_bytes,
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

    #[cfg(windows)]
    fn utf16_len(path: &Path) -> usize {
        use std::os::windows::ffi::OsStrExt;
        path.as_os_str().encode_wide().count()
    }

    #[cfg(windows)]
    fn directory_of_length(base: &Path, length: usize) -> PathBuf {
        let mut path = base.to_path_buf();
        while utf16_len(&path) < length {
            let room = length - utf16_len(&path) - 1;
            assert!(room >= 1, "{} is too long for {length}", base.display());
            path.push("p".repeat(if room == 101 { 99 } else { room.min(100) }));
        }
        assert_eq!(utf16_len(&path), length);
        std::fs::create_dir_all(&path).unwrap();
        path
    }

    #[cfg(windows)]
    fn failing_lengths(
        base: &Path,
        lengths: impl IntoIterator<Item = usize>,
        path_for: impl Fn(PathBuf) -> PathBuf,
    ) -> Vec<String> {
        lengths
            .into_iter()
            .filter_map(|length| {
                let path = path_for(directory_of_length(base, length));
                match free_bytes_for_path(&path) {
                    Ok(bytes) if bytes > 0 => None,
                    Ok(bytes) => Some(format!("{length} characters: {bytes} bytes")),
                    Err(error) => Some(format!("{length} characters: {error}")),
                }
            })
            .collect()
    }

    #[cfg(windows)]
    fn administrative_share(path: &Path) -> Option<PathBuf> {
        use std::path::{Component, Prefix};
        let mut components = path.components();
        let Some(Component::Prefix(prefix)) = components.next() else {
            return None;
        };
        let Prefix::Disk(letter) = prefix.kind() else {
            return None;
        };
        let mut share = PathBuf::from(format!(r"\\localhost\{}$\", letter as char));
        share.extend(components.filter(|component| !matches!(component, Component::RootDir)));
        share.is_dir().then_some(share)
    }

    #[cfg(windows)]
    #[test]
    fn paths_below_the_legacy_limit_reach_the_query_as_written() {
        let longest_unchanged = format!(r"C:\{}", "p".repeat(243));
        for path in [
            r"C:\",
            r"C:\Users\someone\Videos\Cap",
            r"C:/Users/someone/Videos/Cap",
            r"C:\Users\someone\Videos\Cap\",
            r"E:\",
            r"E:\DCIM\clip",
            r"\\server\share\",
            r"\\server\share\recordings",
            r"\\?\C:\Users\someone",
            longest_unchanged.as_str(),
        ] {
            assert_eq!(
                extended_length_path(PathBuf::from(path)).as_os_str(),
                std::ffi::OsStr::new(path)
            );
        }
    }

    #[cfg(windows)]
    #[test]
    fn paths_at_the_legacy_limit_use_the_extended_length_form() {
        let name = "p".repeat(244);
        for (path, expected) in [
            (format!(r"C:\{name}"), format!(r"\\?\C:\{name}")),
            (format!(r"C:\{name}\"), format!(r"\\?\C:\{name}")),
            (format!(r"C:/a/../{name}/b"), format!(r"\\?\C:\{name}\b")),
            (
                format!(r"\\server\share\{name}"),
                format!(r"\\?\UNC\server\share\{name}"),
            ),
            (format!(r"\\?\C:\{name}"), format!(r"\\?\C:\{name}")),
            (
                format!(r"\\?\UNC\server\share\{name}"),
                format!(r"\\?\UNC\server\share\{name}"),
            ),
        ] {
            assert_eq!(
                extended_length_path(PathBuf::from(&path)).as_os_str(),
                std::ffi::OsStr::new(&expected),
                "{path}"
            );
        }
    }

    #[cfg(windows)]
    #[test]
    fn free_bytes_for_a_long_directory_written_with_a_trailing_separator() {
        let root = tempfile::tempdir().unwrap();
        let failed = failing_lengths(root.path(), [246, 247, 258, 259, 260, 272], |directory| {
            let mut written = directory.into_os_string();
            written.push("\\");
            PathBuf::from(written)
        });
        assert!(failed.is_empty(), "{failed:#?}");
    }

    #[cfg(windows)]
    #[test]
    fn free_bytes_for_directories_up_to_and_past_max_path() {
        let root = tempfile::tempdir().unwrap();
        let failed = failing_lengths(
            root.path(),
            (236..=300).chain([400, 1000, 4000]),
            |directory| directory,
        );
        assert!(failed.is_empty(), "{failed:#?}");
    }

    #[cfg(windows)]
    #[test]
    fn free_bytes_for_a_missing_path_below_a_long_directory() {
        let root = tempfile::tempdir().unwrap();
        let failed = failing_lengths(
            root.path(),
            [200, 247, 248, 259, 260, 272, 400],
            |directory| directory.join("not-created-yet").join("recording.cap"),
        );
        assert!(failed.is_empty(), "{failed:#?}");
    }

    #[cfg(windows)]
    #[test]
    fn recording_storage_measures_a_project_past_max_path() {
        let root = tempfile::tempdir().unwrap();
        let project = directory_of_length(root.path(), 286);
        let display = project.join("content").join("segments").join("segment-0");
        std::fs::create_dir_all(&display).unwrap();
        std::fs::write(display.join("segment_000.m4s"), [0; 128]).unwrap();
        std::fs::write(project.join("recording-meta.json"), [0; 16]).unwrap();

        let storage = recording_storage(&project, FinalizationKind::Studio).unwrap();
        assert_eq!(storage.recording_bytes, 144);
        assert!(storage.available_bytes > 0);

        let sampled = RecordingStorageMonitor::new(FinalizationKind::Studio)
            .sample(&project)
            .unwrap();
        assert_eq!(sampled.recording_bytes, 144);
        assert!(sampled.available_bytes > 0);
    }

    #[cfg(windows)]
    #[test]
    fn free_bytes_for_an_existing_file() {
        let root = tempfile::tempdir().unwrap();
        let export = root.path().join("export.mp4");
        std::fs::write(&export, [0; 16]).unwrap();
        assert!(free_bytes_for_path(&export).unwrap() > 0);

        let long = directory_of_length(root.path(), 286).join("export.mp4");
        std::fs::write(&long, [0; 16]).unwrap();
        assert!(free_bytes_for_path(&long).unwrap() > 0);
    }

    #[cfg(windows)]
    #[test]
    fn free_bytes_for_a_drive_root() {
        let root: PathBuf = std::env::temp_dir().components().take(2).collect();
        assert!(root.parent().is_none(), "{}", root.display());
        assert!(free_bytes_for_path(&root).unwrap() > 0);
        assert!(free_bytes_for_path(&root.join("not-created-yet")).unwrap() > 0);
    }

    #[cfg(windows)]
    #[test]
    fn free_bytes_for_unc_paths_up_to_and_past_max_path() {
        let root = tempfile::tempdir().unwrap();
        let Some(share) = administrative_share(root.path()) else {
            eprintln!(
                "skipped: no administrative share for {}",
                root.path().display()
            );
            return;
        };
        assert!(free_bytes_for_path(&share).unwrap() > 0);
        assert!(free_bytes_for_path(&share.join("not-created-yet")).unwrap() > 0);
        let failed = failing_lengths(&share, (236..=300).chain([400, 1000]), |directory| {
            directory
        });
        assert!(failed.is_empty(), "{failed:#?}");
        eprintln!("checked UNC paths below {}", share.display());
    }
}
