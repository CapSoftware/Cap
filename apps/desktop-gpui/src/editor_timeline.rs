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

mod playback_follow;

pub use playback_follow::PlaybackFollow;

use cap_project::{
    Camera3DSegment, CaptionTrackSegment, MaskKind, OverlayTrack, OverlayTrackKind,
    ProjectConfiguration, SceneMode, TextLayout, TimelineConfiguration, ZoomMode,
};
use gpui::{
    AnyElement, FontWeight, Hsla, InteractiveElement, IntoElement, ParentElement, Pixels,
    SharedString, Styled, div, prelude::FluentBuilder, px, svg,
};

use crate::{
    editor_edits::{Selection, clip_is_muted},
    theme::Theme,
};

// ---------------------------------------------------------------------------
// Layout constants (`TL/index.tsx:62-68`)
// ---------------------------------------------------------------------------

/// The hairline the root shell's timeline card draws, and the padding the
/// timeline lays out inside it: the brief's `10px 12px 12px` less that
/// hairline, which every geometry helper below counts as part of the inset.
pub const TIMELINE_CARD_BORDER: f32 = 1.;
pub const TIMELINE_PADDING: f32 = 11.;
pub const TIMELINE_TOP_PADDING: f32 = 9.;
pub const TIMELINE_BOTTOM_PADDING: f32 = 11.;
pub const TRACK_GUTTER_GAP: f32 = 8.;
pub const TRACK_GUTTER: f32 = 104.;
pub const TRACK_ICON_WIDTH: f32 = TRACK_GUTTER - TRACK_GUTTER_GAP;
pub const TIMELINE_HEADER_HEIGHT: f32 = 26.;
/// The playhead hangs from the ruler's baseline, which is the header's bottom
/// edge measured from the card's padding box.
pub const PLAYHEAD_TOP_OFFSET: f32 = TIMELINE_TOP_PADDING + TIMELINE_HEADER_HEIGHT;
/// The snap-to-zero zone at the timeline's origin (`TL/index.tsx:68, 826`).
pub const START_SNAP_PX: f64 = 10.;

/// `px-2` on the timeline slot (`Editor.tsx:781`) -- the card's own left edge
/// in window coordinates.
pub const TIMELINE_SLOT_PADDING: f32 = 8.;
/// `pr-1` on the scroll body (`TL/index.tsx:1326`). The clip track -- which is
/// what `timelineBounds` measures -- sits inside it, so every `secsPerPixel` in
/// the timeline is computed over a column four pixels narrower than the ruler's.
pub const SCROLL_BODY_PADDING_RIGHT: f32 = 4.;

pub const TRACK_HEIGHT: f32 = 44.;
pub const TRACK_ROW_GAP: f32 = 6.;
/// The radius of the band a row draws across its gutter and lane.
pub const TRACK_BAND_RADIUS: f32 = 8.;
/// The gap between the ruler's baseline and the first track row. It is not the
/// row gap: the ruler's ticks already hang into their own strip.
pub const TIMELINE_HEADER_GAP: f32 = 4.;

/// Everything the card spends before the first track row: its hairline, the
/// padding inside it, the ruler and the gap under the ruler.
pub const TIMELINE_CHROME_HEIGHT: f32 = TIMELINE_CARD_BORDER * 2.
    + TIMELINE_TOP_PADDING
    + TIMELINE_BOTTOM_PADDING
    + TIMELINE_HEADER_HEIGHT
    + TIMELINE_HEADER_GAP;

/// The card height that leaves exactly one row visible -- the floor a resize
/// drag (and the auto height) is allowed to reach.
pub const MIN_HUG_HEIGHT: f32 = TIMELINE_CHROME_HEIGHT + TRACK_HEIGHT;

/// The card height that exactly hugs `rows` visible track rows, [`build_rows`]
/// being what decides how many there are.
pub fn hug_height(rows: usize) -> f32 {
    let rows = rows.max(1) as f32;
    TIMELINE_CHROME_HEIGHT + rows * TRACK_HEIGHT + (rows - 1.) * TRACK_ROW_GAP
}

/// The ruler's ticks hang from the baseline: whole seconds are labelled and
/// long, half seconds are short.
const RULER_MAJOR_TICK: f32 = 8.;
const RULER_MINOR_TICK: f32 = 5.;
/// The gutter cell: a 22px tile at 4px of left padding, then the label.
const TRACK_TILE_SIZE: f32 = 22.;
const TRACK_TILE_INSET: f32 = 4.;
/// The segment's radius, its left accent bar and the content inset that clears
/// it (`0 10px 0 13px`).
const SEGMENT_RADIUS: f32 = 8.;
const SEGMENT_ACCENT_BAR: f32 = 3.;
const SEGMENT_PADDING_LEFT: f32 = 13.;
const SEGMENT_PADDING_RIGHT: f32 = 10.;
/// The waveform's ceiling inside a row, so it never climbs into the labels.
const WAVEFORM_MAX_HEIGHT: f32 = 18.;

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

/// The minimap's chip floor (`TL/Minimap.tsx:9`), the height of its hit strip
/// and the 4px indicator drawn inside that strip, and the width it is allowed
/// to take in the card's bottom-right corner.
const MINIMAP_MIN_CHIP_WIDTH: f32 = 20.;
pub const MINIMAP_HEIGHT: f32 = 10.;
pub const MINIMAP_BAR_HEIGHT: f32 = 4.;
pub const MINIMAP_MAX_WIDTH: f32 = 78.;

/// The edge fade (`TL/index.tsx:1103-1106`).

// ---------------------------------------------------------------------------
// Colours
// ---------------------------------------------------------------------------

/// The single source of truth for track colour is eleven CSS custom properties
/// with one definition each -- not per-appearance values -- so they are literal
/// in both themes exactly as they are there
/// (`apps/desktop/src/styles/theme.css`).
pub mod track_color {
    pub const CLIP: u32 = 0x3b82f6;
    pub const ZOOM: u32 = 0x64748b;
    pub const CAPTION: u32 = 0x0ea5e9;
    pub const KEYBOARD: u32 = 0xf97316;
    pub const STYLE: u32 = 0xec4899;
    pub const IMAGE: u32 = 0xf59e0b;
    pub const TEXT: u32 = 0x14b8a6;
    pub const MASK: u32 = 0xef4444;
    pub const SCENE: u32 = 0x8b5cf6;
    pub const AUDIO: u32 = 0x22c55e;
    pub const THREE_D: u32 = 0x6366f1;
}

/// A muted clip keeps the clip lane's shape but drops its hue, so it reads as
/// the row's own disabled state rather than as a different track.
fn muted_clip_color(theme: &Theme) -> Hsla {
    Hsla::from(theme.editor.text_3)
}

/// The `EditorPalette` mixers work in `Rgba`, which is what the `--ed-*`
/// tokens are; every track colour in this file is an `Hsla`.
fn seg_fill(theme: &Theme, color: Hsla, selected: bool) -> Hsla {
    let color = gpui::Rgba::from(color);
    if selected {
        theme.editor.seg_fill_selected(color).into()
    } else {
        theme.editor.seg_fill(color).into()
    }
}

fn seg_border(theme: &Theme, color: Hsla, extra_alpha: f32) -> Hsla {
    let border = theme.editor.seg_border(gpui::Rgba::from(color));
    Hsla::from(crate::theme::rgba_alpha(
        border,
        (border.a + extra_alpha).clamp(0., 1.),
    ))
}

fn seg_label(theme: &Theme, color: Hsla) -> Hsla {
    theme.editor.seg_label(gpui::Rgba::from(color)).into()
}

fn seg_muted(theme: &Theme, color: Hsla) -> Hsla {
    theme.editor.seg_muted(gpui::Rgba::from(color)).into()
}

fn seg_handle(theme: &Theme, color: Hsla) -> Hsla {
    theme.editor.seg_handle(gpui::Rgba::from(color)).into()
}

pub(crate) fn tile_bg(theme: &Theme, color: Hsla) -> Hsla {
    theme.editor.tile_bg(gpui::Rgba::from(color)).into()
}

pub(crate) fn tile_fg(theme: &Theme, color: Hsla) -> Hsla {
    theme.editor.tile_fg(gpui::Rgba::from(color)).into()
}

fn with_alpha(color: Hsla, alpha: f32) -> Hsla {
    Hsla { a: alpha, ..color }
}

/// Times read as columns of digits, so every one of them is set in the font's
/// tabular figures.
fn tabular_numerals() -> gpui::FontFeatures {
    gpui::FontFeatures(Arc::new(vec![("tnum".to_string(), 1)]))
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
        let zoom = new_zoom
            .min(zoom_out_limit(total_duration))
            .max(MAX_ZOOM_IN);

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
    pub(crate) fn segment_visible(&self, start: f64, end: f64) -> bool {
        let (range_start, range_end) = self.visible_range();
        end >= range_start && start <= range_end
    }
}

// ---------------------------------------------------------------------------
// Geometry the window and the transform share
// ---------------------------------------------------------------------------

/// `timelineBounds.width`, which every `secsPerPixel` divides by: the window,
/// less the timeline slot's `px-2`, less the container's own 16px padding on
/// each side, less the scroll body's `pr-1`, less the gutter.
pub fn content_width(viewport_width: f32) -> f32 {
    (viewport_width
        - TIMELINE_SLOT_PADDING * 2.
        - (TIMELINE_CARD_BORDER + TIMELINE_PADDING) * 2.
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
    (viewport_width
        - TIMELINE_SLOT_PADDING * 2.
        - (TIMELINE_CARD_BORDER + TIMELINE_PADDING) * 2.
        - TRACK_GUTTER)
        .max(1.)
}

/// The window x of the track content column's left edge --
/// `rect.left + TIMELINE_PADDING + TRACK_GUTTER` in `getTimelineContentMetrics`
/// (`TL/index.tsx:803-816`), where `rect` is the timeline container, itself
/// inset by the slot's `px-2`.
pub fn content_left() -> f32 {
    TIMELINE_SLOT_PADDING + TIMELINE_CARD_BORDER + TIMELINE_PADDING + TRACK_GUTTER
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
/// `Nh Nm Ns` / `Nm Ns` / `Ns`. One deliberate deviation: the source floors,
/// which labels a 0.8s sliver "0s" -- below ten seconds this shows one decimal
/// instead (Blip's `duration_label`).
pub fn format_clip_time(seconds: f64) -> String {
    let seconds = seconds.max(0.0);
    let hours = (seconds / 3600.0).floor() as u64;
    let minutes = ((seconds % 3600.0) / 60.0).floor() as u64;
    let secs = (seconds % 60.0).floor() as u64;
    if hours > 0 {
        format!("{hours}h {minutes}m {secs}s")
    } else if minutes > 0 {
        format!("{minutes}m {secs}s")
    } else if seconds < 9.95 {
        format!("{:.1}s", (seconds * 10.0).round() / 10.0)
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
        let avg = if end > i { sum / (end - i) as f32 } else { 0.0 };
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
    let num_samples = target_samples
        .clamp(50, MAX_WAVEFORM_SAMPLES)
        .min(native_samples);
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
        builder.cubic_bezier_to(map(normalized_x, y), map(cp_x1, prev_y), map(cp_x2, y));
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

/// Both waveforms are the lane's own colour at 55 %: over a tinted segment a
/// white or orange fill (`TL/ClipTrack.tsx:293-302`) has nothing to sit on.
pub fn waveform_color(color: Hsla) -> Hsla {
    with_alpha(color, 0.55)
}

// ---------------------------------------------------------------------------
// The track model
// ---------------------------------------------------------------------------

/// The nine rows, in the source order `TL/index.tsx:1334-1496` mounts them.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TrackKind {
    Style,
    Image,
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
            Self::Style => "Style",
            Self::Image => "Image",
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
            Self::Style => "icons/palette.svg",
            Self::Image => "icons/image.svg",
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
            Self::Style => track_color::STYLE,
            Self::Image => track_color::IMAGE,
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

    pub fn picker_label(self) -> &'static str {
        match self {
            Self::Clip => "Clip",
            other => other.label(),
        }
    }

    pub fn picker_description(self) -> &'static str {
        match self {
            Self::Clip => "Your recorded screen footage.",
            Self::Style => "Change background, camera and cursor settings over time.",
            Self::Image => "Add an image to your recording.",
            Self::Zoom => "Smooth zoom-ins that follow the action.",
            Self::Caption => "Auto-transcribe your recording into on-screen subtitles.",
            Self::Keyboard => "Display key presses on screen as you type.",
            Self::Text => "Add custom text overlays and titles to the canvas.",
            Self::Mask => "Blur or black out private areas of the screen.",
            Self::Audio => "Add background music or import your own audio.",
            Self::Scene => "Switch layouts between your screen and camera.",
            Self::ThreeD => "Tilt the scene in 3D perspective.",
        }
    }

    pub fn picker_unavailable(self) -> &'static str {
        match self {
            Self::Scene => "Record with a camera to use scenes.",
            _ => "",
        }
    }

    pub fn supports_multiple(self) -> bool {
        matches!(
            self,
            Self::Text | Self::Mask | Self::Audio | Self::Style | Self::Image
        )
    }

    pub fn overlay_track(self, track: u32) -> Option<OverlayTrack> {
        let kind = match self {
            Self::Mask => OverlayTrackKind::Mask,
            Self::Image => OverlayTrackKind::Image,
            Self::Text => OverlayTrackKind::Text,
            _ => return None,
        };
        Some(OverlayTrack { kind, track })
    }
}

pub const ADD_TRACK_OPTIONS: &[TrackKind] = &[
    TrackKind::Style,
    TrackKind::Image,
    TrackKind::Caption,
    TrackKind::Keyboard,
    TrackKind::Text,
    TrackKind::Mask,
    TrackKind::Audio,
    TrackKind::Scene,
    TrackKind::ThreeD,
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TrackLanes {
    pub style: u32,
    pub image: u32,
    pub caption: bool,
    pub keyboard: bool,
    pub scene: bool,
    pub three_d: bool,
    pub text: u32,
    pub mask: u32,
    pub audio: u32,
}

pub(crate) fn scene_available(config: &ProjectConfiguration, has_camera: bool) -> bool {
    has_camera
        && (config.requires_camera()
            || config
                .timeline
                .as_ref()
                .is_some_and(|timeline| !timeline.scene_segments.is_empty()))
}

impl TrackLanes {
    pub fn from_project(config: &ProjectConfiguration, has_camera: bool) -> Self {
        let timeline = config.timeline.as_ref();
        Self {
            style: timeline.map_or(0, |timeline| {
                used_config_lane_count(timeline.style_segments.iter().map(|segment| segment.track))
            }),
            image: timeline.map_or(0, |timeline| {
                used_config_lane_count(timeline.image_segments.iter().map(|segment| segment.track))
            }),
            caption: config
                .captions
                .as_ref()
                .map(|captions| captions.settings.enabled)
                .unwrap_or_else(|| {
                    timeline.is_some_and(|timeline| !timeline.caption_segments.is_empty())
                }),
            keyboard: config
                .keyboard
                .as_ref()
                .is_some_and(|keyboard| keyboard.settings.enabled),
            scene: scene_available(config, has_camera),
            three_d: timeline.is_some_and(|timeline| !timeline.camera3d_segments.is_empty()),
            text: timeline.map_or(0, |timeline| {
                used_config_lane_count(timeline.text_segments.iter().map(|segment| segment.track))
            }),
            mask: timeline.map_or(0, |timeline| {
                used_config_lane_count(timeline.mask_segments.iter().map(|segment| segment.track))
            }),
            audio: timeline.map_or(0, |timeline| {
                used_config_lane_count(timeline.audio_segments.iter().map(|segment| segment.track))
            }),
        }
    }

    pub fn is_active(self, kind: TrackKind) -> bool {
        match kind {
            TrackKind::Caption => self.caption,
            TrackKind::Keyboard => self.keyboard,
            TrackKind::Scene => self.scene,
            TrackKind::ThreeD => self.three_d,
            TrackKind::Style => self.style > 0,
            TrackKind::Image => self.image > 0,
            TrackKind::Text => self.text > 0,
            TrackKind::Mask => self.mask > 0,
            TrackKind::Audio => self.audio > 0,
            TrackKind::Clip | TrackKind::Zoom => true,
        }
    }

    pub fn count(self, kind: TrackKind) -> u32 {
        match kind {
            TrackKind::Style => self.style,
            TrackKind::Image => self.image,
            TrackKind::Text => self.text,
            TrackKind::Mask => self.mask,
            TrackKind::Audio => self.audio,
            _ => 0,
        }
    }
}

fn used_config_lane_count(tracks: impl Iterator<Item = u32>) -> u32 {
    tracks.map(|track| track + 1).max().unwrap_or(0)
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
    Style {
        name: SharedString,
        enabled: bool,
    },
    Image {
        name: SharedString,
        enabled: bool,
    },
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
        muted: bool,
        recording_clip: u32,
        /// Held (paused) windows inside this clip's on-screen box, in output
        /// time (`TL/ClipTrack.tsx:658-666`).
        holds: Arc<[(f64, f64)]>,
    },
    /// `TL/ZoomTrack.tsx:343-349`.
    Zoom {
        amount: f64,
        automatic: bool,
    },
    /// `TL/SceneTrack.tsx:80-102`.
    Scene {
        mode: SceneMode,
    },
    /// `TL/ThreeDTrack.tsx:648-651`.
    ThreeD {
        motion: bool,
    },
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
    Mask {
        label: &'static str,
    },
    /// `TL/AudioTrack.tsx:449-540`.
    Audio {
        name: SharedString,
        enabled: bool,
        fade_in: f64,
        fade_out: f64,
    },
    /// `TL/CaptionsTrack.tsx:176-273`.
    Caption {
        text: SharedString,
    },
    /// `TL/KeyboardTrack.tsx:168-266`.
    Keyboard {
        text: SharedString,
    },
}

impl SegmentDetail {
    fn shows_waveform(&self) -> bool {
        matches!(
            self,
            Self::Clip {
                timescale,
                muted: false,
                ..
            } if *timescale == 1.0
        )
    }
}

/// A row of the timeline body: a track type plus its lane index.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TrackRow {
    pub kind: TrackKind,
    pub lane: u32,
}

impl TrackRow {
    pub fn from_overlay_track(track: OverlayTrack) -> Self {
        let kind = match track.kind {
            OverlayTrackKind::Mask => TrackKind::Mask,
            OverlayTrackKind::Image => TrackKind::Image,
            OverlayTrackKind::Text => TrackKind::Text,
        };
        Self {
            kind,
            lane: track.track,
        }
    }
}

/// Everything the timeline draws, derived once per project-config change.
#[derive(Debug, Clone, Default)]
pub struct TimelineModel {
    pub style: Vec<Segment>,
    pub image: Vec<Segment>,
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
    pub camera3d_setup_ghosts: Vec<(f64, f64, String)>,
    /// The span a live ghost trim is removing, in output time. Drawn as a gap
    /// with a red duration badge, the way Blip's ghost resize marks the cut.
    pub clip_ghost_gap: Option<(f64, f64)>,
}

impl TimelineModel {
    pub fn track_height(&self) -> f32 {
        TRACK_HEIGHT
    }

    fn segments_for(&self, row: TrackRow) -> &[Segment] {
        self.segments(row.kind)
    }

    /// The drawn segments of one track, in **config index order** -- which is
    /// what the selection and every mutator in [`crate::editor_edits`] address
    /// them by. Multi-lane tracks keep every lane in one list; the row filters.
    pub fn segments(&self, kind: TrackKind) -> &[Segment] {
        match kind {
            TrackKind::Style => &self.style,
            TrackKind::Image => &self.image,
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

        let style = timeline
            .style_segments
            .iter()
            .map(|segment| Segment {
                start: segment.start,
                end: segment.end,
                lane: segment.track,
                detail: SegmentDetail::Style {
                    name: segment.name.clone().into(),
                    enabled: segment.enabled,
                },
            })
            .collect();
        let image = timeline
            .image_segments
            .iter()
            .map(|segment| Segment {
                start: segment.start,
                end: segment.end,
                lane: segment.track,
                detail: SegmentDetail::Image {
                    name: segment.name.clone().into(),
                    enabled: segment.enabled,
                },
            })
            .collect();
        let mut model = Self {
            style,
            image,
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
            camera3d_setup_ghosts: Vec::new(),
            clip_ghost_gap: None,
        };
        model.rows = build_rows(
            config,
            &model,
            has_camera,
            &TrackLanes::from_project(config, has_camera),
        );
        model
    }

    pub fn build_with_lanes(
        config: &ProjectConfiguration,
        has_camera: bool,
        multiple_clips: bool,
        lanes: &TrackLanes,
    ) -> Self {
        let mut model = Self::build(config, has_camera, multiple_clips);
        model.rows = build_rows(config, &model, has_camera, lanes);
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
fn build_rows(
    config: &ProjectConfiguration,
    model: &TimelineModel,
    has_camera: bool,
    lanes: &TrackLanes,
) -> Vec<TrackRow> {
    let mut rows = vec![TrackRow {
        kind: TrackKind::Clip,
        lane: 0,
    }];
    if lanes.caption {
        rows.push(TrackRow {
            kind: TrackKind::Caption,
            lane: 0,
        });
    }
    if lanes.keyboard {
        rows.push(TrackRow {
            kind: TrackKind::Keyboard,
            lane: 0,
        });
    }
    for lane in (0..lane_count(&model.style).max(lanes.style)).rev() {
        rows.push(TrackRow {
            kind: TrackKind::Style,
            lane,
        });
    }
    let mut overlay_tracks = Vec::new();
    for (kind, segments, count) in [
        (TrackKind::Text, &model.text, lanes.text),
        (TrackKind::Image, &model.image, lanes.image),
        (TrackKind::Mask, &model.mask, lanes.mask),
    ] {
        overlay_tracks.extend(
            (0..lane_count(segments).max(count))
                .rev()
                .filter_map(|lane| kind.overlay_track(lane)),
        );
    }
    rows.extend(
        config
            .resolved_overlay_order(&overlay_tracks)
            .into_iter()
            .map(TrackRow::from_overlay_track),
    );
    for lane in (0..lane_count(&model.audio).max(lanes.audio)).rev() {
        rows.push(TrackRow {
            kind: TrackKind::Audio,
            lane,
        });
    }
    rows.push(TrackRow {
        kind: TrackKind::Zoom,
        lane: 0,
    });
    if lanes.three_d {
        rows.push(TrackRow {
            kind: TrackKind::ThreeD,
            lane: 0,
        });
    }
    if lanes.scene && scene_available(config, has_camera) {
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
                    muted: clip_is_muted(segment),
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
    /// `editorState.timeline.audioPicker` -- the empty audio lane whose
    /// library panel is open (`TL/AudioTrack.tsx:405`).
    pub audio_picker_lane: Option<u32>,
    /// `isHoveringGenerateZoomButton` (`TL/ZoomTrack.tsx:308-309, 784`).
    pub hovering_generate_zoom: bool,
    pub scene_preview_time: Option<f64>,
}

impl SegmentUi<'_> {
    fn is_selected(&self, kind: TrackKind, index: usize) -> bool {
        self.selection
            .is_some_and(|selection| selection.contains(kind, index))
    }

    fn is_hovered(&self, kind: TrackKind, lane: u32, index: usize) -> bool {
        self.hovered == Some((kind, lane, index))
    }

    fn row_selected(&self, model: &TimelineModel, row: TrackRow) -> bool {
        self.selection.is_some_and(|selection| {
            selection.track == row.kind
                && model
                    .segments_for(row)
                    .iter()
                    .enumerate()
                    .any(|(index, segment)| {
                        segment.lane == row.lane && selection.indices.contains(&index)
                    })
        })
    }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/// The gutter cell: a tinted 22px tile carrying the track's glyph, then the
/// track's name. The saturated pill the source draws
/// (`TL/TrackManager.tsx:264-281`) is gone.
pub fn track_chip(theme: &Theme, kind: TrackKind) -> impl IntoElement {
    let color = kind.color();
    div()
        .w_full()
        .h_full()
        .flex()
        .flex_row()
        .items_center()
        .gap(px(8.))
        .pl(px(TRACK_TILE_INSET))
        .pr(px(6.))
        .child(
            div()
                .flex_none()
                .size(px(TRACK_TILE_SIZE))
                .rounded(px(6.))
                .flex()
                .items_center()
                .justify_center()
                .bg(tile_bg(theme, color))
                .child(
                    svg()
                        .path(kind.icon())
                        .size(px(12.))
                        .flex_none()
                        .text_color(tile_fg(theme, color)),
                ),
        )
        .child(
            div()
                .min_w_0()
                .truncate()
                .text_size(px(11.))
                .line_height(px(14.))
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
    let tick = Hsla::from(theme.editor.line_strong);
    let label = Hsla::from(theme.editor.text_3);

    let mut body = div().relative().flex_1().h_full().ml(px(TRACK_GUTTER));

    // The source renders every mark and hides the negative ones with
    // `visibility`, which costs nothing there and would cost an element here.
    for index in 0..count.min(512) {
        let second = transform.position - offset + index as f64 * resolution;
        if second < 0. {
            continue;
        }
        let x = (second - transform.position) / secs_per_pixel;
        if x > strip_width {
            break;
        }
        let major = second % 1. == 0.;
        body = body.child(
            div()
                .absolute()
                .left(px(x as f32))
                .bottom_0()
                .w(px(1.))
                .h(px(if major {
                    RULER_MAJOR_TICK
                } else {
                    RULER_MINOR_TICK
                }))
                .bg(tick)
                .when(major, |this| {
                    this.child(
                        div()
                            .absolute()
                            .bottom(px(10.))
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
                            .text_size(px(11.))
                            .line_height(px(13.))
                            .font_features(tabular_numerals())
                            .text_color(label)
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

/// The minimap's strip: pinned to the card's inner right edge, at most
/// [`MINIMAP_MAX_WIDTH`] wide. Returns its window x and its width, which the
/// drag maths and the drawn bar have to agree on.
pub fn minimap_bounds(viewport_width: f32) -> (f32, f32) {
    let strip = ruler_width(viewport_width);
    let width = MINIMAP_MAX_WIDTH.min(strip);
    (content_left() + strip - width, width)
}

pub fn minimap_chip(transform: Transform, total_duration: f64, bar_width: f32) -> (f32, f32) {
    let total = total_duration.max(0.001);
    let bar_width = bar_width.max(1.);
    let chip_width = ((transform.zoom * bar_width as f64 / total) as f32)
        .clamp(MINIMAP_MIN_CHIP_WIDTH.min(bar_width), bar_width);
    let max_position = (total - transform.zoom).max(0.001);
    let chip_left = ((transform.position / max_position).clamp(0., 1.) as f32)
        * (bar_width - chip_width).max(0.);
    (chip_left, chip_width)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MinimapDragKind {
    Move,
    Left,
    Right,
}

#[derive(Debug, Clone, Copy)]
pub struct MinimapDrag {
    pub kind: MinimapDragKind,
    start_x: f32,
    start: Transform,
    seconds_per_pixel: f64,
    move_scale: f64,
}

impl MinimapDrag {
    pub fn begin(
        x: f32,
        bar_left: f32,
        bar_width: f32,
        total: f64,
        transform: &mut Transform,
    ) -> Option<Self> {
        if !x.is_finite()
            || !bar_left.is_finite()
            || !bar_width.is_finite()
            || !total.is_finite()
            || !transform.zoom.is_finite()
            || !transform.position.is_finite()
            || bar_width <= 0.
            || total - transform.zoom <= 0.01
        {
            return None;
        }
        let (chip_left, chip_width) = minimap_chip(*transform, total, bar_width);
        let offset = x - bar_left;
        let kind = if offset < chip_left || offset > chip_left + chip_width {
            transform.set_position(
                offset as f64 / bar_width as f64 * total - transform.zoom / 2.,
                total,
            );
            MinimapDragKind::Move
        } else if offset < chip_left + 8. {
            MinimapDragKind::Left
        } else if offset > chip_left + chip_width - 8. {
            MinimapDragKind::Right
        } else {
            MinimapDragKind::Move
        };
        Some(Self {
            kind,
            start_x: x,
            start: *transform,
            seconds_per_pixel: total / bar_width as f64,
            move_scale: (total - transform.zoom) / (bar_width - chip_width).max(1.) as f64,
        })
    }

    pub fn update(self, x: f32, total: f64) -> Transform {
        let mut transform = self.start;
        if !x.is_finite() {
            return transform;
        }
        let delta = (x - self.start_x) as f64;
        match self.kind {
            MinimapDragKind::Move => {
                transform.set_position(self.start.position + delta * self.move_scale, total);
            }
            MinimapDragKind::Left => transform.update_zoom(
                self.start.zoom - delta * self.seconds_per_pixel,
                self.start.position + self.start.zoom,
                total,
            ),
            MinimapDragKind::Right => transform.update_zoom(
                self.start.zoom + delta * self.seconds_per_pixel,
                self.start.position,
                total,
            ),
        }
        transform
    }
}

pub fn render_minimap(
    theme: &Theme,
    model: &TimelineModel,
    view: TimelineView,
    bar_width: f32,
) -> AnyElement {
    let total = model.total_duration.max(0.001);
    let bar_width = bar_width.max(1.);
    let zoomed_in = total - view.transform.zoom > 0.01;
    let (chip_left, chip_width) = minimap_chip(view.transform, total, bar_width);

    let mut bar = div()
        .relative()
        .w_full()
        .h(px(MINIMAP_BAR_HEIGHT))
        .overflow_hidden()
        .rounded(px(2.))
        .bg(Hsla::from(theme.editor.ctl_active))
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
                .bg(with_alpha(TrackKind::Clip.color(), 0.5)),
        );
    }

    div()
        .w_full()
        .h_full()
        .flex()
        .items_center()
        .child(
            bar.child(
                div()
                    .id("timeline-minimap-chip")
                    .absolute()
                    .top_0()
                    .bottom_0()
                    .left(px(chip_left))
                    .w(px(chip_width))
                    .rounded(px(2.))
                    .bg(with_alpha(Hsla::from(theme.editor.text_3), 0.5))
                    .cursor(gpui::CursorStyle::OpenHand)
                    .hover(|style| style.bg(with_alpha(Hsla::from(theme.editor.text_3), 0.75)))
                    .children([true, false].map(|left| {
                        div()
                            .absolute()
                            .top_0()
                            .bottom_0()
                            .w(px(8.))
                            .when(left, |handle| handle.left_0())
                            .when(!left, |handle| handle.right_0())
                            .cursor(gpui::CursorStyle::ResizeLeftRight)
                    })),
            ),
        )
        .into_any_element()
}

/// One track row, drawn as a single band across the gutter and the lane so a
/// label always reads as belonging to the strip beside it: the gutter cell in
/// the band's leading [`TRACK_GUTTER`] pixels, then a `flex-1 relative
/// overflow-hidden min-w-0` content cell (`TL/index.tsx:1516-1550`).
pub fn render_row(
    theme: &Theme,
    model: &TimelineModel,
    row: TrackRow,
    view: TimelineView,
    viewport_width: f32,
    ui: SegmentUi<'_>,
) -> AnyElement {
    let height = model.track_height();
    let selected = ui.row_selected(model, row);
    let active_bg = Hsla::from(theme.editor.ctl_hover);
    let active_text = Hsla::from(theme.editor.text_1);
    div()
        .relative()
        .flex()
        .flex_row()
        .items_stretch()
        .h(px(height))
        .flex_none()
        .rounded(px(TRACK_BAND_RADIUS))
        .bg(if selected {
            active_bg
        } else {
            Hsla::from(theme.editor.ctl)
        })
        .text_color(if selected {
            active_text
        } else {
            Hsla::from(theme.editor.text_2)
        })
        .hover(|style| style.bg(active_bg).text_color(active_text))
        .child(
            div()
                .w(px(TRACK_GUTTER))
                .flex_none()
                .relative()
                .child(track_chip(theme, row.kind)),
        )
        .child(
            div()
                .flex_1()
                .relative()
                .overflow_hidden()
                .min_w_0()
                .rounded_r(px(TRACK_BAND_RADIUS))
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
        && (row.kind != TrackKind::ThreeD || model.camera3d_setup_ghosts.is_empty())
        && let Some(empty) = render_empty_track(
            theme,
            row.kind,
            view.hovered_track == Some(row.kind),
            row.kind == TrackKind::Audio && ui.audio_picker_lane == Some(row.lane),
        )
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
        && !ui.hovering_generate_zoom
        && view.hovered_track == Some(TrackKind::Zoom)
        && let Some(preview) = view.preview_time
        && let Some(ghost) = new_zoom_segment(model, preview, secs_per_pixel)
    {
        content = content.child(render_gap_ghost(
            theme,
            TrackKind::Zoom,
            ghost,
            view,
            secs_per_pixel,
            height,
        ));
    }

    if row.kind == TrackKind::Scene
        && !ui.dragging
        && view.hovered_track == Some(TrackKind::Scene)
        && let Some(preview) = ui.scene_preview_time
        && let Some(ghost) = new_scene_segment(model, preview)
    {
        content = content.child(render_gap_ghost(
            theme,
            TrackKind::Scene,
            ghost,
            view,
            secs_per_pixel,
            height,
        ));
    }

    if row.kind == TrackKind::ThreeD {
        for (start, end, label) in &model.camera3d_setup_ghosts {
            content = content.child(render_camera3d_setup_ghost(
                theme,
                (*start, *end),
                label,
                view,
                secs_per_pixel,
                height,
            ));
        }
    }

    if row.kind == TrackKind::Clip
        && let Some((gap_start, gap_end)) = model.clip_ghost_gap
    {
        let x = ((gap_start - view.transform.position) / secs_per_pixel) as f32;
        let width = ((gap_end - gap_start) / secs_per_pixel) as f32;
        if width > 0.5 {
            let mut gap = div()
                .absolute()
                .top_0()
                .bottom_0()
                .left(px(x))
                .w(px(width))
                .flex()
                .items_center()
                .justify_center()
                .rounded(px(6.))
                .bg(with_alpha(Hsla::from(gpui::rgb(0xef4444)), 0.12));
            if width >= 26. {
                gap = gap.child(
                    div()
                        .px(px(6.))
                        .py(px(2.))
                        .rounded(px(6.))
                        .bg(Hsla::from(gpui::rgb(0xef4444)))
                        .text_size(px(10.))
                        .line_height(px(12.))
                        .font_weight(FontWeight::MEDIUM)
                        .text_color(gpui::white())
                        .child(SharedString::from(format!(
                            "{:.1}s",
                            ((gap_end - gap_start).max(0.) * 10.).round() / 10.
                        ))),
                );
            }
            content = content.child(gap);
        }
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
    new_gap_segment(model, TrackKind::Zoom, preview, secs_per_pixel)
}

pub fn new_scene_segment(model: &TimelineModel, preview: f64) -> Option<(f64, f64)> {
    if !preview.is_finite()
        || preview < 0.0
        || !model.total_duration.is_finite()
        || preview >= model.total_duration
        || model
            .scene
            .iter()
            .any(|segment| preview >= segment.start && preview < segment.end)
    {
        return None;
    }
    let end = model
        .scene
        .iter()
        .filter(|segment| segment.start > preview)
        .map(|segment| segment.start)
        .min_by(f64::total_cmp)
        .unwrap_or(model.total_duration)
        .min(model.total_duration)
        .min(preview + 3.0);
    (end - preview >= 0.5).then_some((preview, end))
}

pub fn new_gap_segment(
    model: &TimelineModel,
    kind: TrackKind,
    preview: f64,
    secs_per_pixel: f64,
) -> Option<(f64, f64)> {
    let min_duration = new_segment_min_duration(secs_per_pixel);
    let segments = model.segments(kind);

    let next = segments.iter().find(|segment| preview <= segment.start);
    let previous = segments
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

fn render_camera3d_setup_ghost(
    theme: &Theme,
    (start, end): (f64, f64),
    label: &str,
    view: TimelineView,
    secs_per_pixel: f64,
    height: f32,
) -> AnyElement {
    let color = TrackKind::ThreeD.color();
    let x = ((start - view.transform.position) / secs_per_pixel) as f32;
    let width = ((end - start) / secs_per_pixel) as f32;
    div()
        .absolute()
        .top_0()
        .bottom_0()
        .left(px(x))
        .w(px(width))
        .rounded(px(SEGMENT_RADIUS))
        .border_1()
        .border_dashed()
        .border_color(seg_border(theme, color, 0.))
        .bg(seg_fill(theme, color, false))
        .child(
            div()
                .h(px(height))
                .w_full()
                .flex()
                .items_center()
                .justify_center()
                .px(px(8.))
                .child(
                    div()
                        .text_size(px(12.))
                        .font_weight(FontWeight::MEDIUM)
                        .text_color(seg_label(theme, color))
                        .child(SharedString::from(label.to_string())),
                ),
        )
        .into_any_element()
}

fn render_gap_ghost(
    theme: &Theme,
    kind: TrackKind,
    (start, end): (f64, f64),
    view: TimelineView,
    secs_per_pixel: f64,
    height: f32,
) -> AnyElement {
    let color = kind.color();
    let x = ((start - view.transform.position) / secs_per_pixel) as f32;
    let width = ((end - start) / secs_per_pixel) as f32;
    div()
        .absolute()
        .top_0()
        .bottom_0()
        .left(px(x))
        .w(px(width))
        .child(
            div()
                .relative()
                .h(px(height))
                .w_full()
                .flex()
                .items_center()
                .justify_center()
                .rounded(px(SEGMENT_RADIUS))
                .overflow_hidden()
                .bg(seg_fill(theme, color, false))
                .border_1()
                .border_dashed()
                .border_color(seg_border(theme, color, 0.))
                .text_size(px(14.))
                .text_color(seg_label(theme, color))
                .child("+"),
        )
        .into_any_element()
}

/// The in-lane empty prompt: the track's own copy centred on the lane's band
/// and, where a click fills the lane, the action word that does it. The
/// floating pills and buttons the source draws are gone.
fn render_empty_prompt(
    theme: &Theme,
    color: Hsla,
    copy: &'static str,
    action: Option<&'static str>,
    hovered: bool,
    active: bool,
) -> AnyElement {
    div()
        .absolute()
        .inset_0()
        .flex()
        .flex_row()
        .items_center()
        .justify_center()
        .gap(px(5.))
        .px(px(10.))
        .rounded(px(SEGMENT_RADIUS))
        .when(active, |this| this.bg(seg_fill(theme, color, false)))
        .text_size(px(12.))
        .line_height(px(16.))
        .text_color(Hsla::from(if hovered {
            theme.editor.text_2
        } else {
            theme.editor.text_3
        }))
        .child(div().min_w_0().truncate().child(copy))
        .children(action.map(|action| {
            div()
                .flex()
                .flex_row()
                .flex_none()
                .items_center()
                .gap(px(5.))
                .child("\u{b7}")
                .child(
                    div()
                        .font_weight(FontWeight::MEDIUM)
                        .text_color(Hsla::from(theme.editor.text_2))
                        .child(action),
                )
        }))
        .into_any_element()
}

/// The empty-lane states. The zoom lane's own prompt is interactive and lives
/// on the window's row overlay instead.
fn render_empty_track(
    theme: &Theme,
    kind: TrackKind,
    hovered: bool,
    active: bool,
) -> Option<AnyElement> {
    let (copy, action) = match kind {
        // `TL/CaptionsTrack.tsx:146-160`.
        TrackKind::Caption => ("No captions", None),
        // `TL/KeyboardTrack.tsx:146-153`.
        TrackKind::Keyboard => ("No keyboard events", None),
        // `TL/AudioTrack.tsx:400-427`, `TL/ThreeDTrack.tsx:319-337`, and the
        // scene lane, which had no empty state at all.
        TrackKind::Audio => (
            kind.picker_description().trim_end_matches('.'),
            Some("Add audio"),
        ),
        TrackKind::ThreeD => (
            kind.picker_description().trim_end_matches('.'),
            Some("Add 3D scene"),
        ),
        TrackKind::Scene => (
            kind.picker_description().trim_end_matches('.'),
            Some("Add scene"),
        ),
        _ => return None,
    };
    Some(render_empty_prompt(
        theme,
        kind.color(),
        copy,
        action,
        hovered,
        active,
    ))
}

/// `SegmentRoot` (`TL/Track.tsx:100-137`): the positioned box, its tinted fill
/// and inset ring, the accent bar flush against its left edge, the label at
/// whatever tier its visible width allows, and the two trim handles.
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
    let color = if matches!(segment.detail, SegmentDetail::Clip { muted: true, .. }) {
        muted_clip_color(theme)
    } else {
        kind.color()
    };
    let x = ((segment.start - view.transform.position) / secs_per_pixel) as f32;
    let width = ((segment.end - segment.start) / secs_per_pixel) as f32;
    let (visible_width, center_x) =
        visible_box(segment.start, segment.end, view.transform, secs_per_pixel);

    // `!segment.enabled && "opacity-60"` (text, `TL/TextTrack.tsx:365`) and
    // `"opacity-50"` (audio, `TL/AudioTrack.tsx:457`).
    let dim = match &segment.detail {
        SegmentDetail::Text { enabled, .. }
        | SegmentDetail::Style { enabled, .. }
        | SegmentDetail::Image { enabled, .. }
            if !enabled =>
        {
            Some(0.6)
        }
        SegmentDetail::Audio { enabled, .. } if !enabled => Some(0.5),
        _ => None,
    };

    let mut fill = div()
        .relative()
        .h_full()
        .w_full()
        .flex()
        .flex_row()
        .rounded(px(SEGMENT_RADIUS))
        .overflow_hidden()
        .bg(seg_fill(theme, color, selected))
        .child(
            div()
                .absolute()
                .top_0()
                .bottom_0()
                .left_0()
                .w(px(SEGMENT_ACCENT_BAR))
                .bg(color),
        );

    // The clip track's waveform and its per-second markings, both under the
    // label (`TL/ClipTrack.tsx:943-957`).
    if let SegmentDetail::Clip {
        holds,
        recording_clip,
        ..
    } = &segment.detail
    {
        if segment.detail.shows_waveform() {
            fill = fill.child(render_waveform(
                model,
                segment,
                *recording_clip,
                holds,
                view,
                width,
                height,
                color,
            ));
        }
        fill = fill.child(render_clip_markings(
            color,
            segment,
            holds,
            view,
            secs_per_pixel,
            height,
        ));
        for (hold_start, hold_end) in holds.iter() {
            let hold_x = ((hold_start - segment.start) / secs_per_pixel) as f32;
            let hold_width = ((hold_end - hold_start) / secs_per_pixel) as f32;
            fill = fill.child(render_hold(theme, color, hold_x, hold_width));
        }
    }

    fill = fill.child(render_label(
        theme,
        color,
        segment,
        visible_width,
        center_x,
        kind,
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
            fill = fill.child(render_fade(
                theme,
                color,
                edge_in,
                fraction as f32,
                width,
                height,
            ));
        }
    }

    // `SegmentHandle` (`TL/Track.tsx:236-258`): a 20px hit target with a 3px
    // visible bar, half-overhanging each edge. A *compact* handle carries no
    // `group-hover` class over there, so it stays visible with the pointer on
    // it (`TL/Track.tsx:250`).
    let compact = (width as f64) < 40.;
    let handle_opacity = if compact {
        0.55
    } else if hovered {
        0.9
    } else {
        0.
    };

    div()
        .absolute()
        .top_0()
        .bottom_0()
        .left(px(x))
        .w(px(width))
        .rounded(px(SEGMENT_RADIUS))
        .when_some(dim, |this, opacity| this.opacity(opacity))
        // `interactMode === "split" && "timeline-scissors-cursor"`
        // (`TL/Track.tsx:107-108`). That cursor is an inline SVG data-URI;
        // this rev has the standard set only, so a crosshair stands in.
        .when(split_mode, |this| this.cursor(gpui::CursorStyle::Crosshair))
        .child(if selected {
            fill.border(px(1.5))
                .border_color(Hsla::from(theme.editor.accent))
        } else {
            fill.border_1()
                .border_color(seg_border(theme, color, if hovered { 0.10 } else { 0. }))
        })
        .child(render_handle(theme, color, true, handle_opacity))
        .child(render_handle(theme, color, false, handle_opacity))
        .into_any_element()
}

fn render_handle(theme: &Theme, color: Hsla, start: bool, opacity: f32) -> impl IntoElement {
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
        .opacity(opacity)
        .child(
            div()
                .absolute()
                .w(px(3.))
                .h(px(16.))
                .rounded(px(2.))
                .bg(seg_handle(theme, color))
                .map(|this| {
                    if start {
                        this.left(px(15.))
                    } else {
                        this.right(px(15.))
                    }
                }),
        )
}

/// `Markings` (`TL/ClipTrack.tsx:1425-1476`): one hairline per ruler tick,
/// drawn *inside* each clip box in recording time and pushed past the holds the
/// stretched box inserts before it. The gradient is a three-stop fade with the
/// mid colour at the centre -- gpui takes two stops, so it is drawn as two
/// stacked halves.
fn render_clip_markings(
    color: Hsla,
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

    let via = with_alpha(color, 0.14);
    let transparent = with_alpha(color, 0.);

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
/// `FadeControl`, `TL/AudioTrack.tsx:63-201`): the faded span washed back
/// towards the card with the envelope curve along its top, plus the 10px
/// corner triangle at the segment's edge.
///
/// The source draws the curve in a `viewBox="0 0 100 100"` with
/// `preserveAspectRatio="none"`, so the two cubic control points are in
/// percent of the span; they are scaled into pixels here.
fn render_fade(
    theme: &Theme,
    color: Hsla,
    edge_in: bool,
    fraction: f32,
    width: f32,
    height: f32,
) -> impl IntoElement {
    let span = (fraction * width).max(0.);
    let shade_x = if edge_in { 0. } else { width - span };
    let shade = with_alpha(Hsla::from(theme.editor.card), 0.55);
    let curve = with_alpha(seg_label(theme, color), 0.85);
    let corner = with_alpha(seg_handle(theme, color), 0.8);

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
                .bg(shade),
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
                        window.paint_path(path, curve);
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
                                window.paint_path(path, corner);
                            }
                        },
                    )
                    .absolute()
                    .inset_0(),
                ),
        )
}

/// The paused window a fullscreen text segment inserts inside a clip
/// (`TL/ClipTrack.tsx:959-1002`): the clip's tint washed back to the card,
/// ruled off at both edges, with a pause glyph.
fn render_hold(theme: &Theme, color: Hsla, x: f32, width: f32) -> impl IntoElement {
    let ink = with_alpha(seg_label(theme, color), 0.75);
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
        .bg(with_alpha(Hsla::from(theme.editor.card), 0.6))
        .border_l_1()
        .border_r_1()
        .border_color(seg_border(theme, color, 0.))
        .child(
            svg()
                .path("icons/pause.svg")
                .size(px(12.))
                .flex_none()
                .text_color(ink),
        )
        .when(width >= 64., |this| {
            this.child(
                div()
                    .text_size(px(10.))
                    .font_weight(FontWeight::MEDIUM)
                    .text_color(ink)
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
    color: Hsla,
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
    let wave_height = height.min(WAVEFORM_MAX_HEIGHT);
    let wave_color = waveform_color(color);

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
            let size = gpui::size(px(slice_width), px(wave_height));
            let samples = waveform_sample_count(slice_width as f64);

            for (peaks, scale) in [(&mic, mic_scale), (&system, system_scale)] {
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
                    window.paint_path(path, wave_color);
                }
            }
        },
    )
    .absolute()
    .bottom_0()
    .left_0()
    .w(px(width))
    .h(px(wave_height))
    .into_any_element()
}

/// `SegmentLabel` (`TL/Track.tsx:186-220`): full, compact and glyph tiers,
/// anchored to the visible box and left-aligned inside the segment's own
/// `0 10px 0 13px` content padding.
fn render_label(
    theme: &Theme,
    color: Hsla,
    segment: &Segment,
    visible_width: f64,
    center_x: f64,
    kind: TrackKind,
) -> impl IntoElement {
    let compact_at = match kind {
        TrackKind::Caption | TrackKind::Keyboard | TrackKind::Audio => {
            SEGMENT_LABEL_COMPACT_TIGHT_PX
        }
        _ => SEGMENT_LABEL_COMPACT_PX,
    };
    let tier = if visible_width >= SEGMENT_LABEL_FULL_PX {
        LabelTier::Full
    } else if visible_width >= compact_at {
        LabelTier::Compact
    } else if visible_width >= SEGMENT_LABEL_GLYPH_PX {
        LabelTier::Glyph
    } else {
        return div();
    };

    let Some(body) = label_body(theme, color, segment, tier, visible_width) else {
        return div();
    };

    // A narrow box cannot pay for the accent bar's clearance and still show
    // anything, so it falls back to a symmetric inset.
    let (pad_left, pad_right) = if tier == LabelTier::Glyph {
        (4., 4.)
    } else if visible_width >= 60. {
        (SEGMENT_PADDING_LEFT as f64, SEGMENT_PADDING_RIGHT as f64)
    } else {
        (6., 4.)
    };
    let max_width = (visible_width - pad_left - pad_right).max(0.);
    let left = center_x - visible_width / 2. + pad_left;

    div().child(
        div()
            .absolute()
            .top_0()
            .bottom_0()
            .left(px(left as f32))
            .w(px(max_width as f32))
            .flex()
            .items_center()
            .when(tier == LabelTier::Glyph, |this| this.justify_center())
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

fn label_row() -> gpui::Div {
    div()
        .flex()
        .flex_row()
        .items_center()
        .gap(px(8.))
        .min_w_0()
        .max_w_full()
}

fn label_primary(theme: &Theme, color: Hsla) -> gpui::Div {
    div()
        .min_w_0()
        .truncate()
        .text_size(px(12.))
        .line_height(px(15.))
        .font_weight(FontWeight::MEDIUM)
        .text_color(seg_label(theme, color))
}

fn label_secondary(theme: &Theme, color: Hsla) -> gpui::Div {
    div()
        .flex_none()
        .text_size(px(11.))
        .line_height(px(15.))
        .font_features(tabular_numerals())
        .text_color(seg_muted(theme, color))
}

fn label_glyph(theme: &Theme, color: Hsla, path: &'static str, size: f32) -> AnyElement {
    svg()
        .path(path)
        .size(px(size))
        .flex_none()
        .text_color(seg_label(theme, color))
        .into_any_element()
}

/// The eleven tracks' label bodies: a primary name and, where the track has
/// one, the value that qualifies it.
fn label_body(
    theme: &Theme,
    color: Hsla,
    segment: &Segment,
    tier: LabelTier,
    visible_width: f64,
) -> Option<AnyElement> {
    Some(match (&segment.detail, tier) {
        (
            SegmentDetail::Style { name, .. } | SegmentDetail::Image { name, .. },
            LabelTier::Full | LabelTier::Compact,
        ) => label_row()
            .child(label_primary(theme, color).child(name.clone()))
            .into_any_element(),
        (SegmentDetail::Style { .. }, LabelTier::Glyph) => {
            label_glyph(theme, color, "icons/palette.svg", 12.)
        }
        (SegmentDetail::Image { .. }, LabelTier::Glyph) => {
            label_glyph(theme, color, "icons/image.svg", 12.)
        }

        // -- Clip (`TL/ClipTrack.tsx:1255-1279`) --------------------------
        (
            SegmentDetail::Clip {
                name,
                source_duration,
                muted,
                ..
            },
            LabelTier::Full,
        ) => label_row()
            .child(label_primary(theme, color).child(name.clone()))
            .when(*muted, |this| this.child(muted_badge(theme, color)))
            .child(label_secondary(theme, color).child(format_clip_time(*source_duration)))
            .into_any_element(),
        (
            SegmentDetail::Clip {
                source_duration,
                muted,
                ..
            },
            LabelTier::Compact,
        ) => label_row()
            .gap(px(4.))
            .when(*muted, |this| {
                this.child(
                    svg()
                        .path("icons/volume-x.svg")
                        .size(px(12.))
                        .flex_none()
                        .text_color(seg_label(theme, color)),
                )
            })
            .child(label_primary(theme, color).child(format_clip_time(*source_duration)))
            .into_any_element(),
        (SegmentDetail::Clip { muted: true, .. }, LabelTier::Glyph) => label_glyph(
            theme,
            color,
            "icons/volume-x.svg",
            (visible_width - 8.).clamp(8., 14.) as f32,
        ),
        (SegmentDetail::Clip { .. }, LabelTier::Glyph) => {
            return None;
        }

        // -- Zoom (`TL/ZoomTrack.tsx:696-723`) ----------------------------
        (SegmentDetail::Zoom { amount, automatic }, LabelTier::Full) => label_row()
            .child(label_primary(theme, color).child(SharedString::from(
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
            )))
            .child(label_secondary(theme, color).child(format!("{amount:.1}x")))
            .into_any_element(),
        (SegmentDetail::Zoom { amount, .. }, LabelTier::Compact) => label_row()
            .child(label_primary(theme, color).child(format!("{amount:.1}x")))
            .into_any_element(),
        (SegmentDetail::Zoom { .. }, LabelTier::Glyph) => {
            label_glyph(theme, color, "icons/search.svg", 12.)
        }

        // -- Scene (`TL/SceneTrack.tsx:543-566`) --------------------------
        (SegmentDetail::Scene { mode }, LabelTier::Full) => label_row()
            .child(label_primary(theme, color).child("Scene"))
            .child(label_secondary(theme, color).child(scene_label(*mode)))
            .into_any_element(),
        (SegmentDetail::Scene { mode }, LabelTier::Compact) => label_row()
            .child(label_primary(theme, color).child(scene_label(*mode)))
            .into_any_element(),
        (SegmentDetail::Scene { mode }, LabelTier::Glyph) => {
            label_glyph(theme, color, scene_icon(*mode), 12.)
        }

        // -- 3D (`TL/ThreeDTrack.tsx:655-687`) ----------------------------
        (SegmentDetail::ThreeD { motion }, LabelTier::Full) => label_row()
            .child(label_primary(theme, color).child(if visible_width >= 140. {
                "3D Perspective"
            } else {
                "3D"
            }))
            .child(label_secondary(theme, color).child(if *motion { "Motion" } else { "Still" }))
            .into_any_element(),
        (SegmentDetail::ThreeD { .. }, LabelTier::Compact) => label_row()
            .child(label_primary(theme, color).child("3D"))
            .into_any_element(),
        (SegmentDetail::ThreeD { .. }, LabelTier::Glyph) => {
            label_glyph(theme, color, "icons/rotate-3d.svg", 12.)
        }

        // -- Text (`TL/TextTrack.tsx:428-481`) ----------------------------
        (
            SegmentDetail::Text {
                content,
                color: text_color,
                italic,
                bold,
                fullscreen,
                ..
            },
            LabelTier::Full | LabelTier::Compact,
        ) => label_row()
            .gap(px(6.))
            .child(
                div()
                    .size(px(8.))
                    .flex_none()
                    .rounded_full()
                    .bg(*text_color),
            )
            .child(
                label_primary(theme, color)
                    .when(*bold, |this| this.font_weight(FontWeight::BOLD))
                    .when(*italic, |this| this.italic())
                    .child(content.clone()),
            )
            .when(*fullscreen, |this| {
                this.child(
                    svg()
                        .path("icons/pause.svg")
                        .size(px(10.))
                        .flex_none()
                        .text_color(seg_muted(theme, color)),
                )
            })
            .into_any_element(),
        (SegmentDetail::Text { fullscreen, .. }, LabelTier::Glyph) => {
            if !*fullscreen {
                return None;
            }
            label_glyph(theme, color, "icons/pause.svg", 10.)
        }

        // -- Mask (`TL/MaskTrack.tsx:481-495`) ----------------------------
        (SegmentDetail::Mask { label }, LabelTier::Full) => label_row()
            .child(label_primary(theme, color).child("Mask"))
            .child(label_secondary(theme, color).child(*label))
            .into_any_element(),
        (SegmentDetail::Mask { label }, LabelTier::Compact) => label_row()
            .child(label_primary(theme, color).child(*label))
            .into_any_element(),
        // The mask track passes no `glyph`.
        (SegmentDetail::Mask { .. }, LabelTier::Glyph) => return None,

        // -- Audio (`TL/AudioTrack.tsx:532-549`) --------------------------
        (SegmentDetail::Audio { name, .. }, LabelTier::Full) => label_row()
            .child(label_primary(theme, color).child(name.clone()))
            .child(
                label_secondary(theme, color).child(format_clip_time(segment.end - segment.start)),
            )
            .into_any_element(),
        (SegmentDetail::Audio { name, .. }, LabelTier::Compact) => label_row()
            .child(label_primary(theme, color).child(name.clone()))
            .into_any_element(),
        (SegmentDetail::Audio { .. }, LabelTier::Glyph) => return None,

        // -- Captions (`TL/CaptionsTrack.tsx:174-181, 268-272`) -----------
        // One row serves both tiers; it just clips against a smaller box.
        (SegmentDetail::Caption { text }, LabelTier::Full | LabelTier::Compact) => label_row()
            .child(label_primary(theme, color).child(text.clone()))
            .into_any_element(),
        (SegmentDetail::Caption { .. }, LabelTier::Glyph) => return None,

        // -- Keyboard (`TL/KeyboardTrack.tsx:166-173, 260-268`) -----------
        (SegmentDetail::Keyboard { text }, LabelTier::Full | LabelTier::Compact) => label_row()
            .child(
                label_primary(theme, color)
                    .font_family("monospace")
                    .child(text.clone()),
            )
            .into_any_element(),
        (SegmentDetail::Keyboard { .. }, LabelTier::Glyph) => label_primary(theme, color)
            .font_family("monospace")
            .child("\u{2328}")
            .into_any_element(),
    })
}

/// The muted clip's badge (`TL/ClipTrack.tsx:1265-1276`).
fn muted_badge(theme: &Theme, color: Hsla) -> impl IntoElement {
    div()
        .flex()
        .flex_none()
        .items_center()
        .gap(px(3.))
        .px(px(5.))
        .rounded(px(4.))
        .bg(seg_border(theme, color, 0.))
        .text_size(px(10.))
        .line_height(px(14.))
        .font_weight(FontWeight::MEDIUM)
        .text_color(seg_label(theme, color))
        .child(
            svg()
                .path("icons/volume-x.svg")
                .size(px(10.))
                .flex_none()
                .text_color(seg_label(theme, color)),
        )
        .child("Muted")
}

/// The playhead's own x is clamped to the timeline width so it parks at the
/// right edge instead of running off it:
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

/// The playhead: a 1px column from the ruler's baseline to the bottom of the
/// card, with a 12px head ringed in the card's own colour so it reads as a
/// knob rather than a dot on the line. gpui has no outline, so the ring is a
/// wider circle of card painted under the head.
pub fn render_playhead(theme: &Theme, x: f32, opacity: f32) -> AnyElement {
    let color = Hsla::from(theme.editor.playhead);
    render_line(
        color,
        x,
        opacity,
        Some((12., color, theme.editor.card.into())),
    )
}

/// The hover preview line (`TL/index.tsx:1255-1277`).
pub fn render_preview_line(theme: &Theme, x: f32) -> AnyElement {
    let color = with_alpha(Hsla::from(theme.editor.text_3), 0.5);
    render_line(color, x, 1., Some((10., color, theme.editor.card.into())))
}

fn render_line(color: Hsla, x: f32, opacity: f32, head: Option<(f32, Hsla, Hsla)>) -> AnyElement {
    div()
        .absolute()
        // `left: ${TIMELINE_PADDING + TRACK_GUTTER}px` (`TL/index.tsx:1285`),
        // measured from the card's padding box -- which is where gpui resolves
        // an absolutely positioned child from too.
        .left(px(TIMELINE_PADDING + TRACK_GUTTER + x))
        .top(px(PLAYHEAD_TOP_OFFSET))
        .bottom_0()
        .w(px(1.))
        .opacity(opacity)
        .bg(color)
        .children(head.map(|(size, fill, ring)| {
            let ring_size = size + 4.;
            div()
                .absolute()
                .top(px(-ring_size / 2.))
                .left(px(-(ring_size - 1.) / 2.))
                .size(px(ring_size))
                .rounded_full()
                .flex()
                .items_center()
                .justify_center()
                .bg(ring)
                .child(div().size(px(size)).rounded_full().bg(fill))
        }))
        .into_any_element()
}

/// `zoomDelta = (e.deltaY * Math.sqrt(transform().zoom)) / 30`
/// (`TL/index.tsx:1191`). `deltaY` is the **DOM** sign convention: positive is
/// a scroll downwards, which zooms *out*.
pub fn wheel_zoom_delta(dom_delta_y: f64, zoom: f64) -> f64 {
    dom_delta_y * zoom.max(0.).sqrt() / 30.
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
        assert!(
            (transform.position - 25.).abs() < 1e-9,
            "{}",
            transform.position
        );
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
        assert!(
            (transform.position - 75.).abs() < 1e-9,
            "{}",
            transform.position
        );
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
        assert!(
            (transform.zoom - 60. / 1.1).abs() < 1e-9,
            "{}",
            transform.zoom
        );
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
        assert!(
            (transform.zoom - 1111. / 80.).abs() < 1e-9,
            "{}",
            transform.zoom
        );
        // A project that already fits is untouched.
        let mut wide = Transform::initial(5.0);
        let before = wide.zoom;
        wide.fit_on_mount(1111., 5.0);
        assert_eq!(wide.zoom, before);
    }

    // -- Geometry -----------------------------------------------------------

    /// The editor's default width: 1275 minus 16 (slot), 24 (the card's
    /// hairline and padding), 4 (`pr-1`) and 104 (gutter) = 1127px of track
    /// content starting at x = 124, with the ruler's own strip four pixels
    /// wider.
    #[test]
    fn the_content_column_carries_the_scroll_bodys_padding() {
        assert_eq!(content_width(1275.), 1127.);
        assert_eq!(ruler_width(1275.), 1131.);
        assert_eq!(content_left(), 124.);
    }

    #[test]
    fn a_click_maps_x_to_time_through_the_transform() {
        let width = 1275.;
        let total = 60.0;
        let transform = Transform::initial(total);
        let content = content_width(width);

        assert!(time_from_x(124., width, transform, total).abs() < 1e-9);
        let end = time_from_x(124. + content, width, transform, total);
        assert!((end - total).abs() < 1e-6, "{end}");
        let middle = time_from_x(124. + content / 2., width, transform, total);
        assert!((middle - total / 2.).abs() < 1e-6, "{middle}");
    }

    #[test]
    fn a_click_snaps_to_zero_and_clamps() {
        let width = 1275.;
        let total = 60.0;
        let transform = Transform::initial(total);
        assert_eq!(time_from_x(124. + 9., width, transform, total), 0.0);
        assert!(time_from_x(124. + 11., width, transform, total) > 0.0);
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
        let time = time_from_x(124. + content_width(width) / 2., width, transform, 600.);
        assert!((time - 25.0).abs() < 1e-6, "{time}");
    }

    /// The hover preview is *not* the click mapping: outside the content
    /// column it clears rather than clamping, and it has no upper bound.
    #[test]
    fn the_hover_preview_clears_outside_the_content_column() {
        let width = 1275.;
        let transform = Transform::initial(60.);
        assert_eq!(preview_time_from_x(123., width, transform), None);
        assert_eq!(
            preview_time_from_x(124. + content_width(width) + 1., width, transform),
            None
        );
        assert_eq!(preview_time_from_x(124. + 5., width, transform), Some(0.));
        let middle = preview_time_from_x(124. + content_width(width) / 2., width, transform);
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
    /// contribute one row per used lane with the highest-priority lane first,
    /// and the two locked tracks are always there.
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
        let rows: Vec<(TrackKind, u32)> =
            model.rows.iter().map(|row| (row.kind, row.lane)).collect();
        assert_eq!(
            rows,
            vec![
                (TrackKind::Clip, 0),
                // Captions: no settings block, but the project has a caption
                // segment, which is the fallback (`ED/context.ts:1414-1416`).
                (TrackKind::Caption, 0),
                (TrackKind::Keyboard, 0),
                (TrackKind::Text, 2),
                (TrackKind::Text, 1),
                (TrackKind::Text, 0),
                (TrackKind::Mask, 0),
                (TrackKind::Audio, 0),
                (TrackKind::Zoom, 0),
                (TrackKind::ThreeD, 0),
                (TrackKind::Scene, 0),
            ]
        );
        assert_eq!(model.track_height(), TRACK_HEIGHT);
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
        assert_eq!(without_camera.track_height(), TRACK_HEIGHT);

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
        assert!(
            (model.total_duration - 23.0).abs() < 1e-9,
            "{}",
            model.total_duration
        );
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
    fn muting_a_split_hides_only_its_waveform_and_shows_a_muted_glyph() {
        let mut config: ProjectConfiguration = serde_json::from_value(serde_json::json!({
            "timeline": {
                "segments": [{ "recordingSegment": 0, "timescale": 1.0, "start": 0.0, "end": 10.0 }],
                "zoomSegments": []
            }
        }))
        .unwrap();
        assert!(crate::editor_edits::split_clip_segment(
            config.timeline.as_mut().unwrap(),
            5.0,
            Some(0),
        ));

        for muted in [true, false] {
            assert!(crate::editor_edits::set_clip_muted(
                config.timeline.as_mut().unwrap(),
                1,
                muted,
            ));
            let model = TimelineModel::build(&config, false, false);
            assert!(model.clips[0].detail.shows_waveform());
            assert_eq!(model.clips[1].detail.shows_waveform(), !muted);
            assert!(matches!(
                model.clips[1].detail,
                SegmentDetail::Clip { muted: value, .. } if value == muted
            ));

            for theme in [Theme::light(), Theme::dark()] {
                let color = TrackKind::Clip.color();
                for (tier, width) in [(LabelTier::Full, 140.0), (LabelTier::Compact, 64.0)] {
                    assert!(label_body(&theme, color, &model.clips[1], tier, width).is_some());
                }
                assert_eq!(
                    label_body(&theme, color, &model.clips[1], LabelTier::Glyph, 24.0).is_some(),
                    muted,
                );
            }
        }
    }

    #[test]
    fn clip_mute_indicators_follow_speed_audio_modes() {
        let config: ProjectConfiguration = serde_json::from_value(serde_json::json!({
            "timeline": {
                "segments": [
                    { "recordingSegment": 0, "timescale": 2.0, "start": 0.0, "end": 2.0 },
                    { "recordingSegment": 0, "timescale": 2.0, "start": 2.0, "end": 4.0, "speedAudioMode": "maintainPitch" },
                    { "recordingSegment": 0, "timescale": 0.5, "start": 4.0, "end": 6.0, "speedAudioMode": "mute" },
                    { "recordingSegment": 0, "timescale": 0.5, "start": 6.0, "end": 8.0, "speedAudioMode": "matchSpeed" }
                ],
                "zoomSegments": []
            }
        }))
        .unwrap();
        let model = TimelineModel::build(&config, false, false);
        for (clip, expected_muted) in model.clips.iter().zip([true, false, true, false]) {
            assert!(matches!(
                clip.detail,
                SegmentDetail::Clip { muted, .. } if muted == expected_muted
            ));
            assert!(!clip.detail.shows_waveform());
        }
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

    #[test]
    fn scene_preview_and_creation_share_non_overlapping_placement() {
        let scene = |start, end| Segment {
            start,
            end,
            lane: 0,
            detail: SegmentDetail::Scene {
                mode: SceneMode::CameraOnly,
            },
        };
        let model = TimelineModel {
            scene: vec![scene(2.0, 5.0), scene(8.0, 11.0)],
            total_duration: 20.0,
            ..TimelineModel::default()
        };
        assert_eq!(new_scene_segment(&model, 0.0), Some((0.0, 2.0)));
        assert_eq!(new_scene_segment(&model, 5.0), Some((5.0, 8.0)));
        assert_eq!(new_scene_segment(&model, 7.5), Some((7.5, 8.0)));
        assert_eq!(new_scene_segment(&model, 11.0), Some((11.0, 14.0)));
        assert_eq!(new_scene_segment(&model, 19.0), Some((19.0, 20.0)));
        for time in [2.0, 4.9, 7.6, 8.0, 19.6, 20.0] {
            assert_eq!(new_scene_segment(&model, time), None, "{time}");
        }
        let mut reordered = model.clone();
        reordered.scene.reverse();
        assert_eq!(new_scene_segment(&reordered, 0.0), Some((0.0, 2.0)));
        assert_eq!(new_scene_segment(&reordered, 5.0), Some((5.0, 8.0)));
    }

    #[test]
    fn scene_placement_requires_a_finite_half_second_of_recording() {
        let mut model = TimelineModel {
            total_duration: 0.5,
            ..TimelineModel::default()
        };
        assert_eq!(new_scene_segment(&model, 0.0), Some((0.0, 0.5)));
        for time in [-1.0, 0.1, f64::NAN, f64::INFINITY] {
            assert_eq!(new_scene_segment(&model, time), None);
        }
        for duration in [0.0, 0.49, f64::NAN, f64::INFINITY] {
            model.total_duration = duration;
            assert_eq!(new_scene_segment(&model, 0.0), None);
        }
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
        let (_, chip) = minimap_chip(
            Transform {
                zoom: 1.,
                position: 0.,
            },
            3600.,
            1000.,
        );
        assert_eq!(chip, MINIMAP_MIN_CHIP_WIDTH);
    }

    #[test]
    fn minimap_drag_moves_the_viewport_and_clamps_outside_the_track() {
        let mut transform = Transform {
            zoom: 20.,
            position: 20.,
        };
        let drag = MinimapDrag::begin(400., 100., 1000., 100., &mut transform).unwrap();
        assert_eq!(drag.kind, MinimapDragKind::Move);
        assert_eq!(
            drag.update(600., 100.),
            Transform {
                zoom: 20.,
                position: 40.
            }
        );
        assert_eq!(drag.update(-1000., 100.).position, 0.);
        assert_eq!(drag.update(3000., 100.).position, 84.);
    }

    #[test]
    fn minimap_track_click_centers_then_drags_from_the_new_position() {
        let mut transform = Transform {
            zoom: 20.,
            position: 0.,
        };
        let drag = MinimapDrag::begin(850., 100., 1000., 100., &mut transform).unwrap();
        assert_eq!(drag.kind, MinimapDragKind::Move);
        assert_eq!(transform.position, 65.);
        assert_eq!(drag.update(950., 100.).position, 75.);
    }

    #[test]
    fn minimap_resize_keeps_the_opposite_edge_fixed() {
        let mut transform = Transform {
            zoom: 20.,
            position: 20.,
        };
        let left = MinimapDrag::begin(301., 100., 1000., 100., &mut transform).unwrap();
        assert_eq!(left.kind, MinimapDragKind::Left);
        let resized = left.update(251., 100.);
        assert_eq!(
            resized,
            Transform {
                zoom: 25.,
                position: 15.
            }
        );
        assert_eq!(resized.position + resized.zoom, 40.);
        let right = MinimapDrag::begin(499., 100., 1000., 100., &mut transform).unwrap();
        assert_eq!(right.kind, MinimapDragKind::Right);
        assert_eq!(
            right.update(599., 100.),
            Transform {
                zoom: 30.,
                position: 20.
            }
        );
        assert_eq!(
            right.update(0., 100.),
            Transform {
                zoom: MAX_ZOOM_IN,
                position: 20.
            }
        );
    }

    #[test]
    fn minimap_drag_uses_the_chip_floor_without_dividing_by_zero() {
        let mut transform = Transform {
            zoom: 3.,
            position: 0.,
        };
        let drag = MinimapDrag::begin(10., 0., 1000., 3600., &mut transform).unwrap();
        assert_eq!(drag.kind, MinimapDragKind::Move);
        assert!((drag.update(990., 3600.).position - 3597.).abs() < 1e-9);
        assert!(MinimapDrag::begin(10., 0., 0., 3600., &mut transform).is_none());
        assert!(MinimapDrag::begin(10., 0., 1000., 3., &mut transform).is_none());
    }
}

#[cfg(test)]
mod style_image_tests {
    use super::*;

    #[test]
    fn timeline_rows_follow_the_saved_overlay_order() {
        let project: ProjectConfiguration = serde_json::from_value(serde_json::json!({
            "overlayOrder": [
                {"kind": "mask", "track": 0},
                {"kind": "image", "track": 0},
                {"kind": "text", "track": 0}
            ],
            "timeline": {
                "segments": [{"start": 0, "end": 20, "timescale": 1}],
                "zoomSegments": [],
                "textSegments": [{"start": 1, "end": 5, "track": 0, "content": "Text"}],
                "imageSegments": [{"start": 1, "end": 5, "track": 0, "path": "image.png"}],
                "maskSegments": [{
                    "start": 1,
                    "end": 5,
                    "track": 0,
                    "maskType": "sensitive",
                    "center": {"x": 0.5, "y": 0.5},
                    "size": {"x": 0.2, "y": 0.2}
                }]
            }
        }))
        .unwrap();
        let model = TimelineModel::build(&project, false, false);
        let overlays = model
            .rows
            .iter()
            .filter(|row| row.kind.overlay_track(row.lane).is_some())
            .copied()
            .collect::<Vec<_>>();
        assert_eq!(
            overlays,
            [
                TrackRow {
                    kind: TrackKind::Mask,
                    lane: 0
                },
                TrackRow {
                    kind: TrackKind::Image,
                    lane: 0
                },
                TrackRow {
                    kind: TrackKind::Text,
                    lane: 0
                }
            ]
        );
    }

    #[test]
    fn style_image_scene_availability_uses_source_camera_and_stable_style_requirement() {
        let mut project: ProjectConfiguration = serde_json::from_value(serde_json::json!({
            "camera":{"hide":true}, "timeline":{"zoomSegments":[],"segments":[{"start":0,"end":20,"timescale":1}],
            "styleSegments":[{"start":3,"end":5,"overrides":{"camera":{"hide":false}}}]}
        }))
        .unwrap();
        assert!(scene_available(&project, true));
        assert!(!scene_available(&project, false));
        assert!(TrackLanes::from_project(&project, true).scene);
        assert!(
            TimelineModel::build(&project, true, false)
                .rows
                .iter()
                .any(|row| row.kind == TrackKind::Scene)
        );
        project.timeline.as_mut().unwrap().style_segments[0].enabled = false;
        assert!(!scene_available(&project, true));
        project.timeline.as_mut().unwrap().scene_segments.push(
            serde_json::from_value(serde_json::json!({"start":1,"end":3,"mode":"cameraOnly"}))
                .unwrap(),
        );
        assert!(scene_available(&project, true));
        assert!(!scene_available(&project, false));
    }
}
