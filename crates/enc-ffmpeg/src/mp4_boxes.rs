use std::path::Path;

const MAX_MOOV_BYTES: u64 = 64 * 1024 * 1024;

fn box_header(data: &[u8]) -> Option<([u8; 4], usize, usize)> {
    let size = u32::from_be_bytes(data.get(0..4)?.try_into().ok()?) as u64;
    let kind: [u8; 4] = data.get(4..8)?.try_into().ok()?;
    let (size, header) = match size {
        0 => (data.len() as u64, 8),
        1 => (u64::from_be_bytes(data.get(8..16)?.try_into().ok()?), 16),
        size => (size, 8),
    };
    let size = usize::try_from(size).ok()?;
    (size >= header && size <= data.len()).then_some((kind, header, size))
}

fn child_boxes(mut data: &[u8]) -> impl Iterator<Item = ([u8; 4], &[u8])> {
    std::iter::from_fn(move || {
        let (kind, header, size) = box_header(data)?;
        let payload = &data[header..size];
        data = &data[size..];
        Some((kind, payload))
    })
}

fn child_box<'a>(data: &'a [u8], kind: &[u8; 4]) -> Option<&'a [u8]> {
    child_boxes(data)
        .find(|(child, _)| child == kind)
        .map(|(_, payload)| payload)
}

fn read_be_u32(data: &[u8], at: usize) -> Option<u32> {
    Some(u32::from_be_bytes(data.get(at..at + 4)?.try_into().ok()?))
}

fn read_moov(path: &Path) -> Option<Vec<u8>> {
    use std::io::{Read, Seek, SeekFrom};

    let mut file = std::fs::File::open(path).ok()?;
    let file_len = file.metadata().ok()?.len();
    let mut offset = 0u64;
    let mut moov = None;
    while offset + 8 <= file_len {
        file.seek(SeekFrom::Start(offset)).ok()?;
        let mut header = [0u8; 16];
        let available = (file_len - offset).min(16) as usize;
        file.read_exact(&mut header[..available]).ok()?;
        let kind: [u8; 4] = header[4..8].try_into().ok()?;
        let (size, header_len) = match u32::from_be_bytes(header[0..4].try_into().ok()?) {
            0 => (file_len - offset, 8),
            1 if available == 16 => (u64::from_be_bytes(header[8..16].try_into().ok()?), 16),
            1 => return None,
            size => (u64::from(size), 8),
        };
        if size < header_len || offset + size > file_len {
            return None;
        }
        match &kind {
            b"moof" => return None,
            b"moov" if moov.is_none() && size <= MAX_MOOV_BYTES => {
                let mut data = vec![0u8; size as usize];
                file.seek(SeekFrom::Start(offset)).ok()?;
                file.read_exact(&mut data).ok()?;
                moov = Some(data);
            }
            b"moov" => return None,
            _ => {}
        }
        offset += size;
    }
    moov
}

// The sample table stores decode times, so it only matches presentation times
// when every composition offset in the track is zero: the track has no `ctts`
// box, or all of its entries are zero. Fragmented files keep offsets per
// fragment instead and are never eligible.
pub fn track_has_no_composition_offsets(path: &Path, track_id: i32) -> bool {
    let check = || -> Option<bool> {
        let moov_box = read_moov(path)?;
        let (_, header, size) = box_header(&moov_box)?;
        let moov = &moov_box[header..size];
        if child_box(moov, b"mvex").is_some() {
            return None;
        }
        let track = child_boxes(moov)
            .filter(|(kind, _)| kind == b"trak")
            .map(|(_, trak)| trak)
            .find(|trak| {
                child_box(trak, b"tkhd").and_then(|tkhd| {
                    let id_at = if tkhd.first() == Some(&1) { 20 } else { 12 };
                    read_be_u32(tkhd, id_at)
                }) == Some(track_id as u32)
            })?;
        let stbl = child_box(child_box(child_box(track, b"mdia")?, b"minf")?, b"stbl")?;
        let Some(ctts) = child_box(stbl, b"ctts") else {
            return Some(true);
        };
        let entries = read_be_u32(ctts, 4)? as usize;
        (0..entries)
            .map(|entry| read_be_u32(ctts, 8 + entry * 8 + 4))
            .try_fold(true, |all_zero, offset| Some(all_zero && offset? == 0))
    };
    check().unwrap_or(false)
}
