//! Engine verification suite: marker codecs, fixture generation, a reference
//! timeline model and oracle checkers. See `crates/verify/README.md`.

pub mod audio_code;
pub mod catalog;
pub mod fixture;
#[cfg(target_os = "macos")]
pub mod fixture_avf;
pub mod media;
pub mod model;
pub mod oracle;
pub mod report;
pub mod stimulus;
pub mod video_code;
