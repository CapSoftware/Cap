use cap_editor::InputSoundPreview;
use cap_project::{ClickSoundType, KeySoundType, KeyboardData};

use super::*;

const TILE_GAP: f32 = 8.;
const TILE_HEIGHT: f32 = 34.;
const TILE_RADIUS: f32 = 10.;
const TILE_GROUP: &str = "input-sound-tile";

const KEY_TYPES: [KeySoundType; 4] = [
    KeySoundType::Mechanical,
    KeySoundType::Deep,
    KeySoundType::Laptop,
    KeySoundType::Typewriter,
];
const CLICK_TYPES: [ClickSoundType; 2] = [ClickSoundType::Mouse, ClickSoundType::Trackpad];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum InputSoundSlider {
    Keys,
    Clicks,
}

impl InputSoundSlider {
    pub fn limits(self) -> (f32, f32, f32) {
        (0., 100., 1.)
    }

    pub fn read(self, project: &ProjectConfiguration) -> f32 {
        let volume = match self {
            Self::Keys => project
                .keyboard
                .as_ref()
                .map_or(cap_project::DEFAULT_INPUT_SOUND_VOLUME, |keyboard| {
                    keyboard.settings.key_sound_volume
                }),
            Self::Clicks => project.cursor.click_sound_volume,
        };
        (volume * 100.).round()
    }
}

fn key_label(kind: KeySoundType) -> &'static str {
    match kind {
        KeySoundType::Mechanical => tr::editor::sidebar::input_sounds::mechanical(),
        KeySoundType::Deep => tr::editor::sidebar::input_sounds::deep(),
        KeySoundType::Laptop => tr::editor::sidebar::input_sounds::laptop(),
        KeySoundType::Typewriter => tr::editor::sidebar::input_sounds::typewriter(),
    }
}

fn key_description(kind: KeySoundType) -> &'static str {
    match kind {
        KeySoundType::Mechanical => tr::editor::sidebar::input_sounds::mechanical_description(),
        KeySoundType::Deep => tr::editor::sidebar::input_sounds::deep_description(),
        KeySoundType::Laptop => tr::editor::sidebar::input_sounds::laptop_description(),
        KeySoundType::Typewriter => tr::editor::sidebar::input_sounds::typewriter_description(),
    }
}

fn click_label(kind: ClickSoundType) -> &'static str {
    match kind {
        ClickSoundType::Mouse => tr::editor::sidebar::input_sounds::mouse(),
        ClickSoundType::Trackpad => tr::editor::sidebar::input_sounds::trackpad(),
    }
}

fn click_description(kind: ClickSoundType) -> &'static str {
    match kind {
        ClickSoundType::Mouse => tr::editor::sidebar::input_sounds::mouse_description(),
        ClickSoundType::Trackpad => tr::editor::sidebar::input_sounds::trackpad_description(),
    }
}

/// Plays a short phrase in the chosen sound off the UI thread, through the
/// default output, so a choice can be heard without starting playback.
fn audition(preview: InputSoundPreview, volume: f32) {
    let spawned = std::thread::Builder::new()
        .name("input-sound-preview".into())
        .spawn(move || {
            let Some(samples) = cap_editor::render_input_sound_preview(preview, volume) else {
                return;
            };
            let played = rodio::OutputStream::try_default()
                .map_err(|error| error.to_string())
                .and_then(|(_stream, handle)| {
                    let sink = rodio::Sink::try_new(&handle).map_err(|error| error.to_string())?;
                    sink.append(rodio::buffer::SamplesBuffer::new(
                        2,
                        cap_audio::AudioData::SAMPLE_RATE,
                        samples,
                    ));
                    sink.sleep_until_end();
                    Ok(())
                });
            if let Err(error) = played {
                tracing::warn!(%error, "Could not preview the input sound");
            }
        });
    if let Err(error) = spawned {
        tracing::warn!(%error, "Could not start the input sound preview");
    }
}

impl EditorWindow {
    pub(crate) fn apply_input_sound_slider(
        &mut self,
        slider: InputSoundSlider,
        value: f32,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let volume = (value / 100.).clamp(0., 1.);
        self.edit_project_without_timeline("input-sound-volume", window, cx, move |project| {
            match slider {
                InputSoundSlider::Keys => {
                    project
                        .keyboard
                        .get_or_insert_with(KeyboardData::default)
                        .settings
                        .key_sound_volume = volume
                }
                InputSoundSlider::Clicks => project.cursor.click_sound_volume = volume,
            }
            true
        });
    }

    fn render_sound_tile(
        &self,
        id: SharedString,
        label: &'static str,
        selected: bool,
        on_click: impl Fn(&mut Self, &mut Window, &mut Context<Self>) + 'static,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let theme = self.theme;
        div()
            .id(id)
            .group(TILE_GROUP)
            .flex_1()
            .min_w_0()
            .h(px(TILE_HEIGHT))
            .rounded(px(TILE_RADIUS))
            .flex()
            .items_center()
            .justify_center()
            .px(px(8.))
            .cursor_pointer()
            .map(|this| {
                if selected {
                    this.border_2()
                        .border_color(Hsla::from(theme.blue_8))
                        .bg(with_alpha(theme.blue_3, 0.4))
                } else {
                    this.border_1()
                        .border_color(Hsla::from(theme.gray_3))
                        .bg(Hsla::from(theme.gray_2))
                        .hover(|this| this.border_color(Hsla::from(theme.gray_5)))
                }
            })
            .child(
                div()
                    .max_w_full()
                    .whitespace_nowrap()
                    .overflow_hidden()
                    .text_ellipsis()
                    .text_size(px(12.))
                    .font_weight(FontWeight::MEDIUM)
                    .text_color(Hsla::from(if selected {
                        theme.gray_12
                    } else {
                        theme.gray_11
                    }))
                    .child(label),
            )
            .on_click(cx.listener(move |this, _, window, cx| on_click(this, window, cx)))
            .into_any_element()
    }

    fn render_sound_options(
        &self,
        rows: Vec<Vec<AnyElement>>,
        description: &'static str,
        volume: SliderKey,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        div()
            .flex()
            .flex_col()
            .gap(px(TILE_GAP))
            .pt(px(4.))
            .pb(px(8.))
            .children(
                rows.into_iter()
                    .map(|row| div().flex().flex_row().gap(px(TILE_GAP)).children(row)),
            )
            .child(
                div()
                    .text_size(px(11.))
                    .text_color(Hsla::from(self.theme.gray_11))
                    .child(description),
            )
            .child(self.slider_field(tr::editor::sidebar::input_sounds::volume(), volume, "%", cx))
            .into_any_element()
    }

    /// Key sounds follow the keyboard track: they play for presses while their
    /// keys are on screen, so they live with the overlay's own settings.
    pub(crate) fn render_key_sounds(&self, cx: &mut Context<Self>) -> AnyElement {
        let theme = self.theme;
        let settings = crate::editor_tabs::keyboard_settings(&self.project);
        let enabled = settings.key_sounds;
        let selected = settings.key_sound_type;
        let mut section = div().flex().flex_col().child(
            ui::Field::inline(&theme, tr::editor::sidebar::input_sounds::key_sounds()).value(
                ui::Toggle::plain(&theme, "key-sounds", enabled)
                    .on_click(cx.listener(move |this, _, window, cx| {
                        this.edit_project_without_timeline("key-sounds", window, cx, |project| {
                            let settings = &mut project
                                .keyboard
                                .get_or_insert_with(KeyboardData::default)
                                .settings;
                            settings.key_sounds = !enabled;
                            true
                        });
                    }))
                    .into_any_element(),
            ),
        );
        if enabled {
            let tiles = KEY_TYPES
                .iter()
                .map(|&kind| {
                    self.render_sound_tile(
                        SharedString::from(format!("key-sound-{kind:?}")),
                        key_label(kind),
                        kind == selected,
                        move |this, window, cx| {
                            this.edit_project_without_timeline(
                                "key-sound-type",
                                window,
                                cx,
                                |project| {
                                    let settings = &mut project
                                        .keyboard
                                        .get_or_insert_with(KeyboardData::default)
                                        .settings;
                                    let changed = settings.key_sound_type != kind;
                                    settings.key_sound_type = kind;
                                    changed
                                },
                            );
                            let volume = crate::editor_tabs::keyboard_settings(&this.project)
                                .key_sound_volume;
                            audition(InputSoundPreview::Keys(kind), volume);
                        },
                        cx,
                    )
                })
                .collect::<Vec<_>>();
            let mut tiles = tiles.into_iter();
            let rows = vec![tiles.by_ref().take(2).collect(), tiles.collect()];
            section = section.child(self.render_sound_options(
                rows,
                key_description(selected),
                SliderKey::InputSound(InputSoundSlider::Keys),
                cx,
            ));
        }
        section.into_any_element()
    }

    /// Click sounds sit with the cursor, which has to be visible for them to
    /// play. Inside a style segment the cursor tab edits that segment's look,
    /// and sounds are not part of it, so the section is left out there.
    pub(crate) fn render_click_sounds(&self, cx: &mut Context<Self>) -> AnyElement {
        if self.sidebar.style_target.is_some() {
            return div().into_any_element();
        }
        let theme = self.theme;
        let cursor = &self.project.cursor;
        let enabled = cursor.click_sounds;
        let selected = cursor.click_sound_type;
        let mut section = div().flex().flex_col().child(
            ui::Field::inline(&theme, tr::editor::sidebar::input_sounds::click_sounds()).value(
                ui::Toggle::plain(&theme, "click-sounds", enabled)
                    .on_click(cx.listener(move |this, _, window, cx| {
                        this.edit_project_without_timeline("click-sounds", window, cx, |project| {
                            project.cursor.click_sounds = !enabled;
                            true
                        });
                    }))
                    .into_any_element(),
            ),
        );
        if enabled {
            let tiles = CLICK_TYPES
                .iter()
                .map(|&kind| {
                    self.render_sound_tile(
                        SharedString::from(format!("click-sound-{kind:?}")),
                        click_label(kind),
                        kind == selected,
                        move |this, window, cx| {
                            this.edit_project_without_timeline(
                                "click-sound-type",
                                window,
                                cx,
                                |project| {
                                    let changed = project.cursor.click_sound_type != kind;
                                    project.cursor.click_sound_type = kind;
                                    changed
                                },
                            );
                            audition(
                                InputSoundPreview::Clicks(kind),
                                this.project.cursor.click_sound_volume,
                            );
                        },
                        cx,
                    )
                })
                .collect();
            section = section.child(self.render_sound_options(
                vec![tiles],
                click_description(selected),
                SliderKey::InputSound(InputSoundSlider::Clicks),
                cx,
            ));
        }
        section.into_any_element()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn volume_sliders_read_the_saved_fraction_as_a_percent() {
        let mut project = ProjectConfiguration::default();
        assert_eq!(InputSoundSlider::Keys.read(&project), 60.);
        assert_eq!(InputSoundSlider::Clicks.read(&project), 60.);
        project.keyboard = Some(KeyboardData::default());
        project.keyboard.as_mut().unwrap().settings.key_sound_volume = 0.25;
        project.cursor.click_sound_volume = 1.;
        assert_eq!(InputSoundSlider::Keys.read(&project), 25.);
        assert_eq!(InputSoundSlider::Clicks.read(&project), 100.);
        assert_eq!(InputSoundSlider::Keys.limits(), (0., 100., 1.));
    }

    #[test]
    fn every_sound_type_has_its_own_label_and_description() {
        let labels: std::collections::HashSet<&str> = KEY_TYPES
            .iter()
            .map(|kind| key_label(*kind))
            .chain(CLICK_TYPES.iter().map(|kind| click_label(*kind)))
            .collect();
        assert_eq!(labels.len(), KEY_TYPES.len() + CLICK_TYPES.len());
        let descriptions: std::collections::HashSet<&str> = KEY_TYPES
            .iter()
            .map(|kind| key_description(*kind))
            .chain(CLICK_TYPES.iter().map(|kind| click_description(*kind)))
            .collect();
        assert_eq!(descriptions.len(), labels.len());
    }
}
