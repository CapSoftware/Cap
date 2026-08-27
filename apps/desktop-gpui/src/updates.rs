//! Update discovery for sessions owned by GPUI.
//!
//! The endpoint response is advisory only. GPUI never downloads or installs
//! it; accepting the prompt hands control to Tauri, which repeats the check
//! and enforces the signed updater contract before changing the app bundle.

use std::time::Duration;

use futures_util::future::{Either, select};
use gpui::{App, Global};
use semver::Version;
use serde::Deserialize;

use crate::{
    session::RecordingSession,
    store::{GeneralSettings, UpdateChannel},
};

const UPDATE_ENDPOINT: &str =
    "https://cdn.crabnebula.app/update/cap/cap/{target}/{current_version}";
const STABLE_FIRST_CHECK_DELAY: Duration = Duration::from_secs(10);
const NIGHTLY_FIRST_CHECK_DELAY: Duration = Duration::from_secs(60);
const NIGHTLY_CHECK_INTERVAL: Duration = Duration::from_secs(2 * 60 * 60);
const BUSY_RETRY_DELAY: Duration = Duration::from_secs(5 * 60);

#[derive(Deserialize)]
struct AvailableUpdate {
    version: String,
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

struct UpdateScheduler {
    wake: flume::Sender<()>,
    pending: PendingUpdateRequests,
    manual_in_flight: bool,
}

impl Global for UpdateScheduler {}

fn updater_target() -> Result<String, String> {
    let arch = if cfg!(target_arch = "aarch64") {
        "aarch64"
    } else {
        "x86_64"
    };

    #[cfg(target_os = "linux")]
    {
        cap_utils::linux_package::updater_target(arch)
    }
    #[cfg(not(target_os = "linux"))]
    {
        let platform = if cfg!(target_os = "macos") {
            "darwin"
        } else {
            "windows"
        };
        Ok(format!("{platform}-{arch}"))
    }
}

fn endpoint(channel: UpdateChannel) -> Result<String, String> {
    let url = UPDATE_ENDPOINT
        .replace("{target}", &updater_target()?)
        .replace("{current_version}", env!("CARGO_PKG_VERSION"));
    Ok(match channel {
        UpdateChannel::Stable => url,
        UpdateChannel::Nightly => format!("{url}?channel=nightly"),
    })
}

async fn remote_version(channel: UpdateChannel) -> Result<Option<Version>, String> {
    let response = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|error| error.to_string())?
        .get(endpoint(channel)?)
        .send()
        .await
        .map_err(|error| error.to_string())?;

    if response.status() == reqwest::StatusCode::NO_CONTENT {
        return Ok(None);
    }

    let update = response
        .error_for_status()
        .map_err(|error| error.to_string())?
        .json::<AvailableUpdate>()
        .await
        .map_err(|error| error.to_string())?;
    Version::parse(&update.version)
        .map(Some)
        .map_err(|error| error.to_string())
}

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

async fn available_version(channel: UpdateChannel) -> Result<Option<Version>, String> {
    let current = Version::parse(env!("CARGO_PKG_VERSION")).map_err(|error| error.to_string())?;
    let stable = remote_version(UpdateChannel::Stable)
        .await
        .map(|candidate| {
            candidate.filter(|remote| qualifies(&current, remote, channel, UpdateChannel::Stable))
        });

    if channel == UpdateChannel::Stable {
        return stable;
    }

    let nightly = remote_version(UpdateChannel::Nightly)
        .await
        .map(|candidate| {
            candidate.filter(|remote| qualifies(&current, remote, channel, UpdateChannel::Nightly))
        });

    select_available_version(stable, nightly)
}

fn select_available_version(
    stable: Result<Option<Version>, String>,
    nightly: Result<Option<Version>, String>,
) -> Result<Option<Version>, String> {
    match (stable, nightly) {
        (Ok(Some(stable)), Ok(Some(nightly))) => Ok(Some(stable.max(nightly))),
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

pub(crate) fn check_manually(cx: &mut App) {
    if !cx.has_global::<UpdateScheduler>() {
        return;
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

pub(crate) fn schedule_startup_check(cx: &mut App) {
    let (wake, requests) = flume::bounded(1);
    cx.set_global(UpdateScheduler {
        wake,
        pending: PendingUpdateRequests::default(),
        manual_in_flight: false,
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

            if cx.update(work_in_flight) {
                if manual {
                    crate::platform::activate_app();
                    crate::platform::alert_dialog(
                        "Cap is busy",
                        "Finish your recording, export, upload, import, or transcription task before checking for updates.",
                    );
                    cx.update(|cx| finish_manual_check(cx, true));
                } else {
                    delay = Some(BUSY_RETRY_DELAY);
                }
                continue;
            }

            let result = match cx
                .update(|cx| gpui_tokio::Tokio::spawn(cx, available_version(channel)))
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

            let version = match result {
                Ok(Some(version)) => version,
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

            if !manual && ignored_version.as_ref() == Some(&version) {
                continue;
            }

            if cx.update(work_in_flight) {
                if manual {
                    crate::platform::activate_app();
                    crate::platform::alert_dialog(
                        "Cap is busy",
                        "Finish your recording, export, upload, import, or transcription task before checking for updates.",
                    );
                    cx.update(|cx| finish_manual_check(cx, true));
                } else {
                    delay = Some(BUSY_RETRY_DELAY);
                }
                continue;
            }

            crate::platform::activate_app();
            if crate::platform::confirm_dialog(
                "Update Cap",
                &format!("Version {version} of Cap is available. Would you like to install it?"),
                "Update",
                "Ignore",
                false,
            ) {
                cx.update(|cx| {
                    finish_manual_check(cx, manual);
                    crate::settings_pages::start_update_handoff(cx);
                });
            } else {
                ignored_version = Some(version);
                cx.update(|cx| finish_manual_check(cx, manual));
            }
        }
    })
    .detach();
}

#[cfg(test)]
mod tests {
    use super::*;

    fn version(value: &str) -> Version {
        Version::parse(value).unwrap()
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
            select_available_version(Err("stable unavailable".into()), Ok(Some(version("0.6.1"))))
                .unwrap(),
            Some(version("0.6.1")),
        );
        assert_eq!(
            select_available_version(
                Ok(Some(version("0.6.2"))),
                Err("nightly unavailable".into())
            )
            .unwrap(),
            Some(version("0.6.2")),
        );
        assert_eq!(
            select_available_version(
                Err("stable unavailable".into()),
                Err("nightly unavailable".into()),
            ),
            Err("stable unavailable".into()),
        );
    }

    #[test]
    fn nightly_channel_prefers_the_newest_successful_version() {
        assert_eq!(
            select_available_version(
                Ok(Some(version("0.6.1"))),
                Ok(Some(version("0.6.2-nightly.4"))),
            )
            .unwrap(),
            Some(version("0.6.2-nightly.4")),
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
}
