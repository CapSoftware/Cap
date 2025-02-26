fn main() {
    let path = "/Users/brendonovich/Library/Application Support/so.cap.desktop.dev/recordings/51ecf128-913e-456c-8959-c73c6c4a60b3.cap/content/segments/segment-0/display.mp4";

    let mut input = ffmpeg::format::input(&path).unwrap();

    let input_stream = input
        .streams()
        .best(ffmpeg::media::Type::Video)
        .ok_or("Could not find a video stream")
        .unwrap();

    let decoder_codec =
        find_decoder(&input, &input_stream, input_stream.parameters().id()).unwrap();

    let mut context = ffmpeg::codec::context::Context::new_with_codec(decoder_codec);
    context.set_parameters(input_stream.parameters()).unwrap();

    let input_stream_index = input_stream.index();
    let time_base = input_stream.time_base();
    let frame_rate = input_stream.rate();

    // Create a decoder for the video stream
    let mut decoder = context.decoder().video().unwrap();

    let mut temp_frame = ffmpeg::frame::Video::empty();

    for (stream, packet) in input.packets() {
        if stream.index() == input_stream_index {
            decoder.send_packet(&packet).unwrap();

            while decoder.receive_frame(&mut temp_frame).is_ok() {
                dbg!(temp_frame.pts());
            }
        }
    }
}

pub fn find_decoder(
    s: &ffmpeg::format::context::Input,
    st: &ffmpeg::format::stream::Stream,
    codec_id: ffmpeg::codec::Id,
) -> Option<ffmpeg::Codec> {
    unsafe {
        use ffmpeg::media::Type;
        let codec = match st.parameters().medium() {
            Type::Video => Some((*s.as_ptr()).video_codec),
            Type::Audio => Some((*s.as_ptr()).audio_codec),
            Type::Subtitle => Some((*s.as_ptr()).subtitle_codec),
            _ => None,
        };

        if let Some(codec) = codec {
            if !codec.is_null() {
                return Some(ffmpeg::Codec::wrap(codec));
            }
        }

        let found = ffmpeg::sys::avcodec_find_decoder(codec_id.into());

        if found.is_null() {
            return None;
        }
        Some(ffmpeg::Codec::wrap(found))
    }
}
