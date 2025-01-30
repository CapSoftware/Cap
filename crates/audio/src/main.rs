use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use ffmpeg::{
    codec as avcodec,
    format::{self as avformat},
    software::resampling::Delay,
};
use std::{collections::VecDeque, path::Path};

// F32 sample buffer with AUDIO_FORMAT
// Always packed/interlaced
pub struct AudioSampleBuffer {
    samples: Vec<f32>,
    channels: u16,
    sample_rate: u32,
}

impl AudioSampleBuffer {
    const SAMPLE_FORMAT: avformat::Sample = avformat::Sample::F32(avformat::sample::Type::Packed);
}

pub fn decode_audio(path: impl AsRef<Path>) -> AudioSampleBuffer {
    let mut input_ctx = ffmpeg::format::input(&path).unwrap();
    let input_stream = input_ctx
        .streams()
        .best(ffmpeg::media::Type::Audio)
        .unwrap();

    let decoder_ctx = avcodec::Context::from_parameters(input_stream.parameters()).unwrap();
    let mut decoder = decoder_ctx.decoder().audio().unwrap();
    decoder.set_parameters(input_stream.parameters()).unwrap();
    decoder.set_packet_time_base(input_stream.time_base());

    let mut resampler = ffmpeg::software::resampler(
        (decoder.format(), decoder.channel_layout(), decoder.rate()),
        (
            AudioSampleBuffer::SAMPLE_FORMAT,
            decoder.channel_layout(),
            decoder.rate(),
        ),
    )
    .unwrap();

    let index = input_stream.index();

    let mut decoded_samples = 0;
    let mut decoded_frame = ffmpeg::frame::Audio::empty();
    let mut resampled_frame = ffmpeg::frame::Audio::empty();

    // let mut resampled_frames = 0;
    let mut samples: Vec<f32> = vec![];

    for (stream, packet) in input_ctx.packets() {
        if stream.index() != index {
            continue;
        }

        decoder.send_packet(&packet).unwrap();

        while let Ok(_) = decoder.receive_frame(&mut decoded_frame) {
            decoded_samples += decoded_frame.samples();
            dbg!(decoded_frame.format());
            let resample_delay = resampler.run(&decoded_frame, &mut resampled_frame).unwrap();

            let slice = &resampled_frame.data(0)
                [0..resampled_frame.samples() * 4 * resampled_frame.channels() as usize];
            samples.extend(unsafe { cast_bytes_to_f32_slice(slice) });

            if resample_delay.is_some() {
                loop {
                    let resample_delay = resampler.flush(&mut resampled_frame).unwrap();

                    let slice = &resampled_frame.data(0)
                        [0..resampled_frame.samples() * 4 * resampled_frame.channels() as usize];
                    samples.extend(unsafe { cast_bytes_to_f32_slice(slice) });

                    if resample_delay.is_none() {
                        break;
                    }
                }
            }
        }

        loop {
            let resample_delay = resampler.flush(&mut resampled_frame).unwrap();

            let slice = &resampled_frame.data(0)
                [0..resampled_frame.samples() * 4 * resampled_frame.channels() as usize];
            samples.extend(unsafe { cast_bytes_to_f32_slice(slice) });

            if resample_delay.is_none() {
                break;
            }
        }
    }

    decoder.send_eof().unwrap();

    while let Ok(_) = decoder.receive_frame(&mut decoded_frame) {
        decoded_samples += decoded_frame.samples();
        dbg!(decoded_frame.format());
        let resample_delay = resampler.run(&decoded_frame, &mut resampled_frame).unwrap();

        let slice = &resampled_frame.data(0)
            [0..resampled_frame.samples() * 4 * resampled_frame.channels() as usize];
        samples.extend(unsafe { cast_bytes_to_f32_slice(slice) });

        if resample_delay.is_some() {
            loop {
                let resample_delay = resampler.flush(&mut resampled_frame).unwrap();

                let slice = &resampled_frame.data(0)
                    [0..resampled_frame.samples() * 4 * resampled_frame.channels() as usize];
                samples.extend(unsafe { cast_bytes_to_f32_slice(slice) });

                if resample_delay.is_none() {
                    break;
                }
            }
        }
    }

    loop {
        let resample_delay = resampler.flush(&mut resampled_frame).unwrap();

        let slice = &resampled_frame.data(0)
            [0..resampled_frame.samples() * 4 * resampled_frame.channels() as usize];
        samples.extend(unsafe { cast_bytes_to_f32_slice(slice) });

        dbg!(resample_delay);
        if resample_delay.is_none() {
            break;
        }
    }

    dbg!(decoded_samples);
    dbg!(samples.len());

    dbg!(Delay::from(&resampler));

    AudioSampleBuffer {
        samples,
        channels: decoder.channels(),
        sample_rate: decoder.rate(),
    }
}

pub unsafe fn cast_f32_slice_to_bytes(slice: &[f32]) -> &[u8] {
    std::slice::from_raw_parts(slice.as_ptr() as *const u8, slice.len() * 4)
}

pub unsafe fn cast_bytes_to_f32_slice(slice: &[u8]) -> &[f32] {
    std::slice::from_raw_parts(slice.as_ptr() as *const f32, slice.len() / 4)
}

pub fn opus_encode_audio(path: impl AsRef<Path>, samples: &AudioSampleBuffer) {
    let mut output = avformat::output(&path).unwrap();

    let codec = avcodec::encoder::find_by_name("libopus").unwrap();
    let ctx = avcodec::Context::new_with_codec(codec);
    let mut encoder = ctx.encoder().audio().unwrap();

    let output_format = AudioSampleBuffer::SAMPLE_FORMAT; //avformat::Sample::F32(avformat::sample::Type::Packed);

    let rate = samples.sample_rate as i32;
    // encoder.set_bit_rate(128 * 1000);
    encoder.set_rate(rate);
    encoder.set_format(output_format);
    let channel_layout = ffmpeg::ChannelLayout::default(samples.channels as i32);
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

    for (i, frame_samples) in samples
        .samples
        .chunks(frame_size * samples.channels as usize)
        .enumerate()
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

pub fn wav_encode_audio(path: impl AsRef<Path>, samples: &AudioSampleBuffer) {
    let mut output = avformat::output(&path).unwrap();

    let codec = avcodec::encoder::find_by_name("pcm_f32le").unwrap();
    let ctx = avcodec::Context::new_with_codec(codec);
    let mut encoder = ctx.encoder().audio().unwrap();

    let output_format = AudioSampleBuffer::SAMPLE_FORMAT; //avformat::Sample::F32(avformat::sample::Type::Packed);

    let rate = samples.sample_rate as i32;
    // encoder.set_bit_rate(128 * 1000);
    encoder.set_rate(rate);
    encoder.set_format(output_format);
    let channel_layout = ffmpeg::ChannelLayout::default(samples.channels as i32);
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
        .samples
        .chunks(frame_size * samples.channels as usize)
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

fn main() {
    decode_audio("/Users/brendonovich/Library/Application Support/so.cap.desktop.dev/recordings/5730b279-10ef-478a-aa35-5b4c4d7b3b29.cap/content/segments/segment-0/audio-input.ogg");
}

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
