//! A note's recorded sound, handed to the audio-only project hook: "Open in
//! editor" makes a Cap project of it, "Download audio" saves it as MP3 or WAV.

use std::{
    fs::File,
    io::{BufWriter, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
};

use cap_export::audio_project::{AudioProjectSources, create_audio_only_project};
use cap_meetings::{library::DocMeta, transcript::Source};
use ffmpeg::{
    ChannelLayout, Packet,
    format::{Sample, sample::Type},
    frame,
    software::resampling,
};
use gpui::{App, Entity, Window};

use super::{export, player, player::Part, store::DocStore};
use crate::{audio_project::Shown, i18n::tr};

const RATE: u32 = crate::meetings::timeline::RATE;

/// The note's audio, or `None` while it is still recording or has none.
fn finished_parts(store: &Entity<DocStore>, meta: &DocMeta, cx: &App) -> Option<Vec<Part>> {
    let live = crate::meetings::Meetings::try_global(cx)
        .and_then(|m| m.read(cx).active().map(|a| a.doc_id == meta.id))
        .unwrap_or(false);
    if live {
        return None;
    }
    let library = store.read(cx).library()?.clone();
    let parts = player::parts(&library, &meta.id, meta.meeting.as_ref()?);
    (!parts.is_empty()).then_some(parts)
}

pub fn open_in_editor(store: &Entity<DocStore>, meta: &DocMeta, cx: &mut App) {
    let Some(parts) = finished_parts(store, meta, cx) else {
        return;
    };
    crate::audio_project::open_prepared_audio_in_editor(
        move || {
            let scratch = tempfile::tempdir().map_err(AudioError::NotReady)?;
            let sources = sources(&parts, scratch.path())?;
            Ok((sources, scratch))
        },
        export::display_title(meta),
        cx,
    );
}

pub fn download(store: &Entity<DocStore>, meta: &DocMeta, window: &mut Window, cx: &mut App) {
    let Some(parts) = finished_parts(store, meta, cx) else {
        return;
    };
    let title = export::display_title(meta);
    let pretty_name = title.clone();
    crate::audio_project::save_prepared_audio_as(
        pretty_name,
        move || {
            let scratch = tempfile::tempdir().map_err(AudioError::NotReady)?;
            let sources = sources(&parts, scratch.path())?;
            let project = scratch.path().join("note.cap");
            create_audio_only_project(&project, &title, &sources)
                .map_err(|error| AudioError::NotReady(std::io::Error::other(error.to_string())))?;
            Ok((project, scratch))
        },
        window,
        cx,
    );
}

/// Why a note's sound could not be handed on. The dialog says it in the
/// person's language; the detail, with file names, stays in the log.
#[derive(Debug)]
pub enum AudioError {
    NoAudio,
    Unreadable { file: String, error: String },
    NotReady(std::io::Error),
}

impl From<AudioError> for Shown {
    fn from(error: AudioError) -> Self {
        match error {
            AudioError::NoAudio => Shown {
                title: tr::documents::audio::no_audio_title(),
                message: tr::documents::audio::no_audio_message(),
            },
            AudioError::Unreadable { file, error } => {
                tracing::warn!(file, error, "could not read a note's audio");
                Shown {
                    title: tr::documents::audio::unreadable_title(),
                    message: tr::documents::audio::unreadable_message(),
                }
            }
            AudioError::NotReady(error) => {
                tracing::warn!(%error, "could not prepare a note's audio");
                Shown {
                    title: tr::documents::audio::not_ready_title(),
                    message: tr::documents::audio::not_ready_message(),
                }
            }
        }
    }
}

/// One file per side of the call. A side recorded in one piece from the
/// start is used as it is; a side in several pieces (the note was recorded
/// into again later) is laid out on one WAV at the pieces' offsets, with
/// silence between them, written under `scratch`.
pub fn sources(parts: &[Part], scratch: &Path) -> Result<AudioProjectSources, AudioError> {
    let side = |source: Source, name: &str| -> Result<Option<PathBuf>, AudioError> {
        let pieces: Vec<&Part> = parts.iter().filter(|p| p.source == source).collect();
        match pieces.as_slice() {
            [] => Ok(None),
            [only] if only.offset_ms == 0 => Ok(Some(only.path.clone())),
            _ => {
                let path = scratch.join(name);
                stitch(&pieces, &path)?;
                Ok(Some(path))
            }
        }
    };
    let sources = AudioProjectSources {
        microphone: side(Source::Mic, "microphone.wav")?,
        system_audio: side(Source::System, "system.wav")?,
    };
    if sources.microphone.is_none() && sources.system_audio.is_none() {
        return Err(AudioError::NoAudio);
    }
    Ok(sources)
}

fn stitch(pieces: &[&Part], output: &Path) -> Result<(), AudioError> {
    let mut pieces = pieces.to_vec();
    pieces.sort_by_key(|p| p.offset_ms);
    let mut wav = WavWriter::create(output).map_err(AudioError::NotReady)?;
    for piece in pieces {
        let start = piece.offset_ms * u64::from(RATE) / 1000;
        if start > wav.samples {
            wav.silence(start - wav.samples)
                .map_err(AudioError::NotReady)?;
        }
        let mut skip = wav.samples.saturating_sub(start);
        let mut written = Ok(());
        let decoded = decode(&piece.path, |samples| {
            let take = skip.min(samples.len() as u64) as usize;
            skip -= take as u64;
            written = wav.samples(&samples[take..]);
            written
                .as_ref()
                .map(|_| ())
                .map_err(|_| std::io::ErrorKind::Other.into())
        });
        written.map_err(AudioError::NotReady)?;
        decoded.map_err(|error| AudioError::Unreadable {
            file: piece
                .path
                .file_name()
                .map(|name| name.to_string_lossy().into_owned())
                .unwrap_or_default(),
            error,
        })?;
    }
    wav.finish().map_err(AudioError::NotReady)
}

fn decode(path: &Path, mut sink: impl FnMut(&[f32]) -> std::io::Result<()>) -> Result<(), String> {
    let mut input = ffmpeg::format::input(&path).map_err(|error| error.to_string())?;
    let stream = input
        .streams()
        .best(ffmpeg::media::Type::Audio)
        .ok_or("it has no audio")?;
    let index = stream.index();
    let mut decoder = ffmpeg::codec::context::Context::from_parameters(stream.parameters())
        .and_then(|context| context.decoder().audio())
        .map_err(|error| error.to_string())?;
    let mut resampler: Option<resampling::Context> = None;
    let mut convert = |decoded: &frame::Audio,
                       resampler: &mut Option<resampling::Context>|
     -> Result<(), String> {
        let resampler = match resampler {
            Some(resampler) => resampler,
            None => resampler.insert(
                resampling::Context::get(
                    decoded.format(),
                    decoded.channel_layout(),
                    decoded.rate(),
                    Sample::F32(Type::Packed),
                    ChannelLayout::MONO,
                    RATE,
                )
                .map_err(|error| error.to_string())?,
            ),
        };
        let mut out = frame::Audio::empty();
        resampler
            .run(decoded, &mut out)
            .map_err(|error| error.to_string())?;
        sink(&out.plane::<f32>(0)[..out.samples()]).map_err(|error| error.to_string())
    };
    let mut packet = Packet::empty();
    let mut decoded = frame::Audio::empty();
    let mut eof = false;
    loop {
        while decoder.receive_frame(&mut decoded).is_ok() {
            convert(&decoded, &mut resampler)?;
        }
        if eof {
            break;
        }
        match packet.read(&mut input) {
            Ok(()) => {
                if packet.stream() == index {
                    decoder
                        .send_packet(&packet)
                        .map_err(|error| error.to_string())?;
                }
            }
            Err(ffmpeg::Error::Eof) => {
                eof = true;
                decoder.send_eof().map_err(|error| error.to_string())?;
            }
            Err(error) => return Err(error.to_string()),
        }
    }
    if let Some(resampler) = resampler.as_mut() {
        let mut out = frame::Audio::empty();
        if resampler.flush(&mut out).is_ok() && out.samples() > 0 {
            sink(&out.plane::<f32>(0)[..out.samples()]).map_err(|error| error.to_string())?;
        }
    }
    Ok(())
}

/// 16-bit mono PCM at the meeting rate. The sizes in the header are written
/// once the length is known.
struct WavWriter {
    file: BufWriter<File>,
    samples: u64,
}

impl WavWriter {
    fn create(path: &Path) -> std::io::Result<Self> {
        let mut file = BufWriter::new(File::create(path)?);
        file.write_all(&Self::header(0))?;
        Ok(Self { file, samples: 0 })
    }

    fn header(samples: u64) -> [u8; 44] {
        let data = u32::try_from(samples * 2).unwrap_or(u32::MAX - 36);
        let mut header = [0u8; 44];
        header[0..4].copy_from_slice(b"RIFF");
        header[4..8].copy_from_slice(&(data + 36).to_le_bytes());
        header[8..16].copy_from_slice(b"WAVEfmt ");
        header[16..20].copy_from_slice(&16u32.to_le_bytes());
        header[20..22].copy_from_slice(&1u16.to_le_bytes());
        header[22..24].copy_from_slice(&1u16.to_le_bytes());
        header[24..28].copy_from_slice(&RATE.to_le_bytes());
        header[28..32].copy_from_slice(&(RATE * 2).to_le_bytes());
        header[32..34].copy_from_slice(&2u16.to_le_bytes());
        header[34..36].copy_from_slice(&16u16.to_le_bytes());
        header[36..40].copy_from_slice(b"data");
        header[40..44].copy_from_slice(&data.to_le_bytes());
        header
    }

    fn samples(&mut self, samples: &[f32]) -> std::io::Result<()> {
        for sample in samples {
            let value = (sample.clamp(-1.0, 1.0) * f32::from(i16::MAX)).round() as i16;
            self.file.write_all(&value.to_le_bytes())?;
        }
        self.samples += samples.len() as u64;
        Ok(())
    }

    fn silence(&mut self, count: u64) -> std::io::Result<()> {
        const ZEROS: [u8; 4096] = [0; 4096];
        let mut bytes = count * 2;
        while bytes > 0 {
            let chunk = bytes.min(ZEROS.len() as u64) as usize;
            self.file.write_all(&ZEROS[..chunk])?;
            bytes -= chunk as u64;
        }
        self.samples += count;
        Ok(())
    }

    fn finish(mut self) -> std::io::Result<()> {
        self.file.seek(SeekFrom::Start(0))?;
        self.file.write_all(&Self::header(self.samples))?;
        self.file.flush()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::meetings::audio_file::OpusOggWriter;

    fn tone(path: &Path, seconds: f32, level: f32) {
        let mut writer = OpusOggWriter::create(path).unwrap();
        let samples: Vec<f32> = (0..(seconds * RATE as f32) as usize)
            .map(|i| level * (i as f32 * 440.0 * std::f32::consts::TAU / RATE as f32).sin())
            .collect();
        writer.write(&samples).unwrap();
        writer.finish().unwrap();
    }

    fn part(path: &Path, source: Source, offset_ms: u64, duration_ms: u64) -> Part {
        Part {
            path: path.to_path_buf(),
            source,
            offset_ms,
            duration_ms,
        }
    }

    fn wav_samples(path: &Path) -> Vec<i16> {
        let bytes = std::fs::read(path).unwrap();
        assert_eq!(&bytes[0..4], b"RIFF");
        let data = u32::from_le_bytes(bytes[40..44].try_into().unwrap()) as usize;
        assert_eq!(bytes.len(), 44 + data);
        bytes[44..]
            .chunks_exact(2)
            .map(|pair| i16::from_le_bytes([pair[0], pair[1]]))
            .collect()
    }

    #[test]
    fn a_side_in_one_piece_is_used_as_it_is() {
        let dir = tempfile::tempdir().unwrap();
        let mic = dir.path().join("mic.ogg");
        tone(&mic, 1.0, 0.5);
        let sources = sources(&[part(&mic, Source::Mic, 0, 1000)], dir.path()).unwrap();
        assert_eq!(sources.microphone.as_deref(), Some(mic.as_path()));
        assert_eq!(sources.system_audio, None);
    }

    #[test]
    fn pieces_are_laid_out_at_their_offsets_with_silence_between() {
        let ffmpeg_ready = ffmpeg::init().is_ok();
        assert!(ffmpeg_ready);
        let dir = tempfile::tempdir().unwrap();
        let first = dir.path().join("a.ogg");
        let second = dir.path().join("b.ogg");
        tone(&first, 1.0, 0.5);
        tone(&second, 1.0, 0.5);
        let sources = sources(
            &[
                part(&second, Source::System, 3000, 1000),
                part(&first, Source::System, 0, 1000),
            ],
            dir.path(),
        )
        .unwrap();
        assert_eq!(sources.microphone, None);
        let stitched = sources.system_audio.unwrap();
        assert_eq!(stitched, dir.path().join("system.wav"));
        let samples = wav_samples(&stitched);
        let rate = RATE as usize;
        assert!(samples.len() >= 4 * rate - rate / 50);
        assert!(samples.len() <= 4 * rate + rate / 10);
        let loud = |range: std::ops::Range<usize>| {
            samples[range]
                .iter()
                .map(|s| i64::from(s.unsigned_abs()))
                .max()
                .unwrap()
        };
        assert!(loud(rate / 10..rate * 9 / 10) > 8000);
        assert_eq!(loud(rate * 3 / 2..rate * 5 / 2), 0);
        assert!(loud(rate * 31 / 10..rate * 39 / 10) > 8000);
    }

    #[test]
    fn a_note_without_audio_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let shown = Shown::from(sources(&[], dir.path()).unwrap_err());
        assert_eq!(shown.title, tr::documents::audio::no_audio_title());
        assert_eq!(shown.message, tr::documents::audio::no_audio_message());
    }

    /// The dialog says what happened in the person's language; the file
    /// name and the decoder's own words stay in the log.
    #[test]
    fn a_damaged_piece_is_reported_without_paths_or_decoder_text() {
        assert!(ffmpeg::init().is_ok());
        let dir = tempfile::tempdir().unwrap();
        let good = dir.path().join("a.ogg");
        let damaged = dir.path().join("b.ogg");
        tone(&good, 1.0, 0.5);
        std::fs::write(&damaged, b"not audio at all").unwrap();
        let error = sources(
            &[
                part(&good, Source::Mic, 0, 1000),
                part(&damaged, Source::Mic, 2000, 1000),
            ],
            dir.path(),
        )
        .unwrap_err();
        assert!(
            matches!(&error, AudioError::Unreadable { file, .. } if file == "b.ogg"),
            "{error:?}"
        );
        let shown = Shown::from(error);
        assert_eq!(shown.title, tr::documents::audio::unreadable_title());
        assert_eq!(shown.message, tr::documents::audio::unreadable_message());
        let path = dir.path().to_string_lossy();
        assert!(!shown.message.contains(path.as_ref()) && !shown.message.contains("b.ogg"));
    }

    #[test]
    fn a_meeting_becomes_an_audio_only_project_that_exports() {
        let dir = tempfile::tempdir().unwrap();
        let mic = dir.path().join("mic.ogg");
        let system_a = dir.path().join("sys-a.ogg");
        let system_b = dir.path().join("sys-b.ogg");
        tone(&mic, 3.0, 0.4);
        tone(&system_a, 1.0, 0.4);
        tone(&system_b, 1.0, 0.4);
        let scratch = dir.path().join("scratch");
        std::fs::create_dir_all(&scratch).unwrap();
        let sources = sources(
            &[
                part(&mic, Source::Mic, 0, 3000),
                part(&system_a, Source::System, 0, 1000),
                part(&system_b, Source::System, 2000, 1000),
            ],
            &scratch,
        )
        .unwrap();
        let project = dir.path().join("Weekly sync.cap");
        let meta = create_audio_only_project(&project, "Weekly sync", &sources).unwrap();
        assert_eq!(meta.pretty_name, "Weekly sync");
        assert!(
            project
                .join("content/segments/segment-0/audio-input.ogg")
                .exists()
        );
        assert!(
            project
                .join("content/segments/segment-0/system_audio.wav")
                .exists()
        );

        let output = dir.path().join("Weekly sync.wav");
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let written = runtime
            .block_on(cap_export::audio::export_audio(
                project,
                None,
                cap_export::audio::AudioExportFormat::Wav,
                output.clone(),
                std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
                |_| {},
            ))
            .unwrap();
        assert_eq!(written, output);
        let exported = std::fs::metadata(&output).unwrap().len();
        assert!(exported > 100_000, "exported only {exported} bytes");
    }
}
