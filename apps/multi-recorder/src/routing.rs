use anyhow::{Context, Result, bail};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use cap_recording::OutputPipeline;
use cap_recording::feeds::microphone::{
    Lock, MicrophoneFeed as RecordingMicrophoneFeed, MicrophoneFeedLock, SetInput,
};
use cap_timestamp::Timestamps;
use futures::future::BoxFuture;
use kameo::Actor;

use crate::config::{InputConfig, MicrophoneInputConfig, parse_input_config};
use crate::sources::display::Display;
use crate::sources::microphone::Microphone;
use crate::{InputDecl, OutputDecl};

#[derive(Debug)]
pub struct Routing {
    pub inputs: HashMap<String, InputConfig>,
    pub outputs: HashMap<PathBuf, OutputConfig>,
}

#[derive(Debug)]
pub struct OutputConfig {
    #[allow(dead_code)]
    pub path: PathBuf,
    pub video_input: Option<String>,
    pub audio_inputs: Vec<String>,
}

pub fn cli_routing_to_routing(
    input_decls: Vec<InputDecl>,
    output_decls: Vec<OutputDecl>,
) -> Result<Routing> {
    let mut inputs = HashMap::new();

    for decl in &input_decls {
        let config = parse_input_config(&decl.name, decl.input_type, decl.options.as_deref())?;
        inputs.insert(decl.name.clone(), config);
    }

    let mut outputs = HashMap::new();
    for decl in output_decls {
        let mut video_input = None;
        let mut audio_inputs = Vec::new();

        for input_name in &decl.inputs {
            let input_config = inputs.get(input_name).with_context(|| {
                format!(
                    "Unknown input '{}' in output '{}'",
                    input_name,
                    decl.path.display()
                )
            })?;

            match input_config {
                InputConfig::Display(_) | InputConfig::Camera(_) | InputConfig::Window(_) => {
                    if video_input.is_some() {
                        bail!("Output '{}' has multiple video inputs", decl.path.display());
                    }
                    video_input = Some(input_name.clone());
                }
                InputConfig::Microphone(_) => {
                    audio_inputs.push(input_name.clone());
                }
            }
        }

        outputs.insert(
            decl.path.clone(),
            OutputConfig {
                path: decl.path.clone(),
                video_input,
                audio_inputs,
            },
        );
    }

    validate_routing(&inputs, &outputs)?;

    Ok(Routing { inputs, outputs })
}

fn validate_routing(
    inputs: &HashMap<String, InputConfig>,
    outputs: &HashMap<PathBuf, OutputConfig>,
) -> Result<()> {
    if inputs.is_empty() {
        bail!("At least one input must be specified");
    }

    for (input_name, _) in inputs {
        let used_in_output = outputs.values().any(|output| {
            output.video_input.as_ref() == Some(input_name)
                || output.audio_inputs.contains(input_name)
        });

        if !used_in_output {
            bail!("Input '{}' is not used in any output", input_name);
        }
    }

    for (path, output) in outputs {
        if output.video_input.is_none() && output.audio_inputs.is_empty() {
            bail!("Output '{}' has no inputs", path.display());
        }
    }

    Ok(())
}

pub async fn initialize_microphone_feeds(
    inputs: &HashMap<String, InputConfig>,
) -> Result<HashMap<String, Arc<MicrophoneFeedLock>>> {
    let mut feeds = HashMap::new();

    for (input_name, input_config) in inputs {
        if let InputConfig::Microphone(cfg) = input_config {
            let feed_lock = create_microphone_feed(cfg).await?;
            feeds.insert(input_name.clone(), feed_lock);
        }
    }

    Ok(feeds)
}

async fn create_microphone_feed(config: &MicrophoneInputConfig) -> Result<Arc<MicrophoneFeedLock>> {
    let (error_tx, _error_rx) = flume::unbounded();

    let feed = RecordingMicrophoneFeed::new(error_tx);
    let feed_ref = <RecordingMicrophoneFeed as Actor>::spawn(feed);

    let label = config.label.clone().unwrap_or_else(|| {
        RecordingMicrophoneFeed::default()
            .map(|(name, _, _)| name)
            .unwrap_or_else(|| "default".to_string())
    });

    let ready_future: BoxFuture<'static, Result<_, _>> =
        match feed_ref.ask(SetInput { label }).await {
            Ok(future) => future,
            Err(e) => bail!("Failed to send SetInput: {e}"),
        };

    ready_future
        .await
        .map_err(|e| anyhow::anyhow!("SetInput error: {e}"))?;

    let feed_lock = feed_ref
        .ask(Lock)
        .await
        .map_err(|e| anyhow::anyhow!("Failed to lock microphone feed: {e}"))?;

    Ok(Arc::new(feed_lock))
}

pub async fn create_output_pipeline(
    output_path: PathBuf,
    output_config: &OutputConfig,
    input_configs: &HashMap<String, InputConfig>,
    microphone_feeds: &HashMap<String, Arc<MicrophoneFeedLock>>,
    start_time: Timestamps,
) -> Result<OutputPipeline> {
    if let Some(video_input_name) = &output_config.video_input {
        let input_config = &input_configs[video_input_name];

        let mut builder = match input_config {
            InputConfig::Display(cfg) => {
                OutputPipeline::builder(output_path.clone()).with_video::<Display>(cfg.clone())
            }
            InputConfig::Camera(_cfg) => {
                bail!("Camera input not yet implemented");
            }
            InputConfig::Window(_cfg) => {
                bail!("Window input not yet implemented");
            }
            InputConfig::Microphone(_) => unreachable!(),
        };

        for audio_input_name in &output_config.audio_inputs {
            if let Some(mic_feed) = microphone_feeds.get(audio_input_name) {
                builder = builder.with_audio_source::<Microphone>(mic_feed.clone());
            }
        }

        builder.set_timestamps(start_time);

        #[cfg(target_os = "macos")]
        {
            use cap_recording::output_pipeline::AVFoundationMp4Muxer;
            builder
                .build::<AVFoundationMp4Muxer>(Default::default())
                .await
        }

        #[cfg(windows)]
        {
            bail!("Windows platform not yet implemented");
        }

        #[cfg(not(any(target_os = "macos", windows)))]
        {
            bail!("Unsupported platform");
        }
    } else {
        bail!("Audio-only outputs not yet implemented");
    }
}
