use cap_verify::fixture::{FixtureSpec, SegmentSpec, Timing, VideoTrackSpec, write_fixture};

fn main() -> anyhow::Result<()> {
    let out = std::path::PathBuf::from(std::env::args().nth(1).expect("output dir"));
    let duration: f64 = std::env::args()
        .nth(2)
        .map(|value| value.parse().expect("duration"))
        .unwrap_or(10.0);
    let spec = FixtureSpec {
        name: "cursor-wallpaper".to_string(),
        segments: vec![SegmentSpec {
            display: VideoTrackSpec::new(1920, 1080, 30, Timing::Constant { duration }),
            camera: None,
            mic: None,
            system_audio: None,
        }],
    };
    std::fs::create_dir_all(&out)?;
    write_fixture(&spec, &out)?;
    Ok(())
}
