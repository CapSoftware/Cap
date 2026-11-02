//! A `WAYLAND_DISPLAY` that names no running compositor, as a systemd user
//! environment keeps after the Wayland session that set it has ended. gpui
//! picks Wayland whenever the variable is set and cannot start without the
//! compositor, so when the session also has an X display Cap uses that.

use std::{
    ffi::{OsStr, OsString},
    io::ErrorKind,
    os::unix::net::UnixStream,
    path::{Path, PathBuf},
};

fn socket_path(display: &OsStr, runtime_dir: Option<&OsStr>) -> Option<PathBuf> {
    let display = Path::new(display);
    if display.is_absolute() {
        return Some(display.to_path_buf());
    }
    let runtime_dir = Path::new(runtime_dir?);
    runtime_dir
        .is_absolute()
        .then(|| runtime_dir.join(display))
}

/// Only a missing socket or a refused connection counts: anything else, such
/// as a permission error, leaves the session as it is.
fn nothing_listens(path: &Path) -> bool {
    match UnixStream::connect(path) {
        Ok(_) => false,
        Err(error) => matches!(
            error.kind(),
            ErrorKind::NotFound | ErrorKind::ConnectionRefused
        ),
    }
}

pub fn stale_wayland_display() -> Option<OsString> {
    if std::env::var_os("WAYLAND_SOCKET").is_some() {
        return None;
    }
    let display = std::env::var_os("WAYLAND_DISPLAY").filter(|display| !display.is_empty())?;
    std::env::var_os("DISPLAY").filter(|display| !display.is_empty())?;
    let path = socket_path(&display, std::env::var_os("XDG_RUNTIME_DIR").as_deref())?;
    nothing_listens(&path).then_some(display)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::net::UnixListener;

    #[test]
    fn display_names_resolve_in_the_runtime_dir_unless_absolute() {
        assert_eq!(
            socket_path(OsStr::new("wayland-0"), Some(OsStr::new("/run/user/1000"))),
            Some(PathBuf::from("/run/user/1000/wayland-0"))
        );
        assert_eq!(
            socket_path(OsStr::new("/tmp/wl"), None),
            Some(PathBuf::from("/tmp/wl"))
        );
        assert_eq!(socket_path(OsStr::new("wayland-0"), None), None);
        assert_eq!(
            socket_path(OsStr::new("wayland-0"), Some(OsStr::new("relative"))),
            None
        );
    }

    #[test]
    fn only_a_missing_or_refusing_socket_is_stale() {
        let dir = tempfile::tempdir().unwrap();
        let live = dir.path().join("wayland-live");
        let listener = UnixListener::bind(&live).unwrap();
        assert!(!nothing_listens(&live));

        let gone = dir.path().join("wayland-gone");
        drop(UnixListener::bind(&gone).unwrap());
        assert!(nothing_listens(&gone));

        assert!(nothing_listens(&dir.path().join("wayland-missing")));
        drop(listener);
    }
}
