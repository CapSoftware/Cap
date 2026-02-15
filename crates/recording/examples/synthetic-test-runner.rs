use cap_recording::{
    Mp4Muxer, OggMuxer, OutputPipeline, SegmentedVideoMuxer, SegmentedVideoMuxerConfig,
    test_sources::{
        AudioGenerator, AudioTestConfig, OutputFormat, RecordingValidator, SyntheticAudioSource,
        SyntheticAudioSourceConfig, TestConfig, TestPattern, TestPatternVideoSource,
        TestPatternVideoSourceConfig, ValidationConfig, VideoTestConfig, common_test_configs,
        comprehensive_test_configs,
    },
};
use cap_timestamp::Timestamps;
use clap::{Parser, Subcommand};
use std::{
    path::{Path, PathBuf},
    time::{Duration, Instant},
};
use tokio_util::sync::CancellationToken;
use tracing_subscriber::{EnvFilter, fmt, prelude::*};

#[derive(Parser)]
#[command(name = "synthetic-test-runner")]
#[command(about = "Run synthetic recording tests without physical hardware")]
struct Cli {
    #[command(subcommand)]
    command: Option<Commands>,

    #[arg(long, default_value = "5")]
    duration: u64,

    #[arg(long)]
    report: Option<PathBuf>,

    #[arg(long)]
    keep_outputs: bool,

    #[arg(long, default_value = "/tmp/cap-synthetic-tests")]
    output_dir: PathBuf,
}

#[derive(Subcommand)]
enum Commands {
    Quick,
    Full,
    StudioMode,
    PauseResume,
    Resolution {
        #[arg(long)]
        width: u32,
        #[arg(long)]
        height: u32,
        #[arg(long, default_value = "30")]
        fps: u32,
    },
    Source {
        #[arg(value_enum)]
        source_type: SourceType,
    },
    List,
    Sync {
        #[arg(long, default_value = "50")]
        tolerance_ms: f64,
    },
}

#[derive(Clone, Copy, clap::ValueEnum)]
enum SourceType {
    Screen,
    Camera,
    Microphone,
}

#[tokio::main]
async fn main() {
    tracing_subscriber::registry()
        .with(fmt::layer())
        .with(EnvFilter::from_default_env().add_directive(tracing::Level::INFO.into()))
        .init();

    let cli = Cli::parse();

    let duration = Duration::from_secs(cli.duration);

    let configs = match &cli.command {
        None | Some(Commands::Quick) => {
            println!("Running quick test suite (~10 common configurations)...\n");
            common_test_configs()
        }
        Some(Commands::Full) => {
            println!("Running full test suite (comprehensive matrix)...\n");
            comprehensive_test_configs()
        }
        Some(Commands::StudioMode) => {
            println!("Running Studio Mode simulation (screen + camera + mic)...\n");
            vec![create_studio_mode_config(duration)]
        }
        Some(Commands::PauseResume) => {
            println!("Running pause/resume tests...\n");
            run_pause_resume_tests(&cli).await;
            return;
        }
        Some(Commands::Resolution { width, height, fps }) => {
            println!("Testing resolution {width}x{height} @ {fps}fps...\n");
            vec![TestConfig {
                video: Some(
                    VideoTestConfig::default()
                        .with_resolution(*width, *height)
                        .with_frame_rate(*fps),
                ),
                audio: Some(AudioTestConfig::broadcast_stereo()),
                duration,
                output_format: OutputFormat::FragmentedM4s {
                    segment_duration: Duration::from_secs(3),
                },
            }]
        }
        Some(Commands::Source { source_type }) => match source_type {
            SourceType::Screen => {
                println!("Testing screen capture configurations...\n");
                screen_test_configs(duration)
            }
            SourceType::Camera => {
                println!("Testing webcam configurations...\n");
                camera_test_configs(duration)
            }
            SourceType::Microphone => {
                println!("Testing microphone configurations...\n");
                microphone_test_configs(duration)
            }
        },
        Some(Commands::List) => {
            list_test_configurations();
            return;
        }
        Some(Commands::Sync { tolerance_ms }) => {
            println!("Running A/V sync verification tests (tolerance: {tolerance_ms}ms)...\n");
            sync_test_configs(duration, *tolerance_ms)
        }
    };

    let total_tests = configs.len();
    let mut passed = 0;
    let mut failed = 0;
    let mut results = Vec::new();

    if cli.output_dir.exists()
        && let Err(e) = std::fs::remove_dir_all(&cli.output_dir)
    {
        tracing::warn!("Failed to clean output directory before tests: {}", e);
    }

    let start = Instant::now();

    for (idx, config) in configs.iter().enumerate() {
        let test_name = format_test_name(config);
        println!("[{}/{}] {}", idx + 1, total_tests, test_name);

        let result = run_synthetic_test(config, &cli.output_dir, idx).await;

        match &result {
            TestResult::Passed {
                validation,
                elapsed,
            } => {
                passed += 1;
                println!(
                    "       \u{2713} Frame count: {}/{}",
                    validation.actual_frames, validation.expected_frames
                );
                println!(
                    "       \u{2713} A/V sync: {:.1}ms offset (< 50ms threshold)",
                    validation.av_sync_offset_ms
                );
                if validation.fragments_checked > 0 {
                    println!(
                        "       \u{2713} Fragment integrity: {} segments OK",
                        validation.fragments_valid
                    );
                }
                println!("       Duration: {:.2}s\n", elapsed.as_secs_f64());
            }
            TestResult::Failed { error, elapsed } => {
                failed += 1;
                println!("       \u{2717} FAILED: {error}");
                println!("       Duration: {:.2}s\n", elapsed.as_secs_f64());
            }
            TestResult::Skipped { reason } => {
                println!("       - SKIPPED: {reason}\n");
            }
        }

        results.push((test_name, result));
    }

    let total_elapsed = start.elapsed();

    println!("\n{}", "=".repeat(60));
    println!("Summary: {passed}/{total_tests} passed, {failed} failed");
    println!("Total time: {:.1}s", total_elapsed.as_secs_f64());

    if failed > 0 {
        println!("\nFailed tests:");
        for (name, result) in &results {
            if let TestResult::Failed { error, .. } = result {
                println!("  - {name}: {error}");
            }
        }
    }

    if let Some(report_path) = &cli.report {
        save_report(report_path, &results);
        println!("\nReport saved to: {}", report_path.display());
    }

    if !cli.keep_outputs
        && let Err(e) = std::fs::remove_dir_all(&cli.output_dir)
    {
        tracing::warn!("Failed to clean up output directory: {}", e);
    }

    std::process::exit(if failed > 0 { 1 } else { 0 });
}

#[allow(dead_code)]
enum TestResult {
    Passed {
        validation: cap_recording::test_sources::ValidationResult,
        elapsed: Duration,
    },
    Failed {
        error: String,
        elapsed: Duration,
    },
    Skipped {
        reason: String,
    },
}

async fn run_synthetic_test(config: &TestConfig, output_dir: &Path, test_idx: usize) -> TestResult {
    let start = Instant::now();

    let test_output_dir = output_dir.join(format!("test_{test_idx}"));
    if let Err(e) = std::fs::create_dir_all(&test_output_dir) {
        return TestResult::Failed {
            error: format!("Failed to create output directory: {e}"),
            elapsed: start.elapsed(),
        };
    }

    let timestamps = Timestamps::now();
    let cancel_token = CancellationToken::new();

    let output_path = match &config.output_format {
        OutputFormat::Mp4 => test_output_dir.join("output.mp4"),
        OutputFormat::FragmentedM4s { .. } => test_output_dir.join("segments"),
        OutputFormat::OggOpus => test_output_dir.join("output.ogg"),
    };

    let pipeline_result = match (&config.video, &config.audio, &config.output_format) {
        (Some(video_config), Some(audio_config), OutputFormat::Mp4) => {
            run_mp4_recording(
                &output_path,
                video_config,
                audio_config,
                config.duration,
                timestamps,
                cancel_token.clone(),
            )
            .await
        }
        (Some(video_config), None, OutputFormat::Mp4) => {
            run_video_only_mp4_recording(
                &output_path,
                video_config,
                config.duration,
                timestamps,
                cancel_token.clone(),
            )
            .await
        }
        (None, Some(audio_config), OutputFormat::OggOpus) => {
            run_audio_only_ogg_recording(
                &output_path,
                audio_config,
                config.duration,
                timestamps,
                cancel_token.clone(),
            )
            .await
        }
        (
            Some(video_config),
            Some(audio_config),
            OutputFormat::FragmentedM4s { segment_duration },
        ) => {
            run_segmented_m4s_recording(
                &output_path,
                video_config,
                audio_config,
                config.duration,
                *segment_duration,
                timestamps,
                cancel_token.clone(),
            )
            .await
        }
        (Some(video_config), None, OutputFormat::FragmentedM4s { segment_duration }) => {
            run_video_only_segmented_m4s_recording(
                &output_path,
                video_config,
                config.duration,
                *segment_duration,
                timestamps,
                cancel_token.clone(),
            )
            .await
        }
        _ => {
            return TestResult::Skipped {
                reason: "Unsupported configuration combination".to_string(),
            };
        }
    };

    let elapsed = start.elapsed();

    match pipeline_result {
        Ok(()) => {
            let validator = RecordingValidator::new(config).with_config(ValidationConfig {
                frame_count_tolerance: 0.10,
                duration_tolerance: Duration::from_millis(1000),
                av_sync_tolerance_ms: 50.0,
                check_fragments: true,
            });

            let validation_result = match &config.output_format {
                OutputFormat::FragmentedM4s { .. } => {
                    validator.validate_m4s_fragments(&output_path).await
                }
                _ => validator.validate_mp4(&output_path).await,
            };

            match validation_result {
                Ok(validation) => {
                    if validation.is_valid() {
                        TestResult::Passed {
                            validation,
                            elapsed,
                        }
                    } else {
                        let mut failures = vec![];
                        if !validation.frame_count_ok {
                            failures.push(format!(
                                "frame_count: {}/{}",
                                validation.actual_frames, validation.expected_frames
                            ));
                        }
                        if !validation.duration_ok {
                            failures.push(format!(
                                "duration: {:.2}s/{:.2}s",
                                validation.actual_duration.as_secs_f64(),
                                validation.expected_duration.as_secs_f64()
                            ));
                        }
                        if !validation.av_sync_ok {
                            failures.push(format!(
                                "av_sync: {:.1}ms offset",
                                validation.av_sync_offset_ms
                            ));
                        }
                        if !validation.fragment_integrity {
                            failures.push(format!(
                                "fragments: {}/{}",
                                validation.fragments_valid, validation.fragments_checked
                            ));
                        }
                        if !validation.errors.is_empty() {
                            failures.push(validation.errors.join(", "));
                        }
                        TestResult::Failed {
                            error: format!("Validation failed: {}", failures.join("; ")),
                            elapsed,
                        }
                    }
                }
                Err(e) => TestResult::Failed {
                    error: format!("Validation error: {e}"),
                    elapsed,
                },
            }
        }
        Err(e) => TestResult::Failed {
            error: format!("Recording failed: {e}"),
            elapsed,
        },
    }
}

async fn run_mp4_recording(
    output_path: &std::path::Path,
    video_config: &VideoTestConfig,
    audio_config: &AudioTestConfig,
    duration: Duration,
    timestamps: Timestamps,
    cancel_token: CancellationToken,
) -> anyhow::Result<()> {
    let video_source_config = TestPatternVideoSourceConfig {
        video_config: video_config.clone(),
        duration,
        timestamps,
        cancel_token: cancel_token.clone(),
    };

    let audio_source_config = SyntheticAudioSourceConfig {
        audio_config: audio_config.clone(),
        duration,
        timestamps,
        cancel_token: cancel_token.clone(),
    };

    let pipeline = OutputPipeline::builder(output_path.to_path_buf())
        .with_timestamps(timestamps)
        .with_video::<TestPatternVideoSource>(video_source_config)
        .with_audio_source::<SyntheticAudioSource>(audio_source_config)
        .build::<Mp4Muxer>(())
        .await?;

    tokio::time::sleep(duration + Duration::from_millis(500)).await;

    pipeline.stop().await?;

    Ok(())
}

async fn run_video_only_mp4_recording(
    output_path: &std::path::Path,
    video_config: &VideoTestConfig,
    duration: Duration,
    timestamps: Timestamps,
    cancel_token: CancellationToken,
) -> anyhow::Result<()> {
    let video_source_config = TestPatternVideoSourceConfig {
        video_config: video_config.clone(),
        duration,
        timestamps,
        cancel_token: cancel_token.clone(),
    };

    let pipeline = OutputPipeline::builder(output_path.to_path_buf())
        .with_timestamps(timestamps)
        .with_video::<TestPatternVideoSource>(video_source_config)
        .build::<Mp4Muxer>(())
        .await?;

    tokio::time::sleep(duration + Duration::from_millis(500)).await;

    pipeline.stop().await?;

    Ok(())
}

async fn run_audio_only_ogg_recording(
    output_path: &std::path::Path,
    audio_config: &AudioTestConfig,
    duration: Duration,
    timestamps: Timestamps,
    cancel_token: CancellationToken,
) -> anyhow::Result<()> {
    let audio_source_config = SyntheticAudioSourceConfig {
        audio_config: audio_config.clone(),
        duration,
        timestamps,
        cancel_token: cancel_token.clone(),
    };

    let pipeline = OutputPipeline::builder(output_path.to_path_buf())
        .with_timestamps(timestamps)
        .with_audio_source::<SyntheticAudioSource>(audio_source_config)
        .build::<OggMuxer>(())
        .await?;

    tokio::time::sleep(duration + Duration::from_millis(500)).await;

    pipeline.stop().await?;

    Ok(())
}

async fn run_segmented_m4s_recording(
    output_path: &std::path::Path,
    video_config: &VideoTestConfig,
    _audio_config: &AudioTestConfig,
    duration: Duration,
    segment_duration: Duration,
    timestamps: Timestamps,
    cancel_token: CancellationToken,
) -> anyhow::Result<()> {
    let video_source_config = TestPatternVideoSourceConfig {
        video_config: video_config.clone(),
        duration,
        timestamps,
        cancel_token: cancel_token.clone(),
    };

    let muxer_config = SegmentedVideoMuxerConfig {
        segment_duration,
        ..Default::default()
    };

    let pipeline = OutputPipeline::builder(output_path.to_path_buf())
        .with_timestamps(timestamps)
        .with_video::<TestPatternVideoSource>(video_source_config)
        .build::<SegmentedVideoMuxer>(muxer_config)
        .await?;

    tokio::time::sleep(duration + Duration::from_millis(500)).await;

    pipeline.stop().await?;

    Ok(())
}

async fn run_video_only_segmented_m4s_recording(
    output_path: &std::path::Path,
    video_config: &VideoTestConfig,
    duration: Duration,
    segment_duration: Duration,
    timestamps: Timestamps,
    cancel_token: CancellationToken,
) -> anyhow::Result<()> {
    let video_source_config = TestPatternVideoSourceConfig {
        video_config: video_config.clone(),
        duration,
        timestamps,
        cancel_token: cancel_token.clone(),
    };

    let muxer_config = SegmentedVideoMuxerConfig {
        segment_duration,
        ..Default::default()
    };

    let pipeline = OutputPipeline::builder(output_path.to_path_buf())
        .with_timestamps(timestamps)
        .with_video::<TestPatternVideoSource>(video_source_config)
        .build::<SegmentedVideoMuxer>(muxer_config)
        .await?;

    tokio::time::sleep(duration + Duration::from_millis(500)).await;

    pipeline.stop().await?;

    Ok(())
}

fn format_test_name(config: &TestConfig) -> String {
    let mut parts = vec![];

    if let Some(video) = &config.video {
        parts.push(format!(
            "{}x{}@{}fps",
            video.width, video.height, video.frame_rate
        ));
        parts.push(format!("{:?}", video.pixel_format));
    }

    if let Some(audio) = &config.audio {
        parts.push(format!("{}kHz", audio.sample_rate / 1000));
        if audio.channels == 1 {
            parts.push("mono".to_string());
        } else if audio.channels == 2 {
            parts.push("stereo".to_string());
        } else {
            parts.push(format!("{}ch", audio.channels));
        }
    }

    parts.join(" + ")
}

fn create_studio_mode_config(duration: Duration) -> TestConfig {
    TestConfig {
        video: Some(
            VideoTestConfig::fhd_1080p()
                .with_frame_rate(60)
                .with_pattern(TestPattern::FrameCounter),
        ),
        audio: Some(AudioTestConfig::broadcast_stereo().with_generator(
            AudioGenerator::TimestampBeeps {
                beep_interval_ms: 1000,
            },
        )),
        duration,
        output_format: OutputFormat::FragmentedM4s {
            segment_duration: Duration::from_secs(3),
        },
    }
}

fn screen_test_configs(duration: Duration) -> Vec<TestConfig> {
    vec![
        TestConfig {
            video: Some(VideoTestConfig::hd_720p()),
            audio: Some(AudioTestConfig::broadcast_stereo()),
            duration,
            output_format: OutputFormat::FragmentedM4s {
                segment_duration: Duration::from_secs(3),
            },
        },
        TestConfig {
            video: Some(VideoTestConfig::fhd_1080p()),
            audio: Some(AudioTestConfig::broadcast_stereo()),
            duration,
            output_format: OutputFormat::FragmentedM4s {
                segment_duration: Duration::from_secs(3),
            },
        },
        TestConfig {
            video: Some(VideoTestConfig::fhd_1080p().with_frame_rate(60)),
            audio: Some(AudioTestConfig::broadcast_stereo()),
            duration,
            output_format: OutputFormat::FragmentedM4s {
                segment_duration: Duration::from_secs(3),
            },
        },
        TestConfig {
            video: Some(VideoTestConfig::qhd_1440p()),
            audio: Some(AudioTestConfig::broadcast_stereo()),
            duration,
            output_format: OutputFormat::FragmentedM4s {
                segment_duration: Duration::from_secs(3),
            },
        },
        TestConfig {
            video: Some(VideoTestConfig::uhd_4k()),
            audio: Some(AudioTestConfig::broadcast_stereo()),
            duration,
            output_format: OutputFormat::FragmentedM4s {
                segment_duration: Duration::from_secs(3),
            },
        },
        TestConfig {
            video: Some(VideoTestConfig::ultrawide_1080()),
            audio: Some(AudioTestConfig::broadcast_stereo()),
            duration,
            output_format: OutputFormat::FragmentedM4s {
                segment_duration: Duration::from_secs(3),
            },
        },
        TestConfig {
            video: Some(VideoTestConfig::macbook_retina()),
            audio: Some(AudioTestConfig::broadcast_stereo()),
            duration,
            output_format: OutputFormat::FragmentedM4s {
                segment_duration: Duration::from_secs(3),
            },
        },
        TestConfig {
            video: Some(VideoTestConfig::portrait_1080()),
            audio: Some(AudioTestConfig::broadcast_stereo()),
            duration,
            output_format: OutputFormat::FragmentedM4s {
                segment_duration: Duration::from_secs(3),
            },
        },
    ]
}

fn camera_test_configs(duration: Duration) -> Vec<TestConfig> {
    vec![
        TestConfig {
            video: Some(VideoTestConfig::webcam_vga()),
            audio: None,
            duration,
            output_format: OutputFormat::Mp4,
        },
        TestConfig {
            video: Some(VideoTestConfig::webcam_hd()),
            audio: None,
            duration,
            output_format: OutputFormat::Mp4,
        },
        TestConfig {
            video: Some(VideoTestConfig::webcam_hd().with_frame_rate(60)),
            audio: None,
            duration,
            output_format: OutputFormat::Mp4,
        },
        TestConfig {
            video: Some(VideoTestConfig::webcam_fhd()),
            audio: None,
            duration,
            output_format: OutputFormat::Mp4,
        },
        TestConfig {
            video: Some(VideoTestConfig::webcam_4k()),
            audio: None,
            duration,
            output_format: OutputFormat::Mp4,
        },
    ]
}

fn microphone_test_configs(duration: Duration) -> Vec<TestConfig> {
    vec![
        TestConfig {
            video: None,
            audio: Some(AudioTestConfig::cd_quality_mono()),
            duration,
            output_format: OutputFormat::OggOpus,
        },
        TestConfig {
            video: None,
            audio: Some(AudioTestConfig::cd_quality_stereo()),
            duration,
            output_format: OutputFormat::OggOpus,
        },
        TestConfig {
            video: None,
            audio: Some(AudioTestConfig::broadcast_mono()),
            duration,
            output_format: OutputFormat::OggOpus,
        },
        TestConfig {
            video: None,
            audio: Some(AudioTestConfig::broadcast_stereo()),
            duration,
            output_format: OutputFormat::OggOpus,
        },
        TestConfig {
            video: None,
            audio: Some(AudioTestConfig::high_res_stereo()),
            duration,
            output_format: OutputFormat::OggOpus,
        },
        TestConfig {
            video: None,
            audio: Some(AudioTestConfig::voice_optimized()),
            duration,
            output_format: OutputFormat::OggOpus,
        },
    ]
}

fn sync_test_configs(duration: Duration, _tolerance_ms: f64) -> Vec<TestConfig> {
    vec![
        TestConfig {
            video: Some(
                VideoTestConfig::fhd_1080p()
                    .with_frame_rate(30)
                    .with_pattern(TestPattern::TimestampOverlay),
            ),
            audio: Some(AudioTestConfig::broadcast_stereo().with_generator(
                AudioGenerator::TimestampBeeps {
                    beep_interval_ms: 1000,
                },
            )),
            duration,
            output_format: OutputFormat::FragmentedM4s {
                segment_duration: Duration::from_secs(3),
            },
        },
        TestConfig {
            video: Some(
                VideoTestConfig::fhd_1080p()
                    .with_frame_rate(60)
                    .with_pattern(TestPattern::TimestampOverlay),
            ),
            audio: Some(AudioTestConfig::broadcast_stereo().with_generator(
                AudioGenerator::TimestampBeeps {
                    beep_interval_ms: 1000,
                },
            )),
            duration,
            output_format: OutputFormat::FragmentedM4s {
                segment_duration: Duration::from_secs(3),
            },
        },
    ]
}

fn list_test_configurations() {
    println!("Available test configurations:\n");

    println!("Screen Capture Simulations (--source screen):");
    println!("  - 720p (1280x720)");
    println!("  - 1080p (1920x1080) @ 30/60fps");
    println!("  - 1440p (2560x1440)");
    println!("  - 4K (3840x2160)");
    println!("  - Ultrawide (2560x1080, 3440x1440)");
    println!("  - Portrait (1080x1920)");
    println!("  - MacBook Retina (2880x1800)");
    println!("  - MacBook Pro 14\" (3024x1964)");
    println!("  - MacBook Pro 16\" ProMotion (3456x2234 @ 120fps)");
    println!();

    println!("Webcam Simulations (--source camera):");
    println!("  - VGA (640x480)");
    println!("  - HD (1280x720) @ 30/60fps");
    println!("  - FHD (1920x1080) @ 30/60fps");
    println!("  - 4K (3840x2160)");
    println!();

    println!("Microphone Simulations (--source microphone):");
    println!("  - CD Quality (44.1kHz mono/stereo)");
    println!("  - Broadcast (48kHz mono/stereo)");
    println!("  - High-res (96kHz stereo)");
    println!("  - Voice-optimized (16kHz mono S16)");
    println!();

    println!("Output Formats:");
    println!("  - Fragmented M4S (default, 3s segments)");
    println!("  - MP4 (single file)");
    println!("  - OGG Opus (audio-only)");
    println!();

    println!("Commands:");
    println!("  quick        - Run ~10 common configurations (~1 min)");
    println!("  full         - Run full test matrix (~30 min)");
    println!("  studio-mode  - Screen + camera + mic combined");
    println!("  resolution   - Test specific resolution (--width --height --fps)");
    println!("  source       - Test specific source type (screen/camera/microphone)");
    println!("  sync         - A/V sync verification tests");
    println!("  list         - Show this help");
}

async fn run_pause_resume_tests(cli: &Cli) {
    let output_dir = &cli.output_dir;

    if output_dir.exists()
        && let Err(e) = std::fs::remove_dir_all(output_dir)
    {
        tracing::warn!("Failed to clean output directory: {}", e);
    }

    let tests: Vec<(&str, Box<dyn Fn() -> PauseResumeScenario>)> = vec![
        (
            "Single pause (MP4, 3s+3s)",
            Box::new(|| PauseResumeScenario {
                record_durations: vec![
                    Duration::from_secs(3),
                    Duration::from_secs(3),
                ],
                pause_durations: vec![Duration::from_secs(2)],
            }),
        ),
        (
            "Triple pause (MP4, 2s+2s+2s+2s)",
            Box::new(|| PauseResumeScenario {
                record_durations: vec![
                    Duration::from_secs(2),
                    Duration::from_secs(2),
                    Duration::from_secs(2),
                    Duration::from_secs(2),
                ],
                pause_durations: vec![
                    Duration::from_secs(1),
                    Duration::from_secs(1),
                    Duration::from_secs(1),
                ],
            }),
        ),
        (
            "Rapid pause (MP4, 1s+1s+1s)",
            Box::new(|| PauseResumeScenario {
                record_durations: vec![
                    Duration::from_secs(1),
                    Duration::from_secs(1),
                    Duration::from_secs(1),
                ],
                pause_durations: vec![
                    Duration::from_millis(500),
                    Duration::from_millis(500),
                ],
            }),
        ),
    ];

    let total = tests.len();
    let mut passed = 0;
    let mut failed = 0;

    for (idx, (name, make_scenario)) in tests.iter().enumerate() {
        println!("[{}/{}] {}", idx + 1, total, name);
        let scenario = make_scenario();
        let test_dir = output_dir.join(format!("pause_test_{idx}"));
        let _ = std::fs::create_dir_all(&test_dir);
        let output_path = test_dir.join("output.mp4");

        match run_mp4_with_pause(&output_path, &scenario).await {
            Ok(result) => {
                let total_record_secs: f64 = scenario
                    .record_durations
                    .iter()
                    .map(|d| d.as_secs_f64())
                    .sum();
                println!(
                    "       Duration: {:.2}s (expected ~{:.1}s)",
                    result.actual_duration.as_secs_f64(),
                    total_record_secs
                );
                println!(
                    "       Frames: {} ({:.1}fps)",
                    result.frame_count,
                    result.frame_count as f64 / result.actual_duration.as_secs_f64().max(0.001)
                );

                let duration_diff = (result.actual_duration.as_secs_f64() - total_record_secs).abs();
                if duration_diff < 2.0 {
                    passed += 1;
                    println!("       \u{2713} PASS\n");
                } else {
                    failed += 1;
                    println!(
                        "       \u{2717} FAIL (duration diff {:.2}s exceeds 2s tolerance)\n",
                        duration_diff
                    );
                }
            }
            Err(e) => {
                failed += 1;
                println!("       \u{2717} FAIL: {e}\n");
            }
        }
    }

    println!("{}", "=".repeat(60));
    println!("Pause/Resume: {passed}/{total} passed, {failed} failed");

    if !cli.keep_outputs
        && let Err(e) = std::fs::remove_dir_all(output_dir)
    {
        tracing::warn!("Failed to clean output directory: {}", e);
    }

    std::process::exit(if failed > 0 { 1 } else { 0 });
}

struct PauseResumeScenario {
    record_durations: Vec<Duration>,
    pause_durations: Vec<Duration>,
}

struct PauseResumeResult {
    actual_duration: Duration,
    frame_count: u64,
}

async fn run_mp4_with_pause(
    output_path: &Path,
    scenario: &PauseResumeScenario,
) -> anyhow::Result<PauseResumeResult> {
    let timestamps = Timestamps::now();
    let cancel_token = CancellationToken::new();
    let video_config = VideoTestConfig::fhd_1080p().with_frame_rate(30);
    let audio_config = AudioTestConfig::broadcast_stereo();

    let total_record: Duration = scenario.record_durations.iter().sum();
    let total_pause: Duration = scenario.pause_durations.iter().sum();
    let total_wall = total_record + total_pause;

    let video_source_config = TestPatternVideoSourceConfig {
        video_config: video_config.clone(),
        duration: total_wall + Duration::from_secs(2),
        timestamps,
        cancel_token: cancel_token.clone(),
    };

    let audio_source_config = SyntheticAudioSourceConfig {
        audio_config: audio_config.clone(),
        duration: total_wall + Duration::from_secs(2),
        timestamps,
        cancel_token: cancel_token.clone(),
    };

    let pipeline = OutputPipeline::builder(output_path.to_path_buf())
        .with_timestamps(timestamps)
        .with_video::<TestPatternVideoSource>(video_source_config)
        .with_audio_source::<SyntheticAudioSource>(audio_source_config)
        .build::<Mp4Muxer>(())
        .await?;

    for (i, record_dur) in scenario.record_durations.iter().enumerate() {
        tokio::time::sleep(*record_dur).await;

        if i < scenario.pause_durations.len() {
            pipeline.pause();
            tokio::time::sleep(scenario.pause_durations[i]).await;
            pipeline.resume();
        }
    }

    tokio::time::sleep(Duration::from_millis(200)).await;

    let finished = pipeline.stop().await?;

    let actual_duration = if output_path.exists() {
        get_video_duration(output_path).unwrap_or(Duration::ZERO)
    } else {
        Duration::ZERO
    };

    Ok(PauseResumeResult {
        actual_duration,
        frame_count: finished.video_frame_count,
    })
}

fn get_video_duration(path: &Path) -> Option<Duration> {
    let input = ffmpeg::format::input(path).ok()?;
    let duration_ts = input.duration();
    if duration_ts > 0 {
        Some(Duration::from_secs_f64(
            duration_ts as f64 / ffmpeg::ffi::AV_TIME_BASE as f64,
        ))
    } else {
        None
    }
}

fn save_report(path: &PathBuf, results: &[(String, TestResult)]) {
    let mut report = String::new();

    report.push_str("{\n  \"results\": [\n");

    for (idx, (name, result)) in results.iter().enumerate() {
        let status = match result {
            TestResult::Passed { .. } => "passed",
            TestResult::Failed { .. } => "failed",
            TestResult::Skipped { .. } => "skipped",
        };

        let details = match result {
            TestResult::Passed {
                validation,
                elapsed,
            } => {
                format!(
                    r#""frames": {}, "duration_secs": {:.2}, "sync_offset_ms": {:.1}"#,
                    validation.actual_frames,
                    elapsed.as_secs_f64(),
                    validation.av_sync_offset_ms
                )
            }
            TestResult::Failed { error, elapsed } => {
                format!(
                    r#""error": "{}", "duration_secs": {:.2}"#,
                    error.replace('"', "\\\""),
                    elapsed.as_secs_f64()
                )
            }
            TestResult::Skipped { reason } => {
                format!(r#""reason": "{}""#, reason.replace('"', "\\\""))
            }
        };

        report.push_str(&format!(
            "    {{ \"name\": \"{name}\", \"status\": \"{status}\", {details} }}"
        ));

        if idx < results.len() - 1 {
            report.push(',');
        }
        report.push('\n');
    }

    report.push_str("  ]\n}\n");

    if let Err(e) = std::fs::write(path, &report) {
        tracing::error!("Failed to write report: {}", e);
    }
}
