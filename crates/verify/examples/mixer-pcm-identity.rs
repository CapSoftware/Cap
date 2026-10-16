use anyhow::Context;
use cap_verify::{catalog, media, pipeline, report::Tier};
use std::{io::Write, path::PathBuf};

fn main() -> anyhow::Result<()> {
    let root = PathBuf::from(
        std::env::args()
            .nth(1)
            .context("output directory required")?,
    );
    std::fs::create_dir_all(&root)?;
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?;
    for system in [false, true] {
        let name = if system { "system" } else { "mic" };
        let mut spec = catalog::recorded_instant(Tier::Fast);
        spec.name = format!("identity-{name}");
        spec.duration = 2.0;
        spec.screen.delivery = pipeline::Delivery::Steady;
        spec.arm_at = None;
        spec.mic_delay = (!system).then_some(0.0);
        spec.system_audio = system;
        spec.system_continuous = true;
        let dir = root.join(name);
        runtime.block_on(pipeline::record_instant(&spec, &dir))?;
        let pcm = media::decode_audio(&dir.join("content/output.mp4"), None)?;
        anyhow::ensure!(pcm.channels.iter().all(|channel| !channel.is_empty()));
        let mut file =
            std::io::BufWriter::new(std::fs::File::create(root.join(format!("{name}.pcm")))?);
        for channel in &pcm.channels {
            for sample in channel {
                file.write_all(&sample.to_le_bytes())?;
            }
        }
        file.flush()?;
        std::fs::write(
            root.join(format!("{name}.json")),
            serde_json::to_vec_pretty(&serde_json::json!({
                "sample_rate": pcm.sample_rate,
                "start_secs": pcm.start_secs,
                "samples_per_channel": pcm.channels.iter().map(Vec::len).collect::<Vec<_>>(),
            }))?,
        )?;
    }
    Ok(())
}
