//! Shared logic for installing the `cap` CLI shim onto the user's `PATH`.
//!
//! Used by both the desktop app (via Tauri commands) and the CLI itself
//! (`cap desktop status|install-cli|uninstall-cli`) so the two surfaces never
//! diverge. The shim points at the `cap-cli` binary that sits next to the
//! current executable, which is the bundled CLI for both callers.

use serde::Serialize;
use std::{
    env, fs,
    path::{Path, PathBuf},
};

const INSTALL_DIR_NAME: &str = ".cap/bin";

#[cfg(windows)]
const SHIM_NAME: &str = "cap.cmd";
#[cfg(not(windows))]
const SHIM_NAME: &str = "cap";

#[cfg(windows)]
const CLI_BINARY_NAME: &str = "cap-cli.exe";
#[cfg(not(windows))]
const CLI_BINARY_NAME: &str = "cap-cli";

#[derive(Clone, Serialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub struct CliInstallStatus {
    pub install_dir: String,
    pub shim_path: String,
    pub target_path: String,
    pub installed: bool,
    pub on_path: bool,
    pub conflict: Option<String>,
    pub path_entry: String,
    pub shell_command: String,
    /// Whether the install dir is persisted to the user's shell PATH config (profile/registry),
    /// so `cap` will be available in a new terminal even though it is not on the current PATH.
    pub path_configured: bool,
}

fn home_dir() -> Result<PathBuf, String> {
    dirs::home_dir().ok_or_else(|| "Could not determine home directory".to_string())
}

fn install_dir() -> Result<PathBuf, String> {
    let home = home_dir()?;
    let cap_bin = home.join(INSTALL_DIR_NAME);
    let local_bin = home.join(".local/bin");

    // Prefer whichever candidate already holds a Cap-managed shim, so `status` and `install` agree
    // regardless of whether they run from the GUI or a terminal (whose PATHs differ). Without this,
    // a shim the web installer placed in ~/.local/bin reads as "not installed" from a GUI launch.
    if let Ok(target) = target_path() {
        for candidate in [&cap_bin, &local_bin] {
            if shim_points_to(&candidate.join(SHIM_NAME), &target).unwrap_or(false) {
                return Ok(candidate.clone());
            }
        }
    }

    if path_is_present(&cap_bin.join(SHIM_NAME)) || cfg!(windows) {
        return Ok(cap_bin);
    }

    if path_contains_install_dir(&local_bin) {
        return Ok(local_bin);
    }

    Ok(cap_bin)
}

fn shim_path() -> Result<PathBuf, String> {
    Ok(install_dir()?.join(SHIM_NAME))
}

fn target_path() -> Result<PathBuf, String> {
    let exe = env::current_exe().map_err(|e| format!("Could not locate Cap executable: {e}"))?;
    let dir = exe
        .parent()
        .ok_or_else(|| "Could not locate Cap executable directory".to_string())?;
    Ok(dir.join(CLI_BINARY_NAME))
}

fn display_path(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

fn path_is_present(path: &Path) -> bool {
    fs::symlink_metadata(path).is_ok()
}

fn path_contains_install_dir(install_dir: &Path) -> bool {
    let Some(path) = env::var_os("PATH") else {
        return false;
    };

    env::split_paths(&path).any(|entry| entry == install_dir)
}

#[cfg(unix)]
fn shim_points_to(shim_path: &Path, target_path: &Path) -> Result<bool, String> {
    match fs::read_link(shim_path) {
        Ok(link) => Ok(link == target_path),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(err) => Err(format!("Could not read CLI shim: {err}")),
    }
}

#[cfg(windows)]
fn shim_points_to(shim_path: &Path, target_path: &Path) -> Result<bool, String> {
    let contents = match fs::read_to_string(shim_path) {
        Ok(contents) => contents,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(err) => return Err(format!("Could not read CLI shim: {err}")),
    };

    Ok(contents.contains(&display_path(target_path)))
}

fn shell_command(install_dir: &Path) -> String {
    let install_dir = display_path(install_dir);

    if cfg!(windows) {
        // Persist to the user PATH (the session-only `$env:Path = ...` form did not survive
        // closing the terminal). Takes effect in new shells, matching the macOS profile flow.
        format!(
            r#"[Environment]::SetEnvironmentVariable("Path", [Environment]::GetEnvironmentVariable("Path", "User") + ";{install_dir}", "User")"#
        )
    } else {
        format!(r#"export PATH="{install_dir}:$PATH""#)
    }
}

pub fn status() -> Result<CliInstallStatus, String> {
    let install_dir = install_dir()?;
    let shim_path = shim_path()?;
    let target_path = target_path()?;
    let target_exists = target_path.exists();
    let shim_exists = path_is_present(&shim_path);
    let installed = target_exists && shim_points_to(&shim_path, &target_path)?;
    let conflict = if shim_exists && !installed {
        Some(format!(
            "{} already exists and is not managed by Cap",
            display_path(&shim_path)
        ))
    } else if !target_exists {
        Some(format!(
            "Bundled CLI binary not found at {}",
            display_path(&target_path)
        ))
    } else {
        None
    };

    let on_path = path_contains_install_dir(&install_dir);

    Ok(CliInstallStatus {
        install_dir: display_path(&install_dir),
        shim_path: display_path(&shim_path),
        target_path: display_path(&target_path),
        installed,
        on_path,
        conflict,
        path_entry: display_path(&install_dir),
        shell_command: shell_command(&install_dir),
        path_configured: path_persisted(&install_dir, on_path),
    })
}

#[cfg(unix)]
fn write_shim(shim_path: &Path, target_path: &Path) -> Result<(), String> {
    std::os::unix::fs::symlink(target_path, shim_path)
        .map_err(|e| format!("Could not create CLI symlink: {e}"))
}

#[cfg(windows)]
fn write_shim(shim_path: &Path, target_path: &Path) -> Result<(), String> {
    let target = display_path(target_path);
    let contents = format!(
        r#"@echo off
"{target}" %*
"#
    );
    fs::write(shim_path, contents).map_err(|e| format!("Could not write CLI shim: {e}"))
}

pub fn install() -> Result<CliInstallStatus, String> {
    let install_dir = install_dir()?;
    let shim_path = shim_path()?;
    let target_path = target_path()?;

    if !target_path.exists() {
        return Err(format!(
            "Bundled CLI binary not found at {}",
            display_path(&target_path)
        ));
    }

    fs::create_dir_all(&install_dir).map_err(|e| format!("Could not create CLI directory: {e}"))?;

    if path_is_present(&shim_path) {
        if !shim_points_to(&shim_path, &target_path)? {
            return Err(format!(
                "{} already exists and is not managed by Cap",
                display_path(&shim_path)
            ));
        }

        fs::remove_file(&shim_path).map_err(|e| format!("Could not replace CLI shim: {e}"))?;
    }

    write_shim(&shim_path, &target_path)?;

    let mut status = status()?;
    if !status.on_path && ensure_path_persisted(&install_dir) {
        status.path_configured = true;
    }
    Ok(status)
}

/// Persist `install_dir` to the user's PATH (shell profile on unix, User registry on Windows) so a
/// freshly opened terminal can run `cap`. Idempotent; honours `CAP_NO_MODIFY_PATH`. Returns whether
/// the directory is now persisted. Best-effort: a failure just falls back to the printed command.
#[cfg(unix)]
fn ensure_path_persisted(install_dir: &Path) -> bool {
    if env::var_os("CAP_NO_MODIFY_PATH").is_some() {
        return false;
    }
    let Some(home) = dirs::home_dir() else {
        return false;
    };
    let needle = display_path(install_dir);
    if profile_mentions_dir(&home, &needle) {
        return true;
    }
    let shell = env::var("SHELL").unwrap_or_default();
    let shell_name = Path::new(&shell)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("");
    append_path_export(&shell_profile(&home, shell_name), &needle)
}

#[cfg(windows)]
fn ensure_path_persisted(install_dir: &Path) -> bool {
    if env::var_os("CAP_NO_MODIFY_PATH").is_some() {
        return false;
    }
    let dir = display_path(install_dir);
    // Mirror the web installer: prepend to the persistent User PATH (idempotent) and broadcast the
    // change via the same Environment API the .ps1 script uses.
    let script = format!(
        "$d = '{dir}'; \
         $u = [Environment]::GetEnvironmentVariable('Path', 'User'); \
         $e = if ($u) {{ $u -split ';' }} else {{ @() }}; \
         if ($e -notcontains $d) {{ \
         $n = if ($u) {{ \"$d;$u\" }} else {{ $d }}; \
         [Environment]::SetEnvironmentVariable('Path', $n, 'User') }}"
    );
    std::process::Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", &script])
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}

#[cfg(unix)]
fn path_persisted(install_dir: &Path, on_path: bool) -> bool {
    on_path
        || dirs::home_dir()
            .is_some_and(|home| profile_mentions_dir(&home, &display_path(install_dir)))
}

#[cfg(windows)]
fn path_persisted(_install_dir: &Path, on_path: bool) -> bool {
    on_path
}

#[cfg(unix)]
fn shell_profile(home: &Path, shell_name: &str) -> PathBuf {
    match shell_name {
        "zsh" => home.join(".zshrc"),
        "bash" => home.join(".bashrc"),
        "" if home.join(".zshrc").exists() => home.join(".zshrc"),
        _ => home.join(".profile"),
    }
}

#[cfg(unix)]
fn profile_mentions_dir(home: &Path, needle: &str) -> bool {
    [".zshrc", ".bashrc", ".bash_profile", ".profile"]
        .iter()
        .any(|file| fs::read_to_string(home.join(file)).is_ok_and(|c| c.contains(needle)))
}

#[cfg(unix)]
fn append_path_export(profile: &Path, install_dir: &str) -> bool {
    use std::io::Write;
    let line = format!("export PATH=\"{install_dir}:$PATH\"");
    fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(profile)
        .and_then(|mut file| writeln!(file, "\n# Added by Cap\n{line}"))
        .is_ok()
}

pub fn uninstall() -> Result<CliInstallStatus, String> {
    let shim_path = shim_path()?;
    let target_path = target_path()?;

    if shim_points_to(&shim_path, &target_path)? {
        fs::remove_file(&shim_path).map_err(|e| format!("Could not remove CLI shim: {e}"))?;
    }

    status()
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    #[test]
    fn shell_profile_selection() {
        let home = Path::new("/home/u");
        assert_eq!(shell_profile(home, "zsh"), home.join(".zshrc"));
        assert_eq!(shell_profile(home, "bash"), home.join(".bashrc"));
        assert_eq!(shell_profile(home, "fish"), home.join(".profile"));
    }

    #[test]
    fn append_is_detectable_and_caller_dedupes() {
        let home = tempfile::tempdir().unwrap();
        let profile = home.path().join(".zshrc");
        let install_dir = "/home/u/.cap/bin";

        assert!(!profile_mentions_dir(home.path(), install_dir));
        assert!(append_path_export(&profile, install_dir));
        assert!(profile_mentions_dir(home.path(), install_dir));

        // ensure_path_persisted checks profile_mentions_dir before appending, so a re-install does
        // not duplicate the entry; verify a second append would be the only way to duplicate.
        let contents = std::fs::read_to_string(&profile).unwrap();
        assert_eq!(contents.matches(install_dir).count(), 1);
    }
}
