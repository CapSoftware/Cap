use std::{path::PathBuf, time::Duration};

use futures_util::future::{Either, select};
use gpui::{App, Global};
use semver::Version;

use crate::{
    installer::{self, ArtifactKind, Release},
    session::RecordingSession,
    store::{GeneralSettings, UpdateChannel},
};

const STABLE_FIRST_CHECK_DELAY: Duration = Duration::from_secs(10);
const NIGHTLY_FIRST_CHECK_DELAY: Duration = Duration::from_secs(60);
const NIGHTLY_CHECK_INTERVAL: Duration = Duration::from_secs(2 * 60 * 60);
const BUSY_RETRY_DELAY: Duration = Duration::from_secs(5 * 60);
const BUSY_MESSAGE: &str =
    "Finish your recording, export, upload, import, or transcription task before updating Cap.";

#[derive(Clone, Debug, Default, PartialEq)]
pub(crate) enum UpdateStatus {
    #[default]
    Idle,
    Downloading {
        version: Version,
        fraction: Option<f32>,
    },
    Ready {
        version: Version,
    },
    Installing {
        version: Version,
    },
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
struct PendingUpdateRequests {
    manual: bool,
    channel: Option<UpdateChannel>,
}

impl PendingUpdateRequests {
    fn request_manual(&mut self, manual_in_flight: bool) -> bool {
        if self.manual || manual_in_flight {
            return false;
        }

        self.manual = true;
        true
    }

    fn request_channel(&mut self, channel: UpdateChannel) {
        self.channel = Some(channel);
    }
}

struct StagedUpdate {
    kind: ArtifactKind,
    package: PathBuf,
}

struct UpdateScheduler {
    wake: flume::Sender<()>,
    pending: PendingUpdateRequests,
    manual_in_flight: bool,
    status: UpdateStatus,
    staged: Option<StagedUpdate>,
    download: Option<gpui::Task<()>>,
}

impl Global for UpdateScheduler {}

fn qualifies(
    current: &Version,
    remote: &Version,
    configured_channel: UpdateChannel,
    remote_channel: UpdateChannel,
) -> bool {
    remote > current
        || (configured_channel == UpdateChannel::Stable
            && remote_channel == UpdateChannel::Stable
            && !current.pre.is_empty()
            && remote.pre.is_empty()
            && remote != current)
}

fn current_version() -> Result<Version, String> {
    Version::parse(env!("CARGO_PKG_VERSION")).map_err(|error| error.to_string())
}

async fn available_release(channel: UpdateChannel) -> Result<Option<Release>, String> {
    let current = current_version()?;
    let stable = installer::fetch_release(UpdateChannel::Stable, &current)
        .await
        .map(|candidate| {
            candidate.filter(|remote| {
                qualifies(&current, &remote.version, channel, UpdateChannel::Stable)
            })
        });

    if channel == UpdateChannel::Stable {
        return stable;
    }

    let nightly = installer::fetch_release(UpdateChannel::Nightly, &current)
        .await
        .map(|candidate| {
            candidate.filter(|remote| {
                qualifies(&current, &remote.version, channel, UpdateChannel::Nightly)
            })
        });

    select_available_release(stable, nightly)
}

fn select_available_release(
    stable: Result<Option<Release>, String>,
    nightly: Result<Option<Release>, String>,
) -> Result<Option<Release>, String> {
    match (stable, nightly) {
        (Ok(Some(stable)), Ok(Some(nightly))) => Ok(Some(if nightly.version > stable.version {
            nightly
        } else {
            stable
        })),
        (Ok(stable), Ok(nightly)) => Ok(stable.or(nightly)),
        (Ok(candidate), Err(error)) | (Err(error), Ok(candidate)) => {
            tracing::warn!("update check failed for one channel: {error}");
            Ok(candidate)
        }
        (Err(error), Err(_)) => Err(error),
    }
}

pub(crate) fn work_in_flight(cx: &mut App) -> bool {
    RecordingSession::recording_in_flight(cx)
        || crate::app_windows::export_in_flight(cx)
        || crate::import::imports_in_flight(cx)
        || crate::transcription::work_in_flight()
}

pub(crate) fn status(cx: &App) -> UpdateStatus {
    if cx.has_global::<UpdateScheduler>() {
        cx.global::<UpdateScheduler>().status.clone()
    } else {
        UpdateStatus::Idle
    }
}

fn set_status(status: UpdateStatus, cx: &mut App) {
    let scheduler = cx.global_mut::<UpdateScheduler>();
    if scheduler.status == status {
        return;
    }
    scheduler.status = status;
    crate::app_windows::refresh_settings(cx);
}

pub(crate) fn check_manually(cx: &mut App) {
    if !cx.has_global::<UpdateScheduler>() {
        return;
    }

    match status(cx) {
        UpdateStatus::Ready { .. } => {
            prompt_restart(cx);
            return;
        }
        UpdateStatus::Downloading { version, .. } | UpdateStatus::Installing { version } => {
            cx.spawn(async move |_| {
                crate::platform::activate_app();
                crate::platform::alert_dialog(
                    "Update Cap",
                    &format!("Cap is already getting version {version} ready."),
                );
            })
            .detach();
            return;
        }
        UpdateStatus::Idle => {}
    }

    let scheduler = cx.global_mut::<UpdateScheduler>();
    if !scheduler.pending.request_manual(scheduler.manual_in_flight) {
        return;
    }

    let _ = scheduler.wake.try_send(());
}

pub(crate) fn update_channel_changed(channel: UpdateChannel, cx: &mut App) {
    if !cx.has_global::<UpdateScheduler>() {
        return;
    }

    let scheduler = cx.global_mut::<UpdateScheduler>();
    scheduler.pending.request_channel(channel);
    let _ = scheduler.wake.try_send(());
}

fn first_check_delay(channel: UpdateChannel) -> Duration {
    match channel {
        UpdateChannel::Stable => STABLE_FIRST_CHECK_DELAY,
        UpdateChannel::Nightly => NIGHTLY_FIRST_CHECK_DELAY,
    }
}

fn next_check_delay(channel: UpdateChannel) -> Option<Duration> {
    (channel == UpdateChannel::Nightly).then_some(NIGHTLY_CHECK_INTERVAL)
}

fn finish_manual_check(cx: &mut App, manual: bool) {
    if manual {
        cx.global_mut::<UpdateScheduler>().manual_in_flight = false;
    }
}

fn busy_alert(cx: &mut App) {
    cx.spawn(async move |_| {
        crate::platform::activate_app();
        crate::platform::alert_dialog("Cap is busy", BUSY_MESSAGE);
    })
    .detach();
}

pub(crate) fn schedule_startup_check(cx: &mut App) {
    let (wake, requests) = flume::bounded(1);
    cx.set_global(UpdateScheduler {
        wake,
        pending: PendingUpdateRequests::default(),
        manual_in_flight: false,
        status: UpdateStatus::Idle,
        staged: None,
        download: None,
    });

    cx.spawn(async move |cx| {
        let mut channel = cx
            .background_executor()
            .spawn(async { GeneralSettings::load().update_channel })
            .await;
        let mut delay = (!cfg!(debug_assertions)).then(|| first_check_delay(channel));
        let mut ignored_version: Option<Version> = None;

        loop {
            let signaled = match delay {
                Some(delay) => {
                    let timer = cx.background_executor().timer(delay);
                    let request = requests.recv_async();
                    futures_util::pin_mut!(timer, request);
                    match select(timer, request).await {
                        Either::Left(_) => false,
                        Either::Right((Ok(()), _)) => true,
                        Either::Right((Err(_), _)) => return,
                    }
                }
                None => {
                    if requests.recv_async().await.is_err() {
                        return;
                    }
                    true
                }
            };

            let request = cx.update(|cx| {
                let scheduler = cx.global_mut::<UpdateScheduler>();
                std::mem::take(&mut scheduler.pending)
            });

            if signaled && request == PendingUpdateRequests::default() {
                continue;
            }

            if let Some(next_channel) = request.channel {
                channel = next_channel;
                ignored_version = None;
            }

            let manual = request.manual;
            if cfg!(debug_assertions) && !manual {
                delay = None;
                continue;
            }

            if manual {
                cx.update(|cx| cx.global_mut::<UpdateScheduler>().manual_in_flight = true);
            }

            delay = next_check_delay(channel);

            if cx.update(|cx| status(cx) != UpdateStatus::Idle) {
                cx.update(|cx| finish_manual_check(cx, manual));
                continue;
            }

            let result = match cx
                .update(|cx| gpui_tokio::Tokio::spawn(cx, available_release(channel)))
                .await
            {
                Ok(result) => result,
                Err(error) => Err(error.to_string()),
            };

            let superseded = cx.update(|cx| {
                let scheduler = cx.global_mut::<UpdateScheduler>();
                let channel_changed = scheduler.pending.channel.is_some();
                if channel_changed && manual {
                    scheduler.pending.manual = true;
                    scheduler.manual_in_flight = false;
                }
                channel_changed || (!manual && scheduler.pending.manual)
            });
            if superseded {
                continue;
            }

            let release = match result {
                Ok(Some(release)) => release,
                Ok(None) => {
                    if manual {
                        crate::platform::activate_app();
                        crate::platform::alert_dialog(
                            "No Update Available",
                            "You're already using the latest version of Cap.",
                        );
                        cx.update(|cx| finish_manual_check(cx, true));
                    }
                    continue;
                }
                Err(error) => {
                    tracing::warn!("update check failed: {error}");
                    if manual {
                        crate::platform::activate_app();
                        crate::platform::alert_dialog(
                            "Update Cap",
                            &format!("Couldn't check for updates: {error}"),
                        );
                        cx.update(|cx| finish_manual_check(cx, true));
                    }
                    continue;
                }
            };

            if !manual && ignored_version.as_ref() == Some(&release.version) {
                continue;
            }

            crate::platform::activate_app();
            let accepted = crate::platform::confirm_dialog(
                "Update Cap",
                &format!(
                    "Version {} of Cap is available. Cap will download it in the background and let you know when it's ready to install.",
                    release.version
                ),
                "Download",
                "Not Now",
                false,
            );
            cx.update(|cx| finish_manual_check(cx, manual));
            if accepted {
                cx.update(|cx| start_download(release, cx));
            } else {
                ignored_version = Some(release.version);
            }
        }
    })
    .detach();
}

fn start_download(release: Release, cx: &mut App) {
    let kind = match installer::update_platform()
        .and_then(|platform| ArtifactKind::for_platform(&platform))
    {
        Ok(kind) => kind,
        Err(error) => {
            update_failed(&error, cx);
            return;
        }
    };

    let version = release.version.clone();
    set_status(
        UpdateStatus::Downloading {
            version: version.clone(),
            fraction: None,
        },
        cx,
    );

    let (progress_sender, progress) = flume::bounded::<Option<f32>>(1);
    let download = gpui_tokio::Tokio::spawn(cx, async move {
        let mut reported = None::<u16>;
        installer::download(kind, &release, move |done, total| {
            let fraction = total
                .filter(|total| *total > 0)
                .map(|total| (done as f64 / total as f64).clamp(0., 1.) as f32);
            let step = fraction.map(|fraction| (fraction * 100.) as u16);
            if step != reported {
                reported = step;
                let _ = progress_sender.try_send(fraction);
            }
        })
        .await
    });

    let task = cx.spawn(async move |cx| {
        let progress_version = version.clone();
        let progress_updates = cx.spawn(async move |cx| {
            while let Ok(fraction) = progress.recv_async().await {
                cx.update(|cx| {
                    set_status(
                        UpdateStatus::Downloading {
                            version: progress_version.clone(),
                            fraction,
                        },
                        cx,
                    )
                });
            }
        });

        let result = match download.await {
            Ok(result) => result,
            Err(error) => Err(error.to_string()),
        };
        drop(progress_updates);

        cx.update(|cx| {
            cx.global_mut::<UpdateScheduler>().download = None;
            match result {
                Ok(package) => {
                    tracing::info!(%version, path = %package.display(), "update downloaded and verified");
                    cx.global_mut::<UpdateScheduler>().staged =
                        Some(StagedUpdate { kind, package });
                    set_status(UpdateStatus::Ready { version }, cx);
                    prompt_restart(cx);
                }
                Err(error) => {
                    tracing::warn!(%version, "update download failed: {error}");
                    update_failed(&format!("Couldn't download version {version}: {error}"), cx);
                }
            }
        });
    });
    cx.global_mut::<UpdateScheduler>().download = Some(task);
}

fn update_failed(message: &str, cx: &mut App) {
    set_status(UpdateStatus::Idle, cx);
    let message =
        format!("{message}\n\nYou can always download the latest version from cap.so/download.");
    cx.spawn(async move |_| {
        crate::platform::activate_app();
        crate::platform::alert_dialog("Update Cap", &message);
    })
    .detach();
}

fn prompt_restart(cx: &mut App) {
    let UpdateStatus::Ready { version } = status(cx) else {
        return;
    };
    if work_in_flight(cx) {
        tracing::info!(%version, "update ready; waiting for in-flight work before prompting");
        cx.spawn(async move |cx| {
            cx.background_executor().timer(BUSY_RETRY_DELAY).await;
            cx.update(prompt_restart);
        })
        .detach();
        return;
    }

    cx.spawn(async move |cx| {
        crate::platform::activate_app();
        if crate::platform::confirm_dialog(
            "Update Cap",
            &format!("Cap {version} is ready. Restart Cap to finish updating."),
            "Restart Now",
            "Later",
            false,
        ) {
            cx.update(install_and_relaunch);
        }
    })
    .detach();
}

pub(crate) fn install_and_relaunch(cx: &mut App) {
    if !cx.has_global::<UpdateScheduler>() {
        return;
    }
    let UpdateStatus::Ready { version } = status(cx) else {
        return;
    };
    if work_in_flight(cx) {
        busy_alert(cx);
        return;
    }
    if let Err(error) = crate::app_windows::flush_pending_editor_saves(cx) {
        cx.spawn(async move |_| {
            crate::platform::alert_dialog("Cap is still open", &error);
        })
        .detach();
        return;
    }
    let Some((package, kind)) = cx
        .global::<UpdateScheduler>()
        .staged
        .as_ref()
        .map(|staged| (staged.package.clone(), staged.kind))
    else {
        return;
    };

    set_status(
        UpdateStatus::Installing {
            version: version.clone(),
        },
        cx,
    );
    cx.spawn(async move |cx| {
        let applied = cx
            .background_executor()
            .spawn(async move { apply(&package, kind) })
            .await;
        cx.update(|cx| match applied {
            Ok(Some(executable)) => {
                tracing::info!(%version, "update installed; relaunching");
                if let Err(error) = crate::permissions::relaunch_executable(&executable, cx) {
                    tracing::error!(%error, "could not relaunch after updating");
                    crate::menus::quit(cx);
                }
            }
            Ok(None) => {
                tracing::info!(%version, "update installer started; quitting");
                crate::menus::quit(cx);
            }
            Err(error) => {
                tracing::error!(%version, "update install failed: {error}");
                cx.global_mut::<UpdateScheduler>().staged = None;
                update_failed(&format!("Couldn't install version {version}: {error}"), cx);
            }
        });
    })
    .detach();
}

fn apply(package: &std::path::Path, kind: ArtifactKind) -> Result<Option<PathBuf>, String> {
    installer::check_artifact_kind(package, kind)?;
    apply_package(package, kind)
}

#[cfg(target_os = "macos")]
fn apply_package(
    package: &std::path::Path,
    _kind: ArtifactKind,
) -> Result<Option<PathBuf>, String> {
    let executable = std::env::current_exe().map_err(|error| error.to_string())?;
    let bundle = executable
        .ancestors()
        .find(|path| path.extension().is_some_and(|extension| extension == "app"))
        .ok_or_else(|| "This copy of Cap isn't running from an app bundle".to_string())?;
    installer::install_app_bundle(package, bundle)?;
    Ok(Some(executable))
}

#[cfg(windows)]
fn apply_package(
    package: &std::path::Path,
    _kind: ArtifactKind,
) -> Result<Option<PathBuf>, String> {
    installer::launch_installer(package, &["/P", "/R", "/UPDATE"])?;
    Ok(None)
}

#[cfg(target_os = "linux")]
fn apply_package(package: &std::path::Path, kind: ArtifactKind) -> Result<Option<PathBuf>, String> {
    match kind {
        ArtifactKind::Deb => {
            let executable = std::env::current_exe().map_err(|error| error.to_string())?;
            let executable = without_deleted_suffix(&executable);
            installer::install_deb(package)?;
            Ok(Some(executable))
        }
        ArtifactKind::AppImage => {
            let image = std::env::var_os("APPIMAGE")
                .map(PathBuf::from)
                .filter(|path| path.is_absolute())
                .ok_or_else(|| "This copy of Cap isn't running from an AppImage".to_string())?;
            installer::install_appimage(package, &image)?;
            Ok(Some(image))
        }
        ArtifactKind::AppArchive | ArtifactKind::NsisInstaller => {
            Err("This package can't be installed on Linux".to_string())
        }
    }
}

#[cfg(any(target_os = "linux", test))]
fn without_deleted_suffix(executable: &std::path::Path) -> PathBuf {
    let path = executable.to_string_lossy();
    PathBuf::from(path.strip_suffix(" (deleted)").unwrap_or(&path))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn version(value: &str) -> Version {
        Version::parse(value).unwrap()
    }

    fn release(value: &str) -> Release {
        Release {
            version: version(value),
            url: format!("https://cdn.crabnebula.app/asset/{value}"),
            signature: "c2ln".to_string(),
            notes: None,
        }
    }

    #[test]
    fn stable_channel_accepts_newer_versions_and_explicit_prerelease_downgrades() {
        assert!(qualifies(
            &version("0.6.0"),
            &version("0.6.1"),
            UpdateChannel::Stable,
            UpdateChannel::Stable,
        ));
        assert!(qualifies(
            &version("0.6.1-nightly.4"),
            &version("0.6.0"),
            UpdateChannel::Stable,
            UpdateChannel::Stable,
        ));
        assert!(!qualifies(
            &version("0.6.1"),
            &version("0.6.0"),
            UpdateChannel::Stable,
            UpdateChannel::Stable,
        ));
    }

    #[test]
    fn nightly_channel_never_uses_the_stable_downgrade_rule() {
        assert!(!qualifies(
            &version("0.6.1-nightly.4"),
            &version("0.6.0"),
            UpdateChannel::Nightly,
            UpdateChannel::Stable,
        ));
        assert!(qualifies(
            &version("0.6.1-nightly.4"),
            &version("0.6.1-nightly.5"),
            UpdateChannel::Nightly,
            UpdateChannel::Nightly,
        ));
    }

    #[test]
    fn nightly_channel_survives_individual_endpoint_failures() {
        assert_eq!(
            select_available_release(Err("stable unavailable".into()), Ok(Some(release("0.6.1"))))
                .unwrap(),
            Some(release("0.6.1")),
        );
        assert_eq!(
            select_available_release(
                Ok(Some(release("0.6.2"))),
                Err("nightly unavailable".into())
            )
            .unwrap(),
            Some(release("0.6.2")),
        );
        assert_eq!(
            select_available_release(
                Err("stable unavailable".into()),
                Err("nightly unavailable".into()),
            ),
            Err("stable unavailable".into()),
        );
    }

    #[test]
    fn nightly_channel_prefers_the_newest_successful_version() {
        assert_eq!(
            select_available_release(
                Ok(Some(release("0.6.1"))),
                Ok(Some(release("0.6.2-nightly.4"))),
            )
            .unwrap(),
            Some(release("0.6.2-nightly.4")),
        );
        assert_eq!(
            select_available_release(
                Ok(Some(release("0.6.3"))),
                Ok(Some(release("0.6.3-nightly.9"))),
            )
            .unwrap(),
            Some(release("0.6.3")),
        );
    }

    #[test]
    fn check_cadence_preserves_each_update_channel_contract() {
        assert_eq!(
            first_check_delay(UpdateChannel::Stable),
            Duration::from_secs(10)
        );
        assert_eq!(
            first_check_delay(UpdateChannel::Nightly),
            Duration::from_secs(60)
        );
        assert_eq!(next_check_delay(UpdateChannel::Stable), None);
        assert_eq!(
            next_check_delay(UpdateChannel::Nightly),
            Some(Duration::from_secs(2 * 60 * 60))
        );
    }

    #[test]
    fn manual_checks_coalesce_while_pending_or_running() {
        let mut requests = PendingUpdateRequests::default();

        assert!(requests.request_manual(false));
        assert!(!requests.request_manual(false));

        requests.manual = false;
        assert!(!requests.request_manual(true));
        assert!(requests.request_manual(false));
    }

    #[test]
    fn channel_changes_coalesce_without_losing_manual_checks() {
        let mut requests = PendingUpdateRequests::default();

        assert!(requests.request_manual(false));
        requests.request_channel(UpdateChannel::Nightly);
        requests.request_channel(UpdateChannel::Stable);

        assert_eq!(
            requests,
            PendingUpdateRequests {
                manual: true,
                channel: Some(UpdateChannel::Stable),
            }
        );
    }

    #[test]
    fn recording_exports_and_uploads_remain_update_blockers_until_finished() {
        use crate::editor_export::ExportPhase;

        for phase in [
            ExportPhase::Starting,
            ExportPhase::Rendering,
            ExportPhase::Copying,
            ExportPhase::Uploading,
        ] {
            assert!(phase.is_busy());
        }

        for phase in [ExportPhase::Idle, ExportPhase::Done, ExportPhase::Failed] {
            assert!(!phase.is_busy());
        }
    }

    #[test]
    fn deb_relaunch_targets_the_installed_path_even_after_replacement() {
        assert_eq!(
            without_deleted_suffix(std::path::Path::new("/usr/bin/Cap (deleted)")),
            PathBuf::from("/usr/bin/Cap")
        );
        assert_eq!(
            without_deleted_suffix(std::path::Path::new("/usr/bin/Cap")),
            PathBuf::from("/usr/bin/Cap")
        );
    }
}
