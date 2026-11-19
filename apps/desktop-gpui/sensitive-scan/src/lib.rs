mod classify;
mod frame;
mod masks;
mod ocr;
mod scan;
#[cfg(any(test, feature = "synthetic"))]
pub mod synthetic;
mod track;

pub use classify::{SensitiveKind, SensitiveMatch, find_sensitive};
pub use frame::{LumaFrame, Rect};
pub use masks::{mask_rect_at, mask_segments};
pub use ocr::{DETECTION_MODEL, MODELS, ModelFile, RECOGNITION_MODEL, ReadLine, TextReader};
pub use scan::{
    Detection, ReadText, ScanSettings, Scanner, SensitiveTrack, TrackSample, detect, in_motion,
};
