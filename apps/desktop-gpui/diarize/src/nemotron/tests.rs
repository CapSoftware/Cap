use super::*;

/// Hears a low tone as voice 0 and a high tone as voice 1, from the
/// log-mel energy of each stacked frame; echoes the cache through.
struct Tones {
    steps: usize,
    fail_after: Option<usize>,
}

fn tone(freq: f32, secs: f32) -> Vec<f32> {
    (0..(secs * 16_000.0) as usize)
        .map(|i| (2.0 * std::f32::consts::PI * freq * i as f32 / 16_000.0).sin() * 0.3)
        .collect()
}

impl NemoModel for Tones {
    fn step(&mut self, feats: &[f32], cached: &[f32], mask: &[i64]) -> Result<StepOut, Error> {
        self.steps += 1;
        if self.fail_after.is_some_and(|n| self.steps > n) {
            return Err(Error::Model("scripted failure".into()));
        }
        let n_mel = feats.len() / N_MELS;
        let n_emb = n_mel.div_ceil(SUB);
        let n_cached = cached.len() / HIDDEN;
        assert_eq!(mask.len(), n_cached + n_emb, "mask covers cached and chunk frames");
        let mut logits = vec![-8.0f32; (n_cached + n_emb) * SUB * SPEAKERS];
        let mut chunk_embeds = vec![0.0f32; n_emb * HIDDEN];
        for f in 0..n_mel {
            let row = &feats[f * N_MELS..(f + 1) * N_MELS];
            let (bin, e) = row.iter().enumerate().fold((0, f32::MIN), |a, (i, v)| if *v > a.1 { (i, *v) } else { a });
            if e > -5.0 {
                let v = if bin < 40 { 0 } else { 1 };
                logits[((n_cached * SUB) + f) * SPEAKERS + v] = 8.0;
            }
            chunk_embeds[(f / SUB) * HIDDEN] += e / SUB as f32;
        }
        Ok(StepOut { logits, chunk_embeds, silence: vec![0.0; HIDDEN] })
    }
}

#[test]
fn each_voice_is_found_where_it_speaks_on_the_source_timeline() {
    let mut model = Tones { steps: 0, fail_after: None };
    let mut s = TrackStream::new();
    // two segments far apart in the meeting: the 75 s pause between them stays on the timeline
    s.push(&mut model, 5_000, &tone(300.0, 40.0)).unwrap();
    s.push(&mut model, 120_000, &tone(3_000.0, 35.0)).unwrap();
    s.finish(&mut model).unwrap();
    let v = &s.voices;
    // 40 s + 75 s pause + 35 s: about 15k frames (+1 padded)
    assert!((15_000..15_040).contains(&v.frames()), "{} frames", v.frames());
    let a = v.cover(5_000, 45_000);
    let b = v.cover(120_000, 155_000);
    assert!(a[0] > 39_000 && a[1] == 0, "{a:?}");
    assert!(b[1] > 34_000 && b[0] == 0, "{b:?}");
    // the gap between segments and time outside them hold nobody
    assert_eq!(v.cover(50_000, 110_000), [0; SPEAKERS]);
    assert_eq!(v.voices(), 2);
    // 150 s is 1,875 encoder frames: five full 340-frame steps and one at the end
    assert_eq!(model.steps, 6);
}

#[test]
fn turns_follow_the_voice_changes_inside_a_segment() {
    let mut model = Tones { steps: 0, fail_after: None };
    let mut s = TrackStream::new();
    let mut x = tone(300.0, 4.0);
    x.extend(tone(3_000.0, 4.0));
    s.push(&mut model, 1_000, &x).unwrap();
    s.finish(&mut model).unwrap();
    let t = s.voices.turns(1_000, 9_000);
    let first_b = t.iter().find(|(_, v)| *v == Some(1)).map(|(ms, _)| *ms).unwrap();
    assert!((4_900..5_100).contains(&first_b), "voice 1 starts at {first_b}");
}

#[test]
fn a_model_failure_leaves_no_voices_and_never_panics() {
    let runner = NemoRunner::start(Box::new(Tones { steps: 0, fail_after: Some(1) }));
    for k in 0..4 {
        runner.push(Track::System, k * 40_000, &tone(300.0, 35.0));
    }
    assert!(runner.finish().unwrap_err().contains("scripted failure"));
}

#[test]
fn the_runner_returns_both_tracks() {
    let runner = NemoRunner::start(Box::new(Tones { steps: 0, fail_after: None }));
    runner.push(Track::Mic, 0, &tone(300.0, 10.0));
    runner.push(Track::System, 0, &tone(3_000.0, 10.0));
    let [mic, sys] = runner.finish().expect("voices");
    assert!(mic.cover(0, 10_000)[0] > 9_000);
    assert!(sys.cover(0, 10_000)[1] > 9_000);
}

#[test]
fn nemotron_runs_after_stop_on_every_machine() {
    assert_eq!(Schedule::for_this_machine(), Schedule::AfterStop);
}

static STOPPED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

fn stop() {
    STOPPED.store(true, std::sync::atomic::Ordering::SeqCst);
}

/// `Tones` that fails when it is asked anything before the runner lowered
/// its priority for the after-Stop pass.
struct AfterStopOnly(Tones);

impl NemoModel for AfterStopOnly {
    fn step(&mut self, feats: &[f32], cached: &[f32], mask: &[i64]) -> Result<StepOut, Error> {
        if !STOPPED.load(std::sync::atomic::Ordering::SeqCst) {
            return Err(Error::Model("ran during the recording".into()));
        }
        self.0.step(feats, cached, mask)
    }
}

fn meeting(runner: &NemoRunner) {
    for k in 0..3u64 {
        runner.push(Track::Mic, k * 50_000, &tone(300.0, 20.0));
        runner.push(Track::System, k * 50_000 + 20_000, &tone(3_000.0, 25.0));
    }
    runner.push(Track::Mic, 160_000, &tone(3_000.0, 12.0));
}

#[test]
fn after_stop_hears_nothing_while_recording_then_exactly_what_live_hears() {
    let live = NemoRunner::start(Box::new(Tones { steps: 0, fail_after: None }));
    meeting(&live);
    let live = live.finish().expect("live voices");

    let later = NemoRunner::start_with(Box::new(AfterStopOnly(Tones { steps: 0, fail_after: None })), Schedule::AfterStop, stop);
    assert_eq!(later.schedule(), Schedule::AfterStop);
    let spool = later.spool_path().expect("a speech file").to_path_buf();
    meeting(&later);
    let voices = later.finish_later().recv().expect("an answer").expect("after-Stop voices");
    assert!(STOPPED.load(std::sync::atomic::Ordering::SeqCst), "the pass lowered its priority first");
    for (a, b) in live.iter().zip(&voices) {
        assert_eq!(a.raw(), b.raw(), "same frames, bit for bit");
        assert_eq!(a.parts(), b.parts());
        assert!(a.voices() > 0);
    }
    assert!(!spool.exists(), "the speech file is gone once the pass is done");
}

#[test]
fn an_after_stop_runner_dropped_unfinished_leaves_no_file() {
    let runner = NemoRunner::start_with(Box::new(Tones { steps: 0, fail_after: None }), Schedule::AfterStop, || {});
    let spool = runner.spool_path().expect("a speech file").to_path_buf();
    assert!(spool.exists());
    runner.push(Track::Mic, 0, &tone(300.0, 5.0));
    // a meeting that never reached its final pass: the worker ends when its channel closes
    drop(runner);
    for _ in 0..500 {
        if !spool.exists() {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    assert!(!spool.exists());
}

#[test]
fn an_after_stop_model_failure_is_an_answer_not_a_hang() {
    let runner = NemoRunner::start_with(Box::new(Tones { steps: 0, fail_after: Some(1) }), Schedule::AfterStop, || {});
    for k in 0..4 {
        runner.push(Track::System, k * 40_000, &tone(300.0, 35.0));
    }
    let answer = runner.finish_later().recv().expect("an answer");
    assert!(answer.unwrap_err().contains("scripted failure"));
}

#[test]
fn spools_whose_process_is_gone_are_cleared_but_not_running_ones() {
    let dir = std::env::temp_dir().join(format!("cap-nemotron-stale-test-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    // pid 1 quit, pid 2 still runs (a second Cap in a long silent meeting)
    let quit = dir.join("cap-nemotron-1-0-00ff.f32");
    let running = dir.join("cap-nemotron-2-0-00ff.f32");
    let abandoned = dir.join("cap-nemotron-3-0-00ff.f32");
    let own = dir.join("cap-nemotron-7-0-00ff.f32");
    let other = dir.join("notes-1-0.f32");
    let odd = dir.join("cap-nemotron-x-0.f32");
    for f in [&quit, &running, &abandoned, &own, &other, &odd] {
        std::fs::write(f, b"x").unwrap();
    }
    let hours_ago = |h: u64| std::time::SystemTime::now() - std::time::Duration::from_secs(h * 3_600);
    for f in [&running, &own, &other, &odd] {
        std::fs::File::options().write(true).open(f).unwrap().set_modified(hours_ago(5)).unwrap();
    }
    std::fs::File::options().write(true).open(&abandoned).unwrap().set_modified(hours_ago(25)).unwrap();

    let alive = |pid| pid != 1;
    assert_eq!(remove_stale_spools(&dir, 7, alive), 2);
    assert!(!quit.exists(), "a spool whose process is gone goes, however new");
    assert!(running.exists(), "a running process's spool stays");
    assert!(!abandoned.exists(), "a day-old spool goes even if its pid runs");
    assert!(own.exists(), "this process's spools stay");
    assert!(other.exists() && odd.exists(), "other files stay");
    std::fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn the_speech_spool_is_private_and_named_unguessably() {
    let spool = Spool::create().unwrap();
    let name = spool.path.file_name().unwrap().to_string_lossy().into_owned();
    let own = format!("cap-nemotron-{}-", std::process::id());
    assert!(name.starts_with(&own) && name.ends_with(".f32"), "{name}");
    assert!(name.len() > own.len() + 20, "a random part follows the pid: {name}");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(&spool.path).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600);
    }
    let path = spool.path.clone();
    drop(spool);
    assert!(!path.exists());
}

#[test]
fn a_spool_never_writes_over_a_file_already_there() {
    let dir = tempfile::tempdir().unwrap();
    let taken = dir.path().join("cap-nemotron-1-0-taken.f32");
    std::fs::write(&taken, "keep").unwrap();
    let error = open_private(&taken).unwrap_err();
    assert_eq!(error.kind(), std::io::ErrorKind::AlreadyExists);
    assert_eq!(std::fs::read_to_string(&taken).unwrap(), "keep");
}

#[cfg(unix)]
#[test]
fn a_spool_never_follows_a_link_left_at_its_path() {
    let dir = tempfile::tempdir().unwrap();
    let target = dir.path().join("someone-elses-file");
    std::fs::write(&target, "keep").unwrap();
    let link = dir.path().join("cap-nemotron-1-0-link.f32");
    std::os::unix::fs::symlink(&target, &link).unwrap();
    assert!(open_private(&link).is_err());
    assert_eq!(std::fs::read_to_string(&target).unwrap(), "keep");
}

/// Tones, keeping a fingerprint of everything each step was given.
struct Heard {
    tones: Tones,
    inputs: Vec<u64>,
}

impl NemoModel for Heard {
    fn step(&mut self, feats: &[f32], cached: &[f32], mask: &[i64]) -> Result<StepOut, Error> {
        use std::hash::{Hash, Hasher};
        let mut h = std::collections::hash_map::DefaultHasher::new();
        for x in feats.iter().chain(cached) {
            x.to_bits().hash(&mut h);
        }
        mask.hash(&mut h);
        self.inputs.push(h.finish());
        self.tones.step(feats, cached, mask)
    }
}

#[test]
fn a_long_pause_is_fed_in_pieces_and_heard_exactly_as_in_one() {
    let run = |gap_piece| {
        let mut model = Heard { tones: Tones { steps: 0, fail_after: None }, inputs: Vec::new() };
        let mut s = TrackStream::new();
        s.gap_piece = gap_piece;
        s.push(&mut model, 0, &tone(300.0, 10.0)).unwrap();
        // four minutes of nobody, then the other voice
        s.push(&mut model, 250_000, &tone(3_000.0, 10.0)).unwrap();
        let peak = s.feats.capacity();
        s.finish(&mut model).unwrap();
        (model.inputs, s.voices.probs, peak)
    };
    let (whole_inputs, whole_probs, whole_peak) = run(usize::MAX);
    let (piece_inputs, piece_probs, piece_peak) = run(GAP_PIECE);
    assert_eq!(piece_inputs, whole_inputs, "the model was given something else");
    assert_eq!(piece_probs, whole_probs);
    // four minutes of features is 24k frames; in pieces, two steps' worth
    assert!(whole_peak >= 24_000 * N_MELS, "{whole_peak}");
    assert!(piece_peak < whole_peak / 2, "{piece_peak} vs {whole_peak}");
}
