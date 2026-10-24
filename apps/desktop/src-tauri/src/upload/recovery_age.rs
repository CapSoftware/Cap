use std::{path::Path, time::SystemTime};

const MAX_AUTOMATIC_RECOVERY_AGE: std::time::Duration =
    std::time::Duration::from_secs(24 * 60 * 60);

pub(crate) fn eligible(project: &Path, now: SystemTime) -> bool {
    project
        .metadata()
        .and_then(|metadata| metadata.created())
        .ok()
        .and_then(|created| now.duration_since(created).ok())
        .is_some_and(|age| age <= MAX_AUTOMATIC_RECOVERY_AGE)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{fs, time::Duration};

    #[test]
    fn recovery_expires_even_when_old_recording_metadata_changes() {
        let project = std::env::temp_dir().join(format!("cap-recovery-age-{}", std::process::id()));
        fs::create_dir(&project).unwrap();
        let created = project.metadata().unwrap().created().unwrap();
        assert!(eligible(&project, created));
        assert!(eligible(&project, created + MAX_AUTOMATIC_RECOVERY_AGE));
        fs::write(project.join("recording-meta.json"), b"{}").unwrap();
        assert!(!eligible(
            &project,
            created + MAX_AUTOMATIC_RECOVERY_AGE + Duration::from_secs(1)
        ));
        assert!(!eligible(&project, SystemTime::UNIX_EPOCH));
        fs::remove_dir_all(&project).unwrap();
        assert!(!eligible(&project, created));
    }
}
