mod audio;
mod audio_output;
mod editor;
mod editor_instance;
mod playback;
mod segments;
mod telemetry;

pub use audio::{AudioRenderer, MusicTracks};
pub use audio_output::{
    AudioOutput, HEADLESS_BLOCK_FRAMES, HEADLESS_CHANNELS, HEADLESS_SAMPLE_RATE, HeadlessAudioTap,
};
pub use editor::{
    EditorFrameOutput, Renderer, RendererHandle, finish_renderer_layers_creation,
    start_renderer_layers_creation,
};
pub use editor_instance::{
    AudioLoader, EditorInstance, EditorState, SegmentMedia, create_segments,
};
pub use playback::{Playback, PlaybackEvent, PlaybackHandle, PlaybackStartError};
pub use segments::{get_audio_segments, load_music_tracks, load_music_tracks_uncached};
pub use telemetry::{
    PlaybackFrameSource, PlaybackRenderOutputFormat, PlaybackSkipReason, PlaybackTelemetry,
    PlaybackTelemetryEvent,
};
