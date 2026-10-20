use cap_verify::{
    audio_code::AudioSource,
    fixture::{AudioTrackSpec, FixtureSpec, SegmentSpec, Timing, VideoTrackSpec, write_fixture},
};

fn main() -> anyhow::Result<()> {
    let dir = std::path::PathBuf::from(std::env::args().nth(1).expect("output dir"));
    let duration = 20.0;
    let spec = FixtureSpec {
        name: "first-open".into(),
        segments: vec![SegmentSpec {
            display: VideoTrackSpec::new(2560, 1440, 30, Timing::Constant { duration }),
            camera: Some(VideoTrackSpec::new(
                1280,
                720,
                30,
                Timing::Constant { duration },
            )),
            mic: Some(AudioTrackSpec {
                source: AudioSource::Mic,
                sample_rate: 48000,
                channels: 1,
                duration,
                start_time: 0.0,
            }),
            system_audio: None,
        }],
    };
    std::fs::create_dir_all(&dir)?;
    write_fixture(&spec, &dir)
}
