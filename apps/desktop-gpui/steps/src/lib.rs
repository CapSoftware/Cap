//! Pointer events are read on their clip's own clock, the seconds since that
//! clip started recording: how fast someone clicked does not change with the
//! speed the clip is played at. A guide is in output time, the seconds a
//! viewer sees. Positions are normalised to the recorded frame. Reading a
//! project and decoding its frames is the app's side.

mod detect;
mod document;
mod frame;
mod narration;

use serde::{Deserialize, Serialize};

pub use detect::{build_guide, clip_steps};
pub use document::{
    Captions, Document, DocumentStep, image_name, instruction, is_image_name, json, listed_images,
    markdown, timestamp,
};
pub use frame::{Rect, Size, StepImage, crop_for, encode_png, render_step_image};

pub const LEFT_BUTTON: u8 = 1;
pub const RIGHT_BUTTON: u8 = 2;

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct Point {
    pub x: f64,
    pub y: f64,
}

impl Point {
    pub fn new(x: f64, y: f64) -> Self {
        Self { x, y }
    }

    pub fn distance(self, other: Self) -> f64 {
        (self.x - other.x).hypot(self.y - other.y)
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct PointerMove {
    pub time: f64,
    pub position: Point,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ButtonEvent {
    pub time: f64,
    pub button: u8,
    pub down: bool,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Source {
    pub clip: u32,
    pub time: f64,
}

pub struct ClipEvents<'a> {
    pub clip: u32,
    pub stopped_at: Option<f64>,
    pub moves: &'a [PointerMove],
    pub buttons: &'a [ButtonEvent],
}

#[derive(Clone, Debug, PartialEq)]
pub struct Marker {
    pub time: f64,
    pub source: Source,
    pub label: String,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Word {
    pub start: f64,
    pub end: f64,
    pub text: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Action {
    Click,
    DoubleClick,
    RightClick,
    Drag,
    Note,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Step {
    pub time: f64,
    pub source: Source,
    pub frame_time: f64,
    pub action: Action,
    pub position: Option<Point>,
    pub drag_to: Option<Point>,
    pub repeat: u32,
    pub heading: Option<String>,
    pub narration: String,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Guide {
    pub intro: String,
    pub steps: Vec<Step>,
}
