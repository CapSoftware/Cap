use std::{
    io::{Read as _, Write as _},
    path::{Path, PathBuf},
    time::Duration,
};

use base64::Engine as _;
use futures_util::StreamExt as _;
use minisign_verify::{PublicKey, Signature, StreamVerifier};
use semver::Version;
use serde::Deserialize;

use crate::store::UpdateChannel;

const UPDATE_ENDPOINT: &str = "https://cdn.crabnebula.app/update/cap/cap";
const UPDATER_PUBLIC_KEY: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IEUyOTAzOTdFNzJFQkRFOTMKUldTVDN1dHlmam1RNHFXb1VYTXlrQk1iMFFkcjN0YitqZlA5WnZNY0ZtQ1dvM1dxK211M3VIYUQK";
const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
const METADATA_TIMEOUT: Duration = Duration::from_secs(20);
const CHUNK_TIMEOUT: Duration = Duration::from_secs(60);

const STAGING_SLUG: &str = "cap";

pub(crate) fn update_platform() -> Result<String, String> {
    let arch = if cfg!(target_arch = "aarch64") {
        "aarch64"
    } else {
        "x86_64"
    };
    platform_for(arch)
}

#[cfg(target_os = "linux")]
fn platform_for(arch: &str) -> Result<String, String> {
    cap_utils::linux_package::updater_target(arch)
}

#[cfg(not(target_os = "linux"))]
fn platform_for(arch: &str) -> Result<String, String> {
    let os = if cfg!(target_os = "macos") {
        "darwin"
    } else {
        "windows"
    };
    Ok(format!("{os}-{arch}"))
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ArtifactKind {
    AppArchive,
    NsisInstaller,
    Deb,
    AppImage,
}

impl ArtifactKind {
    pub(crate) fn for_platform(platform: &str) -> Result<Self, String> {
        if platform.starts_with("darwin-") {
            Ok(Self::AppArchive)
        } else if platform.starts_with("windows-") {
            Ok(Self::NsisInstaller)
        } else if platform.starts_with("linux-") && platform.contains("-deb") {
            Ok(Self::Deb)
        } else if platform.starts_with("linux-") && platform.contains("-appimage") {
            Ok(Self::AppImage)
        } else {
            Err(format!("Unsupported update platform: {platform}"))
        }
    }

    fn file_name(self) -> &'static str {
        match self {
            Self::AppArchive => "Cap.app.tar.gz",
            Self::NsisInstaller => "Cap-setup.exe",
            Self::Deb => "Cap.deb",
            Self::AppImage => "Cap.AppImage",
        }
    }

    fn matches(self, header: &[u8]) -> bool {
        match self {
            Self::AppArchive => header.starts_with(&[0x1f, 0x8b]),
            Self::NsisInstaller => header.starts_with(b"MZ"),
            Self::Deb => header.starts_with(b"!<arch>\n"),
            Self::AppImage => header.starts_with(b"\x7fELF"),
        }
    }
}

#[derive(Deserialize)]
struct RemoteRelease {
    version: String,
    url: String,
    signature: String,
    #[serde(default)]
    notes: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Release {
    pub(crate) version: Version,
    pub(crate) url: String,
    pub(crate) signature: String,
    pub(crate) notes: Option<String>,
}

fn parse_release(body: &[u8]) -> Result<Release, String> {
    let remote: RemoteRelease = serde_json::from_slice(body)
        .map_err(|error| format!("Invalid update response: {error}"))?;
    let version = Version::parse(remote.version.trim().trim_start_matches('v'))
        .map_err(|error| format!("Invalid update version {:?}: {error}", remote.version))?;
    let url = reqwest::Url::parse(remote.url.trim())
        .map_err(|error| format!("Invalid update download URL: {error}"))?;
    if url.scheme() != "https" {
        return Err("Update downloads must use HTTPS".to_string());
    }
    if remote.signature.trim().is_empty() {
        return Err("The update has no signature".to_string());
    }
    Ok(Release {
        version,
        url: url.into(),
        signature: remote.signature.trim().to_string(),
        notes: remote.notes.filter(|notes| !notes.trim().is_empty()),
    })
}

fn endpoint(platform: &str, channel: UpdateChannel, current: &Version) -> String {
    let url = format!("{UPDATE_ENDPOINT}/{platform}/{current}");
    match channel {
        UpdateChannel::Stable => url,
        UpdateChannel::Nightly => format!("{url}?channel=nightly"),
    }
}

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .user_agent(concat!("Cap/", env!("CARGO_PKG_VERSION")))
        .connect_timeout(CONNECT_TIMEOUT)
        .build()
        .map_err(|error| error.to_string())
}

pub(crate) async fn fetch_release(
    channel: UpdateChannel,
    current: &Version,
) -> Result<Option<Release>, String> {
    let platform = update_platform()?;
    let response = client()?
        .get(endpoint(&platform, channel, current))
        .timeout(METADATA_TIMEOUT)
        .send()
        .await
        .map_err(|error| error.to_string())?;

    if response.status() == reqwest::StatusCode::NO_CONTENT {
        return Ok(None);
    }

    let body = response
        .error_for_status()
        .map_err(|error| error.to_string())?
        .bytes()
        .await
        .map_err(|error| error.to_string())?;
    parse_release(&body).map(Some)
}

fn decode_base64_text(value: &str, what: &str) -> Result<String, String> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(value.trim())
        .map_err(|error| format!("Invalid {what} encoding: {error}"))?;
    String::from_utf8(bytes).map_err(|_| format!("Invalid {what} text"))
}

fn trusted_key(encoded: &str) -> Result<PublicKey, String> {
    PublicKey::decode(&decode_base64_text(encoded, "update key")?)
        .map_err(|error| format!("Invalid update key: {error}"))
}

fn decode_signature(encoded: &str) -> Result<Signature, String> {
    Signature::decode(&decode_base64_text(encoded, "update signature")?)
        .map_err(|error| format!("Invalid update signature: {error}"))
}

enum Verifier<'a> {
    Stream(StreamVerifier<'a>),
    Buffered,
}

impl<'a> Verifier<'a> {
    fn new(key: &'a PublicKey, signature: &'a Signature) -> Result<Self, String> {
        match key.verify_stream(signature) {
            Ok(verifier) => Ok(Self::Stream(verifier)),
            Err(minisign_verify::Error::UnsupportedLegacyMode) => Ok(Self::Buffered),
            Err(error) => Err(format!("The update was not signed by Cap: {error}")),
        }
    }

    fn update(&mut self, chunk: &[u8]) {
        if let Self::Stream(verifier) = self {
            verifier.update(chunk);
        }
    }

    fn finish(self, key: &PublicKey, signature: &Signature, file: &Path) -> Result<(), String> {
        let verified = match self {
            Self::Stream(mut verifier) => verifier.finalize(),
            Self::Buffered => {
                let bytes = std::fs::read(file).map_err(|error| error.to_string())?;
                key.verify(&bytes, signature, true)
            }
        };
        verified.map_err(|error| format!("The download failed signature verification: {error}"))
    }
}

fn verify_file(file: &Path, key: &PublicKey, signature: &Signature) -> Result<(), String> {
    let mut verifier = Verifier::new(key, signature)?;
    if matches!(verifier, Verifier::Stream(_)) {
        let mut reader = std::fs::File::open(file).map_err(|error| error.to_string())?;
        let mut buffer = vec![0_u8; 256 * 1024];
        loop {
            let read = reader
                .read(&mut buffer)
                .map_err(|error| error.to_string())?;
            if read == 0 {
                break;
            }
            verifier.update(&buffer[..read]);
        }
    }
    verifier.finish(key, signature, file)
}

pub(crate) fn check_artifact_kind(file: &Path, kind: ArtifactKind) -> Result<(), String> {
    let mut header = [0_u8; 8];
    let read = std::fs::File::open(file)
        .and_then(|mut reader| reader.read(&mut header))
        .map_err(|error| error.to_string())?;
    if kind.matches(&header[..read]) {
        Ok(())
    } else {
        Err("The downloaded file is not a Cap package for this platform".to_string())
    }
}

fn staging_root() -> PathBuf {
    if let Some(directory) = std::env::var_os("CAP_GPUI_UPDATE_STAGING_DIR")
        && !directory.is_empty()
    {
        return PathBuf::from(directory);
    }
    dirs::cache_dir()
        .unwrap_or_else(std::env::temp_dir)
        .join("so.cap.desktop")
        .join("updates")
}

fn prune_other_versions(product_dir: &Path, keep: &Path) {
    let Ok(entries) = std::fs::read_dir(product_dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path != keep
            && let Err(error) = std::fs::remove_dir_all(&path)
        {
            tracing::warn!(path = %path.display(), %error, "could not remove a stale update download");
        }
    }
}

pub(crate) async fn download(
    kind: ArtifactKind,
    release: &Release,
    mut progress: impl FnMut(u64, Option<u64>) + Send,
) -> Result<PathBuf, String> {
    download_into(
        &staging_root(),
        UPDATER_PUBLIC_KEY,
        kind,
        release,
        &mut progress,
    )
    .await
}

async fn download_into(
    root: &Path,
    encoded_key: &str,
    kind: ArtifactKind,
    release: &Release,
    progress: &mut (impl FnMut(u64, Option<u64>) + Send),
) -> Result<PathBuf, String> {
    let key = trusted_key(encoded_key)?;
    let signature = decode_signature(&release.signature)?;
    let product_dir = root.join(STAGING_SLUG);
    let version_dir = product_dir.join(release.version.to_string());
    let destination = version_dir.join(kind.file_name());

    if destination.is_file() && verify_file(&destination, &key, &signature).is_ok() {
        prune_other_versions(&product_dir, &version_dir);
        return Ok(destination);
    }

    std::fs::create_dir_all(&version_dir).map_err(|error| error.to_string())?;
    let partial = version_dir.join(format!("{}.partial", kind.file_name()));
    if let Err(error) = stream_to_file(&partial, &key, &signature, release, progress).await {
        let _ = std::fs::remove_file(&partial);
        return Err(error);
    }
    std::fs::rename(&partial, &destination).map_err(|error| error.to_string())?;
    prune_other_versions(&product_dir, &version_dir);
    Ok(destination)
}

async fn stream_to_file(
    partial: &Path,
    key: &PublicKey,
    signature: &Signature,
    release: &Release,
    progress: &mut (impl FnMut(u64, Option<u64>) + Send),
) -> Result<(), String> {
    let mut verifier = Verifier::new(key, signature)?;
    let response = client()?
        .get(&release.url)
        .header(reqwest::header::ACCEPT, "application/octet-stream")
        .send()
        .await
        .map_err(|error| error.to_string())?
        .error_for_status()
        .map_err(|error| error.to_string())?;
    let total = response.content_length();
    let mut file = std::fs::File::create(partial).map_err(|error| error.to_string())?;
    let mut stream = response.bytes_stream();
    let mut downloaded = 0_u64;
    progress(0, total);

    loop {
        let next = tokio::time::timeout(CHUNK_TIMEOUT, stream.next())
            .await
            .map_err(|_| "The download stopped responding".to_string())?;
        let Some(chunk) = next else {
            break;
        };
        let chunk = chunk.map_err(|error| error.to_string())?;
        file.write_all(&chunk).map_err(|error| error.to_string())?;
        verifier.update(&chunk);
        downloaded = downloaded.saturating_add(chunk.len() as u64);
        progress(downloaded, total);
    }

    file.sync_all().map_err(|error| error.to_string())?;
    drop(file);
    if total.is_some_and(|total| total != downloaded) {
        return Err("The download ended early".to_string());
    }
    verifier.finish(key, signature, partial)
}

#[cfg(target_os = "macos")]
pub(crate) fn install_app_bundle(archive: &Path, destination: &Path) -> Result<(), String> {
    let parent = destination
        .parent()
        .ok_or_else(|| "The app has no parent folder".to_string())?;
    std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let staging = match unique_directory_in(parent, ".cap-update") {
        Ok(directory) => directory,
        Err(error) if error.kind() == std::io::ErrorKind::PermissionDenied => {
            unique_directory_in(&std::env::temp_dir(), "cap-update")
                .map_err(|error| error.to_string())?
        }
        Err(error) => return Err(error.to_string()),
    };

    let installed =
        extract_app_archive(archive, &staging).and_then(|app| {
            match replace_directory(&app, destination) {
                Ok(()) => Ok(()),
                Err(error)
                    if matches!(
                        error.kind(),
                        std::io::ErrorKind::PermissionDenied | std::io::ErrorKind::CrossesDevices
                    ) =>
                {
                    replace_directory_with_privileges(&app, destination)
                }
                Err(error) => Err(error.to_string()),
            }
        });
    if let Err(error) = std::fs::remove_dir_all(&staging)
        && error.kind() != std::io::ErrorKind::NotFound
    {
        tracing::warn!(%error, "could not remove the update staging folder");
    }
    installed?;

    let _ = std::process::Command::new("/usr/bin/touch")
        .arg(destination)
        .status();
    Ok(())
}

#[cfg(target_os = "macos")]
fn extract_app_archive(archive: &Path, staging: &Path) -> Result<PathBuf, String> {
    let output = std::process::Command::new("/usr/bin/tar")
        .arg("-xzf")
        .arg(archive)
        .arg("-C")
        .arg(staging)
        .output()
        .map_err(|error| format!("Could not unpack the update: {error}"))?;
    if !output.status.success() {
        return Err(format!(
            "Could not unpack the update: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    single_app_bundle(staging)
}

#[cfg(any(target_os = "macos", test))]
fn single_app_bundle(directory: &Path) -> Result<PathBuf, String> {
    let bundles = std::fs::read_dir(directory)
        .map_err(|error| error.to_string())?
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| {
            path.extension().is_some_and(|extension| extension == "app")
                && path.join("Contents/Info.plist").is_file()
        })
        .collect::<Vec<_>>();
    match bundles.as_slice() {
        [bundle] => Ok(bundle.clone()),
        _ => Err("The update archive does not contain exactly one app".to_string()),
    }
}

#[cfg(target_os = "macos")]
fn unique_directory_in(parent: &Path, prefix: &str) -> std::io::Result<PathBuf> {
    for attempt in 0..32_u32 {
        let candidate = parent.join(format!("{prefix}-{}-{attempt}", std::process::id()));
        match std::fs::create_dir(&candidate) {
            Ok(()) => return Ok(candidate),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(error) => return Err(error),
        }
    }
    Err(std::io::Error::new(
        std::io::ErrorKind::AlreadyExists,
        "no free staging folder name",
    ))
}

#[cfg(any(target_os = "macos", test))]
fn replace_directory(new: &Path, destination: &Path) -> std::io::Result<()> {
    if !destination.exists() {
        return std::fs::rename(new, destination);
    }
    let name = destination
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();
    let backup = destination.with_file_name(format!(".{name}.previous-{}", std::process::id()));
    if backup.exists() {
        std::fs::remove_dir_all(&backup)?;
    }
    std::fs::rename(destination, &backup)?;
    if let Err(error) = std::fs::rename(new, destination) {
        if let Err(restore) = std::fs::rename(&backup, destination) {
            tracing::error!(%restore, "could not restore the previous app after a failed update");
        }
        return Err(error);
    }
    if let Err(error) = std::fs::remove_dir_all(&backup) {
        tracing::warn!(%error, "could not remove the previous app after updating");
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn replace_directory_with_privileges(new: &Path, destination: &Path) -> Result<(), String> {
    let output = std::process::Command::new("/usr/bin/osascript")
        .args([
            "-e",
            "on run argv",
            "-e",
            "do shell script \"/bin/rm -rf \" & quoted form of (item 1 of argv) & \" && /bin/mv -f \" & quoted form of (item 2 of argv) & \" \" & quoted form of (item 1 of argv) with administrator privileges",
            "-e",
            "end run",
        ])
        .arg(destination)
        .arg(new)
        .output()
        .map_err(|error| format!("Could not ask for permission to install: {error}"))?;
    if output.status.success() {
        Ok(())
    } else {
        Err(format!(
            "Cap couldn't replace {}. {}",
            destination.display(),
            String::from_utf8_lossy(&output.stderr).trim()
        ))
    }
}

#[cfg(windows)]
pub(crate) fn launch_installer(installer: &Path, arguments: &[&str]) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt as _;
    use windows_sys::{
        Win32::UI::{Shell::ShellExecuteW, WindowsAndMessaging::SW_SHOWNORMAL},
        w,
    };

    let wide = |value: &std::ffi::OsStr| {
        value
            .encode_wide()
            .chain(std::iter::once(0))
            .collect::<Vec<u16>>()
    };
    let file = wide(installer.as_os_str());
    let parameters = wide(std::ffi::OsStr::new(&arguments.join(" ")));
    let result = unsafe {
        ShellExecuteW(
            std::ptr::null_mut(),
            w!("open"),
            file.as_ptr(),
            parameters.as_ptr(),
            std::ptr::null(),
            SW_SHOWNORMAL,
        )
    };
    if result as isize > 32 {
        Ok(())
    } else {
        Err(format!(
            "Windows could not start the installer (code {})",
            result as isize
        ))
    }
}

#[cfg(target_os = "linux")]
pub(crate) fn install_deb(package: &Path) -> Result<(), String> {
    let status = std::process::Command::new("pkexec")
        .arg("dpkg")
        .arg("-i")
        .arg(package)
        .status()
        .map_err(|error| format!("Could not ask for permission to install: {error}"))?;
    if status.success() {
        Ok(())
    } else {
        Err("The package wasn't installed. Approve the system prompt, or install it from cap.so/download.".to_string())
    }
}

#[cfg(any(target_os = "linux", all(test, unix)))]
pub(crate) fn install_appimage(image: &Path, destination: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt as _;

    let parent = destination
        .parent()
        .ok_or_else(|| "The AppImage has no parent folder".to_string())?;
    std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let name = destination
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();
    let staged = parent.join(format!(".{name}.update-{}", std::process::id()));
    let copied = std::fs::copy(image, &staged)
        .and_then(|_| std::fs::set_permissions(&staged, std::fs::Permissions::from_mode(0o755)))
        .and_then(|()| std::fs::rename(&staged, destination));
    if let Err(error) = copied {
        let _ = std::fs::remove_file(&staged);
        return Err(format!(
            "Could not install {}: {error}",
            destination.display()
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::io::{Read as _, Write as _};

    use super::*;

    const TEST_KEY: &str = "untrusted comment: minisign public key E7620F1842B4E81F\nRWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3\n";
    const TEST_SIGNATURE: &str = "untrusted comment: signature from minisign secret key\nRUQf6LRCGA9i559r3g7V1qNyJDApGip8MfqcadIgT9CuhV3EMhHoN1mGTkUidF/z7SrlQgXdy8ofjb7bNJJylDOocrCo8KLzZwo=\ntrusted comment: timestamp:1556193335\tfile:test\ny/rUw2y8/hOUYjZU71eHp/Wo1KZ40fGy2VJEDl34XMJM+TX48Ss/17u3IvIfbVR1FkZZSNCisQbuQY+bHwhEBg==\n";

    fn encode(text: &str) -> String {
        base64::engine::general_purpose::STANDARD.encode(text)
    }

    fn scratch(name: &str) -> PathBuf {
        let directory = std::env::temp_dir().join(format!(
            "cap-gpui-installer-{name}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&directory).unwrap();
        directory
    }

    fn serve_once(body: &'static [u8]) -> (String, std::thread::JoinHandle<usize>) {
        let listener = std::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).unwrap();
        let url = format!("http://{}/artifact", listener.local_addr().unwrap());
        let server = std::thread::spawn(move || {
            let mut served = 0;
            for stream in listener.incoming().take(1) {
                let mut stream = stream.unwrap();
                let mut request = [0_u8; 4096];
                let _ = stream.read(&mut request).unwrap();
                write!(
                    stream,
                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    body.len()
                )
                .unwrap();
                stream.write_all(body).unwrap();
                served += 1;
            }
            served
        });
        (url, server)
    }

    fn release(url: String) -> Release {
        Release {
            version: Version::new(9, 9, 9),
            url,
            signature: encode(TEST_SIGNATURE),
            notes: None,
        }
    }

    #[test]
    fn the_shipped_update_key_decodes() {
        let key = trusted_key(UPDATER_PUBLIC_KEY).unwrap();
        assert_eq!(
            key.untrusted_comment(),
            Some("untrusted comment: minisign public key: E290397E72EBDE93")
        );
    }

    #[test]
    fn release_metadata_requires_https_and_a_signature() {
        let release = parse_release(
            br#"{"version":"v0.7.0","notes":"","url":"https://cdn.crabnebula.app/asset/1","signature":"c2ln"}"#,
        )
        .unwrap();
        assert_eq!(release.version, Version::new(0, 7, 0));
        assert_eq!(release.notes, None);
        assert!(
            parse_release(
                br#"{"version":"0.7.0","url":"http://example.com/a","signature":"c2ln"}"#
            )
            .is_err()
        );
        assert!(
            parse_release(br#"{"version":"0.7.0","url":"https://example.com/a","signature":" "}"#)
                .is_err()
        );
        assert!(
            parse_release(
                br#"{"version":"seven","url":"https://example.com/a","signature":"c2ln"}"#
            )
            .is_err()
        );
    }

    #[test]
    fn endpoints_name_the_platform_version_and_channel() {
        let current = Version::parse("0.6.2-nightly.4").unwrap();
        assert_eq!(
            endpoint("darwin-aarch64", UpdateChannel::Stable, &current),
            "https://cdn.crabnebula.app/update/cap/cap/darwin-aarch64/0.6.2-nightly.4"
        );
        assert_eq!(
            endpoint("windows-x86_64", UpdateChannel::Nightly, &current),
            "https://cdn.crabnebula.app/update/cap/cap/windows-x86_64/0.6.2-nightly.4?channel=nightly"
        );
    }

    #[test]
    fn update_platforms_map_to_their_artifact_kinds() {
        assert_eq!(
            ArtifactKind::for_platform("linux-x86_64-appimage"),
            Ok(ArtifactKind::AppImage)
        );
        assert_eq!(
            ArtifactKind::for_platform("linux-x86_64-deb"),
            Ok(ArtifactKind::Deb)
        );
        assert_eq!(
            ArtifactKind::for_platform("darwin-aarch64"),
            Ok(ArtifactKind::AppArchive)
        );
        assert_eq!(
            ArtifactKind::for_platform("windows-x86_64"),
            Ok(ArtifactKind::NsisInstaller)
        );
        assert!(ArtifactKind::for_platform("linux-x86_64-rpm").is_err());
        if !cfg!(target_os = "linux") {
            let platform = update_platform().unwrap();
            assert!(ArtifactKind::for_platform(&platform).is_ok(), "{platform}");
        }
    }

    #[test]
    fn signatures_verify_while_streaming_and_reject_tampering() {
        let key = trusted_key(&encode(TEST_KEY)).unwrap();
        let signature = decode_signature(&encode(TEST_SIGNATURE)).unwrap();
        let directory = scratch("verify");
        let file = directory.join("artifact");

        std::fs::write(&file, b"test").unwrap();
        verify_file(&file, &key, &signature).unwrap();

        std::fs::write(&file, b"tesT").unwrap();
        assert!(verify_file(&file, &key, &signature).is_err());

        let mut verifier = Verifier::new(&key, &signature).unwrap();
        verifier.update(b"te");
        verifier.update(b"st");
        verifier.finish(&key, &signature, &file).unwrap();
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn downloads_are_verified_staged_and_reused() {
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(1)
            .enable_all()
            .build()
            .unwrap();
        let root = scratch("download");
        let stale = root.join("cap").join("0.0.1");
        std::fs::create_dir_all(&stale).unwrap();

        let (url, server) = serve_once(b"test");
        let mut updates = Vec::new();
        let downloaded = runtime
            .block_on(download_into(
                &root,
                &encode(TEST_KEY),
                ArtifactKind::AppImage,
                &release(url),
                &mut |done, total| updates.push((done, total)),
            ))
            .unwrap();
        assert_eq!(server.join().unwrap(), 1);
        assert_eq!(downloaded, root.join("cap/9.9.9/Cap.AppImage"));
        assert_eq!(std::fs::read(&downloaded).unwrap(), b"test");
        assert_eq!(updates.first(), Some(&(0, Some(4))));
        assert_eq!(updates.last(), Some(&(4, Some(4))));
        assert!(!stale.exists());
        assert!(check_artifact_kind(&downloaded, ArtifactKind::AppImage).is_err());

        let reused = runtime
            .block_on(download_into(
                &root,
                &encode(TEST_KEY),
                ArtifactKind::AppImage,
                &release("http://127.0.0.1:9/unreachable".to_string()),
                &mut |_, _| panic!("a verified cached download must not be fetched again"),
            ))
            .unwrap();
        assert_eq!(reused, downloaded);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn artifact_kinds_are_recognised_by_their_headers() {
        let root = scratch("kinds");
        for (kind, header) in [
            (ArtifactKind::AppArchive, &b"\x1f\x8b\x08\x00"[..]),
            (ArtifactKind::NsisInstaller, &b"MZ\x90\x00"[..]),
            (ArtifactKind::Deb, &b"!<arch>\ndebian"[..]),
            (ArtifactKind::AppImage, &b"\x7fELF\x02\x01"[..]),
        ] {
            let file = root.join("artifact");
            std::fs::write(&file, header).unwrap();
            check_artifact_kind(&file, kind).unwrap();
            std::fs::write(&file, b"<html>").unwrap();
            assert!(check_artifact_kind(&file, kind).is_err());
        }
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn tampered_downloads_are_discarded() {
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(1)
            .enable_all()
            .build()
            .unwrap();
        let root = scratch("tampered");
        let (url, server) = serve_once(b"tesT");
        let error = runtime
            .block_on(download_into(
                &root,
                &encode(TEST_KEY),
                ArtifactKind::AppImage,
                &release(url),
                &mut |_, _| {},
            ))
            .unwrap_err();
        assert_eq!(server.join().unwrap(), 1);
        assert!(error.contains("signature verification"));
        let version_dir = root.join("cap").join("9.9.9");
        assert!(!version_dir.join("Cap.AppImage").exists());
        assert!(!version_dir.join("Cap.AppImage.partial").exists());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn app_bundles_are_swapped_atomically_with_a_single_bundle_check() {
        let root = scratch("bundle");
        let staging = root.join("staging");
        let new_app = staging.join("Cap.app");
        std::fs::create_dir_all(new_app.join("Contents")).unwrap();
        std::fs::write(new_app.join("Contents/Info.plist"), "new").unwrap();
        assert_eq!(single_app_bundle(&staging).unwrap(), new_app);

        let destination = root.join("Applications").join("Cap.app");
        std::fs::create_dir_all(destination.join("Contents")).unwrap();
        std::fs::write(destination.join("Contents/Info.plist"), "old").unwrap();
        replace_directory(&new_app, &destination).unwrap();
        assert_eq!(
            std::fs::read_to_string(destination.join("Contents/Info.plist")).unwrap(),
            "new"
        );
        assert_eq!(
            std::fs::read_dir(root.join("Applications"))
                .unwrap()
                .count(),
            1
        );

        let other = staging.join("Other.app");
        std::fs::create_dir_all(other.join("Contents")).unwrap();
        std::fs::write(other.join("Contents/Info.plist"), "other").unwrap();
        let again = staging.join("Again.app");
        std::fs::create_dir_all(again.join("Contents")).unwrap();
        std::fs::write(again.join("Contents/Info.plist"), "again").unwrap();
        assert!(single_app_bundle(&staging).is_err());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn appimages_are_replaced_in_place_and_made_executable() {
        use std::os::unix::fs::PermissionsExt as _;

        let root = scratch("appimage");
        let source = root.join("download.AppImage");
        std::fs::write(&source, b"\x7fELFnew").unwrap();
        let destination = root.join("Applications").join("Cap.AppImage");
        install_appimage(&source, &destination).unwrap();
        assert_eq!(std::fs::read(&destination).unwrap(), b"\x7fELFnew");
        assert_eq!(
            std::fs::metadata(&destination)
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o755
        );
        std::fs::write(&source, b"\x7fELFnewer").unwrap();
        install_appimage(&source, &destination).unwrap();
        assert_eq!(std::fs::read(&destination).unwrap(), b"\x7fELFnewer");
        assert_eq!(
            std::fs::read_dir(root.join("Applications"))
                .unwrap()
                .count(),
            1
        );
        std::fs::remove_dir_all(root).unwrap();
    }
}
