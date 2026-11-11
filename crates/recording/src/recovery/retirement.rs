#[cfg(unix)]
use std::fs::File;
use std::{
    fs,
    path::{Path, PathBuf},
    sync::Mutex,
};

use super::{
    RECOVERY_PUBLICATION, RECOVERY_PUBLICATION_RECEIPT, RecoveryError, RecoveryLock,
    RecoveryPublication, RecoveryPublicationStampVersion, read_recovery_publication,
    recovery_publication_segments_stamp, recovery_publication_state_for_version,
    recovery_publication_workspace, reject_recovery_link,
};

/// Marks a publication workspace whose original media backup a lease armed
/// for retirement. Recovery and salvage keep their backups, so they never
/// write it.
const RETIREMENT_ARMED: &str = "retire-original-segments";

pub(super) struct RecoveryLease {
    lock: Option<RecoveryLock>,
    retirement: Mutex<Option<OriginalMediaRetirement>>,
}

impl RecoveryLease {
    pub(super) fn new(lock: RecoveryLock) -> Self {
        Self {
            lock: Some(lock),
            retirement: Mutex::new(None),
        }
    }

    pub(super) fn retire_originals(
        &self,
        project: &Path,
        workspace: &Path,
    ) -> Result<(), RecoveryError> {
        let retirement = OriginalMediaRetirement {
            project: project.canonicalize()?,
            workspace: workspace.canonicalize()?,
            receipt: read_recovery_publication(&workspace.join(RECOVERY_PUBLICATION_RECEIPT))?,
        };
        retirement.validate()?;
        // Synced with the publication, so the next launch can finish a
        // retirement that the process did not live to run.
        fs::write(workspace.join(RETIREMENT_ARMED), [])?;
        sync_publication(project, workspace)?;
        *self.retirement.lock().map_err(|_| {
            RecoveryError::Validation("Original media retirement lease poisoned".into())
        })? = Some(retirement);
        Ok(())
    }
}

impl Drop for RecoveryLease {
    fn drop(&mut self) {
        if self
            .lock
            .as_ref()
            .is_none_or(|lock| !lock.owned_by_this_process())
        {
            return;
        }
        let Some(retirement) = self.retirement.get_mut().ok().and_then(Option::take) else {
            return;
        };
        let lock = self.lock.take();
        if let Err(error) = std::thread::Builder::new()
            .name("studio-original-retirement".into())
            .spawn(move || {
                let _lock = lock;
                if let Err(error) = retirement.remove_originals() {
                    tracing::warn!(path = %retirement.workspace.display(), %error, "Original media backup retained");
                }
            })
        {
            tracing::warn!(%error, "Original media retirement worker unavailable; backup retained");
        }
    }
}

/// Removes the original media backup of a publication whose lock was never
/// shared with a preparing reader, after the same durability barrier and
/// receipt checks the shared lease uses.
pub(super) fn retire_unread_originals(
    project: &Path,
    workspace: &Path,
) -> Result<(), RecoveryError> {
    let retirement = OriginalMediaRetirement {
        project: project.canonicalize()?,
        workspace: workspace.canonicalize()?,
        receipt: read_recovery_publication(&workspace.join(RECOVERY_PUBLICATION_RECEIPT))?,
    };
    retirement.validate()?;
    sync_publication(project, workspace)?;
    retirement.remove_originals()
}

/// Removes the original media backups that outlived the process that
/// published them, and returns how many it removed.
///
/// A shared lease retires its backup only when the last preparing reader
/// closes. A quit, crash, or kill right after a Studio stop ends the process
/// before that, which leaves the whole recording on disk twice. Only backups
/// a lease armed go, after the same receipt checks and durability barrier as
/// a live retirement, under the project's recovery lock, so a project that a
/// reader or a finalizer still holds keeps its backup.
pub(super) fn retire_leftover_originals(recordings_dir: &Path) -> usize {
    let Ok(entries) = fs::read_dir(recordings_dir) else {
        return 0;
    };
    entries
        .flatten()
        .map(|entry| entry.path())
        .map(|project| {
            retire_leftover_originals_in(&project).unwrap_or_else(|error| {
                tracing::debug!(path = %project.display(), %error, "Leftover original media backup retained");
                0
            })
        })
        .sum()
}

fn retire_leftover_originals_in(project: &Path) -> Result<usize, RecoveryError> {
    let workspaces = leftover_backups(project)?;
    if workspaces.is_empty() {
        return Ok(0);
    }
    let _lock = RecoveryLock::acquire(project)?;
    let mut retired = 0;
    for workspace in workspaces {
        match retire_unread_originals(project, &workspace) {
            Ok(()) => retired += 1,
            Err(error) => {
                tracing::debug!(path = %workspace.display(), %error, "Leftover original media backup retained");
            }
        }
    }
    Ok(retired)
}

/// The publication workspaces in `project` that still hold an armed original
/// media backup. Touches nothing, so a project without one never gets a lock
/// file.
fn leftover_backups(project: &Path) -> Result<Vec<PathBuf>, RecoveryError> {
    if !project.symlink_metadata()?.is_dir()
        || !project.join("content/segments").try_exists()?
        // Opening the project reconciles an interrupted publication first.
        || project.join(RECOVERY_PUBLICATION).symlink_metadata().is_ok()
    {
        return Ok(Vec::new());
    }
    let mut workspaces = Vec::new();
    for entry in fs::read_dir(project)? {
        let name = entry?.file_name();
        let Some(workspace) = name
            .to_str()
            .and_then(|name| recovery_publication_workspace(project, name).ok())
        else {
            continue;
        };
        if workspace
            .join("original-segments")
            .symlink_metadata()
            .is_ok()
            && workspace.join(RETIREMENT_ARMED).symlink_metadata().is_ok()
        {
            workspaces.push(workspace);
        }
    }
    Ok(workspaces)
}

/// The durability barrier before a backup goes: the published tree and the
/// directories its renames touched.
fn sync_publication(project: &Path, workspace: &Path) -> Result<(), RecoveryError> {
    sync_directories(&project.join("content/segments"))?;
    for directory in [
        project.join("content"),
        project.to_path_buf(),
        workspace.to_path_buf(),
    ] {
        sync_directory(&directory)?;
    }
    Ok(())
}

struct OriginalMediaRetirement {
    project: PathBuf,
    workspace: PathBuf,
    receipt: Vec<u8>,
}

impl OriginalMediaRetirement {
    fn validate(&self) -> Result<(), RecoveryError> {
        reject_recovery_link(&self.project.symlink_metadata()?)?;
        let receipt: RecoveryPublication = serde_json::from_slice(&self.receipt)?;
        let version = match receipt.version {
            2 => RecoveryPublicationStampVersion::V2,
            3 => RecoveryPublicationStampVersion::V3,
            _ => {
                return Err(RecoveryError::Validation(
                    "Original media retirement receipt changed".into(),
                ));
            }
        };
        if receipt.project != self.project
            || recovery_publication_workspace(&self.project, &receipt.workspace)? != self.workspace
            || read_recovery_publication(&self.workspace.join(RECOVERY_PUBLICATION_RECEIPT))?
                != self.receipt
        {
            return Err(RecoveryError::Validation(
                "Original media retirement receipt changed".into(),
            ));
        }
        match self.project.join(RECOVERY_PUBLICATION).symlink_metadata() {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
            Ok(_) => {
                return Err(RecoveryError::Validation(
                    "Publication is still in progress".into(),
                ));
            }
        }
        let published = recovery_publication_state_for_version(&self.project, version)?;
        if published.segments.is_none()
            || published.meta.is_none()
            || published.segments != receipt.staged.segments
            || published.meta != receipt.staged.meta
            || recovery_publication_segments_stamp(
                &self.workspace.join("original-segments"),
                version,
            )? != receipt.original.segments
        {
            return Err(RecoveryError::Validation(
                "Published media or original backup changed".into(),
            ));
        }
        Ok(())
    }

    fn remove_originals(&self) -> Result<(), RecoveryError> {
        self.validate()?;
        remove_backup(&self.workspace.join("original-segments"))?;
        sync_directory(&self.workspace)?;
        tracing::info!(path = %self.workspace.display(), "Retired original media backup");
        Ok(())
    }
}

fn sync_directories(path: &Path) -> Result<(), RecoveryError> {
    reject_recovery_link(&path.symlink_metadata()?)?;
    for entry in fs::read_dir(path)? {
        let entry = entry?;
        let metadata = entry.path().symlink_metadata()?;
        reject_recovery_link(&metadata)?;
        if metadata.is_dir() {
            sync_directories(&entry.path())?;
        }
    }
    sync_directory(path)?;
    Ok(())
}

fn sync_directory(path: &Path) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        File::open(path)?.sync_all()
    }
    // A directory can't be opened as a plain file on Windows. NTFS journals the
    // renames that published the recording, and the published files themselves
    // were flushed before publication.
    #[cfg(not(unix))]
    {
        let _ = path;
        Ok(())
    }
}

fn remove_backup(path: &Path) -> std::io::Result<()> {
    #[cfg(windows)]
    {
        // Antivirus and the search indexer briefly open new files without
        // delete sharing; give them a moment rather than keeping the backup.
        let mut attempt = 0;
        loop {
            match fs::remove_dir_all(path) {
                Ok(()) => return Ok(()),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
                Err(error) if attempt < 4 => {
                    attempt += 1;
                    tracing::debug!(%error, attempt, "Original media backup busy; retrying removal");
                    std::thread::sleep(std::time::Duration::from_millis(100));
                }
                Err(error) => return Err(error),
            }
        }
    }
    #[cfg(not(windows))]
    {
        fs::remove_dir_all(path)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use cap_enc_ffmpeg::RelocatableSource;
    use std::{
        io::Read,
        sync::Arc,
        time::{Duration, Instant},
    };

    fn fixture() -> (tempfile::TempDir, PathBuf, PathBuf) {
        let temporary = tempfile::tempdir().unwrap();
        let project = temporary.path().join("recording.cap");
        let workspace = project.join(".recovery-00000000-0000-4000-8000-000000000042");
        fs::create_dir_all(project.join("content/segments")).unwrap();
        super::super::create_private_recovery_dir(&workspace).unwrap();
        fs::create_dir_all(workspace.join("staged/content/segments")).unwrap();
        for (root, media, meta) in [
            (
                &project,
                b"original encoded media".as_slice(),
                b"original metadata".as_slice(),
            ),
            (
                &workspace.join("staged"),
                b"published encoded media".as_slice(),
                b"published metadata".as_slice(),
            ),
        ] {
            fs::write(root.join("content/segments/video.mp4"), media).unwrap();
            fs::write(root.join("recording-meta.json"), meta).unwrap();
            fs::write(root.join("project-config.json"), b"configuration").unwrap();
        }
        (temporary, project, workspace)
    }

    fn wait_for_retirement(project: &Path, workspace: &Path) {
        let start = Instant::now();
        loop {
            if !workspace.join("original-segments").exists()
                && RecoveryLock::acquire(project).is_ok()
            {
                return;
            }
            assert!(
                start.elapsed() < Duration::from_secs(5),
                "Retirement did not finish"
            );
            std::thread::sleep(Duration::from_millis(5));
        }
    }

    #[test]
    fn retirement_waits_for_open_and_lazy_readers_and_preserves_published_files() {
        let (_temporary, project, workspace) = fixture();
        let lease = Arc::new(RecoveryLease::new(RecoveryLock::acquire(&project).unwrap()));
        let source =
            RelocatableSource::new_with_owner(project.join("content/segments"), lease.clone())
                .unwrap();
        let mut opened = source.reader(Path::new("video.mp4")).unwrap();
        let mut lazy = source.reader(Path::new("video.mp4")).unwrap();
        let mut prefix = [0; 8];
        opened.read_exact(&mut prefix).unwrap();
        super::super::publish_recovery_with_source(&project, &workspace, &source).unwrap();
        lease.retire_originals(&project, &workspace).unwrap();
        let expected = super::super::recovery_snapshot(&project).unwrap();
        drop(source);
        drop(lease);
        assert!(RecoveryLock::acquire(&project).is_err());
        let mut remainder = Vec::new();
        opened.read_to_end(&mut remainder).unwrap();
        assert_eq!(
            [prefix.as_slice(), &remainder].concat(),
            b"original encoded media"
        );
        drop(opened);
        assert!(workspace.join("original-segments").is_dir());
        assert!(RecoveryLock::acquire(&project).is_err());
        let mut bytes = Vec::new();
        lazy.read_to_end(&mut bytes).unwrap();
        assert_eq!(bytes, b"original encoded media");
        drop(lazy);
        wait_for_retirement(&project, &workspace);
        assert_eq!(super::super::recovery_snapshot(&project).unwrap(), expected);
        assert!(workspace.join(RECOVERY_PUBLICATION_RECEIPT).is_file());
        assert!(workspace.join("original-recording-meta.json").is_file());
    }

    #[test]
    fn changed_publication_or_backup_prevents_retirement() {
        for changed in [
            "content/segments/video.mp4",
            "recording-meta.json",
            ".recovery-00000000-0000-4000-8000-000000000042/original-segments/video.mp4",
            ".recovery-00000000-0000-4000-8000-000000000042/publication-receipt.json",
            RECOVERY_PUBLICATION,
        ] {
            let (_temporary, project, workspace) = fixture();
            let lease = RecoveryLease::new(RecoveryLock::acquire(&project).unwrap());
            super::super::publish_recovery(&project, &workspace).unwrap();
            lease.retire_originals(&project, &workspace).unwrap();
            let retirement = lease.retirement.lock().unwrap().take().unwrap();
            fs::write(project.join(changed), b"changed").unwrap();
            assert!(
                retirement.remove_originals().is_err(),
                "Accepted changed {changed}"
            );
            assert!(workspace.join("original-segments").is_dir());
        }
    }

    #[test]
    fn unarmed_or_unpublished_leases_preserve_originals() {
        let (_temporary, project, workspace) = fixture();
        let lease = RecoveryLease::new(RecoveryLock::acquire(&project).unwrap());
        assert!(lease.retire_originals(&project, &workspace).is_err());
        super::super::publish_recovery(&project, &workspace).unwrap();
        drop(lease);
        assert!(workspace.join("original-segments").is_dir());
        assert!(RecoveryLock::acquire(&project).is_ok());
    }

    #[test]
    fn editing_configuration_does_not_remove_or_replace_the_edit() {
        let (_temporary, project, workspace) = fixture();
        let lease = RecoveryLease::new(RecoveryLock::acquire(&project).unwrap());
        super::super::publish_recovery(&project, &workspace).unwrap();
        lease.retire_originals(&project, &workspace).unwrap();
        fs::write(project.join("project-config.json"), b"edited configuration").unwrap();
        drop(lease);
        wait_for_retirement(&project, &workspace);
        assert_eq!(
            fs::read(project.join("project-config.json")).unwrap(),
            b"edited configuration"
        );
    }

    #[cfg(unix)]
    #[test]
    fn replacing_backup_with_a_link_preserves_the_link_target() {
        let (_temporary, project, workspace) = fixture();
        let lease = RecoveryLease::new(RecoveryLock::acquire(&project).unwrap());
        super::super::publish_recovery(&project, &workspace).unwrap();
        lease.retire_originals(&project, &workspace).unwrap();
        let retirement = lease.retirement.lock().unwrap().take().unwrap();
        let saved = project.join("saved-originals");
        fs::rename(workspace.join("original-segments"), &saved).unwrap();
        std::os::unix::fs::symlink(&saved, workspace.join("original-segments")).unwrap();
        assert!(retirement.remove_originals().is_err());
        assert_eq!(
            fs::read(saved.join("video.mp4")).unwrap(),
            b"original encoded media"
        );
    }

    /// What a quit right after a Studio stop leaves on disk: the publication
    /// armed its retirement, and the process ended before the reader closed.
    fn leftover() -> (tempfile::TempDir, PathBuf, PathBuf) {
        let (temporary, project, workspace) = fixture();
        let lease = RecoveryLease::new(RecoveryLock::acquire(&project).unwrap());
        super::super::publish_recovery(&project, &workspace).unwrap();
        lease.retire_originals(&project, &workspace).unwrap();
        lease.retirement.lock().unwrap().take();
        drop(lease);
        assert!(workspace.join("original-segments").is_dir());
        (temporary, project, workspace)
    }

    #[test]
    fn sweep_retires_a_backup_its_process_left_behind() {
        let (temporary, project, workspace) = leftover();
        let expected = super::super::recovery_snapshot(&project).unwrap();
        assert_eq!(retire_leftover_originals(temporary.path()), 1);
        assert!(!workspace.join("original-segments").exists());
        assert!(workspace.join(RECOVERY_PUBLICATION_RECEIPT).is_file());
        assert_eq!(super::super::recovery_snapshot(&project).unwrap(), expected);
        assert!(RecoveryLock::acquire(&project).is_ok());
        assert_eq!(retire_leftover_originals(temporary.path()), 0);
    }

    #[test]
    fn sweep_keeps_a_backup_no_lease_armed() {
        let (temporary, project, workspace) = fixture();
        let lock = RecoveryLock::acquire(&project).unwrap();
        super::super::publish_recovery(&project, &workspace).unwrap();
        drop(lock);
        assert_eq!(retire_leftover_originals(temporary.path()), 0);
        assert!(workspace.join("original-segments").is_dir());
    }

    #[test]
    fn sweep_keeps_the_backup_of_a_locked_project() {
        let (temporary, project, workspace) = leftover();
        let held = RecoveryLock::acquire(&project).unwrap();
        assert_eq!(retire_leftover_originals(temporary.path()), 0);
        assert!(workspace.join("original-segments").is_dir());
        drop(held);
        assert_eq!(retire_leftover_originals(temporary.path()), 1);
    }

    #[test]
    fn sweep_keeps_a_changed_or_unfinished_publication() {
        for changed in [
            "content/segments/video.mp4",
            "recording-meta.json",
            ".recovery-00000000-0000-4000-8000-000000000042/original-segments/video.mp4",
            ".recovery-00000000-0000-4000-8000-000000000042/publication-receipt.json",
            RECOVERY_PUBLICATION,
        ] {
            let (temporary, project, workspace) = leftover();
            fs::write(project.join(changed), b"changed").unwrap();
            assert_eq!(
                retire_leftover_originals(temporary.path()),
                0,
                "Accepted changed {changed}"
            );
            assert!(workspace.join("original-segments").is_dir());
        }
    }

    #[test]
    fn sweep_leaves_projects_without_a_backup_untouched() {
        let temporary = tempfile::tempdir().unwrap();
        let project = temporary.path().join("plain.cap");
        fs::create_dir_all(project.join("content/segments")).unwrap();
        fs::write(temporary.path().join("notes.txt"), b"not a project").unwrap();
        assert_eq!(retire_leftover_originals(temporary.path()), 0);
        assert!(!project.join(".recovery.lock").exists());
        assert_eq!(
            retire_leftover_originals(&temporary.path().join("missing")),
            0
        );
    }
}
