mod editor;
mod editor_instance;
mod playback;
mod project_recordings;

pub use editor_instance::{EditorInstance, EditorState, Segment, FRAMES_WS_PATH};
pub use project_recordings::{ProjectRecordings, SegmentRecordings};
