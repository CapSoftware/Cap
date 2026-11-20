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
fn spools_a_quit_left_behind_are_cleared_but_not_fresh_or_own_ones() {
    let dir = std::env::temp_dir().join(format!("cap-nemotron-stale-test-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let old = dir.join("cap-nemotron-1-0.f32");
    let fresh = dir.join("cap-nemotron-2-0.f32");
    let own = dir.join("cap-nemotron-7-0.f32");
    let other = dir.join("notes-1-0.f32");
    for f in [&old, &fresh, &own, &other] {
        std::fs::write(f, b"x").unwrap();
    }
    let hour_ago = std::time::SystemTime::now() - std::time::Duration::from_secs(3_600);
    for f in [&old, &own, &other] {
        std::fs::File::options().write(true).open(f).unwrap().set_modified(hour_ago).unwrap();
    }
    assert_eq!(remove_stale_spools(&dir, 7), 1);
    assert!(!old.exists());
    assert!(fresh.exists(), "a spool still being written stays");
    assert!(own.exists(), "this process's spools stay");
    assert!(other.exists(), "other files stay");
    std::fs::remove_dir_all(&dir).unwrap();
}
