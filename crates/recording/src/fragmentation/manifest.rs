use serde::{Deserialize, Serialize};
use std::{path::PathBuf, time::Duration};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FragmentManifest {
    pub fragments: Vec<FragmentInfo>,
    #[serde(
        with = "duration_serde",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub total_duration: Option<Duration>,
    pub is_complete: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FragmentInfo {
    #[serde(with = "path_serde")]
    pub path: PathBuf,
    pub index: u32,
    #[serde(
        with = "duration_serde",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub duration: Option<Duration>,
    pub is_complete: bool,
}

impl FragmentManifest {
    pub fn load_from_file(path: &PathBuf) -> std::io::Result<Self> {
        let content = std::fs::read_to_string(path)?;
        serde_json::from_str(&content)
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))
    }

    pub fn complete_fragments(&self) -> Vec<&FragmentInfo> {
        self.fragments.iter().filter(|f| f.is_complete).collect()
    }

    pub fn recoverable_duration(&self) -> Option<Duration> {
        let mut total = Duration::ZERO;
        for fragment in self.complete_fragments() {
            total += fragment.duration?;
        }
        Some(total)
    }
}

mod duration_serde {
    use serde::{Deserialize, Deserializer, Serialize, Serializer};
    use std::time::Duration;

    pub fn serialize<S>(duration: &Option<Duration>, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        match duration {
            Some(d) => d.as_secs_f64().serialize(serializer),
            None => serializer.serialize_none(),
        }
    }

    pub fn deserialize<'de, D>(deserializer: D) -> Result<Option<Duration>, D::Error>
    where
        D: Deserializer<'de>,
    {
        let opt: Option<f64> = Option::deserialize(deserializer)?;
        Ok(opt.map(Duration::from_secs_f64))
    }
}

mod path_serde {
    use serde::{Deserialize, Deserializer, Serialize, Serializer};
    use std::path::{Path, PathBuf};

    pub fn serialize<S>(path: &Path, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        path.to_string_lossy().serialize(serializer)
    }

    pub fn deserialize<'de, D>(deserializer: D) -> Result<PathBuf, D::Error>
    where
        D: Deserializer<'de>,
    {
        let s = String::deserialize(deserializer)?;
        Ok(PathBuf::from(s))
    }
}
