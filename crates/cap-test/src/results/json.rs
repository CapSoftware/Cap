use anyhow::{Context, Result};
use std::path::Path;

use super::types::TestResults;

#[allow(dead_code)]
impl TestResults {
    pub fn save_json(&self, path: &Path) -> Result<()> {
        let json =
            serde_json::to_string_pretty(self).context("Failed to serialize results to JSON")?;

        std::fs::write(path, json)
            .with_context(|| format!("Failed to write results to {}", path.display()))?;

        Ok(())
    }

    pub fn load(path: &Path) -> Result<Self> {
        let content = std::fs::read_to_string(path)
            .with_context(|| format!("Failed to read results from {}", path.display()))?;

        serde_json::from_str(&content)
            .with_context(|| format!("Failed to parse results from {}", path.display()))
    }

    pub fn to_json(&self) -> Result<String> {
        serde_json::to_string_pretty(self).context("Failed to serialize results")
    }
}
