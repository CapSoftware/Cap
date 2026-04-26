use cap_utils::Url;
use std::collections::HashMap;

pub mod cap_utils {
    pub struct Url {
        // implementation
    }

    impl Url {
        pub fn parse(s: &str) -> Result<Self, std::fmt::Error> {
            // implementation
        }

        pub fn join(&self, path: &str) -> Result<Self, std::fmt::Error> {
            // implementation
        }
    }
}