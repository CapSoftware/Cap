// File: crates/recording/src/cap_utils.rs

use std::collections::HashMap;

pub mod cap_utils {
    pub struct Url {
        pub scheme: String,
        pub authority: String,
        pub path: String,
        pub query: String,
        pub fragment: String,
    }

    impl Url {
        pub fn parse(s: &str) -> Result<Self, std::fmt::Error> {
            let mut url = Url {
                scheme: String::new(),
                authority: String::new(),
                path: String::new(),
                query: String::new(),
                fragment: String::new(),
            };
            let mut parts = s.split(|c| c == '/' || c == '?' || c == '#');
            let scheme = parts.next().unwrap_or("");
            let authority = parts.next().unwrap_or("");
            let path = parts.next().unwrap_or("");
            let query = parts.next().unwrap_or("");
            let fragment = parts.next().unwrap_or("");
            url.scheme = scheme.to_string();
            url.authority = authority.to_string();
            url.path = path.to_string();
            url.query = query.to_string();
            url.fragment = fragment.to_string();
            Ok(url)
        }

        pub fn join(&self, path: &str) -> Result<Self, std::fmt::Error> {
            let mut url = self.clone();
            url.path.push_str(path);
            Ok(url)
        }
    }
}