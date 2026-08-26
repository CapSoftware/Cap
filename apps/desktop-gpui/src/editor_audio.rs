use std::path::{Path, PathBuf};

use gpui::{
    AnyElement, Context, FontWeight, Hsla, InteractiveElement, IntoElement, ParentElement,
    SharedString, StatefulInteractiveElement, Styled, div, px, svg,
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
    Ok((format!("assets/audio/{dest_name}"), name.to_string(), 0.0))
}

impl EditorWindow {
    pub(crate) fn render_audio_library(&self, cx: &mut Context<Self>) -> AnyElement {
        let theme = self.theme;
        let is_replace = matches!(self.audio_picker, Some(AudioPicker::Replace { .. }));

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
                    .on_click(cx.listener(|this, _, window, cx| {
                        this.import_audio_from_picker(window, cx);
                    })),
            )
            .child(
                div().flex().flex_col().gap(px(6.)).children(
                    AUDIO_LIBRARY
                        .iter()
                        .copied()
                        .map(|(id, name)| render_library_row(&theme, id, name, cx)),
                ),
            )
            .into_any_element()
    }
}

fn render_library_row(
    theme: &Theme,
    id: &'static str,
    name: &'static str,
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
        .cursor_pointer()
        .hover(|this| this.bg(Hsla::from(theme.gray_3)))
        .on_click(cx.listener(move |this, _, window, cx| {
            this.add_library_track(id, name, window, cx);
        }))
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
    use super::{AUDIO_LIBRARY, bundled_track_path, bundled_track_path_from};

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
