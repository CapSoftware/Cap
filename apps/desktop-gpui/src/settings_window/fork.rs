use std::{
    collections::{HashMap, HashSet},
    path::PathBuf,
    sync::Arc,
};

use gpui::{
    Context, Div, InteractiveElement, IntoElement, ParentElement, Styled, Window, div,
    prelude::FluentBuilder, px,
};

use super::{Page, RecordingsTab, SettingsWindow};
use crate::{
    library::{self, RecordingItem, RecordingMode},
    theme::Theme,
    ui,
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
    /// Recordings whose notes are being made from the library, and the last error for each.
    notes_busy: HashSet<PathBuf>,
    notes_errors: HashMap<PathBuf, String>,
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
    // An ordinary recording with notes stays where its mode puts it.
    let walk = item.walk.as_ref().filter(|walk| !walk.notes);
    if walk.is_none() && !walk_tab {
        return None;
    }
    let Some(walk) = walk else {
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

/// The walk a row is shown as, if any. An ordinary recording with notes is not one.
fn shown_walk(item: &RecordingItem) -> Option<&crate::ux_walk_library::WalkSummary> {
    item.walk.as_ref().filter(|walk| !walk.notes)
}

pub(super) fn row_title(item: &RecordingItem) -> String {
    match shown_walk(item) {
        Some(walk) if walk.diatribe => {
            chrono::TimeZone::timestamp_millis_opt(&chrono::Local, walk.started_at_ms as i64)
                .single()
                .map_or_else(
                    || crate::mode_choice::DIATRIBE_NAME.into(),
                    crate::mode_choice::diatribe_title,
                )
        }
        Some(walk) => walk.topic.clone(),
        None => item.pretty_name.clone(),
    }
}

/// Instant rows get the blue pill; walk mode rows, diatribes included, stay gray.
pub(super) fn row_pill_tinted(item: &RecordingItem) -> bool {
    shown_walk(item).is_none() && item.mode == RecordingMode::Instant
}

pub(super) fn row_icon(item: &RecordingItem) -> &'static str {
    match shown_walk(item) {
        Some(walk) if walk.diatribe => crate::mode_choice::DIATRIBE_ICON,
        Some(_) => "icons/ux-walk.svg",
        None => item.mode.icon(),
    }
}

pub(super) fn row_label(item: &RecordingItem) -> &'static str {
    match shown_walk(item) {
        Some(walk) if walk.diatribe => crate::mode_choice::DIATRIBE_NAME,
        Some(_) => fork_brand::WALK_MODE_NAME,
        None => item.mode.label(),
    }
}

pub(super) fn walk_status(item: &RecordingItem) -> Option<&'static str> {
    item.walk
        .as_ref()
        .map(crate::ux_walk_library::WalkSummary::status_label)
}

/// "Make notes & action items" is offered on a finished Studio or Instant recording that has
/// no notes yet, or whose notes were interrupted before they were made.
pub(super) fn offers_notes(item: &RecordingItem) -> bool {
    FORK && cfg!(all(target_os = "macos", feature = "ux-walk"))
        && matches!(item.mode, RecordingMode::Studio | RecordingMode::Instant)
        && !item.status.is_in_progress()
        && item.status.error().is_none()
        && item.walk.as_ref().is_none_or(|walk| {
            walk.notes && walk.status == crate::ux_walk_library::WalkStatus::Interrupted
        })
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
        let Some(walk) = item.walk.as_ref().filter(|walk| {
            !(walk.notes && walk.status == crate::ux_walk_library::WalkStatus::Interrupted)
        }) else {
            return actions;
        };
        let notes = walk.file.clone();
        let icon = if walk.notes {
            "icons/scan-text.svg"
        } else {
            "icons/ux-walk.svg"
        };
        actions = actions.child(self.row_button(
            "recording-walk-notes",
            icon,
            "View notes",
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
                "Sharing video only. Notes and browser traces stay local…"
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

    /// Makes notes & action items for a recording made earlier: a completed notes journal
    /// pointing at it, then the same snapshot and processing a live recording gets. The
    /// recording itself is never changed.
    fn make_recording_notes(&mut self, path: PathBuf, window: &mut Window, cx: &mut Context<Self>) {
        if !self.recordings.fork.notes_busy.insert(path.clone()) {
            return;
        }
        self.recordings.fork.notes_errors.remove(&path);
        self.recordings.fork.notice = Some("Making notes & action items in the background…".into());
        cx.notify();
        cx.spawn_in(window, async move |this, cx| {
            let project = path.clone();
            let journal = cx
                .background_executor()
                .spawn(async move { crate::ux_walk::notes::for_recording(&project) })
                .await;
            let file = match journal {
                Ok(file) => {
                    // The row links to its notes as soon as the journal exists.
                    this.update_in(cx, |this, window, cx| {
                        this.refresh_recordings(window, cx);
                        cx.notify();
                    })
                    .ok();
                    file
                }
                Err(error) => {
                    this.update_in(cx, |this, window, cx| {
                        this.finish_recording_notes(path, Err(error), window, cx)
                    })
                    .ok();
                    return;
                }
            };
            let result = cx
                .background_executor()
                .spawn(async move { crate::ux_walk::notes::process(&file) })
                .await;
            this.update_in(cx, |this, window, cx| {
                this.finish_recording_notes(path, result, window, cx)
            })
            .ok();
        })
        .detach();
    }

    fn finish_recording_notes(
        &mut self,
        path: PathBuf,
        result: Result<(), String>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.recordings.fork.notes_busy.remove(&path);
        self.recordings.fork.notice = Some(match result {
            Ok(()) => "Notes & action items are ready. Choose View notes on the recording.".into(),
            Err(error) => {
                let message = notes_error(&error);
                self.recordings
                    .fork
                    .notes_errors
                    .insert(path.clone(), message.clone());
                message
            }
        });
        self.refresh_recordings(window, cx);
        cx.notify();
        window.refresh();
    }

    /// "Make notes & action items" under the recording's name, with the last error inline.
    /// It sits apart from the row's action buttons so those keep their places.
    pub(super) fn notes_row(&self, item: &RecordingItem, cx: &mut Context<Self>) -> Option<Div> {
        let error = self.recordings.fork.notes_errors.get(&item.path).cloned();
        let offered = offers_notes(item);
        if !offered && error.is_none() {
            return None;
        }
        let path = item.path.clone();
        let busy = self.recordings.fork.notes_busy.contains(&path);
        Some(
            div()
                .flex()
                .flex_row()
                .items_center()
                .gap(px(8.))
                .min_w_0()
                .when(offered, |this| {
                    this.child(
                        div()
                            .flex_shrink_0()
                            // The row itself opens the recording; this click is the button's.
                            .on_mouse_down(gpui::MouseButton::Left, |_, _, cx| {
                                cx.stop_propagation()
                            })
                            .child(self.button(
                                gpui::ElementId::Name(
                                    format!("recording-make-notes-{}", path.display()).into(),
                                ),
                                (ui::ButtonVariant::Gray, None),
                                if busy {
                                    "Making notes & action items…"
                                } else {
                                    crate::ux_walk::notes::MAKE
                                },
                                busy,
                                cx,
                                move |this, window, cx| {
                                    this.make_recording_notes(path.clone(), window, cx)
                                },
                            )),
                    )
                })
                .when_some(error, |this, error| {
                    this.child(
                        div()
                            .min_w_0()
                            .text_size(px(11.))
                            .text_color(self.theme.red_11)
                            .child(error),
                    )
                }),
        )
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

/// A library notes failure, worded for the row. The recording itself is untouched.
fn notes_error(error: &str) -> String {
    format!("Could not make notes & action items. The recording is unchanged. {error}")
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
            notes: false,
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
            notes: false,
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
        assert!(!row_pill_tinted(&talk));
        let started = chrono::TimeZone::with_ymd_and_hms(&chrono::Local, 2026, 11, 5, 18, 20, 0)
            .single()
            .unwrap();
        talk.walk.as_mut().unwrap().started_at_ms = started.timestamp_millis() as u64;
        assert_eq!(row_title(&talk), "Diatribe 2026-11-05 18.20");
        let mut walk = talk.clone();
        walk.walk.as_mut().unwrap().diatribe = false;
        assert_eq!(row_label(&walk), fork_brand::WALK_MODE_NAME);
        assert_eq!(row_icon(&walk), "icons/ux-walk.svg");
        assert_eq!(row_title(&walk), "Diatribe");
        assert!(!row_pill_tinted(&walk));
        assert!(row_pill_tinted(&recording(
            "Instant",
            RecordingMode::Instant
        )));
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

    #[cfg(all(target_os = "macos", feature = "ux-walk"))]
    fn with_notes(
        mut item: RecordingItem,
        status: crate::ux_walk_library::WalkStatus,
    ) -> RecordingItem {
        item.walk = Some(crate::ux_walk_library::WalkSummary {
            file: "/notes/native-walk.json".into(),
            directory: "/notes".into(),
            source_project: item.path.clone(),
            topic: item.pretty_name.clone(),
            started_at_ms: 1,
            status,
            diatribe: false,
            notes: true,
        });
        item
    }

    #[cfg(all(target_os = "macos", feature = "ux-walk"))]
    #[test]
    fn a_recording_with_notes_stays_an_ordinary_studio_or_instant_row() {
        use crate::ux_walk_library::WalkStatus;
        for mode in [RecordingMode::Studio, RecordingMode::Instant] {
            let plain = recording("Team standup", mode);
            let noted = with_notes(plain.clone(), WalkStatus::Ready);
            let tab = match mode {
                RecordingMode::Studio => RecordingsTab::Studio,
                RecordingMode::Instant => RecordingsTab::Instant,
            };
            assert!(matches_recording_filters(&noted, tab, "standup"));
            assert!(matches_recording_filters(&noted, RecordingsTab::All, ""));
            assert!(!matches_recording_filters(
                &noted,
                RecordingsTab::UxWalk,
                ""
            ));
            assert_eq!(row_title(&noted), row_title(&plain));
            assert_eq!(row_icon(&noted), mode.icon());
            assert_eq!(row_label(&noted), mode.label());
            assert_eq!(walk_status(&noted), Some("Notes ready"));
            assert_eq!(
                walk_status(&with_notes(plain, WalkStatus::Failed("No key".into()))),
                Some("Notes need attention")
            );
        }
    }

    #[cfg(all(target_os = "macos", feature = "ux-walk"))]
    #[test]
    fn make_notes_is_offered_on_finished_recordings_without_notes() {
        use crate::ux_walk_library::WalkStatus;
        let studio = recording("Demo", RecordingMode::Studio);
        assert!(offers_notes(&studio));
        assert!(offers_notes(&recording("Clip", RecordingMode::Instant)));
        assert!(!offers_notes(&with_notes(
            studio.clone(),
            WalkStatus::Processing
        )));
        assert!(!offers_notes(&with_notes(
            studio.clone(),
            WalkStatus::Ready
        )));
        assert!(offers_notes(&with_notes(
            studio.clone(),
            WalkStatus::Interrupted
        )));
        let mut walk = with_notes(studio.clone(), WalkStatus::Interrupted);
        walk.walk.as_mut().unwrap().notes = false;
        assert!(!offers_notes(&walk));
        let mut recording_now = studio.clone();
        recording_now.status = crate::library::RecordingStatus::InProgress;
        assert!(!offers_notes(&recording_now));
        let mut failed = studio;
        failed.status = crate::library::RecordingStatus::Failed {
            error: "Disk full".into(),
        };
        assert!(!offers_notes(&failed));
        assert!(notes_error("No transcription key").contains("The recording is unchanged"));
    }
}
