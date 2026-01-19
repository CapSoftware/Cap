use anyhow::Result;
use cpal::traits::{DeviceTrait, HostTrait};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DiscoveredAudioInput {
    pub id: String,
    pub name: String,
    pub sample_rates: Vec<u32>,
    pub channels: u16,
    pub is_bluetooth: bool,
    pub is_usb: bool,
    pub is_builtin: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DiscoveredAudioOutput {
    pub id: String,
    pub name: String,
    pub sample_rates: Vec<u32>,
    pub channels: u16,
    pub is_default: bool,
}

pub fn discover_audio_devices() -> Result<(Vec<DiscoveredAudioInput>, Vec<DiscoveredAudioOutput>)> {
    let host = cpal::default_host();

    let mut inputs = Vec::new();
    let mut outputs = Vec::new();

    let default_input = host.default_input_device();
    let default_output = host.default_output_device();

    let _default_input_name = default_input.as_ref().and_then(|d| d.name().ok());
    let default_output_name = default_output.as_ref().and_then(|d| d.name().ok());

    if let Ok(devices) = host.input_devices() {
        for device in devices {
            if let Ok(name) = device.name() {
                let configs: Vec<_> = device
                    .supported_input_configs()
                    .map(|c| c.collect())
                    .unwrap_or_default();

                let sample_rates = extract_sample_rates(&configs);
                let channels = configs.first().map(|c| c.channels()).unwrap_or(1);

                let is_bluetooth = is_bluetooth_device(&name);
                let is_usb = is_usb_device(&name);
                let is_builtin = is_builtin_device(&name);

                inputs.push(DiscoveredAudioInput {
                    id: name.clone(),
                    name: name.clone(),
                    sample_rates,
                    channels,
                    is_bluetooth,
                    is_usb,
                    is_builtin,
                });
            }
        }
    }

    if let Ok(devices) = host.output_devices() {
        for device in devices {
            if let Ok(name) = device.name() {
                let configs: Vec<_> = device
                    .supported_output_configs()
                    .map(|c| c.collect())
                    .unwrap_or_default();

                let sample_rates = extract_sample_rates(&configs);
                let channels = configs.first().map(|c| c.channels()).unwrap_or(2);

                let is_default = default_output_name
                    .as_ref()
                    .map(|n| n == &name)
                    .unwrap_or(false);

                outputs.push(DiscoveredAudioOutput {
                    id: name.clone(),
                    name: name.clone(),
                    sample_rates,
                    channels,
                    is_default,
                });
            }
        }
    }

    Ok((inputs, outputs))
}

fn extract_sample_rates(configs: &[cpal::SupportedStreamConfigRange]) -> Vec<u32> {
    let common_rates = [8000, 16000, 22050, 44100, 48000, 96000, 192000];
    let mut supported = Vec::new();

    for config in configs {
        let min = config.min_sample_rate().0;
        let max = config.max_sample_rate().0;

        for &rate in &common_rates {
            if rate >= min && rate <= max && !supported.contains(&rate) {
                supported.push(rate);
            }
        }
    }

    supported.sort_unstable();
    supported
}

fn is_bluetooth_device(name: &str) -> bool {
    let lower = name.to_lowercase();
    lower.contains("bluetooth")
        || lower.contains("airpods")
        || lower.contains("beats")
        || lower.contains("bose")
        || lower.contains("sony wh")
        || lower.contains("sony wf")
        || lower.contains("jabra")
        || lower.contains("jbl")
}

fn is_usb_device(name: &str) -> bool {
    let lower = name.to_lowercase();
    lower.contains("usb")
        || lower.contains("blue yeti")
        || lower.contains("snowball")
        || lower.contains("rode")
        || lower.contains("focusrite")
        || lower.contains("scarlett")
        || lower.contains("audio-technica")
        || lower.contains("shure")
        || lower.contains("elgato wave")
}

fn is_builtin_device(name: &str) -> bool {
    let lower = name.to_lowercase();
    lower.contains("macbook")
        || lower.contains("built-in")
        || lower.contains("builtin")
        || lower.contains("internal")
        || lower.contains("realtek")
        || lower.contains("conexant")
}
