use std::{
    fs::File,
    io::{self, Read, Seek, SeekFrom},
    path::Path,
    time::Duration,
};

pub(super) struct FragmentMetadata {
    pub duration: Duration,
    pub file_size: u64,
}

pub(super) fn read_fragment_metadata(path: &Path) -> io::Result<FragmentMetadata> {
    let mut file = File::open(path)?;
    let file_size = file.metadata()?.len();
    read_metadata(&mut file, file_size)
}

fn invalid_fragment(message: &'static str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message)
}

fn read_u32(reader: &mut impl Read) -> io::Result<u32> {
    let mut bytes = [0; 4];
    reader.read_exact(&mut bytes)?;
    Ok(u32::from_be_bytes(bytes))
}

fn read_u64(reader: &mut impl Read) -> io::Result<u64> {
    let mut bytes = [0; 8];
    reader.read_exact(&mut bytes)?;
    Ok(u64::from_be_bytes(bytes))
}

fn read_metadata(reader: &mut (impl Read + Seek), file_size: u64) -> io::Result<FragmentMetadata> {
    let mut offset = 0;
    let mut duration = None;
    let mut has_movie_fragment = false;
    let mut has_media_data = false;

    while offset < file_size {
        if file_size - offset < 8 {
            return Err(invalid_fragment("Truncated fragment box header"));
        }

        reader.seek(SeekFrom::Start(offset))?;
        let size = read_u32(reader)?;
        let mut kind = [0; 4];
        reader.read_exact(&mut kind)?;
        let (size, header_size) = match size {
            0 => (file_size - offset, 8),
            1 => (read_u64(reader)?, 16),
            size => (u64::from(size), 8),
        };
        if size < header_size || size > file_size - offset {
            return Err(invalid_fragment("Invalid fragment box size"));
        }

        if kind == *b"sidx" {
            if duration.is_some() {
                return Err(invalid_fragment("Multiple segment indexes in one fragment"));
            }
            // DASH cuts at encoded keyframes, which can differ from capture-time boundaries.
            let (indexed_duration, referenced_bytes) =
                read_segment_index(&mut (&mut *reader).take(size - header_size))?;
            if referenced_bytes > file_size - offset - size {
                return Err(invalid_fragment(
                    "Segment index references incomplete media",
                ));
            }
            duration = Some(indexed_duration);
        } else if kind == *b"moof" {
            has_movie_fragment = true;
        } else if kind == *b"mdat" {
            has_media_data = size > header_size;
        }

        offset += size;
    }

    if !has_movie_fragment || !has_media_data {
        return Err(invalid_fragment("Fragment media is missing"));
    }

    Ok(FragmentMetadata {
        duration: duration.ok_or_else(|| invalid_fragment("Fragment segment index is missing"))?,
        file_size,
    })
}

fn read_segment_index(reader: &mut impl Read) -> io::Result<(Duration, u64)> {
    let version = read_u32(reader)? >> 24;
    let _reference_id = read_u32(reader)?;
    let timescale = u64::from(read_u32(reader)?);
    if timescale == 0 {
        return Err(invalid_fragment("Segment index timescale is zero"));
    }

    let mut referenced_bytes = match version {
        0 => {
            let _earliest_presentation_time = read_u32(reader)?;
            u64::from(read_u32(reader)?)
        }
        1 => {
            let _earliest_presentation_time = read_u64(reader)?;
            read_u64(reader)?
        }
        _ => return Err(invalid_fragment("Unsupported segment index version")),
    };
    let reference_count = read_u32(reader)? & 0xffff;
    let mut duration_ticks = 0_u64;
    for _ in 0..reference_count {
        let reference = read_u32(reader)?;
        if reference & 0x8000_0000 != 0 {
            return Err(invalid_fragment("Nested segment index is unsupported"));
        }
        referenced_bytes = referenced_bytes
            .checked_add(u64::from(reference))
            .ok_or_else(|| invalid_fragment("Segment index size overflow"))?;
        duration_ticks += u64::from(read_u32(reader)?);
        let _access_point = read_u32(reader)?;
    }
    if duration_ticks == 0 {
        return Err(invalid_fragment("Segment index duration is zero"));
    }

    let duration = Duration::new(
        duration_ticks / timescale,
        ((duration_ticks % timescale) * 1_000_000_000 / timescale) as u32,
    );
    Ok((duration, referenced_bytes))
}

#[cfg(test)]
pub(super) mod tests {
    use super::*;
    use std::io::Cursor;

    fn mp4_box(kind: &[u8; 4], payload: &[u8]) -> Vec<u8> {
        let mut bytes = ((payload.len() + 8) as u32).to_be_bytes().to_vec();
        bytes.extend(kind);
        bytes.extend(payload);
        bytes
    }

    pub(crate) fn fragment(version: u8, timescale: u32, durations: &[u32]) -> Vec<u8> {
        let mut payload = (u32::from(version) << 24).to_be_bytes().to_vec();
        payload.extend(1_u32.to_be_bytes());
        payload.extend(timescale.to_be_bytes());
        payload.extend(vec![0; if version == 0 { 8 } else { 16 }]);
        payload.extend((durations.len() as u32).to_be_bytes());
        for duration in durations {
            payload.extend(32_u32.to_be_bytes());
            payload.extend(duration.to_be_bytes());
            payload.extend(0x8000_0000_u32.to_be_bytes());
        }
        let mut bytes = mp4_box(b"styp", &[0; 16]);
        bytes.extend(mp4_box(b"sidx", &payload));
        for _ in durations {
            bytes.extend(mp4_box(b"moof", &[0; 8]));
            bytes.extend(mp4_box(b"mdat", &[0; 8]));
        }
        bytes
    }

    fn parse(bytes: &[u8]) -> io::Result<FragmentMetadata> {
        read_metadata(&mut Cursor::new(bytes), bytes.len() as u64)
    }

    #[test]
    fn reads_both_segment_index_versions_and_multiple_references() {
        for version in [0, 1] {
            let bytes = fragment(version, 90_000, &[180_000, 360_070]);
            let metadata = parse(&bytes).unwrap();
            assert_eq!(metadata.file_size, bytes.len() as u64);
            assert_eq!(metadata.duration, Duration::new(6, 777_777));
        }
    }

    #[test]
    fn reads_audio_timescale_without_rounding_to_segment_target() {
        let bytes = fragment(1, 48_000, &[97_280]);
        assert_eq!(
            parse(&bytes).unwrap().duration,
            Duration::new(2, 26_666_666)
        );
    }

    #[test]
    fn skips_extended_size_boxes() {
        let mut bytes = 1_u32.to_be_bytes().to_vec();
        bytes.extend(b"free");
        bytes.extend(24_u64.to_be_bytes());
        bytes.extend([0; 8]);
        bytes.extend(fragment(1, 30, &[60]));
        assert_eq!(parse(&bytes).unwrap().duration, Duration::from_secs(2));
    }

    #[test]
    fn rejects_truncated_media_even_when_segment_index_is_complete() {
        let bytes = fragment(1, 30, &[60]);
        for length in 0..bytes.len() {
            assert!(parse(&bytes[..length]).is_err(), "length {length}");
        }
    }

    #[test]
    fn rejects_invalid_segment_indexes() {
        for bytes in [
            fragment(2, 30, &[60]),
            fragment(1, 0, &[60]),
            fragment(1, 30, &[0]),
            fragment(1, 30, &[]),
            mp4_box(b"mdat", &[0; 32]),
        ] {
            assert!(parse(&bytes).is_err());
        }
    }
}
