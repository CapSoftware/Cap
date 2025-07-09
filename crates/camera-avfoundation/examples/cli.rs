use cap_camera_avfoundation::{YCbCrMatrix, list_video_devices};
use cidre::*;
use clap::{Args, Parser, Subcommand};
use inquire::Select;
use std::{fmt::Display, ops::Deref};

#[derive(Parser)]
struct Cli {
    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand)]
enum Commands {
    /// Print details of a device
    Device,
}

pub fn main() {
    let devices = list_video_devices();
    let devices = devices
        .iter()
        .map(CaptureDeviceSelectOption)
        .collect::<Vec<_>>();

    let selected = Select::new("Select a device", devices).prompt().unwrap();

    println!(
        "Info for device '{}'",
        selected.localized_name().to_string()
    );

    let formats = selected.formats();
    println!("Formats: {}", formats.len());

    for (i, format) in formats.iter().enumerate() {
        let desc = format.format_desc();

        println!("Format {i}:");
        println!(
            "  Dimensions: {}x{}",
            desc.dimensions().width,
            desc.dimensions().height
        );
        println!(
            "  Pixel format: {}",
            four_cc_to_string(desc.media_sub_type().to_be_bytes())
        );

        let color_space = desc
            .ext(cm::FormatDescExtKey::ycbcr_matrix())
            .map(|v| {
                v.try_as_string()
                    .and_then(|v| YCbCrMatrix::try_from(v).ok())
            })
            .unwrap_or(Some(YCbCrMatrix::Rec601));
        println!(
            "  Color space: {}",
            color_space
                .map(|v| v.to_string())
                .unwrap_or("Unknown".to_string())
        );

        let fr_ranges = format.video_supported_frame_rate_ranges();
        println!("  Frame Rate Ranges: {}", fr_ranges.len());

        for fr_range in fr_ranges.iter() {
            println!(
                "    Min: {} ({}/{})",
                fr_range.min_frame_rate(),
                fr_range.min_frame_duration().scale,
                fr_range.min_frame_duration().value
            );
            println!(
                "    Max: {} ({}/{})",
                fr_range.max_frame_rate(),
                fr_range.max_frame_duration().scale,
                fr_range.max_frame_duration().value
            );
        }
    }
}

struct CaptureDeviceSelectOption<'a>(&'a av::CaptureDevice);

impl<'a> Display for CaptureDeviceSelectOption<'a> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.0.localized_name().to_string())
    }
}

impl AsRef<av::CaptureDevice> for CaptureDeviceSelectOption<'_> {
    fn as_ref(&self) -> &av::CaptureDevice {
        &self.0
    }
}

impl Deref for CaptureDeviceSelectOption<'_> {
    type Target = av::CaptureDevice;

    fn deref(&self) -> &Self::Target {
        &self.0
    }
}
