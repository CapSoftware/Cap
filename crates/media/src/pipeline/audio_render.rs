use cap_audio::AudioData;

use crate::MediaError;

pub struct AudioRenderer {
    tracks: Vec<AudioData>,
    cursor: usize,
}

// impl AudioRenderer {
//     pub fn new(tracks: Vec<AudioData>) -> Result<Self, MediaError> {
//         Ok(Self { tracks, cursor: 0 })
//     }

//     pub fn channels(&self) -> u16 {
//         self.tracks.first().map(|t| t.channels()).unwrap_or(0)
//     }

//     pub fn set_cursor(&mut self, position: usize) {
//         self.cursor = position;
//     }

//     pub fn render(&mut self, requested_samples: usize) -> Vec<f32> {
//         if self.tracks.is_empty() {
//             return vec![0.0; requested_samples];
//         }

//         let channels = self.channels() as usize;
//         let total_samples = self.tracks[0].buffer.len() / channels;

//         // Calculate how many samples we can actually render
//         let available_samples = total_samples.saturating_sub(self.cursor);
//         let samples_to_render = requested_samples.min(available_samples);

//         // Pre-allocate output buffer
//         let mut output = vec![0.0; samples_to_render * channels];

//         // Mix all tracks
//         for track in &self.tracks {
//             let start = self.cursor * channels;
//             let end = start + (samples_to_render * channels);

//             // Add this track's samples to the output buffer
//             for (out, &sample) in output.iter_mut().zip(&track.buffer[start..end]) {
//                 *out += sample;
//             }
//         }

//         // Advance cursor
//         self.cursor += samples_to_render;

//         // Normalize the mixed output to prevent clipping
//         let track_count = self.tracks.len() as f32;
//         if track_count > 1.0 {
//             for sample in output.iter_mut() {
//                 *sample /= track_count;
//             }
//         }

//         output
//     }

//     pub fn is_finished(&self) -> bool {
//         if self.tracks.is_empty() {
//             return true;
//         }

//         let total_samples = self.tracks[0].buffer.len() / self.channels() as usize;
//         self.cursor >= total_samples
//     }
// }
