use cap_media::diagnostics::SystemDiagnostics;
use clap::Parser;
use std::path::PathBuf;

#[derive(Parser, Debug)]
#[command(author, version, about, long_about = None)]
struct Args {
    /// Output file path for diagnostics JSON
    #[arg(short, long, default_value = "diagnostics.json")]
    output: PathBuf,

    /// Print diagnostics to stdout as well
    #[arg(short, long)]
    print: bool,
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    // Initialize logging
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .init();

    let args = Args::parse();

    println!("Collecting system diagnostics...");

    let diagnostics = SystemDiagnostics::collect().await?;

    // Save to file
    let json = diagnostics.to_json()?;
    std::fs::write(&args.output, &json)?;

    println!("Diagnostics saved to: {}", args.output.display());

    if args.print {
        println!("\n{}", json);
    }

    // Print summary
    println!("\nSummary:");
    println!(
        "  OS: {} {} ({})",
        diagnostics.os.name, diagnostics.os.version, diagnostics.os.arch
    );
    println!(
        "  CPU: {} ({} cores)",
        diagnostics.hardware.cpu_model, diagnostics.hardware.cpu_cores
    );
    println!("  Memory: {:.1} GB", diagnostics.hardware.total_memory_gb);
    println!("  Video Devices: {}", diagnostics.video_devices.len());
    println!(
        "  Audio Input Devices: {}",
        diagnostics.audio_devices.input_devices.len()
    );
    println!("  Displays: {}", diagnostics.displays.len());

    Ok(())
}
