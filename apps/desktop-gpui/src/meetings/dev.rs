use std::time::{Duration, Instant};

use gpui::{App, AsyncApp};
use serde_json::json;

use super::{Meetings, StartSource, StopReason};

fn env_u64(name: &str) -> Option<u64> {
    std::env::var(name).ok().and_then(|v| v.trim().parse().ok())
}

fn process_usage() -> (f64, u64) {
    #[cfg(unix)]
    unsafe {
        let mut usage = std::mem::zeroed::<libc::rusage>();
        if libc::getrusage(libc::RUSAGE_SELF, &mut usage) == 0 {
            let cpu = usage.ru_utime.tv_sec as f64
                + usage.ru_utime.tv_usec as f64 / 1e6
                + usage.ru_stime.tv_sec as f64
                + usage.ru_stime.tv_usec as f64 / 1e6;
            let peak = if cfg!(target_os = "macos") {
                usage.ru_maxrss as u64
            } else {
                usage.ru_maxrss as u64 * 1024
            };
            return (cpu, peak);
        }
    }
    (0.0, 0)
}

async fn sleep(cx: &mut AsyncApp, duration: Duration) {
    cx.background_executor().timer(duration).await;
}

fn epoch_ms() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_millis())
}

// The system tap is a global process tap, so audio another process plays into
// a loopback "microphone" also lands on the system track, and no process this
// harness can launch on the test Mac holds a microphone grant. The microphone
// side is therefore fed through the same capture thread from these batches,
// paced in real time with capture timestamps the way the feed delivers them.
fn feed_mic_script(
    script: String,
    tx: flume::Sender<super::capture::RawBatch>,
    marks: Option<String>,
) {
    use std::io::Write;

    const RATE: u64 = 48_000;
    const BATCH: u64 = 480;
    let mut log = marks.and_then(|path| {
        std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
            .ok()
    });
    let t0 = epoch_ms();
    if let Some(log) = log.as_mut() {
        let _ = writeln!(log, "t0 {t0}");
    }
    // A clip scheduled several times (long soaks) is held once, so the
    // harness does not inflate the memory it is used to measure.
    let mut loaded: std::collections::HashMap<String, std::sync::Arc<Vec<f32>>> =
        std::collections::HashMap::new();
    let mut timeline: Vec<(u64, std::sync::Arc<Vec<f32>>, String)> = Vec::new();
    for line in std::fs::read_to_string(&script).unwrap_or_default().lines() {
        let mut parts = line.split_whitespace();
        let (Some(offset), Some(path)) = (parts.next(), parts.next()) else {
            continue;
        };
        let Ok(offset) = offset.parse::<u64>() else {
            continue;
        };
        let samples = match loaded.get(path) {
            Some(samples) => samples.clone(),
            None => {
                let Ok(bytes) = std::fs::read(path) else {
                    continue;
                };
                let samples = std::sync::Arc::new(
                    bytes
                        .as_chunks::<4>()
                        .0
                        .iter()
                        .map(|b| f32::from_le_bytes(*b))
                        .collect::<Vec<f32>>(),
                );
                loaded.insert(path.to_string(), samples.clone());
                samples
            }
        };
        timeline.push((offset * RATE / 1000, samples, path.to_string()));
    }
    let end = timeline
        .iter()
        .map(|(at, samples, _)| at + samples.len() as u64)
        .max()
        .unwrap_or(0)
        + RATE;
    let start = Instant::now();
    let mut sent = 0u64;
    let mut next_clip = 0usize;
    let mut cursor = 0usize;
    for _ in 0..end.div_ceil(BATCH) {
        let due = start + Duration::from_micros((sent + BATCH) * 1_000_000 / RATE);
        std::thread::sleep(due.saturating_duration_since(Instant::now()));
        let mut data = Vec::with_capacity(BATCH as usize * 4);
        for n in sent..sent + BATCH {
            while cursor < timeline.len()
                && timeline[cursor].0 + timeline[cursor].1.len() as u64 <= n
            {
                cursor += 1;
            }
            let value = timeline
                .get(cursor)
                .filter(|(at, _, _)| n >= *at)
                .map_or(0.0, |(at, samples, _)| samples[(n - at) as usize]);
            let pcm = (value.clamp(-1.0, 1.0) * 32_767.0) as i16;
            data.extend_from_slice(&pcm.to_ne_bytes());
            data.extend_from_slice(&pcm.to_ne_bytes());
        }
        while next_clip < timeline.len() && timeline[next_clip].0 < sent + BATCH {
            if let Some(log) = log.as_mut() {
                let at = t0 + u128::from(timeline[next_clip].0 * 1000 / RATE);
                let _ = writeln!(log, "{at} you {}", timeline[next_clip].2);
            }
            next_clip += 1;
        }
        let batch = super::capture::RawBatch {
            data,
            format: cpal::SampleFormat::I16,
            sample_rate: RATE as u32,
            channels: 2,
            captured: start + Duration::from_micros(sent * 1_000_000 / RATE),
        };
        if tx.send(batch).is_err() {
            return;
        }
        sent += BATCH;
    }
}

pub fn run_from_env(cx: &mut App) {
    let Some(seconds) = env_u64("CAP_GPUI_AUTO_MEETING") else {
        return;
    };
    let Some(meetings) = Meetings::try_global(cx) else {
        tracing::error!("CAP_GPUI_AUTO_MEETING: the meeting service is not initialised");
        return;
    };
    let cycles = env_u64("CAP_GPUI_AUTO_MEETING_CYCLES").unwrap_or(1).max(1);
    let linger = env_u64("CAP_GPUI_AUTO_MEETING_LINGER").unwrap_or(0);
    let out = std::env::var("CAP_GPUI_AUTO_MEETING_OUT").ok();
    meetings.update(cx, |m, cx| m.enable_in_memory(cx));
    cx.spawn(async move |cx| {
        sleep(cx, Duration::from_secs(2)).await;
        let mut last_doc = None;
        let mut before_stop = json!(null);
        let started = Instant::now();
        for cycle in 0..cycles {
            let script = std::env::var("CAP_GPUI_AUTO_MEETING_MIC_SCRIPT")
                .ok()
                .filter(|_| cycle == 0);
            let feed = script.as_ref().map(|_| flume::bounded(256));
            let doc = cx.update(|cx| {
                meetings.update(cx, |m, cx| {
                    m.dev_mic = feed.as_ref().map(|(_, rx)| rx.clone());
                    m.start_recording(StartSource::Manual, cx)
                })
            });
            let doc = match doc {
                Ok(doc) => doc,
                Err(error) => {
                    tracing::error!(%error, cycle, "CAP_GPUI_AUTO_MEETING: start failed");
                    break;
                }
            };
            tracing::info!(doc, cycle, "CAP_GPUI_AUTO_MEETING: recording");
            if let (Some(script), Some((tx, _))) = (script, feed) {
                let marks = std::env::var("CAP_GPUI_AUTO_MEETING_MARKS").ok();
                std::thread::spawn(move || feed_mic_script(script, tx, marks));
            }
            // CAP_GPUI_AUTO_MEETING_SLEEP=<at_s>:<secs>[:resume] runs the
            // computer's sleep and wake handlers once, `secs` apart, and
            // takes the Resume offer if asked.
            if let Some((at, secs, take)) = std::env::var("CAP_GPUI_AUTO_MEETING_SLEEP")
                .ok()
                .filter(|_| cycle == 0)
                .and_then(|v| {
                    let mut parts = v.split(':');
                    let at = parts.next()?.parse::<u64>().ok()?;
                    let secs = parts.next()?.parse::<u64>().ok()?;
                    Some((at, secs, parts.next() == Some("resume")))
                })
            {
                cx.spawn(async move |cx| {
                    sleep(cx, Duration::from_secs(at)).await;
                    tracing::info!("CAP_GPUI_AUTO_MEETING: going to sleep");
                    cx.update(Meetings::system_will_sleep);
                    sleep(cx, Duration::from_secs(secs)).await;
                    cx.update(Meetings::system_did_wake);
                    let state = cx.update(|cx| {
                        Meetings::try_global(cx)
                            .and_then(|m| m.read(cx).active().map(|a| format!("{:?}", a.state)))
                    });
                    tracing::info!(?state, "CAP_GPUI_AUTO_MEETING: woke");
                    if take {
                        sleep(cx, Duration::from_secs(2)).await;
                        cx.update(|cx| {
                            if let Some(m) = Meetings::try_global(cx) {
                                m.update(cx, |m, cx| m.resume(cx));
                            }
                        });
                        let recording =
                            cx.update(|cx| Meetings::try_global(cx).map(|m| m.read(cx).is_recording()));
                        tracing::info!(?recording, "CAP_GPUI_AUTO_MEETING: resumed");
                    }
                })
                .detach();
            }
            // CAP_GPUI_AUTO_MEETING_STOP_FILE=<path>: the meeting's length
            // counts from when the scripted call says it started playing (a
            // `started ` line there), so a slow call page never cuts it short.
            if let Some(path) = std::env::var("CAP_GPUI_AUTO_MEETING_STOP_FILE")
                .ok()
                .filter(|_| cycle == 0)
            {
                let waited = Instant::now();
                while waited.elapsed() < Duration::from_secs(120)
                    && !std::fs::read_to_string(&path)
                        .is_ok_and(|s| s.lines().any(|l| l.starts_with("started ")))
                {
                    sleep(cx, Duration::from_millis(200)).await;
                }
                tracing::info!(
                    waited_ms = waited.elapsed().as_millis() as u64,
                    "CAP_GPUI_AUTO_MEETING: the stop clock starts with the call"
                );
            }
            sleep(cx, Duration::from_secs(seconds)).await;
            before_stop = cx.update(|cx| {
                let m = meetings.read(cx);
                json!({
                    "active": m.active().map(|a| json!({
                        "mic": { "health": format!("{:?}", a.mic.health), "speechMs": a.mic.speech_ms, "level": a.mic.level, "droppedBatches": a.mic.dropped_batches, "droppedSegments": a.mic.dropped_segments },
                        "system": { "health": format!("{:?}", a.system.health), "speechMs": a.system.speech_ms, "level": a.system.level, "droppedBatches": a.system.dropped_batches, "droppedSegments": a.system.dropped_segments },
                        "engine": format!("{:?}", a.engine),
                    })),
                    "captureStats": m.capture_stats(),
                })
            });
            cx.update(|cx| meetings.update(cx, |m, cx| m.stop_recording(StopReason::User, cx)));
            let drain_started = Instant::now();
            while cx.update(|cx| meetings.read(cx).is_finishing(&doc)) {
                sleep(cx, Duration::from_millis(100)).await;
            }
            tracing::info!(
                doc,
                cycle,
                drain_ms = drain_started.elapsed().as_millis() as u64,
                "CAP_GPUI_AUTO_MEETING: drained"
            );
            last_doc = Some((doc, drain_started.elapsed().as_millis() as u64));
        }
        if linger > 0 {
            tracing::info!(pid = std::process::id(), linger, "CAP_GPUI_AUTO_MEETING: lingering");
            sleep(cx, Duration::from_secs(linger)).await;
        }
        let summary = cx.update(|cx| {
            meetings.update(cx, |m, _| {
                let (cpu, peak) = process_usage();
                let Some((doc, drain_ms)) = last_doc.clone() else {
                    return json!({ "error": "no recording", "cpuSeconds": cpu, "peakRssBytes": peak });
                };
                let dir = m
                    .library()
                    .and_then(|l| l.doc_dir(&doc).ok())
                    .map(|d| d.display().to_string());
                let meta = m.library().and_then(|l| l.load(&doc).ok());
                let transcript = m.transcript(&doc).map(|t| t.into_owned()).unwrap_or_default();
                let text = transcript.to_plain_text(&cap_meetings::transcript::Header::default());
                let stats = transcript.stats();
                let utterances: Vec<_> = transcript
                    .utterances()
                    .iter()
                    .map(|u| json!({
                        "id": u.id,
                        "source": u.source,
                        "startMs": u.start_ms,
                        "endMs": u.end_ms,
                        "text": u.text,
                        "final": u.is_final,
                    }))
                    .collect();
                json!({
                    "docId": doc,
                    "docDir": dir,
                    "cycles": cycles,
                    "secondsPerCycle": seconds,
                    "elapsedMs": started.elapsed().as_millis() as u64,
                    "drainMs": drain_ms,
                    "startedAt": meta.as_ref().and_then(|m| m.meeting.as_ref()).and_then(|m| m.started_at),
                    "durationMs": meta.as_ref().and_then(|m| m.meeting.as_ref()).map(|m| m.duration_ms),
                    "engine": meta.as_ref().and_then(|m| m.meeting.as_ref()).and_then(|m| m.engine.clone()),
                    "audio": meta.as_ref().and_then(|m| m.meeting.as_ref()).map(|m| m.audio.iter().map(|a| json!({"file": a.file, "durationMs": a.duration_ms})).collect::<Vec<_>>()),
                    "micSpeechMs": stats.mic_speech_ms,
                    "systemSpeechMs": stats.system_speech_ms,
                    "utteranceCount": stats.utterances,
                    "transcriptStart": text.chars().take(400).collect::<String>(),
                    "utterances": utterances,
                    "beforeStop": before_stop,
                    "peakRssBytes": peak,
                    "cpuSeconds": cpu,
                })
            })
        });
        let text = serde_json::to_string_pretty(&summary).unwrap_or_default();
        match &out {
            Some(path) => {
                if let Err(error) = std::fs::write(path, &text) {
                    tracing::error!(%error, path, "CAP_GPUI_AUTO_MEETING: could not write summary");
                }
            }
            None => println!("{text}"),
        }
        cx.update(|cx| cx.quit());
    })
    .detach();
}

pub fn fake_mic_clients(platform_ids: &[&str], cx: &mut App) {
    let Some(meetings) = Meetings::try_global(cx) else {
        return;
    };
    let clients: Vec<cap_meetings::detect::MicClient> = platform_ids
        .iter()
        .map(|id| cap_meetings::detect::MicClient::new(*id, 99_999))
        .collect();
    meetings.update(cx, |meetings, cx| {
        let events = meetings.detector.on_mic_clients(meetings.now(), &clients);
        meetings.handle_detect_events(events, cx);
        meetings.rearm(cx);
    });
}
