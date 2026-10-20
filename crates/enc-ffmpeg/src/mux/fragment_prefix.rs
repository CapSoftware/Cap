use std::{
    fs::File,
    io::{self, BufReader, Read, Seek, SeekFrom},
    path::Path,
    time::Duration,
};

struct Reader {
    input: BufReader<File>,
    position: u64,
}

impl Reader {
    fn open(path: &Path) -> io::Result<Self> {
        Ok(Self {
            input: BufReader::new(File::open(path)?),
            position: 0,
        })
    }

    fn len(&self) -> io::Result<u64> {
        Ok(self.input.get_ref().metadata()?.len())
    }
}

impl Read for Reader {
    fn read(&mut self, bytes: &mut [u8]) -> io::Result<usize> {
        let read = self.input.read(bytes)?;
        self.position += read as u64;
        Ok(read)
    }
}

impl Seek for Reader {
    fn seek(&mut self, position: SeekFrom) -> io::Result<u64> {
        if let SeekFrom::Current(0) = position {
            return Ok(self.position);
        }
        self.position = self.input.seek(position)?;
        Ok(self.position)
    }
}

#[derive(Clone, Copy)]
struct BoxHeader {
    kind: [u8; 4],
    start: u64,
    payload: u64,
    end: u64,
}

#[derive(Default)]
struct Track {
    id: u32,
    timescale: u32,
    duration: u32,
    size: u32,
    flags: u32,
}

struct Run {
    start: u64,
    end: u64,
}

struct Fragment {
    decode_time: u64,
    duration: u64,
    runs: Vec<Run>,
    starts_with_keyframe: bool,
}

pub struct FragmentPrefix {
    pub length: u64,
    pub duration: Duration,
}

fn invalid() -> io::Error {
    io::Error::new(
        io::ErrorKind::InvalidData,
        "Invalid fragmented MP4 sample table",
    )
}

fn u32_at(reader: &mut (impl Read + Seek), end: u64) -> io::Result<u32> {
    if reader
        .stream_position()?
        .checked_add(4)
        .ok_or_else(invalid)?
        > end
    {
        return Err(invalid());
    }
    let mut bytes = [0; 4];
    reader.read_exact(&mut bytes)?;
    Ok(u32::from_be_bytes(bytes))
}

fn u64_at(reader: &mut (impl Read + Seek), end: u64) -> io::Result<u64> {
    Ok((u64::from(u32_at(reader, end)?) << 32) | u64::from(u32_at(reader, end)?))
}

fn skip(reader: &mut (impl Read + Seek), bytes: u64, end: u64) -> io::Result<()> {
    let position = reader
        .stream_position()?
        .checked_add(bytes)
        .ok_or_else(invalid)?;
    if position > end {
        return Err(invalid());
    }
    reader.seek(SeekFrom::Start(position))?;
    Ok(())
}

fn header(reader: &mut (impl Read + Seek), end: u64) -> io::Result<Option<BoxHeader>> {
    let start = reader.stream_position()?;
    if start == end {
        return Ok(None);
    }
    let size = u32_at(reader, end)?;
    let kind = u32_at(reader, end)?.to_be_bytes();
    let size = match size {
        0 => return Err(invalid()),
        1 => u64_at(reader, end)?,
        size => u64::from(size),
    };
    let payload = reader.stream_position()?;
    let box_end = start.checked_add(size).ok_or_else(invalid)?;
    if box_end < payload || box_end > end {
        return Err(invalid());
    }
    Ok(Some(BoxHeader {
        kind,
        start,
        payload,
        end: box_end,
    }))
}

fn track_in(reader: &mut (impl Read + Seek), end: u64, track: &mut Track) -> io::Result<()> {
    while let Some(item) = header(reader, end)? {
        match &item.kind {
            b"trak" | b"mdia" => track_in(reader, item.end, track)?,
            b"tkhd" => {
                let version = u32_at(reader, item.end)? >> 24;
                skip(
                    reader,
                    match version {
                        0 => 8,
                        1 => 16,
                        _ => return Err(invalid()),
                    },
                    item.end,
                )?;
                track.id = u32_at(reader, item.end)?;
            }
            b"mdhd" => {
                let version = u32_at(reader, item.end)? >> 24;
                skip(
                    reader,
                    match version {
                        0 => 8,
                        1 => 16,
                        _ => return Err(invalid()),
                    },
                    item.end,
                )?;
                track.timescale = u32_at(reader, item.end)?;
            }
            _ => {}
        }
        reader.seek(SeekFrom::Start(item.end))?;
    }
    Ok(())
}

fn read_track(path: &Path) -> io::Result<Track> {
    let mut reader = Reader::open(path)?;
    let end = reader.len()?;
    let mut track = Track::default();
    let mut defaults = Vec::new();
    while let Some(item) = header(&mut reader, end)? {
        if item.kind == *b"moov" {
            while let Some(child) = header(&mut reader, item.end)? {
                match &child.kind {
                    b"trak" => {
                        if track.id != 0 {
                            return Err(invalid());
                        }
                        track_in(&mut reader, child.end, &mut track)?;
                    }
                    b"mvex" => {
                        while let Some(entry) = header(&mut reader, child.end)? {
                            if entry.kind == *b"trex" {
                                if u32_at(&mut reader, entry.end)? != 0 {
                                    return Err(invalid());
                                }
                                let id = u32_at(&mut reader, entry.end)?;
                                let _description = u32_at(&mut reader, entry.end)?;
                                defaults.push((
                                    id,
                                    u32_at(&mut reader, entry.end)?,
                                    u32_at(&mut reader, entry.end)?,
                                    u32_at(&mut reader, entry.end)?,
                                ));
                            }
                            reader.seek(SeekFrom::Start(entry.end))?;
                        }
                    }
                    _ => {}
                }
                reader.seek(SeekFrom::Start(child.end))?;
            }
        }
        reader.seek(SeekFrom::Start(item.end))?;
    }
    if track.id == 0 || track.timescale == 0 {
        return Err(invalid());
    }
    let mut matching = defaults.into_iter().filter(|(id, ..)| *id == track.id);
    if let Some((_, duration, size, flags)) = matching.next() {
        track.duration = duration;
        track.size = size;
        track.flags = flags;
    }
    if matching.next().is_some() {
        return Err(invalid());
    }
    Ok(track)
}

fn read_fragment(
    reader: &mut (impl Read + Seek),
    moof: BoxHeader,
    track: &Track,
) -> io::Result<Fragment> {
    let mut traf = None;
    while let Some(item) = header(reader, moof.end)? {
        if item.kind == *b"traf" && traf.replace(item).is_some() {
            return Err(invalid());
        }
        reader.seek(SeekFrom::Start(item.end))?;
    }
    let traf = traf.ok_or_else(invalid)?;
    reader.seek(SeekFrom::Start(traf.payload))?;
    let mut base = moof.start;
    let mut default_duration = track.duration;
    let mut default_size = track.size;
    let mut default_flags = track.flags;
    let mut decode_time = None;
    let mut has_header = false;
    let mut runs = Vec::new();
    while let Some(item) = header(reader, traf.end)? {
        match &item.kind {
            b"tfhd" => {
                if has_header {
                    return Err(invalid());
                }
                has_header = true;
                let flags = u32_at(reader, item.end)?;
                if flags & !0x02003b != 0 || u32_at(reader, item.end)? != track.id {
                    return Err(invalid());
                }
                if flags & 1 != 0 {
                    base = u64_at(reader, item.end)?;
                }
                if flags & 2 != 0 {
                    let _description = u32_at(reader, item.end)?;
                }
                if flags & 8 != 0 {
                    default_duration = u32_at(reader, item.end)?;
                }
                if flags & 16 != 0 {
                    default_size = u32_at(reader, item.end)?;
                }
                if flags & 32 != 0 {
                    default_flags = u32_at(reader, item.end)?;
                }
            }
            b"tfdt" => {
                if decode_time.is_some() {
                    return Err(invalid());
                }
                decode_time = Some(match u32_at(reader, item.end)? {
                    0 => u64::from(u32_at(reader, item.end)?),
                    0x01000000 => u64_at(reader, item.end)?,
                    _ => return Err(invalid()),
                });
            }
            b"trun" => runs.push(item),
            _ => {}
        }
        reader.seek(SeekFrom::Start(item.end))?;
    }
    if !has_header || runs.is_empty() {
        return Err(invalid());
    }
    let mut fragment = Fragment {
        decode_time: decode_time.ok_or_else(invalid)?,
        duration: 0,
        runs: Vec::new(),
        starts_with_keyframe: false,
    };
    let mut next_data = base;
    for run in runs {
        reader.seek(SeekFrom::Start(run.payload))?;
        let flags = u32_at(reader, run.end)?;
        if flags & !0x01000f05 != 0 || flags >> 24 > 1 {
            return Err(invalid());
        }
        let count = u32_at(reader, run.end)?;
        if count == 0 {
            return Err(invalid());
        }
        if flags & 1 != 0 {
            let offset = u32_at(reader, run.end)? as i32;
            next_data = base
                .checked_add_signed(i64::from(offset))
                .ok_or_else(invalid)?;
        }
        let first_flags = if flags & 4 != 0 {
            u32_at(reader, run.end)?
        } else {
            default_flags
        };
        let per_sample = (flags & 0xf00).count_ones() as u64 * 4;
        if per_sample
            .checked_mul(u64::from(count))
            .ok_or_else(invalid)?
            > run.end - reader.stream_position()?
        {
            return Err(invalid());
        }
        let start = next_data;
        if per_sample == 0 {
            if default_duration == 0 || default_size == 0 {
                return Err(invalid());
            }
            if fragment.runs.is_empty() {
                fragment.starts_with_keyframe = first_flags & 0x10000 == 0;
            }
            fragment.duration = fragment
                .duration
                .checked_add(u64::from(default_duration) * u64::from(count))
                .ok_or_else(invalid)?;
            next_data = next_data
                .checked_add(u64::from(default_size) * u64::from(count))
                .ok_or_else(invalid)?;
        }
        for index in 0..if per_sample == 0 { 0 } else { count } {
            let duration = if flags & 0x100 != 0 {
                u32_at(reader, run.end)?
            } else {
                default_duration
            };
            let size = if flags & 0x200 != 0 {
                u32_at(reader, run.end)?
            } else {
                default_size
            };
            let sample_flags = if flags & 0x400 != 0 {
                u32_at(reader, run.end)?
            } else if index == 0 {
                first_flags
            } else {
                default_flags
            };
            if flags & 0x800 != 0 {
                let _composition_offset = u32_at(reader, run.end)?;
            }
            if duration == 0 || size == 0 {
                return Err(invalid());
            }
            if fragment.runs.is_empty() && index == 0 {
                fragment.starts_with_keyframe = sample_flags & 0x10000 == 0;
            }
            fragment.duration = fragment
                .duration
                .checked_add(u64::from(duration))
                .ok_or_else(invalid)?;
            next_data = next_data.checked_add(u64::from(size)).ok_or_else(invalid)?;
        }
        if reader.stream_position()? != run.end {
            return Err(invalid());
        }
        fragment.runs.push(Run {
            start,
            end: next_data,
        });
    }
    Ok(fragment)
}

fn is_incomplete_tail(error: &io::Error) -> bool {
    matches!(
        error.kind(),
        io::ErrorKind::InvalidData | io::ErrorKind::UnexpectedEof
    )
}

pub fn read_fragment_prefix(init: &Path, media: &Path) -> io::Result<FragmentPrefix> {
    let track = read_track(init)?;
    let mut reader = Reader::open(media)?;
    let end = reader.len()?;
    let mut pending = None;
    let mut prefix = 0;
    let mut first_time = None;
    let mut end_time = 0;
    let result = (|| -> io::Result<()> {
        while let Some(item) = header(&mut reader, end)? {
            match &item.kind {
                b"moof" => {
                    if pending.is_some() {
                        return Err(invalid());
                    }
                    pending = Some(read_fragment(&mut reader, item, &track)?);
                }
                b"mdat" => {
                    let fragment: Fragment = pending.take().ok_or_else(invalid)?;
                    if fragment
                        .runs
                        .iter()
                        .any(|run| run.start < item.payload || run.end > item.end)
                        || fragment
                            .runs
                            .windows(2)
                            .any(|pair| pair[0].end != pair[1].start)
                        || fragment
                            .runs
                            .first()
                            .is_none_or(|run| run.start != item.payload)
                        || fragment.runs.last().is_none_or(|run| run.end != item.end)
                    {
                        return Err(invalid());
                    }
                    if first_time.is_none() {
                        if !fragment.starts_with_keyframe {
                            return Err(invalid());
                        }
                        first_time = Some(fragment.decode_time);
                    } else if fragment.decode_time != end_time {
                        return Err(invalid());
                    }
                    end_time = fragment
                        .decode_time
                        .checked_add(fragment.duration)
                        .ok_or_else(invalid)?;
                    prefix = item.end;
                }
                b"styp" | b"sidx" | b"emsg" | b"prft" | b"free" => {
                    if pending.is_some() {
                        return Err(invalid());
                    }
                }
                _ => return Err(invalid()),
            }
            reader.seek(SeekFrom::Start(item.end))?;
        }
        Ok(())
    })();
    // Only a malformed or truncated tail ends the prefix; any other read
    // error leaves the recording retryable instead of shortening it.
    if let Err(error) = result
        && !is_incomplete_tail(&error)
    {
        return Err(error);
    }
    if prefix == 0 {
        return Err(invalid());
    }
    let ticks = end_time
        .checked_sub(first_time.ok_or_else(invalid)?)
        .ok_or_else(invalid)?;
    let timescale = u64::from(track.timescale);
    Ok(FragmentPrefix {
        length: prefix,
        duration: Duration::new(
            ticks / timescale,
            ((ticks % timescale) * 1_000_000_000 / timescale) as u32,
        ),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_malformed_or_truncated_tails_end_a_prefix() {
        assert!(is_incomplete_tail(&invalid()));
        assert!(is_incomplete_tail(&io::Error::from(
            io::ErrorKind::UnexpectedEof
        )));
        for kind in [
            io::ErrorKind::PermissionDenied,
            io::ErrorKind::Interrupted,
            io::ErrorKind::Other,
        ] {
            assert!(!is_incomplete_tail(&io::Error::from(kind)));
        }
    }

    fn boxed(kind: &[u8; 4], data: &[u8]) -> Vec<u8> {
        let mut bytes = ((data.len() + 8) as u32).to_be_bytes().to_vec();
        bytes.extend(kind);
        bytes.extend(data);
        bytes
    }

    fn words(values: &[u32]) -> Vec<u8> {
        values
            .iter()
            .flat_map(|value| value.to_be_bytes())
            .collect()
    }

    fn init() -> Vec<u8> {
        let tkhd = boxed(b"tkhd", &words(&[0, 0, 0, 1]));
        let mdhd = boxed(b"mdhd", &words(&[0, 0, 0, 30]));
        let trak = boxed(b"trak", &[tkhd, boxed(b"mdia", &mdhd)].concat());
        let defaults = boxed(b"mvex", &boxed(b"trex", &words(&[0, 1, 1, 1, 4, 0])));
        boxed(b"moov", &[trak, defaults].concat())
    }

    fn media(time: u32, keyframe: bool, count: u32) -> Vec<u8> {
        let tfhd = boxed(b"tfhd", &words(&[0x20000, 1]));
        let tfdt = boxed(b"tfdt", &words(&[0, time]));
        let make_moof = |offset| {
            let trun = boxed(
                b"trun",
                &words(&[5, count, offset, if keyframe { 0 } else { 0x10000 }]),
            );
            boxed(
                b"moof",
                &boxed(b"traf", &[tfhd.clone(), tfdt.clone(), trun].concat()),
            )
        };
        let moof = make_moof(make_moof(0).len() as u32 + 8);
        [moof, boxed(b"mdat", &vec![42; count as usize * 4])].concat()
    }

    fn parse(init: &[u8], media: &[u8]) -> io::Result<FragmentPrefix> {
        let directory = tempfile::tempdir()?;
        let init_path = directory.path().join("init.mp4");
        let media_path = directory.path().join("segment.m4s");
        std::fs::write(&init_path, init)?;
        std::fs::write(&media_path, media)?;
        read_fragment_prefix(&init_path, &media_path)
    }

    #[test]
    fn accepts_multiple_fragments_without_indexes_and_with_multiple_indexes() {
        for indexed in [false, true] {
            let mut bytes = boxed(b"styp", &[0; 16]);
            for index in 0..3 {
                if indexed {
                    bytes.extend(boxed(b"sidx", &[0; 24]));
                }
                bytes.extend(media(index * 60, index == 0, 60));
            }
            let prefix = parse(&init(), &bytes).unwrap();
            assert_eq!(prefix.length, bytes.len() as u64);
            assert_eq!(prefix.duration, Duration::from_secs(6));
        }
    }

    #[test]
    fn every_truncated_tail_keeps_only_preceding_complete_samples() {
        let first = media(0, true, 60);
        let second = media(60, false, 60);
        for cut in 0..second.len() {
            let bytes = [&first[..], &second[..cut]].concat();
            let prefix = parse(&init(), &bytes).unwrap();
            assert_eq!(prefix.length, first.len() as u64, "cut {cut}");
            assert_eq!(prefix.duration, Duration::from_secs(2));
        }
        for cut in 0..first.len() {
            assert!(parse(&init(), &first[..cut]).is_err(), "cut {cut}");
        }
    }

    #[test]
    fn requires_keyframe_at_segment_start_and_contiguous_decode_times() {
        assert!(parse(&init(), &media(0, false, 60)).is_err());
        for time in [0, 59, 61] {
            let first = media(0, true, 60);
            let bytes = [first.clone(), media(time, false, 60)].concat();
            assert_eq!(parse(&init(), &bytes).unwrap().length, first.len() as u64);
        }
    }

    #[test]
    fn rejects_invalid_track_and_sample_ranges() {
        let original = media(0, true, 60);
        for (needle, delta, value) in [
            (b"tfhd", 8, 2),
            (b"trun", 8, 0),
            (b"trun", 12, 0),
            (b"trun", 8, u32::MAX),
        ] {
            let mut bytes = original.clone();
            let offset = bytes.windows(4).position(|slice| slice == needle).unwrap() + delta;
            bytes[offset..offset + 4].copy_from_slice(&value.to_be_bytes());
            assert!(parse(&init(), &bytes).is_err());
        }
        let mut invalid_init = init();
        let offset = invalid_init
            .windows(4)
            .position(|slice| slice == b"mdhd")
            .unwrap()
            + 16;
        invalid_init[offset..offset + 4].fill(0);
        assert!(parse(&invalid_init, &original).is_err());
    }
}
