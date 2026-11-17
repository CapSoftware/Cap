use cap_audio::{AudioStream, ChunkRead};
use std::{
    error::Error,
    hint::black_box,
    path::PathBuf,
    sync::{Arc, atomic::AtomicBool},
    time::Instant,
};

fn main() -> Result<(), Box<dyn Error>> {
    ffmpeg::init()?;
    let paths: Vec<PathBuf> = std::env::args_os().skip(1).map(PathBuf::from).collect();
    if paths.is_empty() {
        return Err("expected audio file paths".into());
    }
    println!("fixture,mode,prefix,sample,elapsed_ms,frames");
    for (fixture, path) in paths.iter().enumerate() {
        for (mode, prefix) in [("validate", 0), ("validate", 7), ("read", 0)] {
            for iteration in 0..28 {
                let mut stream = AudioStream::open(path, Arc::new(AtomicBool::new(false)))?;
                if prefix != 0 {
                    assert!(matches!(stream.read_chunk(prefix)?, ChunkRead::Chunk(_)));
                }
                let started = Instant::now();
                let frames = if mode == "validate" {
                    black_box(stream.validate_to_end()?)
                } else {
                    loop {
                        match stream.read_chunk(48_000)? {
                            ChunkRead::Chunk(chunk) => {
                                black_box(chunk);
                            }
                            ChunkRead::Eof { next_sample } => break next_sample,
                        }
                    }
                };
                let elapsed_ms = started.elapsed().as_secs_f64() * 1_000.0;
                assert_eq!(stream.position(), frames);
                assert!(
                    matches!(stream.read_chunk(1)?, ChunkRead::Eof { next_sample } if next_sample == frames)
                );
                if iteration >= 3 {
                    println!(
                        "{fixture},{mode},{prefix},{},{elapsed_ms:.6},{frames}",
                        iteration - 3
                    );
                }
            }
        }
    }
    Ok(())
}
