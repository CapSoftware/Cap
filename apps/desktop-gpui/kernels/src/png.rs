const LEVEL: u32 = 6;
const WINDOW: usize = 32 * 1024;
const MIN_STRIP_BYTES: usize = 1024 * 1024;
const MAX_STRIPS: usize = 8;
const MAX_CHUNK: usize = (u32::MAX >> 1) as usize;

pub fn encode(
    data: &[u8],
    width: u32,
    height: u32,
    color: image::ExtendedColorType,
) -> image::ImageResult<Vec<u8>> {
    let mut png = Vec::new();
    write(&mut png, data, width, height, color)?;
    Ok(png)
}

pub fn write<W: std::io::Write>(
    out: W,
    data: &[u8],
    width: u32,
    height: u32,
    color: image::ExtendedColorType,
) -> image::ImageResult<()> {
    write_strips(out, data, width, height, color, None, MAX_CHUNK)
}

fn write_strips<W: std::io::Write>(
    mut out: W,
    data: &[u8],
    width: u32,
    height: u32,
    color: image::ExtendedColorType,
    strips: Option<usize>,
    max_chunk: usize,
) -> image::ImageResult<()> {
    let (bpp, color_type) = match color {
        image::ExtendedColorType::Rgb8 => (3, 2),
        image::ExtendedColorType::Rgba8 => (4, 6),
        _ => return write_single(&mut out, data, width, height, color),
    };
    let stride = width as usize * bpp;
    let rows = height as usize;
    if data.len() != stride * rows {
        return Err(image::ImageError::Parameter(
            image::error::ParameterError::from_kind(
                image::error::ParameterErrorKind::DimensionMismatch,
            ),
        ));
    }
    if width == 0 || height == 0 {
        return write_single(&mut out, data, width, height, color);
    }

    let filtered_len = rows * (stride + 1);
    let strips = strips.unwrap_or_else(|| {
        let threads = std::thread::available_parallelism()
            .map(|n| n.get())
            .unwrap_or(1)
            .min(MAX_STRIPS);
        (filtered_len / MIN_STRIP_BYTES).clamp(1, threads)
    });
    let per_strip = rows.div_ceil(strips.clamp(1, rows));
    let ranges: Vec<(usize, usize)> = (0..rows)
        .step_by(per_strip)
        .map(|start| (start, per_strip.min(rows - start)))
        .collect();

    let mut filtered = vec![0u8; filtered_len];
    std::thread::scope(|scope| {
        let mut rest = filtered.as_mut_slice();
        for &(start, count) in &ranges {
            let (strip, tail) = rest.split_at_mut(count * (stride + 1));
            rest = tail;
            scope.spawn(move || filter_rows(data, stride, bpp, start, strip));
        }
    });

    let filtered_rows = filtered.as_slice();
    let compressed = std::thread::scope(|scope| {
        let handles: Vec<_> = ranges
            .iter()
            .map(|&(start, count)| {
                scope.spawn(move || {
                    let from = start * (stride + 1);
                    let to = from + count * (stride + 1);
                    let dictionary = &filtered_rows[from.saturating_sub(WINDOW)..from];
                    compress_strip(
                        &filtered_rows[from..to],
                        dictionary,
                        to == filtered_rows.len(),
                    )
                })
            })
            .collect();
        handles
            .into_iter()
            .map(|handle| handle.join().expect("PNG strip encoder panicked"))
            .collect::<Result<Vec<_>, _>>()
    })
    .map_err(image::ImageError::IoError)?;

    let mut adler = simd_adler32::Adler32::new();
    adler.write(filtered_rows);
    let adler = adler.finish().to_be_bytes();
    drop(filtered);

    let mut ihdr = [0u8; 13];
    ihdr[..4].copy_from_slice(&width.to_be_bytes());
    ihdr[4..8].copy_from_slice(&height.to_be_bytes());
    ihdr[8] = 8;
    ihdr[9] = color_type;

    let mut idat: Vec<&[u8]> = Vec::with_capacity(compressed.len() + 2);
    idat.push(&[0x78, 0x9c]);
    idat.extend(compressed.iter().map(Vec::as_slice));
    idat.push(&adler);

    out.write_all(b"\x89PNG\r\n\x1a\n")?;
    write_chunk(&mut out, b"IHDR", &[&ihdr], MAX_CHUNK)?;
    write_chunk(&mut out, b"IDAT", &idat, max_chunk)?;
    write_chunk(&mut out, b"IEND", &[], MAX_CHUNK)?;
    out.flush()?;
    Ok(())
}

fn write_single<W: std::io::Write>(
    out: &mut W,
    data: &[u8],
    width: u32,
    height: u32,
    color: image::ExtendedColorType,
) -> image::ImageResult<()> {
    use image::ImageEncoder as _;
    image::codecs::png::PngEncoder::new_with_quality(
        &mut *out,
        image::codecs::png::CompressionType::Default,
        image::codecs::png::FilterType::Adaptive,
    )
    .write_image(data, width, height, color)?;
    out.flush()?;
    Ok(())
}

fn compress_strip(strip: &[u8], dictionary: &[u8], last: bool) -> std::io::Result<Vec<u8>> {
    let mut compress = flate2::Compress::new(flate2::Compression::new(LEVEL), false);
    if !dictionary.is_empty() {
        compress
            .set_dictionary(dictionary)
            .map_err(std::io::Error::other)?;
    }
    let flush = if last {
        flate2::FlushCompress::Finish
    } else {
        flate2::FlushCompress::Sync
    };
    let mut out = Vec::with_capacity(strip.len() / 4 + 1024);
    loop {
        if out.len() == out.capacity() {
            out.reserve(out.capacity() / 2 + 1024);
        }
        let consumed = compress.total_in() as usize;
        let status = compress
            .compress_vec(&strip[consumed..], &mut out, flush)
            .map_err(std::io::Error::other)?;
        let drained = compress.total_in() as usize == strip.len() && out.len() < out.capacity();
        if status == flate2::Status::StreamEnd || (!last && drained) {
            return Ok(out);
        }
    }
}

// Writes `parts` back to back as the payload of one chunk, or of several
// consecutive chunks of the same type when it is longer than `max_chunk`.
fn write_chunk<W: std::io::Write>(
    out: &mut W,
    kind: &[u8; 4],
    parts: &[&[u8]],
    max_chunk: usize,
) -> std::io::Result<()> {
    let mut remaining: usize = parts.iter().map(|part| part.len()).sum();
    let mut parts = parts.iter().copied();
    let mut current: &[u8] = &[];
    loop {
        let len = remaining.min(max_chunk);
        let mut crc = crc32fast::Hasher::new();
        crc.update(kind);
        out.write_all(&(len as u32).to_be_bytes())?;
        out.write_all(kind)?;
        let mut left = len;
        while left > 0 {
            while current.is_empty() {
                current = parts.next().expect("chunk parts cover its length");
            }
            let (head, tail) = current.split_at(left.min(current.len()));
            out.write_all(head)?;
            crc.update(head);
            current = tail;
            left -= head.len();
        }
        out.write_all(&crc.finalize().to_be_bytes())?;
        remaining -= len;
        if remaining == 0 {
            return Ok(());
        }
    }
}

fn filter_rows(data: &[u8], stride: usize, bpp: usize, first_row: usize, out: &mut [u8]) {
    let zero = vec![0u8; stride];
    let mut candidate = vec![0u8; stride];
    for (index, row_out) in out.chunks_exact_mut(stride + 1).enumerate() {
        let row = first_row + index;
        let current = &data[row * stride..(row + 1) * stride];
        let previous = match row {
            0 => zero.as_slice(),
            _ => &data[(row - 1) * stride..row * stride],
        };
        let (kind, filtered) = row_out.split_at_mut(1);
        kind[0] = adaptive_filter(bpp, previous, current, filtered, &mut candidate);
    }
}

// The png crate's `Filter::Adaptive`: try Up, Sub, Avg, Paeth and keep the one
// with the smallest sum of absolute signed bytes, later filters winning ties.
fn adaptive_filter(
    bpp: usize,
    previous: &[u8],
    current: &[u8],
    output: &mut [u8],
    candidate: &mut [u8],
) -> u8 {
    let mut best_cost = u64::MAX;
    let mut best = 0;
    for kind in [2, 1, 3, 4] {
        apply_filter(kind, bpp, previous, current, candidate);
        let cost = sum_abs(candidate);
        if cost <= best_cost {
            best_cost = cost;
            best = kind;
            output.copy_from_slice(candidate);
            if cost == 0 {
                break;
            }
        }
    }
    best
}

fn sum_abs(buf: &[u8]) -> u64 {
    buf.chunks(32)
        .map(|chunk| {
            chunk
                .iter()
                .map(|&b| u64::from((b as i8).unsigned_abs()))
                .sum::<u64>()
        })
        .sum()
}

fn apply_filter(kind: u8, bpp: usize, previous: &[u8], current: &[u8], out: &mut [u8]) {
    let len = current.len();
    match kind {
        1 => {
            out[..bpp].copy_from_slice(&current[..bpp]);
            for i in bpp..len {
                out[i] = current[i].wrapping_sub(current[i - bpp]);
            }
        }
        2 => {
            for i in 0..len {
                out[i] = current[i].wrapping_sub(previous[i]);
            }
        }
        3 => {
            for i in 0..bpp {
                out[i] = current[i].wrapping_sub(previous[i] / 2);
            }
            for i in bpp..len {
                let (a, b) = (current[i - bpp], previous[i]);
                out[i] = current[i].wrapping_sub((a & b) + ((a ^ b) >> 1));
            }
        }
        4 => {
            for i in 0..bpp {
                out[i] = current[i].wrapping_sub(previous[i]);
            }
            for i in bpp..len {
                out[i] = current[i].wrapping_sub(paeth(
                    current[i - bpp],
                    previous[i],
                    previous[i - bpp],
                ));
            }
        }
        _ => out.copy_from_slice(current),
    }
}

fn paeth(a: u8, b: u8, c: u8) -> u8 {
    let (a16, b16, c16) = (a as i16, b as i16, c as i16);
    let pa = (b16 - c16).abs();
    let pb = (a16 - c16).abs();
    let pc = (a16 + b16 - 2 * c16).abs();
    if pa <= pb && pa <= pc {
        a
    } else if pb <= pc {
        b
    } else {
        c
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn screen_like(width: u32, height: u32, channels: usize) -> Vec<u8> {
        let mut state = 0x2545_f491_u32;
        let mut data = Vec::with_capacity(width as usize * height as usize * channels);
        for y in 0..height {
            for x in 0..width {
                state ^= state << 13;
                state ^= state >> 17;
                state ^= state << 5;
                let band = ((x / 37 + y / 23) % 7) as u8 * 30;
                let noise = if (x + y) % 11 == 0 { state as u8 } else { 0 };
                let px = [
                    band,
                    band.wrapping_add(noise),
                    (x ^ y) as u8,
                    (y % 256) as u8,
                ];
                data.extend_from_slice(&px[..channels]);
            }
        }
        data
    }

    fn decode(png: &[u8]) -> image::DynamicImage {
        image::load_from_memory_with_format(png, image::ImageFormat::Png).unwrap()
    }

    fn encode_with(
        data: &[u8],
        width: u32,
        height: u32,
        color: image::ExtendedColorType,
        strips: Option<usize>,
        max_chunk: usize,
    ) -> Vec<u8> {
        let mut png = Vec::new();
        write_strips(&mut png, data, width, height, color, strips, max_chunk).unwrap();
        png
    }

    fn assert_round_trip(png: &[u8], data: &[u8], width: u32, height: u32, channels: usize) {
        let decoded = decode(png);
        assert_eq!((decoded.width(), decoded.height()), (width, height));
        let pixels = match channels {
            3 => decoded.to_rgb8().into_raw(),
            _ => decoded.to_rgba8().into_raw(),
        };
        assert!(
            pixels == data,
            "{width}x{height}x{channels} did not round-trip"
        );
    }

    #[test]
    fn round_trips_rgb_and_rgba_across_strip_counts() {
        for (width, height) in [(1, 1), (7, 3), (3024, 1964), (1501, 2049), (4000, 300)] {
            for (channels, color) in [
                (3, image::ExtendedColorType::Rgb8),
                (4, image::ExtendedColorType::Rgba8),
            ] {
                let data = screen_like(width, height, channels);
                let png = encode(&data, width, height, color).unwrap();
                assert_round_trip(&png, &data, width, height, channels);
                for strips in [1, 2, 3, 8] {
                    let png = encode_with(&data, width, height, color, Some(strips), MAX_CHUNK);
                    assert_round_trip(&png, &data, width, height, channels);
                }
            }
        }
    }

    #[test]
    fn splits_long_image_data_across_idat_chunks() {
        let (width, height) = (640, 480);
        let data = screen_like(width, height, 4);
        let color = image::ExtendedColorType::Rgba8;
        let whole = encode_with(&data, width, height, color, Some(4), MAX_CHUNK);
        let split = encode_with(&data, width, height, color, Some(4), 1000);
        let idat_chunks = |png: &[u8]| {
            let (mut offset, mut count) = (8, 0);
            while offset < png.len() {
                let len = u32::from_be_bytes(png[offset..offset + 4].try_into().unwrap());
                count += usize::from(&png[offset + 4..offset + 8] == b"IDAT");
                offset += 12 + len as usize;
            }
            count
        };
        assert_eq!(idat_chunks(&whole), 1);
        assert!(idat_chunks(&split) > 1);
        assert_round_trip(&whole, &data, width, height, 4);
        assert_round_trip(&split, &data, width, height, 4);
    }

    #[test]
    fn matches_the_single_stream_encoder_size() {
        let (width, height) = (3024, 1964);
        let data = screen_like(width, height, 3);
        let parallel = encode(&data, width, height, image::ExtendedColorType::Rgb8).unwrap();
        let mut single = Vec::new();
        write_single(
            &mut single,
            &data,
            width,
            height,
            image::ExtendedColorType::Rgb8,
        )
        .unwrap();
        let ratio = parallel.len() as f64 / single.len() as f64;
        assert!(
            ratio < 1.005,
            "parallel PNG is {ratio:.4}x the single-stream size"
        );
    }

    #[test]
    fn falls_back_for_other_layouts() {
        let gray = vec![128u8; 64 * 32];
        let png = encode(&gray, 64, 32, image::ExtendedColorType::L8).unwrap();
        assert_eq!(decode(&png).to_luma8().into_raw(), gray);
        assert!(encode(&gray, 64, 32, image::ExtendedColorType::Rgb8).is_err());
    }
}
