//! Auto redact: finds sensitive text in screen recordings and writes the
//! regions to hide, per segment and source time, to `redactions.json`.

pub mod analyze;
pub mod classify;
mod ctc;
mod db;
pub mod frames;
mod gitleaks;
mod gpu;
pub mod image;
pub mod model;
pub mod motion;
mod names;
mod scan;
mod wdet;

pub use analyze::{Analyzer, Progress, SegmentSource, Stats, segment_sources};
pub use classify::{Finding, LineContext, classify_frame, classify_frame_with, classify_line};
pub use model::OcrModel;
