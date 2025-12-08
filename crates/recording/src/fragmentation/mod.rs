mod manifest;
pub use manifest::*;

use std::{path::PathBuf, time::Duration};

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
        let json = serde_json::to_string_pretty(&manifest)?;
        std::fs::write(manifest_path, json)?;
        Ok(())
    }

    pub fn finalize_manifest(&self) -> std::io::Result<()> {
        let manifest = FragmentManifest {
            fragments: self.fragments.clone(),
            total_duration: self.total_duration(),
            is_complete: true,
        };

        let manifest_path = self.base_path.join("manifest.json");
        let json = serde_json::to_string_pretty(&manifest)?;
        std::fs::write(manifest_path, json)?;
        Ok(())
    }

    fn total_duration(&self) -> Option<Duration> {
        let mut total = Duration::ZERO;
        for fragment in &self.fragments {
            total += fragment.duration?;
        }
        Some(total)
    }
}
