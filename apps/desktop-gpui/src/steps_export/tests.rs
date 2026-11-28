use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::atomic::AtomicBool;
use std::time::Duration;

use cap_project::{
    CaptionTrackSegment, CaptionWord, ClipTransition, ClipTransitionType, MaskSegment,
    ProjectConfiguration, RecordingMeta, TimelineMarker,
};
use cap_steps::{Action, Captions, Point, Size, Source, Step, crop_for};
use cap_verify::fixture::{FixtureSpec, SegmentSpec, Timing, VideoTrackSpec, write_fixture};
use serde_json::json;

use super::{
    GUIDE_DATA_FILE, GUIDE_FILE, STEP_IMAGES_FOLDER, StepsError, caption_words, export_steps,
    project_guide, publish,
};

const FRAME: Size = Size {
    width: 1280,
    height: 720,
};
const LENGTH: f64 = 8.0;
const CAP_BLUE: [u8; 3] = [0x47, 0x85, 0xFF];

struct Project {
    _root: tempfile::TempDir,
    folder: PathBuf,
    meta: RecordingMeta,
    config: ProjectConfiguration,
}

/// A real studio project: an 8 s 1280x720 screen track, and a cursor file
/// with one left click per `(seconds, x, y)`, the pointer arriving 200 ms
/// before each press.
fn project(clicks: &[(f64, f64, f64)]) -> Project {
    project_with(clicks, |_| {})
}

fn project_with(clicks: &[(f64, f64, f64)], patch: impl FnOnce(&mut serde_json::Value)) -> Project {
    let root = tempfile::tempdir().unwrap();
    let bundle = root.path().join("steps.cap");
    let spec = FixtureSpec {
        name: "Invite a teammate".into(),
        segments: vec![SegmentSpec {
            display: VideoTrackSpec::new(
                FRAME.width,
                FRAME.height,
                30,
                Timing::Constant { duration: LENGTH },
            ),
            camera: None,
            mic: None,
            system_audio: None,
        }],
    };
    write_fixture(&spec, &bundle).unwrap();

    let mut moves = Vec::new();
    let mut presses = Vec::new();
    for &(seconds, x, y) in clicks {
        let at = seconds * 1000.0;
        moves.push(json!({
            "active_modifiers": [], "cursor_id": "0", "time_ms": at - 200.0, "x": x, "y": y
        }));
        for (offset, down) in [(0.0, true), (80.0, false)] {
            presses.push(json!({
                "active_modifiers": [], "cursor_num": 1, "cursor_id": "0",
                "time_ms": at + offset, "down": down
            }));
        }
    }
    let cursor = "content/segments/segment-0/cursor.json";
    std::fs::write(
        bundle.join(cursor),
        serde_json::to_vec(&json!({ "clicks": presses, "moves": moves })).unwrap(),
    )
    .unwrap();
    let meta_path = bundle.join("recording-meta.json");
    let mut meta: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&meta_path).unwrap()).unwrap();
    meta["segments"][0]["cursor"] = cursor.into();
    patch(&mut meta);
    std::fs::write(&meta_path, serde_json::to_vec_pretty(&meta).unwrap()).unwrap();

    Project {
        folder: root.path().join("guide"),
        meta: RecordingMeta::load_for_project(&bundle).unwrap(),
        config: ProjectConfiguration::load(&bundle).unwrap(),
        _root: root,
    }
}

fn export(project: &Project) -> Result<Vec<PathBuf>, StepsError> {
    export_steps(
        &project.meta,
        &project.config,
        "Invite a teammate",
        &project.folder,
        &Captions::default(),
        &AtomicBool::new(false),
        &|_, _| {},
    )
}

fn read_png(path: &Path) -> image::RgbaImage {
    image::load_from_memory_with_format(&std::fs::read(path).unwrap(), image::ImageFormat::Png)
        .unwrap()
        .to_rgba8()
}

fn click_step(x: f64, y: f64) -> Step {
    Step {
        time: 0.0,
        source: Source { clip: 0, time: 0.0 },
        frame_time: 0.0,
        action: Action::Click,
        position: Some(Point::new(x, y)),
        drag_to: None,
        repeat: 1,
        heading: None,
        narration: String::new(),
    }
}

fn caption(start: f64, end: f64, text: &str, words: &[(f32, f32, &str)]) -> CaptionTrackSegment {
    CaptionTrackSegment {
        id: format!("caption-{start}"),
        start,
        end,
        text: text.into(),
        words: words
            .iter()
            .map(|&(start, end, text)| CaptionWord {
                text: text.into(),
                start,
                end,
            })
            .collect(),
        fade_duration_override: None,
        linger_duration_override: None,
        position_override: None,
        color_override: None,
        background_color_override: None,
        font_size_override: None,
    }
}

#[test]
fn clicks_come_out_in_seconds_at_their_positions() {
    let project = project(&[(2.0, 0.25, 0.5), (4.0, 0.75, 0.25)]);
    let guide = project_guide(&project.meta, &project.config);

    assert_eq!(guide.steps.len(), 2, "{guide:?}");
    for (step, (time, x, y)) in guide
        .steps
        .iter()
        .zip([(2.0, 0.25, 0.5), (4.0, 0.75, 0.25)])
    {
        assert_eq!(step.action, Action::Click);
        assert!((step.time - time).abs() < 1e-6, "{guide:?}");
        assert_eq!(step.source.clip, 0);
        assert!((step.source.time - time).abs() < 1e-6, "{guide:?}");
        assert_eq!(step.position, Some(Point::new(x, y)));
    }
}

#[test]
fn clicks_in_cut_footage_are_dropped_and_the_rest_shift() {
    let mut project = project(&[(2.0, 0.25, 0.5), (4.0, 0.75, 0.25)]);
    let timeline = project.config.timeline.as_mut().unwrap();
    timeline.segments[0].start = 3.0;
    timeline.segments[0].end = 7.0;
    let guide = project_guide(&project.meta, &project.config);

    assert_eq!(guide.steps.len(), 1, "{guide:?}");
    assert!((guide.steps[0].time - 1.0).abs() < 1e-6, "{guide:?}");
    assert!((guide.steps[0].source.time - 4.0).abs() < 1e-6, "{guide:?}");
    assert_eq!(guide.steps[0].position, Some(Point::new(0.75, 0.25)));

    export(&project).unwrap();
    let duration = guide_data(&project)["duration"].as_f64().unwrap();
    assert!((duration - 4.0).abs() < 1e-6, "{duration}");
}

#[test]
fn a_faster_clip_brings_its_clicks_closer() {
    let mut project = project(&[(4.0, 0.75, 0.25)]);
    project.config.timeline.as_mut().unwrap().segments[0].timescale = 2.0;
    let guide = project_guide(&project.meta, &project.config);

    assert_eq!(guide.steps.len(), 1, "{guide:?}");
    assert!((guide.steps[0].time - 2.0).abs() < 1e-6, "{guide:?}");
    assert!((guide.steps[0].source.time - 4.0).abs() < 1e-6, "{guide:?}");
    assert!((guide.steps[0].frame_time - 3.95).abs() < 1e-6, "{guide:?}");
}

#[test]
fn markers_and_captions_are_read_in_timeline_time() {
    let mut project = project(&[(4.0, 0.5, 0.5)]);
    let mut marker = TimelineMarker::new(0, 3.5);
    marker.label = "Setup".into();
    let mut cut = TimelineMarker::new(0, 1.0);
    cut.label = "Cut away".into();
    project.config.markers = vec![cut, marker];
    let timeline = project.config.timeline.as_mut().unwrap();
    timeline.segments[0].start = 3.0;
    timeline.caption_segments = vec![
        caption(
            0.2,
            0.9,
            "Open the menu.",
            &[(0.2, 0.4, "Open"), (0.4, 0.5, "the"), (0.5, 0.9, "menu.")],
        ),
        caption(2.0, 3.0, "Then save", &[]),
    ];
    project.config.markers.push(TimelineMarker::new(0, 7.0));

    let guide = project_guide(&project.meta, &project.config);
    assert_eq!(guide.steps.len(), 2, "{guide:?}");
    assert_eq!(guide.steps[0].action, Action::Click);
    assert_eq!(guide.steps[0].heading.as_deref(), Some("Setup"));
    assert_eq!(guide.steps[0].narration, "Open the menu.");
    assert_eq!(guide.steps[1].action, Action::Note);
    assert_eq!(guide.steps[1].narration, "Then save");
    assert!((guide.steps[1].time - 4.0).abs() < 1e-6, "{guide:?}");
    assert_eq!(guide.steps[1].source, Source { clip: 0, time: 7.0 });

    let words = caption_words(project.config.timeline.as_ref().unwrap());
    let spoken: Vec<&str> = words.iter().map(|word| word.text.as_str()).collect();
    assert_eq!(spoken, ["Open", "the", "menu.", "Then", "save"]);
    assert!((words[0].start - 0.2).abs() < 1e-4);
    assert!((words[2].end - 0.9).abs() < 1e-4);
    assert!((words[3].start - 2.0).abs() < 1e-4);
    assert!((words[3].end - 2.5).abs() < 1e-4);
    assert!((words[4].end - 3.0).abs() < 1e-4);
}

#[test]
fn export_writes_the_guide_its_data_and_one_image_per_step() {
    let project = project(&[(2.0, 0.25, 0.5), (4.0, 0.75, 0.25), (6.0, 0.5, 0.9)]);
    let files = export(&project).unwrap();

    let images = project.folder.join(STEP_IMAGES_FOLDER);
    assert_eq!(
        files,
        vec![
            project.folder.join(GUIDE_FILE),
            project.folder.join(GUIDE_DATA_FILE),
            images.join("step-01.png"),
            images.join("step-02.png"),
            images.join("step-03.png"),
        ]
    );
    for file in &files {
        assert!(file.is_file(), "{}", file.display());
    }

    let guide = std::fs::read_to_string(project.folder.join(GUIDE_FILE)).unwrap();
    assert!(guide.starts_with("# Invite a teammate\n"), "{guide}");
    for number in 1..=3 {
        assert!(
            guide.contains(&format!("![Step {number}](steps/step-0{number}.png)")),
            "{guide}"
        );
    }
    assert!(guide.contains("### Step 2 · 0:04"), "{guide}");

    let data: serde_json::Value =
        serde_json::from_slice(&std::fs::read(project.folder.join(GUIDE_DATA_FILE)).unwrap())
            .unwrap();
    assert_eq!(data["title"], "Invite a teammate");
    assert_eq!(data["steps"].as_array().unwrap().len(), 3);
    assert_eq!(data["steps"][1]["action"], "click");
    assert_eq!(data["steps"][1]["image"], "steps/step-02.png");

    let crop = crop_for(&click_step(0.25, 0.5), FRAME);
    let image = read_png(&images.join("step-01.png"));
    assert_eq!((image.width(), image.height()), (crop.width, crop.height));
}

#[test]
fn each_click_is_ringed_where_it_happened() {
    let clicks = [(2.0, 0.25, 0.5), (4.0, 0.75, 0.25)];
    let project = project(&clicks);
    export(&project).unwrap();

    for (index, &(_, x, y)) in clicks.iter().enumerate() {
        let image = read_png(
            &project
                .folder
                .join(STEP_IMAGES_FOLDER)
                .join(format!("step-0{}.png", index + 1)),
        );
        let crop = crop_for(&click_step(x, y), FRAME);
        let cx = x * f64::from(FRAME.width) - f64::from(crop.x);
        let cy = y * f64::from(FRAME.height) - f64::from(crop.y);
        let radius = (f64::from(crop.width) * 0.022).max(14.0);
        for turn in 0..8 {
            let angle = f64::from(turn) * std::f64::consts::FRAC_PI_4;
            let pixel = image.get_pixel(
                (cx + radius * angle.cos()).round() as u32,
                (cy + radius * angle.sin()).round() as u32,
            );
            assert!(
                pixel.0[..3]
                    .iter()
                    .zip(CAP_BLUE)
                    .all(|(channel, blue)| (i32::from(*channel) - i32::from(blue)).abs() <= 24),
                "step {} turn {turn}: {pixel:?}",
                index + 1
            );
        }
    }
}

#[test]
fn screenshots_come_from_their_own_moments() {
    let project = project(&[(2.0, 0.5, 0.5), (6.0, 0.5, 0.5)]);
    export(&project).unwrap();
    let images = project.folder.join(STEP_IMAGES_FOLDER);
    assert_ne!(
        read_png(&images.join("step-01.png")).into_raw(),
        read_png(&images.join("step-02.png")).into_raw()
    );
}

#[test]
fn narration_and_headings_reach_the_guide() {
    let mut project = project(&[(4.0, 0.5, 0.5)]);
    let mut marker = TimelineMarker::new(0, 1.0);
    marker.label = "Setup".into();
    project.config.markers = vec![marker];
    project.config.timeline.as_mut().unwrap().caption_segments = vec![caption(
        2.5,
        3.6,
        "Open the team page.",
        &[
            (2.5, 2.8, "Open"),
            (2.8, 2.9, "the"),
            (2.9, 3.2, "team"),
            (3.2, 3.6, "page."),
        ],
    )];
    export(&project).unwrap();

    let guide = std::fs::read_to_string(project.folder.join(GUIDE_FILE)).unwrap();
    assert!(
        guide.contains("## Setup\n\n### Step 1 · 0:04\n\nOpen the team page.\n\n![Step 1]"),
        "{guide}"
    );
}

#[test]
fn a_recording_with_nothing_clicked_or_marked_has_no_steps() {
    let project = project(&[]);
    assert_eq!(export(&project), Err(StepsError::NoSteps));
    assert!(!project.folder.join(GUIDE_FILE).exists());
}

#[test]
fn a_cancelled_export_stops_without_a_guide() {
    let project = project(&[(2.0, 0.25, 0.5), (4.0, 0.75, 0.25)]);
    let result = export_steps(
        &project.meta,
        &project.config,
        "Invite a teammate",
        &project.folder,
        &Captions::default(),
        &AtomicBool::new(true),
        &|_, _| {},
    );
    assert_eq!(result, Err(StepsError::Cancelled));
    assert!(!project.folder.join(GUIDE_FILE).exists());
}

#[test]
fn progress_counts_every_screenshot() {
    let project = project(&[(2.0, 0.25, 0.5), (4.0, 0.75, 0.25), (6.0, 0.5, 0.9)]);
    let seen = Mutex::new(Vec::new());
    export_steps(
        &project.meta,
        &project.config,
        "Invite a teammate",
        &project.folder,
        &Captions::default(),
        &AtomicBool::new(false),
        &|done, total| seen.lock().unwrap().push((done, total)),
    )
    .unwrap();

    let seen = seen.into_inner().unwrap();
    assert_eq!(seen.last(), Some(&(3, 3)), "{seen:?}");
    assert!(seen.iter().all(|&(_, total)| total == 3), "{seen:?}");
    assert!(
        seen.windows(2).all(|pair| pair[0].0 <= pair[1].0),
        "{seen:?}"
    );
}

fn step_image(project: &Project, number: usize) -> Vec<u8> {
    read_png(
        &project
            .folder
            .join(STEP_IMAGES_FOLDER)
            .join(format!("step-0{number}.png")),
    )
    .into_raw()
}

fn guide_data(project: &Project) -> serde_json::Value {
    serde_json::from_slice(&std::fs::read(project.folder.join(GUIDE_DATA_FILE)).unwrap()).unwrap()
}

fn listing(folder: &Path) -> Vec<String> {
    let mut names: Vec<String> = std::fs::read_dir(folder)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    names.sort();
    names
}

fn mask(kind: &str) -> MaskSegment {
    serde_json::from_value(json!({
        "start": 0.0,
        "end": LENGTH,
        "maskType": kind,
        "center": { "x": 0.5, "y": 0.5 },
        "size": { "x": 0.3, "y": 0.3 },
    }))
    .unwrap()
}

/// Cursor events are on the recording's clock; the timeline starts at the
/// latest track start, and the screen file at the screen's own start.
#[test]
fn track_start_offsets_place_clicks_and_their_screenshots() {
    let offset = project_with(&[(3.0, 0.5, 0.5)], |meta| {
        meta["segments"][0]["display"]["start_time"] = 0.2.into();
        meta["segments"][0]["mic"] =
            json!({ "path": "content/segments/segment-0/mic.ogg", "start_time": 0.5 });
    });
    let guide = project_guide(&offset.meta, &offset.config);
    assert!((guide.steps[0].time - 2.5).abs() < 1e-6, "{guide:?}");
    assert!((guide.steps[0].frame_time - 2.45).abs() < 1e-6, "{guide:?}");
    export(&offset).unwrap();

    let plain = project(&[(2.8, 0.5, 0.5)]);
    export(&plain).unwrap();
    assert_eq!(step_image(&offset, 1), step_image(&plain, 1));
}

#[test]
fn a_click_outside_the_recorded_area_is_not_a_step() {
    let project = project(&[(2.0, 1.3, 0.5), (4.0, 0.5, 0.5), (5.5, 0.4, -0.2)]);
    export(&project).unwrap();
    let data = guide_data(&project);
    let steps = data["steps"].as_array().unwrap();
    assert_eq!(steps.len(), 1, "{data}");
    assert!((steps[0]["time"].as_f64().unwrap() - 4.0).abs() < 1e-6);
}

#[test]
fn a_click_after_a_cut_is_ringed_where_the_pointer_was() {
    let mut project = project(&[(3.1, 0.75, 0.25)]);
    project.config.timeline.as_mut().unwrap().segments[0].start = 3.0;
    export(&project).unwrap();
    let data = guide_data(&project);
    let position = &data["steps"][0]["position"];
    assert!(
        (position["x"].as_f64().unwrap() - 0.75).abs() < 1e-6,
        "{data}"
    );
    assert!(
        (position["y"].as_f64().unwrap() - 0.25).abs() < 1e-6,
        "{data}"
    );
}

#[test]
fn a_click_right_after_a_cut_shows_footage_from_after_the_cut() {
    let mut cut = project(&[(5.02, 0.5, 0.5)]);
    let timeline = cut.config.timeline.as_mut().unwrap();
    let mut second = timeline.segments[0].clone();
    timeline.segments[0].end = 2.0;
    second.start = 5.0;
    timeline.segments.push(second);
    export(&cut).unwrap();

    let whole = project(&[(5.06, 0.5, 0.5)]);
    export(&whole).unwrap();
    assert_eq!(step_image(&cut, 1), step_image(&whole, 1));
}

#[test]
fn the_stop_click_is_judged_by_the_recording_not_the_trimmed_timeline() {
    let mut trimmed = project(&[(4.5, 0.5, 0.5)]);
    trimmed.config.timeline.as_mut().unwrap().segments[0].end = 5.0;
    export(&trimmed).unwrap();
    assert_eq!(guide_data(&trimmed)["steps"].as_array().unwrap().len(), 1);

    let stopped = project(&[(7.5, 0.5, 0.5)]);
    assert_eq!(export(&stopped), Err(StepsError::NoSteps));
}

#[test]
fn a_cancelled_re_export_leaves_the_earlier_guide_as_it_was() {
    let project = project(&[(2.0, 0.25, 0.5), (4.0, 0.75, 0.25), (6.0, 0.5, 0.9)]);
    let files = export(&project).unwrap();
    let before: Vec<Vec<u8>> = files
        .iter()
        .map(|file| std::fs::read(file).unwrap())
        .collect();
    let beside = listing(project.folder.parent().unwrap());
    let inside = listing(&project.folder.join(STEP_IMAGES_FOLDER));

    let cancel = AtomicBool::new(false);
    let result = export_steps(
        &project.meta,
        &project.config,
        "A different title",
        &project.folder,
        &Captions::default(),
        &cancel,
        &|done, _| {
            if done == 1 {
                cancel.store(true, std::sync::atomic::Ordering::Relaxed);
            }
        },
    );
    assert_eq!(result, Err(StepsError::Cancelled));
    for (file, bytes) in files.iter().zip(&before) {
        assert_eq!(&std::fs::read(file).unwrap(), bytes, "{}", file.display());
    }
    assert_eq!(listing(project.folder.parent().unwrap()), beside);
    assert_eq!(listing(&project.folder.join(STEP_IMAGES_FOLDER)), inside);
}

#[test]
fn cancelling_during_the_last_screenshot_still_cancels() {
    let project = project(&[(2.0, 0.25, 0.5), (4.0, 0.75, 0.25)]);
    let cancel = AtomicBool::new(false);
    let result = export_steps(
        &project.meta,
        &project.config,
        "Invite a teammate",
        &project.folder,
        &Captions::default(),
        &cancel,
        &|done, total| {
            if done == total {
                cancel.store(true, std::sync::atomic::Ordering::Relaxed);
            }
        },
    );
    assert_eq!(result, Err(StepsError::Cancelled));
    assert!(!project.folder.join(GUIDE_FILE).exists());
}

#[test]
fn a_click_under_a_crossfade_shows_the_clip_it_was_made_in() {
    let mut faded = project(&[(3.5, 0.5, 0.5)]);
    let timeline = faded.config.timeline.as_mut().unwrap();
    let mut second = timeline.segments[0].clone();
    timeline.segments[0].end = 4.0;
    second.start = 4.0;
    timeline.segments.push(second);
    timeline.transitions = vec![ClipTransition {
        segment_index: 1,
        kind: ClipTransitionType::CrossFade,
        duration: 1.0,
    }];
    export(&faded).unwrap();
    assert!((guide_data(&faded)["steps"][0]["time"].as_f64().unwrap() - 3.5).abs() < 1e-6);

    let plain = project(&[(3.5, 0.5, 0.5)]);
    export(&plain).unwrap();
    assert_eq!(step_image(&faded, 1), step_image(&plain, 1));
}

#[test]
fn a_slowed_clip_keeps_its_double_click() {
    let mut slowed = project(&[(2.0, 0.5, 0.5), (2.3, 0.5, 0.5)]);
    slowed.config.timeline.as_mut().unwrap().segments[0].timescale = 0.5;
    export(&slowed).unwrap();
    let data = guide_data(&slowed);
    let steps = data["steps"].as_array().unwrap();
    assert_eq!(steps.len(), 1, "{data}");
    assert_eq!(steps[0]["action"], "doubleClick", "{data}");
    assert!(
        (steps[0]["time"].as_f64().unwrap() - 4.0).abs() < 1e-6,
        "{data}"
    );
}

#[test]
fn a_sped_up_clip_keeps_its_clicks_apart() {
    let mut fast = project(&[(2.0, 0.5, 0.5), (2.8, 0.5, 0.5)]);
    fast.config.timeline.as_mut().unwrap().segments[0].timescale = 2.0;
    export(&fast).unwrap();
    let data = guide_data(&fast);
    let steps = data["steps"].as_array().unwrap();
    assert_eq!(steps.len(), 1, "{data}");
    assert_eq!(steps[0]["action"], "click", "{data}");
    assert_eq!(steps[0]["repeat"], 2, "{data}");
    assert!(
        (steps[0]["time"].as_f64().unwrap() - 1.0).abs() < 1e-6,
        "{data}"
    );
}

#[test]
fn a_shorter_re_export_leaves_no_screenshots_from_the_longer_one() {
    let longer = project(&[(2.0, 0.25, 0.5), (4.0, 0.75, 0.25), (6.0, 0.5, 0.9)]);
    export(&longer).unwrap();
    let kept = longer.folder.join("notes.txt");
    std::fs::write(&kept, "mine").unwrap();

    let mut shorter = project(&[(2.0, 0.25, 0.5)]);
    shorter.folder = longer.folder.clone();
    export(&shorter).unwrap();

    assert_eq!(
        listing(&longer.folder.join(STEP_IMAGES_FOLDER)),
        ["step-01.png"]
    );
    assert_eq!(guide_data(&shorter)["steps"].as_array().unwrap().len(), 1);
    assert_eq!(std::fs::read_to_string(&kept).unwrap(), "mine");
    assert_eq!(
        listing(longer.folder.parent().unwrap()),
        ["guide", "steps.cap"]
    );
}

#[test]
fn a_re_export_leaves_other_files_in_the_screenshots_folder_alone() {
    let longer = project(&[(2.0, 0.25, 0.5), (4.0, 0.75, 0.25), (6.0, 0.5, 0.9)]);
    export(&longer).unwrap();
    let images = longer.folder.join(STEP_IMAGES_FOLDER);
    let mine = [
        images.join("diagram.png"),
        images.join("step-09.png"),
        images.join("raw").join("step-02.png"),
    ];
    std::fs::create_dir(images.join("raw")).unwrap();
    for file in &mine {
        std::fs::write(file, "mine").unwrap();
    }
    let replaced = step_image(&longer, 1);

    let mut shorter = project(&[(5.0, 0.6, 0.6)]);
    shorter.folder = longer.folder.clone();
    export(&shorter).unwrap();

    assert_eq!(
        listing(&images),
        ["diagram.png", "raw", "step-01.png", "step-09.png"]
    );
    for file in &mine {
        assert_eq!(
            std::fs::read_to_string(file).unwrap(),
            "mine",
            "{}",
            file.display()
        );
    }
    assert_ne!(step_image(&shorter, 1), replaced);
    assert_eq!(
        listing(longer.folder.parent().unwrap()),
        ["guide", "steps.cap"]
    );
}

#[test]
fn an_earlier_guide_that_lists_files_elsewhere_has_none_of_them_removed() {
    let project = project(&[(2.0, 0.25, 0.5)]);
    export(&project).unwrap();
    let beside = project.folder.parent().unwrap();
    let images = project.folder.join(STEP_IMAGES_FOLDER);
    let mine = [
        beside.join("step-08.png"),
        project.folder.join("step-07.png"),
        images.join("diagram.png"),
        images.join("raw").join("step-02.png"),
    ];
    std::fs::create_dir(images.join("raw")).unwrap();
    for file in &mine {
        std::fs::write(file, "mine").unwrap();
    }
    let mut data = guide_data(&project);
    data["steps"] = json!([
        { "image": "../step-08.png" },
        { "image": "steps/../../step-08.png" },
        { "image": mine[0].to_string_lossy() },
        { "image": "step-07.png" },
        { "image": "steps/../step-07.png" },
        { "image": "steps/diagram.png" },
        { "image": "steps/raw/step-02.png" },
    ]);
    std::fs::write(
        project.folder.join(GUIDE_DATA_FILE),
        serde_json::to_vec(&data).unwrap(),
    )
    .unwrap();

    export(&project).unwrap();

    for file in &mine {
        assert_eq!(
            std::fs::read_to_string(file).unwrap(),
            "mine",
            "{}",
            file.display()
        );
    }
    assert_eq!(guide_data(&project)["steps"].as_array().unwrap().len(), 1);
}

#[test]
fn a_folder_where_a_guide_file_would_go_is_not_replaced() {
    let project = project(&[(2.0, 0.25, 0.5)]);
    let taken = project.folder.join(GUIDE_FILE);
    std::fs::create_dir_all(&taken).unwrap();
    std::fs::write(taken.join("notes.txt"), "mine").unwrap();

    assert!(matches!(export(&project), Err(StepsError::Failed(_))));

    assert_eq!(listing(&project.folder), [GUIDE_FILE]);
    assert_eq!(
        std::fs::read_to_string(taken.join("notes.txt")).unwrap(),
        "mine"
    );
    assert_eq!(
        listing(project.folder.parent().unwrap()),
        ["guide", "steps.cap"]
    );
}

#[test]
fn a_failed_first_export_into_a_folder_leaves_it_as_it_was() {
    let root = tempfile::tempdir().unwrap();
    let folder = root.path().join("guide");
    std::fs::create_dir(&folder).unwrap();
    std::fs::write(folder.join("notes.txt"), "mine").unwrap();

    let staging = root.path().join(".guide.staging");
    let written = format!("{STEP_IMAGES_FOLDER}/step-01.png");
    std::fs::create_dir_all(staging.join(STEP_IMAGES_FOLDER)).unwrap();
    for name in [GUIDE_FILE, GUIDE_DATA_FILE, written.as_str()] {
        std::fs::write(staging.join(name), "new").unwrap();
    }
    let names = [
        GUIDE_FILE.to_string(),
        GUIDE_DATA_FILE.to_string(),
        written,
        format!("{STEP_IMAGES_FOLDER}/step-02.png"),
    ];
    assert!(publish(&staging, &folder, &names).is_err());

    assert_eq!(listing(&folder), ["notes.txt"]);
    assert_eq!(listing(root.path()), [".guide.staging", "guide"]);
}

#[test]
fn a_replacement_that_fails_part_way_puts_the_earlier_guide_back() {
    let project = project(&[(2.0, 0.25, 0.5), (4.0, 0.75, 0.25)]);
    let files = export(&project).unwrap();
    let before: Vec<Vec<u8>> = files
        .iter()
        .map(|file| std::fs::read(file).unwrap())
        .collect();
    let mine = project.folder.join(STEP_IMAGES_FOLDER).join("diagram.png");
    std::fs::write(&mine, "mine").unwrap();

    let staging = project.folder.with_file_name(".guide.staging");
    std::fs::create_dir(&staging).unwrap();
    std::fs::write(staging.join(GUIDE_FILE), "new").unwrap();
    std::fs::write(staging.join(GUIDE_DATA_FILE), "new").unwrap();
    let names = [
        GUIDE_FILE.to_string(),
        GUIDE_DATA_FILE.to_string(),
        format!("{STEP_IMAGES_FOLDER}/step-01.png"),
    ];
    assert!(publish(&staging, &project.folder, &names).is_err());

    for (file, bytes) in files.iter().zip(&before) {
        assert_eq!(&std::fs::read(file).unwrap(), bytes, "{}", file.display());
    }
    assert_eq!(std::fs::read_to_string(&mine).unwrap(), "mine");
    assert_eq!(
        listing(&project.folder),
        [GUIDE_DATA_FILE, GUIDE_FILE, STEP_IMAGES_FOLDER]
    );
    assert_eq!(
        listing(&project.folder.join(STEP_IMAGES_FOLDER)),
        ["diagram.png", "step-01.png", "step-02.png"]
    );
    assert_eq!(
        listing(project.folder.parent().unwrap()),
        [".guide.staging", "guide", "steps.cap"]
    );
}

const FRAGMENTS: &str = "content/segments/segment-0/display";

/// A screen track left as a folder of `init.mp4` and `.m4s` fragments, which
/// the editor opens as it is, and the same footage converted to one file.
/// Neighbouring frames differ, so a screenshot one frame off does not match.
fn fragmented_and_converted(clicks: &[(f64, f64, f64)]) -> (Project, Project) {
    use cap_enc_ffmpeg::segmented_stream::{SegmentedVideoEncoder, SegmentedVideoEncoderConfig};

    let fragmented = project_with(clicks, |meta| {
        meta["segments"][0]["display"]["path"] = FRAGMENTS.into();
    });
    let folder = fragmented.meta.project_path.join(FRAGMENTS);
    ffmpeg::init().unwrap();
    let mut encoder = SegmentedVideoEncoder::init(
        folder.clone(),
        cap_media_info::VideoInfo {
            pixel_format: cap_media_info::Pixel::NV12,
            width: FRAME.width,
            height: FRAME.height,
            time_base: ffmpeg::Rational(1, 1_000_000),
            frame_rate: ffmpeg::Rational(30, 1),
        },
        SegmentedVideoEncoderConfig {
            segment_duration: Duration::from_secs(1),
            ..Default::default()
        },
    )
    .unwrap();
    for index in 0..(LENGTH * 30.0) as u64 {
        let mut frame =
            ffmpeg::frame::Video::new(ffmpeg::format::Pixel::NV12, FRAME.width, FRAME.height);
        frame.data_mut(0).fill(16 + (index * 7 % 200) as u8);
        frame.data_mut(1).fill(128);
        encoder
            .queue_frame(frame, Duration::from_micros(index * 1_000_000 / 30))
            .unwrap();
    }
    encoder.finish().unwrap();

    let mut fragments: Vec<PathBuf> = std::fs::read_dir(&folder)
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .filter(|path| path.extension().is_some_and(|extension| extension == "m4s"))
        .collect();
    cap_enc_ffmpeg::fragment_order::sort_fragment_paths(&mut fragments);
    assert!(fragments.len() >= 4, "{fragments:?}");
    let converted = project(clicks);
    cap_enc_ffmpeg::remux::concatenate_m4s_segments_with_init(
        &folder.join("init.mp4"),
        &fragments,
        &converted
            .meta
            .project_path
            .join(FRAGMENTS)
            .with_extension("mp4"),
    )
    .unwrap();
    (fragmented, converted)
}

#[test]
fn a_recording_left_as_fragments_exports_the_screenshots_of_its_one_file_form() {
    let clicks = [(1.5, 0.5, 0.5), (4.2, 0.5, 0.5), (6.8, 0.5, 0.5)];
    let (fragmented, converted) = fragmented_and_converted(&clicks);
    export(&fragmented).unwrap();
    export(&converted).unwrap();

    for number in 1..=clicks.len() {
        assert_eq!(
            step_image(&fragmented, number),
            step_image(&converted, number),
            "step {number}"
        );
    }
    assert_ne!(step_image(&fragmented, 1), step_image(&fragmented, 2));
    assert_ne!(step_image(&fragmented, 2), step_image(&fragmented, 3));
}

#[test]
fn a_recording_left_as_fragments_that_was_never_edited_keeps_its_length() {
    let clicks = [(1.5, 0.5, 0.5), (4.2, 0.5, 0.5), (7.9, 0.5, 0.5)];
    let (mut fragmented, mut converted) = fragmented_and_converted(&clicks);
    fragmented.config.timeline = None;
    converted.config.timeline = None;
    export(&fragmented).unwrap();
    export(&converted).unwrap();

    let data = guide_data(&fragmented);
    assert_eq!(data["steps"], guide_data(&converted)["steps"]);
    assert_eq!(data["steps"].as_array().unwrap().len(), 2, "{data}");
    assert!(
        (data["duration"].as_f64().unwrap() - LENGTH).abs() < 0.05,
        "{data}"
    );
}

#[test]
fn a_recording_with_a_hidden_area_is_not_exported() {
    let mut hidden = project(&[(2.0, 0.5, 0.5)]);
    hidden.config.timeline.as_mut().unwrap().mask_segments = vec![mask("sensitive")];
    assert_eq!(export(&hidden), Err(StepsError::HiddenAreas));
    assert!(!hidden.folder.exists());
    assert_eq!(listing(hidden.folder.parent().unwrap()), ["steps.cap"]);
}

#[test]
fn masks_that_hide_nothing_do_not_stop_an_export() {
    let mut shown = project(&[(2.0, 0.5, 0.5)]);
    let mut switched_off = mask("sensitive");
    switched_off.enabled = false;
    shown.config.timeline.as_mut().unwrap().mask_segments = vec![switched_off, mask("highlight")];
    export(&shown).unwrap();
}
