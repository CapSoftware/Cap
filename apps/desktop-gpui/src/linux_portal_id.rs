//! Gives Cap an app id the desktop portals accept when nothing else does.
//!
//! xdg-desktop-portal names a host app after the systemd unit that launched
//! it (`app-gnome-Cap-1234.scope` from GNOME's app grid). A launch from a
//! terminal or an AppImage has no such unit, and the GlobalShortcuts portal
//! then refuses Cap ("An app id is required"), so the recording Stop control
//! falls back to the tray. `org.freedesktop.host.portal.Registry` lets the app
//! name itself instead, once, before its first portal call, and only with an
//! id a `.desktop` file carries.

use std::{
    ffi::OsString,
    path::{Path, PathBuf},
    time::Duration,
};

pub const PORTAL_APP_ID: &str = "so.cap.Cap";
const PACKAGED_APP_ID: &str = "Cap";

/// The app id xdg-desktop-portal reads from a launcher's systemd unit:
/// `app-[<launcher>-]<id>-<random>.scope` or `app-[<launcher>-]<id>[@<random>].service`.
pub fn unit_app_id(cgroup: &str) -> Option<String> {
    let unit = cgroup.lines().find_map(|line| {
        let path = line.rsplit(':').next()?;
        path.rsplit('/')
            .find(|part| part.starts_with("app-"))
            .map(str::to_string)
    })?;
    let name = unit.strip_prefix("app-")?;
    let name = if let Some(name) = name.strip_suffix(".scope") {
        name.rsplit_once('-')?.0
    } else {
        let name = name.strip_suffix(".service")?;
        name.split_once('@').map_or(name, |(name, _)| name)
    };
    let id = name.rsplit('-').next()?;
    (!id.is_empty()).then(|| id.to_string())
}

fn application_dirs(
    data_home: Option<OsString>,
    data_dirs: Option<OsString>,
    home: Option<OsString>,
) -> Option<(PathBuf, Vec<PathBuf>)> {
    let user = data_home
        .filter(|dir| !dir.is_empty())
        .map(PathBuf::from)
        .or_else(|| {
            home.filter(|home| !home.is_empty())
                .map(|home| PathBuf::from(home).join(".local/share"))
        })
        .filter(|dir| dir.is_absolute())?
        .join("applications");
    let system = data_dirs
        .filter(|dirs| !dirs.is_empty())
        .unwrap_or_else(|| "/usr/local/share:/usr/share".into());
    let mut dirs = vec![user.clone()];
    dirs.extend(std::env::split_paths(&system).map(|dir| dir.join("applications")));
    Some((user, dirs))
}

/// A hidden entry for [`PORTAL_APP_ID`]: the portal needs one to accept the
/// id, and GNOME names the app from it in the shortcut dialog. GLib, which
/// the portal loads it with, looks the program up before expanding `%%`, so
/// `env` is the program and Cap's path its argument.
pub fn desktop_entry(exec: &Path) -> String {
    format!(
        "[Desktop Entry]\nType=Application\nName=Cap\nIcon=Cap\nExec=env {}\nNoDisplay=true\nStartupWMClass=Cap\n",
        exec_argument(&exec.to_string_lossy())
    )
}

/// One quoted `Exec` argument. Inside quotes `"`, `` ` ``, `$` and `\` take a
/// backslash; the string escape then doubles every backslash, and `%` (a
/// field code anywhere in the line) becomes `%%`.
fn exec_argument(value: &str) -> String {
    let mut quoted = String::with_capacity(value.len() + 2);
    for c in value.chars() {
        if matches!(c, '"' | '`' | '$' | '\\') {
            quoted.push('\\');
        }
        quoted.push(c);
    }
    format!("\"{}\"", quoted.replace('\\', "\\\\").replace('%', "%%"))
}

/// Finds or writes the `.desktop` file for [`PORTAL_APP_ID`], returning
/// whether one exists afterwards.
pub fn ensure_desktop_entry(user_dir: &Path, dirs: &[PathBuf], exec: &Path) -> bool {
    let file = format!("{PORTAL_APP_ID}.desktop");
    if dirs.iter().any(|dir| dir.join(&file).is_file()) {
        return true;
    }
    let path = user_dir.join(&file);
    let written =
        std::fs::create_dir_all(user_dir).and_then(|()| std::fs::write(&path, desktop_entry(exec)));
    match written {
        Ok(()) => true,
        Err(error) => {
            tracing::info!(path = %path.display(), %error, "could not write the portal app id's desktop entry");
            false
        }
    }
}

/// Registers [`PORTAL_APP_ID`] when the portal has no app id for Cap. Must
/// run before any portal call on the process's portal connection, gpui's
/// appearance read included, and on the runtime that keeps that connection.
pub async fn register() {
    // The desktop harness turns this off to keep covering the tray Stop
    // control, which a terminal launch otherwise no longer needs.
    if std::env::var_os("CAP_GPUI_PORTAL_APP_ID").is_some_and(|value| value == "0") {
        return;
    }
    let cgroup = std::fs::read_to_string("/proc/self/cgroup").unwrap_or_default();
    if let Some(id) = unit_app_id(&cgroup)
        && (id == PACKAGED_APP_ID || id == PORTAL_APP_ID)
    {
        tracing::info!(%id, "portals know Cap from its launcher's unit");
        return;
    }
    let exec = std::env::var_os("APPIMAGE")
        .map(PathBuf::from)
        .or_else(|| std::env::current_exe().ok());
    let Some(exec) = exec else {
        return;
    };
    let Some((user_dir, dirs)) = application_dirs(
        std::env::var_os("XDG_DATA_HOME"),
        std::env::var_os("XDG_DATA_DIRS"),
        std::env::var_os("HOME"),
    ) else {
        return;
    };
    if !ensure_desktop_entry(&user_dir, &dirs, &exec) {
        return;
    }
    let Ok(app_id) = ashpd::AppID::try_from(PORTAL_APP_ID) else {
        return;
    };
    match tokio::time::timeout(Duration::from_secs(3), ashpd::register_host_app(app_id)).await {
        Ok(Ok(())) => tracing::info!(
            app_id = PORTAL_APP_ID,
            "registered Cap's app id with the portals"
        ),
        Ok(Err(error)) => tracing::info!(%error, "the portals did not take Cap's app id"),
        Err(_) => tracing::info!("the portal registry did not answer"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn launcher_units_name_the_app_the_way_the_portal_reads_them() {
        assert_eq!(
            unit_app_id("0::/user.slice/user-1000.slice/user@1000.service/app.slice/app-gnome-Cap-4721.scope").as_deref(),
            Some("Cap")
        );
        assert_eq!(
            unit_app_id("0::/user.slice/user-1000.slice/user@1000.service/app.slice/app-so.cap.Cap-21974.scope").as_deref(),
            Some("so.cap.Cap")
        );
        assert_eq!(
            unit_app_id("0::/user.slice/user-1000.slice/user@1000.service/app.slice/app-flatpak-org.gnome.Ptyxis@1234.service").as_deref(),
            Some("org.gnome.Ptyxis")
        );
        // A terminal's tab, a login shell, an AppImage started from either.
        assert_eq!(
            unit_app_id(
                "0::/user.slice/user-1000.slice/user@1000.service/app.slice/vte-spawn-8d1c.scope"
            ),
            None
        );
        assert_eq!(
            unit_app_id("0::/user.slice/user-1000.slice/session-2.scope"),
            None
        );
        assert_eq!(unit_app_id(""), None);
    }

    #[test]
    fn the_desktop_entry_is_written_once_and_found_anywhere_on_the_data_path() {
        let root = tempfile::tempdir().unwrap();
        let (user, dirs) = application_dirs(
            None,
            Some(root.path().join("system").into_os_string()),
            Some(root.path().join("home").into_os_string()),
        )
        .unwrap();
        assert_eq!(user, root.path().join("home/.local/share/applications"));
        let exec = Path::new(r#"/opt/100% Cap/"beta" $HOME `x`\.AppImage"#);
        assert!(ensure_desktop_entry(&user, &dirs, exec));
        let entry = std::fs::read_to_string(user.join("so.cap.Cap.desktop")).unwrap();
        assert!(entry.contains("NoDisplay=true"));
        assert!(entry.contains(
            r#"Exec=env "/opt/100%% Cap/\\"beta\\" \\$HOME \\`x\\`\\\\.AppImage""#
        ));

        // An entry a package installed wins: nothing is written for the user.
        let packaged = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(packaged.path().join("applications")).unwrap();
        std::fs::write(packaged.path().join("applications/so.cap.Cap.desktop"), "x").unwrap();
        let home = tempfile::tempdir().unwrap();
        let (user, dirs) = application_dirs(
            Some(home.path().join("data").into_os_string()),
            Some(packaged.path().as_os_str().to_owned()),
            None,
        )
        .unwrap();
        assert!(ensure_desktop_entry(&user, &dirs, exec));
        assert!(!user.join("so.cap.Cap.desktop").exists());

        // Without a home there is nowhere safe to write.
        assert!(application_dirs(None, None, None).is_none());
        assert!(application_dirs(Some("relative".into()), None, None).is_none());
    }
}
