use cap_project::ProjectConfiguration;
use std::{
    io,
    path::PathBuf,
    sync::{Arc, Mutex},
};

pub(crate) struct PendingProjectSave {
    path: PathBuf,
    config: Option<Arc<ProjectConfiguration>>,
    revision: u64,
    retired: Arc<Mutex<u64>>,
}

pub(crate) struct ProjectSave {
    path: PathBuf,
    config: Arc<ProjectConfiguration>,
    revision: u64,
    retired: Arc<Mutex<u64>>,
}

impl PendingProjectSave {
    pub(crate) fn new(path: PathBuf) -> Self {
        Self {
            path,
            config: None,
            revision: 0,
            retired: Arc::default(),
        }
    }

    pub(crate) fn queue(&mut self, config: ProjectConfiguration) {
        self.revision += 1;
        self.config = Some(Arc::new(config));
    }

    pub(crate) fn snapshot(&self) -> Option<ProjectSave> {
        Some(ProjectSave {
            path: self.path.clone(),
            config: self.config.clone()?,
            revision: self.revision,
            retired: self.retired.clone(),
        })
    }

    pub(crate) fn complete(&mut self, result: io::Result<u64>) {
        match result {
            Ok(revision) if revision == self.revision => self.config = None,
            Ok(_) => {}
            Err(error) => {
                tracing::error!(path = %self.path.display(), "failed to persist project config: {error}");
            }
        }
    }

    pub(crate) fn discard(&mut self) {
        let mut retired = self.retired.lock().unwrap();
        self.revision += 1;
        *retired = self.revision;
        self.config = None;
    }

    pub(crate) fn flush(&mut self) {
        if let Err(error) = self.try_flush() {
            tracing::error!(path = %self.path.display(), "failed to persist project config: {error}");
        }
    }

    pub(crate) fn try_flush(&mut self) -> io::Result<()> {
        let Some(config) = &self.config else {
            return Ok(());
        };
        let mut retired = self.retired.lock().unwrap();
        if self.revision > *retired {
            // Retire queued jobs even if this flush fails before an import.
            *retired = self.revision;
            self.revision += 1;
            config.write(&self.path)?;
            *retired = self.revision;
            tracing::debug!(path = %self.path.display(), "project config written");
        }
        self.config = None;
        Ok(())
    }
}

impl ProjectSave {
    pub(crate) fn write(self) -> io::Result<u64> {
        let mut retired = self.retired.lock().unwrap();
        // A close or import can flush while this job is queued on the executor.
        if self.revision <= *retired {
            return Ok(self.revision);
        }
        self.config.write(&self.path)?;
        *retired = self.revision;
        tracing::debug!(path = %self.path.display(), "project config written");
        Ok(self.revision)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    fn config(padding: f64) -> ProjectConfiguration {
        let mut config = ProjectConfiguration::default();
        config.background.padding = padding;
        config
    }

    fn assert_saved(path: &Path, expected: &ProjectConfiguration) {
        assert_eq!(
            std::fs::read(path.join("project-config.json")).unwrap(),
            serde_json::to_vec_pretty(expected).unwrap()
        );
    }

    #[test]
    fn older_completion_keeps_the_new_edit_pending_and_cannot_overwrite_it() {
        let root = tempfile::tempdir().unwrap();
        let mut pending = PendingProjectSave::new(root.path().to_owned());
        pending.queue(config(1.));
        let older = pending.snapshot().unwrap();
        let delayed = pending.snapshot().unwrap();
        pending.queue(config(2.));
        pending.complete(older.write());
        assert!(pending.snapshot().is_some());
        pending.complete(pending.snapshot().unwrap().write());
        assert!(pending.snapshot().is_none());
        delayed.write().unwrap();
        assert_saved(root.path(), &config(2.));
    }

    #[test]
    fn flushed_jobs_cannot_overwrite_an_import_committed_before_reload() {
        let root = tempfile::tempdir().unwrap();
        let mut pending = PendingProjectSave::new(root.path().to_owned());
        pending.queue(config(1.));
        let delayed = pending.snapshot().unwrap();
        pending.try_flush().unwrap();
        assert!(pending.snapshot().is_none());
        config(2.).write(root.path()).unwrap();
        delayed.write().unwrap();
        assert_saved(root.path(), &config(2.));
    }

    #[test]
    fn discard_invalidates_queued_jobs_and_allows_new_edits() {
        let root = tempfile::tempdir().unwrap();
        let mut pending = PendingProjectSave::new(root.path().to_owned());
        pending.queue(config(1.));
        let delayed = pending.snapshot().unwrap();
        pending.discard();
        config(2.).write(root.path()).unwrap();
        pending.complete(delayed.write());
        assert!(pending.snapshot().is_none());
        assert_saved(root.path(), &config(2.));
        pending.queue(config(3.));
        pending.flush();
        assert_saved(root.path(), &config(3.));
    }

    #[test]
    fn failed_save_keeps_the_pending_edit_for_retry() {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("source.mp4");
        std::fs::write(&source, b"original recording").unwrap();
        let mut pending = PendingProjectSave::new(source.clone());
        pending.queue(config(1.));
        let result = pending.snapshot().unwrap().write();
        assert!(result.is_err());
        pending.complete(result);
        assert!(pending.try_flush().is_err());
        assert!(pending.snapshot().is_some());
        assert_eq!(std::fs::read(&source).unwrap(), b"original recording");
        pending.path = root.path().to_owned();
        pending.try_flush().unwrap();
        assert!(pending.snapshot().is_none());
        assert_saved(root.path(), &config(1.));
    }

    #[test]
    fn failed_flush_retires_queued_jobs_before_an_external_commit() {
        let root = tempfile::tempdir().unwrap();
        let bundle = root.path().join("recording.cap");
        std::fs::write(&bundle, b"not a directory").unwrap();
        let mut pending = PendingProjectSave::new(bundle.clone());
        pending.queue(config(1.));
        let delayed = pending.snapshot().unwrap();
        assert!(pending.try_flush().is_err());
        std::fs::remove_file(&bundle).unwrap();
        std::fs::create_dir(&bundle).unwrap();
        config(2.).write(&bundle).unwrap();
        pending.complete(delayed.write());
        assert_saved(&bundle, &config(2.));
        assert!(pending.snapshot().is_some());
        pending.discard();
        assert!(pending.snapshot().is_none());
    }
}
