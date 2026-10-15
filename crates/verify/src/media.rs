//! Thin FFmpeg helpers used to write fixtures and read outputs. These are
//! test tools: simple, sequential and independent of the product's decoders.

use std::path::Path;

use anyhow::{Context, anyhow, bail};
use ffmpeg::{
    ChannelLayout, Dictionary, Rational,
    codec::{self, Flags as CodecFlags},
    format::{self, Pixel, Sample, sample::Type as SampleType},
    frame,
    media::Type,
    software::{resampling, scaling},
};

use crate::video_code::{PackedFrame, PixelOrder, PixelSource, Yuv420Frame};

pub fn init() {
    static ONCE: std::sync::Once = std::sync::Once::new();
    ONCE.call_once(|| {
        ffmpeg::init().expect("ffmpeg init");
        ffmpeg::util::log::set_level(ffmpeg::util::log::Level::Error);
    });
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum VideoCodec {
    H264,
    Hevc,
}

#[derive(Clone, Debug)]
pub struct VideoWriterConfig {
    pub width: u32,
    pub height: u32,
    /// Nominal frame rate written to the stream (the track's `r_frame_rate`).
    pub fps: u32,
    pub codec: VideoCodec,
    /// Distance between keyframes, in frames.
    pub gop: u32,
    pub b_frames: u32,
    /// Target bitrate in bits per second; `None` uses constant quality.
    pub bitrate: Option<u64>,
    /// Stream time base denominator (ticks per second).
    pub time_base: i32,
}

impl VideoWriterConfig {
    pub fn new(width: u32, height: u32, fps: u32) -> Self {
        Self {
            width,
            height,
            fps,
            codec: VideoCodec::H264,
            gop: fps,
            b_frames: 0,
            bitrate: None,
            time_base: 90_000,
        }
    }
}

fn find_video_encoder(codec: VideoCodec) -> anyhow::Result<ffmpeg::Codec> {
    let names: &[&str] = match codec {
        VideoCodec::H264 => &["libx264", "h264_videotoolbox", "h264_mf"],
        // The bundled FFmpeg's libx265 crashes inside avcodec after a few
        // frames, so HEVC uses the platform hardware encoders the product
        // itself uses (VideoToolbox, Media Foundation).
        VideoCodec::Hevc => &["hevc_videotoolbox", "hevc_mf"],
    };
    if let Ok(name) = std::env::var("CAP_VERIFY_FORCE_ENCODER") {
        return ffmpeg::encoder::find_by_name(&name).ok_or_else(|| anyhow!("no {name}"));
    }
    names
        .iter()
        .find_map(|name| ffmpeg::encoder::find_by_name(name))
        .ok_or_else(|| anyhow!("no encoder available for {codec:?}"))
}

/// Writes an MP4 (or MOV) with exactly the presentation timestamps given.
pub struct VideoWriter {
    output: format::context::Output,
    encoder: ffmpeg::encoder::Video,
    scaler: scaling::Context,
    yuv: frame::Video,
    rgba: frame::Video,
    encoder_time_base: Rational,
    stream_time_base: Rational,
    last_pts: Option<i64>,
    frames: u64,
}

impl VideoWriter {
    pub fn create(path: &Path, config: &VideoWriterConfig) -> anyhow::Result<Self> {
        init();
        let codec = find_video_encoder(config.codec)?;
        let mut output = format::output(&path).with_context(|| format!("open {path:?}"))?;
        let global_header = output
            .format()
            .flags()
            .contains(format::Flags::GLOBAL_HEADER);
        let time_base = Rational::new(1, config.time_base);
        let mut ctx = codec::context::Context::new_with_codec(codec);
        if codec.name() == "libx264" {
            ctx.set_threading(codec::threading::Config::count(1));
        }
        let mut enc = ctx.encoder().video()?;
        enc.set_width(config.width);
        enc.set_height(config.height);
        enc.set_format(Pixel::YUV420P);
        enc.set_time_base(time_base);
        enc.set_frame_rate(Some(Rational::new(config.fps as i32, 1)));
        enc.set_gop(config.gop);
        enc.set_max_b_frames(config.b_frames as usize);
        if let Some(bitrate) = config.bitrate {
            enc.set_bit_rate(bitrate as usize);
        }
        if global_header {
            enc.set_flags(CodecFlags::GLOBAL_HEADER);
        }
        let mut options = Dictionary::new();
        if codec.name() == "libx264" {
            options.set("preset", "ultrafast");
            options.set("x264-params", "scenecut=0:open-gop=0");
            if config.bitrate.is_none() {
                options.set("crf", "23");
            }
        }
        let encoder = enc.open_as_with(codec, options)?;
        let stream_time_base = {
            let mut stream = output.add_stream(codec)?;
            stream.set_parameters(&encoder);
            stream.set_time_base(time_base);
            stream.set_rate(Rational::new(config.fps as i32, 1));
            stream.time_base()
        };
        output.write_header()?;
        let stream_time_base = output
            .stream(0)
            .map(|s| s.time_base())
            .unwrap_or(stream_time_base);
        let scaler = scaling::Context::get(
            Pixel::RGBA,
            config.width,
            config.height,
            Pixel::YUV420P,
            config.width,
            config.height,
            scaling::Flags::BILINEAR,
        )?;
        Ok(Self {
            output,
            encoder,
            scaler,
            yuv: frame::Video::new(Pixel::YUV420P, config.width, config.height),
            rgba: frame::Video::new(Pixel::RGBA, config.width, config.height),
            encoder_time_base: time_base,
            stream_time_base,
            last_pts: None,
            frames: 0,
        })
    }

    /// Queues one RGBA picture (tightly packed) presented at `pts_secs`.
    pub fn write_rgba(&mut self, rgba: &[u8], pts_secs: f64) -> anyhow::Result<()> {
        let width = self.rgba.width() as usize;
        let height = self.rgba.height() as usize;
        let stride = self.rgba.stride(0);
        let dst = self.rgba.data_mut(0);
        for y in 0..height {
            dst[y * stride..y * stride + width * 4]
                .copy_from_slice(&rgba[y * width * 4..(y + 1) * width * 4]);
        }
        let mut yuv = frame::Video::new(Pixel::YUV420P, self.yuv.width(), self.yuv.height());
        self.scaler.run(&self.rgba, &mut yuv)?;
        let pts = (pts_secs * f64::from(self.encoder_time_base.denominator())
            / f64::from(self.encoder_time_base.numerator()))
        .round() as i64;
        if self.last_pts.is_some_and(|last| pts <= last) {
            bail!("non-increasing pts {pts_secs}");
        }
        self.last_pts = Some(pts);
        yuv.set_pts(Some(pts));
        self.encoder.send_frame(&yuv)?;
        self.frames += 1;
        self.drain()
    }

    fn drain(&mut self) -> anyhow::Result<()> {
        let mut packet = ffmpeg::Packet::empty();
        while self.encoder.receive_packet(&mut packet).is_ok() {
            packet.set_stream(0);
            packet.rescale_ts(self.encoder_time_base, self.stream_time_base);
            packet.write_interleaved(&mut self.output)?;
        }
        Ok(())
    }

    pub fn finish(mut self) -> anyhow::Result<u64> {
        self.encoder.send_eof()?;
        self.drain()?;
        self.output.write_trailer()?;
        Ok(self.frames)
    }
}

/// A decoded picture in a layout the marker reader understands.
pub struct Picture {
    pub frame: frame::Video,
    pub pts_secs: f64,
}

impl Picture {
    pub fn view(&self) -> PictureView<'_> {
        PictureView::new(&self.frame)
    }
}

pub enum PictureView<'a> {
    Yuv(Yuv420Frame<'a>),
    Packed(PackedFrame<'a>),
}

impl<'a> PictureView<'a> {
    pub fn new(frame: &'a frame::Video) -> Self {
        let width = frame.width() as usize;
        let height = frame.height() as usize;
        match frame.format() {
            Pixel::NV12 => PictureView::Yuv(Yuv420Frame {
                width,
                height,
                y: frame.data(0),
                y_stride: frame.stride(0),
                u: frame.data(1),
                u_stride: frame.stride(1),
                v: None,
            }),
            Pixel::RGBA | Pixel::BGRA => PictureView::Packed(PackedFrame {
                data: frame.data(0),
                width,
                height,
                stride: frame.stride(0),
                order: if frame.format() == Pixel::RGBA {
                    PixelOrder::Rgba
                } else {
                    PixelOrder::Bgra
                },
            }),
            _ => PictureView::Yuv(Yuv420Frame {
                width,
                height,
                y: frame.data(0),
                y_stride: frame.stride(0),
                u: frame.data(1),
                u_stride: frame.stride(1),
                v: Some((frame.data(2), frame.stride(2))),
            }),
        }
    }
}

impl PixelSource for PictureView<'_> {
    fn width(&self) -> usize {
        match self {
            PictureView::Yuv(f) => f.width(),
            PictureView::Packed(f) => f.width(),
        }
    }

    fn height(&self) -> usize {
        match self {
            PictureView::Yuv(f) => f.height(),
            PictureView::Packed(f) => f.height(),
        }
    }

    fn luma(&self, x: usize, y: usize) -> f64 {
        match self {
            PictureView::Yuv(f) => f.luma(x, y),
            PictureView::Packed(f) => f.luma(x, y),
        }
    }

    fn chroma(&self, x: usize, y: usize) -> (f64, f64) {
        match self {
            PictureView::Yuv(f) => f.chroma(x, y),
            PictureView::Packed(f) => f.chroma(x, y),
        }
    }
}

fn readable_format(format: Pixel) -> bool {
    matches!(
        format,
        Pixel::YUV420P | Pixel::YUVJ420P | Pixel::NV12 | Pixel::RGBA | Pixel::BGRA
    )
}

/// Decodes every picture of the best video stream in presentation order.
pub fn decode_video(path: &Path, mut on_picture: impl FnMut(Picture)) -> anyhow::Result<()> {
    init();
    let mut input = format::input(&path).with_context(|| format!("open {path:?}"))?;
    let stream = input
        .streams()
        .best(Type::Video)
        .ok_or_else(|| anyhow!("{path:?} has no video stream"))?;
    let index = stream.index();
    let time_base = stream.time_base();
    let mut decoder = codec::context::Context::from_parameters(stream.parameters())?
        .decoder()
        .video()?;
    let mut scaler: Option<scaling::Context> = None;
    let mut emit = |decoded: &frame::Video, scaler: &mut Option<scaling::Context>| {
        let pts = decoded.timestamp().or(decoded.pts()).unwrap_or(0);
        let pts_secs =
            pts as f64 * f64::from(time_base.numerator()) / f64::from(time_base.denominator());
        let frame = if readable_format(decoded.format()) {
            decoded.clone()
        } else {
            let s = scaler.get_or_insert_with(|| {
                scaling::Context::get(
                    decoded.format(),
                    decoded.width(),
                    decoded.height(),
                    Pixel::YUV420P,
                    decoded.width(),
                    decoded.height(),
                    scaling::Flags::POINT,
                )
                .expect("scaler")
            });
            let mut out = frame::Video::empty();
            s.run(decoded, &mut out).expect("convert picture");
            out
        };
        on_picture(Picture { frame, pts_secs });
    };
    let mut decoded = frame::Video::empty();
    for (stream, packet) in input.packets() {
        if stream.index() != index {
            continue;
        }
        decoder.send_packet(&packet)?;
        while decoder.receive_frame(&mut decoded).is_ok() {
            emit(&decoded, &mut scaler);
        }
    }
    decoder.send_eof()?;
    while decoder.receive_frame(&mut decoded).is_ok() {
        emit(&decoded, &mut scaler);
    }
    Ok(())
}

/// Packet presentation times of the best video stream, sorted.
pub fn video_packet_times(path: &Path) -> anyhow::Result<Vec<f64>> {
    init();
    let mut input = format::input(&path).with_context(|| format!("open {path:?}"))?;
    let stream = input
        .streams()
        .best(Type::Video)
        .ok_or_else(|| anyhow!("{path:?} has no video stream"))?;
    let index = stream.index();
    let tb = stream.time_base();
    let mut times: Vec<f64> = input
        .packets()
        .filter(|(s, _)| s.index() == index)
        .filter_map(|(_, p)| p.pts())
        .map(|pts| pts as f64 * f64::from(tb.numerator()) / f64::from(tb.denominator()))
        .collect();
    times.sort_by(f64::total_cmp);
    Ok(times)
}

/// Presentation times of the keyframes of the best video stream, sorted.
pub fn keyframe_times(path: &Path) -> anyhow::Result<Vec<f64>> {
    init();
    let mut input = format::input(&path).with_context(|| format!("open {path:?}"))?;
    let stream = input
        .streams()
        .best(Type::Video)
        .ok_or_else(|| anyhow!("{path:?} has no video stream"))?;
    let index = stream.index();
    let tb = stream.time_base();
    let mut times: Vec<f64> = input
        .packets()
        .filter(|(s, p)| s.index() == index && p.is_key())
        .filter_map(|(_, p)| p.pts())
        .map(|pts| pts as f64 * f64::from(tb.numerator()) / f64::from(tb.denominator()))
        .collect();
    times.sort_by(f64::total_cmp);
    Ok(times)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AudioCodec {
    Aac,
    Opus,
    Flac,
}

/// Writes mono or multichannel f32 audio (channels given separately).
pub fn write_audio(
    path: &Path,
    channels: &[Vec<f32>],
    sample_rate: u32,
    codec: AudioCodec,
    bitrate: usize,
) -> anyhow::Result<()> {
    init();
    let codec_name = match codec {
        AudioCodec::Aac => "aac",
        AudioCodec::Opus => "libopus",
        AudioCodec::Flac => "flac",
    };
    let encoder_codec =
        ffmpeg::encoder::find_by_name(codec_name).ok_or_else(|| anyhow!("no {codec_name}"))?;
    let layout = ChannelLayout::default(channels.len() as i32);
    let mut output = format::output(&path)?;
    let global_header = output
        .format()
        .flags()
        .contains(format::Flags::GLOBAL_HEADER);
    let mut enc = codec::context::Context::new_with_codec(encoder_codec)
        .encoder()
        .audio()?;
    let sample_format = encoder_codec
        .audio()
        .ok()
        .and_then(|a| a.formats().and_then(|mut f| f.next()))
        .unwrap_or(Sample::F32(SampleType::Planar));
    enc.set_rate(sample_rate as i32);
    enc.set_channel_layout(layout);
    enc.set_format(sample_format);
    enc.set_bit_rate(bitrate);
    enc.set_time_base(Rational::new(1, sample_rate as i32));
    if global_header {
        enc.set_flags(CodecFlags::GLOBAL_HEADER);
    }
    let mut encoder = enc.open_as(encoder_codec)?;
    {
        let mut stream = output.add_stream(encoder_codec)?;
        stream.set_parameters(&encoder);
        stream.set_time_base(Rational::new(1, sample_rate as i32));
    }
    output.write_header()?;
    let stream_tb = output.stream(0).map(|s| s.time_base()).unwrap();
    let frame_size = match encoder.frame_size() {
        0 => 1024,
        n => n as usize,
    };
    let mut resampler = resampling::Context::get(
        Sample::F32(SampleType::Planar),
        layout,
        sample_rate,
        sample_format,
        layout,
        sample_rate,
    )?;
    let total = channels.first().map_or(0, Vec::len);
    let mut pos = 0;
    let mut packet = ffmpeg::Packet::empty();
    let enc_tb = Rational::new(1, sample_rate as i32);
    let mut drain = |encoder: &mut ffmpeg::encoder::Audio,
                     output: &mut format::context::Output|
     -> anyhow::Result<()> {
        while encoder.receive_packet(&mut packet).is_ok() {
            packet.set_stream(0);
            packet.rescale_ts(enc_tb, stream_tb);
            packet.write_interleaved(output)?;
        }
        Ok(())
    };
    while pos < total {
        let n = frame_size.min(total - pos);
        let mut planar = frame::Audio::new(Sample::F32(SampleType::Planar), n, layout);
        planar.set_rate(sample_rate);
        for (ch, data) in channels.iter().enumerate() {
            let plane: &mut [f32] = planar.plane_mut(ch);
            plane[..n].copy_from_slice(&data[pos..pos + n]);
        }
        let mut converted = frame::Audio::empty();
        resampler.run(&planar, &mut converted)?;
        converted.set_pts(Some(pos as i64));
        converted.set_rate(sample_rate);
        encoder.send_frame(&converted)?;
        drain(&mut encoder, &mut output)?;
        pos += n;
    }
    encoder.send_eof()?;
    drain(&mut encoder, &mut output)?;
    output.write_trailer()?;
    Ok(())
}

pub struct DecodedAudio {
    pub sample_rate: u32,
    /// One vector per channel.
    pub channels: Vec<Vec<f32>>,
    /// Presentation time of the first decoded sample, in seconds.
    pub start_secs: f64,
}

impl DecodedAudio {
    pub fn mono(&self) -> Vec<f32> {
        let n = self.channels.iter().map(Vec::len).min().unwrap_or(0);
        let count = self.channels.len().max(1) as f32;
        (0..n)
            .map(|i| self.channels.iter().map(|c| c[i]).sum::<f32>() / count)
            .collect()
    }
}

/// Decodes the best audio stream (optionally resampled) to planar f32.
pub fn decode_audio(path: &Path, out_rate: Option<u32>) -> anyhow::Result<DecodedAudio> {
    init();
    let mut input = format::input(&path).with_context(|| format!("open {path:?}"))?;
    let stream = input
        .streams()
        .best(Type::Audio)
        .ok_or_else(|| anyhow!("{path:?} has no audio stream"))?;
    let index = stream.index();
    let tb = stream.time_base();
    // The container start time already accounts for encoder priming that the
    // decoder strips (Opus pre-skip, AAC edit lists); the first frame's pts
    // does not always.
    let container_start = (stream.start_time() != ffmpeg::ffi::AV_NOPTS_VALUE).then(|| {
        stream.start_time() as f64 * f64::from(tb.numerator()) / f64::from(tb.denominator())
    });
    let mut decoder = codec::context::Context::from_parameters(stream.parameters())?
        .decoder()
        .audio()?;
    let mut resampler: Option<resampling::Context> = None;
    let mut channels: Vec<Vec<f32>> = Vec::new();
    let mut start_secs = None;
    let mut rate = 0;
    let mut handle = |decoded: &frame::Audio,
                      resampler: &mut Option<resampling::Context>|
     -> anyhow::Result<()> {
        if start_secs.is_none() {
            let pts = decoded.pts().or(decoded.timestamp()).unwrap_or(0);
            start_secs = Some(pts as f64 * f64::from(tb.numerator()) / f64::from(tb.denominator()));
        }
        let target_rate = out_rate.unwrap_or(decoded.rate());
        rate = target_rate;
        let layout = if decoded.channel_layout().is_empty() {
            ChannelLayout::default(decoded.channels() as i32)
        } else {
            decoded.channel_layout()
        };
        let r = match resampler {
            Some(r) => r,
            None => resampler.insert(resampling::Context::get(
                decoded.format(),
                layout,
                decoded.rate(),
                Sample::F32(SampleType::Planar),
                layout,
                target_rate,
            )?),
        };
        let mut out = frame::Audio::empty();
        let mut input = decoded.clone();
        input.set_channel_layout(layout);
        r.run(&input, &mut out)?;
        append_planar(&mut channels, &out);
        Ok(())
    };
    let mut decoded = frame::Audio::empty();
    for (s, packet) in input.packets() {
        if s.index() != index {
            continue;
        }
        decoder.send_packet(&packet)?;
        while decoder.receive_frame(&mut decoded).is_ok() {
            handle(&decoded, &mut resampler)?;
        }
    }
    decoder.send_eof()?;
    while decoder.receive_frame(&mut decoded).is_ok() {
        handle(&decoded, &mut resampler)?;
    }
    if let Some(r) = resampler.as_mut() {
        let mut out = frame::Audio::empty();
        while r.flush(&mut out).is_ok() && out.samples() > 0 {
            append_planar(&mut channels, &out);
        }
    }
    Ok(DecodedAudio {
        sample_rate: rate,
        channels,
        start_secs: container_start.or(start_secs).unwrap_or(0.0),
    })
}

fn append_planar(channels: &mut Vec<Vec<f32>>, out: &frame::Audio) {
    let n = out.samples();
    let count = out.channels() as usize;
    if channels.len() < count {
        channels.resize(count, Vec::new());
    }
    for (ch, data) in channels.iter_mut().enumerate().take(count) {
        let plane: &[f32] = out.plane(ch);
        data.extend_from_slice(&plane[..n]);
    }
}
