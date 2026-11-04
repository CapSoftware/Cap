use std::path::{Path, PathBuf};

pub const REPAIR_DIR: &str = ".cap-repair";
const MAX_PATH_BYTES: usize = 1024;
const WRITABLE_EXTENSIONS: [&str; 9] = [
    "json", "m4s", "mp4", "m4a", "ogg", "aac", "wav", "mp3", "webm",
];
pub const MEDIA_EXTENSIONS: [&str; 8] = ["m4s", "mp4", "m4a", "ogg", "aac", "wav", "mp3", "webm"];

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct RelPath(String);

impl RelPath {
    pub fn parse(raw: &str) -> Result<Self, String> {
        if raw.is_empty() {
            return Err("path is empty".into());
        }
        if raw.len() > MAX_PATH_BYTES {
            return Err("path is too long".into());
        }
        if raw.contains('\0') || raw.contains('\\') || raw.contains(':') {
            return Err("path contains a forbidden character".into());
        }
        if raw.starts_with('/') || Path::new(raw).is_absolute() {
            return Err("path must be relative to the recording".into());
        }
        let mut parts = Vec::new();
        for (index, part) in raw.split('/').enumerate() {
            if part.is_empty() || part == "." || part == ".." {
                return Err("path must not contain empty, . or .. components".into());
            }
            if part.chars().any(char::is_control) {
                return Err("path contains a control character".into());
            }
            if index == 0 && part.eq_ignore_ascii_case(REPAIR_DIR) {
                return Err("repair workspace is not accessible".into());
            }
            if part.to_ascii_lowercase().starts_with(".recovery-") {
                return Err("recovery workspaces are not accessible".into());
            }
            parts.push(part);
        }
        Ok(Self(parts.join("/")))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }

    pub fn components(&self) -> impl Iterator<Item = &str> {
        self.0.split('/')
    }

    pub fn extension(&self) -> Option<String> {
        let name = self.0.rsplit('/').next()?;
        let (stem, ext) = name.rsplit_once('.')?;
        (!stem.is_empty()).then(|| ext.to_ascii_lowercase())
    }

    pub fn is_writable_kind(&self) -> bool {
        self.extension()
            .is_some_and(|ext| WRITABLE_EXTENSIONS.contains(&ext.as_str()))
    }

    pub fn is_media(&self) -> bool {
        self.extension()
            .is_some_and(|ext| MEDIA_EXTENSIONS.contains(&ext.as_str()))
    }

    pub fn is_json(&self) -> bool {
        self.extension().as_deref() == Some("json")
    }

    pub fn join_to(&self, base: &Path) -> PathBuf {
        let mut path = base.to_path_buf();
        for part in self.components() {
            path.push(part);
        }
        path
    }
}

#[derive(Debug, Clone)]
pub struct Bundle {
    root: PathBuf,
}

impl Bundle {
    pub fn open(path: &Path) -> Result<Self, String> {
        let metadata = path
            .symlink_metadata()
            .map_err(|error| format!("recording folder is not readable: {error}"))?;
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            return Err("recording is not a folder".into());
        }
        let root = dunce::canonicalize(path)
            .map_err(|error| format!("recording folder is not readable: {error}"))?;
        Ok(Self { root })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn repair_root(&self) -> PathBuf {
        self.root.join(REPAIR_DIR)
    }

    pub fn resolve(&self, rel: &RelPath) -> Result<PathBuf, String> {
        let mut current = self.root.clone();
        let count = rel.components().count();
        for (index, part) in rel.components().enumerate() {
            current.push(part);
            match current.symlink_metadata() {
                Ok(metadata) => {
                    if metadata.file_type().is_symlink() {
                        return Err("links inside the recording are not followed".into());
                    }
                    if index + 1 < count && !metadata.is_dir() {
                        return Err("path goes through a file".into());
                    }
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    for remaining in rel.components().skip(index + 1) {
                        current.push(remaining);
                    }
                    return Ok(current);
                }
                Err(error) => return Err(format!("cannot read path: {error}")),
            }
        }
        Ok(current)
    }

    pub fn relative(&self, path: &Path) -> Option<RelPath> {
        let rel = path.strip_prefix(&self.root).ok()?;
        let mut parts = Vec::new();
        for component in rel.components() {
            match component {
                std::path::Component::Normal(part) => parts.push(part.to_str()?.to_string()),
                _ => return None,
            }
        }
        RelPath::parse(&parts.join("/")).ok()
    }
}

pub fn display_bytes(bytes: u64) -> String {
    const KB: f64 = 1024.0;
    let value = bytes as f64;
    if value < KB {
        format!("{bytes} B")
    } else if value < KB * KB {
        format!("{:.0} KB", value / KB)
    } else if value < KB * KB * KB {
        format!("{:.1} MB", value / (KB * KB))
    } else {
        format!("{:.2} GB", value / (KB * KB * KB))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_bundle(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "cap-repair-paths-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(dir.join("content/segments/segment-0/display")).unwrap();
        std::fs::write(dir.join("recording-meta.json"), b"{}").unwrap();
        dir
    }

    #[test]
    fn rejects_escaping_and_absolute_paths() {
        for bad in [
            "",
            "/etc/passwd",
            "../outside",
            "content/../../x",
            "content//x",
            "./content",
            "C:/Windows/system32",
            "C:\\Windows",
            "content\\segments",
            "\\\\server\\share",
            "file.json:stream",
            ".cap-repair/journal.json",
            ".CAP-REPAIR/x.json",
            "content/.recovery-1234/staged/x.m4s",
            ".Recovery-abc",
            "bad\0name",
            "tab\tname",
        ] {
            assert!(RelPath::parse(bad).is_err(), "{bad:?} was accepted");
        }
        assert!(RelPath::parse(&"a/".repeat(600)).is_err());
    }

    #[test]
    fn accepts_bundle_paths() {
        let rel = RelPath::parse("content/segments/segment-0/display/fragment_001.m4s").unwrap();
        assert!(rel.is_media());
        assert!(rel.is_writable_kind());
        assert!(RelPath::parse("recording-meta.json").unwrap().is_json());
        assert!(!RelPath::parse("notes.txt").unwrap().is_writable_kind());
        assert!(!RelPath::parse("content/.json").unwrap().is_writable_kind());
        assert!(RelPath::parse("content/A.M4S").unwrap().is_media());
    }

    #[test]
    fn resolve_stays_inside_and_refuses_links() {
        let dir = temp_bundle("resolve");
        let bundle = Bundle::open(&dir).unwrap();
        let rel = RelPath::parse("content/segments/segment-0/display/new.m4s").unwrap();
        let resolved = bundle.resolve(&rel).unwrap();
        assert!(resolved.starts_with(bundle.root()));
        assert_eq!(bundle.relative(&resolved), Some(rel));

        #[cfg(unix)]
        {
            let outside = temp_bundle("outside");
            std::os::unix::fs::symlink(&outside, dir.join("content/escape")).unwrap();
            let through = RelPath::parse("content/escape/recording-meta.json").unwrap();
            assert!(bundle.resolve(&through).is_err());
            std::os::unix::fs::symlink(
                outside.join("recording-meta.json"),
                dir.join("content/link.json"),
            )
            .unwrap();
            assert!(
                bundle
                    .resolve(&RelPath::parse("content/link.json").unwrap())
                    .is_err()
            );
            std::fs::remove_dir_all(&outside).ok();
        }

        let through_file = RelPath::parse("recording-meta.json/inner.json").unwrap();
        assert!(bundle.resolve(&through_file).is_err());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[cfg(unix)]
    #[test]
    fn symlinked_bundle_root_is_refused() {
        let dir = temp_bundle("rootlink");
        let link = dir.with_extension("link");
        std::os::unix::fs::symlink(&dir, &link).unwrap();
        assert!(Bundle::open(&link).is_err());
        std::fs::remove_file(&link).ok();
        std::fs::remove_dir_all(&dir).ok();
    }
}
