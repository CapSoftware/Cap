use std::path::{Path, PathBuf};

use semver::Version;

use crate::{
    installer::{self, ArtifactKind, Product},
    store::UpdateChannel,
};

pub(crate) const DOWNLOAD_PAGE: &str = "https://cap.so/download?version=classic";

#[cfg(target_os = "macos")]
const BUNDLE_NAME: &str = "Cap Classic.app";
#[cfg(windows)]
const EXECUTABLE_NAME: &str = "Cap Classic.exe";
#[cfg(target_os = "linux")]
const APPIMAGE_NAME: &str = "Cap-Classic.AppImage";

#[cfg(target_os = "macos")]
fn candidates(executable: Option<&Path>, home: Option<&Path>) -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    if let Some(parent) = executable
        .and_then(|executable| {
            executable
                .ancestors()
                .find(|path| path.extension().is_some_and(|extension| extension == "app"))
        })
        .and_then(Path::parent)
    {
        candidates.push(parent.join(BUNDLE_NAME));
    }
    candidates.push(Path::new("/Applications").join(BUNDLE_NAME));
    if let Some(home) = home {
        candidates.push(home.join("Applications").join(BUNDLE_NAME));
    }
    candidates.dedup();
    candidates
}

#[cfg(target_os = "macos")]
fn is_installed(candidate: &Path) -> bool {
    candidate.join("Contents/MacOS/Cap Classic").is_file()
}

#[cfg(target_os = "macos")]
pub(crate) fn installed() -> Option<PathBuf> {
    let executable = std::env::current_exe().ok();
    candidates(executable.as_deref(), dirs::home_dir().as_deref())
        .into_iter()
        .find(|candidate| is_installed(candidate))
}

#[cfg(windows)]
fn registry_install_dir(root: windows_sys::Win32::System::Registry::HKEY) -> Option<PathBuf> {
    use std::os::windows::ffi::OsStringExt as _;
    use windows_sys::{
        Win32::{
            Foundation::ERROR_SUCCESS,
            System::Registry::{RRF_RT_REG_SZ, RegGetValueW},
        },
        w,
    };

    let mut buffer = vec![0_u16; 1024];
    let mut size = (buffer.len() * std::mem::size_of::<u16>()) as u32;
    let status = unsafe {
        RegGetValueW(
            root,
            w!("Software\\cap\\Cap Classic"),
            std::ptr::null(),
            RRF_RT_REG_SZ,
            std::ptr::null_mut(),
            buffer.as_mut_ptr().cast(),
            &mut size,
        )
    };
    if status != ERROR_SUCCESS {
        return None;
    }
    let length = (size as usize / std::mem::size_of::<u16>()).min(buffer.len());
    let value = std::ffi::OsString::from_wide(&buffer[..length]);
    let value = value.to_string_lossy();
    let value = value.trim_end_matches('\0').trim().trim_matches('"');
    (!value.is_empty()).then(|| PathBuf::from(value))
}

#[cfg(windows)]
pub(crate) fn installed() -> Option<PathBuf> {
    use windows_sys::Win32::System::Registry::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE};

    [HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE]
        .into_iter()
        .filter_map(registry_install_dir)
        .chain(
            std::env::var_os("LOCALAPPDATA")
                .map(PathBuf::from)
                .map(|directory| directory.join("Cap Classic")),
        )
        .map(|directory| directory.join(EXECUTABLE_NAME))
        .find(|candidate| candidate.is_file())
}

#[cfg(target_os = "linux")]
fn install_destination() -> Option<PathBuf> {
    dirs::home_dir().map(|home| home.join("Applications").join(APPIMAGE_NAME))
}

#[cfg(target_os = "linux")]
pub(crate) fn installed() -> Option<PathBuf> {
    install_destination().filter(|candidate| candidate.is_file())
}

#[cfg(target_os = "macos")]
fn install_destination() -> Option<PathBuf> {
    let system = Path::new("/Applications");
    if writable(system) {
        return Some(system.join(BUNDLE_NAME));
    }
    dirs::home_dir().map(|home| home.join("Applications").join(BUNDLE_NAME))
}

#[cfg(target_os = "macos")]
fn writable(directory: &Path) -> bool {
    use std::os::unix::ffi::OsStrExt as _;

    let Ok(path) = std::ffi::CString::new(directory.as_os_str().as_bytes()) else {
        return false;
    };
    unsafe { libc::access(path.as_ptr(), libc::W_OK) == 0 }
}

pub(crate) async fn download_and_install(
    progress: impl FnMut(u64, Option<u64>) + Send,
) -> Result<Option<PathBuf>, String> {
    let platform = Product::Classic.update_platform()?;
    let kind = ArtifactKind::for_platform(&platform)?;
    let release = installer::fetch_release(
        Product::Classic,
        UpdateChannel::Stable,
        &Version::new(0, 0, 0),
    )
    .await?
    .ok_or_else(|| "Cap Classic isn't available to download for this computer yet.".to_string())?;
    let package = installer::download(Product::Classic, kind, &release, progress).await?;
    tokio::task::spawn_blocking(move || install(&package, kind))
        .await
        .map_err(|error| error.to_string())?
}

fn install(package: &Path, kind: ArtifactKind) -> Result<Option<PathBuf>, String> {
    installer::check_artifact_kind(package, kind)?;
    install_package(package)
}

#[cfg(target_os = "macos")]
fn install_package(package: &Path) -> Result<Option<PathBuf>, String> {
    let destination = install_destination()
        .ok_or_else(|| "Couldn't find an Applications folder to install into".to_string())?;
    installer::install_app_bundle(package, &destination)?;
    Ok(Some(destination))
}

#[cfg(windows)]
fn install_package(package: &Path) -> Result<Option<PathBuf>, String> {
    installer::launch_installer(package, &["/P", "/R"])?;
    Ok(None)
}

#[cfg(target_os = "linux")]
fn install_package(package: &Path) -> Result<Option<PathBuf>, String> {
    let destination =
        install_destination().ok_or_else(|| "Couldn't find your home folder".to_string())?;
    installer::install_appimage(package, &destination)?;
    Ok(Some(destination))
}

pub(crate) fn launch(path: &Path) -> std::io::Result<()> {
    let mut command = launch_command(path);
    #[cfg(target_os = "macos")]
    {
        let output = command.output()?;
        if output.status.success() {
            Ok(())
        } else {
            Err(std::io::Error::other(format!(
                "Cap Classic didn't open ({}): {}",
                output.status,
                String::from_utf8_lossy(&output.stderr).trim()
            )))
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        use std::process::Stdio;

        command
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt as _;
            command.process_group(0);
        }
        let mut child = command.spawn()?;
        std::thread::spawn(move || {
            let _ = child.wait();
        });
        Ok(())
    }
}

fn launch_command(path: &Path) -> std::process::Command {
    #[cfg(target_os = "macos")]
    {
        let mut command = std::process::Command::new("/usr/bin/open");
        command.arg("-n").arg(path);
        command
    }
    #[cfg(not(target_os = "macos"))]
    {
        std::process::Command::new(path)
    }
}

#[cfg(test)]
mod tests {
    #[cfg(target_os = "macos")]
    #[test]
    fn classic_is_found_beside_this_app_and_in_both_application_folders() {
        use std::path::{Path, PathBuf};

        assert_eq!(
            super::candidates(
                Some(Path::new("/Volumes/Work/Apps/Cap.app/Contents/MacOS/Cap")),
                Some(Path::new("/Users/x")),
            ),
            vec![
                PathBuf::from("/Volumes/Work/Apps/Cap Classic.app"),
                PathBuf::from("/Applications/Cap Classic.app"),
                PathBuf::from("/Users/x/Applications/Cap Classic.app"),
            ]
        );
        assert_eq!(
            super::candidates(
                Some(Path::new("/Applications/Cap.app/Contents/MacOS/Cap")),
                None
            ),
            vec![PathBuf::from("/Applications/Cap Classic.app")]
        );
    }

    #[test]
    fn launching_passes_the_install_path_as_a_literal_argument() {
        let path = std::path::Path::new("/tmp/Cap ' \" $ Classic");
        let command = super::launch_command(path);
        if cfg!(target_os = "macos") {
            assert_eq!(command.get_program(), "/usr/bin/open");
            assert_eq!(
                command.get_args().collect::<Vec<_>>(),
                [std::ffi::OsStr::new("-n"), path.as_os_str()]
            );
        } else {
            assert_eq!(command.get_program(), path.as_os_str());
            assert_eq!(command.get_args().count(), 0);
        }
    }
}
