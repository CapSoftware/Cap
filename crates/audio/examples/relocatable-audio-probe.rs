use cap_audio::{AudioData, AudioStream, ChunkRead};
use cap_enc_ffmpeg::RelocatableSource;
use std::{
    error::Error,
    fs, io,
    path::{Path, PathBuf},
    sync::{Arc, atomic::AtomicBool},
    time::Instant,
};

fn main() -> Result<(), Box<dyn Error>> {
    let input = std::env::args_os()
        .nth(1)
        .map(PathBuf::from)
        .ok_or_else(|| io::Error::other("Expected one audio file path"))?;
    ffmpeg::init()?;
    let reference = AudioData::from_file(&input).map_err(io::Error::other)?;
    let directory = tempfile::tempdir()?;
    let original = directory.path().join("original");
    let retained = directory.path().join("retained");
    fs::create_dir(&original)?;
    let relative = input
        .file_name()
        .map(Path::new)
        .ok_or_else(|| io::Error::other("Missing audio file name"))?;
    fs::copy(&input, original.join(relative))?;
    let source = RelocatableSource::new(original.clone())?;
    let started = Instant::now();
    let mut stream =
        AudioStream::open_relocatable(&source, [relative], Arc::new(AtomicBool::new(false)))?;
    let mut compared_frames = 0;
    let mut first_window_ms = None;
    let mut relocations = Vec::new();
    let mut move_index = 0;
    let mut root_is_original = true;
    let thresholds = [
        0,
        reference.sample_count() / 4,
        reference.sample_count() / 2,
        reference.sample_count() * 3 / 4,
    ];
    let mut failed_move_verified = false;
    loop {
        match stream.read_chunk(12_000)? {
            ChunkRead::Chunk(chunk) => {
                first_window_ms.get_or_insert_with(|| started.elapsed().as_secs_f64() * 1_000.0);
                if chunk.source_start_sample as usize != compared_frames
                    || chunk.channels != reference.channels()
                {
                    return Err(io::Error::other("Audio frame position or channels differ").into());
                }
                let sample_offset = compared_frames * usize::from(reference.channels());
                let expected = reference
                    .samples()
                    .get(sample_offset..sample_offset + chunk.samples.len())
                    .ok_or_else(|| io::Error::other("Decoded output exceeds reference"))?;
                for (index, (actual, expected)) in chunk.samples.iter().zip(expected).enumerate() {
                    if actual.to_bits() != expected.to_bits() {
                        return Err(io::Error::other(format!(
                            "Decoded sample differs at {}",
                            sample_offset + index
                        ))
                        .into());
                    }
                }
                compared_frames += chunk.samples.len() / usize::from(reference.channels());
                if move_index < thresholds.len() && compared_frames >= thresholds[move_index] {
                    let target = if root_is_original {
                        &retained
                    } else {
                        &original
                    };
                    let move_started = Instant::now();
                    source.relocate(target.clone())?;
                    relocations.push(move_started.elapsed().as_secs_f64() * 1_000.0);
                    root_is_original = !root_is_original;
                    move_index += 1;
                    if move_index == 1 {
                        if source
                            .relocate(directory.path().join("missing/target"))
                            .is_ok()
                        {
                            return Err(io::Error::other(
                                "Injected relocation unexpectedly succeeded",
                            )
                            .into());
                        }
                        failed_move_verified = true;
                        fs::create_dir(&original)?;
                        fs::write(original.join(relative), b"published output")?;
                        if fs::read(original.join(relative))? != b"published output" {
                            return Err(
                                io::Error::other("Ordinary output path was redirected").into()
                            );
                        }
                        fs::remove_file(original.join(relative))?;
                        fs::remove_dir(&original)?;
                    }
                }
            }
            ChunkRead::Eof { next_sample } => {
                if next_sample as usize != reference.sample_count()
                    || compared_frames != reference.sample_count()
                {
                    return Err(io::Error::other("Decoded EOF differs from reference").into());
                }
                break;
            }
        }
    }
    let validation_ms = started.elapsed().as_secs_f64() * 1_000.0;
    let source_path = if root_is_original {
        original.join(relative)
    } else {
        retained.join(relative)
    };
    if fs::read(source_path)? != fs::read(&input)? {
        return Err(io::Error::other("Retained source bytes changed").into());
    }
    if stream.validate_to_end()? as usize != compared_frames {
        return Err(io::Error::other("Repeated EOF changed").into());
    }
    println!(
        "{}",
        serde_json::json!({
            "input": input,
            "channels": reference.channels(),
            "comparedFrames": compared_frames,
            "everyDecodedSampleBitMatches": true,
            "retainedSourceExact": true,
            "failedRelocationPreservedReader": failed_move_verified,
            "relocationMs": relocations,
            "first250msWindowMs": first_window_ms,
            "validationMs": validation_ms,
            "method": "Single managed decoder remains alive through publication and rollback; full reference decode occurs before timing. Validation time includes exact PCM comparisons and relocation. This is not a Stop-to-editor benchmark."
        })
    );
    Ok(())
}
