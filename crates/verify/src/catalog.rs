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

/// The seek fixture written by the product's macOS encoder: AVAssetWriter
/// with VideoToolbox, its own GOP structure and a 1/600 time base.
/// Keyframes at k/30 s are off the 10 ms grid for most k. Identical to
/// `seek_gop` elsewhere.
pub fn seek_gop_native(_tier: Tier) -> FixtureSpec {
    let duration = 12.0;
    let native = |mut track: VideoTrackSpec| {
        track.encoder = crate::fixture::TrackEncoder::AvFoundation;
        track
    };
    FixtureSpec {
        name: "seek-native".into(),
        segments: vec![SegmentSpec {
            display: native(screen(30, Timing::Constant { duration })),
            camera: Some(native(camera(Timing::Constant { duration }))),
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

/// Recorded through the real pipeline: two recording segments (pause and
/// resume), the first with a jittery camera that is the last device to
/// start, a static-screen hold, a mic that starts late and loopback-style
/// system audio; the second screen and mic only. (A camera that starts
/// before the mic is covered by `early_camera`.)
pub fn recorded_studio(_tier: Tier) -> crate::pipeline::RecordedSpec {
    use crate::pipeline::{Delivery, RecordedSegment, RecordedSpec, RecordedVideo};
    let screen = |delivery| RecordedVideo {
        width: SCREEN_W,
        height: SCREEN_H,
        fps: 30,
        delivery,
        start_delay: 0.0,
    };
    RecordedSpec {
        name: "studio".into(),
        segments: vec![
            RecordedSegment {
                duration: 6.0,
                screen: screen(Delivery::Holds(vec![(2.0, 1.5)])),
                camera: Some(RecordedVideo {
                    width: CAMERA_W,
                    height: CAMERA_H,
                    fps: 30,
                    delivery: Delivery::Jittery { seed: 0x5EED_0003 },
                    start_delay: 0.3,
                }),
                mic_delay: Some(0.15),
                system_audio: true,
            },
            RecordedSegment {
                duration: 4.0,
                screen: screen(Delivery::Steady),
                camera: None,
                mic_delay: Some(0.1),
                system_audio: false,
            },
        ],
    }
}

/// Instant recording through the real Instant muxers, started like the app
/// does (sources warm up, then the start gate opens at 0.517 s, between two frames): steady 30 fps
/// screen with a static hold, a mic that becomes ready at 0.2 s,
/// loopback-style system audio.
pub fn recorded_instant(_tier: Tier) -> crate::pipeline::InstantSpec {
    use crate::pipeline::{Delivery, InstantSpec, RecordedVideo};
    InstantSpec {
        name: "instant".into(),
        duration: 6.0,
        screen: RecordedVideo {
            width: SCREEN_W,
            height: SCREEN_H,
            fps: 30,
            delivery: Delivery::Holds(vec![(2.5, 1.2)]),
            start_delay: 0.0,
        },
        mic_delay: Some(0.2),
        system_audio: true,
        system_continuous: false,
        arm_at: Some(0.517),
    }
}

/// Instant variants isolating each audio source's start behaviour: no start
/// gate, so a source that delivers its first sample after the screen does.
pub fn instant_variants(tier: Tier) -> Vec<crate::pipeline::InstantSpec> {
    let base = recorded_instant(tier);
    vec![
        crate::pipeline::InstantSpec {
            name: "instant-ungated-mic-late".into(),
            system_audio: false,
            arm_at: None,
            ..base.clone()
        },
        crate::pipeline::InstantSpec {
            name: "instant-ungated-system-loopback".into(),
            mic_delay: None,
            arm_at: None,
            ..base.clone()
        },
        crate::pipeline::InstantSpec {
            name: "instant-ungated-system-continuous-mic-late".into(),
            system_continuous: true,
            arm_at: None,
            ..base.clone()
        },
        crate::pipeline::InstantSpec {
            name: "instant-gated-system-only".into(),
            mic_delay: None,
            ..base.clone()
        },
        crate::pipeline::InstantSpec {
            name: "instant-gated-system-continuous-mic-late".into(),
            system_continuous: true,
            ..base.clone()
        },
        crate::pipeline::InstantSpec {
            name: "instant-gated-mic-only".into(),
            system_audio: false,
            ..base.clone()
        },
        base,
    ]
}
