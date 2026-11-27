use std::{
    fs::File,
    io,
    path::{Path, PathBuf},
    sync::{Mutex, MutexGuard, PoisonError},
};

use super::RecoveryError;

const LOCK_DIR: &str = ".recording-locks";

struct Entry {
    id: u64,
    project: PathBuf,
    _file: LockFile,
}

static HELD: Mutex<Vec<Entry>> = Mutex::new(Vec::new());

fn held() -> MutexGuard<'static, Vec<Entry>> {
    HELD.lock().unwrap_or_else(PoisonError::into_inner)
}

/// The lock lives beside the project rather than in it: on Windows an open
/// handle inside a folder stops the folder from being moved or deleted, and
/// the recorder's own discard and delete paths do both.
fn lock_path(project: &Path) -> io::Result<(PathBuf, PathBuf)> {
    let project = project.canonicalize()?;
    let parent = project
        .parent()
        .ok_or_else(|| io::Error::other("Recording has no parent directory"))?;
    #[cfg(windows)]
    let identity = project.to_string_lossy().to_lowercase().into_bytes();
    #[cfg(not(windows))]
    let identity = project.as_os_str().as_encoded_bytes().to_vec();
    let path = parent
        .join(LOCK_DIR)
        .join(format!("{}.lock", blake3::hash(&identity).to_hex()));
    Ok((project, path))
}

#[must_use]
pub struct RecordingLock {
    id: u64,
}

impl RecordingLock {
    pub fn acquire(project: &Path) -> io::Result<Self> {
        static NEXT_ID: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let (project, path) = lock_path(project)?;
        create_lock_dir(path.parent().unwrap_or(&project))?;
        let file = LockFile::exclusive(&path)?;
        let id = NEXT_ID.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        held().push(Entry {
            id,
            project,
            _file: file,
        });
        Ok(Self { id })
    }

    pub fn acquire_for_recording(project: &Path) -> Option<Self> {
        Self::acquire(project)
            .inspect_err(|error| {
                tracing::warn!(path = %project.display(), %error, "Could not mark the project as recording");
            })
            .ok()
    }
}

impl Drop for RecordingLock {
    fn drop(&mut self) {
        let mut held = held();
        let entry = held
            .iter()
            .position(|entry| entry.id == self.id)
            .map(|index| held.swap_remove(index));
        drop(held);
        drop(entry);
    }
}

fn held_here(project: &Path) -> bool {
    let held = held();
    !held.is_empty()
        && project
            .canonicalize()
            .is_ok_and(|project| held.iter().any(|entry| entry.project == project))
}

pub(super) fn release(project: &Path) {
    let Ok(project) = project.canonicalize() else {
        return;
    };
    let mut held = held();
    let mut released = Vec::new();
    let mut index = 0;
    while index < held.len() {
        if held[index].project == project {
            released.push(held.swap_remove(index));
        } else {
            index += 1;
        }
    }
    drop(held);
    drop(released);
}

pub(super) struct ReleaseWhenDone<'a>(pub(super) &'a Path);

impl Drop for ReleaseWhenDone<'_> {
    fn drop(&mut self) {
        release(self.0);
    }
}

pub(super) struct RecordingProbe {
    _file: Option<LockFile>,
}

/// Refuses only while another process holds the project's lock. Anything
/// else (no lock file, a filesystem without locks, an unreadable lock) leaves
/// recovery as it was before the lock existed, so no project can become
/// unrecoverable over it.
pub(super) fn probe(project: &Path) -> Result<RecordingProbe, RecoveryError> {
    let free = RecordingProbe { _file: None };
    if held_here(project) {
        return Ok(free);
    }
    let path = match lock_path(project) {
        Ok((_, path)) => path,
        Err(error) => {
            tracing::debug!(path = %project.display(), %error, "No recording lock to check");
            return Ok(free);
        }
    };
    match LockFile::shared(&path) {
        Ok(file) => Ok(RecordingProbe { _file: Some(file) }),
        Err(error) if is_busy(&error) => Err(RecoveryError::RecordingInProgress),
        Err(error) => {
            if error.kind() != io::ErrorKind::NotFound {
                tracing::debug!(path = %path.display(), %error, "Recording lock unavailable; recovery proceeds");
            }
            Ok(free)
        }
    }
}

pub fn is_recording_elsewhere(project: &Path) -> bool {
    matches!(probe(project), Err(RecoveryError::RecordingInProgress))
}

fn is_busy(error: &io::Error) -> bool {
    #[cfg(windows)]
    {
        const ERROR_SHARING_VIOLATION: i32 = 32;
        const ERROR_LOCK_VIOLATION: i32 = 33;
        matches!(
            error.raw_os_error(),
            Some(ERROR_SHARING_VIOLATION | ERROR_LOCK_VIOLATION)
        )
    }
    #[cfg(not(windows))]
    {
        error.kind() == io::ErrorKind::WouldBlock
    }
}

fn create_lock_dir(directory: &Path) -> io::Result<()> {
    let builder = std::fs::DirBuilder::new();
    #[cfg(unix)]
    let builder = {
        use std::os::unix::fs::DirBuilderExt;
        let mut builder = builder;
        builder.mode(0o700);
        builder
    };
    match builder.create(directory) {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
        Err(error) => return Err(error),
    }
    let metadata = directory.symlink_metadata()?;
    if !metadata.is_dir() || is_link(&metadata) {
        return Err(io::Error::other(
            "Recording lock directory is not a directory",
        ));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if metadata.uid() != unsafe { libc::geteuid() } {
            return Err(io::Error::other("Recording lock directory is not private"));
        }
    }
    Ok(())
}

struct LockFile {
    _file: File,
    #[cfg(unix)]
    owned: Option<(libc::pid_t, PathBuf)>,
}

impl LockFile {
    fn exclusive(path: &Path) -> io::Result<Self> {
        let mut options = std::fs::OpenOptions::new();
        options.read(true).write(true).create(true).truncate(false);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options
                .mode(0o600)
                .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC);
        }
        #[cfg(windows)]
        {
            use std::os::windows::fs::OpenOptionsExt;
            const GENERIC_READ: u32 = 0x8000_0000;
            const GENERIC_WRITE: u32 = 0x4000_0000;
            const DELETE: u32 = 0x0001_0000;
            const FILE_FLAG_DELETE_ON_CLOSE: u32 = 0x0400_0000;
            const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
            options
                .access_mode(GENERIC_READ | GENERIC_WRITE | DELETE)
                .share_mode(0)
                .custom_flags(FILE_FLAG_DELETE_ON_CLOSE | FILE_FLAG_OPEN_REPARSE_POINT);
        }
        let file = options.open(path)?;
        let metadata = file.metadata()?;
        if !metadata.is_file() || metadata.len() != 0 || is_link(&metadata) {
            return Err(io::Error::other("Invalid recording lock file"));
        }
        #[cfg(unix)]
        {
            use std::os::{fd::AsRawFd, unix::fs::MetadataExt};
            if metadata.nlink() != 1 || metadata.uid() != unsafe { libc::geteuid() } {
                return Err(io::Error::other("Recording lock is not exclusively owned"));
            }
            if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
                let error = io::Error::last_os_error();
                if !is_busy(&error) {
                    let _ = std::fs::remove_file(path);
                }
                return Err(error);
            }
        }
        Ok(Self {
            _file: file,
            #[cfg(unix)]
            owned: Some((unsafe { libc::getpid() }, path.to_path_buf())),
        })
    }

    fn shared(path: &Path) -> io::Result<Self> {
        let mut options = std::fs::OpenOptions::new();
        options.read(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC);
        }
        #[cfg(windows)]
        {
            use std::os::windows::fs::OpenOptionsExt;
            const FILE_SHARE_READ: u32 = 0x1;
            const FILE_SHARE_DELETE: u32 = 0x4;
            const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
            options
                .share_mode(FILE_SHARE_READ | FILE_SHARE_DELETE)
                .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT);
        }
        let file = options.open(path)?;
        #[cfg(unix)]
        {
            use std::os::fd::AsRawFd;
            if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_SH | libc::LOCK_NB) } != 0 {
                return Err(io::Error::last_os_error());
            }
        }
        Ok(Self {
            _file: file,
            #[cfg(unix)]
            owned: None,
        })
    }
}

#[cfg(unix)]
impl Drop for LockFile {
    fn drop(&mut self) {
        use std::os::fd::AsRawFd;
        let Some((owner_pid, path)) = &self.owned else {
            return;
        };
        if *owner_pid != unsafe { libc::getpid() } {
            return;
        }
        if let Err(error) = std::fs::remove_file(path)
            && error.kind() != io::ErrorKind::NotFound
        {
            tracing::debug!(path = %path.display(), %error, "Recording lock file kept");
        }
        if unsafe { libc::flock(self._file.as_raw_fd(), libc::LOCK_UN) } != 0 {
            tracing::warn!(error = %io::Error::last_os_error(), "Failed to release recording lock");
        }
    }
}

fn is_link(metadata: &std::fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
        if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return true;
        }
    }
    metadata.file_type().is_symlink()
}

#[cfg(test)]
mod tests {
    use super::super::needs_remux_tests::needs_remux_project;
    use super::super::*;
    use super::{RecordingLock, is_busy, is_recording_elsewhere, lock_path};
    use std::{collections::BTreeMap, io};

    const CHILD_PROJECTS: &str = "CAP_RECORDING_LOCK_CHILD";
    const CHILD_READY: &str = "CAP_RECORDING_LOCK_READY";

    struct Child(std::process::Child);

    impl Drop for Child {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }

    #[test]
    fn recording_lock_child_holder() {
        let (Some(projects), Some(ready)) = (
            std::env::var_os(CHILD_PROJECTS),
            std::env::var_os(CHILD_READY),
        ) else {
            return;
        };
        let _locks = std::env::split_paths(&projects)
            .map(|project| RecordingLock::acquire(&project).unwrap())
            .collect::<Vec<_>>();
        std::fs::write(ready, b"ready").unwrap();
        std::thread::sleep(Duration::from_secs(120));
    }

    fn record_in_child(projects: &[&Path], ready: &Path) -> Child {
        let mut child = Child(
            std::process::Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "recovery::recording_lock::tests::recording_lock_child_holder",
                    "--nocapture",
                ])
                .env(CHILD_PROJECTS, std::env::join_paths(projects).unwrap())
                .env(CHILD_READY, ready)
                .stdout(std::process::Stdio::null())
                .spawn()
                .unwrap(),
        );
        let deadline = Instant::now() + Duration::from_secs(20);
        while !ready.exists() && Instant::now() < deadline {
            assert!(
                child.0.try_wait().unwrap().is_none(),
                "recording lock holder exited before acquisition"
            );
            std::thread::sleep(Duration::from_millis(10));
        }
        assert!(ready.exists());
        child
    }

    fn tree(root: &Path) -> BTreeMap<PathBuf, Option<Vec<u8>>> {
        let mut entries = BTreeMap::new();
        let mut pending = vec![root.to_path_buf()];
        while let Some(path) = pending.pop() {
            let relative = path.strip_prefix(root).unwrap().to_path_buf();
            if path.is_dir() {
                let _ = entries.insert(relative, None);
                for entry in std::fs::read_dir(&path).unwrap() {
                    pending.push(entry.unwrap().path());
                }
            } else {
                let _ = entries.insert(relative, Some(std::fs::read(&path).unwrap()));
            }
        }
        entries
    }

    fn studio_status(project: &Path) -> StudioRecordingStatus {
        RecordingMeta::load_for_project(project)
            .unwrap()
            .studio_meta()
            .unwrap()
            .status()
    }

    fn in_progress_project(parent: &Path, name: &str) -> PathBuf {
        let project = parent.join(name);
        std::fs::create_dir_all(project.join("content/segments")).unwrap();
        let project = project.canonicalize().unwrap();
        RecordingMeta {
            platform: None,
            project_path: project.clone(),
            pretty_name: name.into(),
            sharing: None,
            upload: None,
            inner: RecordingMetaInner::Studio(Box::new(StudioRecordingMeta::MultipleSegments {
                inner: MultipleSegments {
                    segments: Vec::new(),
                    cursors: Cursors::default(),
                    status: Some(StudioRecordingStatus::InProgress),
                    cursor_shape_version: 0,
                    audio_only: false,
                },
            })),
        }
        .save_for_project()
        .unwrap();
        project
    }

    fn instant_project(parent: &Path, name: &str) -> PathBuf {
        let project = parent.join(name);
        std::fs::create_dir_all(project.join("content/display")).unwrap();
        std::fs::create_dir_all(project.join("content/audio")).unwrap();
        project.canonicalize().unwrap()
    }

    #[test]
    fn recording_in_another_process_leaves_every_project_untouched_until_it_ends() {
        let recordings = tempfile::tempdir().unwrap();
        let signals = tempfile::tempdir().unwrap();
        let studio = needs_remux_project(recordings.path(), "studio", 3);
        let incomplete = RecoveryManager::inspect_recording(&studio).unwrap();
        let swept = in_progress_project(recordings.path(), "swept");
        let instant = instant_project(recordings.path(), "instant");
        let before = [tree(&studio), tree(&swept), tree(&instant)];

        let child = record_in_child(&[&studio, &swept, &instant], &signals.path().join("ready"));
        assert!(is_recording_elsewhere(&studio));
        assert!(matches!(
            RecoveryManager::remux_if_needed(&studio),
            Err(RecoveryError::RecordingInProgress)
        ));
        assert!(RecoveryManager::inspect_recording(&studio).is_none());
        assert!(RecoveryManager::find_incomplete_single(&studio).is_none());
        assert!(matches!(
            RecoveryManager::restore_interrupted_recovery(&studio),
            Err(RecoveryError::RecordingInProgress)
        ));
        assert!(matches!(
            RecoveryManager::salvage(&incomplete),
            Err(RecoveryError::RecordingInProgress)
        ));
        assert!(matches!(
            RecoveryManager::recover(&incomplete),
            Err(RecoveryError::RecordingInProgress)
        ));
        assert!(RecoveryManager::find_incomplete(recordings.path()).is_empty());
        assert!(matches!(
            RecoveryManager::finalize_instant_output(
                &instant.join("content/display"),
                &instant.join("content/audio"),
                &instant.join("content/output.mp4"),
            ),
            Err(RecoveryError::RecordingInProgress)
        ));
        assert_eq!(
            [tree(&studio), tree(&swept), tree(&instant)],
            before,
            "a refused recovery wrote to the project"
        );
        assert!(matches!(
            studio_status(&swept),
            StudioRecordingStatus::InProgress
        ));

        drop(child);
        assert!(!is_recording_elsewhere(&studio));
        assert!(RecoveryManager::remux_if_needed(&studio).unwrap());
        assert!(matches!(
            studio_status(&studio),
            StudioRecordingStatus::Complete
        ));
        assert!(RecoveryManager::find_incomplete(recordings.path()).is_empty());
        assert!(matches!(
            studio_status(&swept),
            StudioRecordingStatus::Failed { .. }
        ));
    }

    #[test]
    fn the_recording_process_finalizes_its_own_project() {
        let recordings = tempfile::tempdir().unwrap();
        let project = needs_remux_project(recordings.path(), "own", 3);
        let lock = RecordingLock::acquire(&project).unwrap();
        assert!(!is_recording_elsewhere(&project));
        assert!(RecoveryManager::remux_if_needed(&project).unwrap());
        assert!(matches!(
            studio_status(&project),
            StudioRecordingStatus::Complete
        ));
        let after_finalize = RecordingLock::acquire(&project).unwrap();
        drop(lock);
        drop(after_finalize);
    }

    #[test]
    fn recording_lock_is_exclusive_until_dropped_and_stays_out_of_the_project() {
        let recordings = tempfile::tempdir().unwrap();
        let project = recordings.path().join("project");
        std::fs::create_dir(&project).unwrap();
        let before = tree(&project);
        let lock = RecordingLock::acquire(&project).unwrap();
        assert_eq!(tree(&project), before);
        assert!(lock_path(&project).unwrap().1.exists());
        assert!(RecordingLock::acquire(&project).is_err());
        drop(lock);
        assert!(!lock_path(&project).unwrap().1.exists());
        drop(RecordingLock::acquire(&project).unwrap());
        assert_eq!(tree(&project), before);
    }

    #[test]
    fn projects_without_a_recording_lock_recover_as_before() {
        let recordings = tempfile::tempdir().unwrap();
        let project = needs_remux_project(recordings.path(), "old", 3);
        assert!(!is_recording_elsewhere(&project));
        assert!(RecoveryManager::remux_if_needed(&project).unwrap());
        assert!(matches!(
            studio_status(&project),
            StudioRecordingStatus::Complete
        ));
        assert!(!recordings.path().join(super::LOCK_DIR).exists());
    }

    #[test]
    fn only_a_held_lock_refuses() {
        #[cfg(unix)]
        {
            for code in [
                libc::ENOLCK,
                libc::ENOTSUP,
                libc::EOPNOTSUPP,
                libc::EACCES,
                libc::EPERM,
                libc::ENOENT,
                libc::EINVAL,
            ] {
                assert!(!is_busy(&io::Error::from_raw_os_error(code)), "{code}");
            }
            assert!(is_busy(&io::Error::from_raw_os_error(libc::EWOULDBLOCK)));
            assert!(is_busy(&io::Error::from_raw_os_error(libc::EAGAIN)));
        }
        #[cfg(windows)]
        {
            for code in [2, 3, 5, 50, 87] {
                assert!(!is_busy(&io::Error::from_raw_os_error(code)), "{code}");
            }
            assert!(is_busy(&io::Error::from_raw_os_error(32)));
            assert!(is_busy(&io::Error::from_raw_os_error(33)));
        }
    }

    #[test]
    fn a_lock_file_nobody_holds_never_refuses_recovery() {
        let recordings = tempfile::tempdir().unwrap();
        let project = needs_remux_project(recordings.path(), "left", 3);
        let (_, path) = lock_path(&project).unwrap();
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, b"").unwrap();
        assert!(!is_recording_elsewhere(&project));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0)).unwrap();
            assert!(!is_recording_elsewhere(&project));
        }
        assert!(RecoveryManager::remux_if_needed(&project).unwrap());
        assert!(matches!(
            studio_status(&project),
            StudioRecordingStatus::Complete
        ));
    }
}
