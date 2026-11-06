use crate::{app_windows, i18n::tr, main_window::Mode, settings_window::Page};

/// Worm Mode's voice-only choice: no browser window or console, just notes and action items
/// from what you say. Not a brand word, so it stays outside the brand door.
pub const DIATRIBE_NAME: &str = "Diatribe";
pub const DIATRIBE_ICON: &str = "icons/microphone.svg";

/// A diatribe's name in the library and the tray: "Diatribe 2026-11-05 18.20".
pub fn diatribe_title(at: chrono::DateTime<chrono::Local>) -> String {
    format!("{DIATRIBE_NAME} {}", at.format("%Y-%m-%d %H.%M"))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ModeChoice {
    Capture(Mode),
    UxWalk,
}

impl ModeChoice {
    pub const ALL: &'static [Self] = &[
        Self::Capture(Mode::Instant),
        Self::Capture(Mode::Studio),
        Self::Capture(Mode::Screenshot),
        #[cfg(target_os = "macos")]
        Self::UxWalk,
    ];

    pub fn capture_mode(self) -> Option<Mode> {
        match self {
            Self::Capture(mode) => Some(mode),
            Self::UxWalk => None,
        }
    }

    pub fn title(self) -> &'static str {
        match self {
            Self::Capture(mode) => mode.panel_title(),
            Self::UxWalk => fork_brand::WALK_MODE_NAME,
        }
    }

    pub fn icon(self) -> &'static str {
        match self {
            Self::Capture(mode) => mode.icon(),
            Self::UxWalk => "icons/ux-walk.svg",
        }
    }

    pub fn icon_size(self) -> f32 {
        match self {
            Self::Capture(mode) => mode.icon_size(),
            Self::UxWalk => 16.,
        }
    }

    pub fn index(self) -> usize {
        Self::ALL
            .iter()
            .position(|choice| *choice == self)
            .unwrap_or(0)
    }

    pub fn panel_description(self) -> &'static str {
        match self {
            Self::Capture(Mode::Instant) => {
                "Record a ready-to-play video locally. Share it through your chosen server when you are ready."
            }
            Self::Capture(Mode::Studio) => {
                "Record locally in the highest quality for editing later. Perfect for \
                 creating polished content with effects and transitions."
            }
            Self::Capture(Mode::Screenshot) => {
                "Capture and annotate screenshots instantly. Great for quick captures, bug \
                 reports, and visual communication."
            }
            Self::UxWalk => {
                "Walk through your product in a fresh browser window, or choose Diatribe and just talk. Either way your agent gets notes and transcripts."
            }
        }
    }

    pub fn card_description(self) -> &'static str {
        match self {
            Self::Capture(Mode::Instant) if cfg!(feature = "ux-walk") => {
                "Record a ready-to-play video locally. Share when you choose."
            }
            Self::Capture(Mode::Instant) => "Share instantly with a link. Uploads as you record.",
            Self::Capture(Mode::Studio) => "Highest quality local recording for editing later.",
            Self::Capture(Mode::Screenshot) => "Capture and annotate screenshots instantly.",
            Self::UxWalk => "Record a worm or a diatribe.",
        }
    }

    pub fn hover_description(self) -> &'static str {
        match self {
            Self::Capture(Mode::Instant) if cfg!(feature = "ux-walk") => {
                "Saves a ready-to-play video on your Mac. Share it through your chosen server from Recordings."
            }
            Self::Capture(Mode::Instant) => {
                "No rendering required — uploads on the fly so you can share the link the moment you stop."
            }
            Self::Capture(Mode::Studio) => {
                "Saves to your computer and opens the editor when you stop. Choose recording quality in settings."
            }
            Self::Capture(Mode::Screenshot) => "Capture and annotate stills.",
            Self::UxWalk => {
                "A worm records a fresh Chrome window with its clicks, console and failed requests. A diatribe records your voice and the screen under your pointer, with no browser. Either way your agent gets notes and transcripts."
            }
        }
    }

    pub fn display_name(self) -> &'static str {
        match self {
            Self::Capture(mode) => mode.display_name(),
            Self::UxWalk => fork_brand::WALK_MODE_NAME,
        }
    }

    pub fn settings_label(self) -> &'static str {
        match self {
            Self::Capture(_) => tr::main::mode::hover::quality_settings(),
            Self::UxWalk => fork_brand::mode_text_static("%walk% settings"),
        }
    }

    pub fn localized_hover_description(self) -> &'static str {
        match self {
            Self::Capture(Mode::Studio) => tr::main::mode::hover::studio_description(),
            Self::Capture(Mode::Screenshot) => tr::main::mode::hover::screenshot_description(),
            Self::Capture(Mode::Instant) if !cfg!(feature = "ux-walk") => {
                tr::main::mode::hover::instant_description()
            }
            _ => self.hover_description(),
        }
    }

    pub fn activate(self, cx: &mut gpui::App) {
        match self {
            Self::Capture(mode) => app_windows::set_recording_mode(mode, cx),
            Self::UxWalk => crate::ux_walk::start(cx),
        }
    }

    pub fn open_settings(self, cx: &mut gpui::App) {
        match self {
            Self::Capture(mode) => app_windows::open_quality_settings(mode, cx),
            Self::UxWalk => app_windows::open_settings(Page::General, cx),
        }
    }
}
