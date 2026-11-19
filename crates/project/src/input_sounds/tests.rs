use super::*;
use crate::{KeyboardData, KeyboardSettings, KeyboardTrackSegment};

fn press(key: &str, time_ms: f64, down: bool) -> KeyPressEvent {
    KeyPressEvent {
        key: key.to_string(),
        key_code: key.to_string(),
        time_ms,
        down,
    }
}

fn click(time_ms: f64, down: bool) -> CursorClickEvent {
    CursorClickEvent {
        active_modifiers: Vec::new(),
        cursor_num: 0,
        cursor_id: "0".into(),
        time_ms,
        down,
    }
}

fn shown(start: f64, end: f64) -> KeyboardTrackSegment {
    serde_json::from_value(serde_json::json!({
        "id": format!("kb-{start}"), "start": start, "end": end, "displayText": "x"
    }))
    .unwrap()
}

fn project(timeline: serde_json::Value, keys: bool, clicks: bool) -> ProjectConfiguration {
    let mut project: ProjectConfiguration =
        serde_json::from_value(serde_json::json!({ "timeline": timeline })).unwrap();
    project.keyboard = Some(KeyboardData {
        settings: KeyboardSettings {
            enabled: true,
            key_sounds: keys,
            ..Default::default()
        },
    });
    project.cursor.click_sounds = clicks;
    project
}

fn cut_and_sped_timeline() -> serde_json::Value {
    serde_json::json!({
        "segments": [
            { "start": 0.0, "end": 2.0, "timescale": 1.0, "recordingSegment": 0 },
            { "start": 4.0, "end": 6.0, "timescale": 2.0, "recordingSegment": 0,
              "speedAudioMode": "maintainPitch" },
            { "start": 1.0, "end": 2.0, "timescale": 0.5, "recordingSegment": 1,
              "speedAudioMode": "maintainPitch" }
        ],
        "zoomSegments": []
    })
}

fn key_times(events: &[InputSoundEvent], want_down: bool) -> Vec<f64> {
    events
        .iter()
        .filter_map(|event| match event.kind {
            InputSoundKind::Key { down, .. } if down == want_down => Some(event.time),
            _ => None,
        })
        .collect()
}

#[test]
fn off_by_default_and_for_old_projects() {
    let project: ProjectConfiguration = serde_json::from_value(serde_json::json!({
        "timeline": cut_and_sped_timeline(),
        "keyboard": { "settings": { "enabled": true, "showModifiers": false } },
        "cursor": { "size": 120 }
    }))
    .unwrap();
    let settings = &project.keyboard.as_ref().unwrap().settings;
    assert!(!settings.key_sounds);
    assert_eq!(settings.key_sound_type, crate::KeySoundType::Mechanical);
    assert_eq!(settings.key_sound_volume, crate::DEFAULT_INPUT_SOUND_VOLUME);
    assert!(!settings.show_modifiers);
    assert!(!project.cursor.click_sounds);
    assert_eq!(
        project.cursor.click_sound_type,
        crate::ClickSoundType::Mouse
    );
    assert_eq!(project.cursor.size, 120);

    let keyboard = KeyboardEvents {
        presses: vec![press("a", 500.0, true), press("a", 560.0, false)],
    };
    let clicks = [click(500.0, true), click(580.0, false)];
    let takes = [InputSoundTake {
        keyboard: &keyboard,
        keyboard_offset_secs: 0.0,
        clicks: &clicks,
    }];
    assert!(input_sound_events(&project, &takes).is_empty());
    assert!(input_sound_events(&ProjectConfiguration::default(), &takes).is_empty());
}

#[test]
fn settings_round_trip_through_json() {
    let mut project = ProjectConfiguration {
        keyboard: Some(KeyboardData {
            settings: KeyboardSettings {
                key_sounds: true,
                key_sound_type: crate::KeySoundType::Typewriter,
                key_sound_volume: 0.25,
                ..Default::default()
            },
        }),
        ..Default::default()
    };
    project.cursor.click_sounds = true;
    project.cursor.click_sound_type = crate::ClickSoundType::Trackpad;
    project.cursor.click_sound_volume = 0.8;
    let json = serde_json::to_value(&project).unwrap();
    assert_eq!(json["keyboard"]["settings"]["keySoundType"], "typewriter");
    assert_eq!(json["cursor"]["clickSoundType"], "trackpad");
    let back: ProjectConfiguration = serde_json::from_value(json).unwrap();
    let settings = back.keyboard.unwrap().settings;
    assert!(settings.key_sounds);
    assert_eq!(settings.key_sound_type, crate::KeySoundType::Typewriter);
    assert_eq!(settings.key_sound_volume, 0.25);
    assert!(back.cursor.click_sounds);
    assert_eq!(
        back.cursor.click_sound_type,
        crate::ClickSoundType::Trackpad
    );
    assert_eq!(back.cursor.click_sound_volume, 0.8);
}

#[test]
fn presses_follow_cuts_speed_and_clip_order() {
    let mut project = project(cut_and_sped_timeline(), true, true);
    project.timeline.as_mut().unwrap().keyboard_segments = vec![shown(0.0, 10.0)];
    let offset = 0.25;
    let first = KeyboardEvents {
        presses: [1.0, 3.0, 5.0]
            .into_iter()
            .flat_map(|secs| {
                let ms = (secs + offset) * 1000.0;
                [press("a", ms, true), press("a", ms + 40.0, false)]
            })
            .collect(),
    };
    let second = KeyboardEvents {
        presses: vec![press("b", 1_500.0, true), press("b", 1_540.0, false)],
    };
    let first_clicks = [
        click(1_000.0, true),
        click(3_000.0, true),
        click(5_000.0, true),
    ];
    let takes = [
        InputSoundTake {
            keyboard: &first,
            keyboard_offset_secs: offset,
            clicks: &first_clicks,
        },
        InputSoundTake {
            keyboard: &second,
            keyboard_offset_secs: 0.0,
            clicks: &[],
        },
    ];
    let events = input_sound_events(&project, &takes);
    let downs = key_times(&events, true);
    let ups = key_times(&events, false);
    let expected_downs = [1.0, 2.0 + 1.0 / 2.0, 3.0 + 0.5 / 0.5];
    assert_eq!(downs.len(), expected_downs.len());
    for (got, want) in downs.iter().zip(expected_downs) {
        assert!((got - want).abs() < 1e-9, "{got} vs {want}");
    }
    let expected_ups = [1.04, 2.5 + 0.02, 4.0 + 0.08];
    for (got, want) in ups.iter().zip(expected_ups) {
        assert!((got - want).abs() < 1e-9, "{got} vs {want}");
    }
    let clicks: Vec<f64> = events
        .iter()
        .filter(|event| matches!(event.kind, InputSoundKind::Click { .. }))
        .map(|event| event.time)
        .collect();
    assert_eq!(clicks, vec![1.0, 2.5]);
    assert!(events.windows(2).all(|pair| pair[0].time <= pair[1].time));

    for event in &events {
        let (source, segment) = project.get_segment_time(event.time).unwrap();
        let recorded = match (event.kind, segment.recording_clip) {
            (InputSoundKind::Key { .. }, 0) => source + offset,
            _ => source,
        };
        let matches_input = takes[segment.recording_clip as usize]
            .keyboard
            .presses
            .iter()
            .map(|press| press.time_ms / 1000.0)
            .chain(
                takes[segment.recording_clip as usize]
                    .clicks
                    .iter()
                    .map(|click| click.time_ms / 1000.0),
            )
            .any(|time| (time - recorded).abs() < 1e-6);
        assert!(matches_input, "{event:?} does not land on its source frame");
    }
}

#[test]
fn key_sounds_play_only_where_the_keyboard_track_shows_keys() {
    let mut project = project(cut_and_sped_timeline(), true, false);
    project.timeline.as_mut().unwrap().keyboard_segments = vec![shown(0.9, 1.2)];
    let keyboard = KeyboardEvents {
        presses: vec![
            press("LShift", 800.0, true),
            press("a", 1_000.0, true),
            press("LShift", 1_050.0, false),
            press("a", 1_080.0, false),
            press("b", 1_500.0, true),
            press("b", 1_560.0, false),
        ],
    };
    let takes = [InputSoundTake {
        keyboard: &keyboard,
        keyboard_offset_secs: 0.0,
        clicks: &[],
    }];
    let events = input_sound_events(&project, &takes);
    assert_eq!(
        events.iter().map(|event| event.kind).collect::<Vec<_>>(),
        vec![
            InputSoundKind::Key {
                class: KeySoundClass::Letter,
                down: true
            },
            InputSoundKind::Key {
                class: KeySoundClass::Letter,
                down: false
            },
        ]
    );

    project.keyboard.as_mut().unwrap().settings.enabled = false;
    assert!(input_sound_events(&project, &takes).is_empty());
}

#[test]
fn hidden_cursor_mutes_clicks() {
    let mut project = project(cut_and_sped_timeline(), false, true);
    let clicks = [click(500.0, true), click(560.0, false)];
    let keyboard = KeyboardEvents::default();
    let takes = [InputSoundTake {
        keyboard: &keyboard,
        keyboard_offset_secs: 0.0,
        clicks: &clicks,
    }];
    assert_eq!(input_sound_events(&project, &takes).len(), 2);
    project.cursor.hide = true;
    assert!(input_sound_events(&project, &takes).is_empty());
}

#[test]
fn transitions_and_holds_match_the_keyboard_track() {
    let mut project = project(
        serde_json::json!({
            "segments": [
                { "start": 0.0, "end": 3.0, "timescale": 1.0, "recordingSegment": 0 },
                { "start": 5.0, "end": 9.0, "timescale": 1.5, "recordingSegment": 0,
                  "speedAudioMode": "maintainPitch" }
            ],
            "transitions": [{ "segmentIndex": 1, "type": "cross-fade", "duration": 0.5 }],
            "zoomSegments": [],
            "textSegments": [{ "start": 1.0, "end": 2.25, "layout": "fullscreen" }]
        }),
        true,
        false,
    );
    let presses = (0..90)
        .flat_map(|index| {
            let ms = index as f64 * 100.0 + 37.0;
            [press("k", ms, true), press("k", ms + 30.0, false)]
        })
        .collect();
    let keyboard = KeyboardEvents { presses };
    // Plain letters are typing, which new projects hide; show it.
    let settings = KeyboardSettings {
        show_modifiers: true,
        show_typing: true,
        ..Default::default()
    };
    let timeline = project.timeline.clone().unwrap();
    let track =
        crate::keyboard::project_keyboard_events(&[(keyboard.clone(), 0.0)], &timeline, &settings);
    assert!(!track.is_empty());
    let mut shown_times: Vec<f64> = track
        .iter()
        .flat_map(|segment| {
            segment
                .keys
                .iter()
                .map(move |key| segment.start + key.time_offset / 1000.0)
        })
        .collect();
    shown_times.sort_by(f64::total_cmp);
    project.timeline.as_mut().unwrap().keyboard_segments = track;
    let takes = [InputSoundTake {
        keyboard: &keyboard,
        keyboard_offset_secs: 0.0,
        clicks: &[],
    }];
    let downs = key_times(&input_sound_events(&project, &takes), true);
    assert_eq!(downs.len(), shown_times.len());
    for (sound, shown) in downs.iter().zip(&shown_times) {
        assert!((sound - shown).abs() < 1e-6, "{sound} vs {shown}");
    }
}

#[test]
fn events_are_deterministic_and_vary_per_press() {
    let mut project = project(cut_and_sped_timeline(), true, true);
    project.timeline.as_mut().unwrap().keyboard_segments = vec![shown(0.0, 10.0)];
    let keyboard = KeyboardEvents {
        presses: (0..20)
            .flat_map(|index| {
                let ms = 100.0 + index as f64 * 80.0;
                [press("a", ms, true), press("a", ms + 30.0, false)]
            })
            .collect(),
    };
    let clicks = [click(100.0, true), click(150.0, false)];
    let takes = [InputSoundTake {
        keyboard: &keyboard,
        keyboard_offset_secs: 0.0,
        clicks: &clicks,
    }];
    let first = input_sound_events(&project, &takes);
    let second = input_sound_events(&project, &takes);
    assert_eq!(first, second);
    let mut seeds: Vec<u64> = first.iter().map(|event| event.seed).collect();
    seeds.sort_unstable();
    seeds.dedup();
    assert_eq!(seeds.len(), first.len());
}

#[test]
fn keys_are_classed_and_placed_across_the_keyboard() {
    assert_eq!(KeySoundClass::of("Space"), KeySoundClass::Space);
    assert_eq!(KeySoundClass::of("Enter"), KeySoundClass::Enter);
    assert_eq!(KeySoundClass::of("Backspace"), KeySoundClass::Backspace);
    assert_eq!(KeySoundClass::of("LShift"), KeySoundClass::Modifier);
    assert_eq!(KeySoundClass::of("Meta"), KeySoundClass::Modifier);
    assert_eq!(KeySoundClass::of("a"), KeySoundClass::Letter);
    assert!(key_pan("Q") < key_pan("P"));
    assert!(key_pan("LShift") < 0.0 && key_pan("Enter") > 0.0);
    assert!(key_pan("Space").abs() < 0.05);
    assert_eq!(key_pan("SomethingElse"), 0.0);
    for code in ["Grave", "Q", "A", "Z", "Backspace", "RShift", "Right"] {
        assert!(key_pan(code).abs() <= 0.35);
    }
}

#[test]
fn muted_clips_stay_silent_and_clip_volume_carries_over() {
    let mut project = project(cut_and_sped_timeline(), true, true);
    project.timeline.as_mut().unwrap().keyboard_segments = vec![shown(0.0, 10.0)];
    let keyboard = KeyboardEvents {
        presses: vec![press("a", 1_000.0, true), press("a", 5_000.0, true)],
    };
    let clicks = [click(1_000.0, true), click(5_000.0, true)];
    let takes = [InputSoundTake {
        keyboard: &keyboard,
        keyboard_offset_secs: 0.0,
        clicks: &clicks,
    }];
    {
        let timeline = project.timeline.as_mut().unwrap();
        timeline.segments[0].speed_audio_mode = Some(crate::ClipSpeedAudioMode::Mute);
        timeline.segments[1].volume = Some(0.5);
    }
    let events = input_sound_events(&project, &takes);
    assert_eq!(events.len(), 2);
    assert!(events.iter().all(|event| (event.time - 2.5).abs() < 1e-9));
    assert!(events.iter().all(|event| event.gain == 0.5));

    // A sped-up clip is silent unless its audio was kept, as its own sound
    // is, and so is a clip faster than audio can follow.
    project.timeline.as_mut().unwrap().segments[1].speed_audio_mode = None;
    assert!(input_sound_events(&project, &takes).is_empty());
    {
        let timeline = project.timeline.as_mut().unwrap();
        timeline.segments[1].speed_audio_mode = Some(crate::ClipSpeedAudioMode::MatchSpeed);
        timeline.segments[1].timescale = 16.0;
    }
    assert!(input_sound_events(&project, &takes).is_empty());
}

#[test]
fn a_split_keeps_a_held_key_and_a_cut_drops_its_release() {
    let keyboard = KeyboardEvents {
        presses: vec![press("a", 1000.0, true), press("a", 1080.0, false)],
    };
    let takes = [InputSoundTake {
        keyboard: &keyboard,
        keyboard_offset_secs: 0.0,
        clicks: &[],
    }];
    let events_for = |segments: serde_json::Value| {
        let mut project = project(
            serde_json::json!({ "segments": segments, "zoomSegments": [] }),
            true,
            false,
        );
        project.timeline.as_mut().unwrap().keyboard_segments = vec![shown(0.0, 3.0)];
        input_sound_events(&project, &takes)
    };
    let whole = events_for(serde_json::json!([
        { "start": 0.0, "end": 3.0, "timescale": 1.0, "recordingSegment": 0 }
    ]));
    let split = events_for(serde_json::json!([
        { "start": 0.0, "end": 1.04, "timescale": 1.0, "recordingSegment": 0 },
        { "start": 1.04, "end": 3.0, "timescale": 1.0, "recordingSegment": 0 }
    ]));
    assert_eq!(key_times(&whole, true).len(), 1);
    assert_eq!(key_times(&whole, false).len(), 1);
    // Splitting without removing anything sounds exactly the same.
    assert_eq!(split.len(), whole.len());
    for (a, b) in split.iter().zip(&whole) {
        assert!((a.time - b.time).abs() < 1e-9);
        assert_eq!(a.kind, b.kind);
    }
    // Cutting out the moment between press and release drops the release.
    let cut = events_for(serde_json::json!([
        { "start": 0.0, "end": 1.04, "timescale": 1.0, "recordingSegment": 0 },
        { "start": 1.06, "end": 3.0, "timescale": 1.0, "recordingSegment": 0 }
    ]));
    assert_eq!(key_times(&cut, true).len(), 1);
    assert!(key_times(&cut, false).is_empty());
}

#[test]
fn a_clip_that_hides_the_cursor_hides_its_clicks() {
    let clicks = [
        click(500.0, true),
        click(560.0, false),
        click(3500.0, true),
        click(3560.0, false),
    ];
    let keyboard = KeyboardEvents::default();
    let takes = [InputSoundTake {
        keyboard: &keyboard,
        keyboard_offset_secs: 0.0,
        clicks: &clicks,
    }];
    let mut project = project(
        serde_json::json!({
            "segments": [
                { "start": 0.0, "end": 2.0, "timescale": 1.0, "recordingSegment": 0 },
                { "start": 2.0, "end": 5.0, "timescale": 1.0, "recordingSegment": 0 }
            ],
            "zoomSegments": []
        }),
        false,
        true,
    );
    assert_eq!(input_sound_events(&project, &takes).len(), 4);
    project.timeline.as_mut().unwrap().segments[1].hide_cursor = Some(true);
    let events = input_sound_events(&project, &takes);
    assert_eq!(events.len(), 2);
    assert!(events.iter().all(|event| event.time < 1.0));
}

#[test]
fn a_transition_never_sounds_a_release_before_its_press() {
    let keyboard = KeyboardEvents {
        presses: vec![press("a", 1900.0, true), press("a", 2100.0, false)],
    };
    let takes = [InputSoundTake {
        keyboard: &keyboard,
        keyboard_offset_secs: 0.0,
        clicks: &[],
    }];
    let mut project = project(
        serde_json::json!({
            "segments": [
                { "start": 0.0, "end": 2.0, "timescale": 1.0, "recordingSegment": 0 },
                { "start": 2.0, "end": 4.0, "timescale": 1.0, "recordingSegment": 0 }
            ],
            "transitions": [{ "segmentIndex": 1, "type": "cross-fade", "duration": 0.5 }],
            "zoomSegments": []
        }),
        true,
        false,
    );
    project.timeline.as_mut().unwrap().keyboard_segments = vec![shown(0.0, 4.0)];
    let events = input_sound_events(&project, &takes);
    let downs = key_times(&events, true);
    let ups = key_times(&events, false);
    assert_eq!(downs.len(), 1);
    for up in ups {
        assert!(
            up >= downs[0],
            "release at {up} before press at {}",
            downs[0]
        );
    }
}

#[test]
fn a_style_segment_that_hides_or_shows_the_cursor_gates_its_clicks() {
    let clicks = [click(1_000.0, true), click(3_000.0, true)];
    let keyboard = KeyboardEvents::default();
    let takes = [InputSoundTake {
        keyboard: &keyboard,
        keyboard_offset_secs: 0.0,
        clicks: &clicks,
    }];
    let mut project = project(
        serde_json::json!({
            "segments": [{ "start": 0.0, "end": 5.0, "timescale": 1.0, "recordingSegment": 0 }],
            "zoomSegments": []
        }),
        false,
        true,
    );
    let mut hidden = project.cursor.clone();
    hidden.hide = true;
    project.timeline.as_mut().unwrap().style_segments = vec![crate::StyleSegment {
        start: 2.0,
        end: 4.0,
        overrides: crate::StyleOverrides {
            cursor: Some(hidden),
            ..Default::default()
        },
        ..Default::default()
    }];
    let times: Vec<f64> = input_sound_events(&project, &takes)
        .iter()
        .map(|event| event.time)
        .collect();
    assert_eq!(times, vec![1.0]);

    // The other way round: hidden everywhere but shown in the segment.
    project.cursor.hide = true;
    let timeline = project.timeline.as_mut().unwrap();
    let cursor = timeline.style_segments[0]
        .overrides
        .cursor
        .as_mut()
        .unwrap();
    cursor.hide = false;
    let times: Vec<f64> = input_sound_events(&project, &takes)
        .iter()
        .map(|event| event.time)
        .collect();
    assert_eq!(times, vec![3.0]);
}
