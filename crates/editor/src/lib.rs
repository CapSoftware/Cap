mod editor;
mod editor_instance;
mod playback;
mod segments;

pub use editor_instance::{create_segments, EditorInstance, EditorState, Segment};
pub use segments::get_audio_segments;
