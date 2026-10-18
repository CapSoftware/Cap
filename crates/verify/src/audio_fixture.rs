//! Fixtures for the audio, captions and editing tracks: projects whose mic,
//! system audio and timeline music carry distinct audio markers, written by
//! [`crate::fixture::write_fixture`] plus a music file.

use std::path::Path;

use cap_project::{AudioTrackSegment, ProjectConfiguration};

use crate::{
    audio_code::{self, AudioSource},
    catalog::{SCREEN_H, SCREEN_W},
    fixture::{self, AudioTrackSpec, FixtureSpec, SegmentSpec, Timing, VideoTrackSpec},
    media::{self, AudioCodec},
    report::Tier,
};

/// Bump when the music writer changes so cached fixtures are rebuilt.
const AUDIO_GENERATOR_VERSION: u32 = 2;
/// Music file written next to `recording-meta.json`.
pub const MUSIC_FILE: &str = "music.ogg";
pub const MUSIC_SECS: f64 = 12.0;

fn audio(source: AudioSource, duration: f64, start_time: f64) -> AudioTrackSpec {
    AudioTrackSpec {
        source,
        sample_rate: 48_000,
        channels: if source == AudioSource::System { 2 } else { 1 },
        duration,
        start_time,
    }
}

/// One clip: screen at 30 fps (starting 0.10 s into the recording), mic
/// starting 0.5 s in (the latest track, so screen and system audio get
/// alignment offsets), stereo system audio from 0, plus a stereo music file.
/// The mic start is one marker period so the sources' markers stay apart
/// once aligned.
pub fn mix(tier: Tier) -> FixtureSpec {
    let duration = match tier {
        Tier::Fast => 8.0,
        Tier::Full => 30.0,
    };
    let mut display = VideoTrackSpec::new(SCREEN_W, SCREEN_H, 30, Timing::Constant { duration });
    display.start_time = 0.10;
    FixtureSpec {
        name: format!("audio-mix-{duration:.0}s-a{AUDIO_GENERATOR_VERSION}"),
        segments: vec![SegmentSpec {
            display,
            camera: None,
            mic: Some(audio(AudioSource::Mic, duration - 0.5, 0.5)),
            system_audio: Some(audio(AudioSource::System, duration, 0.0)),
        }],
    }
}

/// Two clips (pause/resume): the second has a mic only.
pub fn multi(_tier: Tier) -> FixtureSpec {
    let screen =
        |duration| VideoTrackSpec::new(SCREEN_W, SCREEN_H, 30, Timing::Constant { duration });
    FixtureSpec {
        name: format!("audio-multi-a{AUDIO_GENERATOR_VERSION}"),
        segments: vec![
            SegmentSpec {
                display: screen(5.0),
                camera: None,
                mic: Some(audio(AudioSource::Mic, 5.0, 0.0)),
                system_audio: Some(audio(AudioSource::System, 5.0, 0.0)),
            },
            SegmentSpec {
                display: screen(4.0),
                camera: None,
                mic: Some(audio(AudioSource::Mic, 4.0, 0.0)),
                system_audio: None,
            },
        ],
    }
}

/// Writes the fixture tracks and the music file.
pub fn write(spec: &FixtureSpec, dir: &Path) -> anyhow::Result<()> {
    fixture::write_fixture(spec, dir)?;
    let rate = 48_000;
    let mut mono = vec![0.0f32; (MUSIC_SECS * f64::from(rate)) as usize];
    let schedule = audio_code::standard_schedule(AudioSource::Media, 0.1, MUSIC_SECS - 0.1, 0.5);
    audio_code::render_markers(
        &mut mono,
        rate,
        AudioSource::Media,
        &schedule,
        audio_code::DEFAULT_AMPLITUDE,
    );
    media::write_audio(
        &dir.join(MUSIC_FILE),
        &[mono.clone(), mono],
        rate,
        AudioCodec::Opus,
        128_000,
    )
}

/// Adds a timeline music segment playing [`MUSIC_FILE`].
pub fn add_music(
    config: &mut ProjectConfiguration,
    start: f64,
    end: f64,
    trim_start: f64,
    volume_db: f32,
) {
    let timeline = config.timeline.as_mut().expect("timeline");
    timeline.audio_segments.push(AudioTrackSegment {
        start,
        end,
        track: 0,
        path: MUSIC_FILE.into(),
        name: None,
        enabled: true,
        trim_start,
        volume_db,
        fade_in: 0.0,
        fade_out: 0.0,
        duration: Some(MUSIC_SECS),
    });
}
