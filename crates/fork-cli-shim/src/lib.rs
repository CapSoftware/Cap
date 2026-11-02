//! `cap-cli-install` keeps owning the `cap` shim. This wraps it so the fork's
//! command lands beside that shim, which stays as the old name's alias.

pub use cap_cli_install::CliInstallStatus;
use std::{
    ffi::OsStr,
    fs, io,
    path::{Path, PathBuf},
};

const CLI_BINARY_STEM: &str = "cap-cli";

fn alias_path(shim: &Path) -> PathBuf {
    let mut name = fork_brand::CLI_NAME.to_string();
    if let Some(extension) = shim.extension().and_then(OsStr::to_str) {
        name.push('.');
        name.push_str(extension);
    }
    shim.with_file_name(name)
}

fn present(path: &Path) -> bool {
    fs::symlink_metadata(path).is_ok()
}

fn alias_is_managed(alias: &Path, shim: &Path) -> bool {
    match fs::read_link(alias) {
        Ok(link) => link
            .file_name()
            .and_then(OsStr::to_str)
            .is_some_and(|name| name.starts_with(CLI_BINARY_STEM)),
        Err(error) if error.kind() == io::ErrorKind::InvalidInput => fs::read(alias)
            .ok()
            .is_some_and(|contents| fs::read(shim).ok().as_ref() == Some(&contents)),
        Err(_) => false,
    }
}

fn alias_points_to(alias: &Path, shim: &Path, target: &Path) -> bool {
    match fs::read_link(alias) {
        Ok(link) => {
            link == target
                || matches!(
                    (fs::canonicalize(&link), fs::canonicalize(target)),
                    (Ok(a), Ok(b)) if a == b
                )
        }
        Err(_) => present(alias) && alias_is_managed(alias, shim),
    }
}

fn not_managed(alias: &Path) -> String {
    format!(
        "{} already exists and is not managed by {}",
        alias.display(),
        fork_brand::APP_NAME
    )
}

#[cfg(unix)]
fn write_alias(shim: &Path, alias: &Path, target: &Path) -> io::Result<()> {
    if fs::read_link(shim).is_ok() {
        std::os::unix::fs::symlink(target, alias)
    } else {
        fs::copy(shim, alias).map(|_| ())
    }
}

#[cfg(not(unix))]
fn write_alias(shim: &Path, alias: &Path, _target: &Path) -> io::Result<()> {
    fs::copy(shim, alias).map(|_| ())
}

fn link_alias(shim: &Path, alias: &Path, target: &Path) -> Result<(), String> {
    if present(alias) {
        if !alias_is_managed(alias, shim) {
            return Err(not_managed(alias));
        }
        fs::remove_file(alias).map_err(|error| format!("Could not replace CLI alias: {error}"))?;
    }
    write_alias(shim, alias, target).map_err(|error| format!("Could not create CLI alias: {error}"))
}

fn unlink_alias(shim: &Path, alias: &Path) -> Result<(), String> {
    if present(alias) && alias_is_managed(alias, shim) {
        fs::remove_file(alias).map_err(|error| format!("Could not remove CLI alias: {error}"))?;
    }
    Ok(())
}

fn show_alias(mut status: CliInstallStatus) -> CliInstallStatus {
    let shim = PathBuf::from(&status.shim_path);
    let alias = alias_path(&shim);
    let target = PathBuf::from(&status.target_path);
    if status.conflict.is_none() && present(&alias) && !alias_is_managed(&alias, &shim) {
        status.conflict = Some(not_managed(&alias));
    }
    status.installed = status.installed && alias_points_to(&alias, &shim, &target);
    status.shim_path = alias.display().to_string();
    status
}

pub fn status() -> Result<CliInstallStatus, String> {
    cap_cli_install::status().map(show_alias)
}

pub fn install() -> Result<CliInstallStatus, String> {
    let status = cap_cli_install::install()?;
    let shim = PathBuf::from(&status.shim_path);
    link_alias(&shim, &alias_path(&shim), Path::new(&status.target_path))?;
    Ok(show_alias(status))
}

pub fn uninstall() -> Result<CliInstallStatus, String> {
    let status = cap_cli_install::status()?;
    let shim = PathBuf::from(&status.shim_path);
    unlink_alias(&shim, &alias_path(&shim))?;
    cap_cli_install::uninstall().map(show_alias)
}

/// Moving the app to a new bundle name leaves an existing `cap` shim dangling,
/// and that release predates the new command. Repairs both, but only for a
/// shim the user already installed and that no other live install owns.
fn repair_after_rename() -> Result<(), String> {
    let status = cap_cli_install::status()?;
    let shim = PathBuf::from(&status.shim_path);
    if !present(&shim) {
        return Ok(());
    }
    if fs::metadata(&shim).is_err() {
        install()?;
    } else if status.installed {
        link_alias(&shim, &alias_path(&shim), Path::new(&status.target_path))?;
    }
    Ok(())
}

/// Off the UI thread and best effort: a failure leaves the repair to
/// Settings > Command Line. Debug and isolated builds never touch a real shim.
pub fn repair_in_background() {
    if cfg!(debug_assertions) || std::env::var_os("CAP_GPUI_APP_DATA_DIR").is_some() {
        return;
    }
    std::thread::spawn(|| {
        let _ = repair_after_rename();
    });
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::fs::symlink;

    struct Layout {
        _directory: tempfile::TempDir,
        shim: PathBuf,
        alias: PathBuf,
        target: PathBuf,
    }

    fn layout() -> Layout {
        let directory = tempfile::tempdir().unwrap();
        let shim = directory.path().join("cap");
        let target = directory.path().join(CLI_BINARY_STEM);
        fs::write(&target, b"binary").unwrap();
        symlink(&target, &shim).unwrap();
        Layout {
            alias: alias_path(&shim),
            _directory: directory,
            shim,
            target,
        }
    }

    #[test]
    fn alias_sits_beside_the_shim() {
        assert_eq!(
            alias_path(Path::new("/bin/cap.cmd")),
            Path::new(&format!("/bin/{}.cmd", fork_brand::CLI_NAME))
        );
    }

    #[test]
    fn alias_is_linked_and_repointed() {
        let paths = layout();
        link_alias(&paths.shim, &paths.alias, &paths.target).unwrap();
        assert!(alias_points_to(&paths.alias, &paths.shim, &paths.target));

        let moved = paths.target.with_file_name("moved");
        fs::create_dir(&moved).unwrap();
        let moved = moved.join(CLI_BINARY_STEM);
        fs::write(&moved, b"binary").unwrap();
        assert!(!alias_points_to(&paths.alias, &paths.shim, &moved));
        link_alias(&paths.shim, &paths.alias, &moved).unwrap();
        assert!(alias_points_to(&paths.alias, &paths.shim, &moved));
    }

    #[test]
    fn foreign_files_are_never_replaced_or_removed() {
        let paths = layout();
        fs::write(&paths.alias, b"someone else's tool").unwrap();
        let error = link_alias(&paths.shim, &paths.alias, &paths.target).unwrap_err();
        assert!(error.contains("not managed"), "{error}");
        unlink_alias(&paths.shim, &paths.alias).unwrap();
        assert_eq!(fs::read(&paths.alias).unwrap(), b"someone else's tool");
    }

    #[test]
    fn unlink_removes_only_the_alias() {
        let paths = layout();
        link_alias(&paths.shim, &paths.alias, &paths.target).unwrap();
        unlink_alias(&paths.shim, &paths.alias).unwrap();
        assert!(!present(&paths.alias));
        assert!(present(&paths.shim));
    }

    #[test]
    fn a_script_shim_is_copied() {
        let directory = tempfile::tempdir().unwrap();
        let shim = directory.path().join("cap");
        fs::write(&shim, b"#!/bin/sh\n").unwrap();
        let alias = alias_path(&shim);
        link_alias(&shim, &alias, &directory.path().join("unused")).unwrap();
        assert_eq!(fs::read(&alias).unwrap(), b"#!/bin/sh\n");
        assert!(alias_is_managed(&alias, &shim));
    }
}
