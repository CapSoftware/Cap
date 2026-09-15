use std::{
    collections::HashSet,
    fs::{self, File, Metadata},
    io::{self, Read, Seek, SeekFrom},
    path::{Component, Path, PathBuf},
    sync::{Arc, Mutex, RwLock, Weak},
    time::SystemTime,
};

type CachedFile = Arc<Mutex<Option<File>>>;

#[derive(Clone)]
pub struct RelocatableSource(Arc<RwLock<DirectoryState>>);

struct DirectoryState {
    root: PathBuf,
    identity: FileIdentity,
    readers: Vec<Weak<Mutex<Option<File>>>>,
    next_cleanup: usize,
    _owner: Option<Arc<dyn Send + Sync>>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct FileIdentity {
    #[cfg(unix)]
    device: u64,
    #[cfg(unix)]
    inode: u64,
    #[cfg(windows)]
    volume: u64,
    #[cfg(windows)]
    file_id: [u8; 16],
}

#[derive(Clone, Copy, PartialEq, Eq)]
struct FileSnapshot {
    identity: FileIdentity,
    length: u64,
    modified: SystemTime,
}

pub struct RelocatableReader {
    relative: PathBuf,
    snapshot: FileSnapshot,
    file: CachedFile,
    position: u64,
    failure: Option<io::Error>,
    // Cached files must close before the final source-owned lease is released.
    source: RelocatableSource,
}

fn identity(file: &File) -> io::Result<FileIdentity> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let metadata = file.metadata()?;
        Ok(FileIdentity {
            device: metadata.dev(),
            inode: metadata.ino(),
        })
    }
    #[cfg(windows)]
    {
        use std::os::windows::io::AsRawHandle;
        use windows::Win32::{
            Foundation::HANDLE,
            Storage::FileSystem::{FILE_ID_INFO, FileIdInfo, GetFileInformationByHandleEx},
        };
        let mut information = FILE_ID_INFO::default();
        unsafe {
            GetFileInformationByHandleEx(
                HANDLE(file.as_raw_handle()),
                FileIdInfo,
                std::ptr::from_mut(&mut information).cast(),
                std::mem::size_of::<FILE_ID_INFO>() as u32,
            )
        }
        .map_err(io::Error::other)?;
        Ok(FileIdentity {
            volume: information.VolumeSerialNumber,
            file_id: information.FileId.Identifier,
        })
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = file;
        Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "Managed source identity is unsupported on this platform",
        ))
    }
}

fn directory_identity(path: &Path) -> io::Result<FileIdentity> {
    let mut options = File::options();
    options.read(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        use windows::Win32::Storage::FileSystem::FILE_FLAG_BACKUP_SEMANTICS;
        options.custom_flags(FILE_FLAG_BACKUP_SEMANTICS.0);
    }
    let file = options.open(path)?;
    if !file.metadata()?.is_dir() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "Invalid source directory",
        ));
    }
    identity(&file)
}

fn is_link(metadata: &Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        use windows::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT;
        metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT.0 != 0
    }
    #[cfg(not(windows))]
    {
        metadata.file_type().is_symlink()
    }
}

fn open_relative(root: &Path, relative: &Path) -> io::Result<File> {
    let mut path = root.to_path_buf();
    for component in relative.components() {
        path.push(component);
        if is_link(&fs::symlink_metadata(&path)?) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "Managed source paths cannot contain links",
            ));
        }
    }
    File::open(path)
}

impl FileSnapshot {
    fn capture(file: &File) -> io::Result<Self> {
        let metadata = file.metadata()?;
        if !metadata.is_file() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "Managed sources must be regular files",
            ));
        }
        Ok(Self {
            identity: identity(file)?,
            length: metadata.len(),
            modified: metadata.modified()?,
        })
    }

    fn validate(&self, file: &File) -> io::Result<()> {
        if Self::capture(file)? != *self {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "Managed source identity, length, or modification time changed",
            ));
        }
        Ok(())
    }
}

impl RelocatableSource {
    pub fn new(root: PathBuf) -> io::Result<Self> {
        Self::new_inner(root, None)
    }

    pub fn new_with_owner(root: PathBuf, owner: Arc<dyn Send + Sync>) -> io::Result<Self> {
        Self::new_inner(root, Some(owner))
    }

    fn new_inner(root: PathBuf, owner: Option<Arc<dyn Send + Sync>>) -> io::Result<Self> {
        if is_link(&fs::symlink_metadata(&root)?) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "Managed source roots cannot be links",
            ));
        }
        let root = root.canonicalize()?;
        let identity = directory_identity(&root)?;
        Ok(Self(Arc::new(RwLock::new(DirectoryState {
            root,
            identity,
            readers: Vec::new(),
            next_cleanup: 64,
            _owner: owner,
        }))))
    }

    pub fn reader(&self, relative: &Path) -> io::Result<RelocatableReader> {
        self.readers(&[relative.to_path_buf()])?
            .pop()
            .ok_or_else(|| io::Error::other("Missing managed reader"))
    }

    pub(crate) fn readers(&self, paths: &[PathBuf]) -> io::Result<Vec<RelocatableReader>> {
        for relative in paths {
            if relative.as_os_str().is_empty()
                || relative
                    .components()
                    .any(|part| !matches!(part, Component::Normal(_)))
            {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "Invalid managed source path",
                ));
            }
        }
        let mut source = self
            .0
            .write()
            .map_err(|_| io::Error::other("Source poisoned"))?;
        if directory_identity(&source.root)? != source.identity {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "Managed source directory changed",
            ));
        }
        let mut parents = HashSet::new();
        let mut readers = Vec::with_capacity(paths.len());
        for relative in paths {
            let mut path = source.root.clone();
            let mut components = relative.components().peekable();
            while let Some(component) = components.next() {
                path.push(component);
                let parent = components.peek().is_some();
                if parent && parents.contains(&path) {
                    continue;
                }
                if is_link(&fs::symlink_metadata(&path)?) {
                    return Err(io::Error::new(
                        io::ErrorKind::InvalidInput,
                        "Managed source paths cannot contain links",
                    ));
                }
                if parent {
                    parents.insert(path.clone());
                }
            }
            let snapshot = FileSnapshot::capture(&File::open(path)?)?;
            let file = Arc::new(Mutex::new(None));
            if source.readers.len() >= source.next_cleanup {
                source.readers.retain(|reader| reader.strong_count() > 0);
                source.next_cleanup = source.readers.len().saturating_mul(2).max(64);
            }
            source.readers.push(Arc::downgrade(&file));
            readers.push(RelocatableReader {
                relative: relative.to_path_buf(),
                snapshot,
                file,
                position: 0,
                failure: None,
                source: self.clone(),
            });
        }
        Ok(readers)
    }

    pub fn relocate(&self, destination: PathBuf) -> io::Result<()> {
        self.relocate_checked(None, destination, |source, target| {
            fs::rename(source, target)
        })
    }

    pub fn relocate_from(&self, expected_source: &Path, destination: PathBuf) -> io::Result<()> {
        self.relocate_checked(Some(expected_source), destination, |source, target| {
            fs::rename(source, target)
        })
    }

    #[cfg(test)]
    fn relocate_with(
        &self,
        destination: PathBuf,
        rename: impl FnOnce(&Path, &Path) -> io::Result<()>,
    ) -> io::Result<()> {
        self.relocate_checked(None, destination, rename)
    }

    fn relocate_checked(
        &self,
        expected_source: Option<&Path>,
        destination: PathBuf,
        rename: impl FnOnce(&Path, &Path) -> io::Result<()>,
    ) -> io::Result<()> {
        let name = destination.file_name().ok_or_else(|| {
            io::Error::new(io::ErrorKind::InvalidInput, "Invalid source destination")
        })?;
        let parent = destination
            .parent()
            .filter(|parent| !parent.as_os_str().is_empty())
            .unwrap_or(Path::new("."));
        let destination = parent.canonicalize()?.join(name);
        let mut source = self
            .0
            .write()
            .map_err(|_| io::Error::other("Source poisoned"))?;
        if directory_identity(&source.root)? != source.identity {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "Managed source directory changed",
            ));
        }
        if let Some(expected) = expected_source
            && (is_link(&fs::symlink_metadata(expected)?)
                || expected.canonicalize()? != source.root
                || directory_identity(expected)? != source.identity)
        {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "Relocation does not match the managed source directory",
            ));
        }
        if destination == source.root {
            return Ok(());
        }
        match fs::symlink_metadata(&destination) {
            Ok(_) => {
                return Err(io::Error::new(
                    io::ErrorKind::AlreadyExists,
                    "Source destination already exists",
                ));
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(error),
        }
        source.readers.retain(|reader| reader.strong_count() > 0);
        for reader in source.readers.iter().filter_map(Weak::upgrade) {
            drop(
                reader
                    .lock()
                    .map_err(|_| io::Error::other("Reader poisoned"))?
                    .take(),
            );
        }
        rename(&source.root, &destination)?;
        source.root = destination;
        Ok(())
    }
}

impl RelocatableReader {
    pub fn len(&self) -> u64 {
        self.snapshot.length
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    pub(crate) fn close(&mut self) -> io::Result<()> {
        drop(
            self.file
                .lock()
                .map_err(|_| io::Error::other("Reader poisoned"))?
                .take(),
        );
        Ok(())
    }

    fn read_current(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        if buffer.is_empty() || self.position >= self.len() {
            return Ok(0);
        }
        let source = self
            .source
            .0
            .read()
            .map_err(|_| io::Error::other("Source poisoned"))?;
        let mut cached = self
            .file
            .lock()
            .map_err(|_| io::Error::other("Reader poisoned"))?;
        if cached.is_none() {
            let mut file = open_relative(&source.root, &self.relative)?;
            self.snapshot.validate(&file)?;
            file.seek(SeekFrom::Start(self.position))?;
            *cached = Some(file);
        }
        let file = cached
            .as_mut()
            .ok_or_else(|| io::Error::other("Missing managed source file"))?;
        let limit = (self.len() - self.position).min(buffer.len() as u64) as usize;
        let count = file.read(&mut buffer[..limit])?;
        if count == 0 {
            return Err(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "Managed source was truncated",
            ));
        }
        let position = self.position.checked_add(count as u64).ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::InvalidData,
                "Managed source position overflow",
            )
        })?;
        if position == self.len() {
            self.snapshot.validate(file)?;
        }
        self.position = position;
        Ok(count)
    }
}

impl Read for RelocatableReader {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        if let Some(error) = &self.failure {
            return Err(io::Error::new(error.kind(), error.to_string()));
        }
        match self.read_current(buffer) {
            Ok(count) => Ok(count),
            Err(error) => {
                self.failure = Some(io::Error::new(error.kind(), error.to_string()));
                Err(error)
            }
        }
    }
}

impl Seek for RelocatableReader {
    fn seek(&mut self, from: SeekFrom) -> io::Result<u64> {
        if let Some(error) = &self.failure {
            return Err(io::Error::new(error.kind(), error.to_string()));
        }
        let position = match from {
            SeekFrom::Start(position) => i128::from(position),
            SeekFrom::Current(offset) => i128::from(self.position) + i128::from(offset),
            SeekFrom::End(offset) => i128::from(self.len()) + i128::from(offset),
        };
        let position = u64::try_from(position).map_err(|_| {
            io::Error::new(io::ErrorKind::InvalidInput, "Invalid managed source seek")
        })?;
        if position != self.position {
            self.close()?;
            self.position = position;
        }
        Ok(position)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Fixture(PathBuf);

    impl Fixture {
        fn new() -> Self {
            static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
            let sequence = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            let unique = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let root = std::env::temp_dir().join(format!(
                "cap-revocable-source-probe-{}-{unique}-{sequence}",
                std::process::id()
            ));
            fs::create_dir(&root).unwrap();
            fs::create_dir(root.join("original")).unwrap();
            fs::write(root.join("original/0.m4s"), b"first-original-fragment").unwrap();
            fs::write(root.join("original/1.m4s"), b"second-original-fragment").unwrap();
            Self(root)
        }

        fn source(&self) -> RelocatableSource {
            RelocatableSource::new(self.0.join("original")).unwrap()
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            fs::remove_dir_all(&self.0).unwrap();
        }
    }

    fn read(source: &RelocatableSource, relative: &str) -> Vec<u8> {
        let mut data = Vec::new();
        source
            .reader(Path::new(relative))
            .unwrap()
            .read_to_end(&mut data)
            .unwrap();
        data
    }

    #[test]
    fn held_reader_and_lazy_next_fragment_survive_publication() {
        let fixture = Fixture::new();
        let source = fixture.source();
        let mut first = source.reader(Path::new("0.m4s")).unwrap();
        let mut prefix = [0; 5];
        first.read_exact(&mut prefix).unwrap();
        assert_eq!(&prefix, b"first");
        assert!(first.file.lock().unwrap().is_some());
        source.relocate(fixture.0.join("retained")).unwrap();
        assert!(first.file.lock().unwrap().is_none());
        fs::create_dir(fixture.0.join("original")).unwrap();
        fs::write(fixture.0.join("original/0.m4s"), b"published-output").unwrap();
        let mut rest = Vec::new();
        first.read_to_end(&mut rest).unwrap();
        assert_eq!(rest, b"-original-fragment");
        first.seek(SeekFrom::Start(0)).unwrap();
        let mut all = Vec::new();
        first.read_to_end(&mut all).unwrap();
        assert_eq!(all, b"first-original-fragment");
        assert_eq!(read(&source, "0.m4s"), b"first-original-fragment");
        assert_eq!(read(&source, "1.m4s"), b"second-original-fragment");
        assert_eq!(
            fs::read(fixture.0.join("original/0.m4s")).unwrap(),
            b"published-output"
        );
    }

    #[test]
    fn failed_relocation_preserves_reader_position_and_original_root() {
        let fixture = Fixture::new();
        let source = fixture.source();
        let mut reader = source.reader(Path::new("1.m4s")).unwrap();
        let mut prefix = [0; 6];
        reader.read_exact(&mut prefix).unwrap();
        assert_eq!(&prefix, b"second");
        assert!(
            source
                .relocate_with(fixture.0.join("retained"), |_, _| {
                    Err(io::Error::new(io::ErrorKind::PermissionDenied, "injected"))
                })
                .is_err()
        );
        let mut rest = Vec::new();
        reader.read_to_end(&mut rest).unwrap();
        assert_eq!(rest, b"-original-fragment");
    }

    #[test]
    fn rollback_relocation_preserves_active_readers() {
        let fixture = Fixture::new();
        let source = fixture.source();
        let mut reader = source.reader(Path::new("1.m4s")).unwrap();
        let mut prefix = [0; 3];
        reader.read_exact(&mut prefix).unwrap();
        source.relocate(fixture.0.join("retained")).unwrap();
        reader.read_exact(&mut prefix).unwrap();
        source.relocate(fixture.0.join("original")).unwrap();
        let mut rest = Vec::new();
        reader.read_to_end(&mut rest).unwrap();
        assert_eq!(rest, b"-original-fragment");
    }

    #[test]
    fn concurrent_readers_keep_exact_bytes_during_repeated_relocation() {
        let fixture = Fixture::new();
        let source = fixture.source();
        std::thread::scope(|scope| {
            for _ in 0..4 {
                let source = source.clone();
                scope.spawn(move || {
                    let mut reader = source.reader(Path::new("1.m4s")).unwrap();
                    for _ in 0..1_000 {
                        reader.seek(SeekFrom::Start(0)).unwrap();
                        let mut bytes = Vec::new();
                        reader.read_to_end(&mut bytes).unwrap();
                        assert_eq!(bytes, b"second-original-fragment");
                    }
                });
            }
            for _ in 0..300 {
                source.relocate(fixture.0.join("retained")).unwrap();
                source.relocate(fixture.0.join("original")).unwrap();
            }
        });
    }

    #[test]
    fn reader_cannot_resolve_outside_its_relative_source() {
        let fixture = Fixture::new();
        let source = fixture.source();
        for path in ["", "../0.m4s", "/0.m4s", ".", "segment/../0.m4s"] {
            assert!(source.reader(Path::new(path)).is_err());
        }
    }

    #[test]
    fn invalid_seek_keeps_the_last_successful_position() {
        let fixture = Fixture::new();
        let source = fixture.source();
        let mut reader = source.reader(Path::new("1.m4s")).unwrap();
        reader.seek(SeekFrom::Start(6)).unwrap();
        assert!(reader.seek(SeekFrom::Current(-7)).is_err());
        source.relocate(fixture.0.join("retained")).unwrap();
        let mut rest = Vec::new();
        reader.read_to_end(&mut rest).unwrap();
        assert_eq!(rest, b"-original-fragment");
    }

    #[test]
    fn reopened_reader_rejects_a_changed_source_size() {
        let fixture = Fixture::new();
        let source = fixture.source();
        let mut reader = source.reader(Path::new("1.m4s")).unwrap();
        reader.read_exact(&mut [0; 1]).unwrap();
        source.relocate(fixture.0.join("retained")).unwrap();
        fs::write(fixture.0.join("retained/1.m4s"), b"changed").unwrap();
        assert!(reader.read(&mut [0; 1]).is_err());
    }

    #[test]
    fn replacement_with_matching_length_and_mtime_is_rejected_and_stays_failed() {
        let fixture = Fixture::new();
        let source = fixture.source();
        let mut reader = source.reader(Path::new("1.m4s")).unwrap();
        reader.read_exact(&mut [0; 1]).unwrap();
        source.relocate(fixture.0.join("retained")).unwrap();
        let path = fixture.0.join("retained/1.m4s");
        let bytes = fs::read(&path).unwrap();
        let modified = path.metadata().unwrap().modified().unwrap();
        let backup = path.with_extension("backup");
        fs::rename(&path, &backup).unwrap();
        fs::write(&path, bytes).unwrap();
        File::options()
            .write(true)
            .open(&path)
            .unwrap()
            .set_times(fs::FileTimes::new().set_modified(modified))
            .unwrap();
        assert_eq!(
            reader.read(&mut [0; 1]).unwrap_err().kind(),
            io::ErrorKind::InvalidData
        );
        fs::remove_file(&path).unwrap();
        fs::rename(backup, path).unwrap();
        assert_eq!(
            reader.seek(SeekFrom::Start(0)).unwrap_err().kind(),
            io::ErrorKind::InvalidData
        );
        assert!(reader.read(&mut [0; 1]).is_err());
    }

    #[test]
    fn existing_destination_and_ordinary_path_are_never_replaced() {
        let fixture = Fixture::new();
        let source = fixture.source();
        let destination = fixture.0.join("existing");
        fs::create_dir(&destination).unwrap();
        fs::write(destination.join("output"), b"ordinary output").unwrap();
        assert_eq!(
            source.relocate(destination.clone()).unwrap_err().kind(),
            io::ErrorKind::AlreadyExists
        );
        assert_eq!(
            fs::read(destination.join("output")).unwrap(),
            b"ordinary output"
        );
        assert_eq!(read(&source, "0.m4s"), b"first-original-fragment");
    }

    #[test]
    fn capability_rejects_a_replaced_root() {
        let fixture = Fixture::new();
        let source = fixture.source();
        fs::rename(fixture.0.join("original"), fixture.0.join("external")).unwrap();
        fs::create_dir(fixture.0.join("original")).unwrap();
        fs::write(fixture.0.join("original/0.m4s"), b"replacement").unwrap();
        assert!(source.reader(Path::new("0.m4s")).is_err());
        assert!(source.relocate(fixture.0.join("retained")).is_err());
        assert_eq!(
            fs::read(fixture.0.join("external/0.m4s")).unwrap(),
            b"first-original-fragment"
        );
    }

    #[cfg(unix)]
    #[test]
    fn source_paths_cannot_follow_a_symbolic_link() {
        let fixture = Fixture::new();
        let source = fixture.source();
        fs::write(fixture.0.join("outside"), b"outside").unwrap();
        std::os::unix::fs::symlink(fixture.0.join("outside"), fixture.0.join("original/link"))
            .unwrap();
        assert!(source.reader(Path::new("link")).is_err());
    }

    #[test]
    fn many_lazy_readers_do_not_retain_file_handles() {
        let fixture = Fixture::new();
        let source = fixture.source();
        let readers: Vec<_> = (0..2_000)
            .map(|_| source.reader(Path::new("0.m4s")).unwrap())
            .collect();
        assert!(
            readers
                .iter()
                .all(|reader| reader.file.lock().unwrap().is_none())
        );
        source.relocate(fixture.0.join("retained")).unwrap();
        for mut reader in readers {
            let mut bytes = Vec::new();
            reader.read_to_end(&mut bytes).unwrap();
            assert_eq!(bytes, b"first-original-fragment");
        }
    }

    #[cfg(unix)]
    #[test]
    fn source_root_cannot_be_a_symbolic_link() {
        let fixture = Fixture::new();
        let link = fixture.0.join("link");
        std::os::unix::fs::symlink(fixture.0.join("original"), &link).unwrap();
        assert!(RelocatableSource::new(link).is_err());
    }

    #[cfg(windows)]
    #[test]
    fn source_root_cannot_be_a_directory_junction() {
        let fixture = Fixture::new();
        let link = fixture.0.join("link");
        let result = std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(&link)
            .arg(fixture.0.join("original"))
            .output()
            .unwrap();
        assert!(
            result.status.success(),
            "{}",
            String::from_utf8_lossy(&result.stderr)
        );
        assert!(RelocatableSource::new(link).is_err());
    }

    #[test]
    fn expected_source_rejects_other_project_and_stale_roots_without_consuming_reader() {
        let fixture = Fixture::new();
        let source = fixture.source();
        let original = fixture.0.join("original");
        let retained = fixture.0.join("retained");
        let other = fixture.0.join("other");
        fs::create_dir(&other).unwrap();
        fs::write(other.join("untouched"), b"other-project").unwrap();
        let mut reader = source.reader(Path::new("0.m4s")).unwrap();
        let mut prefix = [0; 5];
        reader.read_exact(&mut prefix).unwrap();
        assert_eq!(&prefix, b"first");
        for destination in [&retained, &original] {
            assert_eq!(
                source
                    .relocate_from(&other, destination.clone())
                    .unwrap_err()
                    .kind(),
                io::ErrorKind::InvalidInput
            );
        }
        assert!(reader.file.lock().unwrap().is_some());
        source.relocate_from(&original, retained.clone()).unwrap();
        fs::create_dir(&original).unwrap();
        fs::write(original.join("published"), b"ordinary-output").unwrap();
        assert_eq!(
            source
                .relocate_from(&original, fixture.0.join("wrong"))
                .unwrap_err()
                .kind(),
            io::ErrorKind::InvalidInput
        );
        let mut remainder = Vec::new();
        reader.read_to_end(&mut remainder).unwrap();
        assert_eq!(remainder, b"-original-fragment");
        assert_eq!(fs::read(other.join("untouched")).unwrap(), b"other-project");
        assert_eq!(
            fs::read(original.join("published")).unwrap(),
            b"ordinary-output"
        );
        fs::remove_file(original.join("published")).unwrap();
        fs::remove_dir(&original).unwrap();
        source.relocate_from(&retained, original.clone()).unwrap();
        reader.rewind().unwrap();
        remainder.clear();
        reader.read_to_end(&mut remainder).unwrap();
        assert_eq!(remainder, b"first-original-fragment");
    }

    #[test]
    fn expected_source_rejects_replacement_identity_before_closing_readers() {
        let fixture = Fixture::new();
        let source = fixture.source();
        let original = fixture.0.join("original");
        let backup = fixture.0.join("external-backup");
        let mut reader = source.reader(Path::new("0.m4s")).unwrap();
        let mut prefix = [0; 5];
        reader.read_exact(&mut prefix).unwrap();
        reader.close().unwrap();
        fs::rename(&original, &backup).unwrap();
        fs::create_dir(&original).unwrap();
        assert_eq!(
            source
                .relocate_from(&original, fixture.0.join("retained"))
                .unwrap_err()
                .kind(),
            io::ErrorKind::InvalidData
        );
        fs::remove_dir(&original).unwrap();
        fs::rename(&backup, &original).unwrap();
        let mut remainder = Vec::new();
        reader.read_to_end(&mut remainder).unwrap();
        assert_eq!(remainder, b"-original-fragment");
    }

    #[test]
    fn batch_keeps_each_file_identity_and_revalidates_root_between_batches() {
        let fixture = Fixture::new();
        let source = fixture.source();
        let original = fixture.0.join("original");
        fs::create_dir(original.join("display")).unwrap();
        let paths: Vec<_> = (0..64)
            .map(|index| PathBuf::from(format!("display/{index}.m4s")))
            .collect();
        for (index, path) in paths.iter().enumerate() {
            fs::write(original.join(path), [index as u8; 32]).unwrap();
        }
        let mut readers = source.readers(&paths).unwrap();
        assert!(
            readers
                .iter()
                .all(|reader| reader.file.lock().unwrap().is_none())
        );
        let changed = original.join(&paths[17]);
        let metadata = fs::metadata(&changed).unwrap();
        fs::rename(&changed, original.join("preserved-original")).unwrap();
        fs::write(&changed, [17; 32]).unwrap();
        File::options()
            .write(true)
            .open(&changed)
            .unwrap()
            .set_modified(metadata.modified().unwrap())
            .unwrap();
        source.relocate(fixture.0.join("retained")).unwrap();
        for (index, reader) in readers.iter_mut().enumerate() {
            let mut output = Vec::new();
            if index == 17 {
                assert_eq!(
                    reader.read_to_end(&mut output).unwrap_err().kind(),
                    io::ErrorKind::InvalidData
                );
            } else {
                reader.read_to_end(&mut output).unwrap();
                assert_eq!(output, [index as u8; 32]);
            }
        }
        source.relocate(original.clone()).unwrap();
        fs::rename(&original, fixture.0.join("external")).unwrap();
        fs::create_dir(&original).unwrap();
        assert_eq!(
            source.readers(&paths).err().unwrap().kind(),
            io::ErrorKind::InvalidData
        );
    }

    #[cfg(unix)]
    #[test]
    fn batch_rejects_linked_parent_and_expected_root_alias() {
        let fixture = Fixture::new();
        let source = fixture.source();
        let original = fixture.0.join("original");
        std::os::unix::fs::symlink(&original, fixture.0.join("alias")).unwrap();
        assert_eq!(
            source
                .relocate_from(&fixture.0.join("alias"), fixture.0.join("retained"))
                .unwrap_err()
                .kind(),
            io::ErrorKind::InvalidInput
        );
        fs::create_dir(original.join("display")).unwrap();
        fs::write(original.join("display/0.m4s"), b"original").unwrap();
        std::os::unix::fs::symlink(original.join("display"), original.join("linked")).unwrap();
        assert_eq!(
            source
                .readers(&[
                    PathBuf::from("display/0.m4s"),
                    PathBuf::from("linked/0.m4s")
                ])
                .err()
                .unwrap()
                .kind(),
            io::ErrorKind::InvalidInput
        );
    }

    #[test]
    fn competing_expected_source_moves_have_only_one_owner() {
        let fixture = Fixture::new();
        let source = fixture.source();
        let original = fixture.0.join("original");
        let barrier = Arc::new(std::sync::Barrier::new(2));
        let workers: Vec<_> = (0..2)
            .map(|index| {
                let source = source.clone();
                let expected = original.clone();
                let destination = fixture.0.join(format!("retained-{index}"));
                let barrier = barrier.clone();
                std::thread::spawn(move || {
                    barrier.wait();
                    source.relocate_from(&expected, destination)
                })
            })
            .collect();
        let outcomes: Vec<_> = workers
            .into_iter()
            .map(|worker| worker.join().unwrap())
            .collect();
        assert_eq!(outcomes.iter().filter(|outcome| outcome.is_ok()).count(), 1);
        assert_eq!(read(&source, "0.m4s"), b"first-original-fragment");
        assert!(!original.exists());
    }

    struct ReleaseCounter(Arc<std::sync::atomic::AtomicUsize>);

    impl Drop for ReleaseCounter {
        fn drop(&mut self) {
            self.0.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        }
    }

    type CachedFileWatch = Weak<Mutex<Option<File>>>;

    struct FilesClosedAtRelease {
        root: PathBuf,
        cached: Mutex<Vec<CachedFileWatch>>,
        released: Arc<std::sync::atomic::AtomicUsize>,
    }

    impl Drop for FilesClosedAtRelease {
        fn drop(&mut self) {
            assert!(
                self.cached
                    .lock()
                    .unwrap()
                    .iter()
                    .all(|file| file.strong_count() == 0)
            );
            #[cfg(windows)]
            {
                use std::os::windows::fs::OpenOptionsExt;
                for name in ["0.m4s", "1.m4s"] {
                    drop(
                        File::options()
                            .read(true)
                            .write(true)
                            .share_mode(0)
                            .open(self.root.join(name))
                            .unwrap(),
                    );
                }
            }
            let renamed = self.root.with_extension("lease-released");
            fs::rename(&self.root, &renamed).unwrap();
            fs::rename(&renamed, &self.root).unwrap();
            self.released
                .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        }
    }

    #[test]
    fn source_owner_survives_cloned_sources_without_readers() {
        use std::sync::atomic::{AtomicUsize, Ordering};

        let fixture = Fixture::new();
        let released = Arc::new(AtomicUsize::new(0));
        let source = RelocatableSource::new_with_owner(
            fixture.0.join("original"),
            Arc::new(ReleaseCounter(released.clone())),
        )
        .unwrap();
        let first = source.clone();
        let last = first.clone();
        drop(source);
        drop(first);
        assert_eq!(released.load(Ordering::SeqCst), 0);
        drop(last);
        assert_eq!(released.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn source_owner_survives_every_reader_after_source_clones_drop() {
        use std::sync::atomic::{AtomicUsize, Ordering};

        let fixture = Fixture::new();
        let released = Arc::new(AtomicUsize::new(0));
        let source = RelocatableSource::new_with_owner(
            fixture.0.join("original"),
            Arc::new(ReleaseCounter(released.clone())),
        )
        .unwrap();
        let copy = source.clone();
        let first = source.reader(Path::new("0.m4s")).unwrap();
        let mut readers = copy
            .readers(&[PathBuf::from("0.m4s"), PathBuf::from("1.m4s")])
            .unwrap();
        let mut last = readers.pop().unwrap();
        drop(source);
        drop(copy);
        drop(first);
        drop(readers);
        assert_eq!(released.load(Ordering::SeqCst), 0);
        let mut bytes = Vec::new();
        last.read_to_end(&mut bytes).unwrap();
        assert_eq!(bytes, b"second-original-fragment");
        drop(last);
        assert_eq!(released.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn failed_source_construction_closes_files_before_releasing_owner() {
        use std::sync::atomic::{AtomicUsize, Ordering};

        let fixture = Fixture::new();
        for root in [fixture.0.join("missing"), fixture.0.join("original/0.m4s")] {
            let released = Arc::new(AtomicUsize::new(0));
            let owner = Arc::new(FilesClosedAtRelease {
                root: fixture.0.join("original"),
                cached: Mutex::new(Vec::new()),
                released: released.clone(),
            });
            assert!(RelocatableSource::new_with_owner(root, owner).is_err());
            assert_eq!(released.load(Ordering::SeqCst), 1);
        }
    }

    #[test]
    fn failed_reader_registration_does_not_leak_or_release_source_owner() {
        use std::sync::atomic::{AtomicUsize, Ordering};

        let fixture = Fixture::new();
        let released = Arc::new(AtomicUsize::new(0));
        let owner = Arc::new(FilesClosedAtRelease {
            root: fixture.0.join("original"),
            cached: Mutex::new(Vec::new()),
            released: released.clone(),
        });
        let source = RelocatableSource::new_with_owner(fixture.0.join("original"), owner).unwrap();
        assert!(source.reader(Path::new("../0.m4s")).is_err());
        assert!(source.reader(Path::new("missing.m4s")).is_err());
        assert!(
            source
                .readers(&[PathBuf::from("0.m4s"), PathBuf::from("missing.m4s")])
                .is_err()
        );
        assert!(
            source
                .0
                .read()
                .unwrap()
                .readers
                .iter()
                .all(|reader| reader.strong_count() == 0)
        );
        assert_eq!(released.load(Ordering::SeqCst), 0);
        assert_eq!(read(&source, "1.m4s"), b"second-original-fragment");
        drop(source);
        assert_eq!(released.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn failed_lazy_open_retains_owner_until_reader_and_files_drop() {
        use std::sync::atomic::{AtomicUsize, Ordering};

        let fixture = Fixture::new();
        let released = Arc::new(AtomicUsize::new(0));
        let owner = Arc::new(FilesClosedAtRelease {
            root: fixture.0.join("original"),
            cached: Mutex::new(Vec::new()),
            released: released.clone(),
        });
        let source =
            RelocatableSource::new_with_owner(fixture.0.join("original"), owner.clone()).unwrap();
        let mut reader = source.reader(Path::new("0.m4s")).unwrap();
        owner
            .cached
            .lock()
            .unwrap()
            .push(Arc::downgrade(&reader.file));
        fs::write(fixture.0.join("original/0.m4s"), b"changed").unwrap();
        let mut byte = [0];
        assert_eq!(
            reader.read(&mut byte).unwrap_err().kind(),
            io::ErrorKind::InvalidData
        );
        assert!(reader.file.lock().unwrap().is_none());
        drop(owner);
        drop(source);
        assert_eq!(released.load(Ordering::SeqCst), 0);
        drop(reader);
        assert_eq!(released.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn every_cached_file_closes_before_last_reader_releases_owner() {
        use std::sync::atomic::{AtomicUsize, Ordering};

        let fixture = Fixture::new();
        let released = Arc::new(AtomicUsize::new(0));
        let owner = Arc::new(FilesClosedAtRelease {
            root: fixture.0.join("original"),
            cached: Mutex::new(Vec::new()),
            released: released.clone(),
        });
        let source =
            RelocatableSource::new_with_owner(fixture.0.join("original"), owner.clone()).unwrap();
        let mut first = source.reader(Path::new("0.m4s")).unwrap();
        let mut last = source.reader(Path::new("1.m4s")).unwrap();
        let mut byte = [0];
        first.read_exact(&mut byte).unwrap();
        last.read_exact(&mut byte).unwrap();
        assert!(first.file.lock().unwrap().is_some());
        assert!(last.file.lock().unwrap().is_some());
        owner
            .cached
            .lock()
            .unwrap()
            .extend([Arc::downgrade(&first.file), Arc::downgrade(&last.file)]);
        drop(owner);
        drop(source);
        drop(first);
        assert_eq!(released.load(Ordering::SeqCst), 0);
        std::thread::spawn(move || drop(last)).join().unwrap();
        assert_eq!(released.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn source_owner_survives_publication_failed_move_and_rollback() {
        use std::sync::atomic::{AtomicUsize, Ordering};

        let fixture = Fixture::new();
        let released = Arc::new(AtomicUsize::new(0));
        let owner = Arc::new(ReleaseCounter(released.clone()));
        let identity = Arc::downgrade(&owner);
        let source = RelocatableSource::new_with_owner(fixture.0.join("original"), owner).unwrap();
        let mut reader = source.reader(Path::new("1.m4s")).unwrap();
        let mut bytes = [0; 3];
        reader.read_exact(&mut bytes).unwrap();
        assert_eq!(&bytes, b"sec");
        source
            .relocate_from(&fixture.0.join("original"), fixture.0.join("retained"))
            .unwrap();
        assert!(identity.upgrade().is_some());
        assert_eq!(released.load(Ordering::SeqCst), 0);
        reader.read_exact(&mut bytes).unwrap();
        assert_eq!(&bytes, b"ond");
        assert!(
            source
                .relocate_with(fixture.0.join("failed"), |_, _| {
                    Err(io::Error::new(io::ErrorKind::PermissionDenied, "injected"))
                })
                .is_err()
        );
        assert!(identity.upgrade().is_some());
        assert_eq!(released.load(Ordering::SeqCst), 0);
        source
            .relocate_from(&fixture.0.join("retained"), fixture.0.join("original"))
            .unwrap();
        assert!(identity.upgrade().is_some());
        drop(source);
        assert_eq!(released.load(Ordering::SeqCst), 0);
        let mut rest = Vec::new();
        reader.read_to_end(&mut rest).unwrap();
        assert_eq!(rest, b"-original-fragment");
        drop(reader);
        assert!(identity.upgrade().is_none());
        assert_eq!(released.load(Ordering::SeqCst), 1);
    }
}
