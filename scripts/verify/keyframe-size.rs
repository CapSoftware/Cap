use cap_enc_ffmpeg::h264::{H264EncoderBuilder, H264Preset};
use cap_media_info::VideoInfo;
use ffmpeg::{Rational, format::Pixel, frame};
use std::{
    error::Error,
    io::Write,
    time::{Duration, Instant},
};

fn main() -> Result<(), Box<dyn Error>> {
    let args: Vec<String> = std::env::args().collect();
    let codec = args.get(1).ok_or("codec")?;
    let step: u64 = args.get(2).ok_or("step")?.parse()?;
    let seconds: u64 = args.get(3).ok_or("seconds")?.parse()?;
    let codecs: &'static [&'static str] = match codec.as_str() {
        "libx264" => &["libx264"],
        "h264_videotoolbox" => &["h264_videotoolbox"],
        _ => return Err("unsupported codec".into()),
    };
    ffmpeg::init()?;
    ffmpeg::log::set_level(ffmpeg::log::Level::Error);
    let info = VideoInfo {
        pixel_format: Pixel::NV12,
        width: 1920,
        height: 1080,
        time_base: Rational(1, 1_000_000),
        frame_rate: Rational(30, 1),
    };
    let started = Instant::now();
    let mut encoder = H264EncoderBuilder::new(info)
        .with_preset(H264Preset::Ultrafast)
        .with_encoder_priority_override(codecs)
        .build_standalone()?;
    if encoder.codec_name() != codec {
        return Err("requested encoder unavailable".into());
    }
    let time_base = encoder.time_base();
    let mut frames = Vec::new();
    for index in 0..30_u32 {
        let mut picture = frame::Video::new(Pixel::NV12, 1920, 1080);
        for plane in 0..picture.planes() {
            let stride = picture.stride(plane);
            let data = picture.data_mut(plane);
            for (offset, byte) in data.iter_mut().enumerate() {
                let x = offset % stride;
                let y = offset / stride;
                *byte = if plane == 0 {
                    (16 + ((x / 32 + y / 32 + index as usize) % 14) * 16) as u8
                } else {
                    128
                };
            }
        }
        frames.push(picture);
    }
    let mut output = args.get(4).map(std::fs::File::create).transpose()?;
    let mut packets = 0_u64;
    let mut bytes = 0_u64;
    let mut keys = Vec::new();
    let mut converted = None;
    for slot in (0..seconds * 30).step_by(step as usize) {
        let picture = &mut frames[(slot % 30) as usize];
        encoder.encode_frame_reusable(
            picture,
            &mut converted,
            Duration::from_nanos(slot * 1_000_000_000 / 30),
            |packet| {
                if let Some(output) = &mut output {
                    output
                        .write_all(&packet.data)
                        .expect("write encoded packet");
                }
                packets += 1;
                bytes += packet.data.len() as u64;
                if packet.is_keyframe {
                    keys.push(
                        packet.pts as f64 * f64::from(time_base.numerator())
                            / f64::from(time_base.denominator()),
                    );
                }
                Ok(())
            },
        )?;
    }
    encoder.flush(|packet| {
        if let Some(output) = &mut output {
            output
                .write_all(&packet.data)
                .expect("write encoded packet");
        }
        packets += 1;
        bytes += packet.data.len() as u64;
        if packet.is_keyframe {
            keys.push(
                packet.pts as f64 * f64::from(time_base.numerator())
                    / f64::from(time_base.denominator()),
            );
        }
        Ok(())
    })?;
    println!(
        "{}",
        serde_json::json!({"codec":encoder.codec_name(), "extradata":encoder.extradata(), "step":step, "seconds":seconds, "packets":packets, "bytes":bytes, "keys":keys, "wall_seconds":started.elapsed().as_secs_f64()})
    );
    Ok(())
}
