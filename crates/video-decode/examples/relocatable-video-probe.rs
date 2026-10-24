use cap_enc_ffmpeg::RelocatableSource;
use cap_video_decode::FFmpegDecoder;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::Read,
    path::{Path, PathBuf},
    time::Instant,
};

fn file_digest(path: &Path) -> Result<String, String> {
    let mut file = fs::File::open(path).map_err(|error| error.to_string())?;
    let mut digest = Sha256::new();
    let mut buffer = [0_u8; 65_536];
    loop {
        let read = file.read(&mut buffer).map_err(|error| error.to_string())?;
        if read == 0 {
            break;
        }
        digest.update(&buffer[..read]);
    }
    Ok(format!("{:x}", digest.finalize()))
}

fn fingerprint(
    frames: impl IntoIterator<Item = Result<ffmpeg::frame::Video, ffmpeg::Error>>,
) -> Result<Value, String> {
    let mut hash = Sha256::new();
    let mut timestamps = Vec::new();
    for frame in frames {
        let frame = frame.map_err(|error| error.to_string())?;
        let timestamp = frame.timestamp().or_else(|| frame.pts());
        timestamps.push(timestamp);
        hash.update(timestamp.unwrap_or(i64::MIN).to_le_bytes());
        hash.update(frame.width().to_le_bytes());
        hash.update(frame.height().to_le_bytes());
        if frame.planes() == 0 {
            return Err("Decoded frame has no readable planes".into());
        }
        for plane in 0..frame.planes() {
            let row_bytes = unsafe {
                ffmpeg::sys::av_image_get_linesize(
                    frame.format().into(),
                    frame.width() as i32,
                    plane as i32,
                )
            };
            if row_bytes <= 0 || row_bytes as usize > frame.stride(plane) {
                return Err("Decoded frame has an invalid row size".into());
            }
            for row in frame
                .data(plane)
                .chunks(frame.stride(plane))
                .take(frame.plane_height(plane) as usize)
            {
                hash.update(&row[..row_bytes as usize]);
            }
        }
    }
    if timestamps.is_empty() {
        return Err("No decoded frames in the requested probe".into());
    }
    Ok(json!({
        "frames": timestamps.len(),
        "timestamps": timestamps,
        "sha256": format!("{:x}", hash.finalize()),
    }))
}

fn sample(decoder: &mut FFmpegDecoder, count: usize) -> Result<Value, String> {
    fingerprint(decoder.frames().take(count))
}

struct OpenedDecoder {
    decoder: FFmpegDecoder,
    first: ffmpeg::frame::Video,
    timings: Value,
}

fn open_probe(
    open: impl FnOnce() -> Result<FFmpegDecoder, String>,
) -> Result<OpenedDecoder, String> {
    let started = Instant::now();
    let mut decoder = open()?;
    let opened = Instant::now();
    let first = decoder
        .frames()
        .next()
        .ok_or("No initial decoded frame")?
        .map_err(|error| error.to_string())?;
    let received = Instant::now();
    Ok(OpenedDecoder {
        decoder,
        first,
        timings: json!({
            "openMs": opened.saturating_duration_since(started).as_secs_f64() * 1000.0,
            "firstFrameAfterOpenMs": received.saturating_duration_since(opened).as_secs_f64() * 1000.0,
            "openToFirstFrameMs": received.saturating_duration_since(started).as_secs_f64() * 1000.0,
        }),
    })
}

fn open_managed(
    root: &Path,
    paths: &[PathBuf],
    device: Option<ffmpeg::sys::AVHWDeviceType>,
) -> Result<(RelocatableSource, OpenedDecoder, f64), String> {
    let started = Instant::now();
    let source = RelocatableSource::new(root.to_path_buf()).map_err(|error| error.to_string())?;
    let setup_ms = started.elapsed().as_secs_f64() * 1000.0;
    let decoder = open_probe(|| {
        FFmpegDecoder::new_relocatable(&source, paths.iter().map(PathBuf::as_path), device)
    })?;
    Ok((source, decoder, setup_ms))
}

fn compare(
    label: String,
    reference: &mut FFmpegDecoder,
    candidate: &mut FFmpegDecoder,
    count: usize,
    probes: &mut Vec<Value>,
) -> Result<(), String> {
    let expected = sample(reference, count)?;
    let actual = sample(candidate, count)?;
    if actual != expected {
        return Err(format!(
            "Decoded frame mismatch at {label}: {expected} != {actual}"
        ));
    }
    probes.push(json!({"label": label, "matches": true, "decoded": actual}));
    Ok(())
}

fn move_source(
    source: &RelocatableSource,
    active: &mut PathBuf,
    original: &Path,
    retained: &Path,
) -> Result<(), String> {
    let destination = if active.as_path() == original {
        retained
    } else {
        original
    };
    source
        .relocate(destination.to_path_buf())
        .map_err(|error| format!("relocate active video source / {error}"))?;
    *active = destination.to_path_buf();
    Ok(())
}

fn main() -> Result<(), String> {
    ffmpeg::init().map_err(|error| error.to_string())?;
    let mut arguments = std::env::args().skip(1);
    let input = arguments
        .next()
        .map(PathBuf::from)
        .ok_or("Pass a fragmented video directory and seek times")?;
    let times = arguments
        .map(|time| time.parse::<f32>().map_err(|error| error.to_string()))
        .collect::<Result<Vec<_>, _>>()?;
    if times.is_empty() {
        return Err("Pass representative forward/backward seek times".into());
    }
    let mut files = fs::read_dir(&input)
        .map_err(|error| error.to_string())?
        .map(|entry| entry.map(|entry| entry.path()))
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    files.retain(|path| path.extension().is_some_and(|extension| extension == "m4s"));
    files.sort();
    if files.len() < 2 {
        return Err("Probe requires multiple fragments".into());
    }
    files.insert(0, input.join("init.mp4"));
    let temporary = tempfile::tempdir().map_err(|error| error.to_string())?;
    let original = temporary.path().join("original");
    let retained = temporary.path().join("retained");
    fs::create_dir_all(original.join("display")).map_err(|error| error.to_string())?;
    let mut input_hashes = Vec::new();
    let mut relative_paths = Vec::new();
    for path in &files {
        let relative = Path::new("display").join(path.file_name().ok_or("Missing filename")?);
        fs::copy(path, original.join(&relative)).map_err(|error| error.to_string())?;
        input_hashes.push(file_digest(path)?);
        relative_paths.push(relative);
    }
    let hardware = std::env::var_os("CAP_BENCH_HW").is_some();
    let device = hardware.then_some(if cfg!(target_os = "macos") {
        ffmpeg::sys::AVHWDeviceType::AV_HWDEVICE_TYPE_VIDEOTOOLBOX
    } else if cfg!(target_os = "windows") {
        ffmpeg::sys::AVHWDeviceType::AV_HWDEVICE_TYPE_D3D11VA
    } else {
        ffmpeg::sys::AVHWDeviceType::AV_HWDEVICE_TYPE_VAAPI
    });
    let managed_first = std::env::var_os("CAP_PROBE_MANAGED_FIRST").is_some();
    let (source, managed, ordinary, source_setup_ms) = if managed_first {
        let (source, managed, setup_ms) = open_managed(&original, &relative_paths, device)?;
        let ordinary = open_probe(|| FFmpegDecoder::new(&input, device))?;
        (source, managed, ordinary, setup_ms)
    } else {
        let ordinary = open_probe(|| FFmpegDecoder::new(&input, device))?;
        let (source, managed, setup_ms) = open_managed(&original, &relative_paths, device)?;
        (source, managed, ordinary, setup_ms)
    };
    let timings = json!({
        "ordinary": ordinary.timings,
        "managed": managed.timings,
        "sourceCapabilitySetupMs": source_setup_ms,
        "order": if managed_first { "managed-ordinary" } else { "ordinary-managed" },
        "method": "Each open is immediately followed by its first frame; copy, source hashing and pixel hashing are outside timers. File caches are warmed by copy/hash preparation. Separate byte-identical source directories preserve the ordinary reference during moves. These are component measurements, not Stop/editor latency or p95.",
    });
    let expected_first = fingerprint(std::iter::once(Ok(ordinary.first)))?;
    let actual_first = fingerprint(std::iter::once(Ok(managed.first)))?;
    if expected_first != actual_first {
        return Err("Initial frame mismatch".into());
    }
    let mut reference = ordinary.decoder;
    let mut candidate = managed.decoder;
    if reference.start_time() != candidate.start_time()
        || reference.is_hardware_accelerated() != candidate.is_hardware_accelerated()
    {
        return Err("Decoder origin or selected acceleration changed".into());
    }
    let mut probes =
        vec![json!({"label": "first-frame", "matches": true, "decoded": actual_first})];
    let mut failed_moves = Vec::new();
    let mut active = original.clone();
    compare(
        "prefix".into(),
        &mut reference,
        &mut candidate,
        1,
        &mut probes,
    )?;
    for round in 0..6 {
        move_source(&source, &mut active, &original, &retained)?;
        compare(
            format!("relocation-{round}"),
            &mut reference,
            &mut candidate,
            24,
            &mut probes,
        )?;
        let error = source
            .relocate(temporary.path().join("missing/target"))
            .err()
            .ok_or("Expected a failed relocation")?;
        failed_moves.push(
            json!({"kind": format!("{:?}", error.kind()), "rawOsError": error.raw_os_error()}),
        );
        compare(
            format!("failed-move-{round}"),
            &mut reference,
            &mut candidate,
            1,
            &mut probes,
        )?;
        move_source(&source, &mut active, &original, &retained)?;
        move_source(&source, &mut active, &original, &retained)?;
        compare(
            format!("rollback-{round}"),
            &mut reference,
            &mut candidate,
            1,
            &mut probes,
        )?;
    }
    for time in times {
        move_source(&source, &mut active, &original, &retained)?;
        reference.reset(time).map_err(|error| error.to_string())?;
        candidate.reset(time).map_err(|error| error.to_string())?;
        move_source(&source, &mut active, &original, &retained)?;
        compare(
            format!("seek-{time}"),
            &mut reference,
            &mut candidate,
            30,
            &mut probes,
        )?;
    }
    for ((input, relative), expected) in files.iter().zip(&relative_paths).zip(&input_hashes) {
        if file_digest(input)? != *expected || file_digest(&active.join(relative))? != *expected {
            return Err("An original or relocated source file changed".into());
        }
    }
    println!(
        "{}",
        json!({
            "input": input,
            "sourceFiles": files.len(),
        "timings": timings,
            "sourceHashes": input_hashes,
            "originalsAndRelocatedCopyUnchanged": true,
            "hardwareRequested": hardware,
            "hardwareUsed": candidate.is_hardware_accelerated(),
            "startTime": candidate.start_time(),
            "decoderInstancesPerVariant": 1,
            "failedMoves": failed_moves,
            "probes": probes,
        })
    );
    drop(candidate);
    drop(source);
    drop(reference);
    temporary.close().map_err(|error| error.to_string())?;
    Ok(())
}
