use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

use cap_project::{
    CursorEvents, MaskKind, ProjectConfiguration, RecordingMeta, StudioRecordingMeta,
    TimelineConfiguration,
};
use cap_steps::{
    ButtonEvent, Captions, ClipEvents, Document, DocumentStep, Marker, Point, PointerMove, Size,
    Source, Word,
};

pub(crate) const GUIDE_FILE: &str = "guide.md";
pub(crate) const GUIDE_DATA_FILE: &str = "guide.json";
pub(crate) const STEP_IMAGES_FOLDER: &str = "steps";

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum StepsError {
    NoSteps,
    HiddenAreas,
    Cancelled,
    Failed(String),
}

const OUTSIDE_FRAME: f64 = 0.001;

/// One recording segment. Cursor events are on the recording's clock, the
/// timeline's source time starts at the segment's latest track start, and
/// the screen file at the screen's own start (`segment_video_timing` in
/// cap-rendering): `event_offset` and `screen_offset` are those two gaps.
struct Clip {
    display: PathBuf,
    cursor: CursorEvents,
    event_offset: f64,
    screen_offset: f64,
}

fn clips(meta: &RecordingMeta) -> Vec<Clip> {
    match meta.studio_meta() {
        Some(StudioRecordingMeta::MultipleSegments { inner }) => inner
            .segments
            .iter()
            .map(|segment| {
                let latest_start = segment.latest_start_time();
                Clip {
                    display: meta.path(&segment.display.path),
                    cursor: segment.cursor_events(meta),
                    event_offset: latest_start.unwrap_or(0.0),
                    screen_offset: latest_start
                        .zip(segment.display.start_time)
                        .map_or(0.0, |(latest, screen)| latest - screen),
                }
            })
            .collect(),
        Some(StudioRecordingMeta::SingleSegment { segment }) => vec![Clip {
            display: meta.path(&segment.display.path),
            cursor: segment
                .cursor
                .as_ref()
                .and_then(|cursor| CursorEvents::load_from_file(&meta.path(cursor)).ok())
                .unwrap_or_default(),
            event_offset: 0.0,
            screen_offset: 0.0,
        }],
        None => Vec::new(),
    }
}

/// A recording that was never remuxed keeps its screen track as a folder of
/// `init.mp4` and `.m4s` fragments, which the editor plays as it is.
enum ScreenTrack {
    File(ffmpeg::format::context::Input),
    Fragments(cap_enc_ffmpeg::SegmentedInput),
}

impl ScreenTrack {
    fn open(path: &Path) -> Result<Self, String> {
        if path.is_dir() {
            cap_video_decode::ffmpeg::open_fragmented_input(path).map(Self::Fragments)
        } else {
            ffmpeg::format::input(path)
                .map(Self::File)
                .map_err(|error| error.to_string())
        }
    }

    fn input(&self) -> &ffmpeg::format::context::Input {
        match self {
            Self::File(input) => input,
            Self::Fragments(fragments) => fragments.input(),
        }
    }

    fn seek(&mut self, position: i64) -> Result<(), ffmpeg::Error> {
        match self {
            Self::File(input) => input.seek(position, ..position),
            Self::Fragments(fragments) => fragments.seek(position),
        }
    }

    fn next_packet(&mut self) -> Result<Option<ffmpeg::Packet>, ffmpeg::Error> {
        match self {
            Self::File(input) => Ok(input.packets().next().map(|(_, packet)| packet)),
            Self::Fragments(fragments) => {
                let mut packet = ffmpeg::Packet::empty();
                match fragments.read_packet(&mut packet) {
                    Ok(()) => Ok(Some(packet)),
                    Err(ffmpeg::Error::Eof) => Ok(None),
                    Err(error) => Err(error),
                }
            }
        }
    }
}

fn media_duration(path: &Path) -> f64 {
    ScreenTrack::open(path)
        .map(|track| track.input().duration().max(0) as f64 / f64::from(ffmpeg::ffi::AV_TIME_BASE))
        .unwrap_or(0.0)
}

fn source_length(clip: &Clip) -> f64 {
    (media_duration(&clip.display) - clip.screen_offset).max(0.0)
}

fn pointer_at(path: &[PointerMove], time: f64) -> Option<Point> {
    let after = path.partition_point(|moved| moved.time <= time);
    path.get(after.saturating_sub(1))
        .map(|moved| moved.position)
}

fn outside_frame(position: Point) -> bool {
    let inside = -OUTSIDE_FRAME..=1.0 + OUTSIDE_FRAME;
    !inside.contains(&position.x) || !inside.contains(&position.y)
}

/// A project that was never edited has no timeline, and plays its clips
/// back to back.
enum Playback<'a> {
    Edited(&'a TimelineConfiguration),
    BackToBack(Vec<(f64, f64)>),
}

impl<'a> Playback<'a> {
    fn new(project: &'a ProjectConfiguration, clips: &[Clip]) -> Self {
        match &project.timeline {
            Some(timeline) => Self::Edited(timeline),
            None => {
                let mut start = 0.0;
                Self::BackToBack(
                    clips
                        .iter()
                        .map(|clip| {
                            let length = source_length(clip);
                            let span = (start, length);
                            start += length;
                            span
                        })
                        .collect(),
                )
            }
        }
    }

    fn duration(&self) -> f64 {
        match self {
            Self::Edited(timeline) => timeline.duration(),
            Self::BackToBack(spans) => spans.iter().map(|(_, length)| length).sum(),
        }
    }

    fn output_time(&self, clip: u32, source_time: f64) -> Option<f64> {
        match self {
            Self::Edited(timeline) => timeline.output_time_for_source(clip, source_time),
            Self::BackToBack(spans) => spans
                .get(clip as usize)
                .filter(|(_, length)| (0.0..=*length).contains(&source_time))
                .map(|(start, _)| start + source_time),
        }
    }
}

fn caption_words(timeline: &TimelineConfiguration) -> Vec<Word> {
    let mut words = Vec::new();
    for caption in &timeline.caption_segments {
        if !caption.words.is_empty() {
            words.extend(caption.words.iter().map(|word| Word {
                start: f64::from(word.start),
                end: f64::from(word.end),
                text: word.text.clone(),
            }));
            continue;
        }
        let spoken: Vec<&str> = caption.text.split_whitespace().collect();
        let each = (caption.end - caption.start) / spoken.len().max(1) as f64;
        words.extend(spoken.iter().enumerate().map(|(index, text)| Word {
            start: caption.start + each * index as f64,
            end: caption.start + each * (index + 1) as f64,
            text: (*text).to_string(),
        }));
    }
    words
}

/// A Sensitive mask is drawn over the styled frame, after padding, zoom and
/// the 3D camera have moved the screen under it, so only the renderer knows
/// which part of the recorded screen it covers. Screenshots are cut from the
/// screen track below all of that and would show what the mask hides.
pub(crate) fn hides_areas(project: &ProjectConfiguration) -> bool {
    project.timeline.as_ref().is_some_and(|timeline| {
        timeline
            .mask_segments
            .iter()
            .any(|mask| mask.enabled && matches!(mask.mask_type, MaskKind::Sensitive))
    })
}

pub(crate) fn project_guide(
    meta: &RecordingMeta,
    project: &ProjectConfiguration,
) -> cap_steps::Guide {
    let clips = clips(meta);
    guide(project, &clips, &Playback::new(project, &clips))
}

/// Actions are read on each clip's own clock and uncut pointer path, and
/// only then placed on the timeline: a clip's speed must not turn a
/// double-click into two clicks, and the pointer may have reached a click in
/// footage the timeline cut.
fn guide(project: &ProjectConfiguration, clips: &[Clip], playback: &Playback) -> cap_steps::Guide {
    let mut steps = Vec::new();
    for (index, clip) in clips.iter().enumerate() {
        let clip_index = index as u32;
        let on_clip = |time_ms: f64| time_ms / 1000.0 - clip.event_offset;
        let mut moves: Vec<PointerMove> = clip
            .cursor
            .moves
            .iter()
            .filter(|event| event.time_ms.is_finite() && event.x.is_finite() && event.y.is_finite())
            .map(|event| PointerMove {
                time: on_clip(event.time_ms),
                position: Point::new(event.x, event.y),
            })
            .collect();
        moves.sort_by(|a, b| a.time.total_cmp(&b.time));
        let buttons: Vec<ButtonEvent> = clip
            .cursor
            .clicks
            .iter()
            .map(|event| ButtonEvent {
                time: on_clip(event.time_ms),
                button: event.cursor_num,
                down: event.down,
            })
            .filter(|event| {
                !(event.down && pointer_at(&moves, event.time).is_some_and(outside_frame))
            })
            .collect();
        let events = ClipEvents {
            clip: clip_index,
            stopped_at: (index + 1 == clips.len())
                .then(|| source_length(clip))
                .filter(|length| *length > 0.0),
            moves: &moves,
            buttons: &buttons,
        };
        steps.extend(cap_steps::clip_steps(&events, |time| {
            playback.output_time(clip_index, time)
        }));
    }

    let mut markers: Vec<Marker> = project
        .markers
        .iter()
        .filter_map(|marker| {
            Some(Marker {
                time: playback.output_time(marker.recording_clip, marker.time)?,
                source: Source {
                    clip: marker.recording_clip,
                    time: marker.time,
                },
                label: marker.label.clone(),
            })
        })
        .collect();
    markers.sort_by(|a, b| a.time.total_cmp(&b.time));
    let words = project
        .timeline
        .as_ref()
        .map(caption_words)
        .unwrap_or_default();
    cap_steps::build_guide(steps, &markers, &words)
}

fn settle(
    shown: &mut ffmpeg::frame::Video,
    next: &mut ffmpeg::frame::Video,
    have_shown: &mut bool,
    target: i64,
) -> bool {
    let timestamp = next.timestamp().or_else(|| next.pts());
    if *have_shown && timestamp.is_some_and(|timestamp| timestamp > target) {
        return true;
    }
    std::mem::swap(shown, next);
    *have_shown = true;
    timestamp.is_none_or(|timestamp| timestamp >= target)
}

fn frame_at(path: &Path, seconds: f64) -> Result<(Size, Vec<u8>), String> {
    use ffmpeg::rescale::{Rescale, TIME_BASE};

    let mut track = ScreenTrack::open(path)?;
    let stream = track
        .input()
        .streams()
        .best(ffmpeg::media::Type::Video)
        .ok_or("No video stream found")?;
    let stream_index = stream.index();
    let time_base = stream.time_base();
    let stream_start = match stream.start_time() {
        ffmpeg::ffi::AV_NOPTS_VALUE => 0,
        timestamp => timestamp,
    };
    let target = ((seconds.max(0.0) * 1_000_000.0) as i64)
        .rescale((1, 1_000_000), time_base)
        .saturating_add(stream_start);
    let mut decoder = ffmpeg::codec::context::Context::from_parameters(stream.parameters())
        .map_err(|error| error.to_string())?
        .decoder()
        .video()
        .map_err(|error| error.to_string())?;
    if seconds > 0.0 {
        let position = target.rescale(time_base, TIME_BASE);
        track
            .seek(position)
            .map_err(|error| format!("Failed to seek to {seconds:.3}s: {error}"))?;
    }

    let mut shown = ffmpeg::frame::Video::empty();
    let mut next = ffmpeg::frame::Video::empty();
    let mut have_shown = false;
    let mut settled = false;
    while !settled {
        let Some(packet) = track
            .next_packet()
            .map_err(|error| format!("Failed to read {}: {error}", path.display()))?
        else {
            break;
        };
        if packet.stream() != stream_index || decoder.send_packet(&packet).is_err() {
            continue;
        }
        while !settled && decoder.receive_frame(&mut next).is_ok() {
            settled = settle(&mut shown, &mut next, &mut have_shown, target);
        }
    }
    if !settled && decoder.send_eof().is_ok() {
        while !settled && decoder.receive_frame(&mut next).is_ok() {
            settled = settle(&mut shown, &mut next, &mut have_shown, target);
        }
    }
    if !have_shown {
        return Err(format!("No frame at {seconds:.3}s in {}", path.display()));
    }

    let (width, height) = (shown.width(), shown.height());
    let mut scaler = ffmpeg::software::scaling::context::Context::get(
        shown.format(),
        width,
        height,
        ffmpeg::format::Pixel::RGBA,
        width,
        height,
        ffmpeg::software::scaling::flag::Flags::BILINEAR,
    )
    .map_err(|error| error.to_string())?;
    let mut rgba = ffmpeg::frame::Video::empty();
    scaler
        .run(&shown, &mut rgba)
        .map_err(|error| error.to_string())?;
    let stride = rgba.stride(0);
    let row_bytes = width as usize * 4;
    let data = rgba.data(0);
    let mut pixels = Vec::with_capacity(row_bytes * height as usize);
    for row in 0..height as usize {
        pixels.extend_from_slice(&data[row * stride..row * stride + row_bytes]);
    }
    Ok((Size { width, height }, pixels))
}

/// Blocking. The screenshots come from the screen track itself, not the
/// styled video, so they are sharp and carry no cursor but the ring. The
/// guide is written beside `folder` and moved in only once it is whole, so
/// a cancelled or failed export leaves an earlier guide there as it was.
pub(crate) fn export_steps(
    meta: &RecordingMeta,
    project: &ProjectConfiguration,
    title: &str,
    folder: &Path,
    captions: &Captions,
    cancel: &AtomicBool,
    progress: &(dyn Fn(usize, usize) + Send + Sync),
) -> Result<Vec<PathBuf>, StepsError> {
    let clips = clips(meta);
    let playback = Playback::new(project, &clips);
    let guide = guide(project, &clips, &playback);
    if guide.steps.is_empty() {
        return Err(StepsError::NoSteps);
    }
    if hides_areas(project) {
        return Err(StepsError::HiddenAreas);
    }
    let name = folder
        .file_name()
        .ok_or_else(|| StepsError::Failed("The guide needs a folder to be saved in".into()))?
        .to_string_lossy();
    let staging = folder.with_file_name(format!(".{name}.{}", crate::store::new_uuid_v4()));
    let output = Output {
        title,
        captions,
        cancel,
        progress,
    };
    let written = write_guide(&staging, &clips, &playback, guide, &output)
        .and_then(|names| publish(&staging, folder, &names).map_err(StepsError::Failed));
    let _ = std::fs::remove_dir_all(&staging);
    written
}

struct Output<'a> {
    title: &'a str,
    captions: &'a Captions,
    cancel: &'a AtomicBool,
    progress: &'a (dyn Fn(usize, usize) + Send + Sync),
}

fn write_guide(
    staging: &Path,
    clips: &[Clip],
    playback: &Playback,
    guide: cap_steps::Guide,
    output: &Output,
) -> Result<Vec<String>, StepsError> {
    let cancelled = || {
        if output.cancel.load(Ordering::Relaxed) {
            Err(StepsError::Cancelled)
        } else {
            Ok(())
        }
    };
    cancelled()?;
    std::fs::create_dir_all(staging.join(STEP_IMAGES_FOLDER))
        .map_err(|error| StepsError::Failed(error.to_string()))?;
    let total = guide.steps.len();
    let mut names = vec![GUIDE_FILE.to_string(), GUIDE_DATA_FILE.to_string()];
    let mut steps = Vec::with_capacity(total);
    for (index, step) in guide.steps.into_iter().enumerate() {
        cancelled()?;
        let image = format!(
            "{STEP_IMAGES_FOLDER}/{}",
            cap_steps::image_name(index + 1, total)
        );
        let Source { clip, time } = step.source;
        let shown = if playback.output_time(clip, step.frame_time).is_some() {
            step.frame_time
        } else {
            time
        };
        clips
            .get(clip as usize)
            .ok_or_else(|| format!("Step {} has no screen recording", index + 1))
            .and_then(|clip| frame_at(&clip.display, shown + clip.screen_offset))
            .and_then(|(size, rgba)| {
                cap_steps::render_step_image(&rgba, size, &step)
                    .ok_or_else(|| "The screen frame could not be read".to_string())
            })
            .and_then(|image| cap_steps::encode_png(&image))
            .and_then(|png| std::fs::write(staging.join(&image), png).map_err(|e| e.to_string()))
            .map_err(StepsError::Failed)?;
        names.push(image.clone());
        steps.push(DocumentStep { step, image });
        (output.progress)(index + 1, total);
    }
    cancelled()?;

    let document = Document {
        title: output.title.to_string(),
        duration: playback.duration(),
        intro: guide.intro,
        steps,
    };
    std::fs::write(
        staging.join(GUIDE_FILE),
        cap_steps::markdown(&document, output.captions),
    )
    .and_then(|()| std::fs::write(staging.join(GUIDE_DATA_FILE), cap_steps::json(&document)))
    .map_err(|error| StepsError::Failed(error.to_string()))?;
    Ok(names)
}

fn publish(staging: &Path, folder: &Path, names: &[String]) -> Result<Vec<PathBuf>, String> {
    if folder.exists() {
        replace_guide(staging, folder, names)?;
    } else {
        std::fs::rename(staging, folder).map_err(|e| e.to_string())?;
    }
    Ok(names.iter().map(|name| folder.join(name)).collect())
}

/// `guide.json` is read back from a folder the user owns and may have been
/// edited, so what it lists counts only under a name an export gives its
/// screenshots, directly inside the screenshots folder.
fn earlier_screenshots(folder: &Path) -> Vec<String> {
    let screenshots = format!("{STEP_IMAGES_FOLDER}/");
    std::fs::read_to_string(folder.join(GUIDE_DATA_FILE))
        .map(|data| cap_steps::listed_images(&data))
        .unwrap_or_default()
        .into_iter()
        .filter(|image| {
            image
                .strip_prefix(&screenshots)
                .is_some_and(cap_steps::is_image_name)
        })
        .collect()
}

fn retire(file: &Path, retired: &Path) -> std::io::Result<bool> {
    match std::fs::symlink_metadata(file) {
        Ok(found) if found.is_dir() => Err(std::io::Error::new(
            std::io::ErrorKind::IsADirectory,
            format!("{} is a folder", file.display()),
        )),
        Ok(_) => std::fs::rename(file, retired).map(|()| true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error),
    }
}

/// The folder is one the user picked, and it and its screenshots folder may
/// hold other files. Only the guide's own files are swapped: the ones this
/// export writes, and the screenshots the earlier guide's `guide.json`
/// lists. The files they replace wait in `retired` until every new one is
/// in. `retired` is deleted with its contents only after that, so a file
/// that could not be put back after a failed swap is still there.
fn replace_guide(staging: &Path, folder: &Path, names: &[String]) -> Result<(), String> {
    let mut retired = staging.as_os_str().to_owned();
    retired.push(".replaced");
    let retired = PathBuf::from(retired);

    let mut outgoing = names.to_vec();
    for image in earlier_screenshots(folder) {
        if !outgoing.contains(&image) {
            outgoing.push(image);
        }
    }
    let screenshots = folder.join(STEP_IMAGES_FOLDER);
    let made_screenshots_folder = !screenshots.exists();

    let mut moved_out = Vec::new();
    let mut moved_in = Vec::new();
    let swapped = std::fs::create_dir_all(retired.join(STEP_IMAGES_FOLDER))
        .and_then(|()| {
            outgoing.iter().try_for_each(|name| {
                if retire(&folder.join(name), &retired.join(name))? {
                    moved_out.push(name);
                }
                Ok(())
            })
        })
        .and_then(|()| std::fs::create_dir_all(&screenshots))
        .and_then(|()| {
            names.iter().try_for_each(|name| {
                std::fs::rename(staging.join(name), folder.join(name))?;
                moved_in.push(name);
                Ok(())
            })
        });
    let Err(error) = swapped else {
        let _ = std::fs::remove_dir_all(&retired);
        return Ok(());
    };

    for name in moved_in {
        let _ = std::fs::rename(folder.join(name), staging.join(name));
    }
    let mut stranded = false;
    for name in moved_out {
        stranded |= std::fs::rename(retired.join(name), folder.join(name)).is_err();
    }
    if made_screenshots_folder {
        let _ = std::fs::remove_dir(&screenshots);
    }
    let _ = std::fs::remove_dir(retired.join(STEP_IMAGES_FOLDER));
    let _ = std::fs::remove_dir(&retired);
    Err(if stranded {
        format!(
            "{error}. The earlier guide was moved to {}",
            retired.display()
        )
    } else {
        error.to_string()
    })
}

#[cfg(test)]
mod tests;
