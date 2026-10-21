use cap_verify::{
    audio_code::AudioSource,
    fixture::{AudioTrackSpec, FixtureSpec, SegmentSpec, Timing, VideoTrackSpec, write_fixture},
};

fn main() -> anyhow::Result<()> {
    let out = std::path::PathBuf::from(std::env::args().nth(1).expect("output dir"));
    let duration = 40.0;
    let mic = AudioTrackSpec {
        source: AudioSource::Mic,
        sample_rate: 48000,
        channels: 1,
        duration,
        start_time: 0.0,
    };
    for (name, camera) in [
        ("display", None),
        (
            "camera",
            Some(VideoTrackSpec::new(1280, 720, 30, Timing::Constant { duration })),
        ),
    ] {
        let spec = FixtureSpec {
            name: format!("editor-playback-{name}"),
            segments: vec![SegmentSpec {
                display: VideoTrackSpec::new(1920, 1080, 30, Timing::Constant { duration }),
                camera,
                mic: Some(mic.clone()),
                system_audio: None,
            }],
        };
        let dir = out.join(format!("{name}.cap"));
        std::fs::create_dir_all(&dir)?;
        write_fixture(&spec, &dir)?;
    }
    Ok(())
}
