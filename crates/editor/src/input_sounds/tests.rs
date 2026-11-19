use super::*;
use cap_project::{CursorClickEvent, KeyPressEvent, KeyboardData, KeyboardSettings};

fn rms_db(samples: &[f32]) -> f32 {
    let energy = samples.iter().map(|sample| sample * sample).sum::<f32>() / samples.len() as f32;
    10.0 * energy.max(1e-20).log10()
}

#[test]
fn every_pack_decodes_with_each_stroke_on_its_onset() {
    for id in PackId::ALL {
        let bank = decoded(id).expect("pack decodes");
        let pack = id.pack();
        assert!(bank.len() >= pack.frames as usize);
        let mut spans = 0;
        for (slot, strokes) in pack.strokes.iter().enumerate() {
            for stroke in strokes.iter() {
                for (offset, len) in std::iter::once(stroke.down).chain(stroke.up) {
                    let (offset, len) = (offset as usize, len as usize);
                    assert!(offset + len <= bank.len());
                    let before = rms_db(&bank[offset - 480..offset - 48]);
                    let attack = rms_db(&bank[offset..offset + 480.min(len)]);
                    assert!(
                        attack - before > 20.0,
                        "pack {} slot {slot} at {offset}: attack {attack:.1} dB, before {before:.1} dB",
                        id.index()
                    );
                    assert!(bank[offset..offset + len].iter().all(|s| s.abs() < 1.0));
                    spans += 1;
                }
            }
        }
        assert!(spans >= 12, "pack {} has {spans} sounds", id.index());
        let keys = !pack.strokes[CLICK].is_empty();
        assert_eq!(keys, matches!(id, PackId::Mouse | PackId::Trackpad));
        assert!(pack.strokes[LETTER].len() >= 4 || keys);
    }
}

fn key_project(volume: f32) -> ProjectConfiguration {
    let mut project: ProjectConfiguration = serde_json::from_value(serde_json::json!({
        "timeline": {
            "segments": [
                { "start": 0.0, "end": 4.0, "timescale": 1.0, "recordingSegment": 0 },
                { "start": 6.0, "end": 8.0, "timescale": 2.0, "recordingSegment": 0 }
            ],
            "zoomSegments": [],
            "keyboardSegments": [
                { "id": "a", "start": 0.0, "end": 9.0, "displayText": "x" }
            ]
        }
    }))
    .unwrap();
    project.keyboard = Some(KeyboardData {
        settings: KeyboardSettings {
            enabled: true,
            key_sounds: true,
            key_sound_volume: volume,
            ..Default::default()
        },
    });
    project.cursor.click_sounds = true;
    project.cursor.click_sound_volume = volume;
    project
}

fn typing() -> (cap_project::KeyboardEvents, Vec<CursorClickEvent>) {
    let keys = [
        "A",
        "S",
        "Space",
        "D",
        "D",
        "D",
        "Enter",
        "Backspace",
        "LShift",
        "K",
    ];
    let presses = (0..60)
        .flat_map(|index| {
            let key = keys[index % keys.len()];
            let ms = 200.0 + index as f64 * 120.0;
            [true, false].map(|down| KeyPressEvent {
                key: key.into(),
                key_code: key.into(),
                time_ms: if down { ms } else { ms + 70.0 },
                down,
            })
        })
        .collect();
    let clicks = (0..10)
        .flat_map(|index| {
            let ms = 300.0 + index as f64 * 700.0;
            [true, false].map(|down| CursorClickEvent {
                active_modifiers: Vec::new(),
                cursor_num: 0,
                cursor_id: "0".into(),
                time_ms: if down { ms } else { ms + 90.0 },
                down,
            })
        })
        .collect();
    (cap_project::KeyboardEvents { presses }, clicks)
}

fn sounds(project: &ProjectConfiguration) -> Option<Arc<InputSounds>> {
    let (keyboard, clicks) = typing();
    InputSounds::new(
        project,
        &[InputSoundTake {
            keyboard: &keyboard,
            keyboard_offset_secs: 0.0,
            clicks: &clicks,
        }],
    )
}

#[test]
fn nothing_is_built_when_both_toggles_are_off() {
    let mut project = key_project(0.6);
    project.keyboard.as_mut().unwrap().settings.key_sounds = false;
    project.cursor.click_sounds = false;
    assert!(sounds(&project).is_none());
    assert!(sounds(&ProjectConfiguration::default()).is_none());
    project.keyboard.as_mut().unwrap().settings.key_sounds = true;
    project.keyboard.as_mut().unwrap().settings.key_sound_volume = 0.0;
    project.cursor.click_sound_volume = 0.0;
    assert!(sounds(&project).is_none());
}

#[test]
fn block_mixing_matches_one_pass_and_is_repeatable() {
    let project = key_project(0.8);
    let first = sounds(&project).unwrap();
    let second = sounds(&project).unwrap();
    assert_eq!(first.fingerprint(), second.fingerprint());
    let frames = 48_000 * 9;
    let mut whole = vec![0.0; frames * 2];
    first.mix(&mut whole, 0);
    let mut blocks = vec![0.0; frames * 2];
    let mut position = 0;
    for size in [1usize, 7, 480, 1024, 4095, 333].iter().cycle() {
        if position >= frames {
            break;
        }
        let count = (*size).min(frames - position);
        second.mix(&mut blocks[position * 2..(position + count) * 2], position);
        position += count;
    }
    assert!(
        whole
            .iter()
            .zip(&blocks)
            .all(|(a, b)| a.to_bits() == b.to_bits())
    );
    assert!(whole.iter().any(|sample| *sample != 0.0));
    assert!(whole.iter().all(|sample| sample.abs() < 1.0));
}

#[test]
fn sounds_start_on_the_press_sample() {
    let project = key_project(1.0);
    let sounds = sounds(&project).unwrap();
    let mut output = vec![0.0; 48_000 * 9 * 2];
    sounds.mix(&mut output, 0);
    let first = output.iter().position(|sample| *sample != 0.0).unwrap() / 2;
    assert_eq!(first, (0.2 * 48_000.0) as usize);
    let sped_press: f64 = 4.0 + (0.2 + 50.0 * 0.12 - 6.0) / 2.0;
    let frame = (sped_press * 48_000.0).round() as usize;
    assert!(sounds.voices.iter().any(|voice| voice.start == frame));
    assert!(
        !sounds
            .voices
            .iter()
            .any(|voice| voice.start > 4 * 48_000 - 100 && voice.start < 4 * 48_000 - 10)
    );
}

#[test]
fn repeated_keys_never_repeat_a_recording_back_to_back() {
    let project = key_project(0.6);
    let sounds = sounds(&project).unwrap();
    let downs: Vec<&Voice> = sounds
        .voices
        .iter()
        .filter(|voice| voice.pack == PackId::Mechanical)
        .collect();
    assert!(downs.len() > 50);
    let letters: std::collections::HashSet<u32> = packs::MECHANICAL.strokes[LETTER]
        .iter()
        .map(|stroke| stroke.down.0)
        .collect();
    let letter_downs: Vec<u32> = downs
        .iter()
        .map(|voice| voice.offset)
        .filter(|offset| letters.contains(offset))
        .collect();
    assert!(letter_downs.windows(2).all(|pair| pair[0] != pair[1]));
    assert!(
        letter_downs
            .iter()
            .collect::<std::collections::HashSet<_>>()
            .len()
            > 5
    );
    let steps: std::collections::HashSet<u32> =
        downs.iter().map(|voice| voice.step.to_bits()).collect();
    assert!(steps.len() > 20);
}

#[test]
fn volume_scales_and_type_switches_packs() {
    let quiet = sounds(&key_project(0.3)).unwrap();
    let loud = sounds(&key_project(0.9)).unwrap();
    let peak = |sounds: &InputSounds| {
        let mut output = vec![0.0; 48_000 * 9 * 2];
        sounds.mix(&mut output, 0);
        output
            .iter()
            .fold(0.0f32, |peak, sample| peak.max(sample.abs()))
    };
    let ratio = peak(&loud) / peak(&quiet);
    assert!((ratio - 9.0).abs() < 0.5, "{ratio}");

    let mut project = key_project(0.6);
    project.keyboard.as_mut().unwrap().settings.key_sound_type = KeySoundType::Typewriter;
    project.cursor.click_sound_type = ClickSoundType::Trackpad;
    let switched = sounds(&project).unwrap();
    assert!(
        switched
            .voices
            .iter()
            .all(|voice| matches!(voice.pack, PackId::Typewriter | PackId::Trackpad))
    );
    assert_ne!(switched.fingerprint(), loud.fingerprint());
}

#[test]
fn previews_render_every_pack() {
    for preview in [
        InputSoundPreview::Keys(KeySoundType::Mechanical),
        InputSoundPreview::Keys(KeySoundType::Deep),
        InputSoundPreview::Keys(KeySoundType::Laptop),
        InputSoundPreview::Keys(KeySoundType::Typewriter),
        InputSoundPreview::Clicks(ClickSoundType::Mouse),
        InputSoundPreview::Clicks(ClickSoundType::Trackpad),
    ] {
        let audio = render_input_sound_preview(preview, 1.0).unwrap();
        assert!(audio.len() > 48_000, "{preview:?}");
        assert!(audio.iter().all(|sample| sample.abs() < 1.0), "{preview:?}");
    }
    assert!(render_input_sound_preview(InputSoundPreview::Keys(KeySoundType::Deep), 0.0).is_none());
}

#[test]
fn cubic_interpolation_hits_the_samples_it_passes_through() {
    let samples = [0.0, 0.5, -0.25, 1.0, 0.0];
    for (index, sample) in samples.iter().enumerate() {
        assert_eq!(cubic(&samples, index as f32), *sample);
    }
    assert!(cubic(&samples, 10.0).abs() <= 1.0);
}
