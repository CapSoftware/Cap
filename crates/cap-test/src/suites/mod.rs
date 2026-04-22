mod av_alignment;
mod drift;
mod encoding;
pub mod ffprobe_ext;
pub mod kill9;
mod performance;
mod playback;
mod recording;
pub(crate) mod recording_helpers;
pub mod scenarios;
mod sync;
pub(crate) mod validate;

pub use recording::RecordingTestRunner;
pub use scenarios::{ScenarioRunner, classify_test_failure};
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

pub async fn run_performance_suite(
    hardware: &DiscoveredHardware,
    recording_path: &std::path::Path,
    duration: u64,
) -> Result<TestResults> {
    performance::run_suite(hardware, recording_path, duration).await
}

pub async fn run_sync_suite(hardware: &DiscoveredHardware, duration: u64) -> Result<TestResults> {
    sync::run_suite(hardware, duration).await
}

pub async fn run_av_alignment_suite(
    hardware: &DiscoveredHardware,
    duration: u64,
) -> Result<TestResults> {
    av_alignment::run_suite(hardware, duration).await
}

pub async fn run_drift_suite(hardware: &DiscoveredHardware, duration: u64) -> Result<TestResults> {
    drift::run_suite(hardware, duration).await
}

pub async fn run_kill9_crash_suite(
    hardware: &DiscoveredHardware,
    duration: u64,
) -> Result<TestResults> {
    kill9::run_suite(hardware, duration).await
}

pub async fn run_benchmark(
    hardware: &DiscoveredHardware,
    duration: u64,
    warmup: u64,
) -> Result<TestResults> {
    recording::run_benchmark(hardware, duration, warmup).await
}
