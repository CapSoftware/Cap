use cap_enc_ffmpeg::{
    h264::{H264EncoderBuilder, H264Preset},
    h264_packet::EncodedPacket,
};
use cap_media_info::VideoInfo;
use ffmpeg::{Packet, Rational, codec, format, frame};
use serde_json::json;
use std::{
    error::Error,
    ffi::CString,
    fs,
    path::Path,
    time::{Duration, Instant},
};

type Result<T> = std::result::Result<T, Box<dyn Error>>;

fn option(output: &mut format::context::Output, name: &str, value: &str) -> Result<()> {
    let name = CString::new(name)?;
    let value = CString::new(value)?;
    let result = unsafe {
        ffmpeg::ffi::av_opt_set(
            (*output.as_mut_ptr()).priv_data,
            name.as_ptr(),
            value.as_ptr(),
            0,
        )
    };
    if result < 0 {
        return Err(ffmpeg::Error::from(result).into());
    }
    Ok(())
}

fn output(path: &Path, mode: &str, header: &[u8], tb: Rational) -> Result<format::context::Output> {
    fs::create_dir_all(path)?;
    let mut context = std::ptr::null_mut();
    let name = CString::new(path.join("dash_manifest.mpd").to_string_lossy().as_bytes())?;
    let code = unsafe {
        ffmpeg::ffi::avformat_alloc_output_context2(
            &mut context,
            std::ptr::null_mut(),
            c"dash".as_ptr(),
            name.as_ptr(),
        )
    };
    if code < 0 {
        return Err(ffmpeg::Error::from(code).into());
    }
    let mut output = unsafe { format::context::Output::wrap(context) };
    for (name, value) in [
        ("init_seg_name", "init.mp4"),
        ("media_seg_name", "segment_$Number%03d$.m4s"),
        ("seg_duration", "2"),
        ("use_timeline", "1"),
        ("use_template", "1"),
        ("single_file", "0"),
        ("hls_playlist", "1"),
    ] {
        option(&mut output, name, value)?;
    }
    if mode != "control" {
        option(&mut output, "frag_type", "duration")?;
        option(&mut output, "frag_duration", "2")?;
    }
    if mode == "streaming" {
        option(&mut output, "streaming", "1")?;
    }
    let mut stream =
        output.add_stream(codec::encoder::find(codec::Id::H264).ok_or("H264 codec")?)?;
    stream.set_time_base(tb);
    stream.set_rate(Rational(30, 1));
    unsafe {
        let parameters = (*stream.as_mut_ptr()).codecpar;
        (*parameters).codec_type = ffmpeg::ffi::AVMediaType::AVMEDIA_TYPE_VIDEO;
        (*parameters).codec_id = ffmpeg::ffi::AVCodecID::AV_CODEC_ID_H264;
        (*parameters).width = 1920;
        (*parameters).height = 1080;
        (*parameters).format = ffmpeg::ffi::AVPixelFormat::AV_PIX_FMT_YUV420P as i32;
        let extra = ffmpeg::ffi::av_mallocz(
            header.len() + ffmpeg::ffi::AV_INPUT_BUFFER_PADDING_SIZE as usize,
        )
        .cast::<u8>();
        if extra.is_null() {
            return Err("extradata allocation".into());
        }
        std::ptr::copy_nonoverlapping(header.as_ptr(), extra, header.len());
        (*parameters).extradata = extra;
        (*parameters).extradata_size = header.len().try_into()?;
    }
    output.write_header()?;
    Ok(output)
}

fn snapshot(path: &Path, destination: &Path) -> Result<()> {
    fs::create_dir_all(destination)?;
    for entry in fs::read_dir(path)? {
        let entry = entry?;
        if entry.file_type()?.is_file() {
            fs::copy(entry.path(), destination.join(entry.file_name()))?;
        }
    }
    Ok(())
}

fn replay(
    root: &Path,
    mode: &str,
    packets: &[EncodedPacket],
    header: &[u8],
    tb: Rational,
) -> Result<serde_json::Value> {
    let path = root.join(mode);
    let mut output = output(&path, mode, header, tb)?;
    let stream_tb = output.stream(0).ok_or("stream")?.time_base();
    let mut snapshots = Vec::new();
    let mut next_snapshot = [7.1, 17.1, 59.0].into_iter().peekable();
    let mut write_nanos = 0_u128;
    for (index, source) in packets.iter().enumerate() {
        let mut packet = Packet::copy(&source.data);
        packet.set_stream(0);
        packet.set_pts(Some(source.pts));
        packet.set_dts(Some(source.dts));
        packet.set_duration(
            packets
                .get(index + 1)
                .map_or(source.duration.max(1), |next| next.dts - source.dts),
        );
        if source.is_keyframe {
            packet.set_flags(ffmpeg::packet::Flags::KEY);
        }
        packet.rescale_ts(tb, stream_tb);
        let start = Instant::now();
        packet.write_interleaved(&mut output)?;
        write_nanos += start.elapsed().as_nanos();
        let seconds = source.pts as f64 * f64::from(tb.numerator()) / f64::from(tb.denominator());
        if next_snapshot
            .peek()
            .is_some_and(|target| seconds >= *target)
        {
            let target = next_snapshot.next().ok_or("snapshot target")?;
            let label = format!("{mode}-at-{target}");
            snapshot(&path, &root.join(&label))?;
            snapshots
                .push(json!({"directory":label,"input_packets":index + 1,"input_pts":seconds}));
        }
    }
    let label = format!("{mode}-before-trailer");
    snapshot(&path, &root.join(&label))?;
    snapshots.push(json!({"directory":label,"input_packets":packets.len(),"input_pts":packets.last().map(|p| p.pts as f64 * f64::from(tb.numerator()) / f64::from(tb.denominator()))}));
    output.write_trailer()?;
    Ok(json!({"mode":mode,"snapshots":snapshots,"packet_write_nanos":write_nanos}))
}

fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().collect();
    let root = Path::new(args.get(1).ok_or("output directory")?);
    let codec = args.get(2).ok_or("codec")?;
    fs::create_dir_all(root)?;
    ffmpeg::init()?;
    ffmpeg::log::set_level(ffmpeg::log::Level::Error);
    let codecs: &'static [&'static str] = match codec.as_str() {
        "libx264" => &["libx264"],
        "h264_videotoolbox" => &["h264_videotoolbox"],
        _ => return Err("codec".into()),
    };
    let mut results = Vec::new();
    for step in [1_u64, 2, 10, 30] {
        let path = root.join(format!("step-{step}"));
        fs::create_dir_all(&path)?;
        let info = VideoInfo {
            pixel_format: format::Pixel::NV12,
            width: 1920,
            height: 1080,
            time_base: Rational(1, 1_000_000),
            frame_rate: Rational(30, 1),
        };
        let mut encoder = H264EncoderBuilder::new(info)
            .with_preset(H264Preset::Ultrafast)
            .with_encoder_priority_override(codecs)
            .build_standalone()?;
        if encoder.codec_name() != codec {
            return Err("required encoder unavailable".into());
        }
        let mut frames = Vec::new();
        for index in 0..30_usize {
            let mut picture = frame::Video::new(format::Pixel::NV12, 1920, 1080);
            for plane in 0..picture.planes() {
                let stride = picture.stride(plane);
                for (offset, byte) in picture.data_mut(plane).iter_mut().enumerate() {
                    let x = offset % stride;
                    let y = offset / stride;
                    *byte = if plane == 0 {
                        (16 + ((x / 32 + y / 32 + index) % 14) * 16) as u8
                    } else {
                        128
                    };
                }
            }
            frames.push(picture);
        }
        let mut packets = Vec::new();
        let mut converted = None;
        for slot in (0..1800_u64).step_by(step as usize) {
            encoder.encode_frame_reusable(
                &mut frames[(slot % 30) as usize],
                &mut converted,
                Duration::from_nanos(slot * 1_000_000_000 / 30),
                |packet| {
                    packets.push(packet);
                    Ok(())
                },
            )?;
        }
        encoder.flush(|packet| {
            packets.push(packet);
            Ok(())
        })?;
        let header = encoder.extradata();
        let tb = encoder.time_base();
        let mut modes = Vec::new();
        for mode in ["control", "duration", "streaming"] {
            modes.push(replay(&path, mode, &packets, &header, tb)?);
        }
        let record = json!({"codec":codec,"step":step,"fps":30.0 / step as f64,"input_packets":packets.len(),"time_base":[tb.numerator(),tb.denominator()],"keys":packets.iter().filter(|p| p.is_keyframe).map(|p| p.pts).collect::<Vec<_>>(),"modes":modes});
        println!("{record}");
        results.push(record);
        fs::write(
            root.join("records.json"),
            serde_json::to_vec_pretty(&results)?,
        )?;
    }
    Ok(())
}
