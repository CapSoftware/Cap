//! The fixture catalogue. Sizes and lengths depend on the tier: the fast
//! tier keeps every fixture a few seconds long at 320x180 or below; the full
//! tier lengthens the cases whose bugs need time to build up.

use crate::{
    audio_code::AudioSource,
    fixture::{AudioTrackSpec, FixtureSpec, SegmentSpec, Timing, VideoTrackSpec},
    report::Tier,
};

pub const SCREEN_W: u32 = 320;
pub const SCREEN_H: u32 = 180;
pub const CAMERA_W: u32 = 160;
pub const CAMERA_H: u32 = 120;

fn screen(fps: u32, timing: Timing) -> VideoTrackSpec {
    VideoTrackSpec::new(SCREEN_W, SCREEN_H, fps, timing)
}

fn camera(timing: Timing) -> VideoTrackSpec {
    VideoTrackSpec::new(CAMERA_W, CAMERA_H, 30, timing)
}

fn audio(source: AudioSource, duration: f64) -> AudioTrackSpec {
    AudioTrackSpec {
        source,
        sample_rate: 48_000,
        channels: if source == AudioSource::System { 2 } else { 1 },
        duration,
        start_time: 0.0,
    }
}

/// Screen + camera + mic + system audio, constant 30 fps.
pub fn basic(_tier: Tier) -> FixtureSpec {
    let duration = 6.0;
    FixtureSpec {
        name: "basic".into(),
        segments: vec![SegmentSpec {
            display: screen(30, Timing::Constant { duration }),
            camera: Some(camera(Timing::Constant { duration })),
            mic: Some(audio(AudioSource::Mic, duration)),
            system_audio: Some(audio(AudioSource::System, duration)),
        }],
    }
}

/// VFR screen with static holds longer than the decoders' frame cache
/// (2.6 s and 4.2 s at 30 fps > 90 frames) plus a narrow 0.4 s hold, and a
/// 60 fps nominal rate so holds are wide on the request grid.
pub fn vfr_holds(_tier: Tier) -> FixtureSpec {
    let duration = 14.0;
    FixtureSpec {
        name: "vfr-holds".into(),
        segments: vec![SegmentSpec {
            display: screen(
                60,
                Timing::Holds {
                    duration,
                    holds: vec![(1.0, 2.6), (5.0, 0.4), (7.0, 4.2)],
                },
            ),
            camera: Some(camera(Timing::Constant { duration })),
            mic: None,
            system_audio: None,
        }],
    }
}

/// Camera nominally 30 fps delivering ~12 fps with jitter, as real webcams
/// do in low light. Long enough for the decoder's gap tracking to fill up.
pub fn jitter_camera(tier: Tier) -> FixtureSpec {
    let duration = match tier {
        Tier::Fast => 40.0,
        Tier::Full => 120.0,
    };
    FixtureSpec {
        name: format!("jitter-camera-{duration:.0}s"),
        segments: vec![SegmentSpec {
            display: screen(30, Timing::Constant { duration }),
            camera: Some(camera(Timing::Jittery {
                duration,
                seed: 0x5EED_0001,
                holds: Vec::new(),
            })),
            mic: None,
            system_audio: None,
        }],
    }
}

/// Screen at 30 fps with keyframes every 25 frames (0.833 s: never on a
/// 10 ms grid), for seek-to-keyframe exactness.
pub fn seek_gop(_tier: Tier) -> FixtureSpec {
    let duration = 12.0;
    let mut display = screen(30, Timing::Constant { duration });
    display.gop = 25;
    let mut cam = camera(Timing::Constant { duration });
    cam.gop = 25;
    FixtureSpec {
        name: "seek-gop".into(),
        segments: vec![SegmentSpec {
            display,
            camera: Some(cam),
            mic: None,
            system_audio: None,
        }],
    }
}

/// Camera that starts 1.5 s after the screen (it is the latest track).
pub fn late_camera(_tier: Tier) -> FixtureSpec {
    let duration = 6.0;
    let mut cam = camera(Timing::Constant { duration: 4.5 });
    cam.start_time = 1.5;
    FixtureSpec {
        name: "late-camera".into(),
        segments: vec![SegmentSpec {
            display: screen(30, Timing::Constant { duration }),
            camera: Some(cam),
            mic: None,
            system_audio: None,
        }],
    }
}

/// Camera that starts before a slow microphone: the mic is the latest track,
/// so the camera needs a positive alignment offset.
pub fn early_camera(_tier: Tier) -> FixtureSpec {
    let duration = 6.0;
    let mut display = screen(30, Timing::Constant { duration });
    display.start_time = 0.2;
    let mut cam = camera(Timing::Constant { duration });
    cam.start_time = 0.0;
    let mut mic = audio(AudioSource::Mic, duration - 1.0);
    mic.start_time = 1.0;
    FixtureSpec {
        name: "early-camera".into(),
        segments: vec![SegmentSpec {
            display,
            camera: Some(cam),
            mic: Some(mic),
            system_audio: None,
        }],
    }
}

/// Camera file whose pts start 2 s in (frames before that do not exist).
pub fn camera_pts_late(_tier: Tier) -> FixtureSpec {
    let duration = 6.0;
    let mut cam = camera(Timing::Constant { duration: 4.0 });
    cam.pts_offset = 2.0;
    FixtureSpec {
        name: "camera-pts-late".into(),
        segments: vec![SegmentSpec {
            display: screen(30, Timing::Constant { duration }),
            camera: Some(cam),
            mic: None,
            system_audio: None,
        }],
    }
}

/// Two recording segments (pause/resume), the second without a camera.
pub fn multi_segment(_tier: Tier) -> FixtureSpec {
    FixtureSpec {
        name: "multi-segment".into(),
        segments: vec![
            SegmentSpec {
                display: screen(30, Timing::Constant { duration: 4.0 }),
                camera: Some(camera(Timing::Constant { duration: 4.0 })),
                mic: None,
                system_audio: None,
            },
            SegmentSpec {
                display: screen(30, Timing::Constant { duration: 3.0 }),
                camera: None,
                mic: None,
                system_audio: None,
            },
        ],
    }
}

/// A jittery 60 fps-nominal screen (~25 fps delivered, so nearly every
/// frame interval is a hole on the request grid) with a 10 s static hold at
/// 30-40 s. Timelines that play past the hold, then elsewhere, then jump
/// back into it exercise the decoders' bounded hole tracking.
pub fn backward_hold(_tier: Tier) -> FixtureSpec {
    let duration = 52.0;
    let mut display = screen(
        60,
        Timing::Jittery {
            duration,
            seed: 0x5EED_0002,
            holds: vec![(30.0, 10.0)],
        },
    );
    display.gop = 30;
    FixtureSpec {
        name: "backward-hold".into(),
        segments: vec![SegmentSpec {
            display,
            camera: Some(camera(Timing::Constant { duration })),
            mic: None,
            system_audio: None,
        }],
    }
}
