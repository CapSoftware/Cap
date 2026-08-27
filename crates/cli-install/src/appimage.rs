use std::{
    ffi::OsString,
    fs,
    io::Write,
    os::unix::{
        ffi::{OsStrExt, OsStringExt},
        fs::OpenOptionsExt,
    },
    path::{Path, PathBuf},
};

const SHIM_PREFIX: &[u8] = b"#!/bin/sh\nexec '";
const SHIM_SUFFIX: &[u8] = b"' --cap-cli \"$@\"\n";

pub fn current_path() -> Option<PathBuf> {
    #[cfg(target_os = "linux")]
    {
        appimage_path(
            Path::new(&std::env::var_os("APPIMAGE")?),
            Path::new(&std::env::var_os("APPDIR")?),
            &std::env::current_exe().ok()?,
        )
    }
    #[cfg(not(target_os = "linux"))]
    None
}

#[cfg(any(target_os = "linux", test))]
fn appimage_path(image: &Path, directory: &Path, executable: &Path) -> Option<PathBuf> {
    (image.is_absolute() && directory.is_absolute() && executable.starts_with(directory))
        .then(|| image.to_path_buf())
}

fn shim_contents(target: &Path) -> Result<Vec<u8>, String> {
    if !target.is_absolute() {
        return Err("The AppImage CLI launcher requires an absolute application path".into());
    }

    let mut contents = SHIM_PREFIX.to_vec();
    for byte in target.as_os_str().as_bytes() {
        if *byte == b'\'' {
            contents.extend_from_slice(b"'\\''");
        } else {
            contents.push(*byte);
        }
    }
    contents.extend_from_slice(SHIM_SUFFIX);
    Ok(contents)
}

pub fn shim_target(contents: &[u8]) -> Option<PathBuf> {
    let mut encoded = contents
        .strip_prefix(SHIM_PREFIX)?
        .strip_suffix(SHIM_SUFFIX)?;
    let mut decoded = Vec::with_capacity(encoded.len());
    while let Some((&byte, remaining)) = encoded.split_first() {
        if byte == b'\'' {
            encoded = encoded.strip_prefix(b"'\\''")?;
        } else {
            if byte == 0 {
                return None;
            }
            encoded = remaining;
        }
        decoded.push(byte);
    }
    let target = PathBuf::from(OsString::from_vec(decoded));
    target.is_absolute().then_some(target)
}

pub fn write_shim(shim: &Path, target: &Path) -> Result<(), String> {
    let contents = shim_contents(target)?;
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o755)
        .open(shim)
        .map_err(|error| format!("Could not create AppImage CLI launcher: {error}"))?;
    file.write_all(&contents)
        .map_err(|error| format!("Could not write AppImage CLI launcher: {error}"))
}

#[cfg(any(target_os = "linux", test))]
fn cli_command(
    executable: &Path,
    original_directory: Option<&Path>,
) -> Result<std::process::Command, String> {
    let directory = original_directory
        .filter(|directory| directory.is_absolute() && directory.is_dir())
        .ok_or_else(|| "The AppImage original working directory is unavailable".to_string())?;
    let mut command = std::process::Command::new(executable);
    command.current_dir(directory);
    Ok(command)
}

#[cfg(target_os = "linux")]
pub fn dispatch_cli() -> Result<(), String> {
    use std::os::unix::process::CommandExt;

    let mut arguments = std::env::args_os().skip(1);
    if arguments.next().as_deref() != Some(std::ffi::OsStr::new("--cap-cli")) {
        return Ok(());
    }
    if current_path().is_none() {
        return Err("The --cap-cli launcher is only available inside a Cap AppImage".into());
    }
    let executable = std::env::current_exe().map_err(|error| error.to_string())?;
    let directory = executable
        .parent()
        .ok_or_else(|| "Could not locate the AppImage executable directory".to_string())?;
    let original_directory = std::env::var_os("OWD").map(PathBuf::from);
    let error = cli_command(&directory.join("cap-cli"), original_directory.as_deref())?
        .args(arguments)
        .exec();
    Err(format!("Could not launch the bundled Cap CLI: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ignores_appimage_environment_from_unrelated_applications() {
        assert_eq!(
            appimage_path(
                Path::new("/home/user/Cap.AppImage"),
                Path::new("/tmp/.mount_cap"),
                Path::new("/tmp/.mount_cap/usr/bin/Cap"),
            ),
            Some(PathBuf::from("/home/user/Cap.AppImage"))
        );
        assert!(
            appimage_path(
                Path::new("/home/user/Cap.AppImage"),
                Path::new("/tmp/.mount_cap"),
                Path::new("/usr/bin/Cap"),
            )
            .is_none()
        );
    }

    #[test]
    fn launcher_round_trips_shell_metacharacters_and_non_unicode_paths() {
        for raw in [
            b"/home/user/Cap.AppImage".as_slice(),
            b"/home/user/Cap's $(example) `command`.AppImage".as_slice(),
            b"/home/user/Cap-\xff.AppImage".as_slice(),
        ] {
            let target = PathBuf::from(OsString::from_vec(raw.to_vec()));
            assert_eq!(shim_target(&shim_contents(&target).unwrap()), Some(target));
        }
        assert!(shim_contents(Path::new("relative.AppImage")).is_err());
        assert!(shim_target(b"#!/bin/sh\nexec '/tmp/Cap'bad' --cap-cli \"$@\"\n").is_none());
        assert!(
            shim_target(b"#!/bin/sh\nexec '/tmp/Cap' --cap-cli \"$@\"\necho extra\n").is_none()
        );
    }

    #[test]
    fn launcher_preserves_arguments_exit_status_and_in_place_updates() {
        use std::os::unix::fs::PermissionsExt;

        let directory = tempfile::tempdir().unwrap();
        let image = directory.path().join("Cap's portable.AppImage");
        let shim = directory.path().join("cap");
        fs::write(&image, b"#!/bin/sh\nprintf '%s\\n' \"$@\"\nexit 23\n").unwrap();
        fs::set_permissions(&image, fs::Permissions::from_mode(0o755)).unwrap();
        write_shim(&shim, &image).unwrap();
        let output = std::process::Command::new(&shim)
            .args(["--version", "two words", "$(literal)"])
            .output()
            .unwrap();
        assert_eq!(output.status.code(), Some(23));
        assert_eq!(
            output.stdout,
            b"--cap-cli\n--version\ntwo words\n$(literal)\n"
        );
        fs::write(&image, b"#!/bin/sh\nprintf replacement\n").unwrap();
        let output = std::process::Command::new(&shim).output().unwrap();
        assert!(output.status.success());
        assert_eq!(output.stdout, b"replacement");
        assert!(write_shim(&shim, &image).is_err());
    }

    #[test]
    fn cli_launch_resolves_relative_paths_from_the_original_directory() {
        let parent_directory = std::env::current_dir().unwrap();
        let root = tempfile::tempdir().unwrap();
        for name in [
            b"caller's directory".as_slice(),
            #[cfg(target_os = "linux")]
            b"caller-\xff".as_slice(),
        ] {
            let directory = root.path().join(OsString::from_vec(name.to_vec()));
            fs::create_dir(&directory).unwrap();
            fs::write(directory.join("relative-project.txt"), b"caller project").unwrap();
            let mut command = cli_command(Path::new("/bin/sh"), Some(&directory)).unwrap();
            assert_eq!(command.get_current_dir(), Some(directory.as_path()));
            let output = command
                .args(["-c", "cat relative-project.txt"])
                .output()
                .unwrap();
            assert!(output.status.success());
            assert_eq!(output.stdout, b"caller project");
        }
        assert_eq!(std::env::current_dir().unwrap(), parent_directory);
    }

    #[test]
    fn cli_launch_never_substitutes_a_different_directory_for_invalid_owd() {
        let root = tempfile::tempdir().unwrap();
        let executable = Path::new("/bin/sh");
        assert!(cli_command(executable, Some(Path::new("relative"))).is_err());
        assert!(cli_command(executable, Some(&root.path().join("missing"))).is_err());
        let file = root.path().join("file");
        fs::write(&file, b"not a directory").unwrap();
        assert!(cli_command(executable, Some(&file)).is_err());
        assert!(cli_command(executable, None).is_err());

        let directory = root.path().join("removed-before-launch");
        fs::create_dir(&directory).unwrap();
        let mut command = cli_command(executable, Some(&directory)).unwrap();
        fs::remove_dir(&directory).unwrap();
        assert!(command.output().is_err());
    }
}
