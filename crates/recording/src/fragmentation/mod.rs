mod manifest;
pub use manifest::*;

use serde::Serialize;
use std::{
    io::Write,
    path::{Path, PathBuf},
    time::Duration,
};

pub fn atomic_write_json<T: Serialize>(path: &Path, data: &T) -> std::io::Result<()> {
    let temp_path = path.with_extension("json.tmp");
    let json = serde_json::to_string_pretty(data)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;

    let mut file = std::fs::File::create(&temp_path)?;
    file.write_all(json.as_bytes())?;
    file.sync_all()?;

    std::fs::rename(&temp_path, path)?;

    if let Some(parent) = path.parent() {
        if let Ok(dir) = std::fs::File::open(parent) {
            let _ = dir.sync_all();
        }
    }

    Ok(())
}

pub fn sync_file(path: &Path) {
    if let Ok(file) = std::fs::File::open(path) {
        let _ = file.sync_all();
    }
}

pub struct FragmentManager {
    base_path: PathBuf,
    fragment_duration: Duration,
    current_index: u32,
    fragments: Vec<FragmentInfo>,
}

impl FragmentManager {
    pub fn new(base_path: PathBuf, duration: Duration) -> Self {
        Self {
            base_path,
            fragment_duration: duration,
            current_index: 0,
            fragments: Vec::new(),
        }
    }

    pub fn fragment_duration(&self) -> Duration {
        self.fragment_duration
    }

    pub fn current_fragment_path(&self) -> PathBuf {
        self.base_path
            .join(format!("fragment_{:03}.mp4", self.current_index))
    }

    pub fn current_audio_fragment_path(&self) -> PathBuf {
        self.base_path
            .join(format!("fragment_{:03}.m4a", self.current_index))
    }

    pub fn rotate(&mut self, duration: Option<Duration>, is_complete: bool) -> PathBuf {
        self.fragments.push(FragmentInfo {
            path: self.current_fragment_path(),
            index: self.current_index,
            duration,
            is_complete,
        });

        self.current_index += 1;
        self.current_fragment_path()
    }

    pub fn current_index(&self) -> u32 {
        self.current_index
    }

    pub fn complete_fragments(&self) -> Vec<&FragmentInfo> {
        self.fragments.iter().filter(|f| f.is_complete).collect()
    }

    pub fn all_fragments(&self) -> &[FragmentInfo] {
        &self.fragments
    }

    pub fn mark_current_complete(&mut self, duration: Option<Duration>) {
        self.fragments.push(FragmentInfo {
            path: self.current_fragment_path(),
            index: self.current_index,
            duration,
            is_complete: true,
        });
    }

    pub fn write_manifest(&self) -> std::io::Result<()> {
        let manifest = FragmentManifest {
            fragments: self.fragments.clone(),
            total_duration: self.total_duration(),
            is_complete: false,
        };

        let manifest_path = self.base_path.join("manifest.json");
        atomic_write_json(&manifest_path, &manifest)
    }

    pub fn finalize_manifest(&self) -> std::io::Result<()> {
        let manifest = FragmentManifest {
            fragments: self.fragments.clone(),
            total_duration: self.total_duration(),
            is_complete: true,
        };

        let manifest_path = self.base_path.join("manifest.json");
        atomic_write_json(&manifest_path, &manifest)
    }

    fn total_duration(&self) -> Option<Duration> {
        let mut total = Duration::ZERO;
        for fragment in &self.fragments {
            total += fragment.duration?;
        }
        Some(total)
    }
}
