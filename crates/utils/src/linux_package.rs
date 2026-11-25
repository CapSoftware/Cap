use std::{
    env,
    ffi::{OsStr, OsString},
    fs,
    path::{Path, PathBuf},
};

fn append_alsa_config(config: &Path, existing: Option<&OsStr>) -> Option<OsString> {
    let config_bytes = config.as_os_str().as_encoded_bytes();
    if config_bytes.contains(&b':') {
        return None;
    }
    let existing = existing
        .filter(|value| !value.is_empty())
        .unwrap_or(OsStr::new("/usr/share/alsa/alsa.conf"));
    if existing
        .as_encoded_bytes()
        .split(|byte| *byte == b':')
        .any(|path| path == config_bytes)
    {
        return None;
    }
    let mut paths = existing.to_os_string();
    if !paths.is_empty() {
        paths.push(":");
    }
    paths.push(config);
    Some(paths)
}

fn appimage_alsa_config_path() -> Option<OsString> {
    let executable = env::current_exe().ok()?;
    let appimage = env::var_os("APPIMAGE").map(PathBuf::from);
    let appdir = env::var_os("APPDIR").map(PathBuf::from)?;
    if package_format(&executable, None, appimage.as_deref(), Some(&appdir), None)
        != PackageFormat::AppImage
    {
        return None;
    }
    appimage_alsa_config(
        &appdir,
        env::var_os("ALSA_CONFIG_PATH").as_deref(),
        |path| path.is_file(),
    )
}

/// The AppImage's ALSA configuration. With no `ALSA_CONFIG_PATH` of the
/// user's it is one file that includes the distribution's `alsa.conf`
/// itself, because openSUSE's alsa-lib ignores an `ALSA_CONFIG_PATH` that is
/// a list of files; a user's own list keeps Cap's plugin appended to it.
fn appimage_alsa_config(
    appdir: &Path,
    existing: Option<&OsStr>,
    is_file: impl Fn(&Path) -> bool,
) -> Option<OsString> {
    let config = appdir.join("usr/lib/cap/alsa-pulse.conf");
    let standalone = appdir.join("usr/lib/cap/alsa-pulse-appimage.conf");
    let plugin = appdir.join("usr/lib/alsa-lib/libasound_module_pcm_pulse.so");
    if !is_file(&plugin) {
        return None;
    }
    let existing = existing.filter(|value| !value.is_empty());
    if existing.is_none()
        && is_file(&standalone)
        && !standalone.as_os_str().as_encoded_bytes().contains(&b':')
    {
        return Some(standalone.into_os_string());
    }
    if !is_file(&config) {
        return None;
    }
    append_alsa_config(&config, existing)
}

const PULSE_PLUGIN: &str = "libasound_module_pcm_pulse.so";
const RPM_ALSA_CONFIG: &str = "/usr/lib/cap/alsa-pulse.conf";
const RPM_PULSE_PLUGIN: &str = "/usr/lib/cap/alsa-lib/libasound_module_pcm_pulse.so";
const RPM_HOST_PLUGIN_DIRECTORIES: [&str; 2] = ["/usr/lib64/alsa-lib", "/usr/lib/alsa-lib"];

/// The ALSA configuration for Cap's own pulse plugin, when this install
/// needs it: always in the AppImage, and in the rpm only on hosts without a
/// pulse plugin of their own and without an `ALSA_CONFIG_PATH` of the user's.
pub fn bundled_alsa_config_path() -> Option<OsString> {
    appimage_alsa_config_path().or_else(rpm_alsa_config_path)
}

fn rpm_alsa_config_path() -> Option<OsString> {
    let executable = env::current_exe().ok()?;
    let marker = fs::read_to_string(
        executable
            .parent()?
            .parent()?
            .join("lib/cap/package-format"),
    )
    .ok()?;
    rpm_alsa_config(
        &marker,
        env::var_os("ALSA_CONFIG_PATH").as_deref(),
        |path| path.is_file(),
    )
    .map(OsString::from)
}

/// The rpm's configuration includes the distribution's `alsa.conf` itself:
/// openSUSE's alsa-lib ignores an `ALSA_CONFIG_PATH` that is a list of files.
fn rpm_alsa_config(
    marker: &str,
    existing: Option<&OsStr>,
    is_file: impl Fn(&Path) -> bool,
) -> Option<&'static Path> {
    if marker.trim() != "rpm"
        || existing.is_some_and(|value| !value.is_empty())
        || RPM_HOST_PLUGIN_DIRECTORIES
            .iter()
            .any(|directory| is_file(&Path::new(directory).join(PULSE_PLUGIN)))
    {
        return None;
    }
    let config = Path::new(RPM_ALSA_CONFIG);
    (is_file(config) && is_file(Path::new(RPM_PULSE_PLUGIN))).then_some(config)
}

#[derive(Debug, PartialEq, Eq)]
enum PackageFormat {
    Deb,
    AppImage,
    ExtractedAppImage,
    Rpm,
    Arch,
    Unknown,
}

fn package_format(
    executable: &Path,
    marker: Option<&str>,
    appimage: Option<&Path>,
    appdir: Option<&Path>,
    debian_files: Option<&str>,
) -> PackageFormat {
    if appimage.is_some_and(Path::is_absolute)
        && appdir
            .is_some_and(|directory| directory.is_absolute() && executable.starts_with(directory))
    {
        return PackageFormat::AppImage;
    }

    match marker.map(str::trim) {
        Some("deb") => PackageFormat::Deb,
        Some("rpm") => PackageFormat::Rpm,
        Some("arch") => PackageFormat::Arch,
        Some("appimage") => PackageFormat::ExtractedAppImage,
        None if debian_files
            .is_some_and(|files| files.lines().any(|file| Path::new(file) == executable)) =>
        {
            PackageFormat::Deb
        }
        _ => PackageFormat::Unknown,
    }
}

fn target_for(format: PackageFormat, arch: &str) -> Result<String, String> {
    let suffix = match format {
        PackageFormat::Deb => "deb",
        PackageFormat::AppImage => "appimage",
        PackageFormat::Rpm => {
            return Err("Update Cap through your RPM package manager or install the latest RPM from cap.so/download.".into());
        }
        PackageFormat::Arch => {
            return Err("Update Cap through your Arch package manager or install the latest Arch package from cap.so/download.".into());
        }
        PackageFormat::ExtractedAppImage => {
            return Err("Launch the original Cap AppImage to use automatic updates. An extracted AppImage cannot update itself.".into());
        }
        PackageFormat::Unknown => {
            return Err("Automatic updates are unavailable for this Cap installation. Update it through your package manager or cap.so/download.".into());
        }
    };
    Ok(format!("linux-{arch}-{suffix}"))
}

pub fn updater_target(arch: &str) -> Result<String, String> {
    let executable = env::current_exe().map_err(|error| error.to_string())?;
    let marker = executable
        .parent()
        .and_then(Path::parent)
        .and_then(|directory| fs::read_to_string(directory.join("lib/cap/package-format")).ok());
    let appimage = env::var_os("APPIMAGE").map(PathBuf::from);
    let appdir = env::var_os("APPDIR").map(PathBuf::from);
    let debian_files = fs::read_to_string("/var/lib/dpkg/info/cap.list").ok();
    target_for(
        package_format(
            &executable,
            marker.as_deref(),
            appimage.as_deref(),
            appdir.as_deref(),
            debian_files.as_deref(),
        ),
        arch,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn appimage_audio_preserves_host_and_custom_configuration() {
        let config = Path::new("/tmp/.mount_cap/usr/lib/cap/alsa-pulse.conf");
        for existing in [None, Some(OsStr::new(""))] {
            assert_eq!(
                append_alsa_config(config, existing).unwrap(),
                OsString::from(
                    "/usr/share/alsa/alsa.conf:/tmp/.mount_cap/usr/lib/cap/alsa-pulse.conf"
                )
            );
        }
        let current = OsStr::new("/home/user/audio.conf:/home/user/devices.conf");
        let combined = append_alsa_config(config, Some(current)).unwrap();
        assert_eq!(
            combined,
            OsString::from(
                "/home/user/audio.conf:/home/user/devices.conf:/tmp/.mount_cap/usr/lib/cap/alsa-pulse.conf"
            )
        );
        assert!(append_alsa_config(config, Some(&combined)).is_none());
        assert!(append_alsa_config(Path::new("/tmp/invalid:path/alsa.conf"), None).is_none());
    }

    #[test]
    fn appimage_sets_one_alsa_config_file_unless_the_user_has_a_list() {
        let appdir = Path::new("/tmp/.mount_cap");
        let standalone = appdir.join("usr/lib/cap/alsa-pulse-appimage.conf");
        let listed = appdir.join("usr/lib/cap/alsa-pulse.conf");
        let after = |existing: &str| {
            let mut paths = OsString::from(existing);
            paths.push(":");
            paths.push(&listed);
            paths
        };
        let bundled = |path: &Path| path.starts_with(appdir);
        for existing in [None, Some(OsStr::new(""))] {
            assert_eq!(
                appimage_alsa_config(appdir, existing, bundled),
                Some(standalone.clone().into_os_string())
            );
        }
        assert_eq!(
            appimage_alsa_config(appdir, Some(OsStr::new("/home/user/audio.conf")), bundled),
            Some(after("/home/user/audio.conf"))
        );
        let without_standalone = |path: &Path| bundled(path) && path != standalone;
        assert_eq!(
            appimage_alsa_config(appdir, None, without_standalone),
            Some(after("/usr/share/alsa/alsa.conf"))
        );
        let without_plugin = |path: &Path| bundled(path) && !path.ends_with(PULSE_PLUGIN);
        assert_eq!(appimage_alsa_config(appdir, None, without_plugin), None);
        assert_eq!(
            appimage_alsa_config(Path::new("/tmp/a:b"), None, |_| true),
            None
        );
    }

    #[test]
    fn rpm_loads_its_pulse_plugin_only_when_the_host_has_none() {
        let bundled =
            |path: &Path| path == Path::new(RPM_ALSA_CONFIG) || path == Path::new(RPM_PULSE_PLUGIN);
        for existing in [None, Some(OsStr::new(""))] {
            assert_eq!(
                rpm_alsa_config("rpm\n", existing, bundled),
                Some(Path::new("/usr/lib/cap/alsa-pulse.conf"))
            );
        }
        assert_eq!(
            rpm_alsa_config("rpm", Some(OsStr::new("/home/user/audio.conf")), bundled),
            None
        );
        for host in ["/usr/lib64/alsa-lib", "/usr/lib/alsa-lib"] {
            let with_host_plugin =
                |path: &Path| bundled(path) || path == Path::new(host).join(PULSE_PLUGIN);
            assert_eq!(rpm_alsa_config("rpm", None, with_host_plugin), None);
        }
        for marker in ["deb", "arch", "appimage", ""] {
            assert_eq!(rpm_alsa_config(marker, None, bundled), None);
        }
        assert_eq!(
            rpm_alsa_config("rpm", None, |path| path == Path::new(RPM_ALSA_CONFIG)),
            None
        );
        assert_eq!(
            rpm_alsa_config("rpm", None, |path| path == Path::new(RPM_PULSE_PLUGIN)),
            None
        );
    }

    #[test]
    fn appimage_updates_require_the_current_executable_inside_its_appdir() {
        let root = std::env::temp_dir().join("cap-linux-package-test");
        let image = root.join("Cap.AppImage");
        let directory = root.join(".mount_cap");
        let format = package_format(
            &directory.join("usr/bin/Cap"),
            Some("appimage\n"),
            Some(&image),
            Some(&directory),
            None,
        );
        assert_eq!(
            target_for(format, "x86_64").unwrap(),
            "linux-x86_64-appimage"
        );
        let format = package_format(
            &root.join("usr/bin/Cap"),
            Some("rpm\n"),
            Some(&image),
            Some(&directory),
            None,
        );
        assert_eq!(format, PackageFormat::Rpm);
        assert!(target_for(format, "x86_64").is_err());
    }

    #[test]
    fn packages_never_select_an_incompatible_updater() {
        for (marker, expected) in [
            ("rpm", PackageFormat::Rpm),
            ("arch", PackageFormat::Arch),
            ("appimage", PackageFormat::ExtractedAppImage),
            ("other", PackageFormat::Unknown),
        ] {
            let format = package_format(Path::new("/usr/bin/Cap"), Some(marker), None, None, None);
            assert_eq!(format, expected);
            assert!(target_for(format, "aarch64").is_err());
        }
        let format = package_format(Path::new("/usr/bin/Cap"), Some("deb\n"), None, None, None);
        assert_eq!(target_for(format, "aarch64").unwrap(), "linux-aarch64-deb");
    }

    #[test]
    fn legacy_debian_packages_require_executable_ownership() {
        let files = Some("/usr/bin/Cap\n/usr/bin/cap-gpui\n");
        for executable in ["/usr/bin/Cap", "/usr/bin/cap-gpui"] {
            assert_eq!(
                package_format(Path::new(executable), None, None, None, files),
                PackageFormat::Deb
            );
        }
        assert_eq!(
            package_format(Path::new("/tmp/Cap"), None, None, None, files),
            PackageFormat::Unknown
        );
    }
}
