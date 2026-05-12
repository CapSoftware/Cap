use std::{
    fs::File,
    io::{Read, Seek, SeekFrom},
    path::Path,
};

pub fn tail_is_complete(path: &Path) -> std::io::Result<bool> {
    let mut file = File::open(path)?;
    let file_size = file.metadata()?.len();
    let mut offset = 0u64;
    let mut previous_box = None;
    let mut last_box = None;

    while offset < file_size {
        let (box_type, box_size) = match read_box_header(&mut file, offset, file_size)? {
            Some(header) => header,
            None => return Ok(false),
        };
        if box_size == 0 {
            return Ok(false);
        }
        previous_box = last_box;
        last_box = Some(box_type);
        offset = box_size;
    }

    Ok(offset == file_size && previous_box == Some(*b"moof") && last_box == Some(*b"mdat"))
}

fn read_box_header(
    file: &mut File,
    offset: u64,
    file_size: u64,
) -> std::io::Result<Option<([u8; 4], u64)>> {
    if file_size.saturating_sub(offset) < 8 {
        return Ok(None);
    }

    file.seek(SeekFrom::Start(offset))?;
    let mut header = [0u8; 8];
    file.read_exact(&mut header)?;

    let size32 = u32::from_be_bytes(header[..4].try_into().unwrap()) as u64;
    let box_type = header[4..8].try_into().unwrap();

    let end = match size32 {
        0 => file_size,
        1 => {
            if file_size.saturating_sub(offset) < 16 {
                return Ok(None);
            }
            let mut large_size = [0u8; 8];
            file.read_exact(&mut large_size)?;
            u64::from_be_bytes(large_size)
        }
        size => size,
    };

    let header_size = if size32 == 1 { 16 } else { 8 };
    if end < header_size {
        return Ok(None);
    }

    let next_offset = offset.saturating_add(end);
    if next_offset > file_size {
        return Ok(None);
    }

    Ok(Some((box_type, next_offset)))
}

#[cfg(test)]
mod tests {
    use super::tail_is_complete;
    use std::{fs::OpenOptions, io::Write};

    fn write_box(file: &mut std::fs::File, name: &[u8; 4], payload_len: usize) {
        let size = (payload_len + 8) as u32;
        file.write_all(&size.to_be_bytes()).unwrap();
        file.write_all(name).unwrap();
        file.write_all(&vec![0u8; payload_len]).unwrap();
    }

    #[test]
    fn complete_tail_returns_true() {
        let temp = tempfile::NamedTempFile::new().unwrap();
        let mut file = OpenOptions::new().write(true).open(temp.path()).unwrap();
        write_box(&mut file, b"styp", 4);
        write_box(&mut file, b"moof", 16);
        write_box(&mut file, b"mdat", 64);
        drop(file);

        assert!(tail_is_complete(temp.path()).unwrap());
    }

    #[test]
    fn truncated_mdat_returns_false() {
        let temp = tempfile::NamedTempFile::new().unwrap();
        let mut file = OpenOptions::new().write(true).open(temp.path()).unwrap();
        write_box(&mut file, b"styp", 4);
        write_box(&mut file, b"moof", 16);
        write_box(&mut file, b"mdat", 64);
        drop(file);

        let file = OpenOptions::new().write(true).open(temp.path()).unwrap();
        file.set_len(temp.path().metadata().unwrap().len() - 12)
            .unwrap();

        assert!(!tail_is_complete(temp.path()).unwrap());
    }
}
