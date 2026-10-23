use std::{fs::OpenOptions, io, path::Path};

pub fn sync_media_file(path: &Path) -> io::Result<()> {
    // Windows FlushFileBuffers requires GENERIC_WRITE; Unix also permits read-only handles.
    OpenOptions::new()
        .read(true)
        .write(cfg!(windows))
        .open(path)?
        .sync_all()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn existing_media_flush_preserves_bytes() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("segment.m4s");
        let bytes = b"completed fragment bytes must remain unchanged";
        std::fs::write(&path, bytes).unwrap();

        sync_media_file(&path).unwrap();

        assert_eq!(std::fs::read(&path).unwrap(), bytes);
    }

    #[test]
    fn missing_media_flush_does_not_create_a_file() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("missing.m4s");

        assert_eq!(
            sync_media_file(&path).unwrap_err().kind(),
            io::ErrorKind::NotFound
        );
        assert!(!path.exists());
    }
}
