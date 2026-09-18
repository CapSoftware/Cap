mod audio;
mod audio_output;
mod auto_zoom;
mod completed_audio;
mod editor;
mod editor_instance;
mod existing_recording_import;
mod export_audio;
mod playback;
mod preparing_audio;
mod preparing_editor;
mod preparing_handoff;
mod preparing_playback;
mod preparing_preview;
mod screen_recording_defaults;
mod segments;
mod telemetry;
mod thumbnail;

pub use audio::{AudioRenderer, AudioSegment, MusicTracks};
pub use audio_output::{
    AudioOutput, HEADLESS_BLOCK_FRAMES, HEADLESS_CHANNELS, HEADLESS_SAMPLE_RATE, HeadlessAudioTap,
};
pub use auto_zoom::generate_project_auto_zoom_segments;
pub use cap_audio::{
    TranscriptionAudioSource, TranscriptionAudioTake, append_transcription_audio,
    assemble_transcription_audio, waveform_peaks,
};
pub use cap_rendering::FrameLayout;
pub use completed_audio::CompletedAudioHandoff;
pub use editor::{
    EditorFrameCallback, EditorFrameFormat, EditorFrameOutput, Renderer, RendererHandle,
    finish_renderer_layers_creation, start_renderer_layers_creation,
};
pub use editor_instance::{
    AudioLoader, EditorInstance, EditorStartupInputs, EditorState, SegmentAudioTimingRepair,
    SegmentMedia, create_segments, create_segments_without_audio, initial_clip_configuration,
    segment_audio_timing_repairs,
};
pub use existing_recording_import::{
    append_instant_cap_project_to_editor_project, append_studio_cap_project_to_editor_project,
};
pub use export_audio::{
    ExportAudioError, ExportAudioPreparation, ExportAudioRenderer, ExportAudioValidation,
};
pub use playback::{Playback, PlaybackEvent, PlaybackHandle, PlaybackStartError};
pub use preparing_editor::{PreparingEditorPhase, PreparingEditorProgress, PreparingPlaybackState};
pub use preparing_handoff::{
    PreparingPlaybackAdoption, PreparingPlaybackHandoff, PreparingPlaybackIntent,
};
pub use preparing_playback::{
    PreparingAudioSegmentInput, PreparingPlaybackController, PreparingPlaybackExit,
    PreparingPlaybackOptions, PreparingPlaybackSession, PreparingPlaybackSnapshot,
    PreparingPlaybackStopHandle,
};
pub use preparing_preview::{
    PreparingFrameRequest, PreparingPreview, PreparingPreviewCallback, PreparingPreviewError,
    PreparingPreviewExit, PreparingPreviewInput, PreparingPreviewOptions, PreparingPreviewReady,
    PreparingPreviewSegment, PreparingPreviewStopHandle,
};
pub use screen_recording_defaults::default_screen_recording_project_config;
pub use segments::{
    audio_segment_from_decoded, get_audio_segments, load_music_tracks, load_music_tracks_uncached,
};
pub use telemetry::{
    PlaybackFrameSource, PlaybackRenderOutputFormat, PlaybackSkipReason, PlaybackTelemetry,
    PlaybackTelemetryEvent,
};
