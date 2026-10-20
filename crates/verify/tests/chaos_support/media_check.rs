//! What a recording pipeline left on disk, read back with FFmpeg.

use std::path::{Path, PathBuf};

/// Packets FFmpeg reads from `path` (a file, or a fragment directory read as
/// its init segment followed by its media segments).
pub fn packets(path: &Path) -> anyhow::Result<usize> {
    if path.is_dir() {
        let mut total = 0;
        let mut any = false;
        for media in fragment_streams(path)? {
            any = true;
            total += file_packets(&media)?;
        }
        anyhow::ensure!(any, "no media in {}", path.display());
        return Ok(total);
    }
    file_packets(path)
}

fn file_packets(path: &Path) -> anyhow::Result<usize> {
    let mut input = ffmpeg::format::input(path)?;
    let mut count = 0;
    for (_, packet) in input.packets() {
        if packet.size() > 0 {
            count += 1;
        }
    }
    Ok(count)
}

/// Concatenates `init.mp4` and the `*.m4s` segments of every fragment
/// directory under `dir` into one readable file per directory.
fn fragment_streams(dir: &Path) -> anyhow::Result<Vec<PathBuf>> {
    let mut out = Vec::new();
    let mut dirs = vec![dir.to_path_buf()];
    while let Some(dir) = dirs.pop() {
        let mut segments = Vec::new();
        let mut init = None;
        let mut files = Vec::new();
        for entry in std::fs::read_dir(&dir)? {
            let path = entry?.path();
            if path.is_dir() {
                dirs.push(path);
                continue;
            }
            let name = path
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or_default()
                .to_string();
            if name == "init.mp4" {
                init = Some(path);
            } else if name.ends_with(".m4s") {
                segments.push(path);
            } else if name.ends_with(".mp4") || name.ends_with(".ogg") || name.ends_with(".m4a") {
                files.push(path);
            }
        }
        segments.sort();
        if let Some(init) = init {
            if segments.is_empty() {
                continue;
            }
            let joined = dir.join("chaos-joined.mp4");
            let mut bytes = std::fs::read(&init)?;
            for segment in &segments {
                bytes.extend(std::fs::read(segment)?);
            }
            std::fs::write(&joined, bytes)?;
            out.push(joined);
        } else {
            out.extend(files);
        }
    }
    Ok(out)
}

/// Judges a pipeline that reported success: it must have written readable
/// media when the input carried any usable frame.
pub fn judge_output(path: &Path, expect_media: bool) -> super::harness::Verdict {
    use super::harness::Verdict;
    match packets(path) {
        Ok(n) if n > 0 => Verdict::Ok(format!("{n} packets")),
        Ok(_) if expect_media => {
            Verdict::Wrong("reported success but the output has no packets".into())
        }
        Ok(_) => Verdict::Ok("no packets (no usable input)".into()),
        Err(e) if expect_media => Verdict::Wrong(format!(
            "reported success but the output is unreadable: {e:#}"
        )),
        Err(e) => Verdict::Ok(format!("no readable output (no usable input): {e:#}")),
    }
}
