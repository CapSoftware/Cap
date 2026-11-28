use cap_steps::{Action, Captions, Guide, Point, Source, Step};

use super::{
    ExportDestination, ExportFormatKind, ExportUi, normalize_export_options, step_rows,
    steps_captions, steps_failure, steps_folder_name,
};
use crate::steps_export::StepsError;
use crate::store::ExportPrefs;

fn prefs(format: &str, export_to: &str) -> ExportPrefs {
    ExportPrefs {
        format: format.into(),
        fps: 30,
        export_to: export_to.into(),
        resolution: "720p".into(),
        compression: "Maximum".into(),
        optimize_filesize: false,
        cursor_only: true,
        custom_bpp: None,
        force_ffmpeg_decoder: false,
        advanced_open: false,
        organization_id: None,
        turbo: false,
        gif_quality: None,
        excluded_tracks: None,
        resolution_from_source: false,
        fps_from_source: false,
        audio_format: None,
        enhance_quality: false,
        link_compression: None,
        link_custom_bpp: None,
    }
}

fn step(time: f64, action: Action, narration: &str, heading: Option<&str>, repeat: u32) -> Step {
    Step {
        time,
        source: Source { clip: 0, time },
        frame_time: time,
        action,
        position: (action != Action::Note).then(|| Point::new(0.5, 0.5)),
        drag_to: (action == Action::Drag).then(|| Point::new(0.7, 0.7)),
        repeat,
        heading: heading.map(str::to_string),
        narration: narration.to_string(),
    }
}

#[test]
fn steps_is_offered_for_recordings_with_a_screen() {
    assert!(ExportFormatKind::options(false, false).contains(&ExportFormatKind::Steps));
    assert!(!ExportFormatKind::options(true, false).contains(&ExportFormatKind::Steps));
    assert!(!ExportFormatKind::options(true, true).contains(&ExportFormatKind::Steps));
    assert!(!ExportFormatKind::Steps.writes_video());
    assert_eq!(
        ExportFormatKind::from_slug(ExportFormatKind::Steps.slug()),
        ExportFormatKind::Steps
    );
    assert_eq!(ExportFormatKind::Steps.label(), "Steps");
}

#[test]
fn steps_are_saved_to_a_folder_whatever_was_chosen_before() {
    for destination in ["link", "clipboard", "file"] {
        let mut ui = ExportUi::from_preferences(prefs("Steps", destination));
        assert_eq!(ui.format, ExportFormatKind::Steps);
        normalize_export_options(&mut ui, false);
        assert_eq!(ui.destination, ExportDestination::File, "{destination}");
        assert!(!ui.cursor_only, "{destination}");
    }
}

#[test]
fn the_automation_hook_switches_to_steps() {
    let mut ui = ExportUi::from_preferences(prefs("Mp4", "link"));
    ui.use_steps();
    assert_eq!(ui.format, ExportFormatKind::Steps);
    assert_eq!(ui.destination, ExportDestination::File);
    assert!(!ui.cursor_only);
}

#[test]
fn the_steps_folder_is_named_after_the_recording() {
    assert_eq!(steps_folder_name("Sprint 1/2"), "Sprint 12 Steps");
    assert_eq!(steps_folder_name("   "), "Cap Recording Steps");
    let long = steps_folder_name(&"a".repeat(300));
    assert!(long.len() <= 255, "{}", long.len());
    assert!(long.ends_with(" Steps"), "{long}");
    assert!(long.starts_with("aaaa"), "{long}");
}

#[test]
fn the_guide_is_written_in_the_apps_own_words() {
    assert_eq!(steps_captions(), Captions::default());
}

#[test]
fn the_stage_lists_each_step_by_what_the_reader_does() {
    let guide = Guide {
        intro: String::new(),
        steps: vec![
            step(4.2, Action::Click, "Open the team page.", None, 1),
            step(9.0, Action::Click, "", Some("Invite"), 3),
            step(75.0, Action::Note, "", None, 1),
            step(80.0, Action::Drag, "", None, 1),
        ],
    };
    let rows = step_rows(&guide, &Captions::default());
    assert_eq!(rows.len(), 4);
    assert_eq!(rows[0].number, 1);
    assert_eq!(rows[0].time, "0:04");
    assert_eq!(rows[0].text, "Open the team page.");
    assert_eq!(rows[0].heading, None);
    assert_eq!(rows[1].number, 2);
    assert_eq!(rows[1].text, "Click the highlighted spot 3 times.");
    assert_eq!(rows[1].heading.as_deref(), Some("Invite"));
    assert_eq!(rows[2].time, "1:15");
    assert_eq!(rows[2].text, "");
    assert_eq!(rows[3].number, 4);
    assert_eq!(rows[3].text, "Drag along the arrow.");
}

#[test]
fn a_recording_without_steps_says_how_to_get_some() {
    let message = steps_failure(&StepsError::NoSteps);
    assert!(message.contains("click"), "{message}");
    assert!(message.contains("marker"), "{message}");
    assert_eq!(
        steps_failure(&StepsError::Failed("disk full".into())),
        "disk full"
    );
    let hidden = steps_failure(&StepsError::HiddenAreas);
    assert!(hidden.contains("Sensitive mask"), "{hidden}");
}
