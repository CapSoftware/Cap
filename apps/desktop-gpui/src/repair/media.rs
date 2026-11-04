use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

use serde::Serialize;

const MAX_BOXES: usize = 4096;
const BLOCK: usize = 4096;
const FULL_SCAN_LIMIT: u64 = 256 * 1024 * 1024;
const TAIL_SCAN_LIMIT: u64 = 256 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct BoxEntry {
    #[serde(rename = "type")]
    pub kind: String,
    pub offset: u64,
    pub size: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaInspection {
    pub path: String,
    pub size: u64,
    pub all_zero: bool,
    pub zero_tail_bytes: u64,
    pub boxes: Vec<BoxEntry>,
    pub trailing_bytes: u64,
    pub complete_fragment: Option<bool>,
}

fn box_kind(raw: [u8; 4]) -> String {
    raw.iter()
        .map(|byte| {
            if byte.is_ascii_alphanumeric() || *byte == b' ' {
                *byte as char
            } else {
                '?'
            }
        })
        .collect()
}

pub fn top_level_boxes(
    file: &mut std::fs::File,
    size: u64,
) -> std::io::Result<(Vec<BoxEntry>, u64)> {
    let mut boxes = Vec::new();
    let mut offset = 0u64;
    while offset < size && boxes.len() < MAX_BOXES {
        if size - offset < 8 {
            break;
        }
        file.seek(SeekFrom::Start(offset))?;
        let mut header = [0u8; 8];
        file.read_exact(&mut header)?;
        let declared = u32::from_be_bytes([header[0], header[1], header[2], header[3]]) as u64;
        let kind_raw = [header[4], header[5], header[6], header[7]];
        if kind_raw == [0, 0, 0, 0] {
            break;
        }
        let box_size = match declared {
            0 => size - offset,
            1 => {
                if size - offset < 16 {
                    break;
                }
                let mut large = [0u8; 8];
                file.read_exact(&mut large)?;
                u64::from_be_bytes(large)
            }
            value => value,
        };
        let header_len = if declared == 1 { 16 } else { 8 };
        if box_size < header_len || box_size > size - offset {
            break;
        }
        boxes.push(BoxEntry {
            kind: box_kind(kind_raw),
            offset,
            size: box_size,
        });
        offset += box_size;
    }
    Ok((boxes, size - offset.min(size)))
}

fn block_is_zero(block: &[u8]) -> bool {
    block.iter().all(|byte| *byte == 0)
}

#[cfg(test)]
pub fn zero_bytes_in_range(path: &Path, start: u64, end: u64) -> std::io::Result<u64> {
    zero_bytes_in_range_until(path, start, end, u64::MAX).map(|(zero, _)| zero)
}

pub fn zero_bytes_in_range_until(
    path: &Path,
    start: u64,
    end: u64,
    max_non_zero: u64,
) -> std::io::Result<(u64, bool)> {
    if end <= start {
        return Ok((0, false));
    }
    let mut file = std::fs::File::open(path)?;
    file.seek(SeekFrom::Start(start))?;
    let mut buffer = vec![0u8; 1024 * 1024];
    let mut remaining = end - start;
    let mut zero = 0u64;
    let mut non_zero = 0u64;
    while remaining > 0 {
        let want = remaining.min(buffer.len() as u64) as usize;
        let read = file.read(&mut buffer[..want])?;
        if read == 0 {
            break;
        }
        for block in buffer[..read].chunks(BLOCK) {
            if block_is_zero(block) {
                zero += block.len() as u64;
            } else {
                non_zero += block.len() as u64;
            }
        }
        if non_zero > max_non_zero {
            return Ok((zero, true));
        }
        remaining -= read as u64;
    }
    Ok((zero, false))
}

fn zero_tail(path: &Path, size: u64) -> std::io::Result<u64> {
    let mut file = std::fs::File::open(path)?;
    let mut tail = 0u64;
    let mut buffer = vec![0u8; 1024 * 1024];
    let floor = size.saturating_sub(TAIL_SCAN_LIMIT);
    let mut end = size;
    while end > floor {
        let start = end.saturating_sub(buffer.len() as u64).max(floor);
        let len = (end - start) as usize;
        file.seek(SeekFrom::Start(start))?;
        file.read_exact(&mut buffer[..len])?;
        match buffer[..len].iter().rposition(|byte| *byte != 0) {
            Some(position) => return Ok(tail + (len - position - 1) as u64),
            None => tail += len as u64,
        }
        end = start;
    }
    Ok(tail)
}

pub fn inspect(path: &Path, rel: &str, is_fragment: bool) -> Result<MediaInspection, String> {
    let size = path
        .metadata()
        .map_err(|error| format!("cannot read file: {error}"))?
        .len();
    let mut file =
        std::fs::File::open(path).map_err(|error| format!("cannot open file: {error}"))?;
    let (boxes, trailing_bytes) =
        top_level_boxes(&mut file, size).map_err(|error| format!("cannot read boxes: {error}"))?;
    let zero_tail_bytes =
        zero_tail(path, size).map_err(|error| format!("cannot scan file: {error}"))?;
    let all_zero = if size == 0 {
        true
    } else if size <= FULL_SCAN_LIMIT {
        zero_tail_bytes == size
    } else {
        false
    };
    let complete_fragment =
        is_fragment.then(|| cap_recording::recovery::RecoveryManager::is_m4s_complete(path));
    Ok(MediaInspection {
        path: rel.to_string(),
        size,
        all_zero,
        zero_tail_bytes,
        boxes,
        trailing_bytes,
        complete_fragment,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_file(tag: &str, bytes: &[u8]) -> std::path::PathBuf {
        let path = std::env::temp_dir().join(format!(
            "cap-repair-media-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::write(&path, bytes).unwrap();
        path
    }

    fn mp4_box(kind: &[u8; 4], payload: usize) -> Vec<u8> {
        let mut out = ((payload + 8) as u32).to_be_bytes().to_vec();
        out.extend_from_slice(kind);
        out.extend(std::iter::repeat_n(7u8, payload));
        out
    }

    #[test]
    fn parses_top_level_boxes_and_trailing_garbage() {
        let mut bytes = mp4_box(b"styp", 8);
        bytes.extend(mp4_box(b"moof", 100));
        bytes.extend(mp4_box(b"mdat", 500));
        bytes.extend([9u8; 5]);
        let path = temp_file("boxes", &bytes);
        let inspection = inspect(&path, "a.m4s", false).unwrap();
        let kinds: Vec<_> = inspection.boxes.iter().map(|b| b.kind.as_str()).collect();
        assert_eq!(kinds, ["styp", "moof", "mdat"]);
        assert_eq!(inspection.trailing_bytes, 5);
        assert!(!inspection.all_zero);
        assert_eq!(inspection.zero_tail_bytes, 0);
        std::fs::remove_file(path).ok();
    }

    #[test]
    fn detects_torn_zero_files_and_tails() {
        let path = temp_file("zero", &vec![0u8; 3 * 1024 * 1024 + 17]);
        let inspection = inspect(&path, "torn.m4s", false).unwrap();
        assert!(inspection.all_zero);
        assert!(inspection.boxes.is_empty());
        assert_eq!(inspection.zero_tail_bytes, 3 * 1024 * 1024 + 17);
        std::fs::remove_file(path).ok();

        let mut bytes = mp4_box(b"moof", 16);
        bytes.extend(vec![0u8; 10_000]);
        let path = temp_file("tail", &bytes);
        let inspection = inspect(&path, "tail.m4s", false).unwrap();
        assert_eq!(inspection.zero_tail_bytes, 10_000);
        assert!(!inspection.all_zero);
        std::fs::remove_file(path).ok();
    }

    #[test]
    fn oversized_box_stops_the_walk() {
        let mut bytes = 9999u32.to_be_bytes().to_vec();
        bytes.extend_from_slice(b"mdat");
        bytes.extend([1u8; 20]);
        let path = temp_file("oversized", &bytes);
        let inspection = inspect(&path, "x.mp4", false).unwrap();
        assert!(inspection.boxes.is_empty());
        assert_eq!(inspection.trailing_bytes, bytes.len() as u64);
        std::fs::remove_file(path).ok();
    }

    #[test]
    fn zero_accounting_is_block_based_and_stops_early() {
        let mut bytes = vec![0u8; BLOCK * 3];
        bytes[BLOCK + 10] = 1;
        let path = temp_file("blocks", &bytes);
        assert_eq!(
            zero_bytes_in_range(&path, 0, bytes.len() as u64).unwrap(),
            (BLOCK * 2) as u64
        );
        let (_, exceeded) = zero_bytes_in_range_until(&path, 0, bytes.len() as u64, 0).unwrap();
        assert!(exceeded);
        std::fs::remove_file(path).ok();
    }
}
