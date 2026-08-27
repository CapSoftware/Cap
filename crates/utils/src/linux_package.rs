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

pub fn appimage_alsa_config_path() -> Option<OsString> {
    let executable = env::current_exe().ok()?;
    let appimage = env::var_os("APPIMAGE").map(PathBuf::from);
    let appdir = env::var_os("APPDIR").map(PathBuf::from)?;
    if package_format(&executable, None, appimage.as_deref(), Some(&appdir), None)
        != PackageFormat::AppImage
    {
        return None;
    }
    let config = appdir.join("usr/lib/cap/alsa-pulse.conf");
    let plugin = appdir.join("usr/lib/alsa-lib/libasound_module_pcm_pulse.so");
    if !config.is_file() || !plugin.is_file() {
        return None;
    }
    append_alsa_config(&config, env::var_os("ALSA_CONFIG_PATH").as_deref())
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
    fn appimage_updates_require_the_current_executable_inside_its_appdir() {
        let image = Some(Path::new("/home/user/Cap.AppImage"));
        let directory = Some(Path::new("/tmp/.mount_cap"));
        let format = package_format(
            Path::new("/tmp/.mount_cap/usr/bin/Cap"),
            Some("appimage\n"),
            image,
            directory,
            None,
        );
        assert_eq!(
            target_for(format, "x86_64").unwrap(),
            "linux-x86_64-appimage"
        );
        let format = package_format(
            Path::new("/usr/bin/Cap"),
            Some("rpm\n"),
            image,
            directory,
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
