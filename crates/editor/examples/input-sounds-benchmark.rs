use cap_editor::{AudioRenderer, AudioSegment, InputSounds, create_segments, get_audio_segments};
use cap_project::{
    ClickSoundType, KeySoundType, KeyboardData, ProjectConfiguration, RecordingMeta,
};
use std::{
    io::Write,
    path::{Path, PathBuf},
    sync::Arc,
    time::{Duration, Instant},
};

const BLOCK: usize = 1024;

fn render(
    segments: &[AudioSegment],
    project: &ProjectConfiguration,
    sounds: Option<Option<Arc<InputSounds>>>,
) -> (Vec<f32>, Vec<Duration>) {
    let renderer = AudioRenderer::new(segments.to_vec());
    let mut renderer = match sounds {
        Some(sounds) => renderer.with_input_sounds(sounds),
        None => renderer,
    };
    renderer.set_playhead(0.0, project);
    let mut output = Vec::new();
    let mut timings = Vec::new();
    loop {
        let started = Instant::now();
        let Some((_, block)) = renderer.render_frame_raw(BLOCK, project) else {
            break;
        };
        timings.push(started.elapsed());
        output.extend_from_slice(&block);
    }
    (output, timings)
}

fn write_wav(path: &Path, samples: &[f32]) {
    let data_bytes = (samples.len() * 4) as u32;
    let mut file = std::io::BufWriter::new(std::fs::File::create(path).unwrap());
    file.write_all(b"RIFF").unwrap();
    file.write_all(&(36 + data_bytes).to_le_bytes()).unwrap();
    file.write_all(b"WAVEfmt ").unwrap();
    file.write_all(&16u32.to_le_bytes()).unwrap();
    file.write_all(&3u16.to_le_bytes()).unwrap();
    file.write_all(&2u16.to_le_bytes()).unwrap();
    file.write_all(&48_000u32.to_le_bytes()).unwrap();
    file.write_all(&(48_000u32 * 8).to_le_bytes()).unwrap();
    file.write_all(&8u16.to_le_bytes()).unwrap();
    file.write_all(&32u16.to_le_bytes()).unwrap();
    file.write_all(b"data").unwrap();
    file.write_all(&data_bytes.to_le_bytes()).unwrap();
    for sample in samples {
        file.write_all(&sample.to_le_bytes()).unwrap();
    }
}

fn stats(label: &str, timings: &[Duration]) {
    let mut micros: Vec<f64> = timings
        .iter()
        .map(|time| time.as_secs_f64() * 1e6)
        .collect();
    micros.sort_by(f64::total_cmp);
    let mean = micros.iter().sum::<f64>() / micros.len() as f64;
    let at = |q: f64| micros[((micros.len() - 1) as f64 * q) as usize];
    println!(
        "{label:<28} blocks={:>5} mean={mean:>7.2}us p50={:>7.2}us p99={:>7.2}us max={:>7.2}us total={:>7.2}ms",
        micros.len(),
        at(0.5),
        at(0.99),
        micros.last().unwrap(),
        micros.iter().sum::<f64>() / 1000.0,
    );
}

fn with_sounds(
    project: &ProjectConfiguration,
    keys: Option<KeySoundType>,
    clicks: Option<ClickSoundType>,
) -> ProjectConfiguration {
    let mut project = project.clone();
    let keyboard = project.keyboard.get_or_insert_with(KeyboardData::default);
    keyboard.settings.key_sounds = keys.is_some();
    keyboard.settings.key_sound_type = keys.unwrap_or_default();
    project.cursor.click_sounds = clicks.is_some();
    project.cursor.click_sound_type = clicks.unwrap_or_default();
    project
}

#[tokio::main]
async fn main() {
    ffmpeg::init().unwrap();
    let mut args = std::env::args_os().skip(1);
    let project_path = PathBuf::from(args.next().expect("project path"));
    let out = PathBuf::from(args.next().expect("output directory"));
    std::fs::create_dir_all(&out).unwrap();

    let meta = RecordingMeta::load_for_project(&project_path).unwrap();
    let studio = meta.studio_meta().unwrap().clone();
    let mut base = ProjectConfiguration::load(&project_path).unwrap();
    cap_project::synchronize_legacy_keyboard(&meta, &mut base);
    let media = create_segments(&meta, &studio, false).await.unwrap();
    let segments = get_audio_segments(&media).await;
    let off = with_sounds(&base, None, None);

    let started = Instant::now();
    let cold = InputSounds::for_segments(
        &with_sounds(
            &base,
            Some(KeySoundType::Mechanical),
            Some(ClickSoundType::Mouse),
        ),
        &media,
    )
    .unwrap();
    let cold_build = started.elapsed();
    let started = Instant::now();
    let warm = InputSounds::for_segments(
        &with_sounds(
            &base,
            Some(KeySoundType::Mechanical),
            Some(ClickSoundType::Mouse),
        ),
        &media,
    )
    .unwrap();
    let warm_build = started.elapsed();
    println!(
        "build: first {:.2}ms (decodes two packs), again {:.3}ms, {} sounds",
        cold_build.as_secs_f64() * 1e3,
        warm_build.as_secs_f64() * 1e3,
        warm.len()
    );
    drop(cold);

    let (main_like, main_timings) = render(&segments, &off, None);
    let off_sounds = InputSounds::for_segments(&off, &media);
    assert!(off_sounds.is_none());
    let (toggles_off, off_timings) = render(&segments, &off, Some(off_sounds));
    let identical = main_like.len() == toggles_off.len()
        && main_like
            .iter()
            .zip(&toggles_off)
            .all(|(a, b)| a.to_bits() == b.to_bits());
    println!(
        "toggles off vs no input sounds: {} samples, byte identical: {identical}",
        main_like.len()
    );
    assert!(identical);
    stats("render, sounds off", &main_timings);
    stats("render, toggles off", &off_timings);

    let on = with_sounds(
        &base,
        Some(KeySoundType::Mechanical),
        Some(ClickSoundType::Mouse),
    );
    let (combined, on_timings) = render(&segments, &on, Some(Some(warm.clone())));
    stats("render, keys + clicks on", &on_timings);
    write_wav(&out.join("keys-mechanical-and-mouse-clicks.wav"), &combined);

    let frames = combined.len() / 2;
    let mut block = vec![0.0f32; BLOCK * 2];
    let mut mix_timings = Vec::new();
    for _ in 0..20 {
        let mut position = 0;
        while position < frames {
            block.fill(0.0);
            let started = Instant::now();
            warm.mix(&mut block, position);
            mix_timings.push(started.elapsed());
            position += BLOCK;
        }
    }
    stats("mix only, 1024 frames", &mix_timings);

    for kind in [
        KeySoundType::Mechanical,
        KeySoundType::Deep,
        KeySoundType::Laptop,
        KeySoundType::Typewriter,
    ] {
        let project = with_sounds(&base, Some(kind), None);
        let sounds = InputSounds::for_segments(&project, &media);
        let (audio, _) = render(&segments, &project, Some(sounds));
        let name = format!("keys-{}.wav", format!("{kind:?}").to_lowercase());
        write_wav(&out.join(&name), &audio);
        println!("wrote {name}");
    }
    for kind in [ClickSoundType::Mouse, ClickSoundType::Trackpad] {
        let project = with_sounds(&base, None, Some(kind));
        let sounds = InputSounds::for_segments(&project, &media);
        let (audio, _) = render(&segments, &project, Some(sounds));
        let name = format!("clicks-{}.wav", format!("{kind:?}").to_lowercase());
        write_wav(&out.join(&name), &audio);
        println!("wrote {name}");
    }
}
