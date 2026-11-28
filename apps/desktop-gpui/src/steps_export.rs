use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

use cap_project::{
    CursorEvents, ProjectConfiguration, RecordingMeta, StudioRecordingMeta, TimelineConfiguration,
};
use cap_steps::{
    ButtonEvent, Captions, Document, DocumentStep, Marker, Point, PointerMove, Recording, Size,
    Word,
};

pub(crate) const GUIDE_FILE: &str = "guide.md";
pub(crate) const GUIDE_DATA_FILE: &str = "guide.json";
pub(crate) const STEP_IMAGES_FOLDER: &str = "steps";

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum StepsError {
    NoSteps,
    Cancelled,
    Failed(String),
}

const STOP_CLICK_WINDOW: f64 = 1.0;
const OUTSIDE_FRAME: f64 = 0.001;
const MAX_FRAME_LEAD: f64 = 1.0;

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

fn media_duration(path: &Path) -> f64 {
    ffmpeg::format::input(path)
        .map(|input| input.duration().max(0) as f64 / f64::from(ffmpeg::ffi::AV_TIME_BASE))
        .unwrap_or(0.0)
}

fn source_length(clip: &Clip) -> f64 {
    (media_duration(&clip.display) - clip.screen_offset).max(0.0)
}

fn pointer_at(path: &[(f64, Point)], time: f64) -> Option<Point> {
    let after = path.partition_point(|(moved, _)| *moved <= time);
    path.get(after.saturating_sub(1))
        .map(|(_, position)| *position)
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

    fn source(&self, output_time: f64) -> Option<(u32, f64)> {
        match self {
            Self::Edited(timeline) => timeline.source_for_output_time(output_time),
            Self::BackToBack(spans) => spans
                .iter()
                .enumerate()
                .rfind(|(_, (start, _))| *start <= output_time)
                .map(|(index, (start, length))| (index as u32, (output_time - start).min(*length))),
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

#[cfg(test)]
pub(crate) fn recording_events(
    meta: &RecordingMeta,
    project: &ProjectConfiguration,
) -> Result<Recording, String> {
    let clips = clips(meta);
    Ok(events(project, &clips, &Playback::new(project, &clips)).0)
}

pub(crate) fn project_guide(
    meta: &RecordingMeta,
    project: &ProjectConfiguration,
) -> cap_steps::Guide {
    let clips = clips(meta);
    guide(project, &clips, &Playback::new(project, &clips)).1
}

/// The guide and the duration of the video it follows. The stop click is
/// already gone from the events (judged against the recording itself), so
/// the guide is built without a duration: an end the timeline trimmed would
/// otherwise cost a real click its step.
fn guide(
    project: &ProjectConfiguration,
    clips: &[Clip],
    playback: &Playback,
) -> (f64, cap_steps::Guide) {
    let (mut recording, anchors) = events(project, clips, playback);
    let duration = std::mem::replace(&mut recording.duration, f64::INFINITY);
    recording.moves.extend(anchors);
    (duration, cap_steps::build_guide(&recording))
}

/// Returns the events and, for every button event, where the pointer was:
/// a click is placed from the uncut pointer path, because the pointer may
/// have reached it in footage the timeline cut.
fn events(
    project: &ProjectConfiguration,
    clips: &[Clip],
    playback: &Playback,
) -> (Recording, Vec<PointerMove>) {
    let mut recording = Recording {
        duration: playback.duration(),
        ..Recording::default()
    };
    let mut anchors = Vec::new();
    for (index, clip) in clips.iter().enumerate() {
        let clip_index = index as u32;
        let source_time = |time_ms: f64| time_ms / 1000.0 - clip.event_offset;
        let mut path: Vec<(f64, Point)> = clip
            .cursor
            .moves
            .iter()
            .filter(|event| event.time_ms.is_finite() && event.x.is_finite() && event.y.is_finite())
            .map(|event| (source_time(event.time_ms), Point::new(event.x, event.y)))
            .collect();
        path.sort_by(|a, b| a.0.total_cmp(&b.0));
        let last_press = if index + 1 == clips.len() {
            Some(source_length(clip))
                .filter(|length| *length > 0.0)
                .map_or(f64::INFINITY, |length| length - STOP_CLICK_WINDOW)
        } else {
            f64::INFINITY
        };

        recording
            .moves
            .extend(path.iter().filter_map(|&(time, position)| {
                Some(PointerMove {
                    time: playback.output_time(clip_index, time)?,
                    position,
                })
            }));
        for event in &clip.cursor.clicks {
            let time = source_time(event.time_ms);
            let position = pointer_at(&path, time);
            if event.down && (time > last_press || position.is_some_and(outside_frame)) {
                continue;
            }
            let Some(time) = playback.output_time(clip_index, time) else {
                continue;
            };
            recording.buttons.push(ButtonEvent {
                time,
                button: event.cursor_num,
                down: event.down,
            });
            anchors.extend(position.map(|position| PointerMove { time, position }));
        }
    }
    recording.moves.sort_by(|a, b| a.time.total_cmp(&b.time));
    recording.buttons.sort_by(|a, b| a.time.total_cmp(&b.time));

    recording.markers = project
        .markers
        .iter()
        .filter_map(|marker| {
            Some(Marker {
                time: playback.output_time(marker.recording_clip, marker.time)?,
                label: marker.label.clone(),
            })
        })
        .collect();
    recording.markers.sort_by(|a, b| a.time.total_cmp(&b.time));
    if let Some(timeline) = &project.timeline {
        recording.words = caption_words(timeline);
    }
    (recording, anchors)
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

    let mut input = ffmpeg::format::input(path).map_err(|error| error.to_string())?;
    let stream = input
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
        input
            .seek(position, ..position)
            .map_err(|error| format!("Failed to seek to {seconds:.3}s: {error}"))?;
    }

    let mut shown = ffmpeg::frame::Video::empty();
    let mut next = ffmpeg::frame::Video::empty();
    let mut have_shown = false;
    let mut settled = false;
    for (stream, packet) in input.packets() {
        if stream.index() != stream_index || decoder.send_packet(&packet).is_err() {
            continue;
        }
        while !settled && decoder.receive_frame(&mut next).is_ok() {
            settled = settle(&mut shown, &mut next, &mut have_shown, target);
        }
        if settled {
            break;
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
/// a cancelled or failed export leaves an earlier guide there untouched.
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
    let (duration, guide) = guide(project, &clips, &playback);
    if guide.steps.is_empty() {
        return Err(StepsError::NoSteps);
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
    let written = write_guide(&staging, &clips, &playback, guide, duration, &output)
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
    duration: f64,
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
        let pressed = playback.source(step.time);
        playback
            .source(step.frame_time)
            .filter(|(clip, time)| {
                pressed.is_none_or(|(pressed_clip, pressed_time)| {
                    *clip == pressed_clip && (0.0..=MAX_FRAME_LEAD).contains(&(pressed_time - time))
                })
            })
            .or(pressed)
            .and_then(|(clip, time)| Some((clips.get(clip as usize)?, time)))
            .ok_or_else(|| format!("Step {} is not on the timeline", index + 1))
            .and_then(|(clip, time)| frame_at(&clip.display, time + clip.screen_offset))
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
        duration,
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
        std::fs::create_dir_all(folder.join(STEP_IMAGES_FOLDER)).map_err(|e| e.to_string())?;
        for name in names {
            std::fs::rename(staging.join(name), folder.join(name)).map_err(|e| e.to_string())?;
        }
    } else {
        std::fs::rename(staging, folder).map_err(|e| e.to_string())?;
    }
    Ok(names.iter().map(|name| folder.join(name)).collect())
}

#[cfg(test)]
mod tests;
