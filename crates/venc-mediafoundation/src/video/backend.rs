use std::{fmt::Display, str::FromStr};

#[derive(Copy, Clone, Debug, PartialEq)]
pub enum EncoderBackend {
    MediaFoundation,
    WindowsMediaTranscoding,
}

#[derive(Copy, Clone, Debug, PartialEq)]
pub struct ParseEncoderBackendError(&'static str);

impl FromStr for EncoderBackend {
    type Err = ParseEncoderBackendError;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s.to_lowercase().as_str() {
            "mf" => Ok(EncoderBackend::MediaFoundation),
            "wmt" => Ok(EncoderBackend::WindowsMediaTranscoding),
            _ => Err(ParseEncoderBackendError(
                "Invalid encoder backend value! Expecting: 'mf' (MediaFoundation), or 'wmt' (Windows.Media.Transcoding).",
            )),
        }
    }
}

impl Display for EncoderBackend {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let string = match self {
            EncoderBackend::MediaFoundation => "mf",
            EncoderBackend::WindowsMediaTranscoding => "wmt",
        };
        write!(f, "{}", string)
    }
}

impl Display for ParseEncoderBackendError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.0)
    }
}
impl std::error::Error for ParseEncoderBackendError {}
