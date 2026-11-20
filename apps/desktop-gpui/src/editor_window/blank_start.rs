//! A new blank project opens as a blank slate in the player's place: a short
//! title, adding clips as the lead action and the other add flows under it,
//! and files dropped on it are imported. It is editor chrome only, never
//! rendered into frames, and once anything is added it fades out for good.

use std::path::PathBuf;

use gpui::{App, ExternalPaths};

use super::*;
use crate::editor_timeline::TrackKind;

const LEAVE: Duration = Duration::from_millis(220);
const ENTER: Duration = Duration::from_millis(240);
const PANEL_REVEAL: Duration = Duration::from_millis(260);
const COLUMN_WIDTH: f32 = 300.;
const SLATE_PADDING: f32 = 32.;
const SECONDARY: [Action; 4] = [Action::Keys, Action::Text, Action::Music, Action::Image];

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(super) enum BlankStart {
    #[default]
    Off,
    Shown,
    Leaving(Instant),
}

/// Whether the side panel was hidden by the slate last frame, and when it
/// last came back.
#[derive(Default)]
pub(super) struct BlankPanel {
    hidden: bool,
    since: Option<Instant>,
    reveals: usize,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Action {
    Clips,
    Keys,
    Text,
    Music,
    Image,
}

impl Action {
    fn track(self) -> TrackKind {
        match self {
            Self::Clips => TrackKind::Clip,
            Self::Keys => TrackKind::Keyboard,
            Self::Text => TrackKind::Text,
            Self::Music => TrackKind::Audio,
            Self::Image => TrackKind::Image,
        }
    }

    fn id(self) -> &'static str {
        match self {
            Self::Clips => "blank-start-clips",
            Self::Keys => "blank-start-keys",
            Self::Text => "blank-start-text",
            Self::Music => "blank-start-music",
            Self::Image => "blank-start-image",
        }
    }

    fn detail(self) -> Option<&'static str> {
        Some(match self {
            Self::Clips => return None,
            Self::Keys => tr::editor::window::blank_start::keys_detail(),
            Self::Text => tr::editor::window::blank_start::text_item_detail(),
            Self::Music => tr::editor::window::blank_start::music_detail(),
            Self::Image => tr::editor::window::blank_start::image_detail(),
        })
    }

    fn label(self) -> &'static str {
        match self {
            Self::Clips => tr::editor::window::blank_start::clips(),
            Self::Keys => tr::editor::window::blank_start::keys(),
            Self::Text => tr::editor::window::blank_start::text_item(),
            Self::Music => tr::editor::window::blank_start::music(),
            Self::Image => tr::editor::window::blank_start::image(),
        }
    }
}

/// Whether a blank project still holds only the canvas it started with and
/// nothing was edited in this window yet. On opening, a restyled background
/// or a lengthened, trimmed or split canvas still counts as untouched; any
/// clip, overlay, sound, key, caption, zoom or annotation does not.
pub(crate) fn blank_canvas_untouched(
    config: &ProjectConfiguration,
    blank: bool,
    audio_only: bool,
    recording_clips: usize,
    edited: bool,
) -> bool {
    if !blank || audio_only || edited || recording_clips > 1 {
        return false;
    }
    let captions = config
        .captions
        .as_ref()
        .is_some_and(|captions| !captions.segments.is_empty());
    if captions || !config.annotations.is_empty() {
        return false;
    }
    config.timeline.as_ref().is_none_or(|timeline| {
        timeline
            .segments
            .iter()
            .all(|segment| segment.recording_clip == 0)
            && timeline.zoom_segments.is_empty()
            && timeline.scene_segments.is_empty()
            && timeline.mask_segments.is_empty()
            && timeline.text_segments.is_empty()
            && timeline.caption_segments.is_empty()
            && timeline.keyboard_segments.is_empty()
            && timeline.audio_segments.is_empty()
            && timeline.style_segments.is_empty()
            && timeline.image_segments.is_empty()
            && timeline.shape_segments.is_empty()
            && timeline.camera3d_segments.is_empty()
    })
}

/// The next state after the project changed: shown while untouched, and once
/// it leaves it never comes back for this window.
fn next_phase(phase: BlankStart, untouched: bool, first: bool, now: Instant) -> BlankStart {
    match phase {
        BlankStart::Off if first && untouched => BlankStart::Shown,
        BlankStart::Shown if !untouched => BlankStart::Leaving(now),
        other => other,
    }
}

enum DroppedFiles {
    Recording(PathBuf),
    Media {
        images: Vec<PathBuf>,
        audio: Vec<PathBuf>,
    },
}

/// A recording or video replaces the editor when it lands, so it is imported
/// alone; otherwise every image and sound is added.
fn sort_dropped(paths: &[PathBuf]) -> Option<DroppedFiles> {
    let extension_in = |path: &PathBuf, list: &[&str]| {
        path.extension()
            .and_then(|extension| extension.to_str())
            .is_some_and(|extension| list.iter().any(|item| extension.eq_ignore_ascii_case(item)))
    };
    if let Some(recording) = paths.iter().find(|path| {
        (path.is_dir() && extension_in(path, &["cap"]))
            || (path.is_file() && extension_in(path, &["mp4"]))
    }) {
        return Some(DroppedFiles::Recording(recording.clone()));
    }
    let images: Vec<PathBuf> = paths
        .iter()
        .filter(|path| {
            path.is_file() && extension_in(path, crate::import::OVERLAY_IMAGE_EXTENSIONS)
        })
        .cloned()
        .collect();
    let audio: Vec<PathBuf> = paths
        .iter()
        .filter(|path| path.is_file() && extension_in(path, AUDIO_IMPORT_EXTENSIONS))
        .cloned()
        .collect();
    (!images.is_empty() || !audio.is_empty()).then_some(DroppedFiles::Media { images, audio })
}

impl EditorWindow {
    pub(super) fn blank_start_shown(&self) -> bool {
        self.blank_start == BlankStart::Shown
    }

    /// The blank slate is over while it fades out, and for a beat after, so
    /// the panel and timeline can ease in behind it.
    pub(super) fn blank_start_leaving(&self, cx: &App) -> Option<Instant> {
        match self.blank_start {
            BlankStart::Leaving(since) if !cx.reduce_motion() && since.elapsed() < LEAVE * 2 => {
                Some(since)
            }
            _ => None,
        }
    }

    /// Re-reads the rule after the project changed. The slate only ever
    /// appears on the first read after the project loads, and any edit made
    /// in this window ends it, so nothing changes out of sight.
    pub(super) fn refresh_blank_start(&mut self, first: bool) {
        let untouched = self.summary().is_some_and(|summary| {
            blank_canvas_untouched(
                &self.project,
                summary.blank,
                self.is_audio_only(),
                summary.recording_clips,
                self.history.can_undo(),
            )
        });
        self.blank_start = next_phase(self.blank_start, untouched, first, Instant::now());
    }

    /// The slate in the player's place, or fading out over the player once
    /// something was added.
    pub(super) fn render_blank_start_layer(&self, cx: &App) -> Option<gpui::AnyElement> {
        let live = match self.blank_start {
            BlankStart::Off => false,
            BlankStart::Shown => self.project_ready(),
            BlankStart::Leaving(_) => self.blank_start_leaving(cx).is_some(),
        };
        live.then(|| {
            div()
                .absolute()
                .inset_0()
                .child(
                    self.blank_start_view
                        .clone()
                        .cached(StyleRefinement::default().size_full()),
                )
                .into_any_element()
        })
    }

    pub(super) fn render_blank_start(
        &self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> gpui::AnyElement {
        let leaving = match self.blank_start {
            BlankStart::Off => return div().into_any_element(),
            BlankStart::Shown => false,
            BlankStart::Leaving(_) => true,
        };
        let theme = self.theme;
        let editor = theme.editor;
        let height = self
            .player_panel_bounds
            .get()
            .map_or(600., |bounds| f32::from(bounds.size.height));
        let compact = height < 460.;

        let content = div()
            .flex()
            .flex_col()
            .w(px(COLUMN_WIDTH))
            .max_w_full()
            .child(
                div()
                    .flex()
                    .flex_col()
                    .items_center()
                    .gap(px(6.))
                    .mb(px(if compact { 20. } else { 28. }))
                    .text_center()
                    .child(
                        div()
                            .text_size(px(if compact { 18. } else { 22. }))
                            .font_weight(FontWeight::MEDIUM)
                            .text_color(Hsla::from(editor.text_1))
                            .child(tr::editor::window::blank_start::title()),
                    )
                    .child(
                        div()
                            .text_size(px(13.))
                            .text_color(Hsla::from(editor.text_2))
                            .child(tr::editor::window::blank_start::body()),
                    ),
            )
            .child(self.render_blank_start_primary(window, cx))
            .child(
                div()
                    .mt(px(12.))
                    .flex()
                    .flex_col()
                    .rounded(px(10.))
                    .border_1()
                    .border_color(Hsla::from(editor.line_strong))
                    .overflow_hidden()
                    .children(SECONDARY.into_iter().enumerate().map(|(index, action)| {
                        self.render_blank_start_row(action, index > 0, window, cx)
                    })),
            )
            .children(self.sidebar.image_import_error.clone().map(|error| {
                div()
                    .mt(px(12.))
                    .text_center()
                    .text_size(px(12.))
                    .text_color(Hsla::from(theme.red_9))
                    .child(error)
            }));

        let surface = div()
            .id("blank-start-slate")
            .debug_selector(|| "editor-blank-start".into())
            .occlude()
            .size_full()
            .flex()
            .items_center()
            .justify_center()
            .p(px(SLATE_PADDING))
            .rounded(px(crate::theme::EDITOR_CARD_RADIUS))
            .bg(Hsla::from(editor.card))
            .border_1()
            .border_color(Hsla::from(editor.line))
            .shadow(editor.card_shadow())
            .child(content);
        if leaving {
            return div()
                .size_full()
                .child(surface)
                .with_animation(
                    "blank-start-leave",
                    Animation::new(LEAVE),
                    |slate, progress| {
                        if progress >= 1. {
                            div()
                        } else {
                            slate.opacity((1. - progress).powi(2))
                        }
                    },
                )
                .into_any_element();
        }
        surface
            .drag_over::<ExternalPaths>(move |style, _, _, _| {
                style
                    .border_color(Hsla::from(editor.accent))
                    .bg(Hsla::from(crate::theme::mix(
                        editor.card,
                        editor.accent,
                        0.04,
                    )))
            })
            .on_drop(cx.listener(|this, paths: &ExternalPaths, window, cx| {
                this.import_dropped(paths.paths(), window, cx);
            }))
            .with_animation(
                "blank-start-enter",
                Animation::new(ENTER),
                |slate, progress| slate.opacity(1. - (1. - progress).powi(3)),
            )
            .into_any_element()
    }

    /// The side panel and its grip. The slate hides them, since nothing on
    /// it has a picture to act on yet, unless a flow the actions start lives
    /// there (Type Keys, the music library); when they come back they
    /// open out rather than jumping in.
    pub(super) fn render_side_panel_slot(
        &mut self,
        viewport_width: f32,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Vec<gpui::AnyElement> {
        let panel_flow = self.key_prompt.is_some() || self.audio_picker.is_some();
        let hidden = self.blank_start_shown() && self.project_ready() && !panel_flow;
        if self.blank_panel.hidden && !hidden && !cx.reduce_motion() {
            self.blank_panel.reveals += 1;
            self.blank_panel.since = Some(Instant::now());
        }
        self.blank_panel.hidden = hidden;
        if hidden {
            return Vec::new();
        }
        let grip = self.render_panel_grip(cx).into_any_element();
        let panel = self.render_side_panel(viewport_width, window);
        if self
            .blank_panel
            .since
            .is_none_or(|since| since.elapsed() >= PANEL_REVEAL * 2)
        {
            self.blank_panel.since = None;
            return vec![grip, panel];
        }
        let width = self.panel_width(viewport_width) + crate::editor_side_panel::PANEL_GAP;
        vec![
            div()
                .flex()
                .flex_row()
                .flex_none()
                .h_full()
                .overflow_hidden()
                .child(grip)
                .child(panel)
                .with_animation(
                    ("blank-start-panel", self.blank_panel.reveals),
                    Animation::new(PANEL_REVEAL),
                    move |slot, progress| {
                        let eased = 1. - (1. - progress).powi(3);
                        slot.w(px(width * eased)).opacity(eased)
                    },
                )
                .into_any_element(),
        ]
    }

    /// The timeline while the slate shows: the ruler and Add track, and no
    /// placeholder clip.
    pub(super) fn render_blank_timeline(
        &self,
        viewport_width: f32,
        cx: &mut Context<Self>,
    ) -> gpui::AnyElement {
        div()
            .size_full()
            .min_h_0()
            .flex()
            .flex_col()
            .gap(px(timeline::TIMELINE_HEADER_GAP))
            .overflow_hidden()
            .pt(px(TIMELINE_TOP_PADDING))
            .pl(px(TIMELINE_PADDING))
            .pr(px(TIMELINE_PADDING))
            .pb(px(TIMELINE_BOTTOM_PADDING))
            .child(self.render_timeline_header(viewport_width, false, cx))
            .into_any_element()
    }

    /// Adding clips leads: it is the one action that makes the project a
    /// video of something.
    fn render_blank_start_primary(
        &self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> gpui::AnyElement {
        let editor = self.theme.editor;
        let (fade, level) = ui::hover_fade(window, cx, "blank-start-clips-fade");
        let rest = Hsla::from(editor.accent);
        let hover = Hsla::from(crate::theme::mix(editor.accent, gpui::rgb(0xffffff), 0.1));
        let button = div()
            .id(Action::Clips.id())
            .flex()
            .items_center()
            .justify_center()
            .h(px(40.))
            .rounded(px(10.))
            .cursor_pointer()
            .bg(ui::hover_blend(rest, hover, level))
            .active(move |style| {
                style.bg(Hsla::from(crate::theme::mix(
                    editor.accent,
                    gpui::rgb(0x000000),
                    0.08,
                )))
            })
            .text_size(px(14.))
            .font_weight(FontWeight::MEDIUM)
            .text_color(gpui::white())
            .on_hover(move |hovered, _, cx| {
                fade.update(cx, |fade, cx| {
                    fade.set_hovered(*hovered);
                    cx.notify();
                });
            })
            .child(Action::Clips.label());
        let this = cx.entity().downgrade();
        ui::Menu::trigger(button, move |bounds, window, cx| {
            this.update(cx, |this, cx| {
                this.open_toolbar_menu(ToolbarMenu::AddClips, *bounds, window, cx);
            })
            .ok();
        })
        .into_any_element()
    }

    /// The quieter actions: plain rows between hairlines.
    fn render_blank_start_row(
        &self,
        action: Action,
        divided: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> gpui::AnyElement {
        let theme = self.theme;
        let editor = theme.editor;
        let (fade, level) = ui::hover_fade(
            window,
            cx,
            SharedString::from(format!("{}-fade", action.id())),
        );
        let hover = Hsla::from(editor.ctl);
        let kind = action.track();
        div()
            .id(action.id())
            .tab_index(0)
            .flex()
            .flex_row()
            .items_center()
            .gap(px(12.))
            .h(px(54.))
            .px(px(14.))
            .cursor_pointer()
            .when(divided, |row| {
                row.border_t_1().border_color(Hsla::from(editor.line))
            })
            .when(level > 0., |row| {
                row.bg(ui::hover_blend(hover.opacity(0.), hover, level))
            })
            .active(move |style| style.bg(Hsla::from(editor.ctl_hover)))
            .text_size(px(13.))
            .text_color(Hsla::from(editor.text_1))
            .on_hover(move |hovered, _, cx| {
                fade.update(cx, |fade, cx| {
                    fade.set_hovered(*hovered);
                    cx.notify();
                });
            })
            .on_click(cx.listener(move |this, _, window, cx| {
                this.add_track = None;
                this.add_track_kind(kind, window, cx);
            }))
            .child(crate::editor_timeline::track_tile(&theme, kind))
            .child(
                div()
                    .flex()
                    .flex_col()
                    .min_w_0()
                    .gap(px(1.))
                    .child(div().truncate().child(action.label()))
                    .children(action.detail().map(|detail| {
                        div()
                            .truncate()
                            .text_size(px(12.))
                            .text_color(Hsla::from(editor.text_2))
                            .child(detail)
                    })),
            )
            .into_any_element()
    }

    fn import_dropped(&mut self, paths: &[PathBuf], window: &mut Window, cx: &mut Context<Self>) {
        if !self.blank_start_shown() || !self.project_ready() {
            return;
        }
        match sort_dropped(paths) {
            Some(DroppedFiles::Recording(path)) => self.import_recording_path(path, window, cx),
            Some(DroppedFiles::Media { images, audio }) => {
                let at = self.playhead;
                let project_path = self.project_path.clone();
                cx.spawn_in(window, async move |this, cx| {
                    for source in images {
                        let project_path = project_path.clone();
                        let imported = cx
                            .background_executor()
                            .spawn(async move {
                                crate::import::import_editor_image(&project_path, &source)
                            })
                            .await;
                        let landed = this.update_in(cx, |this, window, cx| match imported {
                            Ok(imported) => {
                                let lane = this.free_image_lane(at);
                                this.commit_image_import(lane, at, imported, window, cx);
                            }
                            Err(error) => {
                                this.sidebar.image_import_error = Some(error);
                                cx.notify();
                            }
                        });
                        if landed.is_err() {
                            return;
                        }
                    }
                    for source in audio {
                        let project_path = project_path.clone();
                        let imported = cx
                            .background_executor()
                            .spawn(async move { import_audio_file(&project_path, &source) })
                            .await;
                        let landed = this.update_in(cx, |this, window, cx| match imported {
                            Ok(imported) => {
                                let lane = this.free_audio_lane();
                                this.commit_audio_import(lane, imported, window, cx);
                            }
                            Err(error) => {
                                tracing::error!("importing dropped audio failed: {error}");
                                this.show_notice(
                                    tr::editor::window::blank_start::drop_failed(),
                                    window,
                                    cx,
                                );
                            }
                        });
                        if landed.is_err() {
                            return;
                        }
                    }
                })
                .detach();
            }
            None => self.show_notice(
                tr::editor::window::blank_start::drop_unsupported(),
                window,
                cx,
            ),
        }
    }

    fn free_image_lane(&self, at: f64) -> u32 {
        let lane_count = self.tracks.count(TrackKind::Image);
        let segments = self.timeline.segments(TrackKind::Image);
        let length = self.total_duration().min(3.0);
        (0..lane_count)
            .find(|lane| {
                !segments.iter().any(|segment| {
                    segment.lane == *lane && segment.end > at && segment.start < at + length
                })
            })
            .unwrap_or(lane_count)
    }

    fn free_audio_lane(&self) -> u32 {
        let segments = self
            .project
            .timeline
            .as_ref()
            .map(|timeline| timeline.audio_segments.as_slice())
            .unwrap_or(&[]);
        let lane_count = self.tracks.audio.max(edits::used_lane_count(segments));
        (0..lane_count)
            .find(|lane| !segments.iter().any(|segment| segment.track == *lane))
            .unwrap_or(lane_count)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn blank() -> ProjectConfiguration {
        cap_export::audio_project::blank_project_config()
    }

    fn text_segment() -> cap_project::TextSegment {
        crate::style_presets::new_text_segment(1.0, 3.0, 0)
    }

    #[test]
    fn a_fresh_blank_project_opens_on_the_slate() {
        assert!(blank_canvas_untouched(&blank(), true, false, 1, false));
    }

    #[test]
    fn restyling_or_reshaping_the_canvas_adds_nothing() {
        let mut config = blank();
        config.background.padding = 12.;
        let timeline = config.timeline.as_mut().unwrap();
        timeline.segments[0].end = 42.;
        let mut second = timeline.segments[0].clone();
        second.start = 42.;
        second.end = 60.;
        timeline.segments.push(second);
        assert!(blank_canvas_untouched(&config, true, false, 1, false));
    }

    #[test]
    fn any_added_content_ends_the_slate() {
        let cases: Vec<(&str, Box<dyn Fn(&mut ProjectConfiguration)>)> = vec![
            (
                "text",
                Box::new(|config| {
                    let timeline = config.timeline.as_mut().unwrap();
                    timeline.text_segments.push(text_segment());
                }),
            ),
            (
                "image",
                Box::new(|config| {
                    let timeline = config.timeline.as_mut().unwrap();
                    timeline.image_segments.push(cap_project::ImageSegment {
                        end: 2.0,
                        path: "assets/a.png".into(),
                        ..Default::default()
                    });
                }),
            ),
            (
                "audio",
                Box::new(|config| {
                    let timeline = config.timeline.as_mut().unwrap();
                    timeline.audio_segments.push(edits::default_audio_segment(
                        0.0,
                        2.0,
                        0,
                        "assets/a.mp3".into(),
                        "a".into(),
                        Some(2.0),
                    ));
                }),
            ),
            (
                "keys",
                Box::new(|config| {
                    let timeline = config.timeline.as_mut().unwrap();
                    timeline.keyboard_segments.push(
                        serde_json::from_value(serde_json::json!({
                            "id": "k", "start": 0.0, "end": 1.0, "displayText": "K"
                        }))
                        .unwrap(),
                    );
                }),
            ),
            (
                "zoom",
                Box::new(|config| {
                    let timeline = config.timeline.as_mut().unwrap();
                    timeline.zoom_segments.push(
                        serde_json::from_value(serde_json::json!({
                            "start": 0.0, "end": 1.0, "amount": 1.5, "mode": "auto"
                        }))
                        .unwrap(),
                    );
                }),
            ),
            (
                "imported clip",
                Box::new(|config| {
                    let timeline = config.timeline.as_mut().unwrap();
                    let mut clip = timeline.segments[0].clone();
                    clip.recording_clip = 1;
                    timeline.segments.push(clip);
                }),
            ),
        ];
        for (name, add) in cases {
            let mut config = blank();
            add(&mut config);
            assert!(
                !blank_canvas_untouched(&config, true, false, 1, false),
                "{name}"
            );
        }
        assert!(!blank_canvas_untouched(&blank(), true, false, 2, false));
    }

    #[test]
    fn any_edit_in_the_window_ends_the_slate() {
        assert!(!blank_canvas_untouched(&blank(), true, false, 1, true));
    }

    #[test]
    fn recordings_and_audio_only_projects_never_show_it() {
        let config = blank();
        assert!(!blank_canvas_untouched(&config, false, false, 1, false));
        assert!(!blank_canvas_untouched(&config, false, true, 1, false));
        assert!(!blank_canvas_untouched(&config, true, true, 1, false));
    }

    #[test]
    fn once_gone_it_never_comes_back() {
        let now = Instant::now();
        let shown = next_phase(BlankStart::Off, true, true, now);
        assert_eq!(shown, BlankStart::Shown);
        assert_eq!(next_phase(shown, true, false, now), BlankStart::Shown);
        let leaving = next_phase(shown, false, false, now);
        assert_eq!(leaving, BlankStart::Leaving(now));
        assert_eq!(next_phase(leaving, true, false, now), leaving);
        assert_eq!(next_phase(leaving, true, true, now), leaving);
        assert_eq!(
            next_phase(BlankStart::Off, true, false, now),
            BlankStart::Off
        );
        assert_eq!(
            next_phase(BlankStart::Off, false, true, now),
            BlankStart::Off
        );
    }

    #[test]
    fn a_dropped_recording_is_imported_alone() {
        let dir = tempfile::tempdir().unwrap();
        let file = |name: &str| {
            let path = dir.path().join(name);
            std::fs::write(&path, b"x").unwrap();
            path
        };
        let png = file("logo.PNG");
        let mp3 = file("song.mp3");
        let mp4 = file("clip.mp4");
        let txt = file("notes.txt");
        match sort_dropped(&[png.clone(), mp4.clone(), mp3.clone()]) {
            Some(DroppedFiles::Recording(path)) => assert_eq!(path, mp4),
            _ => panic!("expected the video"),
        }
        match sort_dropped(&[png.clone(), txt.clone(), mp3.clone()]) {
            Some(DroppedFiles::Media { images, audio }) => {
                assert_eq!(images, vec![png]);
                assert_eq!(audio, vec![mp3]);
            }
            _ => panic!("expected media"),
        }
        assert!(sort_dropped(&[txt]).is_none());
    }
}
