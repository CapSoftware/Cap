use std::path::{Path, PathBuf};

use cap_enc_ffmpeg::remux::get_media_duration;
use cap_project::{ProjectConfiguration, TimelineConfiguration};
use gpui::{
    AnyElement, Context, FontWeight, Hsla, InteractiveElement, IntoElement, ParentElement,
    SharedString, StatefulInteractiveElement, Styled, div, prelude::FluentBuilder, px, svg,
};

use crate::{editor_window::EditorWindow, theme::Theme, ui};

pub const AUDIO_LIBRARY: &[(&str, &str)] = &[
    ("lofi-beats-mirostar", "Lofi Beats"),
    ("raindrops-lofi-sleep-bluelike", "Raindrops"),
    ("sunday-mood-lofi-cafe-upbeat-bluelike", "Sunday Mood"),
    ("good-night-lofi-cozy-chill-fassounds", "Good Night"),
    (
        "ambient-trap-empty-streets-dreamstate-openmindaudio",
        "Empty Streets",
    ),
    ("lofi-study-calm-peaceful-chill-hop-fassounds", "Study"),
    ("lofi-cinematic-pulsebox", "Cinematic"),
    ("lofi-hip-hop-leberch", "Hip Hop"),
    ("cassette-retrositive", "Cassette"),
    ("lofi-smooth-pulsebox", "Smooth"),
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AudioPicker {
    Add { lane: u32 },
    Replace { index: usize },
}

#[derive(Clone)]
pub(crate) struct AudioImportRequest {
    pub picker: AudioPicker,
    pub generation: u64,
    target_fingerprint: Option<String>,
}

impl AudioImportRequest {
    pub fn new(
        picker: AudioPicker,
        generation: u64,
        project: &ProjectConfiguration,
    ) -> Option<Self> {
        let target_fingerprint = match picker {
            AudioPicker::Add { .. } => None,
            AudioPicker::Replace { index } => Some(
                serde_json::to_string(project.timeline.as_ref()?.audio_segments.get(index)?)
                    .ok()?,
            ),
        };
        Some(Self {
            picker,
            generation,
            target_fingerprint,
        })
    }

    pub fn accepts(
        &self,
        picker: Option<AudioPicker>,
        generation: u64,
        project: &ProjectConfiguration,
    ) -> bool {
        if picker != Some(self.picker) || generation != self.generation {
            return false;
        }
        match self.picker {
            AudioPicker::Add { .. } => true,
            AudioPicker::Replace { index } => {
                project
                    .timeline
                    .as_ref()
                    .and_then(|timeline| timeline.audio_segments.get(index))
                    .and_then(|segment| serde_json::to_string(segment).ok())
                    .as_deref()
                    == self.target_fingerprint.as_deref()
            }
        }
    }
}

pub(crate) fn replace_audio_asset(
    timeline: &mut TimelineConfiguration,
    index: usize,
    path: String,
    name: String,
    duration: f64,
) -> bool {
    let Some(segment) = timeline.audio_segments.get_mut(index) else {
        return false;
    };
    segment.path = path;
    segment.name = Some(name);
    segment.duration = (duration > 0.0).then_some(duration);
    segment.trim_start = 0.0;
    if duration > 0.0 && segment.end > segment.start + duration {
        segment.end = (segment.start + duration)
            .max(segment.start + crate::editor_edits::MIN_AUDIO_SEGMENT_DURATION);
    }
    let segment_duration = (segment.end - segment.start).max(0.0);
    segment.fade_in = segment.fade_in.min(segment_duration);
    segment.fade_out = segment.fade_out.min(segment_duration);
    true
}

pub(crate) fn probe_audio_duration(path: &Path) -> f64 {
    get_media_duration(path)
        .map(|duration| duration.as_secs_f64())
        .unwrap_or(0.0)
}

pub fn bundled_track_path(id: &str) -> Option<PathBuf> {
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    bundled_track_path_from(id, &crate::store::bundled_resource_dirs(), &manifest)
}

fn bundled_track_path_from(
    id: &str,
    resource_dirs: &[PathBuf],
    manifest: &Path,
) -> Option<PathBuf> {
    if !AUDIO_LIBRARY.iter().any(|(known, _)| *known == id) {
        return None;
    }

    let file = format!("{id}.mp3");
    let mut candidates = resource_dirs
        .iter()
        .map(|directory| directory.join("assets/music").join(&file))
        .collect::<Vec<_>>();
    candidates.extend([
        manifest.join("../desktop/src/assets/music").join(&file),
        manifest.join("assets/music").join(&file),
    ]);
    candidates.into_iter().find(|path| path.is_file())
}

pub fn copy_library_track(
    project_path: &Path,
    id: &str,
    name: &str,
) -> Result<(String, String, f64), String> {
    let source = bundled_track_path(id).ok_or_else(|| format!("Unknown library track: {id}"))?;
    let audio_dir = project_path.join("assets").join("audio");
    std::fs::create_dir_all(&audio_dir)
        .map_err(|error| format!("Failed to create audio directory: {error}"))?;
    let dest_name = format!("library-{id}.mp3");
    let dest = audio_dir.join(&dest_name);
    if !dest.exists() {
        std::fs::copy(&source, &dest).map_err(|error| {
            format!(
                "Failed to copy bundled track from {}: {error}",
                source.display()
            )
        })?;
    }
    Ok((
        format!("assets/audio/{dest_name}"),
        name.to_string(),
        probe_audio_duration(&dest),
    ))
}

impl EditorWindow {
    pub(crate) fn render_audio_library(&self, cx: &mut Context<Self>) -> AnyElement {
        let theme = self.theme;
        let is_replace = matches!(self.audio_picker, Some(AudioPicker::Replace { .. }));
        let importing = self.audio_import_pending == Some(self.audio_picker_generation);

        div()
            .id("audio-library")
            .flex()
            .flex_col()
            .flex_1()
            .min_h_0()
            .overflow_y_scroll()
            .p(px(16.))
            .gap(px(16.))
            .child(
                div()
                    .flex()
                    .flex_row()
                    .items_center()
                    .gap(px(8.))
                    .child(
                        ui::EditorButton::plain(&theme, "audio-library-close")
                            .left_icon("icons/check.svg")
                            .icon_size(px(16.))
                            .label("Done")
                            .on_click(cx.listener(|this, _, _, cx| {
                                this.audio_picker = None;
                                cx.notify();
                            })),
                    )
                    .child(
                        div()
                            .text_size(px(14.))
                            .text_color(Hsla::from(theme.gray_10))
                            .child(if is_replace {
                                "Change audio"
                            } else {
                                "Add audio"
                            }),
                    ),
            )
            .child(
                div()
                    .text_size(px(12.))
                    .text_color(Hsla::from(theme.gray_10))
                    .child(if is_replace {
                        "Pick a different track for this segment"
                    } else {
                        "Add audio, music or other sounds to your video"
                    }),
            )
            .child(
                ui::EditorButton::plain(&theme, "audio-library-import")
                    .left_icon("icons/import.svg")
                    .label("Import file")
                    .disabled(importing)
                    .on_click(cx.listener(|this, _, window, cx| {
                        this.import_audio_from_picker(window, cx);
                    })),
            )
            .child(
                div().flex().flex_col().gap(px(6.)).children(
                    AUDIO_LIBRARY
                        .iter()
                        .copied()
                        .map(|(id, name)| render_library_row(&theme, id, name, importing, cx)),
                ),
            )
            .into_any_element()
    }
}

fn render_library_row(
    theme: &Theme,
    id: &'static str,
    name: &'static str,
    importing: bool,
    cx: &mut Context<EditorWindow>,
) -> AnyElement {
    div()
        .id(SharedString::from(format!("audio-lib-{id}")))
        .flex()
        .flex_row()
        .items_center()
        .justify_between()
        .gap(px(12.))
        .px(px(12.))
        .py(px(10.))
        .rounded(px(12.))
        .border_1()
        .border_color(Hsla::from(theme.gray_3))
        .bg(Hsla::from(theme.gray_2))
        .when(!importing, |row| {
            row.cursor_pointer()
                .hover(|this| this.bg(Hsla::from(theme.gray_3)))
                .on_click(cx.listener(move |this, _, window, cx| {
                    this.add_library_track(id, name, window, cx);
                }))
        })
        .child(
            div()
                .flex()
                .flex_col()
                .gap(px(2.))
                .min_w_0()
                .child(
                    div()
                        .text_size(px(13.))
                        .font_weight(FontWeight::MEDIUM)
                        .text_color(Hsla::from(theme.gray_12))
                        .child(name),
                )
                .child(
                    div()
                        .text_size(px(11.))
                        .text_color(Hsla::from(theme.gray_10))
                        .child("Lo-Fi"),
                ),
        )
        .child(
            svg()
                .path("icons/plus.svg")
                .size(px(16.))
                .text_color(Hsla::from(theme.gray_11)),
        )
        .into_any_element()
}

#[cfg(test)]
mod tests {
    use super::{
        AUDIO_LIBRARY, AudioImportRequest, AudioPicker, bundled_track_path,
        bundled_track_path_from, copy_library_track, probe_audio_duration, replace_audio_asset,
    };
    use cap_project::ProjectConfiguration;

    fn audio_project() -> ProjectConfiguration {
        serde_json::from_value(serde_json::json!({
            "timeline": {
                "segments": [],
                "zoomSegments": [],
                "audioSegments": [
                    {"start": 2.0, "end": 22.0, "track": 1, "path": "old.wav", "name": "Old", "trimStart": 10.0, "volumeDb": -6.0, "fadeIn": 8.0, "fadeOut": 7.0, "duration": 30.0},
                    {"start": 25.0, "end": 29.0, "track": 2, "path": "other.wav", "name": "Other", "duration": 4.0}
                ]
            }
        }))
        .unwrap()
    }

    fn finish_replacement(
        request: &AudioImportRequest,
        picker: Option<AudioPicker>,
        generation: u64,
        project: &mut ProjectConfiguration,
    ) -> bool {
        if !request.accepts(picker, generation, project) {
            return false;
        }
        let AudioPicker::Replace { index } = request.picker else {
            return false;
        };
        replace_audio_asset(
            project.timeline.as_mut().unwrap(),
            index,
            "short.wav".into(),
            "Short".into(),
            3.0,
        )
    }

    #[test]
    fn audio_import_rejects_closed_reopened_and_changed_picker_sessions() {
        let mut project = audio_project();
        let picker = AudioPicker::Replace { index: 0 };
        let request = AudioImportRequest::new(picker, 1, &project).unwrap();
        let before = serde_json::to_value(&project).unwrap();
        for (active, generation) in [
            (None, 1),
            (Some(picker), 2),
            (Some(AudioPicker::Replace { index: 1 }), 1),
            (Some(AudioPicker::Add { lane: 1 }), 1),
        ] {
            assert!(!finish_replacement(
                &request,
                active,
                generation,
                &mut project
            ));
            assert_eq!(serde_json::to_value(&project).unwrap(), before);
        }
    }

    #[test]
    fn audio_import_rejects_deleted_reordered_and_edited_targets() {
        for change in 0..3 {
            let mut project = audio_project();
            let picker = AudioPicker::Replace { index: 0 };
            let request = AudioImportRequest::new(picker, 1, &project).unwrap();
            let segments = &mut project.timeline.as_mut().unwrap().audio_segments;
            match change {
                0 => {
                    segments.remove(0);
                }
                1 => segments.swap(0, 1),
                _ => segments[0].trim_start = 11.0,
            }
            let before = serde_json::to_value(&project).unwrap();
            assert!(!finish_replacement(&request, Some(picker), 1, &mut project));
            assert_eq!(serde_json::to_value(&project).unwrap(), before);
        }
    }

    #[test]
    fn replacing_trimmed_audio_starts_new_source_and_clamps_short_source() {
        let mut project = audio_project();
        let picker = AudioPicker::Replace { index: 0 };
        let request = AudioImportRequest::new(picker, 1, &project).unwrap();
        let mut expected = serde_json::to_value(&project).unwrap();
        let segment = &mut expected["timeline"]["audioSegments"][0];
        segment["path"] = "short.wav".into();
        segment["name"] = "Short".into();
        segment["duration"] = 3.0.into();
        segment["trimStart"] = 0.0.into();
        segment["end"] = 5.0.into();
        segment["fadeIn"] = 3.0.into();
        segment["fadeOut"] = 3.0.into();
        assert!(finish_replacement(&request, Some(picker), 1, &mut project));
        assert_eq!(serde_json::to_value(&project).unwrap(), expected);
        assert!(!finish_replacement(&request, Some(picker), 1, &mut project));
    }

    #[test]
    fn replacement_preserves_shorter_timeline_and_unknown_duration() {
        for duration in [60.0, 0.0] {
            let mut project = audio_project();
            let timeline = project.timeline.as_mut().unwrap();
            assert!(replace_audio_asset(
                timeline,
                0,
                "new.wav".into(),
                "New".into(),
                duration,
            ));
            let segment = &timeline.audio_segments[0];
            assert_eq!(segment.end, 22.0);
            assert_eq!(segment.trim_start, 0.0);
            assert_eq!(segment.fade_in, 8.0);
            assert_eq!(segment.fade_out, 7.0);
            assert_eq!(segment.volume_db, -6.0);
            assert_eq!(segment.duration, (duration > 0.0).then_some(duration));
        }
    }

    #[test]
    fn add_audio_import_is_bound_to_its_lane_and_picker_session() {
        let project = audio_project();
        let picker = AudioPicker::Add { lane: 4 };
        let request = AudioImportRequest::new(picker, 7, &project).unwrap();
        assert!(request.accepts(Some(picker), 7, &project));
        assert!(!request.accepts(None, 7, &project));
        assert!(!request.accepts(Some(picker), 8, &project));
        assert!(!request.accepts(Some(AudioPicker::Add { lane: 5 }), 7, &project));
        assert!(AudioImportRequest::new(AudioPicker::Replace { index: 9 }, 7, &project).is_none());
    }

    #[test]
    fn copied_library_audio_includes_source_duration() {
        let root =
            std::env::temp_dir().join(format!("cap-gpui-audio-duration-{}", std::process::id()));
        let (path, name, duration) =
            copy_library_track(&root, "lofi-beats-mirostar", "Lofi Beats").unwrap();
        assert_eq!(name, "Lofi Beats");
        assert!(duration > 0.0);
        assert_eq!(duration, probe_audio_duration(&root.join(path)));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn built_in_music_resolves_from_an_installed_bundle() {
        let root =
            std::env::temp_dir().join(format!("cap-gpui-installed-music-{}", std::process::id()));
        let resources = root.join("Cap.app/Contents/Resources");
        let music = resources.join("assets/music");
        std::fs::create_dir_all(&music).unwrap();
        let track = music.join("lofi-beats-mirostar.mp3");
        std::fs::write(&track, b"test track").unwrap();

        assert_eq!(
            bundled_track_path_from("lofi-beats-mirostar", &[resources], &root.join("missing")),
            Some(track)
        );

        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn built_in_music_remains_available_from_the_development_checkout() {
        for (id, _) in AUDIO_LIBRARY {
            assert!(
                bundled_track_path(id).is_some(),
                "missing bundled track {id}"
            );
        }
    }

    #[test]
    fn built_in_music_rejects_unknown_and_traversal_identifiers() {
        assert_eq!(bundled_track_path("unknown-track"), None);
        assert_eq!(bundled_track_path("../lofi-beats-mirostar"), None);
    }
}
