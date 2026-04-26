// File: crates/recording/src/cap_utils.rs
use std::collections::HashMap;

pub struct Url {
    url: String,
}

impl Url {
    pub fn parse(s: &str) -> Result<Self, std::fmt::Error> {
        // Simplified parsing logic
        if s.is_empty() || !s.contains("://") {
            return Err(std::fmt::Error);
        }
        Ok(Url { url: s.to_string() })
    }

    pub fn join(&self, path: &str) -> Result<Self, std::fmt::Error> {
        if path.is_empty() {
            return Ok(Url {
                url: self.url.clone(),
            });
        }
        let sep = if self.url.ends_with('/') || path.starts_with('/') {
            ""
        } else {
            "/"
        };
        let joined = format!("{}{}{}", self.url, sep, path);
        Url::parse(&joined)
    }
}