use byteorder::{LittleEndian, ReadBytesExt, WriteBytesExt};
use std::io::{self, Read, Write};

pub const MAGIC: u32 = 0x434D5850;
pub const PROTOCOL_VERSION: u16 = 1;

pub const FRAME_KIND_INIT_VIDEO: u8 = 0x10;
pub const FRAME_KIND_INIT_AUDIO: u8 = 0x11;
pub const FRAME_KIND_START: u8 = 0x20;
pub const FRAME_KIND_PACKET: u8 = 0x30;
pub const FRAME_KIND_FINISH: u8 = 0x40;
pub const FRAME_KIND_ABORT: u8 = 0x41;

pub const STREAM_INDEX_VIDEO: u8 = 0;
pub const STREAM_INDEX_AUDIO: u8 = 1;

pub const PACKET_FLAG_KEYFRAME: u8 = 0x01;
pub const PACKET_FLAG_DISCARD: u8 = 0x02;

pub const MAX_PAYLOAD_BYTES: u32 = 16 * 1024 * 1024;

#[derive(thiserror::Error, Debug)]
pub enum ProtocolError {
    #[error("io: {0}")]
    Io(#[from] io::Error),
    #[error("bad magic: got {0:#x}, expected {1:#x}")]
    BadMagic(u32, u32),
    #[error("unsupported protocol version {0}")]
    UnsupportedVersion(u16),
    #[error("unknown frame kind {0:#x}")]
    UnknownKind(u8),
    #[error("payload size {0} exceeds maximum {1}")]
    PayloadTooLarge(u32, u32),
    #[error("crc mismatch: computed {computed:#x}, received {received:#x}")]
    CrcMismatch { computed: u32, received: u32 },
    #[error("utf-8 error: {0}")]
    Utf8(#[from] std::string::FromUtf8Error),
    #[error("invalid encoding: {0}")]
    Invalid(String),
}

#[derive(Debug, Clone)]
pub enum Frame {
    InitVideo(InitVideo),
    InitAudio(InitAudio),
    Start(StartParams),
    Packet(Packet),
    Finish,
    Abort(String),
}

#[derive(Debug, Clone)]
pub struct InitVideo {
    pub codec: String,
    pub width: u32,
    pub height: u32,
    pub frame_rate_num: i32,
    pub frame_rate_den: i32,
    pub time_base_num: i32,
    pub time_base_den: i32,
    pub extradata: Vec<u8>,
    pub segment_duration_ms: u32,
}

#[derive(Debug, Clone)]
pub struct InitAudio {
    pub codec: String,
    pub sample_rate: u32,
    pub channels: u16,
    pub sample_format: String,
    pub time_base_num: i32,
    pub time_base_den: i32,
    pub extradata: Vec<u8>,
}

#[derive(Debug, Clone)]
pub struct StartParams {
    pub output_directory: String,
    pub init_segment_name: String,
    pub media_segment_pattern: String,
}

#[derive(Debug, Clone)]
pub struct Packet<T = Vec<u8>> {
    pub stream_index: u8,
    pub pts: i64,
    pub dts: i64,
    pub duration: u64,
    pub flags: u8,
    pub data: T,
}

impl Frame {
    pub fn kind(&self) -> u8 {
        match self {
            Frame::InitVideo(_) => FRAME_KIND_INIT_VIDEO,
            Frame::InitAudio(_) => FRAME_KIND_INIT_AUDIO,
            Frame::Start(_) => FRAME_KIND_START,
            Frame::Packet(_) => FRAME_KIND_PACKET,
            Frame::Finish => FRAME_KIND_FINISH,
            Frame::Abort(_) => FRAME_KIND_ABORT,
        }
    }
}

fn write_string<W: Write>(w: &mut W, s: &str) -> io::Result<()> {
    let bytes = s.as_bytes();
    w.write_u32::<LittleEndian>(bytes.len() as u32)?;
    w.write_all(bytes)?;
    Ok(())
}

fn read_string<R: Read>(r: &mut R) -> Result<String, ProtocolError> {
    let len = r.read_u32::<LittleEndian>()?;
    if len > MAX_PAYLOAD_BYTES {
        return Err(ProtocolError::PayloadTooLarge(len, MAX_PAYLOAD_BYTES));
    }
    let mut buf = vec![0u8; len as usize];
    r.read_exact(&mut buf)?;
    Ok(String::from_utf8(buf)?)
}

fn write_bytes<W: Write>(w: &mut W, bytes: &[u8]) -> io::Result<()> {
    w.write_u32::<LittleEndian>(bytes.len() as u32)?;
    w.write_all(bytes)?;
    Ok(())
}

fn read_bytes<R: Read>(r: &mut R) -> Result<Vec<u8>, ProtocolError> {
    let len = r.read_u32::<LittleEndian>()?;
    if len > MAX_PAYLOAD_BYTES {
        return Err(ProtocolError::PayloadTooLarge(len, MAX_PAYLOAD_BYTES));
    }
    let mut buf = vec![0u8; len as usize];
    r.read_exact(&mut buf)?;
    Ok(buf)
}

fn encode_body(frame: &Frame) -> Vec<u8> {
    let mut body = Vec::new();
    match frame {
        Frame::InitVideo(init) => {
            write_string(&mut body, &init.codec).unwrap();
            body.write_u32::<LittleEndian>(init.width).unwrap();
            body.write_u32::<LittleEndian>(init.height).unwrap();
            body.write_i32::<LittleEndian>(init.frame_rate_num).unwrap();
            body.write_i32::<LittleEndian>(init.frame_rate_den).unwrap();
            body.write_i32::<LittleEndian>(init.time_base_num).unwrap();
            body.write_i32::<LittleEndian>(init.time_base_den).unwrap();
            write_bytes(&mut body, &init.extradata).unwrap();
            body.write_u32::<LittleEndian>(init.segment_duration_ms)
                .unwrap();
        }
        Frame::InitAudio(init) => {
            write_string(&mut body, &init.codec).unwrap();
            body.write_u32::<LittleEndian>(init.sample_rate).unwrap();
            body.write_u16::<LittleEndian>(init.channels).unwrap();
            write_string(&mut body, &init.sample_format).unwrap();
            body.write_i32::<LittleEndian>(init.time_base_num).unwrap();
            body.write_i32::<LittleEndian>(init.time_base_den).unwrap();
            write_bytes(&mut body, &init.extradata).unwrap();
        }
        Frame::Start(params) => {
            write_string(&mut body, &params.output_directory).unwrap();
            write_string(&mut body, &params.init_segment_name).unwrap();
            write_string(&mut body, &params.media_segment_pattern).unwrap();
        }
        Frame::Packet(p) => {
            body.write_u8(p.stream_index).unwrap();
            body.write_u8(p.flags).unwrap();
            body.write_u16::<LittleEndian>(0).unwrap();
            body.write_i64::<LittleEndian>(p.pts).unwrap();
            body.write_i64::<LittleEndian>(p.dts).unwrap();
            body.write_u64::<LittleEndian>(p.duration).unwrap();
            write_bytes(&mut body, &p.data).unwrap();
        }
        Frame::Finish => {}
        Frame::Abort(reason) => {
            write_string(&mut body, reason).unwrap();
        }
    }
    body
}

pub fn write_frame<W: Write>(w: &mut W, frame: &Frame) -> Result<(), ProtocolError> {
    if let Frame::Packet(packet) = frame {
        return write_packet(w, packet);
    }
    let body = encode_body(frame);
    write_frame_parts(w, frame.kind(), &[&body])
}

pub fn write_packet<W: Write, T: AsRef<[u8]>>(
    w: &mut W,
    packet: &Packet<T>,
) -> Result<(), ProtocolError> {
    let data = packet.data.as_ref();
    let mut metadata = [0; 32];
    metadata[0] = packet.stream_index;
    metadata[1] = packet.flags;
    metadata[4..12].copy_from_slice(&packet.pts.to_le_bytes());
    metadata[12..20].copy_from_slice(&packet.dts.to_le_bytes());
    metadata[20..28].copy_from_slice(&packet.duration.to_le_bytes());
    let data_len = u32::try_from(data.len())
        .map_err(|_| ProtocolError::PayloadTooLarge(u32::MAX, MAX_PAYLOAD_BYTES))?;
    metadata[28..32].copy_from_slice(&data_len.to_le_bytes());
    write_frame_parts(w, FRAME_KIND_PACKET, &[&metadata, data])
}

fn write_frame_parts<W: Write>(w: &mut W, kind: u8, parts: &[&[u8]]) -> Result<(), ProtocolError> {
    let body_len = parts.iter().try_fold(0u32, |total, part| {
        u32::try_from(part.len())
            .ok()
            .and_then(|length| total.checked_add(length))
            .ok_or(ProtocolError::PayloadTooLarge(u32::MAX, MAX_PAYLOAD_BYTES))
    })?;
    if body_len > MAX_PAYLOAD_BYTES {
        return Err(ProtocolError::PayloadTooLarge(body_len, MAX_PAYLOAD_BYTES));
    }
    let mut hasher = crc32fast::Hasher::new();
    hasher.update(&[kind]);
    hasher.update(&body_len.to_le_bytes());
    for part in parts {
        hasher.update(part);
    }
    let crc = hasher.finalize();

    w.write_u32::<LittleEndian>(MAGIC)?;
    w.write_u16::<LittleEndian>(PROTOCOL_VERSION)?;
    w.write_u8(kind)?;
    w.write_u8(0)?;
    w.write_u32::<LittleEndian>(body_len)?;
    w.write_u32::<LittleEndian>(crc)?;
    for part in parts {
        w.write_all(part)?;
    }
    Ok(())
}

pub fn read_frame<R: Read>(r: &mut R) -> Result<Frame, ProtocolError> {
    let magic = r.read_u32::<LittleEndian>()?;
    if magic != MAGIC {
        return Err(ProtocolError::BadMagic(magic, MAGIC));
    }
    let version = r.read_u16::<LittleEndian>()?;
    if version != PROTOCOL_VERSION {
        return Err(ProtocolError::UnsupportedVersion(version));
    }
    let kind = r.read_u8()?;
    let _reserved = r.read_u8()?;
    let body_len = r.read_u32::<LittleEndian>()?;
    if body_len > MAX_PAYLOAD_BYTES {
        return Err(ProtocolError::PayloadTooLarge(body_len, MAX_PAYLOAD_BYTES));
    }
    let received_crc = r.read_u32::<LittleEndian>()?;

    let mut packet_metadata = [0; 32];
    let prefix_len = if kind == FRAME_KIND_PACKET && body_len >= 32 {
        r.read_exact(&mut packet_metadata)?;
        let data_len = (&packet_metadata[28..]).read_u32::<LittleEndian>()?;
        if data_len == body_len - 32 {
            let mut data = vec![0; data_len as usize];
            r.read_exact(&mut data)?;
            verify_frame_crc(kind, body_len, &[&packet_metadata, &data], received_crc)?;
            let mut packet = read_packet_header(&mut packet_metadata.as_slice())?;
            packet.data = data;
            return Ok(Frame::Packet(packet));
        }
        packet_metadata.len()
    } else {
        0
    };
    let mut body = vec![0u8; body_len as usize];
    body[..prefix_len].copy_from_slice(&packet_metadata[..prefix_len]);
    r.read_exact(&mut body[prefix_len..])?;
    verify_frame_crc(kind, body_len, &[&body], received_crc)?;

    let mut body_reader = &body[..];
    match kind {
        FRAME_KIND_INIT_VIDEO => {
            let codec = read_string(&mut body_reader)?;
            let width = body_reader.read_u32::<LittleEndian>()?;
            let height = body_reader.read_u32::<LittleEndian>()?;
            let frame_rate_num = body_reader.read_i32::<LittleEndian>()?;
            let frame_rate_den = body_reader.read_i32::<LittleEndian>()?;
            let time_base_num = body_reader.read_i32::<LittleEndian>()?;
            let time_base_den = body_reader.read_i32::<LittleEndian>()?;
            let extradata = read_bytes(&mut body_reader)?;
            let segment_duration_ms = body_reader.read_u32::<LittleEndian>()?;
            Ok(Frame::InitVideo(InitVideo {
                codec,
                width,
                height,
                frame_rate_num,
                frame_rate_den,
                time_base_num,
                time_base_den,
                extradata,
                segment_duration_ms,
            }))
        }
        FRAME_KIND_INIT_AUDIO => {
            let codec = read_string(&mut body_reader)?;
            let sample_rate = body_reader.read_u32::<LittleEndian>()?;
            let channels = body_reader.read_u16::<LittleEndian>()?;
            let sample_format = read_string(&mut body_reader)?;
            let time_base_num = body_reader.read_i32::<LittleEndian>()?;
            let time_base_den = body_reader.read_i32::<LittleEndian>()?;
            let extradata = read_bytes(&mut body_reader)?;
            Ok(Frame::InitAudio(InitAudio {
                codec,
                sample_rate,
                channels,
                sample_format,
                time_base_num,
                time_base_den,
                extradata,
            }))
        }
        FRAME_KIND_START => {
            let output_directory = read_string(&mut body_reader)?;
            let init_segment_name = read_string(&mut body_reader)?;
            let media_segment_pattern = read_string(&mut body_reader)?;
            Ok(Frame::Start(StartParams {
                output_directory,
                init_segment_name,
                media_segment_pattern,
            }))
        }
        FRAME_KIND_PACKET => {
            let mut packet = read_packet_header(&mut body_reader)?;
            packet.data = read_bytes(&mut body_reader)?;
            Ok(Frame::Packet(packet))
        }
        FRAME_KIND_FINISH => Ok(Frame::Finish),
        FRAME_KIND_ABORT => {
            let reason = read_string(&mut body_reader)?;
            Ok(Frame::Abort(reason))
        }
        other => Err(ProtocolError::UnknownKind(other)),
    }
}

fn verify_frame_crc(
    kind: u8,
    body_len: u32,
    parts: &[&[u8]],
    received_crc: u32,
) -> Result<(), ProtocolError> {
    let mut hasher = crc32fast::Hasher::new();
    hasher.update(&[kind]);
    hasher.update(&body_len.to_le_bytes());
    for part in parts {
        hasher.update(part);
    }
    let computed_crc = hasher.finalize();
    if computed_crc != received_crc {
        return Err(ProtocolError::CrcMismatch {
            computed: computed_crc,
            received: received_crc,
        });
    }
    Ok(())
}

fn read_packet_header<R: Read>(r: &mut R) -> Result<Packet, ProtocolError> {
    let stream_index = r.read_u8()?;
    let flags = r.read_u8()?;
    let _reserved = r.read_u16::<LittleEndian>()?;
    let pts = r.read_i64::<LittleEndian>()?;
    let dts = r.read_i64::<LittleEndian>()?;
    let duration = r.read_u64::<LittleEndian>()?;
    Ok(Packet {
        stream_index,
        pts,
        dts,
        duration,
        flags,
        data: Vec::new(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    fn replace_test_crc(bytes: &mut [u8]) {
        let mut checked = vec![bytes[6]];
        checked.extend_from_slice(&bytes[8..12]);
        checked.extend_from_slice(&bytes[16..]);
        bytes[12..16].copy_from_slice(&crc32fast::hash(&checked).to_le_bytes());
    }

    #[test]
    fn packet_reads_directly_into_the_returned_media_buffer_with_short_reads() {
        struct ShortReader<'a> {
            input: Cursor<&'a [u8]>,
            payload_buffer: Option<usize>,
        }

        impl Read for ShortReader<'_> {
            fn read(&mut self, bytes: &mut [u8]) -> io::Result<usize> {
                if self.input.position() == 48 {
                    self.payload_buffer = Some(bytes.as_ptr() as usize);
                }
                let count = bytes.len().min(7);
                self.input.read(&mut bytes[..count])
            }
        }

        let data: Vec<_> = (0..4096).map(|index| index as u8).collect();
        let mut wire = Vec::new();
        write_packet(
            &mut wire,
            &Packet {
                stream_index: STREAM_INDEX_AUDIO,
                pts: i64::MAX,
                dts: i64::MIN,
                duration: u64::MAX,
                flags: PACKET_FLAG_KEYFRAME | PACKET_FLAG_DISCARD,
                data: data.as_slice(),
            },
        )
        .unwrap();
        let mut reader = ShortReader {
            input: Cursor::new(&wire),
            payload_buffer: None,
        };
        let Frame::Packet(packet) = read_frame(&mut reader).unwrap() else {
            panic!("Expected packet");
        };
        assert_eq!(reader.payload_buffer, Some(packet.data.as_ptr() as usize));
        assert_eq!(packet.data, data);
        assert_eq!(packet.stream_index, STREAM_INDEX_AUDIO);
        assert_eq!(packet.pts, i64::MAX);
        assert_eq!(packet.dts, i64::MIN);
        assert_eq!(packet.duration, u64::MAX);
        assert_eq!(packet.flags, PACKET_FLAG_KEYFRAME | PACKET_FLAG_DISCARD);
    }

    #[test]
    fn packet_reads_preserve_trailing_bytes_and_checksum_error_precedence() {
        let mut wire = Vec::new();
        write_packet(
            &mut wire,
            &Packet {
                stream_index: STREAM_INDEX_VIDEO,
                pts: 0,
                dts: 0,
                duration: 1,
                flags: 0,
                data: &[1, 2, 3],
            },
        )
        .unwrap();
        for length in 0..wire.len() {
            assert!(matches!(
                read_frame(&mut &wire[..length]),
                Err(ProtocolError::Io(error)) if error.kind() == io::ErrorKind::UnexpectedEof
            ));
        }
        wire.extend_from_slice(&[9, 8, 7]);
        let body_len = (wire.len() - 16) as u32;
        wire[8..12].copy_from_slice(&body_len.to_le_bytes());
        replace_test_crc(&mut wire);
        let mut joined = wire.clone();
        write_frame(&mut joined, &Frame::Finish).unwrap();
        let mut reader = joined.as_slice();
        let Frame::Packet(packet) = read_frame(&mut reader).unwrap() else {
            panic!("Expected packet");
        };
        assert_eq!(packet.data, [1, 2, 3]);
        assert!(matches!(read_frame(&mut reader), Ok(Frame::Finish)));
        assert!(reader.is_empty());

        wire[44..48].copy_from_slice(&(MAX_PAYLOAD_BYTES + 1).to_le_bytes());
        assert!(matches!(
            read_frame(&mut wire.as_slice()),
            Err(ProtocolError::CrcMismatch { .. })
        ));
        replace_test_crc(&mut wire);
        assert!(matches!(
            read_frame(&mut wire.as_slice()),
            Err(ProtocolError::PayloadTooLarge(..))
        ));
        wire[44..48].copy_from_slice(&7u32.to_le_bytes());
        replace_test_crc(&mut wire);
        assert!(matches!(
            read_frame(&mut wire.as_slice()),
            Err(ProtocolError::Io(error)) if error.kind() == io::ErrorKind::UnexpectedEof
        ));
    }

    #[test]
    fn incomplete_packet_metadata_preserves_checksum_and_eof_errors() {
        for body_len in 0..32u32 {
            let mut wire = Vec::new();
            wire.extend_from_slice(&MAGIC.to_le_bytes());
            wire.extend_from_slice(&PROTOCOL_VERSION.to_le_bytes());
            wire.extend_from_slice(&[FRAME_KIND_PACKET, 0]);
            wire.extend_from_slice(&body_len.to_le_bytes());
            wire.extend_from_slice(&0u32.to_le_bytes());
            wire.resize(16 + body_len as usize, 0);
            replace_test_crc(&mut wire);
            assert!(matches!(
                read_frame(&mut wire.as_slice()),
                Err(ProtocolError::Io(error)) if error.kind() == io::ErrorKind::UnexpectedEof
            ));
            wire[12] ^= 1;
            assert!(matches!(
                read_frame(&mut wire.as_slice()),
                Err(ProtocolError::CrcMismatch { .. })
            ));
        }
    }

    #[test]
    fn packet_writes_preserve_the_original_wire_format() {
        for length in [0, 1, 257, 64 * 1024, MAX_PAYLOAD_BYTES as usize - 32] {
            for stream_index in [STREAM_INDEX_VIDEO, STREAM_INDEX_AUDIO] {
                let frame = Frame::Packet(Packet {
                    stream_index,
                    pts: i64::MAX,
                    dts: -123456789,
                    duration: u64::MAX,
                    flags: PACKET_FLAG_KEYFRAME | PACKET_FLAG_DISCARD,
                    data: (0..length).map(|index| index as u8).collect(),
                });
                let body = encode_body(&frame);
                let mut checked = vec![frame.kind()];
                checked.extend_from_slice(&(body.len() as u32).to_le_bytes());
                checked.extend_from_slice(&body);
                let mut expected = Vec::new();
                expected.extend_from_slice(&MAGIC.to_le_bytes());
                expected.extend_from_slice(&PROTOCOL_VERSION.to_le_bytes());
                expected.extend_from_slice(&[frame.kind(), 0]);
                expected.extend_from_slice(&(body.len() as u32).to_le_bytes());
                expected.extend_from_slice(&crc32fast::hash(&checked).to_le_bytes());
                expected.extend_from_slice(&body);

                let mut actual = Vec::new();
                write_frame(&mut actual, &frame).unwrap();
                assert_eq!(actual, expected);
                let Frame::Packet(decoded) = read_frame(&mut actual.as_slice()).unwrap() else {
                    panic!("Expected packet");
                };
                let Frame::Packet(original) = frame else {
                    unreachable!();
                };
                assert_eq!(decoded.data, original.data);
                assert_eq!(decoded.stream_index, original.stream_index);
                assert_eq!(decoded.pts, original.pts);
                assert_eq!(decoded.dts, original.dts);
                assert_eq!(decoded.duration, original.duration);
                assert_eq!(decoded.flags, original.flags);
            }
        }
    }

    #[test]
    fn packet_writes_borrow_encoded_media_and_handle_short_writes() {
        struct ShortWriter<'a> {
            packet: &'a [u8],
            borrowed_packet: bool,
            output: Vec<u8>,
        }

        impl Write for ShortWriter<'_> {
            fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
                if bytes.as_ptr() == self.packet.as_ptr() {
                    self.borrowed_packet = true;
                }
                let count = bytes.len().min(7);
                self.output.extend_from_slice(&bytes[..count]);
                Ok(count)
            }

            fn flush(&mut self) -> io::Result<()> {
                Ok(())
            }
        }

        let packet = Packet {
            stream_index: STREAM_INDEX_AUDIO,
            pts: 789,
            dts: 456,
            duration: 123,
            flags: 0,
            data: (0..4096).map(|index| index as u8).collect(),
        };
        let frame = Frame::Packet(packet);
        let Frame::Packet(packet) = &frame else {
            unreachable!();
        };
        let mut writer = ShortWriter {
            packet: &packet.data,
            borrowed_packet: false,
            output: Vec::new(),
        };
        write_frame(&mut writer, &frame).unwrap();
        assert!(writer.borrowed_packet);
        let Frame::Packet(decoded) = read_frame(&mut writer.output.as_slice()).unwrap() else {
            panic!("Expected packet");
        };
        assert_eq!(decoded.data, packet.data);
        assert_eq!(decoded.pts, packet.pts);
        assert_eq!(decoded.dts, packet.dts);
        assert_eq!(decoded.duration, packet.duration);
    }

    #[test]
    fn oversized_packet_writes_leave_the_stream_untouched() {
        let frame = Frame::Packet(Packet {
            stream_index: STREAM_INDEX_VIDEO,
            pts: 0,
            dts: 0,
            duration: 1,
            flags: 0,
            data: vec![0; MAX_PAYLOAD_BYTES as usize - 31],
        });
        let mut bytes = Vec::new();
        assert!(matches!(
            write_frame(&mut bytes, &frame),
            Err(ProtocolError::PayloadTooLarge(..))
        ));
        assert!(bytes.is_empty());
    }

    #[test]
    fn round_trips_init_video() {
        let original = Frame::InitVideo(InitVideo {
            codec: "h264".to_string(),
            width: 3024,
            height: 1964,
            frame_rate_num: 60,
            frame_rate_den: 1,
            time_base_num: 1,
            time_base_den: 90000,
            extradata: vec![0x01, 0x64, 0x00, 0x33],
            segment_duration_ms: 2000,
        });
        let mut buf = Vec::new();
        write_frame(&mut buf, &original).unwrap();
        let decoded = read_frame(&mut Cursor::new(&buf)).unwrap();
        match decoded {
            Frame::InitVideo(v) => {
                assert_eq!(v.codec, "h264");
                assert_eq!(v.width, 3024);
                assert_eq!(v.height, 1964);
                assert_eq!(v.extradata, vec![0x01, 0x64, 0x00, 0x33]);
            }
            other => panic!("expected InitVideo, got {other:?}"),
        }
    }

    #[test]
    fn round_trips_packet() {
        let original = Frame::Packet(Packet {
            stream_index: STREAM_INDEX_VIDEO,
            pts: 1234,
            dts: 1200,
            duration: 1500,
            flags: PACKET_FLAG_KEYFRAME,
            data: vec![0u8; 64 * 1024],
        });
        let mut buf = Vec::new();
        write_frame(&mut buf, &original).unwrap();
        let decoded = read_frame(&mut Cursor::new(&buf)).unwrap();
        match decoded {
            Frame::Packet(p) => {
                assert_eq!(p.stream_index, STREAM_INDEX_VIDEO);
                assert_eq!(p.pts, 1234);
                assert_eq!(p.dts, 1200);
                assert_eq!(p.flags, PACKET_FLAG_KEYFRAME);
                assert_eq!(p.data.len(), 64 * 1024);
            }
            other => panic!("expected Packet, got {other:?}"),
        }
    }

    #[test]
    fn round_trips_start_and_finish() {
        let start = Frame::Start(StartParams {
            output_directory: "/tmp/out".to_string(),
            init_segment_name: "init.mp4".to_string(),
            media_segment_pattern: "segment_$Number%03d$.m4s".to_string(),
        });
        let mut buf = Vec::new();
        write_frame(&mut buf, &start).unwrap();
        write_frame(&mut buf, &Frame::Finish).unwrap();
        let mut cursor = Cursor::new(&buf);
        let first = read_frame(&mut cursor).unwrap();
        let second = read_frame(&mut cursor).unwrap();
        assert!(matches!(first, Frame::Start(_)));
        assert!(matches!(second, Frame::Finish));
    }

    #[test]
    fn detects_bad_magic() {
        let mut buf = Vec::new();
        buf.extend_from_slice(&[0xDE, 0xAD, 0xBE, 0xEF]);
        buf.extend_from_slice(&[0u8; 32]);
        let err = read_frame(&mut Cursor::new(&buf)).unwrap_err();
        assert!(matches!(err, ProtocolError::BadMagic(..)));
    }

    #[test]
    fn detects_crc_corruption() {
        let frame = Frame::Packet(Packet {
            stream_index: STREAM_INDEX_VIDEO,
            pts: 0,
            dts: 0,
            duration: 1000,
            flags: 0,
            data: vec![1, 2, 3, 4, 5],
        });
        let mut buf = Vec::new();
        write_frame(&mut buf, &frame).unwrap();
        let offset = buf.len() - 3;
        buf[offset] ^= 0xFF;
        let err = read_frame(&mut Cursor::new(&buf)).unwrap_err();
        assert!(matches!(err, ProtocolError::CrcMismatch { .. }));
    }

    #[test]
    fn rejects_payload_too_large() {
        let mut buf = Vec::new();
        buf.write_u32::<LittleEndian>(MAGIC).unwrap();
        buf.write_u16::<LittleEndian>(PROTOCOL_VERSION).unwrap();
        buf.write_u8(FRAME_KIND_PACKET).unwrap();
        buf.write_u8(0).unwrap();
        buf.write_u32::<LittleEndian>(MAX_PAYLOAD_BYTES + 1)
            .unwrap();
        buf.write_u32::<LittleEndian>(0).unwrap();
        let err = read_frame(&mut Cursor::new(&buf)).unwrap_err();
        assert!(matches!(err, ProtocolError::PayloadTooLarge(..)));
    }

    #[test]
    fn handles_abort_with_reason() {
        let frame = Frame::Abort("encoder died".to_string());
        let mut buf = Vec::new();
        write_frame(&mut buf, &frame).unwrap();
        let decoded = read_frame(&mut Cursor::new(&buf)).unwrap();
        match decoded {
            Frame::Abort(reason) => assert_eq!(reason, "encoder died"),
            other => panic!("expected Abort, got {other:?}"),
        }
    }
}
