use std::{fmt::Display, str::FromStr};

use windows::Graphics::SizeInt32;

#[derive(Copy, Clone, Debug, PartialEq)]
pub enum Resolution {
    Native,
    _720p,
    _1080p,
    _2160p,
    _4320p,
}

#[derive(Copy, Clone, Debug, PartialEq)]
pub struct ParseResolutionError(&'static str);

impl FromStr for Resolution {
    type Err = ParseResolutionError;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s.to_lowercase().as_str() {
            "native" => Ok(Resolution::Native),
            "720p" => Ok(Resolution::_720p),
            "1080p" => Ok(Resolution::_1080p),
            "2160p" => Ok(Resolution::_2160p),
            "4320p" => Ok(Resolution::_4320p),
            _ => Err(ParseResolutionError(
                "Invalid resolution value! Expecting: native, 720p, 1080p, 2160p, or 4320p.",
            )),
        }
    }
}

impl Display for Resolution {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let string = match self {
            Resolution::Native => "native",
            Resolution::_720p => "720p",
            Resolution::_1080p => "1080p",
            Resolution::_2160p => "2160p",
            Resolution::_4320p => "4320p",
        };
        write!(f, "{}", string)
    }
}

impl Display for ParseResolutionError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.0)
    }
}
impl std::error::Error for ParseResolutionError {}

impl Resolution {
    pub fn get_size(&self) -> Option<SizeInt32> {
        match self {
            Resolution::Native => None,
            Resolution::_720p => Some(SizeInt32 {
                Width: 1280,
                Height: 720,
            }),
            Resolution::_1080p => Some(SizeInt32 {
                Width: 1920,
                Height: 1080,
            }),
            Resolution::_2160p => Some(SizeInt32 {
                Width: 3840,
                Height: 2160,
            }),
            Resolution::_4320p => Some(SizeInt32 {
                Width: 7680,
                Height: 4320,
            }),
        }
    }
}
