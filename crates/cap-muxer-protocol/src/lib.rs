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
pub struct Packet {
    pub stream_index: u8,
    pub pts: i64,
    pub dts: i64,
    pub duration: u64,
    pub flags: u8,
    pub data: Vec<u8>,
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
    let body = encode_body(frame);
    if body.len() > MAX_PAYLOAD_BYTES as usize {
        return Err(ProtocolError::PayloadTooLarge(
            body.len() as u32,
            MAX_PAYLOAD_BYTES,
        ));
    }
    let mut hasher = crc32fast::Hasher::new();
    hasher.update(&[frame.kind()]);
    hasher.update(&(body.len() as u32).to_le_bytes());
    hasher.update(&body);
    let crc = hasher.finalize();

    w.write_u32::<LittleEndian>(MAGIC)?;
    w.write_u16::<LittleEndian>(PROTOCOL_VERSION)?;
    w.write_u8(frame.kind())?;
    w.write_u8(0)?;
    w.write_u32::<LittleEndian>(body.len() as u32)?;
    w.write_u32::<LittleEndian>(crc)?;
    w.write_all(&body)?;
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

    let mut body = vec![0u8; body_len as usize];
    r.read_exact(&mut body)?;

    let mut hasher = crc32fast::Hasher::new();
    hasher.update(&[kind]);
    hasher.update(&body_len.to_le_bytes());
    hasher.update(&body);
    let computed_crc = hasher.finalize();
    if computed_crc != received_crc {
        return Err(ProtocolError::CrcMismatch {
            computed: computed_crc,
            received: received_crc,
        });
    }

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
            let stream_index = body_reader.read_u8()?;
            let flags = body_reader.read_u8()?;
            let _reserved = body_reader.read_u16::<LittleEndian>()?;
            let pts = body_reader.read_i64::<LittleEndian>()?;
            let dts = body_reader.read_i64::<LittleEndian>()?;
            let duration = body_reader.read_u64::<LittleEndian>()?;
            let data = read_bytes(&mut body_reader)?;
            Ok(Frame::Packet(Packet {
                stream_index,
                pts,
                dts,
                duration,
                flags,
                data,
            }))
        }
        FRAME_KIND_FINISH => Ok(Frame::Finish),
        FRAME_KIND_ABORT => {
            let reason = read_string(&mut body_reader)?;
            Ok(Frame::Abort(reason))
        }
        other => Err(ProtocolError::UnknownKind(other)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

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
