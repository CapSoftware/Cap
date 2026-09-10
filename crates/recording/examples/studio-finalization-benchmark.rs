use std::{path::PathBuf, time::Instant};

use cap_project::{RecordingMeta, StudioRecordingStatus};
use cap_recording::recovery::RecoveryManager;

fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .with_writer(std::io::stderr)
        .init();
    let path = std::env::args_os()
        .nth(1)
        .map(PathBuf::from)
        .ok_or_else(|| anyhow::anyhow!("Pass a disposable copy of an unfinished Studio project"))?;
    let before = RecordingMeta::load_for_project(&path)
        .map_err(|error| anyhow::anyhow!(error.to_string()))?;
    anyhow::ensure!(
        before
            .studio_meta()
            .is_some_and(|meta| matches!(meta.status(), StudioRecordingStatus::NeedsRemux)),
        "The benchmark requires a Studio project that needs remuxing"
    );
    let started = Instant::now();
    let remuxed = RecoveryManager::remux_if_needed(&path)?;
    let elapsed = started.elapsed();
    anyhow::ensure!(remuxed, "The benchmark did not finalize media");
    let after = RecordingMeta::load_for_project(&path)
        .map_err(|error| anyhow::anyhow!(error.to_string()))?;
    anyhow::ensure!(
        after
            .studio_meta()
            .is_some_and(|meta| matches!(meta.status(), StudioRecordingStatus::Complete)),
        "Finalized metadata is not complete"
    );
    let project = cap_project::ProjectConfiguration::load(&path)?;
    project.validate().map_err(anyhow::Error::msg)?;
    println!(
        "{}",
        serde_json::json!({
            "elapsedMs": elapsed.as_secs_f64() * 1000.0,
            "durationSeconds": project.timeline.map(|timeline| timeline.duration()),
            "remuxed": remuxed,
        })
    );
    Ok(())
}
