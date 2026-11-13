use anyhow::anyhow;

#[derive(Default)]
pub(crate) struct MjpegDecoder {
    decoder: Option<ffmpeg::codec::decoder::Video>,
}

impl MjpegDecoder {
    pub(crate) fn decode(&mut self, data: &[u8]) -> anyhow::Result<ffmpeg::frame::Video> {
        let mut decoder = match self.decoder.take() {
            Some(decoder) => decoder,
            None => open_mjpeg_decoder()?,
        };

        let packet = ffmpeg::Packet::copy(data);
        decoder
            .send_packet(&packet)
            .map_err(|e| anyhow!("Failed to send MJPEG packet: {e}"))?;

        let mut decoded_frame = ffmpeg::frame::Video::empty();
        decoder
            .receive_frame(&mut decoded_frame)
            .map_err(|e| anyhow!("Failed to decode MJPEG frame: {e}"))?;

        self.decoder = Some(decoder);
        Ok(decoded_frame)
    }
}

fn open_mjpeg_decoder() -> anyhow::Result<ffmpeg::codec::decoder::Video> {
    let codec = ffmpeg::codec::decoder::find(ffmpeg::codec::Id::MJPEG)
        .ok_or_else(|| anyhow!("MJPEG codec not found"))?;

    ffmpeg::codec::context::Context::new_with_codec(codec)
        .decoder()
        .video()
        .map_err(|e| anyhow!("Failed to create MJPEG decoder: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use ffmpeg::format::Pixel;

    const WIDTH: u32 = 64;
    const HEIGHT: u32 = 48;

    fn source_luma(base: u8, x: usize) -> u8 {
        base + x as u8
    }

    fn encode_mjpeg(base_luma: u8, chroma: u8) -> Vec<u8> {
        let codec = ffmpeg::codec::encoder::find(ffmpeg::codec::Id::MJPEG).unwrap();
        let mut encoder = ffmpeg::codec::context::Context::new_with_codec(codec)
            .encoder()
            .video()
            .unwrap();
        encoder.set_width(WIDTH);
        encoder.set_height(HEIGHT);
        encoder.set_format(Pixel::YUVJ420P);
        encoder.set_time_base((1, 30));
        let mut encoder = encoder.open().unwrap();

        let mut frame = ffmpeg::frame::Video::new(Pixel::YUVJ420P, WIDTH, HEIGHT);
        let luma_stride = frame.stride(0);
        for row in frame.data_mut(0).chunks_mut(luma_stride) {
            for (x, pixel) in row.iter_mut().take(WIDTH as usize).enumerate() {
                *pixel = source_luma(base_luma, x);
            }
        }
        frame.data_mut(1).fill(chroma);
        frame.data_mut(2).fill(chroma);
        frame.set_pts(Some(0));

        encoder.send_frame(&frame).unwrap();
        encoder.send_eof().unwrap();
        let mut packet = ffmpeg::Packet::empty();
        encoder.receive_packet(&mut packet).unwrap();
        packet.data().unwrap().to_vec()
    }

    fn decode_with_fresh_decoder(data: &[u8]) -> ffmpeg::frame::Video {
        let codec = ffmpeg::codec::decoder::find(ffmpeg::codec::Id::MJPEG).unwrap();
        let mut decoder = ffmpeg::codec::context::Context::new_with_codec(codec)
            .decoder()
            .video()
            .unwrap();
        decoder.send_packet(&ffmpeg::Packet::copy(data)).unwrap();
        let mut frame = ffmpeg::frame::Video::empty();
        decoder.receive_frame(&mut frame).unwrap();
        frame
    }

    fn luma_rows(frame: &ffmpeg::frame::Video) -> Vec<&[u8]> {
        let width = frame.width() as usize;
        frame
            .data(0)
            .chunks(frame.stride(0))
            .take(frame.height() as usize)
            .map(|row| &row[..width])
            .collect()
    }

    fn assert_matches_fresh_decode(decoded: &ffmpeg::frame::Video, data: &[u8], base_luma: u8) {
        let expected = decode_with_fresh_decoder(data);

        assert_eq!(decoded.width(), WIDTH);
        assert_eq!(decoded.height(), HEIGHT);
        assert_eq!(decoded.format(), expected.format());
        assert_eq!(decoded.width(), expected.width());
        assert_eq!(decoded.height(), expected.height());
        assert_eq!(luma_rows(decoded), luma_rows(&expected));

        let rows = luma_rows(decoded);
        for (x, y) in [(4, 4), (32, 24), (60, 44)] {
            let actual = rows[y][x];
            let source = source_luma(base_luma, x);
            assert!(
                actual.abs_diff(source) <= 6,
                "luma at ({x}, {y}) was {actual}, expected about {source}"
            );
        }
    }

    #[test]
    fn mjpeg_decoder_reused_across_frames_matches_fresh_decoder() {
        let frames: Vec<(u8, Vec<u8>)> =
            [(16u8, 128u8), (60, 90), (100, 160), (140, 40), (30, 200)]
                .into_iter()
                .map(|(base_luma, chroma)| (base_luma, encode_mjpeg(base_luma, chroma)))
                .collect();

        let mut decoder = MjpegDecoder::default();
        for (base_luma, data) in &frames {
            let decoded = decoder.decode(data).unwrap();
            assert_matches_fresh_decode(&decoded, data, *base_luma);
        }
    }

    #[test]
    fn mjpeg_decoder_recovers_after_invalid_input() {
        let valid = encode_mjpeg(80, 128);
        let garbage: Vec<u8> = (0..512u32).map(|i| (i * 37 % 251) as u8).collect();

        let mut decoder = MjpegDecoder::default();
        assert_matches_fresh_decode(&decoder.decode(&valid).unwrap(), &valid, 80);

        assert!(decoder.decode(&garbage).is_err());
        assert_matches_fresh_decode(&decoder.decode(&valid).unwrap(), &valid, 80);

        assert!(decoder.decode(&[]).is_err());
        assert_matches_fresh_decode(&decoder.decode(&valid).unwrap(), &valid, 80);
    }
}
