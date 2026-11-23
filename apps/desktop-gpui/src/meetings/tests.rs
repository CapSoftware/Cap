use cap_meetings::{
    library::{Attendee, DocKind, EventSnapshot, Library, MeetingDetails},
    templates::built_in_templates,
    transcript::{LogLine, Source, Transcript, Utterance, Word, append_jsonl},
};
use chrono::{TimeZone, Utc};
use cpal::SampleFormat;

use super::{
    audio_file::{OpusOggWriter, probe_duration_ms},
    calendar::{self, normalize_feed_url},
    capture::{SegmentJob, utterance_id},
    cloud::{self, Batcher, CloudError, CloudWord},
    engine,
    generate::{self, NotesError, SseEvent, SseParser},
    persist, speakers,
    timeline::{self, Aligner, RATE, decode_interleaved},
};

struct SimSource {
    aligner: Aligner,
    device_rate_scale: f64,
    exact: f64,
    emitted: u64,
}

impl SimSource {
    fn new(ppm: f64) -> Self {
        Self {
            aligner: Aligner::default(),
            device_rate_scale: 1.0 + ppm / 1e6,
            exact: 0.0,
            emitted: 0,
        }
    }

    fn deliver(&mut self, wall_end_secs: f64, chunk_secs: f64, lateness_secs: f64, use_end: bool) {
        self.exact += chunk_secs * f64::from(RATE) * self.device_rate_scale;
        let len = (self.exact.floor() as u64).saturating_sub(self.emitted) as usize;
        self.emitted += len as u64;
        let observed_secs = if use_end {
            wall_end_secs + lateness_secs - len as f64 / f64::from(RATE)
        } else {
            wall_end_secs - chunk_secs
        };
        self.aligner
            .place(timeline::seconds_to_samples(observed_secs), len);
    }

    fn error_ms(&self, wall_secs: f64) -> f64 {
        (self.aligner.written() as f64 - wall_secs * f64::from(RATE)) * 1000.0 / f64::from(RATE)
    }
}

#[test]
fn two_sources_with_opposite_clock_drift_stay_within_tens_of_ms_for_hours() {
    let mut mic = SimSource::new(180.0);
    let mut system = SimSource::new(-120.0);
    let chunk = 0.02;
    let mut wall = 0.0f64;
    let mut seed = 0x1234_5678u64;
    let mut worst_pair = 0.0f64;
    let mut worst_each = 0.0f64;
    let hours = 3.0;
    while wall < hours * 3600.0 {
        wall += chunk;
        seed = seed
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        let jitter = (seed >> 33) as f64 / (1u64 << 31) as f64 * 0.02;
        let in_stall = (1800.0..1802.5).contains(&wall);
        if in_stall {
            mic.exact += chunk * f64::from(RATE) * mic.device_rate_scale;
            mic.emitted = mic.exact.floor() as u64;
        } else {
            mic.deliver(wall, chunk, 0.0, false);
        }
        system.deliver(wall, chunk, jitter, true);
        if wall > 5.0 && !in_stall {
            let a = mic.error_ms(wall);
            let b = system.error_ms(wall);
            worst_each = worst_each.max(a.abs());
            worst_pair = worst_pair.max((a - b).abs());
        }
    }
    assert!(
        worst_each < 45.0,
        "a track drifted {worst_each:.1} ms from the wall clock"
    );
    assert!(
        worst_pair < 50.0,
        "the tracks drifted {worst_pair:.1} ms apart"
    );
    assert!(mic.aligner.stats().gaps >= 1, "the stall was not filled");
    assert!(mic.aligner.stats().drift_corrections > 0);
    assert!(system.aligner.stats().drift_corrections > 0);
}

#[test]
fn a_late_first_chunk_is_placed_at_its_wall_clock_position() {
    let mut aligner = Aligner::default();
    let placement = aligner.place(timeline::seconds_to_samples(1.5), 320);
    assert_eq!(placement.pad, 24_000);
    assert_eq!(aligner.written(), 24_320);
}

#[test]
fn a_gap_is_filled_with_silence_immediately() {
    let mut aligner = Aligner::default();
    aligner.place(0, 16_000);
    let placement = aligner.place(timeline::seconds_to_samples(3.0), 16_000);
    assert_eq!(placement.pad, 32_000);
    assert_eq!(aligner.written(), 64_000);
}

#[test]
fn decodes_every_common_sample_format_to_f32() {
    let mut out = Vec::new();
    let i16s: Vec<u8> = [i16::MAX, 0, i16::MIN]
        .iter()
        .flat_map(|v| v.to_ne_bytes())
        .collect();
    assert!(decode_interleaved(&i16s, SampleFormat::I16, &mut out));
    assert!((out[0] - 1.0).abs() < 1e-3 && out[1] == 0.0 && (out[2] + 1.0).abs() < 1e-6);

    out.clear();
    let f32s: Vec<u8> = [0.5f32, -0.25]
        .iter()
        .flat_map(|v| v.to_ne_bytes())
        .collect();
    assert!(decode_interleaved(&f32s, SampleFormat::F32, &mut out));
    assert_eq!(out, vec![0.5, -0.25]);

    out.clear();
    assert!(decode_interleaved(
        &[0, 128, 255],
        SampleFormat::U8,
        &mut out
    ));
    assert!((out[0] + 1.0).abs() < 1e-6 && out[1] == 0.0 && out[2] > 0.99);

    out.clear();
    let i32s: Vec<u8> = [i32::MIN, i32::MAX]
        .iter()
        .flat_map(|v| v.to_ne_bytes())
        .collect();
    assert!(decode_interleaved(&i32s, SampleFormat::I32, &mut out));
    assert!((out[0] + 1.0).abs() < 1e-6 && (out[1] - 1.0).abs() < 1e-6);
}

fn job(source: Source, start_ms: u64, len_ms: u64) -> SegmentJob {
    SegmentJob {
        source,
        start_sample: timeline::ms_to_samples(start_ms),
        samples: vec![0.1; timeline::ms_to_samples(len_ms) as usize],
        speech_ms: len_ms,
    }
}

#[test]
fn the_batcher_builds_clips_of_20_to_30_seconds_and_maps_words_back() {
    let mut batcher = Batcher::default();
    let mut clips = Vec::new();
    let mut start = 0;
    for len in [6_000, 7_000, 5_000, 9_000, 4_000, 8_000, 3_000] {
        if let Some(clip) = batcher.push(job(Source::System, start, len)) {
            clips.push(clip);
        }
        start += len + 2_000;
    }
    clips.extend(batcher.take());
    let durations: Vec<u64> = clips.iter().map(|c| c.duration_ms()).collect();
    assert!(
        durations[0] >= 20_000 && durations[0] <= 40_000,
        "{durations:?}"
    );
    assert!(
        durations
            .iter()
            .all(|d| *d <= cloud::CLIP_MAX_SECONDS * 1000)
    );

    let clip = &clips[0];
    let second = &clip.parts[1];
    let offset_ms = timeline::samples_to_ms(second.clip_offset_samples);
    let words = vec![
        CloudWord {
            text: "hello".into(),
            start_ms: 100.0,
            end_ms: 400.0,
            speaker: None,
        },
        CloudWord {
            text: "again".into(),
            start_ms: offset_ms as f64 + 250.0,
            end_ms: offset_ms as f64 + 600.0,
            speaker: None,
        },
    ];
    let mapped = clip.words_by_part(&words);
    assert_eq!(mapped[0][0].start_ms, 100);
    assert_eq!(mapped[1][0].text, "again");
    assert_eq!(mapped[1][0].start_ms, 8_000 + 250);
    assert_eq!(mapped[1][0].end_ms, 8_000 + 600);
    let wav = cloud::wav_bytes(&clip.samples);
    assert!(wav.len() <= cloud::CLIP_MAX_BYTES);
}

#[test]
fn the_wav_clip_matches_the_server_format() {
    let wav = cloud::wav_bytes(&[0.0, 1.0, -1.0]);
    assert_eq!(&wav[0..4], b"RIFF");
    assert_eq!(
        u32::from_le_bytes(wav[4..8].try_into().unwrap()) as usize + 8,
        wav.len()
    );
    assert_eq!(&wav[8..12], b"WAVE");
    assert_eq!(u16::from_le_bytes([wav[20], wav[21]]), 1);
    assert_eq!(u16::from_le_bytes([wav[22], wav[23]]), 1);
    assert_eq!(u32::from_le_bytes(wav[24..28].try_into().unwrap()), 16_000);
    assert_eq!(u16::from_le_bytes([wav[34], wav[35]]), 16);
    assert_eq!(&wav[36..40], b"data");
    assert_eq!(u32::from_le_bytes(wav[40..44].try_into().unwrap()), 6);
    assert_eq!(i16::from_le_bytes([wav[46], wav[47]]), 32_767);
}

#[test]
fn keywords_are_percent_encoded_and_bounded() {
    let header = cloud::keywords_header(&[
        "Cap Pro".into(),
        "naïve, café".into(),
        "x".repeat(80),
        "  ".into(),
    ])
    .unwrap();
    assert_eq!(header, "Cap%20Pro,na%C3%AFve%2C%20caf%C3%A9");
    let many: Vec<String> = (0..300).map(|i| format!("term{i}")).collect();
    let header = cloud::keywords_header(&many).unwrap();
    assert_eq!(header.split(',').count(), 100);
    assert!(cloud::keywords_header(&[]).is_none());
}

#[test]
fn server_errors_map_to_typed_failures() {
    assert_eq!(
        cloud::classify_status(401, "", None),
        CloudError::NotSignedIn
    );
    assert_eq!(
        cloud::classify_status(402, r#"{"error":"upgrade_required"}"#, None),
        CloudError::UpgradeRequired
    );
    assert_eq!(
        cloud::classify_status(
            429,
            r#"{"error":"rate_limited","retryAfterSeconds":42}"#,
            None
        ),
        CloudError::RateLimited {
            retry_after_secs: 42
        }
    );
    assert_eq!(
        cloud::classify_status(429, "", Some(7)),
        CloudError::RateLimited {
            retry_after_secs: 7
        }
    );
    // Only Cap's switch is "off"; a bare 503 is a busy server to retry.
    assert_eq!(
        cloud::classify_status(503, r#"{"error":"not_configured"}"#, None),
        CloudError::NotConfigured
    );
    assert_eq!(
        cloud::classify_status(503, "", None),
        CloudError::Failed("HTTP 503".into())
    );
    assert_eq!(
        cloud::classify_status(404, "", None),
        CloudError::NotConfigured
    );
    assert!(matches!(
        cloud::classify_status(502, r#"{"error":"transcription_failed"}"#, None),
        CloudError::Failed(reason) if reason == "transcription_failed"
    ));
    assert_eq!(
        NotesError::from(CloudError::RateLimited {
            retry_after_secs: 3
        }),
        NotesError::RateLimited {
            retry_after_secs: 3
        }
    );
}

#[test]
fn the_sse_parser_handles_split_chunks_and_keep_alives() {
    let stream = b": keep-alive\n\nevent: title\ndata: {\"title\":\"Weekly sync\"}\n\nevent: delta\ndata: {\"text\":\"## Summ\"}\n\nevent: delta\r\ndata: {\"text\":\"ary\\n\"}\r\n\r\n: keep-alive\n\nevent: done\ndata: {\"chars\":11}\n\n";
    let mut parser = SseParser::default();
    let mut events = Vec::new();
    for chunk in stream.chunks(7) {
        events.extend(parser.push(chunk));
    }
    events.extend(parser.finish());
    assert_eq!(
        events,
        vec![
            SseEvent::Title("Weekly sync".into()),
            SseEvent::Delta("## Summ".into()),
            SseEvent::Delta("ary\n".into()),
            SseEvent::Done,
        ]
    );
    let mut parser = SseParser::default();
    assert_eq!(
        parser.push(b"event: error\ndata: {\"error\":\"generation_failed\"}\n\n"),
        vec![SseEvent::Error("generation_failed".into())]
    );
}

fn meeting_meta(title_is_auto: bool) -> cap_meetings::library::DocMeta {
    let now = Utc.with_ymd_and_hms(2026, 11, 12, 9, 30, 0).unwrap();
    let mut meta = cap_meetings::library::DocMeta::new("doc-1".into(), DocKind::Meeting, now);
    meta.title = "Design review".into();
    meta.title_is_auto = title_is_auto;
    meta.meeting = Some(MeetingDetails {
        started_at: Some(now),
        duration_ms: 1_800_000,
        event: Some(EventSnapshot {
            id: "e".into(),
            title: "Design review".into(),
            attendees: vec![
                Attendee {
                    name: Some("Ada".into()),
                    email: Some("ada@example.com".into()),
                    is_self: true,
                },
                Attendee {
                    name: None,
                    email: Some("bob@example.com".into()),
                    is_self: false,
                },
            ],
            ..EventSnapshot::default()
        }),
        participants: vec!["bob@example.com".into()],
        ..MeetingDetails::default()
    });
    meta
}

fn utterance(id: &str, source: Source, start_ms: u64, text: &str) -> Utterance {
    Utterance {
        id: id.into(),
        source,
        start_ms,
        end_ms: start_ms + 1_000,
        text: text.into(),
        is_final: true,
        ..Utterance::default()
    }
}

#[test]
fn a_live_captions_echo_is_dropped_without_a_saved_delete_for_its_final_line() {
    let call = "the squire was not pleased with the answer he got";
    let mut transcript = Transcript::new();
    transcript.upsert(utterance("s1", Source::System, 10_000, call));
    // The microphone's open segment, still a caption, heard the call through
    // the speakers; its final line (same id) will hold the user's own words.
    transcript.upsert(Utterance {
        is_final: false,
        ..utterance("m1", Source::Mic, 10_100, call)
    });
    transcript.upsert(utterance("s2", Source::System, 30_000, call));
    transcript.upsert(utterance("m2", Source::Mic, 30_100, call));
    let saved = super::remove_echoes(&mut transcript);
    assert_eq!(
        saved,
        vec!["m2".to_string()],
        "only final lines are deleted on disk"
    );
    let ids: Vec<&str> = transcript
        .utterances()
        .iter()
        .map(|u| u.id.as_str())
        .collect();
    assert!(!ids.contains(&"m1") && !ids.contains(&"m2"), "{ids:?}");
}

#[test]
fn the_notes_body_matches_the_server_schema() {
    let mut transcript = Transcript::new();
    transcript.upsert(utterance("m1", Source::Mic, 0, "Shall we start?"));
    transcript.upsert(utterance(
        "s1",
        Source::System,
        1_500,
        "Yes, the mockups are ready.",
    ));
    let templates = built_in_templates();
    let meta = meeting_meta(true);
    let body = generate::notes_body(generate::NotesInput {
        meta: &meta,
        transcript: &transcript,
        user_notes_markdown: "- check the header".into(),
        template: &templates[0],
        vocabulary: &["Cap".into()],
        summary_language: Some("xx"),
        previous_markdown: None,
        instruction: None,
        time_zone: Some("Europe/London".into()),
        self_name: Some("Ada"),
    })
    .unwrap();
    assert!(body.title_requested);
    let b = &body.body;
    assert_eq!(b["title"], "");
    assert_eq!(b["startedAt"], "2026-11-12T09:30:00.000Z");
    assert_eq!(b["timezone"], "Europe/London");
    assert_eq!(b["summaryLanguage"], "auto");
    assert_eq!(b["rawNotesMarkdown"], "- check the header");
    assert_eq!(b["transcriptTruncated"], false);
    assert_eq!(b["meetingId"], generate::meeting_id(&meta.id));
    assert_eq!(b["meetingId"], meta.id);
    assert!(
        b["transcript"]
            .as_str()
            .unwrap()
            .contains("Ada: Shall we start?")
    );
    assert!(b["transcript"].as_str().unwrap().contains("Others: Yes"));
    assert_eq!(b["participants"][0]["name"], "Ada");
    assert_eq!(b["participants"][0]["isSelf"], true);
    assert_eq!(b["participants"][1]["email"], "bob@example.com");
    let sections = b["template"]["sections"].as_array().unwrap();
    assert!(!sections.is_empty() && sections.len() <= 12);
    let count = b["headingCount"].as_u64().unwrap();
    assert!((3..=10).contains(&count));
    assert!(b.get("previous").is_none());

    let body = generate::notes_body(generate::NotesInput {
        meta: &meeting_meta(false),
        transcript: &transcript,
        user_notes_markdown: String::new(),
        template: &templates[0],
        vocabulary: &[],
        summary_language: Some("de"),
        previous_markdown: Some("## Old".into()),
        instruction: Some("Shorter".into()),
        time_zone: None,
        self_name: None,
    })
    .unwrap();
    assert!(!body.title_requested);
    assert_eq!(body.body["title"], "Design review");
    assert_eq!(body.body["summaryLanguage"], "de");
    assert_eq!(body.body["previous"]["instruction"], "Shorter");

    let empty = generate::notes_body(generate::NotesInput {
        meta: &meeting_meta(true),
        transcript: &Transcript::new(),
        user_notes_markdown: String::new(),
        template: &templates[0],
        vocabulary: &[],
        summary_language: None,
        previous_markdown: None,
        instruction: None,
        time_zone: None,
        self_name: None,
    });
    assert!(matches!(empty, Err(NotesError::NothingToSummarize)));
}

#[test]
fn the_ask_body_keeps_the_latest_history() {
    let mut transcript = Transcript::new();
    transcript.upsert(utterance("m1", Source::Mic, 0, "Budget is fine."));
    let history: Vec<generate::AskTurn> = (0..30)
        .map(|i| generate::AskTurn {
            role: if i % 2 == 0 {
                generate::AskRole::User
            } else {
                generate::AskRole::Assistant
            },
            content: format!("turn {i}"),
        })
        .collect();
    let body = generate::ask_body(
        "20261113T101500123Z-abc123",
        "Sync",
        &transcript,
        "",
        "What about budget?",
        &history,
        None,
        &[],
    )
    .unwrap();
    assert!(
        body.get("vocabulary").is_none(),
        "an empty dictionary sends nothing new"
    );
    let with = generate::ask_body(
        "20261113T101500123Z-abc123",
        "Sync",
        &transcript,
        "",
        "What about budget?",
        &[],
        None,
        &["Cap".into()],
    )
    .unwrap();
    assert_eq!(with["vocabulary"], serde_json::json!(["Cap"]));
    let kept = body["history"].as_array().unwrap();
    assert_eq!(kept.len(), 20);
    assert_eq!(kept[0]["content"], "turn 10");
    assert_eq!(kept[0]["role"], "user");
    assert_eq!(body["title"], "Sync");
    assert_eq!(body["meetingId"], "20261113T101500123Z-abc123");
}

#[test]
fn meeting_ids_always_fit_the_server_charset() {
    let fits = |id: &str| {
        (1..=64).contains(&id.len())
            && id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    };
    let mut entropy = 0x9e37_79b9_7f4a_7c15u64;
    for _ in 0..500 {
        entropy ^= entropy << 13;
        entropy ^= entropy >> 7;
        entropy ^= entropy << 17;
        let id = cap_meetings::library::new_id(Utc::now(), entropy);
        assert!(fits(&id), "{id}");
        assert_eq!(generate::meeting_id(&id), id);
    }
    let long = "a".repeat(80);
    for odd in [long.as_str(), "", "notes.v2", "café"] {
        let mapped = generate::meeting_id(odd);
        assert!(fits(&mapped), "{odd} -> {mapped}");
        assert_eq!(mapped, generate::meeting_id(odd));
    }
    assert_ne!(
        generate::meeting_id(&long),
        generate::meeting_id(&"b".repeat(80))
    );
}

#[test]
fn feed_urls_are_normalised() {
    assert_eq!(
        normalize_feed_url("webcal://calendar.example.com/a.ics").unwrap(),
        "https://calendar.example.com/a.ics"
    );
    assert_eq!(
        normalize_feed_url(" WEBCALS://Example.com/x ").unwrap(),
        "https://example.com/x"
    );
    assert!(normalize_feed_url("http://example.com/feed").is_ok());
    assert!(normalize_feed_url("ftp://example.com/feed").is_err());
    assert!(normalize_feed_url("not a url").is_err());
    assert!(normalize_feed_url("file:///etc/passwd").is_err());
}

#[test]
fn an_ics_feed_becomes_planner_events() {
    let start = Utc::now() + chrono::Duration::hours(2);
    let ics = format!(
        "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nX-WR-CALNAME:Work\r\nBEGIN:VEVENT\r\nUID:abc@example.com\r\nDTSTART:{}\r\nDTEND:{}\r\nSUMMARY:Planning\r\nLOCATION:https://meet.google.com/abc-defg-hij\r\nATTENDEE;CN=Bob:mailto:bob@example.com\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n",
        start.format("%Y%m%dT%H%M%SZ"),
        (start + chrono::Duration::minutes(30)).format("%Y%m%dT%H%M%SZ"),
    );
    let (events, name) = calendar::parse("ics-1", ics.as_bytes()).unwrap();
    assert_eq!(name.as_deref(), Some("Work"));
    assert_eq!(events.len(), 1);
    let info = calendar::event_info(&events[0]);
    assert_eq!(info.id, "ics-1|abc@example.com");
    assert_eq!(info.title, "Planning");
    assert!(info.has_link);
    assert_eq!(info.attendee_count, 1);
    assert_eq!(calendar::participants(&events[0]), vec!["Bob".to_string()]);
    assert!(calendar::parse("ics-1", b"<html>nope</html>").is_err());
}

#[test]
fn utterances_take_their_times_from_the_segment_and_words() {
    let words = vec![
        Word {
            text: "hello".into(),
            start_ms: 10_200,
            end_ms: 10_500,
        },
        Word {
            text: "there".into(),
            start_ms: 10_600,
            end_ms: 11_000,
        },
    ];
    let u = engine::utterance(Source::Mic, timeline::ms_to_samples(10_000), words, true).unwrap();
    assert_eq!(u.id, utterance_id(Source::Mic, 160_000));
    assert_eq!((u.start_ms, u.end_ms), (10_200, 11_000));
    assert_eq!(u.text, "hello there");
    assert!(engine::utterance(Source::System, 0, Vec::new(), true).is_none());
}

#[test]
fn an_unfinished_meeting_is_recovered_with_its_duration() {
    let dir = tempfile::tempdir().unwrap();
    let library = Library::open(dir.path().join("documents")).unwrap();
    let started = Utc::now() - chrono::Duration::minutes(10);
    let mut meta = library.create(DocKind::Meeting, started, 7).unwrap();
    meta.meeting = Some(MeetingDetails {
        started_at: Some(started),
        ..MeetingDetails::default()
    });
    library.save(&meta).unwrap();
    let path = library.transcript_path(&meta.id).unwrap();
    append_jsonl(
        &path,
        &[
            LogLine::Upsert {
                utterance: utterance("m1", Source::Mic, 1_000, "first"),
            },
            LogLine::Upsert {
                utterance: utterance("s1", Source::System, 64_000, "second"),
            },
        ],
    )
    .unwrap();
    std::fs::OpenOptions::new()
        .append(true)
        .open(&path)
        .and_then(|mut f| std::io::Write::write_all(&mut f, b"{\"op\":\"upsert\",\"utter"))
        .unwrap();

    let recovered = persist::recover_unfinished(&library, None);
    assert_eq!(recovered, vec![meta.id.clone()]);
    let meta = library.load(&meta.id).unwrap();
    let meeting = meta.meeting.unwrap();
    assert_eq!(meeting.duration_ms, 65_000);
    assert_eq!(
        meeting.ended_at.unwrap(),
        started + chrono::Duration::milliseconds(65_000)
    );
    assert_eq!(
        meeting.transcript_chars,
        "first".len() as u64 + "second".len() as u64
    );
    assert!(persist::recover_unfinished(&library, None).is_empty());
}

fn tone(seconds: f64) -> Vec<f32> {
    (0..(seconds * f64::from(RATE)) as usize)
        .map(|n| (0.3 * (n as f64 * 440.0 * std::f64::consts::TAU / f64::from(RATE)).sin()) as f32)
        .collect()
}

#[cfg(unix)]
#[test]
fn meeting_audio_is_readable_by_its_owner_only() {
    use std::os::unix::fs::PermissionsExt as _;
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("audio/you.ogg");
    let mut writer = OpusOggWriter::create(&path).unwrap();
    writer.write(&tone(0.5)).unwrap();
    writer.finish().unwrap();
    let mode = |p: &std::path::Path| std::fs::metadata(p).unwrap().permissions().mode() & 0o777;
    assert_eq!(mode(&path), 0o600);
    assert_eq!(mode(path.parent().unwrap()), 0o700);
}

#[test]
fn the_opus_file_has_the_right_duration_and_survives_a_crash() {
    let dir = tempfile::tempdir().unwrap();
    let finished = dir.path().join("audio/you.ogg");
    let mut writer = OpusOggWriter::create(&finished).unwrap();
    for chunk in tone(3.0).chunks(777) {
        writer.write(chunk).unwrap();
    }
    writer.write_silence(16_000).unwrap();
    writer.finish().unwrap();
    let duration = probe_duration_ms(&finished).unwrap();
    assert!((3_900..=4_100).contains(&duration), "{duration}");
    let size = std::fs::metadata(&finished).unwrap().len();
    assert!(
        size < 20_000,
        "4 s of speech-rate Opus should stay small: {size}"
    );

    let crashed = dir.path().join("audio/others.ogg");
    let mut writer = OpusOggWriter::create(&crashed).unwrap();
    for chunk in tone(6.0).chunks(320) {
        writer.write(chunk).unwrap();
    }
    std::mem::forget(writer);
    let duration = probe_duration_ms(&crashed).unwrap_or(0);
    assert!(duration >= 3_500, "a killed writer kept only {duration} ms");
}

#[test]
fn notes_without_a_calendar_list_name_the_voices_the_transcript_heard() {
    use cap_diarize::{SpeakerId, SpeakerInfo, SpeakerNames, Track};
    let voice = |id: &str, source, start_ms, text: &str, speaker| Utterance {
        speaker_id: Some(speaker),
        ..utterance(id, source, start_ms, text)
    };
    let mut transcript = Transcript::new();
    transcript.upsert(voice("m1", Source::Mic, 0, "Shall we start?", 1));
    transcript.upsert(voice(
        "s1",
        Source::System,
        1_500,
        "The mockups are ready.",
        2,
    ));
    transcript.upsert(voice("s2", Source::System, 3_000, "I have a question.", 3));
    let info = |id, track, first_ms, is_user| SpeakerInfo {
        id: SpeakerId(id),
        track,
        first_ms,
        speech_ms: 5_000,
        is_user,
    };
    let mut names = SpeakerNames::new(None);
    names.observe(&[
        info(1, Track::Mic, 0, true),
        info(2, Track::System, 1_500, false),
        info(3, Track::System, 3_000, false),
    ]);
    names.rename(SpeakerId(2), "Dana");
    transcript.apply(LogLine::SpeakerNames { names });
    let mut meta = meeting_meta(false);
    if let Some(meeting) = meta.meeting.as_mut() {
        meeting.event = None;
        meeting.participants.clear();
    }
    let templates = built_in_templates();
    let body = generate::notes_body(generate::NotesInput {
        meta: &meta,
        transcript: &transcript,
        user_notes_markdown: String::new(),
        template: &templates[0],
        vocabulary: &[],
        summary_language: None,
        previous_markdown: None,
        instruction: None,
        time_zone: None,
        self_name: Some("Ada"),
    })
    .unwrap();
    let b = &body.body;
    let text = b["transcript"].as_str().unwrap();
    assert!(text.contains("Ada: Shall we start?"), "{text}");
    assert!(text.contains("Dana: The mockups are ready."), "{text}");
    assert!(
        text.lines()
            .any(|l| l.starts_with("Person ") && l.ends_with("I have a question.")),
        "{text}"
    );
    assert_eq!(b["participants"][0]["name"], "Ada");
    assert_eq!(b["participants"][0]["isSelf"], true);
    assert_eq!(b["participants"][1]["name"], "Dana");
    assert_eq!(b["participants"].as_array().unwrap().len(), 2);
}

#[test]
fn a_meeting_note_that_heard_nothing_is_a_false_start() {
    let dir = tempfile::tempdir().unwrap();
    let library = Library::open(dir.path().join("documents")).unwrap();
    let mut meta = library.create(DocKind::Meeting, Utc::now(), 11).unwrap();
    meta.title = "Meeting at 10:18".into();
    meta.title_is_auto = true;
    library.save(&meta).unwrap();
    assert!(super::false_start(&library, &meta, 0));
    assert!(
        !super::false_start(&library, &meta, 12),
        "it heard something"
    );

    let mut named = meta.clone();
    named.title = "Hiring sync".into();
    named.title_is_auto = false;
    assert!(
        !super::false_start(&library, &named, 0),
        "the person named it"
    );

    let mut scheduled = meta.clone();
    scheduled.title = "Test Meeting".into();
    scheduled.title_is_auto = false;
    scheduled.meeting.get_or_insert_with(Default::default).event =
        Some(cap_meetings::library::EventSnapshot {
            title: "Test Meeting".into(),
            ..Default::default()
        });
    assert!(
        super::false_start(&library, &scheduled, 0),
        "a calendar title is not a name the person gave it"
    );

    let typed = cap_notes::Document::from_markdown("Ask about the launch date");
    library.write_notes(&meta.id, &typed.to_json()).unwrap();
    assert!(
        !super::false_start(&library, &meta, 0),
        "something was typed"
    );

    let blank = cap_notes::Document::from_markdown("");
    library.write_notes(&meta.id, &blank.to_json()).unwrap();
    assert!(super::false_start(&library, &meta, 0));

    let trashed = library.trash(&meta.id, Utc::now()).unwrap();
    assert!(
        !super::false_start(&library, &trashed, 0),
        "already in Trash"
    );
}

#[test]
fn always_spell_fixes_matching_words_and_leaves_the_rest() {
    use cap_meetings::dictionary::{Corrector, Entry};
    use cap_meetings::transcript::{Utterance, Word};
    let corrector = Corrector::new(&[Entry::new("Cap").with_sounds_like(&["Kap"])]);
    let word = |text: &str, at: u64| Word {
        text: text.into(),
        start_ms: at,
        end_ms: at + 100,
    };
    let line = Utterance {
        id: "u1".into(),
        text: "Kap is my cap.".into(),
        is_final: true,
        words: vec![
            word("Kap", 0),
            word("is", 100),
            word("my", 200),
            word("cap.", 300),
        ],
        ..Utterance::default()
    };
    let fixed = super::respell(&corrector, &line).unwrap();
    assert_eq!(fixed.text, "Cap is my cap.");
    assert_eq!(fixed.words[0], word("Cap", 0));
    assert_eq!(fixed.words[3], word("cap.", 300));
    let other = Utterance {
        text: "Nothing to fix".into(),
        ..line.clone()
    };
    assert!(super::respell(&corrector, &other).is_none());
}

#[test]
fn an_old_voice_profile_is_dropped_once_and_the_voice_is_learnt_again() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("voice-profile.json");
    speakers::TEST_PROFILE_PATH.with(|p| *p.borrow_mut() = Some(path.clone()));
    // A synthetic profile in the format the first version wrote.
    let mut old = cap_diarize::VoiceProfile::new("model#2", &[1.0, 0.0], 37_000);
    old.version = 1;
    old.save(&path).unwrap();
    assert!(speakers::load_profile().is_none());
    assert!(
        !path.exists(),
        "the old file is gone, so the next meeting does not warn again"
    );
    assert!(speakers::load_profile().is_none());
    let learnt = cap_diarize::VoiceProfile::new("model#2", &[0.0, 1.0], 31_000);
    let saved = speakers::save_enrolment(&learnt).unwrap();
    assert_eq!(saved.meetings, 1);
    assert_eq!(speakers::load_profile(), Some(saved));
    speakers::TEST_PROFILE_PATH.with(|p| *p.borrow_mut() = None);
}

#[test]
fn a_late_merge_renames_only_the_merged_voices_label_in_the_summary() {
    use cap_diarize::{SpeakerId, SpeakerInfo, SpeakerNames, Track};
    let voice = |id: &str, source, start_ms, text: &str, speaker| Utterance {
        speaker_id: Some(speaker),
        ..utterance(id, source, start_ms, text)
    };
    let info = |id, track, first_ms, is_user| SpeakerInfo {
        id: SpeakerId(id),
        track,
        first_ms,
        speech_ms: 5_000,
        is_user,
    };
    let mut before = Transcript::new();
    before.upsert(voice("m1", Source::Mic, 0, "Shall we start?", 1));
    before.upsert(voice("s1", Source::System, 1_000, "The deck is ready.", 2));
    before.upsert(voice("s2", Source::System, 2_000, "I will send it.", 4));
    before.upsert(voice("s3", Source::System, 3_000, "Any questions?", 5));
    let mut names = SpeakerNames::new(None);
    names.observe(&[
        info(1, Track::Mic, 0, true),
        info(2, Track::System, 1_000, false),
        info(4, Track::System, 2_000, false),
        info(5, Track::System, 3_000, false),
    ]);
    before.apply(LogLine::SpeakerNames { names: names.clone() });
    // after Stop: voice 4 was a fragment of voice 2; voice 5 is untouched
    let mut after = before.clone();
    after.assign_speakers(&[("s2".to_string(), 2)]);
    let pass = cap_diarize::FinalPass {
        speakers: vec![
            info(1, Track::Mic, 0, true),
            info(2, Track::System, 1_000, false),
            info(5, Track::System, 3_000, false),
        ],
        merged: vec![(SpeakerId(4), SpeakerId(2)), (SpeakerId(9), SpeakerId(1))],
        user: Some(SpeakerId(1)),
        ..cap_diarize::FinalPass::default()
    };
    names.apply_late(&pass);
    after.set_names(names);
    let renames = super::late_summary_renames(&before, &after, &pass.merged, Some("Ada"));
    // Person 2 (voice 4) now goes by Person 1 (voice 2); Person 3 keeps its number; voice 9 was never here
    assert_eq!(renames, vec![("Person 2".to_string(), "Person 1".to_string())]);

    // a merged voice that still holds a line (the user moved it back) keeps its label
    let mut kept = before.clone();
    kept.set_names(after.names().cloned().unwrap());
    assert!(super::late_summary_renames(&before, &kept, &pass.merged, Some("Ada")).is_empty());

    let mut summary = cap_notes::Document::from_markdown(
        "- Person 2 will send the deck.\n- Speaker 2 agreed with Person 3.\n- Person 20 asked about dates.",
    );
    for block in &mut summary.blocks {
        block.origin = cap_notes::Origin::Generated;
    }
    let renamed = super::rename_in_saved_summary(&summary.to_json(), &renames).expect("the summary names Person 2");
    let renamed = cap_notes::Document::from_json(&renamed).unwrap();
    let text = renamed.to_markdown();
    assert!(text.contains("Person 1 will send the deck."), "{text}");
    assert!(text.contains("Person 1 agreed with Person 3."), "{text}");
    assert!(text.contains("Person 20 asked about dates."), "{text}");
    assert!(renamed.blocks.iter().all(|b| b.origin == cap_notes::Origin::Generated), "only text changes");
    // nothing to follow: the saved summary is left as it is
    assert!(super::rename_in_saved_summary(&summary.to_json(), &[("Person 7".into(), "Person 1".into())]).is_none());
}

pub(crate) fn active_meeting() -> super::ActiveMeeting {
    super::ActiveMeeting {
        doc_id: "doc".into(),
        title: String::new(),
        started_at: Utc::now(),
        started: std::time::Instant::now(),
        state: super::ActiveState::Recording,
        mic: super::SourceState::default(),
        system: super::SourceState::default(),
        engine: super::EngineStatus::default(),
        warning: None,
        resume_offer_until: None,
        app_name: None,
        event_id: None,
        health: Vec::new(),
        not_hearing: false,
        audio_failed: false,
        low_disk: false,
    }
}

/// 1 s of silence, half a second of tone, then silence again.
fn marked_track() -> Vec<f32> {
    let mut samples = vec![0.0; 16_000];
    samples.extend(tone(0.5));
    samples.extend(std::iter::repeat_n(0.0, 8_000));
    samples
}

fn onset(samples: &[f32]) -> Option<usize> {
    samples.iter().position(|x| x.abs() > 0.05)
}

#[test]
fn saved_audio_reads_back_on_the_meeting_timeline() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("audio/you.ogg");
    let mut writer = OpusOggWriter::create(&path).unwrap();
    for chunk in marked_track().chunks(480) {
        writer.write(chunk).unwrap();
    }
    writer.finish().unwrap();
    let mut reader = super::audio_file::TrackReader::open(&path).unwrap();
    let all = reader.read(0, 32_000).unwrap();
    assert!(all.len() >= 31_900, "{}", all.len());
    let at = onset(&all).unwrap() as i64;
    assert!((at - 16_000).abs() <= 80, "the tone starts at sample {at}, not 16000 (±5 ms)");
    // A later read, then an earlier one (the file opens again), agree.
    let later = reader.read(20_000, 1_000).unwrap();
    assert_eq!(later.len(), 1_000);
    let again = reader.read(15_000, 2_000).unwrap();
    let at_again = onset(&again).unwrap() as i64 + 15_000;
    assert_eq!(at_again, at);
    // Past the end reads short.
    assert!(reader.read(31_000, 5_000).unwrap().len() < 5_000);
}

#[test]
fn a_crashed_file_reads_back_up_to_its_last_page() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("audio/others.ogg");
    let mut writer = OpusOggWriter::create(&path).unwrap();
    for chunk in tone(6.0).chunks(320) {
        writer.write(chunk).unwrap();
    }
    std::mem::forget(writer);
    let mut reader = super::audio_file::TrackReader::open(&path).unwrap();
    let samples = reader.read(0, 16_000 * 6).unwrap();
    assert!(samples.len() >= 16_000 * 3, "only {} samples survived", samples.len());
}

#[test]
fn recovery_puts_the_untranscribed_end_in_the_ledger() {
    let dir = tempfile::tempdir().unwrap();
    let library = Library::open(dir.path().join("documents")).unwrap();
    let started = Utc::now() - chrono::Duration::minutes(5);
    let mut meta = library.create(DocKind::Meeting, started, 9).unwrap();
    let audio = library.audio_dir(&meta.id).unwrap();
    let mut writer = OpusOggWriter::create(&audio.join("you.ogg")).unwrap();
    for chunk in tone(4.0).chunks(320) {
        writer.write(chunk).unwrap();
    }
    writer.finish().unwrap();
    let mut details = MeetingDetails {
        started_at: Some(started),
        ..MeetingDetails::default()
    };
    details.extra.insert(
        persist::AUDIO_PARTS_KEY.into(),
        serde_json::json!([{ "file": "audio/you.ogg", "source": "mic", "offsetMs": 0 }]),
    );
    meta.meeting = Some(details);
    library.save(&meta).unwrap();
    let path = library.transcript_path(&meta.id).unwrap();
    let mut line = utterance("m1", Source::Mic, 0, "said before the crash");
    line.end_ms = 1_000;
    append_jsonl(&path, &[LogLine::Upsert { utterance: line }]).unwrap();

    assert_eq!(persist::recover_unfinished(&library, None), vec![meta.id.clone()]);
    let (transcript, _) = Transcript::load_jsonl(&path).unwrap();
    let gaps = transcript.gaps();
    assert_eq!(gaps.len(), 1, "{gaps:?}");
    assert_eq!(gaps[0].source, Source::Mic);
    assert_eq!(gaps[0].start_sample, timeline::ms_to_samples(1_300));
    let end_ms = timeline::samples_to_ms(gaps[0].end_sample);
    assert!((3_900..=4_100).contains(&end_ms), "{end_ms}");
    assert!(gaps[0].segments.is_empty(), "the speech is found again in the span");
    assert_eq!(persist::pending_repairs(&library), vec![meta.id.clone()]);
    let parts = persist::audio_parts(&library, &library.load(&meta.id).unwrap());
    assert_eq!(parts.len(), 1);
    assert!(parts[0].path.ends_with("audio/you.ogg"));
}

#[test]
fn audio_parts_never_leave_the_meeting_folder() {
    let dir = tempfile::tempdir().unwrap();
    let library = Library::open(dir.path().join("documents")).unwrap();
    let mut meta = library.create(DocKind::Meeting, Utc::now(), 3).unwrap();
    let mut details = MeetingDetails::default();
    details.extra.insert(
        persist::AUDIO_PARTS_KEY.into(),
        serde_json::json!([
            { "file": "../../elsewhere.ogg", "source": "mic", "offsetMs": 0 },
            { "file": "/tmp/x.ogg", "source": "mic", "offsetMs": 0 },
            { "file": "audio/others-2.ogg", "source": "system", "offsetMs": 61000 }
        ]),
    );
    meta.meeting = Some(details);
    let parts = persist::audio_parts(&library, &meta);
    assert_eq!(parts.len(), 1);
    assert_eq!(parts[0].source, Source::System);
    assert_eq!(parts[0].offset_samples, timeline::ms_to_samples(61_000));
}

#[test]
fn gaps_without_saved_audio_are_recorded_but_never_retried() {
    use cap_meetings::transcript::Gap;
    let gap = |source| Gap {
        id: Gap::id_for(source, 0),
        source,
        start_sample: 0,
        end_sample: 16_000,
        segments: vec![(0, 16_000)],
        reason: "busy".into(),
    };
    let parts = vec![engine::AudioPart {
        source: Source::Mic,
        path: "/tmp/x/you.ogg".into(),
        offset_samples: 0,
    }];
    let gaps = [gap(Source::Mic), gap(Source::System)];
    assert_eq!(persist::repairable(&gaps, &parts), vec![gap(Source::Mic)]);
    assert!(persist::repairable(&gaps, &[]).is_empty(), "audio not kept: nothing to fill");
}

#[test]
fn the_line_says_words_may_be_missing_only_when_nothing_can_bring_them_back() {
    use super::health::{Concern, concerns};
    let mut active = active_meeting();
    active.engine.gaps = 2;
    assert!(!concerns(&active).contains(&Concern::WordsMissing), "kept audio: repaired after Stop");
    active.engine.unrepairable = 2;
    assert!(concerns(&active).contains(&Concern::WordsMissing));
}

#[test]
fn scratch_audio_is_repairable_but_never_part_of_the_note() {
    let dir = tempfile::tempdir().unwrap();
    let library = Library::open(dir.path().join("documents")).unwrap();
    let scratch_root = dir.path().join("scratch");
    let mut meta = library.create(DocKind::Meeting, Utc::now(), 11).unwrap();
    let scratch = persist::scratch_dir_in(&scratch_root, &meta.id);
    let mut writer = OpusOggWriter::create(&scratch.join("others.ogg")).unwrap();
    for chunk in tone(2.0).chunks(320) {
        writer.write(chunk).unwrap();
    }
    writer.finish().unwrap();
    // Windows refuses to delete a file a writer still holds open.
    drop(writer);
    let mut details = MeetingDetails::default();
    details.extra.insert(persist::SCRATCH_KEY.into(), serde_json::json!(true));
    details.extra.insert(
        persist::SCRATCH_PARTS_KEY.into(),
        serde_json::json!([{ "file": "others.ogg", "source": "system", "offsetMs": 0 }]),
    );
    meta.meeting = Some(details);
    library.save(&meta).unwrap();
    // Repair reads it ...
    let parts = persist::audio_parts_with(&library, &meta, &scratch_root);
    assert_eq!(parts.len(), 1);
    assert_eq!(parts[0].path, scratch.join("others.ogg"));
    // ... the note never lists it.
    assert!(persist::audio_tracks(&library, &meta.id).is_empty());
    // Once the meeting is complete it goes, file and record.
    persist::drop_scratch_in(&scratch_root, &mut meta);
    assert!(!scratch.exists());
    assert!(!persist::flag(&meta, persist::SCRATCH_KEY));
    assert!(persist::audio_parts_with(&library, &meta, &scratch_root).is_empty());
}

#[test]
fn stale_scratch_goes_but_a_pending_repair_or_a_live_recording_keeps_its_copy() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("scratch");
    for id in ["old-done", "old-pending", "recording-now"] {
        std::fs::create_dir_all(root.join(id)).unwrap();
        std::fs::write(root.join(id).join("you.ogg"), b"x").unwrap();
    }
    let old = std::time::SystemTime::now() - std::time::Duration::from_secs(600);
    for id in ["old-done", "old-pending"] {
        let f = std::fs::File::options().write(true).open(root.join(id).join("you.ogg")).unwrap();
        f.set_modified(old).unwrap();
    }
    let removed = persist::drop_stale_scratch_in(&root, |id| id == "old-pending");
    assert_eq!(removed, vec!["old-done".to_string()]);
    assert!(root.join("old-pending").exists(), "a repair still needs it");
    assert!(root.join("recording-now").exists(), "written to just now");
}

#[test]
fn saved_audio_keeps_every_sample_up_to_a_partial_last_frame() {
    // Opus frames are 20 ms (320 samples here); a meeting stops anywhere.
    for n in [16_000 + 390, 16_000 + 96, 16_000 + 319, 32_000] {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("audio/others.ogg");
        let mut writer = OpusOggWriter::create(&path).unwrap();
        for chunk in tone(3.0)[..n].chunks(480) {
            writer.write(chunk).unwrap();
        }
        writer.finish().unwrap();
        drop(writer);
        let mut reader = super::audio_file::TrackReader::open(&path).unwrap();
        assert_eq!(reader.read(0, n as u64 + 5_000).unwrap().len(), n, "{n} samples written");
    }
}

#[test]
fn a_repair_that_never_fills_stops_after_a_few_launches() {
    let dir = tempfile::tempdir().unwrap();
    let library = Library::open(dir.path().join("documents")).unwrap();
    let mut meta = library.create(DocKind::Meeting, Utc::now(), 9).unwrap();
    meta.meeting = Some(MeetingDetails::default());
    for _ in 1..persist::REPAIR_TRIES_MAX {
        assert_eq!(persist::after_repair(&mut meta, true), (true, false));
        assert!(persist::flag(&meta, persist::REPAIR_KEY));
    }
    assert_eq!(persist::after_repair(&mut meta, true), (false, true), "given up");
    assert!(!persist::flag(&meta, persist::REPAIR_KEY), "no longer tried at launch");
    // A repair that fills clears the count, so a later gap gets its own tries.
    assert_eq!(persist::after_repair(&mut meta, true), (true, false));
    assert_eq!(persist::after_repair(&mut meta, false), (false, false));
    assert!(!persist::flag(&meta, persist::REPAIR_KEY));
    let tries = meta.meeting.as_ref().unwrap().extra.get(persist::REPAIR_TRIES_KEY).cloned();
    assert_eq!(tries, None);
}

fn read(
    chunks: Vec<Result<&'static str, &'static str>>,
) -> (Result<(), NotesError>, Vec<SseEvent>) {
    let (tx, rx) = flume::unbounded();
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_time()
        .build()
        .unwrap();
    let stream = futures_util::stream::iter(chunks);
    let result = runtime.block_on(generate::read_events(
        stream,
        std::time::Duration::from_secs(5),
        &tx,
    ));
    (result, rx.try_iter().collect())
}

#[test]
fn an_answer_that_stops_early_is_an_interruption_not_a_lost_connection() {
    let title = "event: title\ndata: {\"title\":\"Plan\"}\n\n";
    let delta = "event: delta\ndata: {\"text\":\"## Summary\\n\"}\n\n";
    let done = "event: done\ndata: {}\n\n";

    let (whole, events) = read(vec![Ok(title), Ok(delta), Ok(done)]);
    assert_eq!(whole, Ok(()));
    assert!(events.contains(&SseEvent::Done));

    let (cut, events) = read(vec![Ok(title), Ok(delta)]);
    assert!(matches!(cut, Err(NotesError::Interrupted(_))), "{cut:?}");
    assert_eq!(events.len(), 2, "what arrived is still delivered");

    let (broken, _) = read(vec![Ok(title), Err("connection reset")]);
    assert!(
        matches!(broken, Err(NotesError::Interrupted(_))),
        "{broken:?}"
    );

    for error in [
        NotesError::Interrupted("cut".into()),
        NotesError::Failed("HTTP 500".into()),
    ] {
        assert!(super::notes_retryable(&error));
        assert!(
            !super::waits_on_connection(&error),
            "{error:?} is not the connection"
        );
    }
    assert!(super::waits_on_connection(&NotesError::Offline(
        "dns".into()
    )));
}

#[test]
fn missed_audio_adds_up_on_the_note_and_survives_a_relaunch() {
    let dir = tempfile::tempdir().unwrap();
    let library = Library::open(dir.path().join("documents")).unwrap();
    let mut meta = library.create(DocKind::Meeting, Utc::now(), 11).unwrap();
    meta.meeting = Some(MeetingDetails::default());

    // A clean recording leaves nothing.
    assert!(!persist::add_missed_audio(&mut meta, 0));
    assert_eq!(persist::missed_audio_ms(&meta), 0);

    // Two recordings into the same note, each held up once.
    assert!(persist::add_missed_audio(&mut meta, 20_141));
    assert!(persist::add_missed_audio(&mut meta, 15_002));
    library.save(&meta).unwrap();
    let reloaded = library.load(&meta.id).unwrap();
    assert_eq!(persist::missed_audio_ms(&reloaded), 35_143);

    // Dismissed: gone for good.
    let mut dismissed = reloaded;
    assert!(persist::clear_missed_audio(&mut dismissed));
    library.save(&dismissed).unwrap();
    assert_eq!(
        persist::missed_audio_ms(&library.load(&meta.id).unwrap()),
        0
    );
    assert!(!persist::clear_missed_audio(&mut dismissed));
}

#[test]
fn keep_audio_for_deletes_only_finished_meetings_nothing_still_needs() {
    let dir = tempfile::tempdir().unwrap();
    let library = Library::open(dir.path().join("documents")).unwrap();
    let day = |d: u32| Utc.with_ymd_and_hms(2026, 3, d, 9, 0, 0).unwrap();
    let make = |entropy: u64, ended: Option<u32>, repair: bool| {
        let mut meta = library.create(DocKind::Meeting, day(1), entropy).unwrap();
        meta.meeting.as_mut().unwrap().ended_at = ended.map(day);
        persist::set_flag(&mut meta, persist::REPAIR_KEY, repair);
        library.save(&meta).unwrap();
        let audio = library.audio_dir(&meta.id).unwrap();
        std::fs::create_dir_all(&audio).unwrap();
        std::fs::write(audio.join("you.ogg"), b"ogg").unwrap();
        (meta.id, audio)
    };
    let old = make(1, Some(1), false);
    let recent = make(2, Some(9), false);
    let unfinished = make(3, None, false);
    let repairing = make(4, Some(1), true);
    let in_use = make(5, Some(1), false);

    let swept = persist::sweep_old_audio(&library, day(10), 7, std::slice::from_ref(&in_use.0));
    assert_eq!(swept, vec![old.0]);
    assert!(!old.1.exists());
    for (what, kept) in [
        ("ended two days ago", recent.1),
        ("never ended", unfinished.1),
        ("waiting for a repair", repairing.1),
        ("in use", in_use.1),
    ] {
        assert!(kept.exists(), "a meeting that {what} keeps its audio");
    }
}

#[test]
fn library_cleanup_waits_for_recovery_and_spares_what_is_in_use() {
    use super::CleanupPlan;
    let mut settings = cap_meetings::settings::MeetingSettings::default();
    assert_eq!(
        super::Meetings::new(settings.clone()).cleanup_plan(Vec::new()),
        CleanupPlan::Run { audio_days: None, busy: Vec::new() },
        "the trash is emptied even when audio is kept forever"
    );

    settings.recording.audio_retention_days = Some(7);
    let mut meetings = super::Meetings::new(settings);
    meetings.repair_queue.push_back("repairing".into());
    meetings.resume_doc = Some("resuming".into());
    meetings.notes.insert(
        "writing notes".into(),
        super::NotesState { waiting: true, ..super::NotesState::default() },
    );
    meetings.notes.insert("notes done".into(), super::NotesState::default());
    assert_eq!(
        meetings.cleanup_plan(vec!["open".into()]),
        CleanupPlan::Run {
            audio_days: Some(7),
            busy: vec![
                "repairing".into(),
                "resuming".into(),
                "writing notes".into(),
                "open".into(),
            ],
        }
    );
    meetings.recovery = Some(gpui::Task::ready(()));
    assert_eq!(meetings.cleanup_plan(Vec::new()), CleanupPlan::Later);
}

#[test]
fn trash_older_than_thirty_days_goes_unless_it_is_open() {
    let dir = tempfile::tempdir().unwrap();
    let library = Library::open(dir.path().join("documents")).unwrap();
    let day = |d: u32| Utc.with_ymd_and_hms(2026, 3, d, 9, 0, 0).unwrap();
    let trashed = |entropy: u64, at: u32| {
        let id = library.create(DocKind::Note, day(1), entropy).unwrap().id;
        library.trash(&id, day(at)).unwrap();
        id
    };
    let old = trashed(1, 1);
    let recent = trashed(2, 20);
    let open = trashed(3, 1);
    let kept = library.create(DocKind::Note, day(1), 4).unwrap().id;

    let later = day(1) + chrono::Duration::days(31);
    let purged = persist::purge_old_trash(&library, later, std::slice::from_ref(&open));
    assert_eq!(purged, vec![old.clone()]);
    assert!(library.load(&old).is_err());
    for id in [recent, open, kept] {
        assert!(library.load(&id).is_ok(), "{id} stays");
    }
}

#[test]
fn each_resume_of_a_meeting_without_kept_audio_gets_its_own_files() {
    let mut meeting = MeetingDetails::default();
    let mut seen = Vec::new();
    for (key, sources) in [
        (persist::SCRATCH_PARTS_KEY, 2),
        (persist::SCRATCH_PARTS_KEY, 2),
        (persist::SCRATCH_PARTS_KEY, 1),
        (persist::AUDIO_PARTS_KEY, 2),
        (persist::SCRATCH_PARTS_KEY, 2),
    ] {
        let suffix = persist::resume_suffix(&meeting);
        assert!(!seen.contains(&suffix), "{suffix} reused after {seen:?}");
        seen.push(suffix);
        let parts = meeting.extra.entry(key.to_string()).or_insert_with(|| serde_json::json!([]));
        for _ in 0..sources {
            parts.as_array_mut().unwrap().push(serde_json::json!({ "file": "x.ogg" }));
        }
    }
    assert_eq!(persist::resume_suffix(&MeetingDetails::default()), "-2");
}
