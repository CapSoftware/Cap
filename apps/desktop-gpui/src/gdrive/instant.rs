use std::{
    path::{Path, PathBuf},
    sync::{Arc, atomic::AtomicBool},
};

use super::{DriveError, DriveShare, LinkVisibility, ShareFailure, ShareRequest};
use crate::i18n::tr;
use crate::store::PostInstantBehaviour;

const INSTANT_OUTPUT: &str = "content/output.mp4";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Origin {
    Stop,
    Retry,
}

pub(crate) fn share_after_stop(project_dir: PathBuf, cx: &mut gpui::App) {
    start(project_dir, Origin::Stop, cx);
}

pub(crate) fn retry(project_dir: PathBuf, cx: &mut gpui::App) {
    start(project_dir, Origin::Retry, cx);
}

pub(crate) fn link_to_copy(share: &DriveShare) -> String {
    share.web_view_link.clone()
}

fn start(project_dir: PathBuf, origin: Origin, cx: &mut gpui::App) {
    if super::share_in_flight(&project_dir) {
        tracing::info!(dir = %project_dir.display(), "Google Drive upload is already running");
        return;
    }
    notify(
        tr::gdrive::uploading_title().into(),
        tr::gdrive::uploading_body().into(),
        cx,
    );
    let upload = gpui_tokio::Tokio::spawn(cx, share(project_dir.clone()));
    cx.refresh_windows();
    cx.spawn(async move |cx| {
        let result = upload
            .await
            .unwrap_or_else(|error| Err(DriveError::Protocol(error.to_string()).into()));
        cx.update(|cx| {
            finish(&project_dir, origin, result, cx);
            crate::app_windows::refresh_library_after_delete(cx);
            cx.refresh_windows();
        });
    })
    .detach();
}

async fn share(project_dir: PathBuf) -> Result<DriveShare, ShareFailure> {
    let title = super::recording_title(&project_dir);
    super::share_recording(ShareRequest {
        file: project_dir.join(INSTANT_OUTPUT),
        project_dir,
        title,
        progress: Arc::new(|_| {}),
        cancel: Arc::new(AtomicBool::new(false)),
    })
    .await
}

fn finish(
    project_dir: &Path,
    origin: Origin,
    result: Result<DriveShare, ShareFailure>,
    cx: &mut gpui::App,
) {
    match result {
        Ok(share) => {
            let link = link_to_copy(&share);
            cx.write_to_clipboard(gpui::ClipboardItem::new_string(link.clone()));
            if let LinkVisibility::Private(reason) = &share.visibility {
                tracing::info!(
                    dir = %project_dir.display(),
                    message = %super::private_link_message(reason),
                    "Google Drive link is private"
                );
            }
            let (title, body) = success_notice(&share.visibility);
            notify(title, body, cx);
            if opens_link(
                origin,
                crate::store::GeneralSettings::load().post_instant_behaviour(),
            ) {
                cx.open_url(&link);
            }
            if origin == Origin::Stop {
                crate::automation::instant_recording_finished(
                    project_dir.to_path_buf(),
                    Some(link),
                    Some(super::sharing_meta(&share).id),
                    None,
                );
            }
        }
        Err(failure) => {
            tracing::warn!(
                dir = %project_dir.display(),
                ?failure,
                "Google Drive upload failed; the recording stays on this Mac"
            );
            if let Some(body) = failure_notice(&failure) {
                notify(tr::gdrive::share_to_drive().into(), body, cx);
            }
        }
    }
}

fn success_notice(visibility: &LinkVisibility) -> (String, String) {
    let title = tr::gdrive::link_copied_title().to_string();
    let body = tr::gdrive::link_copied_body();
    match visibility {
        LinkVisibility::Public => (title, body.to_string()),
        LinkVisibility::Private(reason) => (
            title,
            format!("{body} {}", super::private_link_message(reason)),
        ),
    }
}

fn failure_notice(failure: &ShareFailure) -> Option<String> {
    match failure {
        ShareFailure::Drive(DriveError::Cancelled) => None,
        _ => Some(super::share_failure_message(failure)),
    }
}

fn opens_link(origin: Origin, behaviour: PostInstantBehaviour) -> bool {
    origin == Origin::Stop && behaviour == PostInstantBehaviour::OpenLink
}

fn notify(title: String, body: String, cx: &gpui::App) {
    if !crate::notifications::enabled() {
        return;
    }
    gpui_tokio::Tokio::spawn(cx, async move {
        match tokio::task::spawn_blocking(move || crate::notifications::show(&title, &body)).await {
            Ok(Ok(())) => {}
            Ok(Err(error)) => {
                tracing::warn!(%error, "Could not show the Google Drive notification");
            }
            Err(error) => {
                tracing::warn!(%error, "The Google Drive notification task failed");
            }
        }
    })
    .detach();
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::gdrive::PrivateReason;

    fn share(link: &str, visibility: LinkVisibility) -> DriveShare {
        DriveShare {
            file_id: "file-1".into(),
            web_view_link: link.into(),
            folder_id: "folder-1".into(),
            visibility,
            reused: false,
        }
    }

    #[test]
    fn the_copied_link_is_the_web_view_link_unchanged() {
        let link = "https://drive.google.com/file/d/file-1/view?usp=drivesdk&resourcekey=0-fake";
        let copied = link_to_copy(&share(link, LinkVisibility::Public));
        assert_eq!(copied, link);
        assert!(!copied.contains("recordingStopped"));
    }

    #[test]
    fn only_a_stopped_recording_set_to_open_links_opens_the_link() {
        assert!(opens_link(Origin::Stop, PostInstantBehaviour::OpenLink));
        assert!(!opens_link(Origin::Stop, PostInstantBehaviour::CopyLink));
        assert!(!opens_link(Origin::Stop, PostInstantBehaviour::ShowCap));
        assert!(!opens_link(Origin::Retry, PostInstantBehaviour::OpenLink));
    }

    #[test]
    fn a_private_link_says_why_in_the_notice() {
        let (title, body) = success_notice(&LinkVisibility::Public);
        assert_eq!(title, tr::gdrive::link_copied_title());
        assert_eq!(body, tr::gdrive::link_copied_body());
        let (_, body) = success_notice(&LinkVisibility::Private(PrivateReason::RateLimited));
        assert!(body.starts_with(tr::gdrive::link_copied_body()));
        assert!(body.ends_with(tr::gdrive::private_link_busy()));
        let (_, body) = success_notice(&LinkVisibility::Private(PrivateReason::SharingRestricted));
        assert!(body.ends_with(tr::gdrive::private_link()));
    }

    #[test]
    fn a_failed_upload_says_the_recording_is_kept() {
        let notice = |error: DriveError| failure_notice(&ShareFailure::Drive(error));
        assert_eq!(notice(DriveError::Cancelled), None);
        let offline = notice(DriveError::Offline).unwrap();
        assert!(offline.starts_with(tr::gdrive::error_offline()));
        assert!(offline.ends_with(tr::gdrive::kept_locally()));
        let not_connected = notice(DriveError::NotConnected).unwrap();
        assert!(not_connected.starts_with(tr::gdrive::error_not_connected()));
        assert!(not_connected.ends_with(tr::gdrive::kept_locally()));
        assert_eq!(
            notice(DriveError::LocalFile("gone".into())).as_deref(),
            Some(tr::gdrive::error_missing_file())
        );
        assert_eq!(
            failure_notice(&ShareFailure::AlreadyUploading).as_deref(),
            Some(tr::gdrive::already_uploading())
        );
    }
}
