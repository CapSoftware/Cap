//! Where catalogue wallpapers live on disk.
//!
//! A project stores the absolute path of the wallpaper it was given. Older
//! apps shipped the wallpapers inside the app bundle, so those paths point
//! into an install that no longer carries them; newer apps download them into
//! [`downloaded_assets_dir`]. Both layouts end in
//! `assets/backgrounds/<theme>/<name>.jpg`, so a missing path is looked up by
//! that tail in the download folder and in any extra folder the app registers.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{LazyLock, RwLock};

const MARKER: &str = "assets/backgrounds/";

static EXTRA_DIRS: LazyLock<RwLock<Vec<PathBuf>>> = LazyLock::new(|| RwLock::new(Vec::new()));
static GENERATION: AtomicU64 = AtomicU64::new(0);

/// The folder downloaded assets go in: `CAP_ASSETS_DIR` when set, else
/// `assets` in the desktop app's local data folder.
pub fn downloaded_assets_dir() -> PathBuf {
    if let Some(dir) = std::env::var_os("CAP_ASSETS_DIR").filter(|dir| !dir.is_empty()) {
        return PathBuf::from(dir);
    }
    dirs::data_local_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("so.cap.desktop")
        .join("assets")
}

/// Adds a folder that holds `<theme>/<name>.jpg`, searched after the
/// download folder.
pub fn register_wallpaper_dir(dir: PathBuf) {
    let mut dirs = EXTRA_DIRS
        .write()
        .unwrap_or_else(|error| error.into_inner());
    if !dirs.contains(&dir) {
        dirs.push(dir);
    }
}

/// Bumped whenever an asset lands on disk, so a path that was missing is
/// looked up again.
pub fn asset_generation() -> u64 {
    GENERATION.load(Ordering::Acquire)
}

pub fn bump_asset_generation() {
    GENERATION.fetch_add(1, Ordering::AcqRel);
}

/// `theme/name.jpg` from a stored wallpaper path, when it names one.
pub fn catalogue_wallpaper_tail(path: &str) -> Option<String> {
    let normalized = path.replace('\\', "/");
    let start = normalized.rfind(MARKER)? + MARKER.len();
    let tail = &normalized[start..];
    let mut parts = tail.split('/');
    let (theme, file) = (parts.next()?, parts.next()?);
    if parts.next().is_some() || !file.ends_with(".jpg") || file.ends_with("-thumbnail.jpg") {
        return None;
    }
    let safe = |part: &str| {
        !part.is_empty()
            && part != "."
            && part != ".."
            && part
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
    };
    (safe(theme) && safe(file)).then(|| format!("{theme}/{file}"))
}

/// The file a missing catalogue wallpaper path stands for, if a copy exists.
pub fn locate_catalogue_wallpaper(path: &str) -> Option<PathBuf> {
    let tail = catalogue_wallpaper_tail(path)?;
    let extra = EXTRA_DIRS
        .read()
        .unwrap_or_else(|error| error.into_inner())
        .clone();
    std::iter::once(downloaded_assets_dir().join("backgrounds"))
        .chain(extra)
        .map(|dir| dir.join(Path::new(&tail)))
        .find(|candidate| candidate.is_file())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tail_comes_from_every_platform_layout() {
        for path in [
            "/Applications/Cap.app/Contents/Resources/assets/backgrounds/macOS/tahoe-dark.jpg",
            "C:\\Program Files\\Cap\\assets\\backgrounds\\macOS\\tahoe-dark.jpg",
            "/tmp/.mount_CapXyZ/usr/lib/Cap/assets/backgrounds/macOS/tahoe-dark.jpg",
            "/home/a/.local/share/so.cap.desktop/assets/backgrounds/macOS/tahoe-dark.jpg",
        ] {
            assert_eq!(
                catalogue_wallpaper_tail(path).as_deref(),
                Some("macOS/tahoe-dark.jpg"),
                "{path}"
            );
        }
    }

    #[test]
    fn tail_rejects_anything_outside_the_catalogue_shape() {
        for path in [
            "/Users/a/Pictures/beach.jpg",
            "/x/assets/backgrounds/macOS/tahoe-dark-thumbnail.jpg",
            "/x/assets/backgrounds/../secret.jpg",
            "/x/assets/backgrounds/macOS/../../etc.jpg",
            "/x/assets/backgrounds/a/b/c.jpg",
            "/x/assets/backgrounds/macOS/tahoe-dark.png",
            "/x/assets/backgrounds/macOS/",
        ] {
            assert_eq!(catalogue_wallpaper_tail(path), None, "{path}");
        }
    }

    #[test]
    fn a_missing_path_finds_a_registered_copy() {
        let root = tempfile::tempdir().unwrap();
        let theme = root.path().join("remap-test");
        std::fs::create_dir_all(&theme).unwrap();
        std::fs::write(theme.join("one.jpg"), b"x").unwrap();
        register_wallpaper_dir(root.path().to_path_buf());

        assert_eq!(
            locate_catalogue_wallpaper(
                "/Applications/Cap.app/Contents/Resources/assets/backgrounds/remap-test/one.jpg"
            ),
            Some(theme.join("one.jpg"))
        );
        assert_eq!(
            locate_catalogue_wallpaper("/gone/assets/backgrounds/remap-test/two.jpg"),
            None
        );
    }
}
