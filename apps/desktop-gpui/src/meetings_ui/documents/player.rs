use std::{
    collections::VecDeque,
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    time::Duration,
};

use cap_meetings::{
    library::{Library, MeetingDetails},
    transcript::Source,
};
use ffmpeg::{
    ChannelLayout, Packet,
    format::{Sample, sample::Type},
    frame,
    software::resampling,
};

const RATE: u64 = 48_000;
const CHUNK: usize = 960;
const QUEUE_CHUNKS: usize = 50;

#[derive(Clone, Debug, PartialEq)]
pub struct Part {
    pub path: PathBuf,
    pub source: Source,
    pub offset_ms: u64,
    pub duration_ms: u64,
}

pub fn parts(library: &Library, doc_id: &str, meeting: &MeetingDetails) -> Vec<Part> {
    let offsets: Vec<(String, u64)> = meeting
        .extra
        .get("audioParts")
        .and_then(|v| v.as_array())
        .map(|parts| {
            parts
                .iter()
                .filter_map(|p| {
                    Some((
                        p.get("file")?.as_str()?.to_string(),
                        p.get("offsetMs").and_then(|o| o.as_u64()).unwrap_or(0),
                    ))
                })
                .collect()
        })
        .unwrap_or_default();
    let mut out: Vec<Part> = meeting
        .audio
        .iter()
        .filter_map(|track| {
            let path = library.audio_file_path(doc_id, &track.file).ok()?;
            let offset_ms = offsets
                .iter()
                .find(|(file, _)| file == &track.file)
                .map_or(0, |(_, offset)| *offset);
            Some(Part {
                path,
                source: track.source,
                offset_ms,
                duration_ms: track.duration_ms,
            })
        })
        .collect();
    out.sort_by_key(|p| (p.source, p.offset_ms));
    out
}

pub fn total_ms(parts: &[Part]) -> u64 {
    parts
        .iter()
        .map(|p| p.offset_ms + p.duration_ms)
        .max()
        .unwrap_or(0)
}

struct FileReader {
    input: ffmpeg::format::context::Input,
    stream: usize,
    decoder: ffmpeg::decoder::Audio,
    resampler: Option<resampling::Context>,
    time_base: f64,
    pending: VecDeque<f32>,
    cursor: u64,
    skip_until: u64,
    eof: bool,
}

impl FileReader {
    fn open(path: &std::path::Path, start: u64) -> Result<Self, ffmpeg::Error> {
        let mut input = ffmpeg::format::input(&path)?;
        let stream = input
            .streams()
            .best(ffmpeg::media::Type::Audio)
            .ok_or(ffmpeg::Error::StreamNotFound)?;
        let index = stream.index();
        let tb = stream.time_base();
        let time_base = f64::from(tb.numerator()) / f64::from(tb.denominator().max(1));
        let decoder = ffmpeg::codec::context::Context::from_parameters(stream.parameters())?
            .decoder()
            .audio()?;
        let mut cursor = 0;
        if start > 0 {
            let ts =
                (start as i64).saturating_mul(i64::from(ffmpeg::ffi::AV_TIME_BASE)) / RATE as i64;
            if input.seek(ts, ..ts).is_err() {
                cursor = 0;
            } else {
                cursor = u64::MAX;
            }
        }
        Ok(Self {
            input,
            stream: index,
            decoder,
            resampler: None,
            time_base,
            pending: VecDeque::new(),
            cursor,
            skip_until: start,
            eof: false,
        })
    }

    fn fill(&mut self) -> bool {
        let mut packet = Packet::empty();
        loop {
            let mut decoded = frame::Audio::empty();
            if self.decoder.receive_frame(&mut decoded).is_ok() {
                self.push_frame(&decoded);
                return true;
            }
            if self.eof {
                return false;
            }
            match packet.read(&mut self.input) {
                Ok(()) => {
                    if packet.stream() == self.stream && self.decoder.send_packet(&packet).is_err()
                    {
                        continue;
                    }
                }
                Err(ffmpeg::Error::Eof) => {
                    self.eof = true;
                    let _ = self.decoder.send_eof();
                }
                Err(_) => {
                    self.eof = true;
                    let _ = self.decoder.send_eof();
                }
            }
        }
    }

    fn push_frame(&mut self, decoded: &frame::Audio) {
        if self.cursor == u64::MAX {
            self.cursor = decoded
                .pts()
                .map(|pts| ((pts.max(0) as f64) * self.time_base * RATE as f64).round() as u64)
                .unwrap_or(self.skip_until);
        }
        let direct = decoded.channels() == 1
            && matches!(decoded.format(), Sample::F32(_))
            && u64::from(decoded.rate()) == RATE;
        let samples: Vec<f32> = if direct {
            decoded.plane::<f32>(0)[..decoded.samples()].to_vec()
        } else {
            let resampler = match self.resampler.as_mut() {
                Some(r) => r,
                None => {
                    match resampling::Context::get(
                        decoded.format(),
                        decoded.channel_layout(),
                        decoded.rate(),
                        Sample::F32(Type::Packed),
                        ChannelLayout::MONO,
                        RATE as u32,
                    ) {
                        Ok(r) => self.resampler.insert(r),
                        Err(_) => return,
                    }
                }
            };
            let mut out = frame::Audio::empty();
            if resampler.run(decoded, &mut out).is_err() {
                return;
            }
            out.plane::<f32>(0)[..out.samples()].to_vec()
        };
        for sample in samples {
            if self.cursor >= self.skip_until {
                self.pending.push_back(sample);
            }
            self.cursor += 1;
        }
    }

    fn read(&mut self, out: &mut [f32]) -> usize {
        let mut written = 0;
        while written < out.len() {
            if self.pending.is_empty() && !self.fill() {
                break;
            }
            while written < out.len() {
                match self.pending.pop_front() {
                    Some(s) => {
                        out[written] = s;
                        written += 1;
                    }
                    None => break,
                }
            }
        }
        written
    }
}

struct Track {
    parts: Vec<Part>,
    index: usize,
    reader: Option<FileReader>,
    position: u64,
}

impl Track {
    fn new(parts: Vec<Part>, position: u64) -> Self {
        Self {
            parts,
            index: 0,
            reader: None,
            position,
        }
    }

    fn next_chunk(&mut self, out: &mut [f32]) {
        out.fill(0.);
        let mut filled = 0;
        while filled < out.len() {
            let Some(part) = self.parts.get(self.index) else {
                self.position += (out.len() - filled) as u64;
                return;
            };
            let start = part.offset_ms * RATE / 1000;
            let end = start + part.duration_ms.max(1) * RATE / 1000;
            if self.position >= end {
                self.index += 1;
                self.reader = None;
                continue;
            }
            if self.position < start {
                let gap = ((start - self.position) as usize).min(out.len() - filled);
                filled += gap;
                self.position += gap as u64;
                continue;
            }
            if self.reader.is_none() {
                match FileReader::open(&part.path, self.position - start) {
                    Ok(reader) => self.reader = Some(reader),
                    Err(error) => {
                        tracing::warn!(%error, "could not open meeting audio");
                        self.index += 1;
                        continue;
                    }
                }
            }
            let want = ((end - self.position) as usize).min(out.len() - filled);
            let Some(reader) = self.reader.as_mut() else {
                break;
            };
            let got = reader.read(&mut out[filled..filled + want]);
            if got == 0 {
                self.index += 1;
                self.reader = None;
                self.position = self.position.max(end);
                continue;
            }
            filled += got;
            self.position += got as u64;
        }
    }

    fn finished(&self) -> bool {
        self.index >= self.parts.len()
    }
}

#[derive(Default)]
pub struct Shared {
    pub emitted: AtomicU64,
    pub start_ms: AtomicU64,
    pub playing: AtomicBool,
    pub ended: AtomicBool,
    generation: AtomicU64,
}

impl Shared {
    pub fn position_ms(&self) -> u64 {
        self.start_ms.load(Ordering::Relaxed) + self.emitted.load(Ordering::Relaxed) * 1000 / RATE
    }
}

struct MixSource {
    rx: flume::Receiver<Vec<f32>>,
    chunk: Vec<f32>,
    at: usize,
    shared: Arc<Shared>,
    generation: u64,
    done: bool,
}

impl Iterator for MixSource {
    type Item = f32;

    fn next(&mut self) -> Option<f32> {
        if self.shared.generation.load(Ordering::Relaxed) != self.generation {
            return None;
        }
        if self.at >= self.chunk.len() {
            match self.rx.try_recv() {
                Ok(chunk) => {
                    self.chunk = chunk;
                    self.at = 0;
                }
                Err(flume::TryRecvError::Empty) if !self.done => {
                    return Some(0.);
                }
                Err(_) => {
                    self.done = true;
                    self.shared.ended.store(true, Ordering::Relaxed);
                    self.shared.playing.store(false, Ordering::Relaxed);
                    return None;
                }
            }
        }
        let sample = self.chunk.get(self.at).copied().unwrap_or(0.);
        self.at += 1;
        self.shared.emitted.fetch_add(1, Ordering::Relaxed);
        Some(sample)
    }
}

impl rodio::Source for MixSource {
    fn current_frame_len(&self) -> Option<usize> {
        None
    }

    fn channels(&self) -> u16 {
        1
    }

    fn sample_rate(&self) -> u32 {
        RATE as u32
    }

    fn total_duration(&self) -> Option<Duration> {
        None
    }
}

enum Command {
    Play(u64),
    Pause,
    Resume,
}

pub struct Player {
    pub duration_ms: u64,
    pub shared: Arc<Shared>,
    commands: flume::Sender<Command>,
}

fn decode(
    parts: Vec<Part>,
    from_ms: u64,
    tx: flume::Sender<Vec<f32>>,
    shared: Arc<Shared>,
    generation: u64,
) {
    let position = from_ms * RATE / 1000;
    let (mic, system): (Vec<Part>, Vec<Part>) =
        parts.into_iter().partition(|p| p.source == Source::Mic);
    let mut tracks = [Track::new(mic, position), Track::new(system, position)];
    let mut a = vec![0f32; CHUNK];
    let mut b = vec![0f32; CHUNK];
    loop {
        if shared.generation.load(Ordering::Relaxed) != generation {
            return;
        }
        if tracks.iter().all(Track::finished) {
            return;
        }
        let [first, second] = &mut tracks;
        first.next_chunk(&mut a);
        second.next_chunk(&mut b);
        let mixed: Vec<f32> = a
            .iter()
            .zip(&b)
            .map(|(x, y)| ((x + y) * 0.9).clamp(-1., 1.))
            .collect();
        if tx.send(mixed).is_err() {
            return;
        }
    }
}

impl Player {
    pub fn new(parts: Vec<Part>, duration_ms: u64) -> Self {
        let duration_ms = duration_ms.max(total_ms(&parts));
        let shared = Arc::new(Shared::default());
        let (commands, rx) = flume::unbounded::<Command>();
        let thread_parts = parts;
        let thread_shared = shared.clone();
        let spawned = std::thread::Builder::new()
            .name("cap-documents-player".into())
            .spawn(move || run(thread_parts, rx, thread_shared));
        if let Err(error) = spawned {
            tracing::warn!(%error, "could not start the audio player");
        }
        Self {
            duration_ms,
            shared,
            commands,
        }
    }

    pub fn play_from(&self, ms: u64) {
        let _ = self.commands.send(Command::Play(ms.min(self.duration_ms)));
    }

    pub fn pause(&self) {
        let _ = self.commands.send(Command::Pause);
    }

    pub fn resume(&self) {
        if self.shared.ended.load(Ordering::Relaxed) || self.position_ms() >= self.duration_ms {
            self.play_from(0);
        } else {
            let _ = self.commands.send(Command::Resume);
        }
    }

    pub fn is_playing(&self) -> bool {
        self.shared.playing.load(Ordering::Relaxed)
    }

    pub fn position_ms(&self) -> u64 {
        self.shared.position_ms().min(self.duration_ms)
    }
}

impl Drop for Player {
    fn drop(&mut self) {
        self.shared.generation.fetch_add(1, Ordering::Relaxed);
    }
}

fn run(parts: Vec<Part>, commands: flume::Receiver<Command>, shared: Arc<Shared>) {
    let mut output: Option<(rodio::OutputStream, rodio::OutputStreamHandle)> = None;
    let mut sink: Option<rodio::Sink> = None;
    let mut started = false;
    while let Ok(command) = commands.recv() {
        match command {
            Command::Play(ms) => {
                let generation = shared.generation.fetch_add(1, Ordering::Relaxed) + 1;
                if let Some(sink) = sink.take() {
                    sink.stop();
                }
                if output.is_none() {
                    match crate::app_sounds::open_output() {
                        Ok(stream) => output = Some(stream),
                        Err(error) => {
                            tracing::warn!(%error, "no audio output for meeting playback");
                            continue;
                        }
                    }
                }
                let Some((_, handle)) = output.as_ref() else {
                    continue;
                };
                let new_sink = match rodio::Sink::try_new(handle) {
                    Ok(sink) => sink,
                    Err(error) => {
                        tracing::warn!(%error, "could not create the playback sink");
                        continue;
                    }
                };
                let (tx, rx) = flume::bounded(QUEUE_CHUNKS);
                let decode_parts = parts.clone();
                let decode_shared = shared.clone();
                let spawned = std::thread::Builder::new()
                    .name("cap-documents-decode".into())
                    .spawn(move || decode(decode_parts, ms, tx, decode_shared, generation));
                if spawned.is_err() {
                    continue;
                }
                shared.start_ms.store(ms, Ordering::Relaxed);
                shared.emitted.store(0, Ordering::Relaxed);
                shared.ended.store(false, Ordering::Relaxed);
                shared.playing.store(true, Ordering::Relaxed);
                new_sink.append(MixSource {
                    rx,
                    chunk: Vec::new(),
                    at: 0,
                    shared: shared.clone(),
                    generation,
                    done: false,
                });
                new_sink.play();
                sink = Some(new_sink);
                started = true;
            }
            Command::Pause => {
                if let Some(sink) = sink.as_ref() {
                    sink.pause();
                }
                shared.playing.store(false, Ordering::Relaxed);
            }
            Command::Resume => {
                if let Some(sink) = sink.as_ref().filter(|_| started) {
                    sink.play();
                    shared.playing.store(true, Ordering::Relaxed);
                }
            }
        }
    }
    shared.generation.fetch_add(1, Ordering::Relaxed);
    if let Some(sink) = sink {
        sink.stop();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn part(source: Source, offset_ms: u64, duration_ms: u64) -> Part {
        Part {
            path: PathBuf::from("/nonexistent.ogg"),
            source,
            offset_ms,
            duration_ms,
        }
    }

    #[test]
    fn total_covers_the_latest_part() {
        let parts = vec![
            part(Source::Mic, 0, 60_000),
            part(Source::System, 0, 61_000),
            part(Source::Mic, 62_000, 10_000),
        ];
        assert_eq!(total_ms(&parts), 72_000);
    }

    #[test]
    fn missing_files_play_as_silence_and_end() {
        let mut track = Track::new(vec![part(Source::Mic, 0, 10)], 0);
        let mut out = vec![1f32; 64];
        track.next_chunk(&mut out);
        assert!(out.iter().all(|s| *s == 0.));
        assert!(track.finished());
    }
}
