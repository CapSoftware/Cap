use cap_audio::{AudioData, cast_f32_slice_to_bytes};
use ffmpeg::{
    codec as avcodec,
    format::{self as avformat},
};
use std::path::Path;

pub fn opus_encode_audio(path: impl AsRef<Path>, samples: &AudioData) {
    let mut output = avformat::output(&path).unwrap();

    let codec = avcodec::encoder::find_by_name("libopus").unwrap();
    let ctx = avcodec::Context::new_with_codec(codec);
    let mut encoder = ctx.encoder().audio().unwrap();

    let output_format = AudioData::SAMPLE_FORMAT; //avformat::Sample::F32(avformat::sample::Type::Packed);

    let rate = AudioData::SAMPLE_RATE as i32;
    // encoder.set_bit_rate(128 * 1000);
    encoder.set_rate(rate);
    encoder.set_format(output_format);
    let channel_layout = ffmpeg::ChannelLayout::default(samples.channels() as i32);
    encoder.set_channel_layout(channel_layout);
    encoder.set_time_base(ffmpeg::Rational(1, rate));

    let mut encoder = encoder.open().unwrap();

    let mut stream = output.add_stream(codec).unwrap();
    let index = stream.index();
    stream.set_time_base(ffmpeg::Rational(1, rate));
    stream.set_parameters(&encoder);

    output.write_header().unwrap();

    let frame_size = encoder.frame_size() as usize;

    let mut frame = ffmpeg::frame::Audio::new(output_format, frame_size, channel_layout);
    let mut packet = ffmpeg::Packet::empty();

    for frame_samples in samples
        .samples()
        .chunks(frame_size * samples.channels() as usize)
    {
        let bytes = unsafe { cast_f32_slice_to_bytes(frame_samples) };
        frame.data_mut(0)[0..bytes.len()].copy_from_slice(bytes);

        encoder.send_frame(&frame).unwrap();

        while encoder.receive_packet(&mut packet).is_ok() {
            packet.set_stream(index);
            packet.write_interleaved(&mut output).unwrap();
        }
    }

    encoder.send_eof().unwrap();

    while encoder.receive_packet(&mut packet).is_ok() {
        packet.set_stream(index);
        packet.write_interleaved(&mut output).unwrap();
    }

    output.write_trailer().unwrap();
}

pub fn wav_encode_audio(path: impl AsRef<Path>, samples: &AudioData) {
    let mut output = avformat::output(&path).unwrap();

    let codec = avcodec::encoder::find_by_name("pcm_f32le").unwrap();
    let ctx = avcodec::Context::new_with_codec(codec);
    let mut encoder = ctx.encoder().audio().unwrap();

    let output_format = AudioData::SAMPLE_FORMAT; //avformat::Sample::F32(avformat::sample::Type::Packed);

    let rate = AudioData::SAMPLE_RATE as i32;
    // encoder.set_bit_rate(128 * 1000);
    encoder.set_rate(rate);
    encoder.set_format(output_format);
    let channel_layout = ffmpeg::ChannelLayout::default(samples.channels() as i32);
    encoder.set_channel_layout(channel_layout);
    encoder.set_time_base(ffmpeg::Rational(1, rate));

    let mut encoder = encoder.open().unwrap();

    let mut stream = output.add_stream(codec).unwrap();
    let index = stream.index();
    stream.set_time_base(ffmpeg::Rational(1, rate));
    stream.set_parameters(&encoder);

    output.write_header().unwrap();

    let frame_size = (encoder.frame_size() as usize).max(256);

    let mut frame = ffmpeg::frame::Audio::new(output_format, frame_size, channel_layout);
    let mut packet = ffmpeg::Packet::empty();

    // dbg!(frame_size, samples.channels);

    for frame_samples in samples
        .samples()
        .chunks(frame_size * samples.channels() as usize)
    {
        let bytes = unsafe { cast_f32_slice_to_bytes(frame_samples) };
        frame.data_mut(0)[0..bytes.len()].copy_from_slice(bytes);

        encoder.send_frame(&frame).unwrap();

        while encoder.receive_packet(&mut packet).is_ok() {
            packet.set_stream(index);
            packet.write_interleaved(&mut output).unwrap();
        }
    }

    encoder.send_eof().unwrap();

    while encoder.receive_packet(&mut packet).is_ok() {
        packet.set_stream(index);
        packet.write_interleaved(&mut output).unwrap();
    }

    output.write_trailer().unwrap();
}

fn main() {}

// fn main() {
//     let device = cpal::default_host().default_input_device().unwrap();
//     let input_config = device.default_input_config().unwrap();

//     dbg!(device.name().unwrap());
//     dbg!(&input_config);

//     let (tx, rx) = std::sync::mpsc::sync_channel(2);

//     let stream = device
//         .build_input_stream(
//             &input_config.config(),
//             move |samples: &[f32], _| {
//                 tx.send(samples.to_vec()).ok();
//             },
//             |_| {},
//             None,
//         )
//         .unwrap();

//     std::thread::spawn(move || {
//         let mut output = avformat::output("./src/out.ogg").unwrap();

//         let codec = avcodec::encoder::find_by_name("libopus").unwrap();
//         let ctx = avcodec::Context::new_with_codec(codec);
//         let mut encoder = ctx.encoder().audio().unwrap();

//         let output_format = AudioSampleBuffer::SAMPLE_FORMAT; //avformat::Sample::F32(avformat::sample::Type::Packed);

//         let rate = 48000; // samples.sample_rate as i32;
//                           // encoder.set_bit_rate(128 * 1000);
//         encoder.set_rate(rate);
//         encoder.set_format(output_format);
//         let channel_layout = ffmpeg::ChannelLayout::default(1);
//         encoder.set_channel_layout(channel_layout);
//         encoder.set_time_base(ffmpeg::Rational(1, rate));

//         let mut encoder = encoder.open().unwrap();

//         let mut stream = output.add_stream(codec).unwrap();
//         let index = stream.index();
//         stream.set_time_base(ffmpeg::Rational(1, rate));
//         stream.set_parameters(&encoder);

//         output.write_header().unwrap();

//         let frame_size = encoder.frame_size() as usize;

//         let mut frame = ffmpeg::frame::Audio::new(output_format, frame_size, channel_layout);
//         let mut packet = ffmpeg::Packet::empty();

//         let mut buffer = VecDeque::<f32>::with_capacity(frame_size * 2);

//         while let Ok(samples) = rx.recv() {
//             buffer.extend(&samples);

//             while buffer.len() >= frame_size {
//                 for (index, sample) in buffer.drain(0..frame_size).enumerate() {
//                     frame.plane_mut::<f32>(0)[index] = sample;
//                 }

//                 encoder.send_frame(&frame).unwrap();

//                 while encoder.receive_packet(&mut packet).is_ok() {
//                     packet.set_stream(index);
//                     packet.write_interleaved(&mut output).unwrap();
//                 }
//             }
//         }

//         while buffer.len() >= frame_size {
//             for (index, sample) in buffer.drain(0..frame_size).enumerate() {
//                 frame.plane_mut::<f32>(0)[index] = sample;
//             }

//             encoder.send_frame(&frame).unwrap();

//             while encoder.receive_packet(&mut packet).is_ok() {
//                 packet.set_stream(index);
//                 packet.write_interleaved(&mut output).unwrap();
//             }
//         }

//         encoder.send_eof().unwrap();

//         while encoder.receive_packet(&mut packet).is_ok() {
//             packet.set_stream(index);
//             packet.write_interleaved(&mut output).unwrap();
//         }

//         output.write_trailer().unwrap();
//     });

//     stream.play().unwrap();

//     std::thread::sleep(std::time::Duration::from_secs(5));
// }
