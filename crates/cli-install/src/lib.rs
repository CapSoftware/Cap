//! Shared logic for installing the `cap` CLI shim onto the user's `PATH`.
//!
//! Used by both the desktop app (via Tauri commands) and the CLI itself
//! (`cap desktop status|install-cli|uninstall-cli`) so the two surfaces never
//! diverge. The shim points at the `cap-cli` binary that sits next to the
//! current executable, which is the bundled CLI for both callers.

use serde::Serialize;
#[cfg(unix)]
use std::ffi::OsStr;
use std::{
    env, fs,
    path::{Path, PathBuf},
};

const CAP_DIR_NAME: &str = ".cap";
const BIN_DIR_NAME: &str = "bin";
const CLI_BINARY_STEM: &str = "cap-cli";

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
    let cap_bin = home.join(CAP_DIR_NAME).join(BIN_DIR_NAME);
    let local_bin = home.join(".local/bin");

    // Prefer whichever candidate already holds a Cap-managed shim, so `status` and `install` agree
    // regardless of whether they run from the GUI or a terminal (whose PATHs differ). Without this,
    // a shim the web installer placed in ~/.local/bin reads as "not installed" from a GUI launch.
    // Also match a shim pointing at a different/older Cap install so `install` repoints it in place
    // rather than leaving it stranded and creating a second shim elsewhere.
    if let Ok(target) = target_path() {
        for candidate in [&cap_bin, &local_bin] {
            let shim = candidate.join(SHIM_NAME);
            if shim_points_to(&shim, &target).unwrap_or(false) || shim_is_cap_managed(&shim) {
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
    // When `cap` runs through the installed shim (a symlink), macOS `current_exe()` returns the
    // symlink path; resolve it to the real binary so the sibling `cap-cli` resolves to the bundled
    // one rather than a non-existent path next to the shim (which made status() report installed:false
    // for every `cap desktop` subcommand). Mirrors doctor.rs's VersionInfo::collect().
    let exe = resolve_path_for_target_lookup(exe);
    let dir = exe
        .parent()
        .ok_or_else(|| "Could not locate Cap executable directory".to_string())?;

    for candidate in cli_binary_candidates(dir) {
        if candidate.exists() {
            return Ok(resolve_path_for_target_lookup(candidate));
        }
    }

    Ok(dir.join(CLI_BINARY_NAME))
}

#[cfg(windows)]
fn resolve_path_for_target_lookup(path: PathBuf) -> PathBuf {
    path
}

#[cfg(not(windows))]
fn resolve_path_for_target_lookup(path: PathBuf) -> PathBuf {
    fs::canonicalize(&path).unwrap_or(path)
}

fn cli_binary_candidates(dir: &Path) -> Vec<PathBuf> {
    cli_binary_candidates_for_triple(dir, current_target_triple())
}

fn cli_binary_candidates_for_triple(dir: &Path, target_triple: Option<&str>) -> Vec<PathBuf> {
    let mut names = vec![CLI_BINARY_NAME.to_string()];
    if let Some(target_triple) = target_triple {
        names.push(target_specific_cli_binary_name(target_triple));
    }

    let dirs = [
        dir.to_path_buf(),
        dir.join("../MacOS"),
        dir.join("../Resources"),
    ];
    let mut candidates = Vec::new();
    for dir in dirs {
        for name in &names {
            candidates.push(dir.join(name));
        }
    }
    candidates
}

fn target_specific_cli_binary_name(target_triple: &str) -> String {
    format!(
        "{CLI_BINARY_STEM}-{target_triple}{}",
        exe_suffix_for_target(target_triple)
    )
}

fn exe_suffix_for_target(target_triple: &str) -> &'static str {
    if target_triple.contains("windows") {
        ".exe"
    } else {
        ""
    }
}

fn current_target_triple() -> Option<&'static str> {
    if cfg!(all(
        target_os = "windows",
        target_arch = "x86_64",
        target_env = "msvc"
    )) {
        Some("x86_64-pc-windows-msvc")
    } else if cfg!(all(
        target_os = "windows",
        target_arch = "aarch64",
        target_env = "msvc"
    )) {
        Some("aarch64-pc-windows-msvc")
    } else if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
        Some("aarch64-apple-darwin")
    } else if cfg!(all(target_os = "macos", target_arch = "x86_64")) {
        Some("x86_64-apple-darwin")
    } else if cfg!(all(target_os = "linux", target_arch = "x86_64")) {
        Some("x86_64-unknown-linux-gnu")
    } else if cfg!(all(target_os = "linux", target_arch = "aarch64")) {
        Some("aarch64-unknown-linux-gnu")
    } else {
        None
    }
}

#[cfg(unix)]
fn cli_binary_file_name_is_cap_managed(name: &OsStr) -> bool {
    if name == CLI_BINARY_NAME {
        return true;
    }

    let Some(name) = name.to_str() else {
        return false;
    };

    current_target_triple().is_some_and(|target_triple| {
        name.eq_ignore_ascii_case(&target_specific_cli_binary_name(target_triple))
    })
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
        // The web installer may symlink to a literal app path that the desktop's canonicalized
        // current_exe spells differently; compare the resolved paths too so a Cap-managed shim is still
        // recognized by status/install/uninstall.
        Ok(link) => Ok(link == target_path || same_file(&link, target_path)),
        // A non-symlink regular file (read_link → InvalidInput) or a missing path is simply not a
        // Cap-managed shim — let the caller report that as a conflict rather than surfacing a raw error.
        Err(err)
            if matches!(
                err.kind(),
                std::io::ErrorKind::NotFound | std::io::ErrorKind::InvalidInput
            ) =>
        {
            Ok(false)
        }
        Err(err) => Err(format!("Could not read CLI shim: {err}")),
    }
}

#[cfg(unix)]
fn same_file(a: &Path, b: &Path) -> bool {
    match (fs::canonicalize(a), fs::canonicalize(b)) {
        (Ok(a), Ok(b)) => a == b,
        _ => false,
    }
}

#[cfg(windows)]
fn shim_points_to(shim_path: &Path, target_path: &Path) -> Result<bool, String> {
    let contents = match fs::read(shim_path) {
        Ok(contents) => contents,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(err) => return Err(format!("Could not read CLI shim: {err}")),
    };

    let target = windows_command_path(target_path);
    Ok(windows_shim_target(&contents).is_some_and(|shim_target| {
        windows_shim_target_matches(shim_target, &target, |name| env::var(name).ok())
    }))
}

#[cfg(unix)]
fn shim_is_cap_managed(shim_path: &Path) -> bool {
    match fs::read_link(shim_path) {
        Ok(link) => link
            .file_name()
            .is_some_and(cli_binary_file_name_is_cap_managed),
        Err(_) => false,
    }
}

#[cfg(windows)]
fn shim_is_cap_managed(shim_path: &Path) -> bool {
    fs::read(shim_path).is_ok_and(|contents| windows_shim_target(&contents).is_some())
}

#[cfg(any(windows, test))]
fn windows_shim_target(contents: &[u8]) -> Option<&[u8]> {
    let contents = contents.strip_prefix(b"\xef\xbb\xbf").unwrap_or(contents);
    let mut lines = contents.split(|byte| *byte == b'\n');
    if !trim_ascii_whitespace(lines.next()?).eq_ignore_ascii_case(b"@echo off") {
        return None;
    }

    let command = trim_ascii_whitespace(lines.next()?);
    if lines.any(|line| !trim_ascii_whitespace(line).is_empty()) {
        return None;
    }

    let target = command.strip_prefix(b"\"")?.strip_suffix(b"\" %*")?;
    if windows_cli_binary_file_name_is_cap_managed(windows_path_file_name(target)) {
        Some(target)
    } else {
        None
    }
}

#[cfg(any(windows, test))]
fn windows_path_file_name(path: &[u8]) -> &[u8] {
    path.rsplit(|byte| *byte == b'\\' || *byte == b'/')
        .next()
        .unwrap_or(path)
}

#[cfg(any(windows, test))]
fn windows_cli_binary_file_name_is_cap_managed(name: &[u8]) -> bool {
    name.eq_ignore_ascii_case(b"cap-cli.exe")
        || name.eq_ignore_ascii_case(b"cap-cli-x86_64-pc-windows-msvc.exe")
        || name.eq_ignore_ascii_case(b"cap-cli-aarch64-pc-windows-msvc.exe")
}

#[cfg(any(windows, test))]
fn windows_command_path(path: &Path) -> String {
    let path = display_path(path);

    if let Some(rest) = path.strip_prefix("\\\\?\\UNC\\") {
        return format!("\\\\{rest}");
    }

    if let Some(rest) = path.strip_prefix("\\\\?\\") {
        return rest.to_string();
    }

    path
}

#[cfg(any(windows, test))]
fn windows_shim_target_matches<F>(shim_target: &[u8], target: &str, env_value: F) -> bool
where
    F: FnMut(&str) -> Option<String>,
{
    if shim_target.eq_ignore_ascii_case(target.as_bytes()) {
        return true;
    }

    let Ok(shim_target) = std::str::from_utf8(shim_target) else {
        return false;
    };

    windows_expand_env_prefix(shim_target, env_value)
        .is_some_and(|expanded| expanded.eq_ignore_ascii_case(target))
}

#[cfg(any(windows, test))]
fn windows_expand_env_prefix<F>(target: &str, mut env_value: F) -> Option<String>
where
    F: FnMut(&str) -> Option<String>,
{
    let rest = target.strip_prefix('%')?;
    let (name, suffix) = rest.split_once('%')?;
    if name.is_empty() {
        return None;
    }

    env_value(name).map(|value| format!("{value}{suffix}"))
}

#[cfg(any(windows, test))]
fn windows_env_prefixed_path<F>(target: &str, mut env_value: F) -> Option<String>
where
    F: FnMut(&str) -> Option<String>,
{
    for name in ["LOCALAPPDATA", "ProgramFiles", "ProgramFiles(x86)"] {
        let Some(value) = env_value(name) else {
            continue;
        };
        let Some(suffix) = strip_ascii_prefix(target, &value) else {
            continue;
        };
        if suffix.is_empty() || suffix.starts_with('\\') || suffix.starts_with('/') {
            return Some(format!("%{name}%{suffix}"));
        }
    }

    None
}

#[cfg(any(windows, test))]
fn strip_ascii_prefix<'a>(value: &'a str, prefix: &str) -> Option<&'a str> {
    let head = value.get(..prefix.len())?;
    let tail = value.get(prefix.len()..)?;
    head.eq_ignore_ascii_case(prefix).then_some(tail)
}

#[cfg(any(windows, test))]
fn trim_ascii_whitespace(mut value: &[u8]) -> &[u8] {
    while value.first().is_some_and(|byte| byte.is_ascii_whitespace()) {
        value = &value[1..];
    }

    while value.last().is_some_and(|byte| byte.is_ascii_whitespace()) {
        value = &value[..value.len() - 1];
    }

    value
}

fn shell_command(install_dir: &Path) -> String {
    let install_dir = display_path(install_dir);

    if cfg!(windows) {
        let install_dir = install_dir.replace('\'', "''");
        format!(
            r#"powershell -NoProfile -Command "[Environment]::SetEnvironmentVariable('Path', [Environment]::GetEnvironmentVariable('Path', 'User') + ';{install_dir}', 'User')""#
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
    let conflict = if shim_exists && !installed && !shim_is_cap_managed(&shim_path) {
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
    let target = windows_command_path(target_path);
    let target = windows_env_prefixed_path(&target, |name| env::var(name).ok()).unwrap_or(target);
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
        // Repoint our own shim and any other Cap-managed shim (e.g. one left by a previous or moved
        // install, or by the web installer); only refuse to clobber a genuinely foreign file.
        if !shim_points_to(&shim_path, &target_path)? && !shim_is_cap_managed(&shim_path) {
            return Err(format!(
                "{} already exists and is not managed by Cap",
                display_path(&shim_path)
            ));
        }

        // The file may vanish between the check above and here (e.g. a concurrent uninstall); a
        // NotFound means the goal — no stale shim in the way — is already met, so don't fail on it.
        match fs::remove_file(&shim_path) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(format!("Could not replace CLI shim: {e}")),
        }
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
    // Escape single quotes for the single-quoted PowerShell string literal below; a profile path
    // containing an apostrophe (e.g. C:\Users\O'Brien) would otherwise break or alter the script.
    let dir = display_path(install_dir).replace('\'', "''");
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
    let mut command = powershell_command();
    command
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
fn path_persisted(install_dir: &Path, on_path: bool) -> bool {
    // `ensure_path_persisted` writes to the User registry PATH, which the current process's PATH
    // env var does not reflect until a new shell starts — so checking only `on_path` reports
    // pathConfigured:false right after a successful install. Consult the persisted User PATH too.
    on_path || windows_user_path_contains(install_dir)
}

#[cfg(windows)]
fn windows_user_path_contains(install_dir: &Path) -> bool {
    let mut command = powershell_command();
    let Ok(output) = command
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "[Environment]::GetEnvironmentVariable('Path', 'User')",
        ])
        .output()
    else {
        return false;
    };
    if !output.status.success() {
        return false;
    }
    let needle = display_path(install_dir);
    let needle = needle.trim();
    String::from_utf8_lossy(&output.stdout)
        .split(';')
        .any(|entry| entry.trim().eq_ignore_ascii_case(needle))
}

#[cfg(windows)]
fn powershell_command() -> std::process::Command {
    use std::os::windows::process::CommandExt;

    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    let mut command = std::process::Command::new("powershell");
    command.creation_flags(CREATE_NO_WINDOW);
    command
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

    #[test]
    fn cap_managed_shim_detection() {
        let dir = tempfile::tempdir().unwrap();
        let shim = dir.path().join(SHIM_NAME);

        // A symlink to a cap-cli binary is Cap-managed even when it points at a different/moved install
        // (the target need not exist — a dangling link from a moved app still counts).
        std::os::unix::fs::symlink("/elsewhere/Cap.app/Contents/MacOS/cap-cli", &shim).unwrap();
        assert!(shim_is_cap_managed(&shim));

        if let Some(target_triple) = current_target_triple() {
            fs::remove_file(&shim).unwrap();
            std::os::unix::fs::symlink(
                format!(
                    "/elsewhere/Cap.app/Contents/MacOS/{}",
                    target_specific_cli_binary_name(target_triple)
                ),
                &shim,
            )
            .unwrap();
            assert!(shim_is_cap_managed(&shim));
        }

        // A symlink to anything else is not Cap-managed.
        fs::remove_file(&shim).unwrap();
        std::os::unix::fs::symlink("/bin/ls", &shim).unwrap();
        assert!(!shim_is_cap_managed(&shim));

        // A regular (non-symlink) file is not Cap-managed, so install refuses to clobber it.
        fs::remove_file(&shim).unwrap();
        fs::write(&shim, b"#!/bin/sh\n").unwrap();
        assert!(!shim_is_cap_managed(&shim));

        // A missing path is not Cap-managed.
        fs::remove_file(&shim).unwrap();
        assert!(!shim_is_cap_managed(&shim));
    }

    #[test]
    fn cli_binary_candidates_include_tauri_sidecar_names() {
        let dir = Path::new("/Applications/Cap.app/Contents/MacOS");
        let candidates = cli_binary_candidates_for_triple(dir, Some("x86_64-pc-windows-msvc"));

        assert!(candidates.contains(&dir.join("cap-cli-x86_64-pc-windows-msvc.exe")));
        assert!(candidates.contains(&dir.join("../Resources/cap-cli-x86_64-pc-windows-msvc.exe")));
    }

    #[test]
    fn windows_cap_cmd_detection_requires_generated_shape() {
        assert_eq!(
            windows_shim_target(b"@echo off\n\"C:\\Program Files\\Cap\\cap-cli.exe\" %*\n"),
            Some(&b"C:\\Program Files\\Cap\\cap-cli.exe"[..])
        );
        assert_eq!(
            windows_shim_target(b"@echo off\n\"C:/Program Files/Cap/cap-cli.exe\" %*\n"),
            Some(&b"C:/Program Files/Cap/cap-cli.exe"[..])
        );
        assert!(windows_shim_target(b"@echo off\ncap-cli.exe %*\n").is_none());
        assert!(windows_shim_target(b"@echo off\n\"C:\\Tools\\other.exe\" %*\n").is_none());
        assert!(
            windows_shim_target(b"@echo off\nrem cap-cli.exe lives somewhere else\n").is_none()
        );
        assert!(
            windows_shim_target(
                b"@echo off\n\"C:\\Program Files\\Cap\\cap-cli.exe\" %*\necho done\n"
            )
            .is_none()
        );
    }

    #[test]
    fn windows_cap_cmd_detection_handles_tauri_sidecar_targets() {
        let target = b"C:\\Program Files\\Cap\\cap-cli-x86_64-pc-windows-msvc.exe";

        assert_eq!(
            windows_shim_target(
                b"@echo off\n\"C:\\Program Files\\Cap\\cap-cli-x86_64-pc-windows-msvc.exe\" %*\n"
            ),
            Some(&target[..])
        );
        assert!(windows_cli_binary_file_name_is_cap_managed(
            b"CAP-CLI-X86_64-PC-WINDOWS-MSVC.EXE"
        ));
        assert!(!windows_cli_binary_file_name_is_cap_managed(
            b"cap-cli-.exe"
        ));
    }

    #[test]
    fn windows_command_path_strips_verbatim_prefixes() {
        assert_eq!(
            windows_command_path(Path::new(
                "\\\\?\\C:\\Users\\Renee\\AppData\\Local\\Programs\\Cap\\cap-cli.exe"
            )),
            "C:\\Users\\Renee\\AppData\\Local\\Programs\\Cap\\cap-cli.exe"
        );
        assert_eq!(
            windows_command_path(Path::new("\\\\?\\UNC\\server\\share\\Cap\\cap-cli.exe")),
            "\\\\server\\share\\Cap\\cap-cli.exe"
        );
    }

    #[test]
    fn windows_cap_cmd_detection_handles_web_installer_targets() {
        let target = b"%LOCALAPPDATA%\\Programs\\Cap\\cap-cli.exe";
        assert_eq!(
            windows_shim_target(
                b"\xef\xbb\xbf@echo off\r\n\"%LOCALAPPDATA%\\Programs\\Cap\\cap-cli.exe\" %*\r\n"
            ),
            Some(&target[..])
        );
        assert!(windows_shim_target_matches(
            target,
            "C:\\Users\\Renee\\AppData\\Local\\Programs\\Cap\\cap-cli.exe",
            |name| match name {
                "LOCALAPPDATA" => Some("C:\\Users\\Renee\\AppData\\Local".to_string()),
                _ => None,
            },
        ));
        assert_eq!(
            windows_env_prefixed_path(
                "C:\\Users\\Renee\\AppData\\Local\\Programs\\Cap\\cap-cli.exe",
                |name| match name {
                    "LOCALAPPDATA" => Some("C:\\Users\\Renee\\AppData\\Local".to_string()),
                    _ => None,
                },
            )
            .as_deref(),
            Some("%LOCALAPPDATA%\\Programs\\Cap\\cap-cli.exe")
        );
        assert_eq!(
            windows_shim_target(
                b"@echo off\n\"C:\\Users\\Ren\xe9\\AppData\\Local\\Programs\\Cap\\cap-cli.exe\" %*\n"
            ),
            Some(&b"C:\\Users\\Ren\xe9\\AppData\\Local\\Programs\\Cap\\cap-cli.exe"[..])
        );
    }
}
