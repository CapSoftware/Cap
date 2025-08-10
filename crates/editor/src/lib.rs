mod editor;
mod editor_instance;
mod playback;
mod segments;

pub use editor_instance::{EditorInstance, EditorState, Segment, create_segments};
pub use segments::get_audio_segments;
