use anyhow::{Context, Result, bail};
use std::path::PathBuf;

mod config;
mod routing;
mod sources;

use cap_timestamp::Timestamps;

#[tokio::main]
async fn main() -> Result<()> {
    unsafe {
        std::env::set_var("RUST_LOG", "trace");
    }

    let cli_config = parse_cli_args()?;

    match cli_config {
        CliConfig::Routing { inputs, outputs } => {
            println!("Parsed CLI routing mode:");
            println!("Inputs: {:#?}", inputs);
            println!("Outputs: {:#?}", outputs);

            let routing = routing::cli_routing_to_routing(inputs, outputs)?;
            println!("Generated routing: {:#?}", routing);

            println!("Initializing microphone feeds...");
            let microphone_feeds = routing::initialize_microphone_feeds(&routing.inputs).await?;
            println!("Initialized {} microphone feed(s)", microphone_feeds.len());

            let start_time = Timestamps::now();

            let mut pipelines = Vec::new();
            for (output_path, output_config) in &routing.outputs {
                let pipeline = routing::create_output_pipeline(
                    output_path.clone(),
                    output_config,
                    &routing.inputs,
                    &microphone_feeds,
                    start_time,
                )
                .await?;
                pipelines.push(pipeline);
            }

            println!("Recording started. Press Ctrl+C to stop...");

            tokio::signal::ctrl_c().await?;

            println!("Stopping recording...");

            for pipeline in pipelines {
                pipeline.stop().await?;
            }

            println!("Recording finished");
        }
        CliConfig::File(path) => {
            println!("Config file mode: {}", path.display());
            bail!("File config mode not yet implemented");
        }
    }

    Ok(())
}

#[derive(Debug, Clone)]
struct InputDecl {
    name: String,
    input_type: InputType,
    options: Option<String>,
}

#[derive(Debug, Clone)]
struct OutputDecl {
    path: PathBuf,
    inputs: Vec<String>,
}

#[derive(Debug)]
enum CliConfig {
    Routing {
        inputs: Vec<InputDecl>,
        outputs: Vec<OutputDecl>,
    },
    File(PathBuf),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum InputType {
    Display,
    Camera,
    Microphone,
    Window,
}

fn parse_input_type(s: &str) -> Result<InputType> {
    match s {
        "display" => Ok(InputType::Display),
        "camera" => Ok(InputType::Camera),
        "microphone" => Ok(InputType::Microphone),
        "window" => Ok(InputType::Window),
        _ => bail!("Unknown input type: {}", s),
    }
}

fn parse_cli_args() -> Result<CliConfig> {
    let args: Vec<String> = std::env::args().collect();

    let mut inputs = Vec::new();
    let mut outputs = Vec::new();
    let mut i = 1;

    while i < args.len() {
        match args[i].as_str() {
            "--input" => {
                let name = args.get(i + 1).context("--input requires NAME")?.clone();

                let type_flag = args.get(i + 2).context("--input requires --type")?;

                if type_flag != "--type" {
                    bail!("--input must be followed by --type");
                }

                let input_type_str = args.get(i + 3).context("--type requires TYPE")?;

                let input_type = parse_input_type(input_type_str)?;

                let mut options = None;
                let mut consumed = 4;

                if i + 4 < args.len() && args[i + 4] == "--options" {
                    if i + 5 < args.len() {
                        options = Some(args[i + 5].clone());
                        consumed = 6;
                    } else {
                        bail!("--options requires JSON5 string");
                    }
                }

                inputs.push(InputDecl {
                    name,
                    input_type,
                    options,
                });

                i += consumed;
            }
            "--output" => {
                let path = args.get(i + 1).context("--output requires PATH")?.clone();

                let mut input_names = Vec::new();
                let mut j = i + 2;

                while j < args.len() && !args[j].starts_with("--") {
                    input_names.push(args[j].clone());
                    j += 1;
                }

                if input_names.is_empty() {
                    bail!("--output requires at least one input name");
                }

                outputs.push(OutputDecl {
                    path: PathBuf::from(path),
                    inputs: input_names,
                });

                i = j;
            }
            _ => {
                // Check if it's a config file (positional arg)
                if !args[i].starts_with("--") {
                    return Ok(CliConfig::File(PathBuf::from(&args[i])));
                }
                bail!("Unknown argument: {}", args[i]);
            }
        }
    }

    Ok(CliConfig::Routing { inputs, outputs })
}
