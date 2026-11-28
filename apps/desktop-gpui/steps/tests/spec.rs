use std::path::Path;

use cap_steps::{
    Action, ButtonEvent, Captions, ClipEvents, Document, DocumentStep, Guide, LEFT_BUTTON, Marker,
    Point, PointerMove, Rect, Size, Source, Step, Word, build_guide, clip_steps, crop_for,
    encode_png, image_name, is_image_name, json, listed_images, markdown, render_step_image,
    timestamp,
};
use serde::Deserialize;

const TIME_TOLERANCE: f64 = 0.15;
const POSITION_TOLERANCE: f64 = 0.01;
const CAP_BLUE: [u8; 3] = [0x47, 0x85, 0xFF];

#[derive(Deserialize)]
struct Scenario {
    #[allow(dead_code)]
    about: String,
    duration: f64,
    #[serde(default = "normal_speed")]
    speed: f64,
    #[serde(default)]
    moves: Vec<(f64, f64, f64)>,
    #[serde(default)]
    buttons: Vec<(f64, u8, bool)>,
    #[serde(default)]
    markers: Vec<(f64, String)>,
    #[serde(default)]
    words: Vec<(f64, f64, String)>,
    expect: Expect,
}

#[derive(Deserialize)]
struct Expect {
    #[serde(default)]
    intro: Vec<String>,
    steps: Vec<ExpectStep>,
}

#[derive(Deserialize)]
struct ExpectStep {
    action: Action,
    time: f64,
    #[serde(default)]
    at: Option<(f64, f64)>,
    #[serde(default)]
    to: Option<(f64, f64)>,
    #[serde(default = "once")]
    repeat: u32,
    #[serde(default)]
    heading: Option<String>,
    #[serde(default)]
    says: Vec<String>,
    #[serde(default)]
    not_says: Vec<String>,
    #[serde(default)]
    silent: bool,
}

fn once() -> u32 {
    1
}

fn normal_speed() -> f64 {
    1.0
}

#[derive(Default)]
struct Recording {
    duration: f64,
    speed: f64,
    moves: Vec<PointerMove>,
    buttons: Vec<ButtonEvent>,
    markers: Vec<(f64, String)>,
    words: Vec<Word>,
}

fn guide_of(recording: &Recording) -> Guide {
    let events = ClipEvents {
        clip: 0,
        stopped_at: Some(recording.duration).filter(|duration| *duration > 0.0),
        moves: &recording.moves,
        buttons: &recording.buttons,
    };
    let markers: Vec<Marker> = recording
        .markers
        .iter()
        .map(|(time, label)| Marker {
            time: *time,
            source: Source {
                clip: 0,
                time: time * recording.speed,
            },
            label: label.clone(),
        })
        .collect();
    build_guide(
        clip_steps(&events, |time| Some(time / recording.speed)),
        &markers,
        &recording.words,
    )
}

impl Scenario {
    fn recording(&self) -> Recording {
        Recording {
            duration: self.duration,
            speed: self.speed,
            moves: self
                .moves
                .iter()
                .map(|&(time, x, y)| PointerMove {
                    time,
                    position: Point::new(x, y),
                })
                .collect(),
            buttons: self
                .buttons
                .iter()
                .map(|&(time, button, down)| ButtonEvent { time, button, down })
                .collect(),
            markers: self.markers.clone(),
            words: self
                .words
                .iter()
                .map(|(start, end, text)| Word {
                    start: *start,
                    end: *end,
                    text: text.clone(),
                })
                .collect(),
        }
    }
}

fn describe(guide: &Guide) -> String {
    let mut out = format!("intro: {:?}\n", guide.intro);
    for (index, step) in guide.steps.iter().enumerate() {
        out.push_str(&format!(
            "  {}. {:?} t={:.2} at={:?} to={:?} x{} heading={:?} says={:?}\n",
            index + 1,
            step.action,
            step.time,
            step.position,
            step.drag_to,
            step.repeat,
            step.heading,
            step.narration
        ));
    }
    out
}

fn near(point: Option<Point>, expected: Option<(f64, f64)>) -> bool {
    match (point, expected) {
        (None, None) => true,
        (Some(point), Some((x, y))) => {
            (point.x - x).abs() <= POSITION_TOLERANCE && (point.y - y).abs() <= POSITION_TOLERANCE
        }
        _ => false,
    }
}

fn says(narration: &str, fragment: &str) -> bool {
    narration.to_lowercase().contains(&fragment.to_lowercase())
}

fn judge(text: &str) -> Result<(), String> {
    let scenario: Scenario = serde_json::from_str(text).map_err(|error| error.to_string())?;
    let guide = guide_of(&scenario.recording());
    let mut problems = Vec::new();
    for fragment in &scenario.expect.intro {
        if !says(&guide.intro, fragment) {
            problems.push(format!("the intro should say {fragment:?}"));
        }
    }
    if scenario.expect.intro.is_empty() && !guide.intro.is_empty() {
        problems.push("the intro should be empty".to_string());
    }
    if guide.steps.len() != scenario.expect.steps.len() {
        problems.push(format!(
            "expected {} steps, got {}",
            scenario.expect.steps.len(),
            guide.steps.len()
        ));
    }
    for (index, (step, expected)) in guide.steps.iter().zip(&scenario.expect.steps).enumerate() {
        let number = index + 1;
        if step.action != expected.action {
            problems.push(format!(
                "step {number} should be {:?}, got {:?}",
                expected.action, step.action
            ));
        }
        if (step.time - expected.time).abs() > TIME_TOLERANCE {
            problems.push(format!(
                "step {number} should be at {:.2}s, got {:.2}s",
                expected.time, step.time
            ));
        }
        if !near(step.position, expected.at) {
            problems.push(format!(
                "step {number} should be at {:?}, got {:?}",
                expected.at, step.position
            ));
        }
        if !near(step.drag_to, expected.to) {
            problems.push(format!(
                "step {number} should drag to {:?}, got {:?}",
                expected.to, step.drag_to
            ));
        }
        if step.repeat != expected.repeat {
            problems.push(format!(
                "step {number} should repeat {} times, got {}",
                expected.repeat, step.repeat
            ));
        }
        if step.heading != expected.heading {
            problems.push(format!(
                "step {number} should be headed {:?}, got {:?}",
                expected.heading, step.heading
            ));
        }
        for fragment in &expected.says {
            if !says(&step.narration, fragment) {
                problems.push(format!("step {number} should say {fragment:?}"));
            }
        }
        for fragment in &expected.not_says {
            if says(&step.narration, fragment) {
                problems.push(format!("step {number} should not say {fragment:?}"));
            }
        }
        if expected.silent && !step.narration.is_empty() {
            problems.push(format!("step {number} should have no narration"));
        }
    }
    if problems.is_empty() {
        Ok(())
    } else {
        Err(format!("{}\n{}", problems.join("\n"), describe(&guide)))
    }
}

macro_rules! scenarios {
    ($($name:ident),* $(,)?) => {
        $(
            #[test]
            fn $name() {
                let text = include_str!(concat!("scenarios/", stringify!($name), ".json"));
                if let Err(problems) = judge(text) {
                    panic!("{problems}");
                }
            }
        )*
    };
}

scenarios!(
    single_click,
    double_click,
    repeated_clicks,
    drag,
    right_click,
    stop_click_dropped,
    narration_announce_then_act,
    narration_prefers_the_coming_step,
    narration_pause_splits_sentences,
    intro_before_first_step,
    marker_headings,
    marker_without_clicks_is_a_note,
    unlabeled_marker_note,
    press_without_release,
    click_position_uses_latest_move,
    no_events,
    two_spots_fast,
    long_press_is_a_click,
    double_click_in_slow_motion,
    separate_clicks_sped_up,
    narration_fullwidth_sentence_ends,
);

/// Scores a folder of scenario files of your own: set
/// `CAP_STEPS_EXTRA_SCENARIOS` to it. Without the variable this does nothing.
#[test]
fn extra_scenarios() {
    let Some(folder) = std::env::var_os("CAP_STEPS_EXTRA_SCENARIOS") else {
        return;
    };
    let mut files: Vec<_> = std::fs::read_dir(Path::new(&folder))
        .expect("the scenario folder should be readable")
        .filter_map(|entry| entry.ok().map(|entry| entry.path()))
        .filter(|path| {
            path.extension()
                .is_some_and(|extension| extension == "json")
        })
        .collect();
    files.sort();
    let mut failures = 0;
    for file in &files {
        let text = std::fs::read_to_string(file).expect("the scenario should be readable");
        if let Err(problems) = judge(&text) {
            failures += 1;
            println!("FAIL {}\n{problems}", file.display());
        } else {
            println!("ok   {}", file.display());
        }
    }
    println!("EXTRA_SCENARIO_TOTAL={}", files.len());
    println!("EXTRA_SCENARIO_FAILURES={failures}");
    assert_eq!(failures, 0, "{failures} of {} scenarios fail", files.len());
}

fn click_at(time: f64, x: f64, y: f64) -> Recording {
    Recording {
        duration: time + 10.0,
        speed: 1.0,
        moves: vec![PointerMove {
            time: 0.0,
            position: Point::new(x, y),
        }],
        buttons: vec![
            ButtonEvent {
                time,
                button: LEFT_BUTTON,
                down: true,
            },
            ButtonEvent {
                time: time + 0.08,
                button: LEFT_BUTTON,
                down: false,
            },
        ],
        ..Recording::default()
    }
}

#[test]
fn the_frame_is_taken_just_before_the_press() {
    let guide = guide_of(&click_at(4.0, 0.5, 0.5));
    assert_eq!(guide.steps.len(), 1);
    assert!((guide.steps[0].frame_time - 3.95).abs() < 1e-9);

    let guide = guide_of(&click_at(0.02, 0.5, 0.5));
    assert_eq!(guide.steps.len(), 1);
    assert_eq!(guide.steps[0].frame_time, 0.0);
}

#[test]
fn a_step_keeps_the_clip_and_moment_it_was_recorded_at() {
    let mut recording = click_at(4.0, 0.5, 0.5);
    recording.speed = 2.0;
    let guide = guide_of(&recording);
    assert_eq!(guide.steps.len(), 1);
    assert_eq!(guide.steps[0].time, 2.0);
    assert_eq!(guide.steps[0].source, Source { clip: 0, time: 4.0 });
    assert!((guide.steps[0].frame_time - 3.95).abs() < 1e-9);
}

#[test]
fn clicks_cut_from_the_timeline_are_left_out_before_actions_are_read() {
    let mut recording = click_at(4.0, 0.5, 0.5);
    for (time, down) in [(4.3, true), (4.38, false)] {
        recording.buttons.push(ButtonEvent {
            time,
            button: LEFT_BUTTON,
            down,
        });
    }
    let events = ClipEvents {
        clip: 3,
        stopped_at: None,
        moves: &recording.moves,
        buttons: &recording.buttons,
    };
    let steps = clip_steps(&events, |time| (time >= 4.2).then_some(time - 4.2));
    assert_eq!(steps.len(), 1);
    assert_eq!(steps[0].action, Action::Click);
    assert!((steps[0].time - 0.1).abs() < 1e-9);
    assert_eq!(steps[0].source.clip, 3);
    assert!((steps[0].source.time - 4.3).abs() < 1e-9);
}

#[test]
fn steps_from_several_clips_are_put_in_output_order() {
    let later = click_at(1.0, 0.2, 0.2);
    let earlier = click_at(5.0, 0.8, 0.8);
    let clip = |clip, recording: &Recording, starts: f64| {
        clip_steps(
            &ClipEvents {
                clip,
                stopped_at: None,
                moves: &recording.moves,
                buttons: &recording.buttons,
            },
            |time| Some(starts + time),
        )
    };
    let mut steps = clip(0, &later, 20.0);
    steps.extend(clip(1, &earlier, 0.0));
    let guide = build_guide(steps, &[], &[]);
    let order: Vec<u32> = guide.steps.iter().map(|step| step.source.clip).collect();
    assert_eq!(order, [1, 0]);
}

#[test]
fn a_note_is_framed_at_its_marker() {
    let guide = guide_of(&Recording {
        duration: 20.0,
        speed: 2.0,
        markers: vec![(6.5, "Overview".into())],
        ..Recording::default()
    });
    assert_eq!(guide.steps.len(), 1);
    assert_eq!(guide.steps[0].action, Action::Note);
    assert_eq!(guide.steps[0].time, 6.5);
    assert_eq!(guide.steps[0].frame_time, 13.0);
}

#[test]
fn events_out_of_order_still_give_steps_in_time_order() {
    let mut recording = click_at(8.0, 0.2, 0.2);
    recording.duration = 30.0;
    recording.moves.push(PointerMove {
        time: 2.5,
        position: Point::new(0.7, 0.7),
    });
    recording.moves.push(PointerMove {
        time: 5.0,
        position: Point::new(0.2, 0.2),
    });
    recording.buttons.push(ButtonEvent {
        time: 3.1,
        button: LEFT_BUTTON,
        down: false,
    });
    recording.buttons.push(ButtonEvent {
        time: 3.0,
        button: LEFT_BUTTON,
        down: true,
    });
    let guide = guide_of(&recording);
    assert_eq!(guide.steps.len(), 2);
    assert!((guide.steps[0].time - 3.0).abs() < 1e-9);
    assert!((guide.steps[1].time - 8.0).abs() < 1e-9);
    assert!(near(guide.steps[0].position, Some((0.7, 0.7))));
    assert!(near(guide.steps[1].position, Some((0.2, 0.2))));
}

#[test]
fn broken_numbers_are_ignored_not_fatal() {
    let mut recording = click_at(4.0, 0.5, 0.5);
    recording.moves.push(PointerMove {
        time: f64::NAN,
        position: Point::new(0.1, 0.1),
    });
    recording.moves.push(PointerMove {
        time: 3.0,
        position: Point::new(f64::INFINITY, 0.1),
    });
    recording.buttons.push(ButtonEvent {
        time: f64::NAN,
        button: LEFT_BUTTON,
        down: true,
    });
    recording.words.push(Word {
        start: f64::NAN,
        end: 1.0,
        text: "lost".into(),
    });
    let guide = guide_of(&recording);
    assert_eq!(guide.steps.len(), 1);
    assert!(near(guide.steps[0].position, Some((0.5, 0.5))));
    assert!(!says(&guide.steps[0].narration, "lost"));
    assert!(!says(&guide.intro, "lost"));
}

#[test]
fn positions_outside_the_frame_are_pulled_onto_it() {
    let guide = guide_of(&click_at(4.0, 1.2, -0.1));
    assert_eq!(guide.steps.len(), 1);
    assert!(near(guide.steps[0].position, Some((1.0, 0.0))));
}

fn step(action: Action, position: Option<(f64, f64)>, drag_to: Option<(f64, f64)>) -> Step {
    Step {
        time: 4.0,
        source: Source { clip: 0, time: 4.0 },
        frame_time: 3.95,
        action,
        position: position.map(|(x, y)| Point::new(x, y)),
        drag_to: drag_to.map(|(x, y)| Point::new(x, y)),
        repeat: 1,
        heading: None,
        narration: String::new(),
    }
}

const RETINA: Size = Size {
    width: 3024,
    height: 1964,
};
const HD: Size = Size {
    width: 1280,
    height: 720,
};

#[test]
fn without_a_position_the_crop_is_the_whole_frame() {
    assert_eq!(
        crop_for(&step(Action::Note, None, None), RETINA),
        Rect {
            x: 0,
            y: 0,
            width: 3024,
            height: 1964
        }
    );
}

#[test]
fn a_click_is_cropped_to_half_the_frame_at_16_by_10() {
    assert_eq!(
        crop_for(&step(Action::Click, Some((0.5, 0.5)), None), RETINA),
        Rect {
            x: 756,
            y: 510,
            width: 1512,
            height: 944
        }
    );
}

#[test]
fn a_crop_is_never_narrower_than_960_pixels() {
    assert_eq!(
        crop_for(&step(Action::Click, Some((0.5, 0.5)), None), HD),
        Rect {
            x: 160,
            y: 60,
            width: 960,
            height: 600
        }
    );
}

#[test]
fn a_small_frame_is_cropped_across_its_full_width() {
    let frame = Size {
        width: 800,
        height: 600,
    };
    assert_eq!(
        crop_for(&step(Action::Click, Some((0.5, 0.5)), None), frame),
        Rect {
            x: 0,
            y: 50,
            width: 800,
            height: 500
        }
    );
}

#[test]
fn a_crop_near_an_edge_stays_inside_the_frame() {
    assert_eq!(
        crop_for(&step(Action::Click, Some((0.99, 0.01)), None), RETINA),
        Rect {
            x: 1512,
            y: 0,
            width: 1512,
            height: 944
        }
    );
    assert_eq!(
        crop_for(&step(Action::Click, Some((0.0, 1.0)), None), RETINA),
        Rect {
            x: 0,
            y: 1020,
            width: 1512,
            height: 944
        }
    );
}

#[test]
fn a_short_drag_is_cropped_around_its_middle() {
    assert_eq!(
        crop_for(
            &step(Action::Drag, Some((0.45, 0.5)), Some((0.55, 0.5))),
            RETINA
        ),
        Rect {
            x: 756,
            y: 510,
            width: 1512,
            height: 944
        }
    );
}

#[test]
fn a_long_drag_widens_the_crop_to_hold_both_ends() {
    let drags = [
        ((0.1, 0.5), (0.9, 0.5)),
        ((0.2, 0.1), (0.3, 0.9)),
        ((0.05, 0.05), (0.95, 0.95)),
        ((0.6, 0.7), (0.1, 0.2)),
    ];
    for (from, to) in drags {
        let crop = crop_for(&step(Action::Drag, Some(from), Some(to)), RETINA);
        assert!(crop.x + crop.width <= RETINA.width, "{crop:?}");
        assert!(crop.y + crop.height <= RETINA.height, "{crop:?}");
        assert!(crop.width >= 1512 && crop.height >= 944, "{crop:?}");
        let full = crop.width == RETINA.width && crop.height == RETINA.height;
        for (x, y) in [from, to] {
            let px = x * f64::from(RETINA.width);
            let py = y * f64::from(RETINA.height);
            let margin_x = if full || crop.width == RETINA.width {
                0.0
            } else {
                0.08 * f64::from(crop.width)
            };
            let margin_y = if full || crop.height == RETINA.height {
                0.0
            } else {
                0.08 * f64::from(crop.height)
            };
            let left_free = crop.x == 0;
            let right_free = crop.x + crop.width == RETINA.width;
            let top_free = crop.y == 0;
            let bottom_free = crop.y + crop.height == RETINA.height;
            assert!(
                px >= f64::from(crop.x) + if left_free { 0.0 } else { margin_x } - 1.0,
                "{from:?} to {to:?}: {crop:?}"
            );
            assert!(
                px <= f64::from(crop.x + crop.width) - if right_free { 0.0 } else { margin_x }
                    + 1.0,
                "{from:?} to {to:?}: {crop:?}"
            );
            assert!(
                py >= f64::from(crop.y) + if top_free { 0.0 } else { margin_y } - 1.0,
                "{from:?} to {to:?}: {crop:?}"
            );
            assert!(
                py <= f64::from(crop.y + crop.height) - if bottom_free { 0.0 } else { margin_y }
                    + 1.0,
                "{from:?} to {to:?}: {crop:?}"
            );
        }
    }
}

fn gradient(size: Size) -> Vec<u8> {
    let mut pixels = Vec::with_capacity((size.width * size.height * 4) as usize);
    for y in 0..size.height {
        for x in 0..size.width {
            pixels.extend_from_slice(&[(x % 251) as u8, (y % 241) as u8, 0, 255]);
        }
    }
    pixels
}

fn gray(size: Size) -> Vec<u8> {
    [128, 128, 128, 255].repeat((size.width * size.height) as usize)
}

fn pixel(image: &cap_steps::StepImage, x: f64, y: f64) -> [u8; 4] {
    let x = (x.round() as u32).min(image.size.width - 1);
    let y = (y.round() as u32).min(image.size.height - 1);
    let index = ((y * image.size.width + x) * 4) as usize;
    [
        image.rgba[index],
        image.rgba[index + 1],
        image.rgba[index + 2],
        image.rgba[index + 3],
    ]
}

fn is_cap_blue(pixel: [u8; 4]) -> bool {
    pixel[..3]
        .iter()
        .zip(CAP_BLUE)
        .all(|(channel, blue)| (i32::from(*channel) - i32::from(blue)).abs() <= 24)
}

fn ring_radius(crop: Rect) -> f64 {
    (f64::from(crop.width) * 0.022).max(14.0)
}

#[test]
fn the_step_image_is_the_cropped_frame() {
    let click = step(Action::Click, Some((0.25, 0.75)), None);
    let crop = crop_for(&click, HD);
    let image = render_step_image(&gradient(HD), HD, &click).expect("an image");
    assert_eq!(
        image.size,
        Size {
            width: crop.width,
            height: crop.height
        }
    );
    assert_eq!(image.rgba.len(), (crop.width * crop.height * 4) as usize);
    for (x, y) in [(0, 0), (crop.width - 1, 0), (0, crop.height - 1)] {
        assert_eq!(
            pixel(&image, f64::from(x), f64::from(y)),
            [
                ((crop.x + x) % 251) as u8,
                ((crop.y + y) % 241) as u8,
                0,
                255
            ]
        );
    }
}

#[test]
fn the_click_is_ringed_in_cap_blue() {
    for position in [(0.5, 0.5), (0.25, 0.75), (0.9, 0.2)] {
        let click = step(Action::Click, Some(position), None);
        let crop = crop_for(&click, HD);
        let image = render_step_image(&gray(HD), HD, &click).expect("an image");
        let cx = position.0 * f64::from(HD.width) - f64::from(crop.x);
        let cy = position.1 * f64::from(HD.height) - f64::from(crop.y);
        let radius = ring_radius(crop);
        for turn in 0..8 {
            let angle = f64::from(turn) * std::f64::consts::FRAC_PI_4;
            let sample = pixel(&image, cx + radius * angle.cos(), cy + radius * angle.sin());
            assert!(is_cap_blue(sample), "{position:?} turn {turn}: {sample:?}");
        }
    }
}

#[test]
fn what_was_clicked_stays_visible_inside_the_ring() {
    let click = step(Action::Click, Some((0.5, 0.5)), None);
    let crop = crop_for(&click, HD);
    let image = render_step_image(&gray(HD), HD, &click).expect("an image");
    let centre = pixel(
        &image,
        f64::from(crop.width) / 2.0,
        f64::from(crop.height) / 2.0,
    );
    assert!(!is_cap_blue(centre), "{centre:?}");
    for channel in &centre[..3] {
        assert!((i32::from(*channel) - 128).abs() <= 40, "{centre:?}");
    }
}

#[test]
fn pixels_away_from_the_ring_are_untouched() {
    let click = step(Action::Click, Some((0.5, 0.5)), None);
    let crop = crop_for(&click, HD);
    let image = render_step_image(&gray(HD), HD, &click).expect("an image");
    let radius = ring_radius(crop);
    let cx = f64::from(crop.width) / 2.0;
    let cy = f64::from(crop.height) / 2.0;
    for turn in 0..8 {
        let angle = f64::from(turn) * std::f64::consts::FRAC_PI_4;
        assert_eq!(
            pixel(
                &image,
                cx + 3.0 * radius * angle.cos(),
                cy + 3.0 * radius * angle.sin()
            ),
            [128, 128, 128, 255]
        );
    }
}

#[test]
fn a_drag_is_drawn_as_a_line_between_its_ends() {
    let drag = step(Action::Drag, Some((0.4, 0.4)), Some((0.6, 0.6)));
    let crop = crop_for(&drag, HD);
    let image = render_step_image(&gray(HD), HD, &drag).expect("an image");
    let middle = pixel(
        &image,
        0.5 * f64::from(HD.width) - f64::from(crop.x),
        0.5 * f64::from(HD.height) - f64::from(crop.y),
    );
    assert!(is_cap_blue(middle), "{middle:?}");
}

#[test]
fn a_note_is_the_frame_as_it_was() {
    let frame = gradient(HD);
    let image = render_step_image(&frame, HD, &step(Action::Note, None, None)).expect("an image");
    assert_eq!(image.size, HD);
    assert_eq!(image.rgba, frame);
}

#[test]
fn a_frame_of_the_wrong_length_gives_no_image() {
    let click = step(Action::Click, Some((0.5, 0.5)), None);
    assert!(render_step_image(&[0; 16], HD, &click).is_none());
    assert!(
        render_step_image(
            &[],
            Size {
                width: 0,
                height: 0
            },
            &click
        )
        .is_none()
    );
}

#[test]
fn step_images_are_written_as_png() {
    let click = step(Action::Click, Some((0.5, 0.5)), None);
    let image = render_step_image(&gradient(HD), HD, &click).expect("an image");
    let png = encode_png(&image).expect("a png");
    let decoded = image::load_from_memory_with_format(&png, image::ImageFormat::Png)
        .expect("a readable png")
        .to_rgba8();
    assert_eq!(decoded.width(), image.size.width);
    assert_eq!(decoded.height(), image.size.height);
    assert_eq!(decoded.into_raw(), image.rgba);
}

#[test]
fn image_names_are_zero_padded() {
    assert_eq!(image_name(1, 9), "step-01.png");
    assert_eq!(image_name(12, 12), "step-12.png");
    assert_eq!(image_name(7, 120), "step-007.png");
}

#[test]
fn only_names_a_guide_gives_its_screenshots_are_image_names() {
    for (index, total) in [(1, 1), (9, 9), (12, 12), (7, 120), (1000, 1000)] {
        let name = image_name(index, total);
        assert!(is_image_name(&name), "{name}");
    }
    for name in [
        "",
        "step-.png",
        "step-01.PNG",
        "step-01.png.bak",
        "step-one.png",
        "step-01.jpg",
        "my-step-01.png",
        "step--1.png",
        "step-01/x.png",
        "../step-01.png",
        "step-01.png/..",
        "diagram.png",
    ] {
        assert!(!is_image_name(name), "{name}");
    }
}

#[test]
fn timestamps_read_like_a_player() {
    assert_eq!(timestamp(4.2), "0:04");
    assert_eq!(timestamp(75.0), "1:15");
    assert_eq!(timestamp(3725.0), "1:02:05");
    assert_eq!(timestamp(-3.0), "0:00");
    assert_eq!(timestamp(f64::NAN), "0:00");
}

fn document_step(
    index: usize,
    time: f64,
    action: Action,
    narration: &str,
    heading: Option<&str>,
) -> DocumentStep {
    DocumentStep {
        step: Step {
            time,
            source: Source { clip: 0, time },
            frame_time: time,
            action,
            position: (action != Action::Note).then(|| Point::new(0.5, 0.5)),
            drag_to: (action == Action::Drag).then(|| Point::new(0.6, 0.6)),
            repeat: 1,
            heading: heading.map(str::to_string),
            narration: narration.to_string(),
        },
        image: format!("steps/{}", image_name(index, 2)),
    }
}

#[test]
fn markdown_lays_out_the_title_the_intro_and_each_step() {
    let document = Document {
        title: "Invite a teammate".into(),
        duration: 12.0,
        intro: "A quick tour of the team page.".into(),
        steps: vec![
            document_step(1, 4.2, Action::Click, "Open the team page.", None),
            document_step(2, 9.0, Action::Click, "", None),
        ],
    };
    assert_eq!(
        markdown(&document, &Captions::default()),
        "# Invite a teammate\n\
         \n\
         A quick tour of the team page.\n\
         \n\
         ### Step 1 · 0:04\n\
         \n\
         Open the team page.\n\
         \n\
         ![Step 1](steps/step-01.png)\n\
         \n\
         ### Step 2 · 0:09\n\
         \n\
         Click the highlighted spot.\n\
         \n\
         ![Step 2](steps/step-02.png)\n"
    );
}

#[test]
fn markdown_opens_a_section_at_each_heading() {
    let document = Document {
        title: "Setup".into(),
        duration: 30.0,
        intro: String::new(),
        steps: vec![
            document_step(1, 3.0, Action::Click, "Sign in.", Some("Create a project")),
            document_step(2, 14.0, Action::Note, "", Some("Invite your team")),
        ],
    };
    assert_eq!(
        markdown(&document, &Captions::default()),
        "# Setup\n\
         \n\
         ## Create a project\n\
         \n\
         ### Step 1 · 0:03\n\
         \n\
         Sign in.\n\
         \n\
         ![Step 1](steps/step-01.png)\n\
         \n\
         ## Invite your team\n\
         \n\
         ### Step 2 · 0:14\n\
         \n\
         ![Step 2](steps/step-02.png)\n"
    );
}

#[test]
fn markdown_names_the_action_when_narration_alone_would_not() {
    let mut double = document_step(1, 3.0, Action::DoubleClick, "Open the file.", None);
    let mut repeated = document_step(2, 6.0, Action::Click, "Go forward a few pages.", None);
    repeated.step.repeat = 3;
    let right = document_step(1, 8.0, Action::RightClick, "", None);
    let dragged = document_step(2, 9.0, Action::Drag, "Move the slider.", None);
    let captions = Captions::default();

    double.image = "steps/step-01.png".into();
    let text = markdown(
        &Document {
            title: "T".into(),
            duration: 10.0,
            intro: String::new(),
            steps: vec![double, repeated],
        },
        &captions,
    );
    assert!(
        text.contains("Open the file.\n\n_Double-click the highlighted spot._\n\n![Step 1]"),
        "{text}"
    );
    assert!(
        text.contains(
            "Go forward a few pages.\n\n_Click the highlighted spot 3 times._\n\n![Step 2]"
        ),
        "{text}"
    );

    let text = markdown(
        &Document {
            title: "T".into(),
            duration: 10.0,
            intro: String::new(),
            steps: vec![right, dragged],
        },
        &captions,
    );
    assert!(
        text.contains("### Step 1 · 0:08\n\nRight-click the highlighted spot.\n\n![Step 1]"),
        "{text}"
    );
    assert!(
        text.contains("Move the slider.\n\n_Drag along the arrow._\n\n![Step 2]"),
        "{text}"
    );
}

#[test]
fn markdown_uses_the_captions_it_is_given() {
    let captions = Captions {
        step: "Schritt {number}".into(),
        click: "Klicke auf die markierte Stelle.".into(),
        double_click: "Doppelklicke auf die markierte Stelle.".into(),
        right_click: "Rechtsklicke auf die markierte Stelle.".into(),
        drag: "Ziehe entlang des Pfeils.".into(),
        repeat: "Klicke {count}-mal auf die markierte Stelle.".into(),
    };
    let mut repeated = document_step(2, 6.0, Action::Click, "", None);
    repeated.step.repeat = 4;
    let text = markdown(
        &Document {
            title: "T".into(),
            duration: 10.0,
            intro: String::new(),
            steps: vec![document_step(1, 3.0, Action::Click, "", None), repeated],
        },
        &captions,
    );
    assert!(
        text.contains("### Schritt 1 · 0:03\n\nKlicke auf die markierte Stelle.\n\n![Schritt 1]"),
        "{text}"
    );
    assert!(
        text.contains("Klicke 4-mal auf die markierte Stelle."),
        "{text}"
    );
}

#[test]
fn narration_cannot_break_the_markdown() {
    let document = Document {
        title: "Use *bold* <b>".into(),
        duration: 10.0,
        intro: "#1 priority".into(),
        steps: vec![document_step(
            1,
            3.0,
            Action::Click,
            "Type *bold* into <input> [here]_now with `code` and a \\ slash",
            Some("Step [one]"),
        )],
    };
    let text = markdown(&document, &Captions::default());
    assert!(text.starts_with("# Use \\*bold\\* \\<b\\>\n"), "{text}");
    assert!(text.contains("\n\\#1 priority\n"), "{text}");
    assert!(text.contains("\n## Step \\[one\\]\n"), "{text}");
    assert!(
        text.contains(
            "Type \\*bold\\* into \\<input\\> \\[here\\]\\_now with \\`code\\` and a \\\\ slash"
        ),
        "{text}"
    );
}

#[test]
fn narration_that_looks_like_a_list_a_fence_or_an_entity_stays_text() {
    let said = |narration: &str| {
        markdown(
            &Document {
                title: "T".into(),
                duration: 10.0,
                intro: String::new(),
                steps: vec![document_step(1, 3.0, Action::Click, narration, None)],
            },
            &Captions::default(),
        )
    };
    assert!(said("1. Open settings").contains("\n1\\. Open settings\n"));
    assert!(said("12) then save").contains("\n12\\) then save\n"));
    assert!(said("3 files are listed.").contains("\n3 files are listed.\n"));
    assert!(said("~~~ fenced").contains("\n\\~\\~\\~ fenced\n"));
    assert!(said("AT&T uses &lt;b&gt;").contains("\nAT\\&T uses \\&lt;b\\&gt;\n"));
}

#[test]
fn an_empty_guide_is_just_its_title() {
    let document = Document {
        title: "Nothing yet".into(),
        duration: 0.0,
        intro: String::new(),
        steps: Vec::new(),
    };
    assert_eq!(markdown(&document, &Captions::default()), "# Nothing yet\n");
}

#[test]
fn json_lists_every_step_for_tools_to_read() {
    let mut dragged = document_step(2, 9.5, Action::Drag, "Move the slider.", Some("Tune it"));
    dragged.step.repeat = 1;
    let document = Document {
        title: "Invite a teammate".into(),
        duration: 12.5,
        intro: "A quick tour.".into(),
        steps: vec![
            document_step(1, 4.0, Action::DoubleClick, "Open the file.", None),
            dragged,
        ],
    };
    let value: serde_json::Value = serde_json::from_str(&json(&document)).expect("valid json");
    assert_eq!(value["title"], "Invite a teammate");
    assert_eq!(value["duration"], 12.5);
    assert_eq!(value["intro"], "A quick tour.");
    let steps = value["steps"].as_array().expect("steps");
    assert_eq!(steps.len(), 2);
    assert_eq!(steps[0]["index"], 1);
    assert_eq!(steps[0]["time"], 4.0);
    assert_eq!(steps[0]["action"], "doubleClick");
    assert_eq!(steps[0]["position"]["x"], 0.5);
    assert_eq!(steps[0]["position"]["y"], 0.5);
    assert!(steps[0]["dragTo"].is_null());
    assert_eq!(steps[0]["repeat"], 1);
    assert!(steps[0]["heading"].is_null());
    assert_eq!(steps[0]["narration"], "Open the file.");
    assert_eq!(steps[0]["image"], "steps/step-01.png");
    assert_eq!(steps[1]["action"], "drag");
    assert_eq!(steps[1]["dragTo"]["x"], 0.6);
    assert_eq!(steps[1]["heading"], "Tune it");
}

#[test]
fn the_screenshots_a_guide_lists_can_be_read_back_from_its_json() {
    let document = Document {
        title: "Invite a teammate".into(),
        duration: 12.5,
        intro: String::new(),
        steps: vec![
            document_step(1, 4.0, Action::Click, "", None),
            document_step(2, 9.5, Action::Click, "", None),
        ],
    };
    let images: Vec<String> = document
        .steps
        .iter()
        .map(|entry| entry.image.clone())
        .collect();
    assert_eq!(listed_images(&json(&document)), images);
}

#[test]
fn text_that_is_not_a_guide_lists_no_screenshots() {
    for text in [
        "",
        "not json",
        "[]",
        "{}",
        r#"{"steps": "steps/step-01.png"}"#,
        r#"{"steps": [{"image": 4}]}"#,
    ] {
        assert!(listed_images(text).is_empty(), "{text}");
    }
    assert_eq!(listed_images(r#"{"steps": [{"index": 1}]}"#), [""]);
}
