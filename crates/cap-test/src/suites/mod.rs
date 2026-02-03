mod encoding;
mod playback;
mod recording;
mod sync;
mod validate;

pub use recording::RecordingTestRunner;
pub use validate::validate_recording;

use anyhow::Result;

use crate::discovery::DiscoveredHardware;
use crate::results::TestResults;

pub async fn run_recording_suite(
    hardware: &DiscoveredHardware,
    duration: u64,
) -> Result<TestResults> {
    recording::run_suite(hardware, duration).await
}

pub async fn run_encoding_suite(
    hardware: &DiscoveredHardware,
    duration: u64,
) -> Result<TestResults> {
    encoding::run_suite(hardware, duration).await
}

pub async fn run_playback_suite(
    hardware: &DiscoveredHardware,
    duration: u64,
) -> Result<TestResults> {
    playback::run_suite(hardware, duration).await
}

pub async fn run_sync_suite(hardware: &DiscoveredHardware, duration: u64) -> Result<TestResults> {
    sync::run_suite(hardware, duration).await
}

pub async fn run_benchmark(
    hardware: &DiscoveredHardware,
    duration: u64,
    warmup: u64,
) -> Result<TestResults> {
    recording::run_benchmark(hardware, duration, warmup).await
}
