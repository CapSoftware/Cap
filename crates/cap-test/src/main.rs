use anyhow::Result;
use clap::{Parser, Subcommand};
use std::path::PathBuf;
use tracing_subscriber::{EnvFilter, fmt, prelude::*};

mod config;
mod discovery;
mod matrix;
mod results;
mod suites;

use config::TestConfig;
use discovery::DiscoveredHardware;
use matrix::MatrixRunner;
#[allow(unused_imports)]
use results::{ResultsSummary, TestResults};

#[derive(Parser)]
#[command(name = "cap-test")]
#[command(about = "Unified testing harness for Cap", long_about = None)]
struct Cli {
    #[command(subcommand)]
    command: Commands,

    #[arg(long, global = true, default_value = "info")]
    log_level: String,
}

#[derive(Subcommand)]
enum Commands {
    Discover {
        #[arg(long)]
        json: bool,
    },

    Matrix {
        #[arg(short, long)]
        config: Option<PathBuf>,

        #[arg(long)]
        quick: bool,

        #[arg(long)]
        exhaustive: bool,

        #[arg(short, long)]
        output: Option<PathBuf>,
    },

    Suite {
        name: String,

        #[arg(short, long)]
        output: Option<PathBuf>,

        #[arg(long, default_value = "10")]
        duration: u64,
    },

    Synthetic {
        #[arg(short, long)]
        config: Option<PathBuf>,

        #[arg(short, long)]
        output: Option<PathBuf>,
    },

    Benchmark {
        #[arg(long, default_value = "30")]
        duration: u64,

        #[arg(long, default_value = "5")]
        warmup: u64,

        #[arg(short, long)]
        output: Option<PathBuf>,
    },

    Validate {
        path: PathBuf,

        #[arg(long)]
        json: bool,
    },

    Compare {
        current: PathBuf,
        baseline: PathBuf,
    },

    Report {
        results: PathBuf,
    },
}

#[tokio::main]
async fn main() -> Result<()> {
    let cli = Cli::parse();

    tracing_subscriber::registry()
        .with(fmt::layer())
        .with(EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new(&cli.log_level)))
        .init();

    match cli.command {
        Commands::Discover { json } => {
            cmd_discover(json).await?;
        }

        Commands::Matrix {
            config,
            quick,
            exhaustive,
            output,
        } => {
            cmd_matrix(config, quick, exhaustive, output).await?;
        }

        Commands::Suite {
            name,
            output,
            duration,
        } => {
            cmd_suite(&name, duration, output).await?;
        }

        Commands::Synthetic { config, output } => {
            cmd_synthetic(config, output).await?;
        }

        Commands::Benchmark {
            duration,
            warmup,
            output,
        } => {
            cmd_benchmark(duration, warmup, output).await?;
        }

        Commands::Validate { path, json } => {
            cmd_validate(path, json).await?;
        }

        Commands::Compare { current, baseline } => {
            cmd_compare(current, baseline).await?;
        }

        Commands::Report { results } => {
            cmd_report(results).await?;
        }
    }

    Ok(())
}

async fn cmd_discover(json_output: bool) -> Result<()> {
    let hardware = DiscoveredHardware::discover().await?;

    if json_output {
        println!("{}", serde_json::to_string_pretty(&hardware)?);
    } else {
        hardware.print_summary();
    }

    Ok(())
}

async fn cmd_matrix(
    config_path: Option<PathBuf>,
    quick: bool,
    exhaustive: bool,
    output: Option<PathBuf>,
) -> Result<()> {
    let config = if quick {
        TestConfig::quick()
    } else if exhaustive {
        TestConfig::exhaustive()
    } else if let Some(path) = config_path {
        TestConfig::load(&path)?
    } else {
        TestConfig::standard()
    };

    let hardware = DiscoveredHardware::discover().await?;
    let runner = MatrixRunner::new(config, hardware);
    let results = runner.run().await?;

    results.print_summary();

    if let Some(path) = output {
        results.save_json(&path)?;
        println!("\nResults saved to: {}", path.display());
    }

    Ok(())
}

async fn cmd_suite(name: &str, duration: u64, output: Option<PathBuf>) -> Result<()> {
    let hardware = DiscoveredHardware::discover().await?;

    let results = match name {
        "recording" => suites::run_recording_suite(&hardware, duration).await?,
        "encoding" => suites::run_encoding_suite(&hardware, duration).await?,
        "playback" => suites::run_playback_suite(&hardware, duration).await?,
        "sync" => suites::run_sync_suite(&hardware, duration).await?,
        _ => {
            anyhow::bail!(
                "Unknown suite: {}. Available: recording, encoding, playback, sync",
                name
            );
        }
    };

    results.print_summary();

    if let Some(path) = output {
        results.save_json(&path)?;
    }

    Ok(())
}

async fn cmd_synthetic(config_path: Option<PathBuf>, output: Option<PathBuf>) -> Result<()> {
    let config = if let Some(path) = config_path {
        TestConfig::load(&path)?
    } else {
        TestConfig::synthetic()
    };

    let runner = MatrixRunner::new_synthetic(config);
    let results = runner.run().await?;

    results.print_summary();

    if let Some(path) = output {
        results.save_json(&path)?;
    }

    Ok(())
}

async fn cmd_benchmark(duration: u64, warmup: u64, output: Option<PathBuf>) -> Result<()> {
    let hardware = DiscoveredHardware::discover().await?;
    let results = suites::run_benchmark(&hardware, duration, warmup).await?;

    results.print_summary();

    if let Some(path) = output {
        results.save_json(&path)?;
    }

    Ok(())
}

async fn cmd_validate(path: PathBuf, json_output: bool) -> Result<()> {
    let validation = suites::validate_recording(&path).await?;

    if json_output {
        println!("{}", serde_json::to_string_pretty(&validation)?);
    } else {
        validation.print_summary();
    }

    Ok(())
}

async fn cmd_compare(current: PathBuf, baseline: PathBuf) -> Result<()> {
    let current_results = TestResults::load(&current)?;
    let baseline_results = TestResults::load(&baseline)?;

    let comparison = results::compare(&current_results, &baseline_results);
    comparison.print_summary();

    Ok(())
}

async fn cmd_report(results_path: PathBuf) -> Result<()> {
    let results = TestResults::load(&results_path)?;
    results.print_detailed_report();

    Ok(())
}
