use gpui::App;

use super::Entry;
#[cfg(target_os = "macos")]
use super::{TrayItem, mode_icon};
use crate::main_window::Mode;

#[cfg(target_os = "macos")]
const UX_WALK_ICON: &[u8] = include_bytes!("../../assets/tray/tray-default-icon-ux-walk.png");

fn editor_open(cx: &App) -> bool {
    crate::session::RecordingSession::global(cx)
        .read(cx)
        .editor_recording_target()
        .is_some()
}

#[cfg(target_os = "macos")]
pub(super) fn current_mode_icon(mode: Mode, cx: &App) -> &'static [u8] {
    if editor_open(cx) {
        mode_icon(Mode::Studio)
    } else if crate::store::ux_walk_selected() {
        UX_WALK_ICON
    } else {
        mode_icon(mode)
    }
}

#[cfg(target_os = "macos")]
pub(super) fn icon_name(png: &[u8]) -> Option<&'static str> {
    (png == UX_WALK_ICON).then_some("ux-walk")
}

/// "Record Diatribe" as its own row, after the capture rows and before Previous.
pub(super) fn add_menu_items(entries: &mut Vec<Entry>) {
    #[cfg(target_os = "macos")]
    {
        let after_captures = entries
            .iter()
            .position(|entry| matches!(entry, Entry::Submenu { .. }))
            .and_then(|index| index.checked_sub(1))
            .unwrap_or(entries.len());
        entries.insert(
            after_captures,
            Entry::item(crate::mode_choice::DIATRIBE_NAME, TrayItem::RecordDiatribe),
        );
    }
    #[cfg(not(target_os = "macos"))]
    let _ = entries;
}

pub(super) fn menu_mode(mode: Mode, cx: &App) -> Mode {
    let editor_open = editor_open(cx);
    #[cfg(target_os = "macos")]
    WALK_PILL_SHOWN.set(!editor_open && crate::store::ux_walk_selected());
    if editor_open { Mode::Studio } else { mode }
}

#[cfg(target_os = "macos")]
thread_local! {
    static WALK_PILL_SHOWN: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

#[cfg(target_os = "macos")]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Pill {
    Mode(Mode),
    UxWalk,
    /// Starts a diatribe; never the shown pill, since the mode does not change.
    Diatribe,
}

#[cfg(target_os = "macos")]
pub(super) type Pills = std::sync::LazyLock<Vec<(Pill, TrayItem)>>;

#[cfg(target_os = "macos")]
impl PartialEq<Mode> for Pill {
    fn eq(&self, mode: &Mode) -> bool {
        *self == Pill::Mode(*mode)
    }
}

#[cfg(target_os = "macos")]
impl From<Pill> for Mode {
    fn from(pill: Pill) -> Self {
        match pill {
            Pill::Mode(mode) => mode,
            Pill::UxWalk => Mode::Studio,
            Pill::Diatribe => Mode::from_store(),
        }
    }
}

#[cfg(target_os = "macos")]
pub(super) fn picker_pills(modes: &[(Mode, TrayItem)]) -> Vec<(Pill, TrayItem)> {
    modes
        .iter()
        .map(|(mode, item)| (Pill::Mode(*mode), item.clone()))
        .chain([
            (Pill::UxWalk, TrayItem::StartWalkthrough),
            (Pill::Diatribe, TrayItem::RecordDiatribe),
        ])
        .collect()
}

#[cfg(target_os = "macos")]
pub(super) fn shown_pill(mode: Mode) -> Pill {
    if WALK_PILL_SHOWN.get() {
        Pill::UxWalk
    } else {
        Pill::Mode(mode)
    }
}

#[cfg(target_os = "macos")]
pub(super) fn mode_name(pill: Pill) -> &'static str {
    match pill {
        Pill::Mode(mode) => super::mode_name(mode),
        Pill::UxWalk => crate::mode_choice::ModeChoice::UxWalk.display_name(),
        Pill::Diatribe => crate::mode_choice::DIATRIBE_NAME,
    }
}

#[cfg(target_os = "macos")]
pub(super) fn mode_heading(pill: Pill) -> &'static str {
    match pill {
        Pill::Mode(mode) => super::mode_heading(mode),
        Pill::UxWalk => fork_brand::WALK_MODE_NAME,
        Pill::Diatribe => crate::mode_choice::DIATRIBE_NAME,
    }
}

#[cfg(target_os = "macos")]
pub(super) fn mode_picker_icon(pill: Pill) -> Option<Vec<u8>> {
    match pill {
        Pill::Mode(mode) => super::mode_picker_icon(mode),
        Pill::UxWalk => super::svg_icon_png(
            include_bytes!("../../assets/icons/ux-walk.svg"),
            super::PICKER_ICON_SIZE,
        ),
        Pill::Diatribe => super::svg_icon_png(
            include_bytes!("../../assets/icons/microphone.svg"),
            super::PICKER_ICON_SIZE,
        ),
    }
}

#[cfg(target_os = "macos")]
pub(super) fn set_status_mode(pill: Pill) {
    if let Pill::Mode(mode) = pill {
        super::mac::set_status_mode(mode);
    }
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;

    const UPSTREAM_PILLS: [(Mode, TrayItem); 3] = [
        (Mode::Instant, TrayItem::ModeInstant),
        (Mode::Studio, TrayItem::ModeStudio),
        (Mode::Screenshot, TrayItem::ModeScreenshot),
    ];

    #[test]
    fn the_walk_pill_follows_the_upstream_mode_pills() {
        let pills = picker_pills(&UPSTREAM_PILLS);
        assert_eq!(
            pills,
            vec![
                (Pill::Mode(Mode::Instant), TrayItem::ModeInstant),
                (Pill::Mode(Mode::Studio), TrayItem::ModeStudio),
                (Pill::Mode(Mode::Screenshot), TrayItem::ModeScreenshot),
                (Pill::UxWalk, TrayItem::StartWalkthrough),
                (Pill::Diatribe, TrayItem::RecordDiatribe),
            ]
        );
    }

    #[test]
    fn the_walk_pill_is_labelled_and_drawn() {
        assert_eq!(mode_name(Pill::UxWalk), fork_brand::WALK_MODE_NAME);
        assert_eq!(mode_heading(Pill::UxWalk), fork_brand::WALK_MODE_NAME);
        assert!(mode_picker_icon(Pill::UxWalk).is_some());
        assert_eq!(mode_name(Pill::Diatribe), "Record Diatribe");
        assert_eq!(mode_heading(Pill::Diatribe), "Record Diatribe");
        assert!(mode_picker_icon(Pill::Diatribe).is_some());
        for mode in [Mode::Instant, Mode::Studio, Mode::Screenshot] {
            assert_eq!(mode_name(Pill::Mode(mode)), super::super::mode_name(mode));
            assert_eq!(
                mode_heading(Pill::Mode(mode)),
                super::super::mode_heading(mode)
            );
        }
    }

    #[test]
    fn the_walk_pill_records_in_studio_and_is_not_studio() {
        assert_eq!(Mode::from(Pill::UxWalk), Mode::Studio);
        assert!(Pill::UxWalk != Mode::Studio);
        assert!(Pill::Mode(Mode::Studio) == Mode::Studio);
    }

    #[test]
    fn a_selected_walk_selects_the_walk_pill() {
        WALK_PILL_SHOWN.set(true);
        assert_eq!(shown_pill(Mode::Studio), Pill::UxWalk);
        WALK_PILL_SHOWN.set(false);
        assert_eq!(shown_pill(Mode::Studio), Pill::Mode(Mode::Studio));
        assert_eq!(shown_pill(Mode::Instant), Pill::Mode(Mode::Instant));
    }

    #[test]
    fn the_diatribe_pill_starts_a_recording_without_becoming_the_mode() {
        for walk in [false, true] {
            WALK_PILL_SHOWN.set(walk);
            for mode in [Mode::Instant, Mode::Studio, Mode::Screenshot] {
                assert_ne!(shown_pill(mode), Pill::Diatribe);
            }
        }
        WALK_PILL_SHOWN.set(false);
        assert!(Pill::Diatribe != Mode::Instant);
    }

    #[test]
    fn the_menu_offers_record_diatribe_after_the_capture_rows() {
        let mut entries = super::super::build_menu(Mode::Studio, &[], "1.0.0");
        let previous = entries
            .iter()
            .position(|entry| matches!(entry, Entry::Submenu { .. }))
            .unwrap();
        add_menu_items(&mut entries);
        assert!(matches!(
            &entries[previous - 1],
            Entry::Item { title, item: Some(TrayItem::RecordDiatribe), .. } if title == "Record Diatribe"
        ));
        assert!(matches!(entries[previous], Entry::Separator));
        assert_eq!(
            entries
                .iter()
                .filter(|entry| matches!(
                    entry,
                    Entry::Item {
                        item: Some(TrayItem::RecordDiatribe),
                        ..
                    }
                ))
                .count(),
            1
        );
    }
}
