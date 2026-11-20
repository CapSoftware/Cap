//! Built-in looks: whole styles applied in one click from the Presets menu.
//!
//! A look sets only what makes a recording look a certain way -- the
//! background, framing, shadow, border and frame, how zooms move, how the
//! cursor glides, the key-press keys and the caption style -- and leaves the
//! timeline, camera, audio and everything else in the project as it is.

use cap_project::{
    AnimatedGradientConfig, BackgroundSource, BorderConfiguration, CornerStyle,
    CursorAnimationStyle, CursorType, FrameConfiguration, FrameStyle, FrameTheme, KeyboardData,
    KeyboardSettings, PaddingMode, ProjectConfiguration, ScreenMovementSpring, ShadowConfiguration,
};

use crate::i18n::tr;

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum LookBackground {
    /// A catalogue wallpaper, by id.
    Wallpaper(&'static str),
    Gradient {
        from: [u16; 3],
        to: [u16; 3],
        angle: u16,
    },
    Color([u16; 3]),
    /// An animated background from the built-in templates, by name.
    Animated(&'static str),
}

/// The cursor shapes a look draws.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LookCursorStyle {
    Recorded,
    MacOS,
    Tahoe,
    Windows,
}

impl LookCursorStyle {
    pub fn cursor_type(self) -> CursorType {
        match self {
            Self::Recorded => CursorType::Auto,
            Self::MacOS => CursorType::MacOS,
            Self::Tahoe => CursorType::MacOSTahoe,
            Self::Windows => CursorType::Windows,
        }
    }
}

/// How a look draws the cursor.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct LookCursor {
    pub style: LookCursorStyle,
    /// Percent of the recorded size.
    pub size: u32,
    pub ripple: bool,
    /// Motion blur on the cursor and the screen, 0 to 1.
    pub motion_blur: f32,
}

/// The key-press keys a look uses; `None` style keeps the platform's own.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct LookKeys {
    pub style: Option<&'static str>,
    pub theme: &'static str,
}

#[derive(Debug, Clone, Copy)]
pub struct Look {
    pub id: &'static str,
    pub name: fn() -> &'static str,
    pub description: fn() -> &'static str,
    pub background: LookBackground,
    /// Padding and corner rounding, in the background panel's own units.
    pub padding: f64,
    pub rounding: f64,
    /// The card's shadow: overall strength, then size, opacity and blur.
    pub shadow: (f32, f32, f32, f32),
    /// A fine border: width and opacity, in white.
    pub border: Option<(f32, f32)>,
    pub frame: Option<(FrameStyle, FrameTheme)>,
    pub zoom: ScreenMovementSpring,
    pub cursor: CursorAnimationStyle,
    pub pointer: LookCursor,
    pub keys: LookKeys,
    /// The caption preset the look sets when the project has captions.
    pub captions: &'static str,
    /// Whether the card in the preview reads as a dark app.
    pub dark_app: bool,
}

const DEFAULT_ZOOM: ScreenMovementSpring = ScreenMovementSpring::NEW_PROJECT;

pub static LOOKS: [Look; 8] = [
    Look {
        id: "smooth-demo",
        name: tr::editor::window::looks::smooth_demo,
        description: tr::editor::window::looks::smooth_demo_description,
        background: LookBackground::Animated("Cool Candy"),
        padding: 14.0,
        rounding: 11.0,
        shadow: (50.0, 0.0, 55.0, 60.0),
        border: None,
        frame: None,
        zoom: ScreenMovementSpring {
            stiffness: 120.0,
            damping: 28.0,
            mass: 2.0,
            start_zooms_early: true,
        },
        cursor: CursorAnimationStyle::Smooth,
        pointer: LookCursor {
            style: LookCursorStyle::MacOS,
            size: 150,
            ripple: true,
            motion_blur: 1.0,
        },
        keys: LookKeys {
            style: Some("macos"),
            theme: "dark",
        },
        captions: "soft",
        dark_app: false,
    },
    Look {
        id: "mac-native",
        name: tr::editor::window::looks::mac_native,
        description: tr::editor::window::looks::mac_native_description,
        background: LookBackground::Wallpaper("macOS/tahoe-day-min"),
        padding: 10.0,
        rounding: 7.0,
        shadow: (40.0, 0.0, 50.0, 45.0),
        border: None,
        frame: Some((FrameStyle::MacOS, FrameTheme::Light)),
        zoom: DEFAULT_ZOOM,
        cursor: CursorAnimationStyle::Mellow,
        pointer: LookCursor {
            style: LookCursorStyle::Tahoe,
            size: 120,
            ripple: false,
            motion_blur: 0.6,
        },
        keys: LookKeys {
            style: Some("macos"),
            theme: "light",
        },
        captions: "soft",
        dark_app: false,
    },
    Look {
        id: "midnight",
        name: tr::editor::window::looks::midnight,
        description: tr::editor::window::looks::midnight_description,
        background: LookBackground::Wallpaper("dark/3"),
        padding: 16.0,
        rounding: 14.0,
        shadow: (75.0, 10.0, 75.0, 70.0),
        border: Some((1.5, 14.0)),
        frame: None,
        zoom: DEFAULT_ZOOM,
        cursor: CursorAnimationStyle::Mellow,
        pointer: LookCursor {
            style: LookCursorStyle::MacOS,
            size: 130,
            ripple: true,
            motion_blur: 1.0,
        },
        keys: LookKeys {
            style: Some("macos"),
            theme: "dark",
        },
        captions: "soft",
        dark_app: true,
    },
    Look {
        id: "minimal",
        name: tr::editor::window::looks::minimal,
        description: tr::editor::window::looks::minimal_description,
        background: LookBackground::Color([245, 245, 247]),
        padding: 3.0,
        rounding: 2.0,
        shadow: (12.0, 0.0, 25.0, 20.0),
        border: None,
        frame: None,
        zoom: DEFAULT_ZOOM,
        cursor: CursorAnimationStyle::Mellow,
        pointer: LookCursor {
            style: LookCursorStyle::Recorded,
            size: 100,
            ripple: false,
            motion_blur: 0.3,
        },
        keys: LookKeys {
            style: None,
            theme: "light",
        },
        captions: "classic",
        dark_app: false,
    },
    Look {
        id: "launch-day",
        name: tr::editor::window::looks::launch_day,
        description: tr::editor::window::looks::launch_day_description,
        background: LookBackground::Animated("Good Energy"),
        padding: 18.0,
        rounding: 16.0,
        shadow: (70.0, 8.0, 65.0, 70.0),
        border: None,
        frame: None,
        zoom: ScreenMovementSpring {
            stiffness: 280.0,
            damping: 26.0,
            mass: 1.0,
            start_zooms_early: false,
        },
        cursor: CursorAnimationStyle::Fast,
        pointer: LookCursor {
            style: LookCursorStyle::MacOS,
            size: 170,
            ripple: true,
            motion_blur: 1.0,
        },
        keys: LookKeys {
            style: Some("macos"),
            theme: "dark",
        },
        captions: "highlight",
        dark_app: false,
    },
    Look {
        id: "tutorial",
        name: tr::editor::window::looks::tutorial,
        description: tr::editor::window::looks::tutorial_description,
        background: LookBackground::Wallpaper("blue/3"),
        padding: 8.0,
        rounding: 7.0,
        shadow: (35.0, 0.0, 50.0, 40.0),
        border: None,
        frame: None,
        zoom: ScreenMovementSpring {
            stiffness: 110.0,
            damping: 30.0,
            mass: 2.4,
            start_zooms_early: true,
        },
        cursor: CursorAnimationStyle::Slow,
        pointer: LookCursor {
            style: LookCursorStyle::MacOS,
            size: 200,
            ripple: true,
            motion_blur: 0.5,
        },
        keys: LookKeys {
            style: None,
            theme: "light",
        },
        captions: "karaoke",
        dark_app: false,
    },
    Look {
        id: "web-product",
        name: tr::editor::window::looks::web_product,
        description: tr::editor::window::looks::web_product_description,
        background: LookBackground::Gradient {
            from: [233, 238, 255],
            to: [205, 219, 255],
            angle: 160,
        },
        padding: 9.0,
        rounding: 8.0,
        shadow: (35.0, 0.0, 45.0, 45.0),
        border: None,
        frame: Some((FrameStyle::Browser, FrameTheme::Light)),
        zoom: DEFAULT_ZOOM,
        cursor: CursorAnimationStyle::Mellow,
        pointer: LookCursor {
            style: LookCursorStyle::Tahoe,
            size: 120,
            ripple: true,
            motion_blur: 0.8,
        },
        keys: LookKeys {
            style: None,
            theme: "light",
        },
        captions: "soft",
        dark_app: false,
    },
    Look {
        id: "retro-desk",
        name: tr::editor::window::looks::retro_desk,
        description: tr::editor::window::looks::retro_desk_description,
        background: LookBackground::Gradient {
            from: [236, 228, 208],
            to: [206, 193, 160],
            angle: 145,
        },
        padding: 12.0,
        rounding: 4.0,
        shadow: (35.0, 0.0, 45.0, 35.0),
        border: None,
        frame: None,
        zoom: DEFAULT_ZOOM,
        cursor: CursorAnimationStyle::Mellow,
        pointer: LookCursor {
            style: LookCursorStyle::Windows,
            size: 130,
            ripple: false,
            motion_blur: 0.6,
        },
        keys: LookKeys {
            style: Some("mechanical"),
            theme: "retro",
        },
        captions: "classic",
        dark_app: false,
    },
];

/// `current` with `look` applied: the look's styling, the rest of the
/// project untouched.
pub fn apply_look(look: &Look, current: &ProjectConfiguration) -> ProjectConfiguration {
    let mut next = current.clone();
    let background = &mut next.background;
    match look.background {
        LookBackground::Wallpaper(id) => {
            if let Some(path) = crate::editor_sidebar::wallpaper_path(id) {
                background.source = BackgroundSource::Wallpaper {
                    path: Some(path.to_string_lossy().into_owned()),
                };
            }
        }
        LookBackground::Gradient { from, to, angle } => {
            background.source = BackgroundSource::Gradient {
                from,
                to,
                angle,
                noise_intensity: None,
                noise_scale: None,
                animated: None,
                animation_speed: None,
            };
        }
        LookBackground::Color(value) => {
            background.source = BackgroundSource::Color { value, alpha: 255 };
        }
        LookBackground::Animated(name) => {
            if let Some(config) = animated_background(name) {
                background.source = BackgroundSource::AnimatedGradient { config };
            }
        }
    }
    background.blur = 0.0;
    background.padding = look.padding;
    background.padding_mode = PaddingMode::Even;
    background.rounding = look.rounding;
    background.rounding_type = CornerStyle::Squircle;
    let (shadow, size, opacity, blur) = look.shadow;
    background.shadow = shadow;
    background.advanced_shadow = Some(ShadowConfiguration {
        size,
        opacity,
        blur,
    });
    background.border = look.border.map(|(width, opacity)| BorderConfiguration {
        enabled: true,
        width,
        color: [255, 255, 255],
        opacity,
    });
    background.frame = match look.frame {
        Some((style, theme)) => Some(FrameConfiguration {
            style,
            theme,
            ..background.frame.clone().unwrap_or_default()
        }),
        None => background.frame.clone().map(|frame| FrameConfiguration {
            style: FrameStyle::None,
            ..frame
        }),
    };

    next.screen_movement_spring = look.zoom;

    next.cursor
        .set_cursor_type(look.pointer.style.cursor_type());
    next.cursor.size = look.pointer.size;
    next.cursor.ripple.enabled = look.pointer.ripple;
    // One slider drives both blurs in the editor.
    next.cursor.motion_blur = look.pointer.motion_blur;
    next.screen_motion_blur = look.pointer.motion_blur;
    next.cursor.animation_style = look.cursor;
    if let Some(preset) = look.cursor.preset() {
        next.cursor.tension = preset.tension;
        next.cursor.mass = preset.mass;
        next.cursor.friction = preset.friction;
    }

    let keyboard = next.keyboard.get_or_insert_with(|| KeyboardData {
        settings: KeyboardSettings::default(),
    });
    keyboard.settings.style = look
        .keys
        .style
        .map_or_else(KeyboardSettings::platform_style, str::to_string);
    keyboard.settings.theme = look.keys.theme.to_string();

    if let Some(captions) = next.captions.as_mut()
        && let Some(preset) = crate::editor_tabs::CAPTION_PRESETS
            .iter()
            .find(|preset| preset.id == look.captions)
    {
        crate::editor_tabs::apply_caption_preset_settings(&mut captions.settings, preset);
    }
    next
}

/// `project` with every setting a look writes put back as `before` had
/// it, and everything else (an edit made while the look was previewed) kept.
pub fn take_off_look(project: &mut ProjectConfiguration, before: &ProjectConfiguration) {
    project.background = before.background.clone();
    project.screen_movement_spring = before.screen_movement_spring;
    project.screen_motion_blur = before.screen_motion_blur;
    let cursor = &mut project.cursor;
    cursor.set_cursor_type(before.cursor.cursor_type().clone());
    cursor.size = before.cursor.size;
    cursor.ripple.enabled = before.cursor.ripple.enabled;
    cursor.motion_blur = before.cursor.motion_blur;
    cursor.animation_style = before.cursor.animation_style;
    cursor.tension = before.cursor.tension;
    cursor.mass = before.cursor.mass;
    cursor.friction = before.cursor.friction;
    match (project.keyboard.as_mut(), before.keyboard.as_ref()) {
        (Some(keyboard), Some(earlier)) => {
            keyboard.settings.style = earlier.settings.style.clone();
            keyboard.settings.theme = earlier.settings.theme.clone();
        }
        (Some(_), None) => project.keyboard = None,
        _ => {}
    }
    if let (Some(captions), Some(earlier)) = (project.captions.as_mut(), before.captions.as_ref()) {
        captions.settings = earlier.settings.clone();
    }
}

/// A built-in animated background, by its template name.
pub fn animated_background(name: &str) -> Option<AnimatedGradientConfig> {
    animated_template(name).cloned()
}

/// The looks gallery reads two templates on every repaint, and the catalogue
/// builds and normalises all of them, so it is built once.
fn animated_template(name: &str) -> Option<&'static AnimatedGradientConfig> {
    static TEMPLATES: std::sync::LazyLock<Vec<cap_project::AnimatedGradientPreset>> =
        std::sync::LazyLock::new(|| cap_project::animated_gradient_catalog().templates);
    TEMPLATES
        .iter()
        .find(|template| template.name == name)
        .map(|template| &template.config)
}

/// The first and last colours of a built-in animated background, for the
/// gallery's small picture of it.
pub fn animated_background_ends(name: &str) -> Option<([u16; 3], [u16; 3])> {
    match animated_template(name)?.color_stops.as_slice() {
        [first, .., last] => Some((first.color, last.color)),
        _ => None,
    }
}

/// Which look the project is wearing: the one whose styling it still has
/// in every part a look sets.
pub fn current_look(project: &ProjectConfiguration) -> Option<&'static str> {
    LOOKS
        .iter()
        .find(|look| look_settings(&apply_look(look, project)) == look_settings(project))
        .map(|look| look.id)
}

/// Every setting a look writes, for comparing two projects on them alone.
fn look_settings(project: &ProjectConfiguration) -> serde_json::Value {
    serde_json::json!({
        "background": project.background,
        "zoom": project.screen_movement_spring,
        "cursor": [
            serde_json::to_value(project.cursor.animation_style).ok(),
            serde_json::to_value(project.cursor.cursor_type()).ok(),
            serde_json::json!(project.cursor.tension),
            serde_json::json!(project.cursor.mass),
            serde_json::json!(project.cursor.friction),
            serde_json::json!(project.cursor.size),
            serde_json::json!(project.cursor.ripple.enabled),
            serde_json::json!(project.cursor.motion_blur),
            serde_json::json!(project.screen_motion_blur),
        ],
        "keys": project.keyboard.as_ref().map(|keyboard| {
            (keyboard.settings.style.clone(), keyboard.settings.theme.clone())
        }),
        "captions": project.captions.as_ref().map(|captions| &captions.settings),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_look_has_a_unique_id_and_a_name() {
        let mut ids: Vec<&str> = LOOKS.iter().map(|look| look.id).collect();
        ids.sort_unstable();
        ids.dedup();
        assert_eq!(ids.len(), LOOKS.len());
        for look in &LOOKS {
            assert!(!(look.name)().is_empty());
            assert!(!(look.description)().is_empty());
        }
    }

    #[test]
    fn every_look_names_a_wallpaper_and_caption_preset_that_exist() {
        for look in &LOOKS {
            match look.background {
                LookBackground::Wallpaper(id) => assert!(
                    crate::editor_sidebar::WALLPAPER_NAMES.contains(&id),
                    "{}: {id}",
                    look.id
                ),
                LookBackground::Animated(name) => {
                    assert!(animated_background(name).is_some(), "{}: {name}", look.id)
                }
                _ => {}
            }
            assert!(
                crate::editor_tabs::CAPTION_PRESETS
                    .iter()
                    .any(|preset| preset.id == look.captions),
                "{}: {}",
                look.id,
                look.captions
            );
        }
    }

    #[test]
    fn a_look_styles_the_project_and_keeps_the_rest() {
        let mut project = ProjectConfiguration::for_new_project();
        project.camera.size = 33.0;
        project.cursor.size = 140;
        let look = LOOKS.iter().find(|look| look.id == "launch-day").unwrap();
        let next = apply_look(look, &project);
        assert_eq!(next.background.padding, 18.0);
        assert!(matches!(
            next.background.source,
            BackgroundSource::AnimatedGradient { .. }
        ));
        assert_eq!(next.screen_movement_spring.stiffness, 280.0);
        assert!(matches!(
            next.cursor.animation_style,
            CursorAnimationStyle::Fast
        ));
        assert_eq!(next.keyboard.as_ref().unwrap().settings.style, "macos");
        // The cursor is part of the look: its style, size and ripple.
        assert_eq!(next.cursor.cursor_type(), &CursorType::MacOS);
        assert_eq!(next.cursor.size, 170);
        assert!(next.cursor.ripple.enabled);
        // Untouched: the camera and whether keys show.
        assert_eq!(next.camera.size, 33.0);
        assert!(!next.keyboard.as_ref().unwrap().settings.enabled);
        assert_eq!(current_look(&next), Some("launch-day"));
        assert_eq!(current_look(&project), None);
        // Changing anything the look set means it is no longer the look.
        let mut tweaked = next.clone();
        tweaked.keyboard.as_mut().unwrap().settings.theme = "light".into();
        assert_eq!(current_look(&tweaked), None);
        let mut slower = next.clone();
        slower.cursor.animation_style = CursorAnimationStyle::Slow;
        assert_eq!(current_look(&slower), None);
    }

    #[test]
    fn leaving_a_framed_look_takes_the_frame_away() {
        let project = ProjectConfiguration::for_new_project();
        let mac = LOOKS.iter().find(|look| look.id == "mac-native").unwrap();
        let framed = apply_look(mac, &project);
        assert_eq!(
            FrameConfiguration::active_style(framed.background.frame.as_ref()),
            FrameStyle::MacOS
        );
        let minimal = LOOKS.iter().find(|look| look.id == "minimal").unwrap();
        let bare = apply_look(minimal, &framed);
        assert_eq!(
            FrameConfiguration::active_style(bare.background.frame.as_ref()),
            FrameStyle::None
        );
    }
}

#[cfg(test)]
mod distinct_tests {
    use super::*;

    #[test]
    fn taking_a_look_off_keeps_an_edit_made_under_it() {
        let project = ProjectConfiguration::for_new_project();
        for look in &LOOKS {
            let mut previewed = apply_look(look, &project);
            // An edit the look does not touch, made while it was showing.
            previewed.camera.size = 41.0;
            take_off_look(&mut previewed, &project);
            assert_eq!(
                look_settings(&previewed),
                look_settings(&project),
                "{}",
                look.id
            );
            assert_eq!(previewed.camera.size, 41.0, "{}", look.id);
        }
    }

    /// Every look reads differently at a glance: no two share their
    /// background, framing and cursor all at once.
    #[test]
    fn no_two_looks_look_alike() {
        for (index, a) in LOOKS.iter().enumerate() {
            for b in &LOOKS[index + 1..] {
                let same = a.background == b.background
                    && a.padding == b.padding
                    && a.rounding == b.rounding
                    && a.pointer == b.pointer;
                assert!(!same, "{} and {}", a.id, b.id);
            }
        }
    }
}
