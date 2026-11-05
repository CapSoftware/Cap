use std::{collections::HashSet, path::PathBuf, sync::Arc};

use gpui::{Context, Div, IntoElement, ParentElement, Styled, Window, div, px};

use super::{Page, RecordingsTab, SettingsWindow};
use crate::{
    library::{self, RecordingItem, RecordingMode},
    theme::Theme,
};

const FORK: bool = crate::fork_policy::FORK;

pub(super) const PREVIOUS_VERSIONS_URL: &str = if FORK {
    fork_brand::RELEASES_URL
} else {
    "https://cap.so/download/versions"
};

#[derive(Default)]
pub(super) struct RecordingsFork {
    notice: Option<String>,
    copy_selection: crate::ux_walk_library::WalkSelection,
    sharing_busy: HashSet<PathBuf>,
}

impl RecordingsFork {
    pub(super) fn busy(&self, path: &PathBuf) -> bool {
        self.sharing_busy.contains(path)
    }

    pub(super) fn notice(&self, theme: &Theme) -> Option<Div> {
        self.notice.clone().map(|notice| {
            div()
                .text_size(px(12.))
                .text_color(theme.settings_muted())
                .child(notice)
        })
    }
}

pub(super) fn recording_filter(
    item: &RecordingItem,
    tab: RecordingsTab,
    query: &str,
) -> Option<bool> {
    #[cfg(all(target_os = "macos", feature = "ux-walk"))]
    let walk_tab = tab == RecordingsTab::UxWalk;
    #[cfg(not(all(target_os = "macos", feature = "ux-walk")))]
    let walk_tab = false;
    if item.walk.is_none() && !walk_tab {
        return None;
    }
    let Some(walk) = &item.walk else {
        return Some(false);
    };
    let matches_tab = walk_tab || tab == RecordingsTab::All;
    Some(
        matches_tab
            && (query.is_empty()
                || item.pretty_name.to_lowercase().contains(query)
                || walk.topic.to_lowercase().contains(query)),
    )
}

pub(super) fn sidebar_title() -> Option<Div> {
    FORK.then(|| {
        div()
            .px(px(14.))
            .pb(px(16.))
            .text_size(px(18.))
            .font_weight(gpui::FontWeight::SEMIBOLD)
            .child(fork_brand::APP_NAME)
    })
}

pub(super) fn version_label() -> String {
    if FORK {
        format!("{} v{}", fork_brand::APP_NAME, env!("CARGO_PKG_VERSION"))
    } else {
        format!("v{}", env!("CARGO_PKG_VERSION"))
    }
}

pub(super) fn opens_local(item: &RecordingItem) -> bool {
    FORK && item.mode == RecordingMode::Instant
        && !item.status.is_in_progress()
        && item.status.error().is_none()
}

pub(super) fn row_title(item: &RecordingItem) -> String {
    item.walk
        .as_ref()
        .map(|walk| walk.topic.clone())
        .unwrap_or_else(|| item.pretty_name.clone())
}

pub(super) fn row_icon(item: &RecordingItem) -> &'static str {
    match &item.walk {
        Some(walk) if walk.diatribe => crate::mode_choice::DIATRIBE_ICON,
        Some(_) => "icons/ux-walk.svg",
        None => item.mode.icon(),
    }
}

pub(super) fn row_label(item: &RecordingItem) -> &'static str {
    match &item.walk {
        Some(walk) if walk.diatribe => crate::mode_choice::DIATRIBE_SHORT_NAME,
        Some(_) => fork_brand::WALK_MODE_NAME,
        None => item.mode.label(),
    }
}

pub(super) fn walk_status(item: &RecordingItem) -> Option<&'static str> {
    item.walk.as_ref().map(|walk| walk.status.label())
}

pub(super) fn instant_quality_description() -> &'static str {
    if FORK {
        "Saved as a ready-to-play video on your Mac. Choose the capture resolution here, then share from Recordings when you are ready."
    } else {
        crate::i18n::tr::settings::quality::instant::description()
    }
}

impl SettingsWindow {
    pub(super) fn render_self_host_or_sharing(
        &self,
        window: &Window,
        cx: &mut Context<Self>,
    ) -> gpui::AnyElement {
        if FORK {
            self.render_sharing_shortcut(cx)
        } else {
            self.render_self_host(window, cx).into_any_element()
        }
    }

    pub(super) fn upload_cleanup_row(
        &self,
        label: &'static str,
        description: Option<&'static str>,
        control: gpui::AnyElement,
    ) -> gpui::AnyElement {
        if !FORK {
            return self.setting_row(label, description, control);
        }
        self.setting_row(
            "Original recordings",
            Some(
                "Sharing keeps the original recording on your Mac. Delete it from Recordings when you choose.",
            ),
            div()
                .text_size(px(12.))
                .child("Kept locally")
                .into_any_element(),
        )
    }

    pub(super) fn fork_walk_actions(
        &self,
        mut actions: Div,
        item: &RecordingItem,
        cx: &mut Context<Self>,
    ) -> Div {
        let Some(walk) = &item.walk else {
            return actions;
        };
        let notes = walk.file.clone();
        let (icon, label) = if walk.diatribe {
            (crate::mode_choice::DIATRIBE_ICON, "View notes")
        } else {
            ("icons/ux-walk.svg", "View walk notes")
        };
        actions = actions.child(self.row_button(
            "recording-walk-notes",
            icon,
            label,
            false,
            cx,
            move |_, _, cx| {
                let file = notes.clone();
                cx.defer(move |cx| crate::ux_walk_window::open_saved(file, cx));
            },
        ));
        if walk.items_editable() {
            let items = walk.file.clone();
            actions = actions.child(self.row_button(
                "recording-walk-items",
                "icons/pencil.svg",
                "Edit items",
                false,
                cx,
                move |_, _, cx| {
                    let file = items.clone();
                    cx.defer(move |cx| crate::ux_walk_window::open_saved_items(file, cx));
                },
            ));
        }
        let prompt = walk.file.clone();
        actions.child(self.row_button(
            "recording-walk-copy",
            "icons/copy.svg",
            "Copy agent prompt",
            false,
            cx,
            move |this, window, cx| this.copy_walk_prompt(prompt.clone(), window, cx),
        ))
    }

    pub(super) fn fork_share_actions(
        &self,
        mut actions: Div,
        item: &RecordingItem,
        unavailable: bool,
        cx: &mut Context<Self>,
    ) -> Div {
        if !FORK {
            return actions;
        }
        let mode = item.mode;
        let path = item.path.clone();
        let busy = self.recordings.fork.busy(&path);
        if mode == RecordingMode::Instant {
            let play_path = path.clone();
            actions = actions.child(self.row_button(
                "recording-play",
                "icons/play.svg",
                "Play video",
                unavailable,
                cx,
                move |_, _, cx| library::ux_walk::play_instant_recording(&play_path, cx),
            ));
        }
        let share_path = path.clone();
        actions = actions.child(self.row_button(
            "recording-share",
            "icons/upload-arrow.svg",
            "Share video",
            unavailable || busy,
            cx,
            move |this, window, cx| this.share_recording(share_path.clone(), false, window, cx),
        ));
        if item
            .sharing
            .as_ref()
            .is_some_and(|link| cap_cloud_sharing::is_owned_link(link))
        {
            actions = actions.child(self.row_button(
                "recording-revoke",
                "icons/unplug.svg",
                "Revoke sharing link",
                busy,
                cx,
                move |this, window, cx| this.share_recording(path.clone(), true, window, cx),
            ));
        }
        actions
    }

    fn share_recording(
        &mut self,
        path: PathBuf,
        revoke: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if !cap_cloud_sharing::load().is_ok_and(|settings| settings.enabled) {
            self.set_page(Page::Sharing, window, cx);
            return;
        }
        if !revoke
            && cap_project::RecordingMeta::load_for_project(&path).is_ok_and(|meta| {
                matches!(meta.inner, cap_project::RecordingMetaInner::Studio(_))
                    && !meta.output_path().is_file()
            })
        {
            self.recordings.fork.notice = Some(
                "Export this recording in the editor, then choose Create shareable link.".into(),
            );
            self.open_editor_confirmed(path, false, window, cx);
            return;
        }
        if !self.recordings.fork.sharing_busy.insert(path.clone()) {
            return;
        }
        self.recordings.fork.notice = Some(
            if revoke {
                "Revoking link…"
            } else {
                "Sharing video only. Walk notes and browser traces stay local…"
            }
            .into(),
        );
        cx.notify();
        cx.spawn_in(window, async move |this, cx| {
            let task_path = path.clone();
            let Ok(task) = cx.update(|_, cx| gpui_tokio::Tokio::spawn(cx, async move {
                if revoke {
                    let client = cap_cloud_sharing::SharingClient::configured()?;
                    let mut meta = cap_project::RecordingMeta::load_for_project(&task_path).map_err(|_| "Could not read this recording.")?;
                    let sharing = meta.sharing.as_ref().ok_or("This recording has no sharing link.")?;
                    cap_cloud_sharing::validate_configured_link(&sharing.link)?;
                    client.revoke(&sharing.id).await?;
                    meta.sharing = None;
                    meta.save_for_project().map_err(|_| "Link revoked, but its local metadata could not be updated.")?;
                    Ok(None)
                } else {
                    match crate::upload::upload_exported_video(task_path, None, |_| {}, Arc::new(std::sync::atomic::AtomicBool::new(false))).await? {
                        crate::upload::UploadResult::Success(link) => Ok(Some(link)),
                        _ => Err("Check your sharing server and upload credential in Settings → Sharing.".into()),
                    }
                }
            })) else { return; };
            let result = task.await.unwrap_or_else(|_| Err("Sharing task stopped. Your local recording is safe.".into()));
            let _ = this.update_in(cx, |this, window, cx| {
                this.recordings.fork.sharing_busy.remove(&path);
                this.recordings.fork.notice = Some(match result {
                    Ok(Some(link)) => { if !this.settings.disable_auto_open_links { cx.open_url(&link); } cx.write_to_clipboard(gpui::ClipboardItem::new_string(link)); "Sharing link copied. Anyone with the full link can view it until it expires or is revoked.".into() },
                    Ok(None) => "Sharing link revoked.".into(),
                    Err(error) => error,
                });
                this.refresh_recordings(window, cx);
                cx.notify(); window.refresh();
            });
        }).detach();
    }

    fn copy_walk_prompt(&mut self, file: PathBuf, window: &mut Window, cx: &mut Context<Self>) {
        let revision = self
            .recordings
            .fork
            .copy_selection
            .choose(Some(file.clone()));
        self.recordings.fork.notice = Some("Preparing agent prompt…".into());
        cx.notify();
        cx.spawn_in(window, async move |this, cx| {
            let selected = file.clone();
            let result = cx
                .background_executor()
                .spawn(async move { crate::ux_walk::run_engine("prompt", &file) })
                .await;
            this.update_in(cx, |this, window, cx| {
                if !this
                    .recordings
                    .fork
                    .copy_selection
                    .accepts(&selected, revision)
                {
                    return;
                }
                this.recordings.fork.notice = Some(match result {
                    Ok(prompt) => {
                        cx.write_to_clipboard(gpui::ClipboardItem::new_string(prompt));
                        "Agent prompt copied".into()
                    }
                    Err(error) => format!("Could not copy the agent prompt: {error}"),
                });
                cx.notify();
                window.refresh();
            })
            .ok();
        })
        .detach();
    }
}

#[cfg(test)]
mod tests {
    use super::super::matches_recording_filters;
    use super::super::tests::recording;
    use super::*;

    #[cfg(all(target_os = "macos", feature = "ux-walk"))]
    #[test]
    fn ux_walk_rows_have_a_peer_filter_and_search_their_topics() {
        let mut walk = recording("Cap recording", RecordingMode::Studio);
        walk.walk = Some(crate::ux_walk_library::WalkSummary {
            file: "/walk/native-walk.json".into(),
            directory: "/walk".into(),
            source_project: walk.path.clone(),
            topic: "Checkout findings".into(),
            started_at_ms: 1,
            status: crate::ux_walk_library::WalkStatus::Saved,
            diatribe: false,
        });
        assert!(matches_recording_filters(
            &walk,
            RecordingsTab::UxWalk,
            "checkout"
        ));
        assert!(matches_recording_filters(
            &walk,
            RecordingsTab::All,
            "cap recording"
        ));
        assert!(!matches_recording_filters(&walk, RecordingsTab::Studio, ""));
        assert!(!matches_recording_filters(
            &walk,
            RecordingsTab::Instant,
            ""
        ));
        assert!(!matches_recording_filters(
            &recording("Studio", RecordingMode::Studio),
            RecordingsTab::UxWalk,
            ""
        ));
        assert_eq!(RecordingsTab::UxWalk.icon(), Some("icons/ux-walk.svg"));
    }

    #[cfg(all(target_os = "macos", feature = "ux-walk"))]
    #[test]
    fn diatribes_list_under_the_walk_filter_with_their_own_name() {
        let mut talk = recording("Cap recording", RecordingMode::Instant);
        talk.walk = Some(crate::ux_walk_library::WalkSummary {
            file: "/talk/native-walk.json".into(),
            directory: "/talk".into(),
            source_project: talk.path.clone(),
            topic: "Diatribe".into(),
            started_at_ms: 1,
            status: crate::ux_walk_library::WalkStatus::Ready,
            diatribe: true,
        });
        assert!(matches_recording_filters(&talk, RecordingsTab::UxWalk, ""));
        assert!(matches_recording_filters(
            &talk,
            RecordingsTab::UxWalk,
            "diatribe"
        ));
        assert!(matches_recording_filters(&talk, RecordingsTab::All, ""));
        assert!(!matches_recording_filters(
            &talk,
            RecordingsTab::Instant,
            ""
        ));
        assert_eq!(row_label(&talk), "Diatribe");
        assert_eq!(row_icon(&talk), crate::mode_choice::DIATRIBE_ICON);
        assert_eq!(row_title(&talk), "Diatribe");
        let mut walk = talk.clone();
        walk.walk.as_mut().unwrap().diatribe = false;
        assert_eq!(row_label(&walk), fork_brand::WALK_MODE_NAME);
        assert_eq!(row_icon(&walk), "icons/ux-walk.svg");
    }

    #[cfg(all(target_os = "macos", feature = "ux-walk"))]
    #[test]
    fn recording_tabs_add_ux_walk_after_the_upstream_tabs() {
        let actual: Vec<_> = RecordingsTab::ALL
            .iter()
            .map(|tab| (tab.id(), tab.label(), tab.icon()))
            .collect();
        let expected = vec![
            ("all", "Show all", None),
            ("instant", "Instant", Some("icons/instant.svg")),
            ("studio", "Studio", Some("icons/film-cut.svg")),
            (
                "ux-walk",
                fork_brand::WALK_MODE_NAME,
                Some("icons/ux-walk.svg"),
            ),
        ];
        assert_eq!(actual, expected);
    }
}
