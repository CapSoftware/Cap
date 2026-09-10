mod managed;
pub use managed::*;

#[cfg(feature = "test-support")]
mod test_support;
#[cfg(feature = "test-support")]
pub use test_support::ProgressiveAudioTestProducer;

use crate::{AudioData, AudioSampleSource, AudioStream, ChunkRead};
use std::{
    ops::Range,
    path::PathBuf,
    sync::{Arc, Mutex, atomic::AtomicBool},
};
use tokio::sync::watch;

const BLOCK_FRAMES: usize = 32_768;

pub fn waveform_peaks<'a>(samples: impl Iterator<Item = &'a f32>, channels: u16) -> Vec<f32> {
    let block_samples = AudioData::SAMPLE_RATE as usize / 10 * usize::from(channels.max(1));
    let mut peaks = Vec::new();
    let mut sum = 0.0_f32;
    let mut count = 0;
    for sample in samples {
        sum += sample.abs();
        count += 1;
        if count == block_samples {
            peaks.push(sum / count as f32);
            sum = 0.0;
            count = 0;
        }
    }
    if count > 0 {
        peaks.push(sum / count as f32);
    }
    for peak in &mut peaks {
        *peak = if *peak > 0.0 {
            20.0 * peak.log10()
        } else {
            -60.0
        };
    }
    peaks
}

pub struct DecodedAudio {
    storage: AudioStorage,
    channels: u16,
    frames: usize,
}

enum AudioStorage {
    Contiguous(Arc<AudioData>),
    Blocks(Vec<Arc<Vec<f32>>>),
}

impl DecodedAudio {
    pub fn channels(&self) -> u16 {
        self.channels
    }

    pub fn sample_count(&self) -> usize {
        self.frames
    }

    pub fn sample_slices(&self) -> impl Iterator<Item = &[f32]> {
        let (contiguous, blocks): (Option<&[f32]>, &[Arc<Vec<f32>>]) = match &self.storage {
            AudioStorage::Contiguous(data) => (Some(data.samples()), &[]),
            AudioStorage::Blocks(blocks) => (None, blocks),
        };
        contiguous
            .into_iter()
            .chain(blocks.iter().map(|block| block.as_slice()))
    }
}

impl From<Arc<AudioData>> for DecodedAudio {
    fn from(data: Arc<AudioData>) -> Self {
        Self {
            channels: data.channels(),
            frames: data.sample_count(),
            storage: AudioStorage::Contiguous(data),
        }
    }
}

impl AudioSampleSource for DecodedAudio {
    fn channels(&self) -> u16 {
        self.channels
    }

    fn sample_count(&self) -> usize {
        self.frames
    }

    fn sample(&self, index: usize) -> Option<&f32> {
        match &self.storage {
            AudioStorage::Contiguous(data) => data.samples().get(index),
            AudioStorage::Blocks(blocks) => {
                let block_samples = BLOCK_FRAMES * usize::from(self.channels);
                blocks
                    .get(index / block_samples)?
                    .get(index % block_samples)
            }
        }
    }

    fn sample_slice(&self, range: Range<usize>) -> Option<&[f32]> {
        match &self.storage {
            AudioStorage::Contiguous(data) => data.sample_slice(range),
            AudioStorage::Blocks(blocks) => {
                let block_samples = BLOCK_FRAMES * usize::from(self.channels);
                let block = range.start / block_samples;
                let base = block * block_samples;
                blocks
                    .get(block)?
                    .get(range.start - base..range.end.checked_sub(base)?)
            }
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct AudioLoadProgress {
    pub ready_frames: usize,
    pub channels: Option<u16>,
    pub complete: bool,
    pub error: Option<String>,
}

#[derive(Clone, Default)]
struct LoadState {
    progress: AudioLoadProgress,
    result: Option<LoadResult>,
}

type LoadResult = Result<Option<Arc<DecodedAudio>>, String>;

#[derive(Default)]
struct PendingBlocks {
    blocks: Vec<Arc<Vec<f32>>>,
    frames: usize,
    channels: Option<u16>,
}

impl PendingBlocks {
    fn append(&mut self, chunk: crate::AudioChunk) -> Result<(), String> {
        let channels = usize::from(chunk.channels);
        if channels == 0
            || self
                .channels
                .is_some_and(|previous| previous != chunk.channels)
            || chunk.source_start_sample != self.frames as u64
            || chunk.samples.is_empty()
            || chunk.samples.len() % channels != 0
            || chunk.samples.len() / channels > BLOCK_FRAMES
            || self
                .blocks
                .last()
                .is_some_and(|last| last.len() != BLOCK_FRAMES * channels)
        {
            return Err("Audio blocks are not contiguous complete sample frames".into());
        }
        self.channels = Some(chunk.channels);
        self.frames = self
            .frames
            .checked_add(chunk.samples.len() / channels)
            .ok_or_else(|| "Decoded audio is too long".to_string())?;
        self.blocks.push(Arc::new(chunk.samples));
        Ok(())
    }
}

#[derive(Clone)]
pub struct ProgressiveAudio {
    rx: watch::Receiver<LoadState>,
    // Full-track waiters must not wake for each published PCM block.
    complete: watch::Receiver<Option<LoadResult>>,
    pending: Arc<Mutex<PendingBlocks>>,
}

impl ProgressiveAudio {
    pub fn none() -> Self {
        Self::ready(None)
    }

    pub fn ready(audio: Option<Arc<AudioData>>) -> Self {
        let audio = audio.map(|audio| Arc::new(DecodedAudio::from(audio)));
        let state = LoadState {
            progress: AudioLoadProgress {
                ready_frames: audio.as_ref().map_or(0, |audio| audio.sample_count()),
                channels: audio.as_ref().map(|audio| audio.channels()),
                complete: true,
                error: None,
            },
            result: Some(Ok(audio)),
        };
        let (_complete_tx, complete) = watch::channel(state.result.clone());
        let (_tx, rx) = watch::channel(state);
        Self {
            rx,
            complete,
            pending: Arc::default(),
        }
    }

    pub fn from_result(result: Result<Option<Arc<DecodedAudio>>, String>) -> Self {
        let audio = result.as_ref().ok().and_then(Option::as_ref);
        let state = LoadState {
            progress: AudioLoadProgress {
                ready_frames: audio.map_or(0, |audio| audio.sample_count()),
                channels: audio.map(|audio| audio.channels()),
                complete: result.is_ok(),
                error: result.as_ref().err().cloned(),
            },
            result: Some(result),
        };
        let (_complete_tx, complete) = watch::channel(state.result.clone());
        let (_tx, rx) = watch::channel(state);
        Self {
            rx,
            complete,
            pending: Arc::default(),
        }
    }

    pub fn spawn(path: PathBuf, label: String) -> Self {
        let (tx, rx) = watch::channel(LoadState::default());
        let (complete_tx, complete) = watch::channel(None);
        let pending = Arc::new(Mutex::new(PendingBlocks::default()));
        let producer = pending.clone();
        tokio::task::spawn_blocking(move || {
            let result =
                Self::decode(path, &producer, &tx).map_err(|error| format!("{label} / {error}"));
            if result.is_err()
                && let Ok(mut pending) = producer.lock()
            {
                pending.blocks.clear();
            }
            let mut state = tx.borrow().clone();
            state.progress.complete = result.is_ok();
            state.progress.error = result.as_ref().err().cloned();
            if let Ok(audio) = &result {
                state.progress.ready_frames = audio.sample_count();
                state.progress.channels = Some(audio.channels());
            }
            state.result = Some(result.map(Some));
            let result = state.result.clone();
            tx.send_replace(state);
            complete_tx.send_replace(result);
        });
        Self {
            rx,
            complete,
            pending,
        }
    }

    fn decode(
        path: PathBuf,
        pending: &Mutex<PendingBlocks>,
        tx: &watch::Sender<LoadState>,
    ) -> Result<Arc<DecodedAudio>, String> {
        let stream = AudioStream::open(&path, Arc::new(AtomicBool::new(false)))
            .map_err(|error| error.to_string())?;
        Self::decode_stream(stream, pending, tx)
    }

    fn decode_stream(
        mut stream: AudioStream,
        pending: &Mutex<PendingBlocks>,
        tx: &watch::Sender<LoadState>,
    ) -> Result<Arc<DecodedAudio>, String> {
        loop {
            if tx.is_closed() {
                return Err("Audio load no longer has readers".into());
            }
            match stream
                .read_chunk(BLOCK_FRAMES)
                .map_err(|error| error.to_string())?
            {
                ChunkRead::Chunk(chunk) => {
                    let progress = {
                        let mut pending = pending.lock().map_err(|error| error.to_string())?;
                        pending.append(chunk)?;
                        AudioLoadProgress {
                            ready_frames: pending.frames,
                            channels: pending.channels,
                            complete: false,
                            error: None,
                        }
                    };
                    tx.send_replace(LoadState {
                        progress,
                        result: None,
                    });
                }
                ChunkRead::Eof { next_sample } => {
                    let mut pending = pending.lock().map_err(|error| error.to_string())?;
                    if next_sample != pending.frames as u64 {
                        return Err("Audio EOF does not match the decoded sample count".into());
                    }
                    return Ok(Arc::new(DecodedAudio {
                        channels: stream.channels(),
                        frames: pending.frames,
                        storage: AudioStorage::Blocks(std::mem::take(&mut pending.blocks)),
                    }));
                }
            }
        }
    }

    pub fn progress(&self) -> AudioLoadProgress {
        let mut progress = self.rx.borrow().progress.clone();
        if !progress.complete && progress.error.is_none() && self.rx.has_changed().is_err() {
            progress.error = Some("Audio load task was dropped".into());
        }
        progress
    }

    pub async fn get(&self) -> Result<Option<Arc<DecodedAudio>>, String> {
        let mut rx = self.complete.clone();
        loop {
            if let Some(result) = rx.borrow_and_update().clone() {
                return result;
            }
            rx.changed()
                .await
                .map_err(|_| "Audio load task was dropped".to_string())?;
        }
    }

    pub fn try_window(&self, range: Range<usize>) -> Result<AudioWindowRead, String> {
        if range.start > range.end {
            return Err("Invalid audio sample range".into());
        }
        let state = {
            let state = self.rx.borrow();
            if state.result.is_none()
                && state.progress.error.is_none()
                && self.rx.has_changed().is_err()
            {
                return Err("Audio load task was dropped".into());
            }
            state.clone()
        };
        if let Some(result) = state.result {
            return result
                .map(|audio| AudioWindowRead::Ready(audio.map(AudioSampleWindow::complete)));
        }
        if let Some(error) = state.progress.error {
            return Err(error);
        }
        if range.end > state.progress.ready_frames {
            return Ok(AudioWindowRead::Pending);
        }
        let pending = self.pending.lock().map_err(|error| error.to_string())?;
        let first_block = range.start / BLOCK_FRAMES;
        let end_block = range.end.div_ceil(BLOCK_FRAMES);
        let Some(blocks) = pending.blocks.get(first_block..end_block) else {
            return Ok(AudioWindowRead::Pending);
        };
        let Some(channels) = pending.channels else {
            return Ok(AudioWindowRead::Pending);
        };
        let available =
            first_block * BLOCK_FRAMES..end_block.saturating_mul(BLOCK_FRAMES).min(pending.frames);
        Ok(AudioWindowRead::Ready(Some(AudioSampleWindow {
            storage: WindowStorage::Blocks {
                first_block,
                blocks: blocks.to_vec(),
            },
            channels,
            frames: available.end,
            available,
        })))
    }

    pub async fn window(&self, range: Range<usize>) -> Result<Option<AudioSampleWindow>, String> {
        let mut rx = self.rx.clone();
        loop {
            drop(rx.borrow_and_update());
            if let AudioWindowRead::Ready(window) = self.try_window(range.clone())? {
                return Ok(window);
            }
            rx.changed()
                .await
                .map_err(|_| "Audio load task was dropped".to_string())?;
        }
    }
}

pub enum AudioWindowRead {
    Pending,
    Ready(Option<AudioSampleWindow>),
}

// Pending windows use global source indices but retain only available_range;
// sample_count alone does not establish coverage or EOF for a mixer.
pub struct AudioSampleWindow {
    storage: WindowStorage,
    channels: u16,
    frames: usize,
    available: Range<usize>,
}

enum WindowStorage {
    Complete(Arc<DecodedAudio>),
    Blocks {
        first_block: usize,
        blocks: Vec<Arc<Vec<f32>>>,
    },
}

impl AudioSampleWindow {
    fn complete(audio: Arc<DecodedAudio>) -> Self {
        Self {
            channels: audio.channels(),
            frames: audio.sample_count(),
            available: 0..audio.sample_count(),
            storage: WindowStorage::Complete(audio),
        }
    }

    pub fn available_range(&self) -> Range<usize> {
        self.available.clone()
    }

    pub fn complete_sample_count(&self) -> Option<usize> {
        match &self.storage {
            WindowStorage::Complete(audio) => Some(audio.sample_count()),
            WindowStorage::Blocks { .. } => None,
        }
    }
}

impl AudioSampleSource for AudioSampleWindow {
    fn channels(&self) -> u16 {
        self.channels
    }

    fn sample_count(&self) -> usize {
        self.frames
    }

    fn sample(&self, index: usize) -> Option<&f32> {
        match &self.storage {
            WindowStorage::Complete(audio) => audio.sample(index),
            WindowStorage::Blocks {
                first_block,
                blocks,
            } => {
                let block_samples = BLOCK_FRAMES * usize::from(self.channels);
                let block = (index / block_samples).checked_sub(*first_block)?;
                blocks.get(block)?.get(index % block_samples)
            }
        }
    }

    fn sample_slice(&self, range: Range<usize>) -> Option<&[f32]> {
        match &self.storage {
            WindowStorage::Complete(audio) => audio.sample_slice(range),
            WindowStorage::Blocks {
                first_block,
                blocks,
            } => {
                let block_samples = BLOCK_FRAMES * usize::from(self.channels);
                let block = range.start / block_samples;
                let base = block * block_samples;
                blocks
                    .get(block.checked_sub(*first_block)?)?
                    .get(range.start - base..range.end.checked_sub(base)?)
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{io::Write, path::Path, time::Duration};

    fn wave(path: &Path, rate: u32, channels: u16) {
        let frames = rate * 3 + 17;
        let bytes = frames * u32::from(channels) * 2;
        let mut file = std::fs::File::create(path).unwrap();
        file.write_all(b"RIFF").unwrap();
        file.write_all(&(bytes + 36).to_le_bytes()).unwrap();
        file.write_all(b"WAVEfmt ").unwrap();
        file.write_all(&16_u32.to_le_bytes()).unwrap();
        file.write_all(&1_u16.to_le_bytes()).unwrap();
        file.write_all(&channels.to_le_bytes()).unwrap();
        file.write_all(&rate.to_le_bytes()).unwrap();
        file.write_all(&(rate * u32::from(channels) * 2).to_le_bytes())
            .unwrap();
        file.write_all(&(channels * 2).to_le_bytes()).unwrap();
        file.write_all(&16_u16.to_le_bytes()).unwrap();
        file.write_all(b"data").unwrap();
        file.write_all(&bytes.to_le_bytes()).unwrap();
        for frame in 0..frames {
            for channel in 0..channels {
                let sample = ((frame * 17 + u32::from(channel) * 971) % 60_000) as i32 - 30_000;
                file.write_all(&(sample as i16).to_le_bytes()).unwrap();
            }
        }
    }

    struct TestProducer {
        progress: watch::Sender<LoadState>,
        complete: watch::Sender<Option<LoadResult>>,
    }

    impl TestProducer {
        fn send_replace(&self, state: LoadState) {
            let result = state.result.clone();
            self.progress.send_replace(state);
            if result.is_some() {
                self.complete.send_replace(result);
            }
        }
    }

    fn controlled() -> (ProgressiveAudio, TestProducer) {
        let (tx, rx) = watch::channel(LoadState::default());
        let (complete_tx, complete) = watch::channel(None);
        (
            ProgressiveAudio {
                rx,
                complete,
                pending: Arc::default(),
            },
            TestProducer {
                progress: tx,
                complete: complete_tx,
            },
        )
    }

    fn append(loader: &ProgressiveAudio, tx: &TestProducer, frames: usize) {
        let mut pending = loader.pending.lock().unwrap();
        let start = pending.frames;
        pending
            .append(crate::AudioChunk {
                source_start_sample: start as u64,
                channels: 2,
                samples: (start * 2..(start + frames) * 2)
                    .map(|sample| sample as f32)
                    .collect(),
            })
            .unwrap();
        tx.send_replace(LoadState {
            progress: AudioLoadProgress {
                ready_frames: pending.frames,
                channels: pending.channels,
                complete: false,
                error: None,
            },
            result: None,
        });
    }

    #[test]
    fn pending_window_reports_only_retained_blocks_and_never_implies_eof() {
        let (loader, tx) = controlled();
        assert!(matches!(
            loader.try_window(0..100).unwrap(),
            AudioWindowRead::Pending
        ));
        for _ in 0..3 {
            append(&loader, &tx, BLOCK_FRAMES);
        }
        let AudioWindowRead::Ready(Some(window)) = loader
            .try_window(BLOCK_FRAMES + 17..BLOCK_FRAMES + 117)
            .unwrap()
        else {
            panic!("Published samples were not ready");
        };
        assert_eq!(window.available_range(), BLOCK_FRAMES..BLOCK_FRAMES * 2);
        assert_eq!(window.sample_count(), BLOCK_FRAMES * 2);
        assert_eq!(window.complete_sample_count(), None);
        assert!(window.sample(BLOCK_FRAMES * 2 - 1).is_none());
        assert!(window.sample(BLOCK_FRAMES * 4).is_none());
        let pending = loader.pending.lock().unwrap();
        assert_eq!(Arc::strong_count(&pending.blocks[0]), 1);
        assert_eq!(Arc::strong_count(&pending.blocks[1]), 2);
        assert_eq!(Arc::strong_count(&pending.blocks[2]), 1);
        assert!(std::ptr::eq(
            window.sample(BLOCK_FRAMES * 2).unwrap(),
            &pending.blocks[1][0]
        ));
        drop(pending);
        append(&loader, &tx, BLOCK_FRAMES);
        assert_eq!(window.available_range(), BLOCK_FRAMES..BLOCK_FRAMES * 2);
        assert_eq!(window.sample_count(), BLOCK_FRAMES * 2);
        assert!(matches!(
            loader
                .try_window(BLOCK_FRAMES * 4 - 1..BLOCK_FRAMES * 4 + 1)
                .unwrap(),
            AudioWindowRead::Pending
        ));
    }

    #[test]
    fn moving_blocks_to_completion_does_not_publish_a_gap_as_silence() {
        let (loader, tx) = controlled();
        append(&loader, &tx, BLOCK_FRAMES);
        let audio = {
            let mut pending = loader.pending.lock().unwrap();
            Arc::new(DecodedAudio {
                channels: 2,
                frames: pending.frames,
                storage: AudioStorage::Blocks(std::mem::take(&mut pending.blocks)),
            })
        };
        assert!(matches!(
            loader.try_window(0..100).unwrap(),
            AudioWindowRead::Pending
        ));
        tx.send_replace(LoadState {
            progress: AudioLoadProgress {
                ready_frames: BLOCK_FRAMES,
                channels: Some(2),
                complete: true,
                error: None,
            },
            result: Some(Ok(Some(audio))),
        });
        let AudioWindowRead::Ready(Some(window)) = loader
            .try_window(BLOCK_FRAMES - 3..BLOCK_FRAMES + 3)
            .unwrap()
        else {
            panic!("Completed samples were not ready");
        };
        assert_eq!(window.available_range(), 0..BLOCK_FRAMES);
        assert_eq!(window.complete_sample_count(), Some(BLOCK_FRAMES));
        assert_eq!(
            window.sample(BLOCK_FRAMES * 2 - 1),
            Some(&((BLOCK_FRAMES * 2 - 1) as f32))
        );
        assert!(window.sample(BLOCK_FRAMES * 2).is_none());
    }

    #[test]
    fn nonblocking_window_distinguishes_absence_failure_and_dropped_producers() {
        assert!(matches!(
            ProgressiveAudio::none().try_window(0..100).unwrap(),
            AudioWindowRead::Ready(None)
        ));
        let (loader, tx) = controlled();
        append(&loader, &tx, BLOCK_FRAMES);
        tx.send_replace(LoadState {
            progress: AudioLoadProgress {
                error: Some("corrupt tail".into()),
                ..loader.progress()
            },
            result: Some(Err("corrupt tail".into())),
        });
        assert_eq!(
            loader.try_window(0..100).err().as_deref(),
            Some("corrupt tail")
        );
        let (loader, tx) = controlled();
        append(&loader, &tx, BLOCK_FRAMES);
        drop(tx);
        assert_eq!(
            loader.try_window(0..100).err().as_deref(),
            Some("Audio load task was dropped")
        );
        assert_eq!(
            loader
                .try_window(Range { start: 2, end: 1 })
                .err()
                .as_deref(),
            Some("Invalid audio sample range")
        );
    }

    #[test]
    fn terminal_publication_and_sender_drop_cannot_erase_successful_samples() {
        let audio = Arc::new(DecodedAudio::from(Arc::new(AudioData::from_raw_f32(
            vec![0.25, -0.5, 0.75, 1.0],
            2,
        ))));
        for _ in 0..512 {
            let (loader, tx) = controlled();
            let barrier = std::sync::Barrier::new(2);
            std::thread::scope(|scope| {
                let barrier = &barrier;
                let expected = audio.clone();
                let worker = scope.spawn(move || {
                    barrier.wait();
                    tx.send_replace(LoadState {
                        progress: AudioLoadProgress {
                            ready_frames: 2,
                            channels: Some(2),
                            complete: true,
                            error: None,
                        },
                        result: Some(Ok(Some(expected))),
                    });
                });
                barrier.wait();
                let window = loop {
                    match loader.try_window(0..2).unwrap() {
                        AudioWindowRead::Pending => std::thread::yield_now(),
                        AudioWindowRead::Ready(Some(window)) => break window,
                        AudioWindowRead::Ready(None) => panic!("Completed audio was lost"),
                    }
                };
                worker.join().unwrap();
                assert_eq!(window.complete_sample_count(), Some(2));
                assert!(std::ptr::eq(
                    window.sample(0).unwrap(),
                    audio.sample(0).unwrap()
                ));
            });
        }
    }

    #[test]
    fn short_pending_tail_and_empty_ranges_do_not_claim_future_samples() {
        let (loader, tx) = controlled();
        assert!(matches!(
            loader.try_window(usize::MAX..usize::MAX).unwrap(),
            AudioWindowRead::Pending
        ));
        append(&loader, &tx, BLOCK_FRAMES);
        append(&loader, &tx, 17);
        let AudioWindowRead::Ready(Some(window)) =
            loader.try_window(BLOCK_FRAMES..BLOCK_FRAMES + 17).unwrap()
        else {
            panic!("Published tail samples were not ready");
        };
        assert_eq!(window.available_range(), BLOCK_FRAMES..BLOCK_FRAMES + 17);
        assert_eq!(window.sample_count(), BLOCK_FRAMES + 17);
        assert_eq!(window.complete_sample_count(), None);
        assert!(window.sample((BLOCK_FRAMES + 17) * 2).is_none());
        assert!(matches!(
            loader.try_window(BLOCK_FRAMES..BLOCK_FRAMES + 18).unwrap(),
            AudioWindowRead::Pending
        ));
        for at in [0, BLOCK_FRAMES] {
            let AudioWindowRead::Ready(Some(window)) = loader.try_window(at..at).unwrap() else {
                panic!("Empty published range was not ready");
            };
            assert_eq!(window.available_range(), at..at);
            assert_eq!(window.complete_sample_count(), None);
            assert!(window.sample(at * 2).is_none());
        }
        let complete =
            ProgressiveAudio::ready(Some(Arc::new(AudioData::from_raw_f32(vec![0.25, -0.5], 2))));
        for range in [0..0, usize::MAX..usize::MAX, usize::MAX - 1..usize::MAX] {
            let AudioWindowRead::Ready(Some(window)) = complete.try_window(range).unwrap() else {
                panic!("Completed source bounds were not ready");
            };
            assert_eq!(window.available_range(), 0..1);
            assert_eq!(window.complete_sample_count(), Some(1));
            assert!(window.sample(usize::MAX).is_none());
        }
    }

    #[test]
    fn pending_windows_mix_exact_samples_across_blocks_with_offsets_and_stereo_modes() {
        for channels in [1, 2] {
            let samples = (0..BLOCK_FRAMES * 3 * usize::from(channels))
                .map(|index| ((index * 97 % 127) as f32 - 63.0) / 80.0)
                .collect::<Vec<_>>();
            let reference = AudioData::from_raw_f32(samples.clone(), channels);
            let (loader, tx) = controlled();
            for chunk in samples.chunks(BLOCK_FRAMES * usize::from(channels)) {
                let mut pending = loader.pending.lock().unwrap();
                let source_start_sample = pending.frames as u64;
                pending
                    .append(crate::AudioChunk {
                        source_start_sample,
                        channels,
                        samples: chunk.to_vec(),
                    })
                    .unwrap();
                tx.send_replace(LoadState {
                    progress: AudioLoadProgress {
                        ready_frames: pending.frames,
                        channels: pending.channels,
                        complete: false,
                        error: None,
                    },
                    result: None,
                });
            }
            let AudioWindowRead::Ready(Some(window)) = loader
                .try_window(BLOCK_FRAMES - 100..BLOCK_FRAMES + 700)
                .unwrap()
            else {
                panic!("Published samples were not ready");
            };
            assert_eq!(window.complete_sample_count(), None);
            for (offset, mode) in [(-17, 0), (0, 1), (17, 2)] {
                let stereo_mode = || match mode {
                    1 => crate::StereoMode::MonoL,
                    2 => crate::StereoMode::MonoR,
                    _ => crate::StereoMode::Stereo,
                };
                let mut expected = vec![13.0_f32; 1_028];
                let mut actual = expected.clone();
                let expected_frames = crate::render_audio(
                    &[crate::AudioRendererTrack {
                        data: &reference,
                        gain: -4.0,
                        stereo_mode: stereo_mode(),
                        offset,
                    }],
                    BLOCK_FRAMES - 50,
                    512,
                    2,
                    &mut expected,
                );
                let actual_frames = crate::render_audio(
                    &[crate::AudioRendererTrack {
                        data: &window,
                        gain: -4.0,
                        stereo_mode: stereo_mode(),
                        offset,
                    }],
                    BLOCK_FRAMES - 50,
                    512,
                    2,
                    &mut actual,
                );
                assert_eq!(actual_frames, expected_frames);
                assert_eq!(
                    actual
                        .iter()
                        .map(|value| value.to_bits())
                        .collect::<Vec<_>>(),
                    expected
                        .iter()
                        .map(|value| value.to_bits())
                        .collect::<Vec<_>>()
                );
            }
        }
    }

    #[tokio::test]
    async fn blocks_match_full_decode_and_waveforms_for_mono_stereo_and_surround() {
        let directory = tempfile::tempdir().unwrap();
        for rate in [16_000, 44_100, 48_000, 96_000] {
            for channels in [1, 2, 6] {
                let path = directory.path().join(format!("{rate}-{channels}.wav"));
                wave(&path, rate, channels);
                let reference = AudioData::from_file(&path).unwrap();
                let loader = ProgressiveAudio::spawn(path, "test".into());
                let first = loader.window(0..480).await.unwrap().unwrap();
                for index in 0..480 * usize::from(reference.channels()) {
                    assert_eq!(
                        first.sample(index).unwrap().to_bits(),
                        reference.samples()[index].to_bits()
                    );
                }
                let audio = loader.get().await.unwrap().unwrap();
                assert_eq!(audio.channels(), reference.channels());
                assert_eq!(audio.sample_count(), reference.sample_count());
                assert_eq!(
                    audio.sample_slices().flatten().count(),
                    reference.samples().len()
                );
                for (index, sample) in reference.samples().iter().enumerate() {
                    assert_eq!(
                        audio.sample(index).unwrap().to_bits(),
                        sample.to_bits(),
                        "{rate}/{channels} at {index}"
                    );
                }
                assert!(audio.sample(reference.samples().len()).is_none());
                let expected = reference
                    .samples()
                    .chunks(4_800 * usize::from(reference.channels()))
                    .map(|chunk| {
                        let sum = chunk.iter().fold(0.0_f32, |sum, sample| sum + sample.abs());
                        let average = sum / chunk.len() as f32;
                        if average > 0.0 {
                            20.0 * average.log10()
                        } else {
                            -60.0
                        }
                    })
                    .collect::<Vec<_>>();
                assert_eq!(
                    waveform_peaks(audio.sample_slices().flatten(), audio.channels()),
                    expected
                );
                for (position, offset, mode) in [
                    (0, -17, 0),
                    (BLOCK_FRAMES - 3, 0, 1),
                    (BLOCK_FRAMES + 7, 11, 2),
                    (reference.sample_count() - 3, 0, 0),
                ] {
                    let stereo_mode = || match mode {
                        1 => crate::StereoMode::MonoL,
                        2 => crate::StereoMode::MonoR,
                        _ => crate::StereoMode::Stereo,
                    };
                    let mut expected = vec![0.0_f32; 1_024];
                    let mut actual = expected.clone();
                    let expected_frames = crate::render_audio(
                        &[crate::AudioRendererTrack {
                            data: &reference,
                            gain: -4.0,
                            stereo_mode: stereo_mode(),
                            offset,
                        }],
                        position,
                        512,
                        0,
                        &mut expected,
                    );
                    let actual_frames = crate::render_audio(
                        &[crate::AudioRendererTrack {
                            data: audio.as_ref(),
                            gain: -4.0,
                            stereo_mode: stereo_mode(),
                            offset,
                        }],
                        position,
                        512,
                        0,
                        &mut actual,
                    );
                    assert_eq!(actual_frames, expected_frames);
                    assert!(
                        actual
                            .iter()
                            .zip(&expected)
                            .all(|(actual, expected)| actual.to_bits() == expected.to_bits())
                    );
                }
                assert_eq!(
                    loader.progress(),
                    AudioLoadProgress {
                        ready_frames: reference.sample_count(),
                        channels: Some(reference.channels()),
                        complete: true,
                        error: None,
                    }
                );
                let tail = loader
                    .window(reference.sample_count() - 1..reference.sample_count() + 480)
                    .await
                    .unwrap()
                    .unwrap();
                assert_eq!(tail.sample_count(), reference.sample_count());
                assert_eq!(
                    tail.sample(reference.samples().len() - 1),
                    reference.samples().last()
                );
                assert!(tail.sample(reference.samples().len()).is_none());
            }
        }
    }

    #[tokio::test]
    async fn range_waits_for_every_requested_sample_and_survives_publication_without_copying() {
        let (loader, tx) = controlled();
        append(&loader, &tx, BLOCK_FRAMES);
        let first = loader.window(0..100).await.unwrap().unwrap();
        assert!(!loader.progress().complete);
        let mut requested = Box::pin(loader.window(BLOCK_FRAMES - 3..BLOCK_FRAMES + 3));
        assert!(
            tokio::time::timeout(Duration::from_millis(10), &mut requested)
                .await
                .is_err()
        );
        append(&loader, &tx, BLOCK_FRAMES);
        let second = requested.await.unwrap().unwrap();
        for index in (BLOCK_FRAMES - 3) * 2..(BLOCK_FRAMES + 3) * 2 {
            assert_eq!(second.sample(index), Some(&(index as f32)));
        }
        let audio = {
            let mut pending = loader.pending.lock().unwrap();
            Arc::new(DecodedAudio {
                channels: 2,
                frames: pending.frames,
                storage: AudioStorage::Blocks(std::mem::take(&mut pending.blocks)),
            })
        };
        tx.send_replace(LoadState {
            progress: AudioLoadProgress {
                ready_frames: audio.frames,
                channels: Some(2),
                complete: true,
                error: None,
            },
            result: Some(Ok(Some(audio.clone()))),
        });
        assert!(std::ptr::eq(
            first.sample(0).unwrap(),
            audio.sample(0).unwrap()
        ));
        assert!(std::ptr::eq(
            second.sample(BLOCK_FRAMES * 2).unwrap(),
            audio.sample(BLOCK_FRAMES * 2).unwrap()
        ));
        assert_eq!(
            loader.get().await.unwrap().unwrap().sample_count(),
            BLOCK_FRAMES * 2
        );
    }

    #[tokio::test]
    async fn failed_or_dropped_producer_never_becomes_silence_or_success() {
        let (loader, tx) = controlled();
        append(&loader, &tx, BLOCK_FRAMES);
        tx.send_replace(LoadState {
            progress: AudioLoadProgress {
                error: Some("failed source".into()),
                ..loader.progress()
            },
            result: Some(Err("failed source".into())),
        });
        assert!(loader.window(0..1).await.is_err());
        assert!(loader.get().await.is_err());
        let (loader, tx) = controlled();
        drop(tx);
        assert!(loader.progress().error.is_some());
        assert!(loader.window(0..1).await.is_err());
        assert!(loader.get().await.is_err());
        let missing = ProgressiveAudio::spawn(
            PathBuf::from("/missing-cap-progressive-audio.wav"),
            "missing".into(),
        );
        assert!(missing.get().await.is_err());
        assert!(missing.progress().error.is_some());
        assert!(!missing.progress().complete);
    }

    #[test]
    fn waiting_for_completion_does_not_wake_for_partial_blocks() {
        use std::{
            future::Future,
            sync::atomic::{AtomicUsize, Ordering},
            task::{Context, Poll, Wake, Waker},
        };

        struct WakeCount(AtomicUsize);
        impl Wake for WakeCount {
            fn wake(self: Arc<Self>) {
                self.0.fetch_add(1, Ordering::Relaxed);
            }
        }

        let (loader, tx) = controlled();
        let count = Arc::new(WakeCount(AtomicUsize::new(0)));
        let waker = Waker::from(count.clone());
        let mut context = Context::from_waker(&waker);
        let mut completion = Box::pin(loader.get());
        assert!(completion.as_mut().poll(&mut context).is_pending());
        for _ in 0..8 {
            append(&loader, &tx, BLOCK_FRAMES);
        }
        assert_eq!(count.0.load(Ordering::Relaxed), 0);
        tx.send_replace(LoadState {
            progress: AudioLoadProgress {
                error: Some("test failure".into()),
                ..loader.progress()
            },
            result: Some(Err("test failure".into())),
        });
        assert_eq!(count.0.load(Ordering::Relaxed), 1);
        assert!(matches!(
            completion.as_mut().poll(&mut context),
            Poll::Ready(Err(_))
        ));
    }

    #[tokio::test]
    async fn absent_and_predecoded_tracks_are_ready_without_a_worker() {
        let loader = ProgressiveAudio::none();
        assert!(loader.get().await.unwrap().is_none());
        assert!(loader.window(0..100).await.unwrap().is_none());
        assert!(loader.progress().complete);
        let data = Arc::new(AudioData::from_raw_f32(vec![0.25, -0.5, 0.75, 1.0], 2));
        let loader = ProgressiveAudio::ready(Some(data.clone()));
        let audio = loader.get().await.unwrap().unwrap();
        assert!(std::ptr::eq(audio.sample(0).unwrap(), &data.samples()[0]));
        assert!(loader.window(Range { start: 2, end: 1 }).await.is_err());
    }

    #[tokio::test]
    async fn truncated_inputs_preserve_full_decoders_success_or_failure() {
        let directory = tempfile::tempdir().unwrap();
        let original = directory.path().join("original.wav");
        wave(&original, 44_100, 2);
        let bytes = std::fs::read(original).unwrap();
        for length in [0, 24, 44, 47, 4_097, bytes.len() - 1, bytes.len() - 1_001] {
            let path = directory.path().join(format!("truncated-{length}.wav"));
            std::fs::write(&path, &bytes[..length]).unwrap();
            let reference = AudioData::from_file(&path);
            let candidate = ProgressiveAudio::spawn(path, "truncated".into())
                .get()
                .await;
            assert_eq!(reference.is_ok(), candidate.is_ok(), "length {length}");
            if let (Ok(reference), Ok(Some(candidate))) = (reference, candidate) {
                assert_eq!(reference.sample_count(), candidate.sample_count());
                for (index, sample) in reference.samples().iter().enumerate() {
                    assert_eq!(
                        candidate.sample(index).unwrap().to_bits(),
                        sample.to_bits(),
                        "length {length} at {index}"
                    );
                }
            }
        }
    }

    #[test]
    fn discontinuities_partial_channels_and_short_interior_blocks_are_rejected() {
        for (start, channels, count) in [
            (1, 2, 4),
            (0, 0, 4),
            (0, 2, 3),
            (0, 2, 0),
            (0, 2, BLOCK_FRAMES * 2 + 2),
        ] {
            let mut pending = PendingBlocks::default();
            assert!(
                pending
                    .append(crate::AudioChunk {
                        source_start_sample: start,
                        channels,
                        samples: vec![0.0; count]
                    })
                    .is_err()
            );
        }
        let mut pending = PendingBlocks::default();
        pending
            .append(crate::AudioChunk {
                source_start_sample: 0,
                channels: 2,
                samples: vec![0.0; 8],
            })
            .unwrap();
        assert!(
            pending
                .append(crate::AudioChunk {
                    source_start_sample: 4,
                    channels: 2,
                    samples: vec![0.0; 8]
                })
                .is_err()
        );
        assert!(
            pending
                .append(crate::AudioChunk {
                    source_start_sample: 4,
                    channels: 1,
                    samples: vec![0.0; 8]
                })
                .is_err()
        );
    }
}
