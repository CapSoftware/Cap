use std::{
    fs::{File, OpenOptions},
    io::{self, ErrorKind},
    path::{Path, PathBuf},
};

fn copy_path(source: &Path, number: u64) -> PathBuf {
    let mut name = source.file_stem().unwrap_or_default().to_os_string();
    name.push(" copy");
    if number > 1 {
        name.push(format!(" {number}"));
    }
    if let Some(extension) = source.extension() {
        name.push(".");
        name.push(extension);
    }
    source.with_file_name(name)
}

pub fn duplicate_file(source: &Path) -> Result<PathBuf, String> {
    duplicate(source).map_err(|error| format!("Failed to copy file: {error}"))
}

fn duplicate(source: &Path) -> io::Result<PathBuf> {
    let mut input = File::open(source)?;
    if !input.metadata()?.is_file() {
        return Err(io::Error::new(
            ErrorKind::InvalidInput,
            "only files can be copied",
        ));
    }
    let mut number = 1;
    loop {
        let destination = copy_path(source, number);
        match OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&destination)
        {
            Ok(mut output) => {
                if let Err(error) = io::copy(&mut input, &mut output) {
                    drop(output);
                    let _ = std::fs::remove_file(&destination);
                    return Err(error);
                }
                return Ok(destination);
            }
            Err(error) if error.kind() == ErrorKind::AlreadyExists => number += 1,
            Err(error) => return Err(error),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn copy_names_preserve_extensions() {
        for (source, expected) in [
            ("video.mp4", "video copy.mp4"),
            ("video.final.mp4", "video.final copy.mp4"),
            ("recording", "recording copy"),
            (".hidden", ".hidden copy"),
            ("日本語.png", "日本語 copy.png"),
            ("video copy.mp4", "video copy copy.mp4"),
        ] {
            assert_eq!(copy_path(Path::new(source), 1), Path::new(expected));
        }
        assert_eq!(
            copy_path(Path::new("/output/video.mp4"), 2),
            Path::new("/output/video copy 2.mp4")
        );
    }

    #[test]
    fn existing_copies_are_never_overwritten() {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("video.final.mp4");
        std::fs::write(&source, b"original").unwrap();
        std::fs::write(dir.path().join("video.final copy.mp4"), b"first").unwrap();
        std::fs::create_dir(dir.path().join("video.final copy 2.mp4")).unwrap();
        let copy = duplicate_file(&source).unwrap();
        assert_eq!(copy, dir.path().join("video.final copy 3.mp4"));
        assert_eq!(std::fs::read(copy).unwrap(), b"original");
        assert_eq!(
            std::fs::read(dir.path().join("video.final copy.mp4")).unwrap(),
            b"first"
        );
        assert_eq!(std::fs::read(source).unwrap(), b"original");
    }

    #[test]
    fn concurrent_copies_get_distinct_names() {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("screenshot.png");
        std::fs::write(&source, b"pixels").unwrap();
        let copies = std::thread::scope(|scope| {
            let first = scope.spawn(|| duplicate_file(&source).unwrap());
            let second = scope.spawn(|| duplicate_file(&source).unwrap());
            [first.join().unwrap(), second.join().unwrap()]
        });
        assert_ne!(copies[0], copies[1]);
        for copy in copies {
            assert_eq!(std::fs::read(copy).unwrap(), b"pixels");
        }
    }

    #[test]
    fn missing_files_and_project_directories_fail_without_a_copy() {
        let dir = tempfile::tempdir().unwrap();
        assert!(
            duplicate_file(&dir.path().join("missing.mp4"))
                .unwrap_err()
                .starts_with("Failed to copy file:")
        );
        let project = dir.path().join("recording.cap");
        std::fs::create_dir(&project).unwrap();
        assert!(duplicate_file(&project).is_err());
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1);
    }
}
