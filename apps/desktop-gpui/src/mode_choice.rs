use crate::{app_windows, i18n::tr, main_window::Mode, settings_window::Page};

/// "Record Diatribe": start talking right away, get notes and action items. Not a brand word,
/// so it stays outside the brand door.
pub const DIATRIBE_NAME: &str = "Record Diatribe";
pub const DIATRIBE_SHORT_NAME: &str = "Diatribe";
pub const DIATRIBE_ICON: &str = "icons/microphone.svg";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ModeChoice {
    Capture(Mode),
    UxWalk,
    /// An action rather than a mode you stay in: it records at once and the mode is unchanged.
    Diatribe,
}

impl ModeChoice {
    pub const ALL: &'static [Self] = &[
        Self::Capture(Mode::Instant),
        Self::Capture(Mode::Studio),
        Self::Capture(Mode::Screenshot),
        #[cfg(target_os = "macos")]
        Self::UxWalk,
        #[cfg(target_os = "macos")]
        Self::Diatribe,
    ];

    pub fn capture_mode(self) -> Option<Mode> {
        match self {
            Self::Capture(mode) => Some(mode),
            Self::UxWalk | Self::Diatribe => None,
        }
    }

    /// A mode the recorder can be left in. Lists of default modes skip the diatribe action.
    pub fn selectable(self) -> bool {
        self != Self::Diatribe
    }

    pub fn title(self) -> &'static str {
        match self {
            Self::Capture(mode) => mode.panel_title(),
            Self::UxWalk => fork_brand::WALK_MODE_NAME,
            Self::Diatribe => DIATRIBE_NAME,
        }
    }

    pub fn icon(self) -> &'static str {
        match self {
            Self::Capture(mode) => mode.icon(),
            Self::UxWalk => "icons/ux-walk.svg",
            Self::Diatribe => DIATRIBE_ICON,
        }
    }

    pub fn icon_size(self) -> f32 {
        match self {
            Self::Capture(mode) => mode.icon_size(),
            Self::UxWalk | Self::Diatribe => 16.,
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
                "Open a new browser window, record a product walkthrough, and keep notes, chapters and transcripts ready for your agent."
            }
            Self::Diatribe => {
                "Talk it through; get notes and action items. Records your screen and microphone at once, then organizes what you said for your agent."
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
            Self::UxWalk => {
                "Open a new browser window and record a walk with notes, chapters and transcripts."
            }
            Self::Diatribe => "Talk it through; get notes and action items.",
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
            Self::UxWalk => fork_brand::text_static(
                "Opens a new browser window and selects it for recording. Keep Cap’s camera, microphone and capture options, then review notes, chapters and transcripts.",
            ),
            Self::Diatribe => {
                "Talk it through; get notes and action items. Starts recording the screen under your pointer with your microphone right away."
            }
        }
    }

    pub fn display_name(self) -> &'static str {
        match self {
            Self::Capture(mode) => mode.display_name(),
            Self::UxWalk => fork_brand::WALK_MODE_NAME,
            Self::Diatribe => DIATRIBE_SHORT_NAME,
        }
    }

    pub fn settings_label(self) -> &'static str {
        match self {
            Self::Capture(_) => tr::main::mode::hover::quality_settings(),
            Self::UxWalk | Self::Diatribe => fork_brand::mode_text_static("%walk% settings"),
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
            Self::Diatribe => crate::ux_walk::start_diatribe(cx),
        }
    }

    pub fn open_settings(self, cx: &mut gpui::App) {
        match self {
            Self::Capture(mode) => app_windows::open_quality_settings(mode, cx),
            Self::UxWalk | Self::Diatribe => app_windows::open_settings(Page::General, cx),
        }
    }
}
