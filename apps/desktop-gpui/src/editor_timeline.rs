//! The editor timeline -- `routes/editor/Timeline/` at 1:1, read-only.
//!
//! E1 drew two locked tracks and a playhead; E2 made the playhead live. This
//! unit is the real strip: a **view state** (`transform.zoom` / `.position`
//! with the source's clamps, the wheel and pinch paths, `Cmd+=` / `Cmd+-`, the
//! transport's zoom buttons and slider), a **ruler** at its real resolution
//! ladder, **every one of the nine track types** rendered from the project's
//! own `TimelineConfiguration`, the **minimap**, the **edge fade**, and the
//! **hover ghost playhead** that follows `previewTime`.
//!
//! Everything that *mutates* the project -- drag, trim, split, selection,
//! create-by-drag, delete -- lives in [`crate::editor_edits`] and the window's
//! pointer handlers. This file draws; it never writes a config. What E4 added
//! here is only what the picture needs: the selected border, the handles'
//! hover reveal and the split-mode cursor, all through [`SegmentUi`].
//!
//! Three things about this file are worth knowing before reading it:
//!
//! * **Two time domains.** Clip segments live in gapless *recording-flow* time
//!   and every other track lives in *output* time. A fullscreen text segment
//!   pauses the recording clock, so the clip track converts on render
//!   ([`clip_rows`], `TL/ClipTrack.tsx:636-655`) using the hold windows Rust
//!   already computes (`TimelineConfiguration::hold_windows`).
//! * **`timelineBounds` is the clip track's own box, not the container's.**
//!   `<ClipTrack ref={setTimelineRef}>` (`TL/index.tsx:1336`) measures the row
//!   *inside* the scroll body, which carries `pr-1`
//!   (`TL/index.tsx:1326`). Every `secsPerPixel` in the timeline divides by
//!   that width, so it is four pixels narrower than the header strip the
//!   ruler draws into. [`content_width`] carries the 4; E2's version did not.
//! * **The label anchors to the *visible* slice of a segment, not its centre.**
//!   A segment wider than the viewport has its true centre off screen, so
//!   [`visible_box`] clamps it (`useSegmentVisibleBox`, `TL/Track.tsx:147-181`).

use std::sync::Arc;

use cap_project::{
    Camera3DSegment, CaptionTrackSegment, MaskKind, ProjectConfiguration, SceneMode, TextLayout,
    TimelineConfiguration, ZoomMode,
};
use gpui::{
    AnyElement, FontWeight, Hsla, IntoElement, ParentElement, Pixels, SharedString, Styled, div,
    prelude::FluentBuilder, px, svg,
};

use crate::{editor_edits::Selection, theme::Theme};

// ---------------------------------------------------------------------------
// Layout constants (`TL/index.tsx:62-68`)
// ---------------------------------------------------------------------------

pub const TIMELINE_PADDING: f32 = 16.;
pub const TRACK_GUTTER_GAP: f32 = 8.;
pub const TRACK_GUTTER: f32 = 112.;
pub const TRACK_ICON_WIDTH: f32 = TRACK_GUTTER - TRACK_GUTTER_GAP;
pub const TIMELINE_HEADER_HEIGHT: f32 = 32.;
pub const PLAYHEAD_TOP_OFFSET: f32 = 24.;
/// The snap-to-zero zone at the timeline's origin (`TL/index.tsx:68, 826`).
pub const START_SNAP_PX: f64 = 10.;

/// `px-2` on the timeline slot (`Editor.tsx:781`) -- the container's own left
/// edge in window coordinates.
pub const TIMELINE_SLOT_PADDING: f32 = 8.;
/// `pt-8` on the timeline container (`TL/index.tsx:1149`).
pub const TIMELINE_TOP_PADDING: f32 = 32.;
/// `pr-1` on the scroll body (`TL/index.tsx:1326`). The clip track -- which is
/// what `timelineBounds` measures -- sits inside it, so every `secsPerPixel` in
/// the timeline is computed over a column four pixels narrower than the ruler's.
pub const SCROLL_BODY_PADDING_RIGHT: f32 = 4.;

/// `visibleTrackCount() > 2 ? "3rem" : "3.25rem"` (`TL/index.tsx:268-270`).
pub const TRACK_HEIGHT_COMPACT: f32 = 48.;
pub const TRACK_HEIGHT_ROOMY: f32 = 52.;
/// `gap-2` between rows (`TL/index.tsx:1333`) and between gutter and content
/// (`TL/index.tsx:1516`).
pub const TRACK_ROW_GAP: f32 = 8.;

/// `SEGMENT_RENDER_PADDING` (`TL/context.ts:14`) -- seconds of slack either
/// side of the viewport before a segment stops being rendered at all.
const SEGMENT_RENDER_PADDING: f64 = 2.;

/// `MAX_TIMELINE_MARKINGS` (`TL/context.ts:11`).
const MAX_TIMELINE_MARKINGS: f64 = 20.;
/// `TIMELINE_MARKING_RESOLUTIONS` (`TL/context.ts:12`).
const TIMELINE_MARKING_RESOLUTIONS: [f64; 6] = [0.5, 1.0, 2.5, 5.0, 10.0, 30.0];

/// `SEGMENT_LABEL_FULL_PX` / `SEGMENT_LABEL_COMPACT_PX` (`TL/Track.tsx:140-141`),
/// and the glyph tier's own floor (`TL/Track.tsx:214`).
const SEGMENT_LABEL_FULL_PX: f64 = 100.;
const SEGMENT_LABEL_COMPACT_PX: f64 = 48.;
const SEGMENT_LABEL_GLYPH_PX: f64 = 16.;
/// Captions, keyboard and audio override the compact tier (`TL/CaptionsTrack.tsx:269`,
/// `TL/KeyboardTrack.tsx:261`, `TL/AudioTrack.tsx:533`).
const SEGMENT_LABEL_COMPACT_TIGHT_PX: f64 = 24.;

/// `MIN_NEW_SEGMENT_PIXEL_WIDTH` / `MIN_NEW_SEGMENT_SECS_WIDTH`
/// (`TL/ZoomTrack.tsx:36-37`), the zoom track's hover-ghost size -- and, since
/// the ghost is where a click puts a segment, the created segment's size too.
pub const MIN_NEW_SEGMENT_PIXEL_WIDTH: f64 = 80.;
pub const MIN_NEW_SEGMENT_SECS_WIDTH: f64 = 1.;

/// `newSegmentMinDuration()` (`TL/ZoomTrack.tsx:96-100`).
pub fn new_segment_min_duration(secs_per_pixel: f64) -> f64 {
    (MIN_NEW_SEGMENT_PIXEL_WIDTH * secs_per_pixel).max(MIN_NEW_SEGMENT_SECS_WIDTH)
}

/// The minimap's floor and its 12px strip (`TL/Minimap.tsx:9`, `TL/index.tsx:1209-1216`).
const MINIMAP_MIN_CHIP_WIDTH: f32 = 20.;
pub const MINIMAP_HEIGHT: f32 = 12.;
pub const MINIMAP_TOP: f32 = 2.;

/// The edge fade (`TL/index.tsx:1103-1106`).
const FADE_WIDTH: f32 = 32.;
const FADE_RAMP_PX: f64 = 50.;

// ---------------------------------------------------------------------------
// Colours
// ---------------------------------------------------------------------------

/// The single source of truth for track colour is nine CSS custom properties
/// with one definition each -- not per-appearance values -- so they are literal
/// in both themes exactly as they are there
/// (`apps/desktop/src/styles/theme.css:24-34`):
///
/// ```css
/// --track-clip:     #3f8ae0;   --track-zoom:     #4a4f5c;   --track-caption:  #6f747d;
/// --track-keyboard: #d4742c;   --track-text:     #2898ac;   --track-mask:     #d2444b;
/// --track-scene:    #975cfa;   --track-audio:    var(--jade-9);  --track-3d:   #7c6ff0;
/// ```
///
/// `--jade-9` is `#29a383` in both `jade.css` and `jade-dark.css` (Radix keeps
/// step 9 constant across the two), so it is a literal here too.
pub mod track_color {
    pub const CLIP: u32 = 0x3f8ae0;
    pub const ZOOM: u32 = 0x4a4f5c;
    pub const CAPTION: u32 = 0x6f747d;
    pub const KEYBOARD: u32 = 0xd4742c;
    pub const TEXT: u32 = 0x2898ac;
    pub const MASK: u32 = 0xd2444b;
    pub const SCENE: u32 = 0x975cfa;
    /// `var(--jade-9)`.
    pub const AUDIO: u32 = 0x29a383;
    pub const THREE_D: u32 = 0x7c6ff0;
}

/// `.cap-track-fill { background: var(--seg-color); border: 1px solid
/// color-mix(in srgb, var(--seg-color) 58%, black) }` (`TL/styles.css:23-26`).
pub fn track_fill_border(color: Hsla) -> Hsla {
    let rgba = gpui::Rgba::from(color);
    gpui::Rgba {
        r: rgba.r * 0.58,
        g: rgba.g * 0.58,
        b: rgba.b * 0.58,
        a: rgba.a,
    }
    .into()
}

/// The playhead's `from-[rgb(226,64,64)]` (`TL/index.tsx:1281`).
pub fn playhead_color() -> Hsla {
    gpui::rgb(0xe24040).into()
}

/// `bg-linear-to-b to-120% from-<color>`: the gradient runs from the colour at
/// 0 % to fully transparent at **120 %** of the box, so at the bottom edge it
/// still carries 1 - 1/1.2 = 1/6 of its alpha. gpui takes two stops, which is
/// exactly what this needs once the 120 % is folded into the end alpha.
fn playhead_gradient(color: Hsla) -> gpui::Background {
    let mut faded = color;
    faded.a = color.a / 6.;
    gpui::linear_gradient(
        180.,
        gpui::linear_color_stop(color, 0.),
        gpui::linear_color_stop(faded, 1.),
    )
}

fn with_alpha(color: Hsla, alpha: f32) -> Hsla {
    Hsla { a: alpha, ..color }
}

/// `--text-tertiary` (`theme.css:58, 122`), the three empty tracks' copy
/// colour: `rgba(18, 22, 31, 0.65)` in light, `rgba(255, 255, 255, 0.65)` in
/// dark. `Theme` carries `--text-primary` but not this one, so it is spelled
/// out where it is used rather than growing the token set for one caller.
fn text_tertiary(theme: &Theme) -> Hsla {
    if theme.is_dark() {
        with_alpha(gpui::white(), 0.65)
    } else {
        with_alpha(gpui::rgb(0x12161f).into(), 0.65)
    }
}

// ---------------------------------------------------------------------------
// The transform -- `transform.zoom` / `transform.position`
// ---------------------------------------------------------------------------

/// `MAX_ZOOM_IN = 3` seconds visible (`ED/context.ts:184`).
pub const MAX_ZOOM_IN: f64 = 3.;
/// `zoomOutLimit() = Math.min(totalDuration(), 60 * 10)` (`ED/context.ts:1387`).
pub fn zoom_out_limit(total_duration: f64) -> f64 {
    total_duration.min(600.)
}

/// The timeline's viewport: how many seconds are visible, and which second is
/// at the left edge (`ED/context.ts:1453-1487`).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Transform {
    /// Visible seconds.
    pub zoom: f64,
    /// Seconds at the leftmost point.
    pub position: f64,
}

impl Default for Transform {
    fn default() -> Self {
        Self {
            zoom: 0.,
            position: 0.,
        }
    }
}

impl Transform {
    /// The initial state: `zoom: zoomOutLimit()`, `position: 0`
    /// (`ED/context.ts:1455, 1474`).
    pub fn initial(total_duration: f64) -> Self {
        Self {
            zoom: zoom_out_limit(total_duration),
            position: 0.,
        }
    }

    /// `secsPerPixel = transform.zoom / timelineBounds.width`
    /// (`TL/index.tsx:189`, `TL/context.ts:91-92`).
    /// Floored at the smallest positive double so a transform with no project
    /// behind it yet (`zoom: 0`) divides to zero rather than to `NaN` -- a
    /// `NaN` reaching `px()` poisons the whole layout pass.
    pub fn secs_per_pixel(&self, content_width: f32) -> f64 {
        (self.zoom / (content_width.max(1.) as f64)).max(f64::MIN_POSITIVE)
    }

    /// `setPosition` (`ED/context.ts:1475-1487`): clamped to
    /// `[0, max(zoomOutLimit, totalDuration) + 4 - zoom]`, where `zoom` is
    /// whatever the transform carries *now* -- which is why `update_zoom`
    /// writes the zoom before it calls this.
    pub fn set_position(&mut self, position: f64, total_duration: f64) {
        let upper = zoom_out_limit(total_duration).max(total_duration) + 4. - self.zoom;
        self.position = position.max(0.).min(upper);
    }

    /// `updateZoom(newZoom, origin)` (`ED/context.ts:1389-1403, 1456-1472`):
    /// clamp the zoom into `[MAX_ZOOM_IN, zoomOutLimit]`, then move the
    /// position so `origin` stays at the same fraction across the viewport.
    ///
    /// The clamp is `Math.max(Math.min(newZoom, zoomOutLimit()), MAX_ZOOM_IN)`
    /// in that order, so on a project shorter than 3 s the *floor* wins and the
    /// viewport is allowed to show more than the whole timeline.
    pub fn update_zoom(&mut self, new_zoom: f64, origin: f64, total_duration: f64) {
        let zoom = new_zoom.min(zoom_out_limit(total_duration)).max(MAX_ZOOM_IN);

        let visible_origin = origin - self.position;
        let origin_percentage = (visible_origin / self.zoom).min(1.);
        let new_visible_origin = zoom * origin_percentage;
        let new_position = origin - new_visible_origin;

        self.zoom = zoom;
        self.set_position(new_position, total_duration);
    }

    /// The transport slider's value: `min(max(1 - zoom / zoomOutLimit, 0), 1)`
    /// (`Player.tsx:450-457`). Fully left is fully zoomed out.
    pub fn slider_fraction(&self, total_duration: f64) -> f32 {
        let limit = zoom_out_limit(total_duration);
        if limit <= 0. {
            return 0.;
        }
        ((1. - self.zoom / limit).clamp(0., 1.)) as f32
    }

    /// The inverse: `updateZoom((1 - v) * zoomOutLimit(), playbackTime)`
    /// (`Player.tsx:458-463`).
    pub fn apply_slider(&mut self, fraction: f32, origin: f64, total_duration: f64) {
        self.update_zoom(
            (1. - fraction as f64) * zoom_out_limit(total_duration),
            origin,
            total_duration,
        );
    }

    /// The on-mount clamp: a project whose whole duration fits in fewer than
    /// 80 px per second is zoomed in until it does not
    /// (`TL/index.tsx:689-703`). `desiredZoom = timelineBounds.width / 80`.
    pub fn fit_on_mount(&mut self, content_width: f32, total_duration: f64) {
        if content_width <= 0. {
            return;
        }
        let desired = content_width as f64 / 80.;
        if self.zoom > desired {
            self.update_zoom(desired, 0., total_duration);
        }
    }

    /// `visibleTimeRange` (`TL/context.ts:57-63`).
    fn visible_range(&self) -> (f64, f64) {
        (
            (self.position - SEGMENT_RENDER_PADDING).max(0.),
            self.position + self.zoom + SEGMENT_RENDER_PADDING,
        )
    }

    /// `isSegmentVisible` (`TL/context.ts:65-68`).
    fn segment_visible(&self, start: f64, end: f64) -> bool {
        let (range_start, range_end) = self.visible_range();
        end >= range_start && start <= range_end
    }
}

// ---------------------------------------------------------------------------
// Geometry the window and the transform share
// ---------------------------------------------------------------------------

/// `timelineBounds.width`, which every `secsPerPixel` divides by: the window,
/// less the timeline slot's `px-2`, less the container's own 16px padding on
/// each side, less the scroll body's `pr-1`, less the 112px icon gutter.
pub fn content_width(viewport_width: f32) -> f32 {
    (viewport_width
        - TIMELINE_SLOT_PADDING * 2.
        - TIMELINE_PADDING * 2.
        - SCROLL_BODY_PADDING_RIGHT
        - TRACK_GUTTER)
        .max(1.)
}

/// The **ruler's** own strip width. `TimelineMarkings` lives in the 32px header
/// (`TL/index.tsx:1220-1226`), which is outside the scroll body, so it is the
/// four pixels of `pr-1` wider than [`content_width`] -- while still being
/// scaled by the clip track's `secsPerPixel`. Ticks therefore line up with the
/// tracks and the strip simply has four pixels of slack at its right edge.
pub fn ruler_width(viewport_width: f32) -> f32 {
    (viewport_width - TIMELINE_SLOT_PADDING * 2. - TIMELINE_PADDING * 2. - TRACK_GUTTER).max(1.)
}

/// The window x of the track content column's left edge --
/// `rect.left + TIMELINE_PADDING + TRACK_GUTTER` in `getTimelineContentMetrics`
/// (`TL/index.tsx:803-816`), where `rect` is the timeline container, itself
/// inset by the slot's `px-2`.
pub fn content_left() -> f32 {
    TIMELINE_SLOT_PADDING + TIMELINE_PADDING + TRACK_GUTTER
}

/// `timelineTimeFromClientX` (`TL/index.tsx:818-828`), verbatim including the
/// snap-to-zero zone and the clamp to `[0, totalDuration]`.
pub fn time_from_x(x: f32, viewport_width: f32, transform: Transform, total: f64) -> f64 {
    let secs_per_pixel = transform.secs_per_pixel(content_width(viewport_width));
    let raw = secs_per_pixel * (x - content_left()) as f64 + transform.position;
    let snapped = if raw / secs_per_pixel <= START_SNAP_PX {
        0.0
    } else {
        raw
    };
    snapped.clamp(0.0, total.max(0.0))
}

/// The hover time the container's `onMouseMove` publishes as `previewTime`
/// (`TL/index.tsx:1170-1184`). It is **not** `timelineTimeFromClientX`: the
/// pointer outside the content column clears the preview rather than clamping,
/// and there is no upper clamp to `totalDuration` -- only the same
/// snap-to-zero.
pub fn preview_time_from_x(x: f32, viewport_width: f32, transform: Transform) -> Option<f64> {
    let width = content_width(viewport_width);
    let offset_x = (x - content_left()) as f64;
    if offset_x < 0. || offset_x > width as f64 {
        return None;
    }
    let secs_per_pixel = transform.secs_per_pixel(width);
    let hover = transform.position + secs_per_pixel * offset_x;
    Some(if hover / secs_per_pixel <= START_SNAP_PX {
        0.
    } else {
        hover
    })
}

/// `markingResolution` (`TL/context.ts:50-55`): the first of
/// `[0.5, 1, 2.5, 5, 10, 30]` whose `zoom / r <= MAX_TIMELINE_MARKINGS (20)`,
/// else 30.
pub fn marking_resolution(zoom: f64) -> f64 {
    for candidate in TIMELINE_MARKING_RESOLUTIONS {
        if zoom / candidate <= MAX_TIMELINE_MARKINGS {
            return candidate;
        }
    }
    30.0
}

/// `formatTime` (`routes/editor/utils.ts:1-13`) -- `M:SS`, which is both the
/// transport clock and the **ruler's** label (`TL/index.tsx:48, 1597`).
pub fn format_time(seconds: f64) -> String {
    let seconds = seconds.max(0.0);
    let minutes = (seconds / 60.0).floor() as u64;
    let secs = (seconds % 60.0).floor() as u64;
    format!("{minutes}:{secs:02}")
}

/// The *other* `formatTime`, the clip track's own (`TL/ClipTrack.tsx:129-141`):
/// `Nh Nm Ns` / `Nm Ns` / `Ns`.
pub fn format_clip_time(seconds: f64) -> String {
    let seconds = seconds.max(0.0);
    let hours = (seconds / 3600.0).floor() as u64;
    let minutes = ((seconds % 3600.0) / 60.0).floor() as u64;
    let secs = (seconds % 60.0).floor() as u64;
    if hours > 0 {
        format!("{hours}h {minutes}m {secs}s")
    } else if minutes > 0 {
        format!("{minutes}m {secs}s")
    } else {
        format!("{secs}s")
    }
}

/// `useSegmentVisibleBox` (`TL/Track.tsx:147-181`): the pixel box of a
/// segment's intersection with the viewport, in segment-local coordinates,
/// with the centre clamped so a label never leaves the screen.
fn visible_box(start: f64, end: f64, transform: Transform, secs_per_pixel: f64) -> (f64, f64) {
    let segment_width = (end - start) / secs_per_pixel;
    let left_px = (start - transform.position) / secs_per_pixel;
    let viewport_px = transform.zoom / secs_per_pixel;

    let visible_start = (-left_px).max(0.);
    let visible_end = segment_width.min(viewport_px - left_px);
    let visible_width = (visible_end - visible_start).max(0.);

    let margin = 60f64
        .min(segment_width / 2.)
        .min((visible_width / 2.).max(4.));
    let center_x = ((visible_start + visible_end) / 2.)
        .max(margin)
        .min(segment_width - margin);

    (visible_width, center_x)
}

// ---------------------------------------------------------------------------
// Waveform peaks
// ---------------------------------------------------------------------------

/// `AudioData::SAMPLE_RATE` (`crates/audio/src/audio_data.rs:20`). Spelled out
/// rather than imported because `cap-audio` is not a direct dependency here --
/// the decoded track arrives through `cap_editor::AudioLoader`, and its
/// inherent methods are all this needs.
const AUDIO_SAMPLE_RATE: usize = 48_000;

/// `get_waveform` (`apps/desktop/src-tauri/src/audio.rs:42-73`), transcribed:
/// one absolute-dBFS value per ~100 ms chunk of the decoded track, with digital
/// silence pinned to -60 dBFS rather than -inf.
///
/// It lives in the Tauri *app*, not in a crate, which is the only reason it is
/// copied here rather than called. The data path itself needs nothing new:
/// `EditorInstance::segment_medias[i].audio` is an `AudioLoader` whose `get()`
/// resolves once the background decode finishes, exactly as
/// `get_mic_waveforms` (`lib.rs:4395-4412`) awaits it.
pub fn waveform_peaks(samples: &[f32], channels: u16) -> Vec<f32> {
    const CHUNK_SIZE: usize = AUDIO_SAMPLE_RATE / 10; // ~100ms

    let channels = (channels as usize).max(1);
    let mut waveform = Vec::new();

    let mut i = 0;
    while i < samples.len() {
        let end = (i + CHUNK_SIZE * channels).min(samples.len());
        let mut sum = 0.0f32;
        for s in &samples[i..end] {
            sum += s.abs();
        }
        let avg = if end > i {
            sum / (end - i) as f32
        } else {
            0.0
        };
        waveform.push(avg);
        i += CHUNK_SIZE * channels;
    }

    for v in waveform.iter_mut() {
        *v = if *v > 0.0 { 20.0 * v.log10() } else { -60.0 };
    }

    waveform
}

/// `WAVEFORM_MIN_DB` / `WAVEFORM_SAMPLE_STEP` / `WAVEFORM_MUTE_DB`
/// (`TL/ClipTrack.tsx:49-54`).
const WAVEFORM_MIN_DB: f64 = -60.;
const WAVEFORM_SAMPLE_STEP: f64 = 0.1;
const WAVEFORM_CONTROL_STEP: f64 = 0.05;
const WAVEFORM_PADDING_SECONDS: f64 = 0.3;
const WAVEFORM_MUTE_DB: f64 = -30.;
const MAX_WAVEFORM_SAMPLES: usize = 6000;
/// `SAMPLES_PER_PIXEL` (`TL/ClipTrack.tsx:144`).
const WAVEFORM_SAMPLES_PER_PIXEL: f64 = 2.;

/// `gainToScale` (`TL/ClipTrack.tsx:57-62`): a track muted to -30 dB or below
/// draws nothing, and anything above scales the waveform's height linearly.
pub fn gain_to_scale(gain_db: f64) -> f64 {
    if !gain_db.is_finite() {
        return 1.;
    }
    if gain_db <= WAVEFORM_MUTE_DB {
        return 0.;
    }
    ((gain_db - WAVEFORM_MUTE_DB) / -WAVEFORM_MUTE_DB).max(0.)
}

/// `amplitudeAt` (`TL/ClipTrack.tsx:93-105`): the peak table is indexed at
/// 10 Hz, and a dBFS value becomes a 0..1 height against the -60 dB floor.
fn waveform_amplitude(peaks: &[f32], source_time: Option<f64>) -> f64 {
    let Some(time) = source_time else { return 0. };
    let index = (time * 10.).floor();
    let sample = if index < 0. {
        None
    } else {
        peaks.get(index as usize).copied()
    };
    let db = match sample {
        Some(value) if value.is_finite() => value as f64,
        _ => WAVEFORM_MIN_DB,
    };
    let clamped = db.max(WAVEFORM_MIN_DB);
    (1. + clamped / -WAVEFORM_MIN_DB).clamp(0., 1.)
}

/// `createWaveformPath` (`TL/ClipTrack.tsx:69-127`) in absolute pixels.
///
/// The source builds the path in a 0..1 unit box and lets the 2D context scale
/// it by `(canvasWidth, canvasHeight * scale)` after translating down by
/// `canvasHeight * (1 - scale)` (`:285-290`); gpui has no path transform on
/// `paint_path`, so the same maths is applied to each point as it is emitted.
/// The curve, the sample count and the closing segment are otherwise the
/// source's, cubic-bezier control points included.
#[allow(clippy::too_many_arguments)]
pub fn waveform_path(
    peaks: &[f32],
    range: (f64, f64),
    target_samples: usize,
    holds: &[(f64, f64)],
    segment_start: f64,
    origin: gpui::Point<Pixels>,
    size: gpui::Size<Pixels>,
    scale: f64,
) -> Option<gpui::Path<Pixels>> {
    if peaks.is_empty() || scale <= 0. {
        return None;
    }
    let duration = (range.1 - range.0).max(WAVEFORM_SAMPLE_STEP);
    if !duration.is_finite() || duration <= 0. {
        return None;
    }

    let native_samples = (duration / WAVEFORM_SAMPLE_STEP).ceil() as usize + 1;
    let num_samples = target_samples.max(50).min(MAX_WAVEFORM_SAMPLES).min(native_samples);
    if num_samples == 0 {
        return None;
    }
    let time_step = duration / num_samples as f64;

    // `sourceTimeAt` (`TL/ClipTrack.tsx:185-193`): output time back to
    // recording time, or `null` inside a hold -- the mixer renders silence
    // there, so the waveform drops to the baseline.
    let source_time_at = |output_time: f64| -> Option<f64> {
        let mut held = 0.;
        for (start, end) in holds {
            if output_time >= *end {
                held += end - start;
            } else if output_time > *start {
                return None;
            } else {
                break;
            }
        }
        Some(segment_start + output_time - held)
    };

    let width = f32::from(size.width) as f64;
    let height = f32::from(size.height) as f64;
    let top = f32::from(origin.y) as f64 + height * (1. - scale);
    let left = f32::from(origin.x) as f64;
    let scaled_height = height * scale;
    let map = |x: f64, y: f64| {
        gpui::point(
            px((left + x * width) as f32),
            px((top + y * scaled_height) as f32),
        )
    };

    let mut builder = gpui::PathBuilder::fill();
    builder.move_to(map(0., 1.));

    let control_step = (WAVEFORM_CONTROL_STEP / duration).min(0.25);

    for i in 0..=num_samples {
        let time = range.0 + i as f64 * time_step;
        let normalized_x = (time - range.0) / duration;
        let prev_time = time - time_step;
        let prev_x = ((prev_time - range.0) / duration).max(0.);
        let y = 1. - waveform_amplitude(peaks, source_time_at(time));
        let prev_y = 1. - waveform_amplitude(peaks, source_time_at(prev_time));
        let cp_x1 = prev_x + control_step / 2.;
        let cp_x2 = normalized_x - control_step / 2.;
        builder.cubic_bezier_to(
            map(normalized_x, y),
            map(cp_x1, prev_y),
            map(cp_x2, y),
        );
    }

    let closing_x = (range.1 + WAVEFORM_PADDING_SECONDS - range.0) / duration;
    builder.line_to(map(closing_x, 1.));
    builder.close();
    builder.build().ok()
}

/// `numSamples = min(ceil(canvasWidth * SAMPLES_PER_PIXEL), MAX_WAVEFORM_SAMPLES)`
/// (`TL/ClipTrack.tsx:266-269`).
pub fn waveform_sample_count(canvas_width: f64) -> usize {
    ((canvas_width * WAVEFORM_SAMPLES_PER_PIXEL).ceil() as usize).min(MAX_WAVEFORM_SAMPLES)
}

/// `drawWaveform`'s two colours (`TL/ClipTrack.tsx:293-302`): the mic in white
/// at 40 %, system audio in orange at 50 %.
pub const WAVEFORM_MIC_COLOR: Hsla = Hsla {
    h: 0.,
    s: 0.,
    l: 1.,
    a: 0.4,
};
pub fn waveform_system_color() -> Hsla {
    with_alpha(gpui::rgb(0xff9600).into(), 0.5)
}

// ---------------------------------------------------------------------------
// The track model
// ---------------------------------------------------------------------------

/// The nine rows, in the source order `TL/index.tsx:1334-1496` mounts them.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TrackKind {
    Clip,
    Caption,
    Keyboard,
    Text,
    Mask,
    Audio,
    Zoom,
    ThreeD,
    Scene,
}

impl TrackKind {
    /// `trackDefinitions` (`TL/index.tsx:89-144`) and `trackIcons` (`:70-80`).
    pub fn label(self) -> &'static str {
        match self {
            // The clip row's gutter label is "Video", not the definition's
            // "Clip" (`TL/index.tsx:1334`).
            Self::Clip => "Video",
            Self::Caption => "Captions",
            Self::Keyboard => "Keyboard",
            Self::Text => "Text",
            Self::Mask => "Mask",
            Self::Audio => "Audio",
            Self::Zoom => "Zoom",
            Self::ThreeD => "3D",
            Self::Scene => "Scene",
        }
    }

    pub fn icon(self) -> &'static str {
        match self {
            Self::Clip => "icons/clapperboard.svg",
            Self::Caption => "icons/captions.svg",
            Self::Keyboard => "icons/keyboard.svg",
            Self::Text => "icons/type.svg",
            Self::Mask => "icons/box-select.svg",
            Self::Audio => "icons/music.svg",
            Self::Zoom => "icons/search.svg",
            Self::ThreeD => "icons/rotate-3d.svg",
            Self::Scene => "icons/video.svg",
        }
    }

    pub fn color(self) -> Hsla {
        gpui::rgb(match self {
            Self::Clip => track_color::CLIP,
            Self::Caption => track_color::CAPTION,
            Self::Keyboard => track_color::KEYBOARD,
            Self::Text => track_color::TEXT,
            Self::Mask => track_color::MASK,
            Self::Audio => track_color::AUDIO,
            Self::Zoom => track_color::ZOOM,
            Self::ThreeD => track_color::THREE_D,
            Self::Scene => track_color::SCENE,
        })
        .into()
    }
}

/// One drawn box on a track. Every field the *read-only* render needs; the
/// per-track extras live in [`SegmentDetail`].
#[derive(Debug, Clone)]
pub struct Segment {
    pub start: f64,
    pub end: f64,
    /// Which lane (mask / text / audio are multi-lane, `TL/index.tsx:224-227`).
    pub lane: u32,
    pub detail: SegmentDetail,
}

/// Every string here is a [`SharedString`] and the waveform tables are
/// `Arc`-shared, because the timeline repaints for the playhead at ~100 Hz
/// during playback: a label that allocated on every paint would put a `String`
/// per segment per frame through the allocator for nothing.
#[derive(Debug, Clone)]
pub enum SegmentDetail {
    /// `TL/ClipTrack.tsx`. `start`/`end` above are the **output-time** box;
    /// these carry the recording-domain numbers the label reads.
    Clip {
        name: SharedString,
        /// `TimelineSegment.start` -- where the clip begins **in the recording
        /// file**. The in-clip ruler hairlines are drawn on this grid
        /// (`TL/ClipTrack.tsx:1437-1438`), not the output one.
        source_start: f64,
        /// `seg.end - seg.start`, which is what the label formats
        /// (`TL/ClipTrack.tsx:1261`) -- the source span, before timescale.
        source_duration: f64,
        timescale: f64,
        recording_clip: u32,
        /// Held (paused) windows inside this clip's on-screen box, in output
        /// time (`TL/ClipTrack.tsx:658-666`).
        holds: Arc<[(f64, f64)]>,
    },
    /// `TL/ZoomTrack.tsx:343-349`.
    Zoom { amount: f64, automatic: bool },
    /// `TL/SceneTrack.tsx:80-102`.
    Scene { mode: SceneMode },
    /// `TL/ThreeDTrack.tsx:648-651`.
    ThreeD { motion: bool },
    /// `TL/TextTrack.tsx:428-450`.
    Text {
        content: SharedString,
        color: Hsla,
        italic: bool,
        bold: bool,
        fullscreen: bool,
        enabled: bool,
    },
    /// `TL/MaskTrack.tsx:349-350`.
    Mask { label: &'static str },
    /// `TL/AudioTrack.tsx:449-540`.
    Audio {
        name: SharedString,
        enabled: bool,
        fade_in: f64,
        fade_out: f64,
    },
    /// `TL/CaptionsTrack.tsx:176-273`.
    Caption { text: SharedString },
    /// `TL/KeyboardTrack.tsx:168-266`.
    Keyboard { text: SharedString },
}

/// A row of the timeline body: a track type plus its lane index.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TrackRow {
    pub kind: TrackKind,
    pub lane: u32,
}

/// Everything the timeline draws, derived once per project-config change.
#[derive(Debug, Clone, Default)]
pub struct TimelineModel {
    pub rows: Vec<TrackRow>,
    pub clips: Vec<Segment>,
    pub zoom: Vec<Segment>,
    pub scene: Vec<Segment>,
    pub three_d: Vec<Segment>,
    pub text: Vec<Segment>,
    pub mask: Vec<Segment>,
    pub audio: Vec<Segment>,
    pub caption: Vec<Segment>,
    pub keyboard: Vec<Segment>,
    /// `clipTimelineOffsets` (`ED/clip-transitions.ts:91-106`) -- where each
    /// clip's box starts in output time, transitions subtracted.
    pub clip_boundaries: Vec<f64>,
    /// `totalDuration()` (`ED/context.ts:1374-1380`).
    pub total_duration: f64,
    /// `gainToScale(project.audio.micVolumeDb)` inputs.
    pub mic_volume_db: f64,
    pub system_volume_db: f64,
    /// One peak table per recording clip, indexed by `recordingSegment`
    /// (`TL/ClipTrack.tsx:713-730`).
    pub mic_waveforms: Vec<Arc<Vec<f32>>>,
    pub system_waveforms: Vec<Arc<Vec<f32>>>,
}

impl TimelineModel {
    /// `visibleTrackCount()` (`TL/index.tsx:257-267`) -- `rows` already is that
    /// list, so the count is its length; the two locked tracks are in it.
    pub fn track_height(&self) -> f32 {
        if self.rows.len() > 2 {
            TRACK_HEIGHT_COMPACT
        } else {
            TRACK_HEIGHT_ROOMY
        }
    }

    fn segments_for(&self, row: TrackRow) -> &[Segment] {
        self.segments(row.kind)
    }

    /// The drawn segments of one track, in **config index order** -- which is
    /// what the selection and every mutator in [`crate::editor_edits`] address
    /// them by. Multi-lane tracks keep every lane in one list; the row filters.
    pub fn segments(&self, kind: TrackKind) -> &[Segment] {
        match kind {
            TrackKind::Clip => &self.clips,
            TrackKind::Caption => &self.caption,
            TrackKind::Keyboard => &self.keyboard,
            TrackKind::Text => &self.text,
            TrackKind::Mask => &self.mask,
            TrackKind::Audio => &self.audio,
            TrackKind::Zoom => &self.zoom,
            TrackKind::ThreeD => &self.three_d,
            TrackKind::Scene => &self.scene,
        }
    }

    /// Build the whole model from a project config plus the two facts that do
    /// not live in it: whether the recording has a camera at all
    /// (`meta().hasCamera`, gating the scene row at `TL/index.tsx:200`) and
    /// whether more than one recording clip exists (which decides `"Clip"` vs
    /// `"Clip N"`, `TL/ClipTrack.tsx:617-620`).
    pub fn build(config: &ProjectConfiguration, has_camera: bool, multiple_clips: bool) -> Self {
        let Some(timeline) = config.timeline.as_ref() else {
            return Self::default();
        };

        let holds = timeline.hold_windows();
        let offsets = clip_timeline_offsets(timeline);
        let total_duration = timeline.duration();

        let clips = clip_rows(timeline, &offsets, &holds, multiple_clips);

        let zoom = timeline
            .zoom_segments
            .iter()
            .map(|segment| Segment {
                start: segment.start,
                end: segment.end,
                lane: 0,
                detail: SegmentDetail::Zoom {
                    amount: segment.amount,
                    automatic: matches!(segment.mode, ZoomMode::Auto),
                },
            })
            .collect();

        let scene = timeline
            .scene_segments
            .iter()
            .map(|segment| Segment {
                start: segment.start,
                end: segment.end,
                lane: 0,
                detail: SegmentDetail::Scene { mode: segment.mode },
            })
            .collect();

        let three_d = timeline
            .camera3d_segments
            .iter()
            .map(|segment| Segment {
                start: segment.start,
                end: segment.end,
                lane: 0,
                detail: SegmentDetail::ThreeD {
                    motion: has_camera3d_motion(segment),
                },
            })
            .collect();

        let text = timeline
            .text_segments
            .iter()
            .map(|segment| Segment {
                start: segment.start,
                end: segment.end,
                lane: segment.track,
                detail: SegmentDetail::Text {
                    content: if segment.content.is_empty() {
                        SharedString::new_static("Label")
                    } else {
                        SharedString::from(segment.content.clone())
                    },
                    color: parse_hex_color(&segment.color).unwrap_or_else(gpui::white),
                    italic: segment.italic,
                    // `font-weight: segment.fontWeight ?? 700` -- gpui has one
                    // weight per family here, so anything at or above 600
                    // draws bold.
                    bold: segment.font_weight >= 600.,
                    fullscreen: matches!(segment.layout, TextLayout::Fullscreen),
                    enabled: segment.enabled,
                },
            })
            .collect();

        let mask = timeline
            .mask_segments
            .iter()
            .map(|segment| Segment {
                start: segment.start,
                end: segment.end,
                lane: segment.track,
                detail: SegmentDetail::Mask {
                    label: match segment.mask_type {
                        MaskKind::Sensitive => "Sensitive",
                        MaskKind::Highlight => "Highlight",
                    },
                },
            })
            .collect();

        let audio = timeline
            .audio_segments
            .iter()
            .map(|segment| Segment {
                start: segment.start,
                end: segment.end,
                lane: segment.track,
                detail: SegmentDetail::Audio {
                    name: segment
                        .name
                        .clone()
                        .filter(|name| !name.is_empty())
                        .map_or_else(|| SharedString::new_static("Audio"), SharedString::from),
                    enabled: segment.enabled,
                    fade_in: segment.fade_in,
                    fade_out: segment.fade_out,
                },
            })
            .collect();

        // Captions and keyboard clamp their box to `totalDuration`
        // (`TL/CaptionsTrack.tsx:196-199`, `TL/KeyboardTrack.tsx:189-192`).
        let caption = timeline
            .caption_segments
            .iter()
            .map(|segment: &CaptionTrackSegment| Segment {
                start: segment.start,
                end: segment.end.min(total_duration),
                lane: 0,
                detail: SegmentDetail::Caption {
                    text: if segment.text.is_empty() {
                        SharedString::new_static("Caption")
                    } else {
                        SharedString::from(segment.text.clone())
                    },
                },
            })
            .collect();

        let keyboard = timeline
            .keyboard_segments
            .iter()
            .map(|segment| Segment {
                start: segment.start,
                end: segment.end.min(total_duration),
                lane: 0,
                detail: SegmentDetail::Keyboard {
                    text: if segment.display_text.is_empty() {
                        SharedString::new_static("\u{2328}")
                    } else {
                        SharedString::from(segment.display_text.clone())
                    },
                },
            })
            .collect();

        let mut model = Self {
            rows: Vec::new(),
            clips,
            zoom,
            scene,
            three_d,
            text,
            mask,
            audio,
            caption,
            keyboard,
            clip_boundaries: offsets,
            total_duration,
            mic_volume_db: config.audio.mic_volume_db as f64,
            system_volume_db: config.audio.system_volume_db as f64,
            mic_waveforms: Vec::new(),
            system_waveforms: Vec::new(),
        };
        model.rows = build_rows(config, &model, has_camera);
        model
    }
}

/// Which rows are visible, in source order.
///
/// Initial visibility is derived from the project's own content
/// (`ED/context.ts:1405-1420, 1489-1499`): captions follow their settings flag
/// (falling back to "any caption segment exists"), keyboard follows its
/// settings flag only, 3D appears when the project has any camera3d segment,
/// scene is on by default but gated on `meta().hasCamera && !project.camera.hide`
/// (`TL/index.tsx:200, 238`), and the three multi-lane tracks show one row per
/// used lane (`getUsedTrackCount` / `getTrackRowsWithCount`,
/// `ED/timelineTracks.ts:39-96`).
fn build_rows(config: &ProjectConfiguration, model: &TimelineModel, has_camera: bool) -> Vec<TrackRow> {
    let timeline = config.timeline.as_ref();
    let caption_visible = config
        .captions
        .as_ref()
        .map(|captions| captions.settings.enabled)
        .unwrap_or_else(|| {
            timeline.is_some_and(|timeline| !timeline.caption_segments.is_empty())
        });
    let keyboard_visible = config
        .keyboard
        .as_ref()
        .is_some_and(|keyboard| keyboard.settings.enabled);
    let three_d_visible = !model.three_d.is_empty();
    let scene_visible = has_camera && !config.camera.hide;

    let mut rows = vec![TrackRow {
        kind: TrackKind::Clip,
        lane: 0,
    }];
    if caption_visible {
        rows.push(TrackRow {
            kind: TrackKind::Caption,
            lane: 0,
        });
    }
    if keyboard_visible {
        rows.push(TrackRow {
            kind: TrackKind::Keyboard,
            lane: 0,
        });
    }
    for (kind, segments) in [
        (TrackKind::Text, &model.text),
        (TrackKind::Mask, &model.mask),
        (TrackKind::Audio, &model.audio),
    ] {
        for lane in 0..lane_count(segments) {
            rows.push(TrackRow { kind, lane });
        }
    }
    rows.push(TrackRow {
        kind: TrackKind::Zoom,
        lane: 0,
    });
    if three_d_visible {
        rows.push(TrackRow {
            kind: TrackKind::ThreeD,
            lane: 0,
        });
    }
    if scene_visible {
        rows.push(TrackRow {
            kind: TrackKind::Scene,
            lane: 0,
        });
    }
    rows
}

/// `getUsedTrackCount` (`ED/timelineTracks.ts:39-48`): the highest lane index
/// any segment carries, plus one. Zero when the track has no segments -- the
/// row only exists once something is on it.
fn lane_count(segments: &[Segment]) -> u32 {
    segments
        .iter()
        .map(|segment| segment.lane + 1)
        .max()
        .unwrap_or(0)
}

/// `clipTimelineOffsets` (`ED/clip-transitions.ts:91-106`): each transition
/// subtracts its duration from the running offset, so a crossfade overlaps the
/// two clips it joins. Uses the Rust side's own `effective_transition`
/// (`crates/project/src/configuration.rs:1601`) rather than re-deriving the
/// clamp.
pub fn clip_timeline_offsets(timeline: &TimelineConfiguration) -> Vec<f64> {
    let mut offsets = Vec::with_capacity(timeline.segments.len());
    let mut offset = 0.0;
    for (index, segment) in timeline.segments.iter().enumerate() {
        offset -= timeline
            .effective_transition(index)
            .map_or(0.0, |transition| transition.duration);
        offsets.push(offset);
        offset += segment.duration();
    }
    offsets
}

/// `effectiveToOutput` (`ED/timeline-holds.ts:54-64`) -- a gapless
/// recording-flow timestamp placed back into output time, landing after every
/// hold it passed. Rust's own copy is private
/// (`configuration.rs:1866-1878`), so this is the four-line transcription.
fn effective_to_output(holds: &[(f64, f64)], effective: f64) -> f64 {
    let mut output = effective;
    for (start, end) in holds {
        if output >= *start {
            output += end - start;
        } else {
            break;
        }
    }
    output
}

/// `relativeSegment` (`TL/ClipTrack.tsx:636-666`): a clip's on-screen box is
/// its gapless offset and duration pushed through the hold windows, so the box
/// stretches across every pause a fullscreen text segment inserts inside it.
fn clip_rows(
    timeline: &TimelineConfiguration,
    offsets: &[f64],
    holds: &[(f64, f64)],
    multiple_clips: bool,
) -> Vec<Segment> {
    timeline
        .segments
        .iter()
        .enumerate()
        .map(|(index, segment)| {
            let previous = offsets.get(index).copied().unwrap_or(0.);
            let start = effective_to_output(holds, previous).max(0.);
            let end = effective_to_output(holds, previous + segment.duration());
            let inner_holds: Arc<[(f64, f64)]> = holds
                .iter()
                .map(|(hold_start, hold_end)| (hold_start.max(start), hold_end.min(end)))
                .filter(|(hold_start, hold_end)| hold_end > hold_start)
                .collect();
            Segment {
                start,
                end,
                lane: 0,
                detail: SegmentDetail::Clip {
                    name: if multiple_clips {
                        SharedString::from(format!("Clip {}", segment.recording_clip))
                    } else {
                        SharedString::new_static("Clip")
                    },
                    source_start: segment.start,
                    // The label shows `formatTime(seg.end - seg.start)` -- the
                    // *source* span, not the output one (`TL/ClipTrack.tsx:1261`).
                    source_duration: segment.end - segment.start,
                    timescale: segment.timescale,
                    recording_clip: segment.recording_clip,
                    holds: inner_holds,
                },
            }
        })
        .collect()
}

/// `hasCamera3DMotion` (`ED/three-d.ts:1253-1254`): a segment moves when any
/// of the nine pose tracks carries a keyframe. Blur is segment-level and never
/// counts.
fn has_camera3d_motion(segment: &Camera3DSegment) -> bool {
    let tracks = &segment.tracks;
    ![
        &tracks.tilt_x,
        &tracks.tilt_y,
        &tracks.roll,
        &tracks.rotate_x,
        &tracks.rotate_y,
        &tracks.fov,
        &tracks.zoom,
        &tracks.pan_x,
        &tracks.pan_y,
    ]
    .iter()
    .all(|track| track.is_empty())
}

/// `#rrggbb` / `#rgb`, the form every colour in the config takes.
fn parse_hex_color(value: &str) -> Option<Hsla> {
    let hex = value.strip_prefix('#')?;
    let rgb = match hex.len() {
        6 => u32::from_str_radix(hex, 16).ok()?,
        3 => {
            let value = u32::from_str_radix(hex, 16).ok()?;
            let r = (value >> 8) & 0xf;
            let g = (value >> 4) & 0xf;
            let b = value & 0xf;
            (r << 20) | (r << 16) | (g << 12) | (g << 8) | (b << 4) | b
        }
        _ => return None,
    };
    Some(gpui::rgb(rgb).into())
}

/// `getSceneLabel` / `getSceneIcon` (`TL/SceneTrack.tsx:80-102`).
fn scene_label(mode: SceneMode) -> &'static str {
    match mode {
        SceneMode::CameraOnly => "Camera Only",
        SceneMode::HideCamera => "Hide Camera",
        SceneMode::SplitScreen => "Split Screen",
        SceneMode::Floating => "Floating",
        SceneMode::Default => "Default",
    }
}

fn scene_icon(mode: SceneMode) -> &'static str {
    match mode {
        SceneMode::CameraOnly => "icons/video.svg",
        SceneMode::HideCamera => "icons/eye-off.svg",
        SceneMode::SplitScreen => "icons/columns-2.svg",
        SceneMode::Floating => "icons/panel-right.svg",
        SceneMode::Default => "icons/monitor-outline.svg",
    }
}

// ---------------------------------------------------------------------------
// The view state the window owns
// ---------------------------------------------------------------------------

/// Everything about the timeline that is *not* the project: the viewport, the
/// playhead, and the pointer.
#[derive(Debug, Clone, Copy)]
pub struct TimelineView {
    pub transform: Transform,
    /// `editorState.playbackTime`.
    pub playhead: f64,
    /// `editorState.previewTime` -- the hover ghost. `None` while playing or
    /// with the pointer outside the content column (`TL/index.tsx:1170-1188`).
    pub preview_time: Option<f64>,
    /// `editorState.timeline.hoveredTrack` (`ED/context.ts:1500`). Read by the
    /// zoom and 3D tracks to decide whether to draw their new-segment ghost
    /// (`TL/ZoomTrack.tsx:107`, `TL/ThreeDTrack.tsx:135`).
    pub hovered_track: Option<TrackKind>,
    pub playing: bool,
}

impl Default for TimelineView {
    fn default() -> Self {
        Self {
            transform: Transform::default(),
            playhead: 0.,
            preview_time: None,
            hovered_track: None,
            playing: false,
        }
    }
}

/// What E4's interaction layer contributes to the picture: which segments are
/// selected, which one the pointer is over, and whether the scissors toggle is
/// down. Borrowed rather than folded into [`TimelineView`] because a selection
/// is a `Vec` and the view is `Copy` on the playback path.
#[derive(Debug, Clone, Copy, Default)]
pub struct SegmentUi<'a> {
    /// `editorState.timeline.selection`.
    pub selection: Option<&'a Selection>,
    /// `editorState.timeline.interactMode === "split"`, which swaps the cursor
    /// and turns a segment press into a cut.
    pub split_mode: bool,
    /// The segment under the pointer, as `(track, lane, index)`. This is the
    /// `group-hover` the handles' `opacity-100` hangs off
    /// (`TL/Track.tsx:250`).
    pub hovered: Option<(TrackKind, u32, usize)>,
    /// `trackState.draggingSegment` (`TL/ZoomTrack.tsx:785`) plus
    /// `creatingSegmentViaDrag` (`:106`): either one hides the create ghost.
    pub dragging: bool,
}

impl SegmentUi<'_> {
    fn is_selected(&self, kind: TrackKind, index: usize) -> bool {
        self.selection
            .is_some_and(|selection| selection.contains(kind, index))
    }

    fn is_hovered(&self, kind: TrackKind, lane: u32, index: usize) -> bool {
        self.hovered == Some((kind, lane, index))
    }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/// The gutter chip: `cap-track-fill` + `relative z-10 w-full h-13 flex flex-col
/// items-center justify-center gap-0.5 rounded-xl shadow-[...] text-white`
/// (`TL/TrackManager.tsx:264-281`).
///
/// **`h-13` is 52px and deliberately does not follow `--track-height`**, so on
/// a timeline with more than two rows (48px) the chip overhangs its row. That
/// is the source's own behaviour, kept.
pub fn track_chip(kind: TrackKind) -> impl IntoElement {
    let color = kind.color();
    div()
        .w_full()
        .h(px(52.))
        .flex()
        .flex_col()
        .items_center()
        .justify_center()
        .gap(px(2.))
        .rounded(px(12.))
        .bg(color)
        .border_1()
        .border_color(track_fill_border(color))
        .text_color(gpui::white())
        .child(
            svg()
                .path(kind.icon())
                .size(px(16.))
                .flex_none()
                .text_color(gpui::white()),
        )
        .child(
            div()
                .text_size(px(10.))
                .line_height(px(10.))
                .font_weight(FontWeight::MEDIUM)
                .child(kind.label()),
        )
}

/// `TimelineMarkings` (`TL/index.tsx:1554-1606`).
///
/// The tick ladder walks from `position - (position % resolution)`, so the
/// marks are absolute times on the resolution grid rather than offsets from
/// the viewport -- panning slides them, zooming re-resolves them. Labels appear
/// only on whole seconds, and the origin's label is left-anchored so it does
/// not overhang into the icon gutter.
pub fn render_ruler(theme: &Theme, view: TimelineView, viewport_width: f32) -> AnyElement {
    let transform = view.transform;
    let resolution = marking_resolution(transform.zoom);
    let secs_per_pixel = transform.secs_per_pixel(content_width(viewport_width));
    // The body is `flex-1` *after* `margin-left: 112px`, so the drawable
    // strip is the header less the gutter.
    let strip_width = (ruler_width(viewport_width) - TRACK_GUTTER) as f64;

    let count = (2. + (transform.zoom + 5.) / resolution).ceil().max(0.) as usize;
    let offset = transform.position % resolution;

    let mut body = div()
        .relative()
        .flex_1()
        .h(px(16.))
        .ml(px(TRACK_GUTTER))
        .text_size(px(12.))
        .text_color(Hsla::from(theme.gray_9));

    // The source renders every mark and hides the negative ones with
    // `visibility`, which costs nothing there and would cost an element here.
    for index in 0..count.min(512) {
        let second = transform.position - offset + index as f64 * resolution;
        if second < 0. {
            continue;
        }
        let x = (second - transform.position) / secs_per_pixel - 1.;
        if x > strip_width {
            break;
        }
        let show_label = second % 1. == 0.;
        body = body.child(
            div()
                .absolute()
                .left(px(x as f32))
                .bottom(px(4.))
                .size(px(4.))
                .rounded_full()
                .bg(Hsla::from(theme.gray_9))
                .when(show_label, |this| {
                    this.child(
                        div()
                            .absolute()
                            // `-top-4.5` = -18px, and the origin's label is
                            // left-anchored (`TL/index.tsx:1591-1594`).
                            .top(px(-18.))
                            // `-translate-x-1/2` on every label but the
                            // origin's, which is left-anchored so it does not
                            // overhang into the icon gutter
                            // (`TL/index.tsx:1591-1594`). gpui has no
                            // transform, so the label sits in a fixed box wide
                            // enough for `M:SS` at any minute count and is
                            // centred inside it.
                            .when(second != 0., |this| this.left(px(-22.)))
                            .w(px(44.))
                            .flex()
                            .when(second != 0., |this| this.justify_center())
                            .text_size(px(12.))
                            .line_height(px(16.))
                            .text_color(Hsla::from(theme.gray_9))
                            .child(format_time(second)),
                    )
                }),
        );
    }

    div()
        .absolute()
        .inset_0()
        .flex()
        .items_end()
        .child(body)
        .into_any_element()
}

/// The minimap (`TL/Minimap.tsx`): a 12px pill above the ruler carrying a
/// viewport chip and a tick per clip boundary. Hidden -- `opacity-0
/// pointer-events-none` -- until the viewport is narrower than the whole
/// timeline (`total - zoom > 0.01`).
pub fn render_minimap(
    theme: &Theme,
    model: &TimelineModel,
    view: TimelineView,
    bar_width: f32,
) -> AnyElement {
    let total = model.total_duration.max(0.001);
    let bar_width = bar_width.max(1.);
    let px_per_sec = bar_width as f64 / total;
    let zoomed_in = total - view.transform.zoom > 0.01;

    let chip_width = ((view.transform.zoom * px_per_sec) as f32)
        .max(MINIMAP_MIN_CHIP_WIDTH)
        .min(bar_width);
    let max_position = (total - view.transform.zoom).max(0.001);
    let chip_left =
        ((view.transform.position / max_position).min(1.) as f32) * (bar_width - chip_width).max(0.);

    let mut bar = div()
        .relative()
        .w_full()
        .h_full()
        .overflow_hidden()
        .rounded_full()
        .border_1()
        .border_color(Hsla::from(theme.gray_4))
        .bg(with_alpha(Hsla::from(theme.gray_3), 0.8))
        .when(!zoomed_in, |this| this.opacity(0.));

    for offset in &model.clip_boundaries {
        if *offset <= 0. || *offset >= total {
            continue;
        }
        bar = bar.child(
            div()
                .absolute()
                .top_0()
                .bottom_0()
                .left(gpui::relative((offset / total) as f32))
                .w(px(1.))
                .bg(with_alpha(Hsla::from(theme.gray_6), 0.5)),
        );
    }

    bar.child(
        div()
            .absolute()
            .top_0()
            .bottom_0()
            .left(px(chip_left))
            .w(px(chip_width))
            .rounded_full()
            .border_1()
            .border_color(with_alpha(Hsla::from(theme.gray_7), 0.8))
            .bg(with_alpha(Hsla::from(theme.gray_6), 0.7)),
    )
    .into_any_element()
}

/// The edge-fade strength either side of the viewport (`TL/index.tsx:1097-1139`).
///
/// The source expresses it as a `mask-image` with a stop whose alpha ramps over
/// `FADE_RAMP_PX` of scroll; gpui has no mask-image, so [`render_edge_fade`]
/// paints the same ramp as two gradient overlays in the container's own
/// background colour. The strengths are the source's exactly.
pub fn edge_fade_strengths(model: &TimelineModel, view: TimelineView, viewport_width: f32) -> (f32, f32) {
    let secs_per_pixel = view.transform.secs_per_pixel(content_width(viewport_width));
    let scroll_left_px = view.transform.position / secs_per_pixel;
    let left = (scroll_left_px / FADE_RAMP_PX).min(1.).max(0.);
    let scroll_right_px =
        (model.total_duration - (view.transform.position + view.transform.zoom)) / secs_per_pixel;
    let right = (scroll_right_px / FADE_RAMP_PX).min(1.).max(0.);
    (left as f32, right as f32)
}

/// The two 32px gradients [`edge_fade_strengths`] describes, painted over the
/// scroll body's left and right edges in `background`.
pub fn render_edge_fade(background: Hsla, strengths: (f32, f32)) -> AnyElement {
    let transparent = with_alpha(background, 0.);
    div()
        .absolute()
        .inset_0()
        .child(
            div()
                .absolute()
                .top_0()
                .bottom_0()
                .left(px(TRACK_GUTTER))
                .w(px(FADE_WIDTH))
                .opacity(strengths.0)
                .bg(gpui::linear_gradient(
                    90.,
                    gpui::linear_color_stop(background, 0.),
                    gpui::linear_color_stop(transparent, 1.),
                )),
        )
        .child(
            div()
                .absolute()
                .top_0()
                .bottom_0()
                .right_0()
                .w(px(FADE_WIDTH))
                .opacity(strengths.1)
                .bg(gpui::linear_gradient(
                    90.,
                    gpui::linear_color_stop(transparent, 0.),
                    gpui::linear_color_stop(background, 1.),
                )),
        )
        .into_any_element()
}

/// One track row: `flex items-stretch gap-2`, a 104px gutter cell and a
/// `flex-1 relative overflow-hidden min-w-0` content cell
/// (`TL/index.tsx:1516-1550`).
pub fn render_row(
    theme: &Theme,
    model: &TimelineModel,
    row: TrackRow,
    view: TimelineView,
    viewport_width: f32,
    ui: SegmentUi<'_>,
) -> AnyElement {
    let height = model.track_height();
    div()
        .flex()
        .flex_row()
        .items_stretch()
        .gap(px(TRACK_ROW_GAP))
        .h(px(height))
        .flex_none()
        .child(
            div()
                .w(px(TRACK_ICON_WIDTH))
                .flex_none()
                .relative()
                .child(track_chip(row.kind)),
        )
        .child(
            div()
                .flex_1()
                .relative()
                .overflow_hidden()
                .min_w_0()
                .child(render_track_content(
                    theme,
                    model,
                    row,
                    view,
                    viewport_width,
                    height,
                    ui,
                )),
        )
        .into_any_element()
}

/// The content column of one row: its segments, or the track's own empty state.
#[allow(clippy::too_many_arguments)]
fn render_track_content(
    theme: &Theme,
    model: &TimelineModel,
    row: TrackRow,
    view: TimelineView,
    viewport_width: f32,
    height: f32,
    ui: SegmentUi<'_>,
) -> AnyElement {
    let width = content_width(viewport_width);
    let secs_per_pixel = view.transform.secs_per_pixel(width);
    let segments = model.segments_for(row);

    let mut content = div().relative().size_full();

    if !segments.iter().any(|segment| segment.lane == row.lane)
        && let Some(empty) = render_empty_track(theme, row.kind)
    {
        content = content.child(empty);
    }

    // Enumerated before the lane filter so the index stays the **config**
    // index -- what the selection and every mutator address segments by.
    for (index, segment) in segments
        .iter()
        .enumerate()
        .filter(|(_, segment)| segment.lane == row.lane)
    {
        // `SEGMENT_RENDER_PADDING` culling (`TL/context.ts:14, 57-68`): a
        // segment outside the viewport plus two seconds is never built.
        if !view.transform.segment_visible(segment.start, segment.end) {
            continue;
        }
        content = content.child(render_segment(
            theme,
            model,
            row.kind,
            segment,
            view,
            secs_per_pixel,
            height,
            ui.is_selected(row.kind, index),
            ui.is_hovered(row.kind, row.lane, index),
            ui.split_mode,
        ));
    }

    // The zoom track's create-by-click ghost (`TL/ZoomTrack.tsx:104-166,
    // 788-802`): while the pointer is over the row and not over an existing
    // segment, a `pointer-events-none z-0` box shows where a new segment would
    // land. Pressing it is what creates the segment.
    if row.kind == TrackKind::Zoom
        && !ui.dragging
        && view.hovered_track == Some(TrackKind::Zoom)
        && let Some(preview) = view.preview_time
        && let Some(ghost) = new_zoom_segment(model, preview, secs_per_pixel)
    {
        content = content.child(render_zoom_ghost(ghost, view, secs_per_pixel, height));
    }

    content.into_any_element()
}

/// `newSegmentDetails` (`TL/ZoomTrack.tsx:104-166`): where a new zoom segment
/// would go if the pointer were clicked here, or `None` when the pointer is
/// inside an existing segment or the surrounding gap is too small.
pub fn new_zoom_segment(
    model: &TimelineModel,
    preview: f64,
    secs_per_pixel: f64,
) -> Option<(f64, f64)> {
    let min_duration = new_segment_min_duration(secs_per_pixel);

    let next = model
        .zoom
        .iter()
        .find(|segment| preview <= segment.start);
    let previous = model
        .zoom
        .iter()
        .rev()
        .find(|segment| preview >= segment.start);

    if let Some(previous) = previous
        && preview > previous.start
        && preview < previous.end
    {
        return None;
    }

    if let Some(next) = next {
        if let Some(previous) = previous
            && next.start - previous.end < min_duration
        {
            return None;
        }
        if next.start - preview < 1. {
            return Some((next.start - min_duration, next.start));
        }
    }

    Some((preview, preview + min_duration))
}

fn render_zoom_ghost(
    (start, end): (f64, f64),
    view: TimelineView,
    secs_per_pixel: f64,
    height: f32,
) -> AnyElement {
    let color = TrackKind::Zoom.color();
    let x = ((start - view.transform.position) / secs_per_pixel) as f32;
    let width = ((end - start) / secs_per_pixel) as f32;
    div()
        .absolute()
        .top_0()
        .bottom_0()
        .left(px(x))
        .w(px(width))
        .rounded(px(12.))
        .border_1()
        .border_color(gpui::transparent_black())
        .child(
            div()
                .relative()
                .h(px(height))
                .w_full()
                .flex()
                .items_center()
                .justify_center()
                .rounded(px(12.))
                .overflow_hidden()
                .bg(color)
                .border_1()
                .border_color(track_fill_border(color))
                .text_color(gpui::white())
                .text_size(px(16.))
                .child("+"),
        )
        .into_any_element()
}

/// The empty-lane states. Only three tracks have one; the rest render nothing.
fn render_empty_track(theme: &Theme, kind: TrackKind) -> Option<AnyElement> {
    match kind {
        // `TL/CaptionsTrack.tsx:146-160`.
        TrackKind::Caption => Some(
            div()
                .absolute()
                .inset_0()
                .flex()
                .flex_col()
                .gap(px(8.))
                .items_center()
                .justify_center()
                .rounded(px(12.))
                .bg(with_alpha(Hsla::from(theme.gray_3), 0.1))
                .text_size(px(14.))
                .text_color(text_tertiary(theme))
                .child("No captions")
                .into_any_element(),
        ),
        // `TL/KeyboardTrack.tsx:146-153`.
        TrackKind::Keyboard => Some(
            div()
                .absolute()
                .inset_0()
                .flex()
                .flex_col()
                .items_center()
                .justify_center()
                .rounded(px(12.))
                .bg(with_alpha(Hsla::from(theme.gray_3), 0.1))
                .text_size(px(14.))
                .text_color(text_tertiary(theme))
                .child("No keyboard events")
                .child(
                    div()
                        .mt(px(2.))
                        .text_size(px(10.))
                        .text_color(with_alpha(text_tertiary(theme), 0.4))
                        .child("Record keyboard presses or generate from recording"),
                )
                .into_any_element(),
        ),
        // `TL/AudioTrack.tsx:400-427` -- the dashed "Add audio" button.
        TrackKind::Audio => Some(
            div()
                .absolute()
                .inset_0()
                .flex()
                .flex_row()
                .gap(px(8.))
                .items_center()
                .justify_center()
                .w_full()
                .rounded(px(12.))
                .border_1()
                .border_dashed()
                .border_color(with_alpha(Hsla::from(theme.gray_4), 0.6))
                .bg(with_alpha(Hsla::from(theme.gray_3), 0.15))
                .text_size(px(14.))
                .text_color(text_tertiary(theme))
                .child(
                    div()
                        .flex()
                        .items_center()
                        .justify_center()
                        .rounded_full()
                        .size(px(24.))
                        .bg(with_alpha(Hsla::from(theme.gray_4), 0.4))
                        .child(
                            svg()
                                .path("icons/plus.svg")
                                .size(px(14.))
                                .text_color(Hsla::from(theme.gray_11)),
                        ),
                )
                .child(
                    div()
                        .font_weight(FontWeight::MEDIUM)
                        .child("Add audio"),
                )
                .into_any_element(),
        ),
        _ => None,
    }
}

/// `SegmentRoot` (`TL/Track.tsx:100-137`): the positioned outer box with its
/// selection border, the `cap-track-fill` inner box, the label at whatever tier
/// its visible width allows, and the two trim handles.
#[allow(clippy::too_many_arguments)]
fn render_segment(
    theme: &Theme,
    model: &TimelineModel,
    kind: TrackKind,
    segment: &Segment,
    view: TimelineView,
    secs_per_pixel: f64,
    height: f32,
    selected: bool,
    hovered: bool,
    split_mode: bool,
) -> AnyElement {
    let color = kind.color();
    let x = ((segment.start - view.transform.position) / secs_per_pixel) as f32;
    let width = ((segment.end - segment.start) / secs_per_pixel) as f32;
    let (visible_width, center_x) =
        visible_box(segment.start, segment.end, view.transform, secs_per_pixel);

    // `!segment.enabled && "opacity-60"` (text, `TL/TextTrack.tsx:365`) and
    // `"opacity-50"` (audio, `TL/AudioTrack.tsx:457`).
    let dim = match &segment.detail {
        SegmentDetail::Text { enabled, .. } if !enabled => Some(0.6),
        SegmentDetail::Audio { enabled, .. } if !enabled => Some(0.5),
        _ => None,
    };

    let mut fill = div()
        .relative()
        .h_full()
        .w_full()
        .flex()
        .flex_row()
        .rounded(px(12.))
        .overflow_hidden()
        .bg(color)
        .border_1()
        .border_color(track_fill_border(color));

    // The clip track's waveform and its per-second markings, both under the
    // label (`TL/ClipTrack.tsx:943-957`).
    if let SegmentDetail::Clip {
        timescale, holds, recording_clip, ..
    } = &segment.detail
    {
        if *timescale == 1. {
            fill = fill.child(render_waveform(
                model,
                segment,
                *recording_clip,
                holds,
                view,
                width,
                height,
            ));
        }
        fill = fill.child(render_clip_markings(
            theme,
            segment,
            holds,
            view,
            secs_per_pixel,
            height,
        ));
        for (hold_start, hold_end) in holds.iter() {
            let hold_x = ((hold_start - segment.start) / secs_per_pixel) as f32;
            let hold_width = ((hold_end - hold_start) / secs_per_pixel) as f32;
            fill = fill.child(render_hold(hold_x, hold_width));
        }
    }

    fill = fill.child(render_label(
        theme,
        kind,
        segment,
        visible_width,
        center_x,
    ));

    // The audio track's fade envelopes (`FadeControl`,
    // `TL/AudioTrack.tsx:118-201`). The fade *handles* -- dragging the envelope
    // itself -- are their own interaction and are not built; the shade and the
    // curve are the segment's own state and are drawn.
    if let SegmentDetail::Audio {
        fade_in, fade_out, ..
    } = &segment.detail
    {
        let duration = (segment.end - segment.start).max(0.0001);
        for (edge_in, seconds) in [(true, *fade_in), (false, *fade_out)] {
            let fraction = (seconds / duration).clamp(0., 1.);
            if fraction <= 0.001 {
                continue;
            }
            fill = fill.child(render_fade(edge_in, fraction as f32, width, height));
        }
    }

    // `SegmentHandle` (`TL/Track.tsx:236-258`): a 20px hit target with a 3px
    // visible bar, half-overhanging each edge. `compact() ? "opacity-55" :
    // "opacity-35 group-hover:opacity-100"`, and the clip track's own handles
    // add `opacity-0 group-hover:opacity-100` (`TL/ClipTrack.tsx:1137, 1286`).
    // A *compact* handle carries no `group-hover` class, so it stays at 0.55
    // with the pointer on it.
    let compact = (width as f64) < 40.;
    let handle_opacity = if compact {
        0.55
    } else if hovered {
        1.
    } else if kind == TrackKind::Clip {
        0.
    } else {
        0.35
    };

    div()
        .absolute()
        .top_0()
        .bottom_0()
        .left(px(x))
        .w(px(width))
        .rounded(px(12.))
        .border_1()
        // `isSelected() ? <segColor> : "border-transparent"`, one line per
        // track; the nine colours are enumerated on `selected_border_color`,
        // two of which are dead classes in the shipping app and paint nothing.
        .border_color(if selected {
            selected_border_color(theme, kind)
        } else {
            gpui::transparent_black()
        })
        .when_some(dim, |this, opacity| this.opacity(opacity))
        // `interactMode === "split" && "timeline-scissors-cursor"`
        // (`TL/Track.tsx:107-108`). That cursor is an inline SVG data-URI;
        // this rev has the standard set only, so a crosshair stands in.
        .when(split_mode, |this| {
            this.cursor(gpui::CursorStyle::Crosshair)
        })
        .child(fill)
        .child(render_handle(true, handle_opacity))
        .child(render_handle(false, handle_opacity))
        .into_any_element()
}

fn render_handle(start: bool, opacity: f32) -> impl IntoElement {
    div()
        .absolute()
        .top_0()
        .bottom_0()
        // `cursor-col-resize`.
        .cursor(gpui::CursorStyle::ResizeLeftRight)
        // `w-5` with `-translate-x-1/2` / `translate-x-1/2`: the 20px box
        // straddles the edge, 10px each side.
        .w(px(20.))
        .map(|this| {
            if start {
                this.left(px(-10.))
            } else {
                this.right(px(-10.))
            }
        })
        .flex()
        .items_center()
        .justify_center()
        .opacity(opacity)
        .child(
            // `w-[3px] h-8 bg-solid-white rounded-full` -- `--solid-white` is
            // `#ffffff` in both themes (`theme.css:74, 140`).
            div()
                .w(px(3.))
                .h(px(32.))
                .rounded_full()
                .bg(gpui::white()),
        )
}

/// `Markings` (`TL/ClipTrack.tsx:1425-1476`): one hairline per ruler tick,
/// drawn *inside* each clip box in recording time and pushed past the holds the
/// stretched box inserts before it. The gradient is
/// `from-transparent to-transparent via-white-transparent-40
/// dark:via-black-transparent-60`, i.e. a three-stop fade with the mid colour at
/// the centre -- gpui takes two stops, so it is drawn as two stacked halves.
fn render_clip_markings(
    theme: &Theme,
    segment: &Segment,
    holds: &[(f64, f64)],
    view: TimelineView,
    secs_per_pixel: f64,
    height: f32,
) -> impl IntoElement {
    let SegmentDetail::Clip { source_start, .. } = segment.detail else {
        return div();
    };
    let resolution = marking_resolution(view.transform.zoom);
    // `visibleMin = transform.position - props.prevDuration + props.segment.start`
    // (`TL/ClipTrack.tsx:1437-1439`): `prevDuration` is the box's output start
    // and `segment.start` its recording-domain start, so the grid is walked in
    // recording time and mapped back through the holds below.
    let visible_min = view.transform.position - segment.start + source_start;
    let visible_max = visible_min + view.transform.zoom;
    let first = (visible_min / resolution).floor();
    let count = ((visible_max / resolution).ceil() - first).max(0.) as usize;

    // `--white-transparent-40: rgba(255,255,255,0.4)` in light and
    // `--black-transparent-60: rgba(255,255,255,0.6)` in dark
    // (`theme.css:64, 70, 129, 136`) -- the dark override of *both* names is
    // white, so the hairline is white in either theme, only its alpha changes.
    let via = if theme.is_dark() {
        with_alpha(gpui::white(), 0.6)
    } else {
        with_alpha(gpui::white(), 0.4)
    };
    let transparent = with_alpha(gpui::white(), 0.);

    let mut root = div();
    let holds_relative: Vec<(f64, f64)> = holds
        .iter()
        .map(|(start, end)| (start - segment.start, end - segment.start))
        .collect();

    for index in 0..count.min(512) {
        let marking = (first + index as f64) * resolution;
        let effective = marking - source_start;
        if effective < 0. {
            continue;
        }
        let x = (effective_to_output(&holds_relative, effective) / secs_per_pixel) as f32;
        root = root.child(
            div()
                .absolute()
                .top_0()
                .left(px(x))
                .w(px(1.))
                .h(px(height))
                .flex()
                .flex_col()
                .child(div().w_full().h(px(height / 2.)).bg(gpui::linear_gradient(
                    180.,
                    gpui::linear_color_stop(transparent, 0.),
                    gpui::linear_color_stop(via, 1.),
                )))
                .child(div().w_full().h(px(height / 2.)).bg(gpui::linear_gradient(
                    180.,
                    gpui::linear_color_stop(via, 0.),
                    gpui::linear_color_stop(transparent, 1.),
                ))),
        );
    }
    root
}

/// One audio fade envelope (`fadeGeometry` / `fadeEnvelopeCurve` /
/// `FadeControl`, `TL/AudioTrack.tsx:63-201`): a 34 %-black shade over the
/// faded span with a white curve along its top, plus the 10px corner triangle
/// at the segment's edge.
///
/// The source draws the curve in a `viewBox="0 0 100 100"` with
/// `preserveAspectRatio="none"`, so the two cubic control points are in
/// percent of the span; they are scaled into pixels here.
fn render_fade(edge_in: bool, fraction: f32, width: f32, height: f32) -> impl IntoElement {
    let span = (fraction * width).max(0.);
    let shade_x = if edge_in { 0. } else { width - span };

    div()
        .absolute()
        .inset_0()
        .child(
            div()
                .absolute()
                .top_0()
                .bottom_0()
                .left(px(shade_x))
                .w(px(span))
                .bg(with_alpha(gpui::black(), 0.34)),
        )
        .child(
            // `M 0,100 C 0,68 span*0.55,10 span,0` in, and
            // `M 100,100 C 100,68 endX + span*0.45,10 endX,0` out. The source
            // draws it in a `viewBox="0 0 100 100"` with
            // `preserveAspectRatio="none"`, so the control points are percent
            // of the span; they are scaled into the element's own bounds here,
            // which is also what puts the path in window coordinates.
            gpui::canvas(
                |bounds, _window, _cx| bounds,
                move |_, bounds, window, _cx| {
                    let mut builder = gpui::PathBuilder::stroke(px(1.5));
                    let x = |value: f32| bounds.origin.x + px(value);
                    let y = |percent: f32| bounds.origin.y + px(height * percent / 100.);
                    if edge_in {
                        builder.move_to(gpui::point(x(0.), y(100.)));
                        builder.cubic_bezier_to(
                            gpui::point(x(span), y(0.)),
                            gpui::point(x(0.), y(68.)),
                            gpui::point(x(span * 0.55), y(10.)),
                        );
                    } else {
                        let end_x = width - span;
                        builder.move_to(gpui::point(x(width), y(100.)));
                        builder.cubic_bezier_to(
                            gpui::point(x(end_x), y(0.)),
                            gpui::point(x(width), y(68.)),
                            gpui::point(x(end_x + span * 0.45), y(10.)),
                        );
                    }
                    if let Ok(path) = builder.build() {
                        window.paint_path(path, with_alpha(gpui::white(), 0.94));
                    }
                },
            )
            .absolute()
            .inset_0(),
        )
        .child(
            // `FadeCornerTriangle`: an 11px right triangle in white at 90 %,
            // clipped to the segment's own rounded corner.
            div()
                .absolute()
                .top_0()
                .map(|this| {
                    if edge_in {
                        this.left_0()
                    } else {
                        this.right_0()
                    }
                })
                .size(px(11.))
                .overflow_hidden()
                .child(
                    gpui::canvas(
                        |bounds, _window, _cx| bounds,
                        move |_, bounds, window, _cx| {
                            let mut builder = gpui::PathBuilder::fill();
                            let (x, y) = (bounds.origin.x, bounds.origin.y);
                            if edge_in {
                                builder.move_to(gpui::point(x, y));
                                builder.line_to(gpui::point(x + px(11.), y));
                                builder.line_to(gpui::point(x, y + px(11.)));
                            } else {
                                builder.move_to(gpui::point(x + px(11.), y));
                                builder.line_to(gpui::point(x, y));
                                builder.line_to(gpui::point(x + px(11.), y + px(11.)));
                            }
                            builder.close();
                            if let Ok(path) = builder.build() {
                                window.paint_path(path, with_alpha(gpui::white(), 0.9));
                            }
                        },
                    )
                    .absolute()
                    .inset_0(),
                ),
        )
}

/// The paused window a fullscreen text segment inserts inside a clip
/// (`TL/ClipTrack.tsx:959-1002`): a 45 % black wash with a 45-degree hatch and
/// a pause glyph.
fn render_hold(x: f32, width: f32) -> impl IntoElement {
    div()
        .absolute()
        .top_0()
        .bottom_0()
        .left(px(x))
        .w(px(width))
        .flex()
        .flex_row()
        .items_center()
        .justify_center()
        .gap(px(4.))
        .overflow_hidden()
        .bg(with_alpha(gpui::black(), 0.45))
        .border_l_1()
        .border_r_1()
        .border_color(with_alpha(gpui::white(), 0.25))
        .child(
            svg()
                .path("icons/pause.svg")
                .size(px(12.))
                .flex_none()
                .text_color(with_alpha(gpui::white(), 0.7)),
        )
        .when(width >= 64., |this| {
            this.child(
                div()
                    .text_size(px(10.))
                    .font_weight(FontWeight::MEDIUM)
                    .text_color(with_alpha(gpui::white(), 0.7))
                    .child("Paused"),
            )
        })
}

/// The mic and system-audio waveforms under a clip (`TL/ClipTrack.tsx:146-351`).
///
/// The source draws them into a `<canvas>` sized to the segment, virtualising
/// anything wider than 2000px down to the visible slice; gpui paints paths
/// directly, so the same slice is computed and handed to
/// [`waveform_path`] through a `canvas` element that knows its own bounds.
#[allow(clippy::too_many_arguments)]
fn render_waveform(
    model: &TimelineModel,
    segment: &Segment,
    recording_clip: u32,
    holds: &[(f64, f64)],
    view: TimelineView,
    width: f32,
    height: f32,
) -> impl IntoElement {
    // `micWaveform()` / `systemAudioWaveform()` (`TL/ClipTrack.tsx:713-730`):
    // a track muted below -30 dB draws nothing at all.
    let mic = (model.mic_volume_db >= WAVEFORM_MUTE_DB)
        .then(|| model.mic_waveforms.get(recording_clip as usize).cloned())
        .flatten()
        .unwrap_or_default();
    let system = (model.system_volume_db >= WAVEFORM_MUTE_DB)
        .then(|| model.system_waveforms.get(recording_clip as usize).cloned())
        .flatten()
        .unwrap_or_default();
    if mic.is_empty() && system.is_empty() {
        return div().into_any_element();
    }

    let mic_scale = gain_to_scale(model.mic_volume_db);
    let system_scale = gain_to_scale(model.system_volume_db);
    let source_start = segment.start;
    let output_duration = (segment.end - segment.start).max(0.0001);
    let holds: Vec<(f64, f64)> = holds
        .iter()
        .map(|(start, end)| (start - segment.start, end - segment.start))
        .collect();
    let transform = view.transform;
    let segment_start = segment.start;
    let full_width = width.max(1.) as f64;

    gpui::canvas(
        |bounds, _window, _cx| bounds,
        move |_, bounds, window, _cx| {
            // The visible slice, in segment-local output seconds
            // (`TL/ClipTrack.tsx:202-245`). Off screen entirely: nothing.
            let view_start = transform.position;
            let view_end = view_start + transform.zoom;
            let visible_start = view_start.max(source_start) - source_start;
            let visible_end = view_end.min(source_start + output_duration) - source_start;
            if visible_end <= visible_start {
                return;
            }
            let px_per_sec = full_width / output_duration;
            let origin = gpui::point(
                bounds.origin.x + px((visible_start * px_per_sec) as f32),
                bounds.origin.y,
            );
            let slice_width = ((visible_end - visible_start) * px_per_sec) as f32;
            let size = gpui::size(px(slice_width), px(height));
            let samples = waveform_sample_count(slice_width as f64);

            for (peaks, color, scale) in [
                (&mic, WAVEFORM_MIC_COLOR, mic_scale),
                (&system, waveform_system_color(), system_scale),
            ] {
                if let Some(path) = waveform_path(
                    peaks,
                    (visible_start, visible_end),
                    samples,
                    &holds,
                    segment_start,
                    origin,
                    size,
                    scale,
                ) {
                    window.paint_path(path, color);
                }
            }
        },
    )
    .absolute()
    .top_0()
    .left_0()
    .w(px(width))
    .h(px(height))
    .into_any_element()
}

/// `SegmentLabel` (`TL/Track.tsx:186-220`): full, compact and glyph tiers,
/// anchored to the visible box's clamped centre and clipped to its width.
fn render_label(
    theme: &Theme,
    kind: TrackKind,
    segment: &Segment,
    visible_width: f64,
    center_x: f64,
) -> impl IntoElement {
    let compact_at = match kind {
        TrackKind::Caption | TrackKind::Keyboard | TrackKind::Audio => {
            SEGMENT_LABEL_COMPACT_TIGHT_PX
        }
        _ => SEGMENT_LABEL_COMPACT_PX,
    };
    let max_width = (visible_width - 8.).max(0.);
    let tier = if visible_width >= SEGMENT_LABEL_FULL_PX {
        LabelTier::Full
    } else if visible_width >= compact_at {
        LabelTier::Compact
    } else if visible_width >= SEGMENT_LABEL_GLYPH_PX {
        LabelTier::Glyph
    } else {
        return div();
    };

    let Some(body) = label_body(theme, segment, tier, visible_width) else {
        return div();
    };

    div().child(
        div()
            .absolute()
            .top_0()
            .bottom_0()
            .left(px((center_x - max_width / 2.) as f32))
            .w(px(max_width as f32))
            .flex()
            .items_center()
            .justify_center()
            .overflow_hidden()
            .child(body),
    )
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum LabelTier {
    Full,
    Compact,
    Glyph,
}

/// The nine tracks' label bodies. Every one is a straight transcription of its
/// `SegmentLabel`'s `full` / `compact` / `glyph` props; a track with no `glyph`
/// prop renders nothing at that tier, which is why this returns an `Option`.
fn label_body(
    theme: &Theme,
    segment: &Segment,
    tier: LabelTier,
    visible_width: f64,
) -> Option<AnyElement> {
    // `text-gray-1 dark:text-gray-12` is the label colour on every track but
    // the clip's, which uses `text-white/70` over `dark:text-gray-12
    // text-gray-1`.
    let on_fill = if theme.is_dark() {
        Hsla::from(theme.gray_12)
    } else {
        Hsla::from(theme.gray_1)
    };

    Some(match (&segment.detail, tier) {
        // -- Clip (`TL/ClipTrack.tsx:1255-1279`) --------------------------
        (
            SegmentDetail::Clip {
                name,
                source_duration,
                timescale,
                ..
            },
            LabelTier::Full,
        ) => div()
            .flex()
            .flex_col()
            .gap(px(4.))
            .items_center()
            .justify_center()
            .text_size(px(12.))
            .child(
                div()
                    .text_color(with_alpha(gpui::white(), 0.7))
                    .child(name.clone()),
            )
            .child(
                div()
                    .flex()
                    .flex_row()
                    .gap(px(4.))
                    .items_center()
                    .text_size(px(16.))
                    .text_color(on_fill)
                    .child(
                        svg()
                            .path("icons/clock.svg")
                            .size(px(14.))
                            .flex_none()
                            .text_color(on_fill),
                    )
                    .child(format_clip_time(*source_duration))
                    .when(*timescale != 1., |this| {
                        this.child(format!("{timescale}x"))
                    }),
            )
            .into_any_element(),
        (
            SegmentDetail::Clip {
                source_duration,
                timescale,
                ..
            },
            LabelTier::Compact,
        ) => div()
            .flex()
            .flex_row()
            .gap(px(4.))
            .items_center()
            .text_size(px(10.))
            .text_color(on_fill)
            .when(*timescale != 1., |this| {
                this.child(format!("{timescale}x"))
            })
            .child(div().truncate().child(format_clip_time(*source_duration)))
            .into_any_element(),
        // The clip's glyph tier exists only for a segment whose speed was
        // changed (`TL/ClipTrack.tsx:1274-1278`).
        (SegmentDetail::Clip { timescale, .. }, LabelTier::Glyph) => {
            if *timescale == 1. {
                return None;
            }
            div()
                .text_size(px(10.))
                .text_color(on_fill)
                .child(format!("{timescale}x"))
                .into_any_element()
        }

        // -- Zoom (`TL/ZoomTrack.tsx:696-723`) ----------------------------
        (SegmentDetail::Zoom { amount, automatic }, LabelTier::Full) => div()
            .flex()
            .flex_col()
            .gap(px(4.))
            .items_center()
            .justify_center()
            .text_size(px(12.))
            .text_color(on_fill)
            .child(
                div().opacity(0.7).child(SharedString::from(
                    // The mode label only appears once the visible box is at
                    // least 140px wide (`TL/ZoomTrack.tsx:700-704`).
                    if visible_width >= 140. {
                        if *automatic {
                            "Automatic Zoom"
                        } else {
                            "Manual Zoom"
                        }
                    } else {
                        "Zoom"
                    },
                )),
            )
            .child(
                div()
                    .flex()
                    .flex_row()
                    .gap(px(4.))
                    .items_center()
                    .text_size(px(16.))
                    .child(
                        svg()
                            .path("icons/search.svg")
                            .size(px(14.))
                            .flex_none()
                            .text_color(on_fill),
                    )
                    .child(format!("{amount:.1}x")),
            )
            .into_any_element(),
        (SegmentDetail::Zoom { amount, .. }, LabelTier::Compact) => div()
            .flex()
            .flex_row()
            .gap(px(4.))
            .items_center()
            .text_size(px(12.))
            .text_color(on_fill)
            .child(
                svg()
                    .path("icons/search.svg")
                    .size(px(12.))
                    .flex_none()
                    .text_color(on_fill),
            )
            .child(format!("{amount:.1}x"))
            .into_any_element(),
        (SegmentDetail::Zoom { .. }, LabelTier::Glyph) => svg()
            .path("icons/search.svg")
            .size(px(14.))
            .text_color(on_fill)
            .into_any_element(),

        // -- Scene (`TL/SceneTrack.tsx:543-566`) --------------------------
        (SegmentDetail::Scene { mode }, LabelTier::Full) => div()
            .flex()
            .flex_col()
            .gap(px(4.))
            .items_center()
            .justify_center()
            .text_size(px(12.))
            .text_color(on_fill)
            .child(div().opacity(0.7).child("Scene"))
            .child(
                div()
                    .flex()
                    .flex_row()
                    .gap(px(4.))
                    .items_center()
                    .child(
                        svg()
                            .path(scene_icon(*mode))
                            .size(px(14.))
                            .flex_none()
                            .text_color(on_fill),
                    )
                    .child(scene_label(*mode)),
            )
            .into_any_element(),
        (SegmentDetail::Scene { mode }, LabelTier::Compact) => div()
            .flex()
            .flex_row()
            .gap(px(4.))
            .items_center()
            .text_size(px(12.))
            .text_color(on_fill)
            .child(
                svg()
                    .path(scene_icon(*mode))
                    .size(px(14.))
                    .flex_none()
                    .text_color(on_fill),
            )
            .child(scene_label(*mode))
            .into_any_element(),
        (SegmentDetail::Scene { mode }, LabelTier::Glyph) => svg()
            .path(scene_icon(*mode))
            .size(px(14.))
            .text_color(on_fill)
            .into_any_element(),

        // -- 3D (`TL/ThreeDTrack.tsx:655-687`) ----------------------------
        (SegmentDetail::ThreeD { motion }, LabelTier::Full) => div()
            .flex()
            .flex_col()
            .gap(px(4.))
            .items_center()
            .justify_center()
            .text_size(px(12.))
            .text_color(on_fill)
            .child(div().opacity(0.7).child(if visible_width >= 140. {
                "3D Perspective"
            } else {
                "3D"
            }))
            .child(
                div()
                    .flex()
                    .flex_row()
                    .gap(px(4.))
                    .items_center()
                    .text_size(px(16.))
                    .child(
                        svg()
                            .path("icons/rotate-3d.svg")
                            .size(px(14.))
                            .flex_none()
                            .text_color(on_fill),
                    )
                    .child(if *motion { "Motion" } else { "Still" })
                    .when(*motion, |this| {
                        this.child(
                            svg()
                                .path("icons/chevron-right.svg")
                                .size(px(12.))
                                .flex_none()
                                .opacity(0.7)
                                .text_color(on_fill),
                        )
                    }),
            )
            .into_any_element(),
        (SegmentDetail::ThreeD { .. }, LabelTier::Compact) => div()
            .flex()
            .flex_row()
            .gap(px(4.))
            .items_center()
            .text_size(px(12.))
            .text_color(on_fill)
            .child(
                svg()
                    .path("icons/rotate-3d.svg")
                    .size(px(12.))
                    .flex_none()
                    .text_color(on_fill),
            )
            .child("3D")
            .into_any_element(),
        (SegmentDetail::ThreeD { .. }, LabelTier::Glyph) => svg()
            .path("icons/rotate-3d.svg")
            .size(px(14.))
            .text_color(on_fill)
            .into_any_element(),

        // -- Text (`TL/TextTrack.tsx:428-481`) ----------------------------
        (
            SegmentDetail::Text {
                content,
                color,
                italic,
                bold,
                fullscreen,
                ..
            },
            LabelTier::Full,
        ) => div()
            .flex()
            .flex_col()
            .gap(px(2.))
            .items_center()
            .justify_center()
            .text_size(px(12.))
            .text_color(on_fill)
            .child(
                div()
                    .flex()
                    .flex_row()
                    .gap(px(4.))
                    .items_center()
                    .opacity(0.7)
                    .child("Text")
                    .when(*fullscreen, |this| {
                        this.child(
                            svg()
                                .path("icons/pause.svg")
                                .size(px(10.))
                                .flex_none()
                                .text_color(on_fill),
                        )
                    }),
            )
            .child(text_content_row(content, *color, *italic, *bold, on_fill))
            .into_any_element(),
        (
            SegmentDetail::Text {
                content,
                color,
                italic,
                bold,
                ..
            },
            LabelTier::Compact,
        ) => text_content_row(content, *color, *italic, *bold, on_fill).into_any_element(),
        (SegmentDetail::Text { fullscreen, .. }, LabelTier::Glyph) => {
            if !*fullscreen {
                return None;
            }
            svg()
                .path("icons/pause.svg")
                .size(px(10.))
                .opacity(0.7)
                .text_color(on_fill)
                .into_any_element()
        }

        // -- Mask (`TL/MaskTrack.tsx:481-495`) ----------------------------
        (SegmentDetail::Mask { label }, LabelTier::Full) => div()
            .flex()
            .flex_col()
            .gap(px(2.))
            .items_center()
            .justify_center()
            .text_size(px(12.))
            .text_color(on_fill)
            .child(div().opacity(0.7).child("Mask"))
            .child(div().text_size(px(16.)).child(*label))
            .into_any_element(),
        (SegmentDetail::Mask { label }, LabelTier::Compact) => div()
            .text_size(px(12.))
            .text_color(on_fill)
            .truncate()
            .child(*label)
            .into_any_element(),
        // The mask track passes no `glyph`.
        (SegmentDetail::Mask { .. }, LabelTier::Glyph) => return None,

        // -- Audio (`TL/AudioTrack.tsx:532-549`) --------------------------
        (SegmentDetail::Audio { name, .. }, LabelTier::Full) => div()
            .flex()
            .flex_row()
            .gap(px(6.))
            .items_center()
            .text_size(px(12.))
            .text_color(with_alpha(gpui::white(), 0.95))
            .child(
                svg()
                    .path("icons/music.svg")
                    .size(px(12.))
                    .flex_none()
                    .opacity(0.9)
                    .text_color(with_alpha(gpui::white(), 0.95)),
            )
            .child(
                div()
                    .font_weight(FontWeight::MEDIUM)
                    .truncate()
                    .child(name.clone()),
            )
            .into_any_element(),
        (SegmentDetail::Audio { name, .. }, LabelTier::Compact) => div()
            .text_size(px(12.))
            .font_weight(FontWeight::MEDIUM)
            .truncate()
            .text_color(with_alpha(gpui::white(), 0.95))
            .child(SharedString::from(name.clone()))
            .into_any_element(),
        (SegmentDetail::Audio { .. }, LabelTier::Glyph) => return None,

        // -- Captions (`TL/CaptionsTrack.tsx:174-181, 268-272`) -----------
        // One row serves both tiers; it just clips against a smaller box.
        (SegmentDetail::Caption { text }, LabelTier::Full | LabelTier::Compact) => div()
            .text_size(px(10.))
            .opacity(0.8)
            .truncate()
            .text_color(on_fill)
            .child(text.clone())
            .into_any_element(),
        (SegmentDetail::Caption { .. }, LabelTier::Glyph) => return None,

        // -- Keyboard (`TL/KeyboardTrack.tsx:166-173, 260-268`) -----------
        (SegmentDetail::Keyboard { text }, LabelTier::Full | LabelTier::Compact) => div()
            .font_family("monospace")
            .text_size(px(10.))
            .opacity(0.8)
            .truncate()
            .text_color(on_fill)
            .child(text.clone())
            .into_any_element(),
        (SegmentDetail::Keyboard { .. }, LabelTier::Glyph) => div()
            .font_family("monospace")
            .text_size(px(10.))
            .opacity(0.8)
            .text_color(on_fill)
            .child("\u{2328}")
            .into_any_element(),
    })
}

/// `textContentRow` (`TL/TextTrack.tsx:428-450`): the segment's own colour as a
/// 8px swatch, then its content in the segment's weight and slant.
fn text_content_row(
    content: &SharedString,
    color: Hsla,
    italic: bool,
    bold: bool,
    on_fill: Hsla,
) -> impl IntoElement {
    div()
        .flex()
        .flex_row()
        .gap(px(6.))
        .items_center()
        .justify_center()
        .max_w_full()
        .text_size(px(16.))
        .text_color(on_fill)
        .child(
            div()
                .size(px(8.))
                .flex_none()
                .rounded_full()
                .border_1()
                .border_color(with_alpha(gpui::white(), 0.4))
                .bg(color),
        )
        .child(
            div()
                .truncate()
                .max_w_full()
                .when(bold, |this| this.font_weight(FontWeight::BOLD))
                .when(italic, |this| this.italic())
                .child(content.clone()),
        )
}

/// The playhead (`TL/index.tsx:1279-1295`) and the hover ghost (`:1255-1277`).
///
/// Both are a 1px column from `PLAYHEAD_TOP_OFFSET` to the container's bottom
/// with a 12px knob at the top; the ghost is grey and the playhead red, and the
/// playhead's own x is additionally clamped to the timeline width so it parks
/// at the right edge instead of running off it.
/// `translateX(min((playbackTime - position) / secsPerPixel, timelineWidth))`
/// (`TL/index.tsx:1287-1291`). Only the **upper** bound is clamped, so a
/// playhead left of the viewport really does run off the left edge and the
/// container's `overflow-hidden` is what hides it.
pub fn playhead_offset(view: TimelineView, content_width: f32) -> f32 {
    let secs_per_pixel = view.transform.secs_per_pixel(content_width);
    ((((view.playhead - view.transform.position) / secs_per_pixel) as f32).min(content_width))
        .max(-content_width)
}

/// The hover ghost's offset (`TL/index.tsx:1246-1267`): shown only while
/// paused, with no `splitPreview` in flight, and **not** clamped at either end.
pub fn ghost_offset(view: TimelineView, content_width: f32) -> Option<f32> {
    if view.playing {
        return None;
    }
    let secs_per_pixel = view.transform.secs_per_pixel(content_width);
    view.preview_time
        .map(|time| ((time - view.transform.position) / secs_per_pixel) as f32)
}

pub fn render_playhead(color: Hsla, x: f32, knob_color: Hsla) -> AnyElement {
    div()
        .absolute()
        // `left: ${TIMELINE_PADDING + TRACK_GUTTER}px` (`TL/index.tsx:1285`),
        // i.e. 128 from the container's own left edge -- which is where gpui
        // resolves an absolutely positioned child from too.
        .left(px(TIMELINE_PADDING + TRACK_GUTTER + x))
        .top(px(PLAYHEAD_TOP_OFFSET))
        .bottom_0()
        .w(px(1.))
        .rounded_full()
        .bg(playhead_gradient(color))
        .child(
            // `size-3 rounded-full -mt-2 -ml-[calc(0.37rem-0.5px)]`: a 12px dot
            // 8px above the top of the column and half a pixel left of centre.
            div()
                .absolute()
                .top(px(-8.))
                .left(px(-5.42))
                .size(px(12.))
                .rounded_full()
                .bg(knob_color),
        )
        .into_any_element()
}

/// The per-track selected border (`TL/index.tsx` per-track `segColor` blocks,
/// enumerated in the digest's 4.3).
///
/// **`border-green-7` (captions) and `border-sky-7` (keyboard) are dead
/// classes in the shipping app.** `theme.css` imports Radix
/// red/gray/blue/indigo/yellow/jade only, and `packages/ui-solid/src/main.css`
/// maps `--color-emerald-*` to jade and `--color-blue-*` to blue but declares
/// no `--color-green-*` or `--color-sky-*`, so Tailwind v4 generates no rule
/// for either. Selecting a caption or keyboard segment changes nothing on
/// screen today.
pub fn selected_border_color(theme: &Theme, kind: TrackKind) -> Hsla {
    match kind {
        // `border-gray-12`.
        TrackKind::Clip | TrackKind::Zoom | TrackKind::Scene | TrackKind::ThreeD | TrackKind::Mask => {
            Hsla::from(theme.gray_12)
        }
        // `border-blue-7`: Radix blue-7 is `#205d9e` light / `#8ec8f6` dark.
        TrackKind::Text => {
            if theme.is_dark() {
                gpui::rgb(0x8ec8f6).into()
            } else {
                gpui::rgb(0x205d9e).into()
            }
        }
        // `border-emerald-11` -> `var(--jade-11)`: `#208368` light,
        // `#1fd8a4` dark.
        TrackKind::Audio => {
            if theme.is_dark() {
                gpui::rgb(0x1fd8a4).into()
            } else {
                gpui::rgb(0x208368).into()
            }
        }
        // The two dead ones; drawn as transparent so nothing is invented.
        TrackKind::Caption | TrackKind::Keyboard => gpui::transparent_black(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // -- The ruler ----------------------------------------------------------

    #[test]
    fn marking_resolution_walks_the_ladder() {
        assert_eq!(marking_resolution(5.0), 0.5);
        assert_eq!(marking_resolution(10.0), 0.5);
        // 10.5 / 0.5 = 21 > 20, so it steps up.
        assert_eq!(marking_resolution(10.5), 1.0);
        assert_eq!(marking_resolution(20.0), 1.0);
        assert_eq!(marking_resolution(20.5), 2.5);
        assert_eq!(marking_resolution(50.0), 2.5);
        assert_eq!(marking_resolution(50.5), 5.0);
        assert_eq!(marking_resolution(100.0), 5.0);
        assert_eq!(marking_resolution(100.5), 10.0);
        assert_eq!(marking_resolution(200.0), 10.0);
        assert_eq!(marking_resolution(200.5), 30.0);
        // Past the ladder's end it stays at 30 rather than growing.
        assert_eq!(marking_resolution(5000.0), 30.0);
        // Degenerate zooms must not panic or pick something absurd.
        assert_eq!(marking_resolution(0.0), 0.5);
        assert_eq!(marking_resolution(f64::INFINITY), 30.0);
    }

    /// The ruler's tick grid is absolute, not viewport-relative: panning by a
    /// fraction of a resolution step slides the marks, it does not renumber
    /// them.
    #[test]
    fn ruler_marks_sit_on_the_absolute_resolution_grid() {
        let resolution = marking_resolution(15.0);
        assert_eq!(resolution, 1.0);
        let position = 7.4;
        let offset = position % resolution;
        let first = position - offset;
        assert!((first - 7.0).abs() < 1e-9, "{first}");
        let second = first + resolution;
        assert!((second - 8.0).abs() < 1e-9, "{second}");
    }

    // -- The transform ------------------------------------------------------

    #[test]
    fn initial_zoom_is_the_zoom_out_limit() {
        assert_eq!(Transform::initial(15.9).zoom, 15.9);
        assert_eq!(Transform::initial(0.0).position, 0.0);
        // `Math.min(totalDuration(), 60 * 10)`.
        assert_eq!(Transform::initial(3_600.0).zoom, 600.0);
    }

    #[test]
    fn zoom_clamps_to_max_zoom_in_and_the_zoom_out_limit() {
        let total = 60.0;
        let mut transform = Transform::initial(total);
        transform.update_zoom(0.001, 0., total);
        assert_eq!(transform.zoom, MAX_ZOOM_IN);
        transform.update_zoom(9_000., 0., total);
        assert_eq!(transform.zoom, 60.0);
        // The order of the clamp matters: on a project shorter than
        // MAX_ZOOM_IN the floor wins and the viewport shows more than exists.
        let mut short = Transform::initial(1.0);
        short.update_zoom(0.5, 0., 1.0);
        assert_eq!(short.zoom, MAX_ZOOM_IN);
    }

    /// `updateZoom` keeps `origin` at the same fractional x across the change.
    #[test]
    fn zooming_keeps_the_origin_under_the_same_pixel() {
        let total = 100.0;
        let mut transform = Transform {
            zoom: 40.,
            position: 20.,
        };
        // The origin sits a quarter of the way across the viewport.
        let origin = 30.0;
        let before = (origin - transform.position) / transform.zoom;
        transform.update_zoom(20., origin, total);
        let after = (origin - transform.position) / transform.zoom;
        assert!((before - after).abs() < 1e-9, "{before} vs {after}");
        assert_eq!(transform.zoom, 20.);
        assert!((transform.position - 25.).abs() < 1e-9, "{}", transform.position);
    }

    /// `originPercentage` is capped at 1, so an origin past the right edge
    /// pins to the edge rather than flying off.
    #[test]
    fn an_origin_past_the_viewport_pins_to_its_right_edge() {
        let total = 100.0;
        let mut transform = Transform {
            zoom: 10.,
            position: 0.,
        };
        transform.update_zoom(5., 80., total);
        // originPercentage = min(1, 80/10) = 1, so position = 80 - 5 = 75.
        assert!((transform.position - 75.).abs() < 1e-9, "{}", transform.position);
    }

    #[test]
    fn position_clamps_to_zero_and_to_the_content_end_plus_four() {
        let total = 60.0;
        let mut transform = Transform {
            zoom: 10.,
            position: 0.,
        };
        transform.set_position(-40., total);
        assert_eq!(transform.position, 0.);
        transform.set_position(10_000., total);
        // `max(zoomOutLimit, totalDuration) + 4 - zoom`.
        assert_eq!(transform.position, 60. + 4. - 10.);
        // Zoomed all the way out there is nowhere to pan except the 4s of
        // slack.
        let mut wide = Transform::initial(total);
        wide.set_position(100., total);
        assert_eq!(wide.position, 4.);
    }

    /// A project longer than the 600s zoom-out limit can still be panned to
    /// its end: the clamp uses `max(zoomOutLimit, totalDuration)`.
    #[test]
    fn a_long_project_can_pan_past_the_zoom_out_limit() {
        let total = 1_800.0;
        let mut transform = Transform::initial(total);
        assert_eq!(transform.zoom, 600.);
        transform.set_position(10_000., total);
        assert_eq!(transform.position, 1_800. + 4. - 600.);
    }

    #[test]
    fn the_slider_maps_zoom_to_its_inverse_fraction() {
        let total = 60.0;
        let out = Transform::initial(total);
        assert_eq!(out.slider_fraction(total), 0.0, "fully out is fully left");
        let mut halfway = out;
        halfway.apply_slider(0.5, 0., total);
        assert_eq!(halfway.zoom, 30.);
        assert!((halfway.slider_fraction(total) - 0.5).abs() < 1e-6);
        // The top of the slider asks for zoom 0, which the clamp lifts to
        // MAX_ZOOM_IN -- so the readout does not reach 1.
        let mut all_the_way = out;
        all_the_way.apply_slider(1.0, 0., total);
        assert_eq!(all_the_way.zoom, MAX_ZOOM_IN);
    }

    /// `Mod+=` is `zoom / 1.1` and `Mod+-` is `zoom * 1.1`, both anchored on
    /// `editorState.playbackTime` (`Player.tsx:256-271`) -- **not** on the
    /// pointer, and not on `previewTime`.
    #[test]
    fn the_keyboard_zoom_steps_are_a_tenth_either_way() {
        let total = 60.0;
        let mut transform = Transform::initial(total);
        let playhead = 12.0;
        transform.update_zoom(transform.zoom / 1.1, playhead, total);
        assert!((transform.zoom - 60. / 1.1).abs() < 1e-9, "{}", transform.zoom);
        transform.update_zoom(transform.zoom * 1.1, playhead, total);
        assert!((transform.zoom - 60.).abs() < 1e-9, "{}", transform.zoom);
    }

    /// The wheel's zoom step (`TL/index.tsx:1191`):
    /// `zoomDelta = deltaY * sqrt(zoom) / 30`, applied as `zoom + zoomDelta`.
    #[test]
    fn the_wheel_zoom_step_scales_with_the_square_root_of_the_zoom() {
        let delta_y = 30.0;
        assert!((wheel_zoom_delta(delta_y, 100.) - 10.).abs() < 1e-9);
        assert!((wheel_zoom_delta(delta_y, 25.) - 5.).abs() < 1e-9);
        // Scrolling the other way zooms in.
        assert!(wheel_zoom_delta(-delta_y, 100.) < 0.);
    }

    #[test]
    fn the_on_mount_fit_leaves_a_short_project_alone() {
        // 1111px of content and 15.9s: 15.9 < 1111/80 = 13.9? No -- 15.9 is
        // larger, so it zooms in to 13.89.
        let total = 15.9;
        let mut transform = Transform::initial(total);
        transform.fit_on_mount(1111., total);
        assert!((transform.zoom - 1111. / 80.).abs() < 1e-9, "{}", transform.zoom);
        // A project that already fits is untouched.
        let mut wide = Transform::initial(5.0);
        let before = wide.zoom;
        wide.fit_on_mount(1111., 5.0);
        assert_eq!(wide.zoom, before);
    }

    // -- Geometry -----------------------------------------------------------

    /// The editor's default width: 1275 - 16 (slot) - 32 (padding) - 4 (`pr-1`)
    /// - 112 (gutter) = 1111px of track content starting at x = 136, with the
    /// ruler's own strip four pixels wider.
    #[test]
    fn the_content_column_carries_the_scroll_bodys_padding() {
        assert_eq!(content_width(1275.), 1111.);
        assert_eq!(ruler_width(1275.), 1115.);
        assert_eq!(content_left(), 136.);
    }

    #[test]
    fn a_click_maps_x_to_time_through_the_transform() {
        let width = 1275.;
        let total = 60.0;
        let transform = Transform::initial(total);
        let content = content_width(width);

        assert!(time_from_x(136., width, transform, total).abs() < 1e-9);
        let end = time_from_x(136. + content, width, transform, total);
        assert!((end - total).abs() < 1e-6, "{end}");
        let middle = time_from_x(136. + content / 2., width, transform, total);
        assert!((middle - total / 2.).abs() < 1e-6, "{middle}");
    }

    #[test]
    fn a_click_snaps_to_zero_and_clamps() {
        let width = 1275.;
        let total = 60.0;
        let transform = Transform::initial(total);
        assert_eq!(time_from_x(136. + 9., width, transform, total), 0.0);
        assert!(time_from_x(136. + 11., width, transform, total) > 0.0);
        assert_eq!(time_from_x(0., width, transform, total), 0.0);
        assert_eq!(time_from_x(9_000., width, transform, total), total);
    }

    /// A panned viewport moves the mapping with it -- `position` is seconds at
    /// the left edge.
    #[test]
    fn a_click_respects_the_transform_position() {
        let width = 1275.;
        let transform = Transform {
            zoom: 10.,
            position: 20.,
        };
        let time = time_from_x(136. + content_width(width) / 2., width, transform, 600.);
        assert!((time - 25.0).abs() < 1e-6, "{time}");
    }

    /// The hover preview is *not* the click mapping: outside the content
    /// column it clears rather than clamping, and it has no upper bound.
    #[test]
    fn the_hover_preview_clears_outside_the_content_column() {
        let width = 1275.;
        let transform = Transform::initial(60.);
        assert_eq!(preview_time_from_x(135., width, transform), None);
        assert_eq!(
            preview_time_from_x(136. + content_width(width) + 1., width, transform),
            None
        );
        assert_eq!(preview_time_from_x(136. + 5., width, transform), Some(0.));
        let middle = preview_time_from_x(136. + content_width(width) / 2., width, transform);
        assert!((middle.unwrap() - 30.).abs() < 1e-6);
    }

    // -- Labels -------------------------------------------------------------

    /// `useSegmentVisibleBox`: a segment wider than the viewport has its true
    /// centre off screen, so the label anchors to the middle of the *visible*
    /// slice instead.
    #[test]
    fn a_label_anchors_to_the_visible_slice_of_a_wide_segment() {
        let transform = Transform {
            zoom: 10.,
            position: 0.,
        };
        let secs_per_pixel = transform.secs_per_pixel(1000.);
        // A 100s segment in a 10s viewport: 1000px visible of a 10000px box.
        let (width, center) = visible_box(0., 100., transform, secs_per_pixel);
        assert!((width - 1000.).abs() < 1e-6, "{width}");
        // Centre of the visible slice, not of the segment.
        assert!((center - 500.).abs() < 1e-6, "{center}");

        // Scrolled to the middle: the visible slice moves with it.
        let scrolled = Transform {
            zoom: 10.,
            position: 40.,
        };
        let (_, center) = visible_box(0., 100., scrolled, secs_per_pixel);
        assert!((center - 4_500.).abs() < 1e-6, "{center}");
    }

    /// The margin shrinks with the visible slice so a segment hanging off the
    /// left edge keeps its label on screen.
    #[test]
    fn a_sliver_of_a_segment_still_gets_a_label_position() {
        let transform = Transform {
            zoom: 10.,
            position: 0.,
        };
        let secs_per_pixel = transform.secs_per_pixel(1000.);
        // Only the last 0.2s of a 50s segment starting at -49.8 is visible.
        let (width, center) = visible_box(-49.8, 0.2, transform, secs_per_pixel);
        assert!((width - 20.).abs() < 1e-6, "{width}");
        assert!(center > 0., "{center}");
        assert!(center <= 5_000., "{center}");
    }

    // -- The model ----------------------------------------------------------

    #[test]
    fn lane_counts_follow_the_highest_used_lane() {
        let segment = |lane: u32| Segment {
            start: 0.,
            end: 1.,
            lane,
            detail: SegmentDetail::Mask { label: "Highlight" },
        };
        assert_eq!(lane_count(&[]), 0);
        assert_eq!(lane_count(&[segment(0)]), 1);
        // A gap still produces the rows below it -- lane 1 exists because
        // lane 2 is used.
        assert_eq!(lane_count(&[segment(0), segment(2)]), 3);
    }

    #[test]
    fn holds_push_a_gapless_timestamp_into_output_time() {
        let holds = [(2.0, 5.0), (8.0, 9.0)];
        assert_eq!(effective_to_output(&holds, 1.0), 1.0);
        // Landing exactly on a hold's start still passes it.
        assert_eq!(effective_to_output(&holds, 2.0), 5.0);
        assert_eq!(effective_to_output(&holds, 3.0), 6.0);
        // Past both.
        assert_eq!(effective_to_output(&holds, 8.5), 12.5);
        assert_eq!(effective_to_output(&[], 4.0), 4.0);
    }

    /// The whole model, built from JSON the way a real `project-config.json`
    /// arrives: the row order is the source's mount order, multi-lane tracks
    /// contribute one row per used lane, and the two locked tracks are always
    /// there.
    #[test]
    fn the_row_order_is_the_sources_mount_order() {
        let config: ProjectConfiguration = serde_json::from_value(serde_json::json!({
            "timeline": {
                "segments": [{ "recordingSegment": 0, "timescale": 1.0, "start": 0.0, "end": 20.0 }],
                "zoomSegments": [],
                "textSegments": [
                    { "start": 1.0, "end": 2.0, "track": 0, "content": "a" },
                    { "start": 3.0, "end": 4.0, "track": 2, "content": "b" }
                ],
                "maskSegments": [
                    { "start": 1.0, "end": 2.0, "track": 0, "maskType": "sensitive",
                      "center": {"x": 0.5, "y": 0.5}, "size": {"x": 0.2, "y": 0.2} }
                ],
                "audioSegments": [
                    { "start": 1.0, "end": 2.0, "track": 0, "path": "/tmp/none.mp3" }
                ],
                "captionSegments": [{ "id": "c", "start": 0.0, "end": 1.0, "text": "hi" }],
                "keyboardSegments": [],
                "camera3dSegments": [{ "start": 1.0, "end": 2.0 }],
                "sceneSegments": []
            },
            "keyboard": { "settings": { "enabled": true } }
        }))
        .expect("the fixture parses");

        let model = TimelineModel::build(&config, true, false);
        let rows: Vec<(TrackKind, u32)> = model
            .rows
            .iter()
            .map(|row| (row.kind, row.lane))
            .collect();
        assert_eq!(
            rows,
            vec![
                (TrackKind::Clip, 0),
                // Captions: no settings block, but the project has a caption
                // segment, which is the fallback (`ED/context.ts:1414-1416`).
                (TrackKind::Caption, 0),
                (TrackKind::Keyboard, 0),
                // Lane 1 exists because lane 2 is used.
                (TrackKind::Text, 0),
                (TrackKind::Text, 1),
                (TrackKind::Text, 2),
                (TrackKind::Mask, 0),
                (TrackKind::Audio, 0),
                (TrackKind::Zoom, 0),
                (TrackKind::ThreeD, 0),
                (TrackKind::Scene, 0),
            ]
        );
        // 11 rows > 2, so the compact height.
        assert_eq!(model.track_height(), TRACK_HEIGHT_COMPACT);
        assert_eq!(model.clips.len(), 1);
        assert!((model.total_duration - 20.0).abs() < 1e-9);
    }

    /// Scene needs a camera *and* an unhidden one; 3D only appears when the
    /// project already has a camera3d segment.
    #[test]
    fn the_scene_row_is_gated_on_the_recordings_camera() {
        let base = serde_json::json!({
            "timeline": {
                "segments": [{ "recordingSegment": 0, "timescale": 1.0, "start": 0.0, "end": 5.0 }],
                "zoomSegments": []
            }
        });
        let config: ProjectConfiguration = serde_json::from_value(base.clone()).unwrap();

        let with_camera = TimelineModel::build(&config, true, false);
        assert_eq!(
            with_camera.rows.len(),
            3,
            "clip + zoom + scene: {:?}",
            with_camera.rows
        );
        // Two rows means the roomier track height.
        let without_camera = TimelineModel::build(&config, false, false);
        assert_eq!(without_camera.rows.len(), 2);
        assert_eq!(without_camera.track_height(), TRACK_HEIGHT_ROOMY);

        // `project.camera.hide` takes the row away again.
        let mut hidden = base;
        hidden["camera"] = serde_json::json!({ "hide": true });
        let hidden: ProjectConfiguration = serde_json::from_value(hidden).unwrap();
        assert_eq!(TimelineModel::build(&hidden, true, false).rows.len(), 2);
    }

    /// A fullscreen text segment pauses the recording clock, so the clip box
    /// stretches across the inserted time and carries the hold as a band.
    #[test]
    fn a_fullscreen_text_segment_stretches_the_clip_box() {
        let config: ProjectConfiguration = serde_json::from_value(serde_json::json!({
            "timeline": {
                "segments": [{ "recordingSegment": 0, "timescale": 1.0, "start": 0.0, "end": 20.0 }],
                "zoomSegments": [],
                "textSegments": [
                    { "start": 8.0, "end": 11.0, "track": 0, "content": "x", "layout": "fullscreen" }
                ]
            }
        }))
        .unwrap();

        let model = TimelineModel::build(&config, false, false);
        // 20s of footage plus a 3s pause.
        assert!((model.total_duration - 23.0).abs() < 1e-9, "{}", model.total_duration);
        let clip = &model.clips[0];
        assert_eq!((clip.start, clip.end), (0.0, 23.0));
        let SegmentDetail::Clip {
            holds,
            source_duration,
            ..
        } = &clip.detail
        else {
            panic!("not a clip")
        };
        assert_eq!(&holds[..], &[(8.0, 11.0)]);
        // The label still reports the *source* span, not the stretched box.
        assert!((source_duration - 20.0).abs() < 1e-9);
    }

    /// A crossfade overlaps the two clips it joins: the second clip starts
    /// `duration` earlier than its gapless offset, and the timeline is that
    /// much shorter.
    #[test]
    fn a_transition_pulls_the_next_clip_backwards() {
        let config: ProjectConfiguration = serde_json::from_value(serde_json::json!({
            "timeline": {
                "segments": [
                    { "recordingSegment": 0, "timescale": 1.0, "start": 0.0, "end": 10.0 },
                    { "recordingSegment": 1, "timescale": 1.0, "start": 0.0, "end": 10.0 }
                ],
                "transitions": [{ "segmentIndex": 1, "type": "cross-fade", "duration": 0.6 }],
                "zoomSegments": []
            }
        }))
        .unwrap();

        let model = TimelineModel::build(&config, false, true);
        assert_eq!(model.clip_boundaries, vec![0.0, 9.4]);
        assert!((model.total_duration - 19.4).abs() < 1e-9);
        // More than one recording clip, so the labels are numbered.
        let SegmentDetail::Clip { name, .. } = &model.clips[1].detail else {
            panic!("not a clip")
        };
        assert_eq!(name.as_ref(), "Clip 1");
    }

    #[test]
    fn hex_colours_parse_in_both_lengths() {
        assert_eq!(parse_hex_color("#ffffff"), Some(gpui::white()));
        assert_eq!(parse_hex_color("#fff"), Some(gpui::white()));
        assert_eq!(parse_hex_color("#000000"), Some(gpui::rgb(0).into()));
        assert_eq!(parse_hex_color("nope"), None);
        assert_eq!(parse_hex_color("#12"), None);
    }

    // -- The zoom track's new-segment ghost ---------------------------------

    /// `newSegmentDetails` (`TL/ZoomTrack.tsx:104-166`), which is both the
    /// hover affordance and where a click places a segment.
    #[test]
    fn the_zoom_ghost_finds_the_gap_under_the_pointer() {
        let zoom = |start: f64, end: f64| Segment {
            start,
            end,
            lane: 0,
            detail: SegmentDetail::Zoom {
                amount: 1.5,
                automatic: true,
            },
        };
        let model = TimelineModel {
            zoom: vec![zoom(2.0, 5.0), zoom(20.0, 24.0)],
            total_duration: 30.,
            ..TimelineModel::default()
        };
        // 80px at this scale is 1s, so `MIN_NEW_SEGMENT_SECS_WIDTH` wins.
        let secs_per_pixel = 10. / 1000.;
        let min = 1.0;

        // In open water: a `min`-long segment starting at the pointer.
        assert_eq!(
            new_zoom_segment(&model, 10.0, secs_per_pixel),
            Some((10.0, 10.0 + min))
        );
        // Inside an existing segment: nothing.
        assert_eq!(new_zoom_segment(&model, 3.0, secs_per_pixel), None);
        // Exactly on a segment's start is a quirk worth pinning: the
        // inside-test is strict (`previewTime > prev.start`), so it passes,
        // but `next` then resolves to that *same* segment and the
        // available-gap check reads `next.start - prev.end` = -3 < min. The
        // source returns nothing there and so does this.
        assert_eq!(new_zoom_segment(&model, 2.0, secs_per_pixel), None);
        // Within a second of the next segment: the ghost backs up against it
        // instead of overlapping.
        assert_eq!(
            new_zoom_segment(&model, 19.5, secs_per_pixel),
            Some((20.0 - min, 20.0))
        );
        // A gap too small to hold one: nothing.
        let tight = TimelineModel {
            zoom: vec![zoom(2.0, 5.0), zoom(5.4, 8.0)],
            ..model.clone()
        };
        assert_eq!(new_zoom_segment(&tight, 5.2, secs_per_pixel), None);

        // Zoomed in far enough that 80px is more than a second, the pixel
        // floor takes over.
        let wide = new_zoom_segment(&model, 10.0, 60. / 1000.).unwrap();
        assert!((wide.1 - wide.0 - 4.8).abs() < 1e-9, "{wide:?}");
    }

    // -- Waveforms ----------------------------------------------------------

    #[test]
    fn gain_scales_the_waveform_and_mutes_below_thirty_db() {
        assert_eq!(gain_to_scale(0.), 1.);
        assert_eq!(gain_to_scale(-15.), 0.5);
        assert_eq!(gain_to_scale(-30.), 0.);
        assert_eq!(gain_to_scale(-60.), 0.);
        assert_eq!(gain_to_scale(f64::NAN), 1.);
    }

    #[test]
    fn peak_amplitude_maps_dbfs_onto_the_minus_sixty_floor() {
        let peaks = [0.0f32, -30.0, -60.0, -90.0];
        // Index is `floor(time * 10)`.
        assert_eq!(waveform_amplitude(&peaks, Some(0.0)), 1.0);
        assert_eq!(waveform_amplitude(&peaks, Some(0.1)), 0.5);
        assert_eq!(waveform_amplitude(&peaks, Some(0.2)), 0.0);
        // Below the floor clamps rather than going negative.
        assert_eq!(waveform_amplitude(&peaks, Some(0.3)), 0.0);
        // Past the end of the table is silence, not a panic.
        assert_eq!(waveform_amplitude(&peaks, Some(99.0)), 0.0);
        // Inside a hold the mixer renders silence, so the curve drops to zero.
        assert_eq!(waveform_amplitude(&peaks, None), 0.0);
    }

    #[test]
    fn peak_extraction_is_one_value_per_hundred_milliseconds() {
        // Two chunks of full-scale mono at the crate's own sample rate.
        let samples = vec![1.0f32; AUDIO_SAMPLE_RATE / 5];
        let peaks = waveform_peaks(&samples, 1);
        assert_eq!(peaks.len(), 2);
        // 20 * log10(1.0) = 0 dBFS.
        assert!(peaks.iter().all(|value| value.abs() < 1e-4), "{peaks:?}");

        // Stereo halves the chunk count for the same sample buffer: the chunk
        // is `CHUNK_SIZE * channels` wide.
        assert_eq!(waveform_peaks(&samples, 2).len(), 1);

        // Digital silence is pinned to -60 rather than -inf.
        let silent = vec![0.0f32; AUDIO_SAMPLE_RATE / 10];
        assert_eq!(waveform_peaks(&silent, 1), vec![-60.0]);

        // An empty track is an empty table, not a panic.
        assert!(waveform_peaks(&[], 1).is_empty());
    }

    #[test]
    fn the_waveform_sample_count_is_two_per_pixel_up_to_the_cap() {
        assert_eq!(waveform_sample_count(100.), 200);
        assert_eq!(waveform_sample_count(10_000.), MAX_WAVEFORM_SAMPLES);
        assert_eq!(waveform_sample_count(0.), 0);
    }

    // -- The minimap --------------------------------------------------------

    #[test]
    fn the_minimap_chip_never_shrinks_below_its_floor() {
        // A 1-second viewport of an hour, on a 1000px bar: 0.28px of chip,
        // lifted to the 20px floor.
        let total = 3_600.0f64;
        let bar = 1_000.0f32;
        let zoom = 1.0f64;
        let px_per_sec = bar as f64 / total;
        let chip = ((zoom * px_per_sec) as f32)
            .max(MINIMAP_MIN_CHIP_WIDTH)
            .min(bar);
        assert_eq!(chip, MINIMAP_MIN_CHIP_WIDTH);
    }

    // -- The edge fade ------------------------------------------------------

    #[test]
    fn the_edge_fade_ramps_over_fifty_pixels_of_scroll() {
        let model = TimelineModel {
            total_duration: 60.,
            ..TimelineModel::default()
        };
        let at_start = TimelineView {
            transform: Transform {
                zoom: 10.,
                position: 0.,
            },
            ..TimelineView::default()
        };
        let (left, right) = edge_fade_strengths(&model, at_start, 1275.);
        assert_eq!(left, 0., "no fade at the very start");
        assert_eq!(right, 1., "fully faded on the right with 50s off screen");

        let at_end = TimelineView {
            transform: Transform {
                zoom: 10.,
                position: 50.,
            },
            ..TimelineView::default()
        };
        let (left, right) = edge_fade_strengths(&model, at_end, 1275.);
        assert_eq!(left, 1.);
        assert_eq!(right, 0.);
    }
}

/// `zoomDelta = (e.deltaY * Math.sqrt(transform().zoom)) / 30`
/// (`TL/index.tsx:1191`). `deltaY` is the **DOM** sign convention: positive is
/// a scroll downwards, which zooms *out*.
pub fn wheel_zoom_delta(dom_delta_y: f64, zoom: f64) -> f64 {
    dom_delta_y * zoom.max(0.).sqrt() / 30.
}
