//! Copy text from a screenshot: the Tauri editor's `OcrSelectionOverlay.tsx`
//! and its `recognize_screenshot_text` command, natively.
//!
//! The source image is recognised once per editor, off the UI thread (Apple
//! Vision on macOS, `Windows.Media.Ocr` on Windows; Linux had no engine in
//! the Tauri app either, so the layer never appears there). Lines and word
//! boxes come back in source-image pixels, so crop, padding, aspect, zoom and
//! pan are pure mapping on top and never re-run recognition.

use std::ops::Range;
use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Instant;

use gpui::IntoElement as _;
use gpui::{
    Bounds, ClipboardItem, Context, CursorStyle, HitboxBehavior, MouseDownEvent, MouseMoveEvent,
    MouseUpEvent, Pixels, Point, Styled as _, Window, canvas, px,
};

use crate::i18n::tr;
use crate::screenshot_annotations::{Rect, Tool};
use crate::screenshot_editor::ScreenshotEditorWindow;
use crate::ui;

pub(crate) const SUPPORTED: bool = cfg!(any(target_os = "macos", target_os = "windows"));

/// Above this the image is downscaled before recognition, which bounds the
/// decoded copy the engine holds next to the renderer's.
const MAX_RECOGNITION_PIXELS: u64 = 50_000_000;

/// How far outside a line's box a press still lands on its text, in screen
/// pixels.
const HIT_SLOP: f64 = 3.;

/// Measurement size for the per-character advances. Only the ratios matter.
const ADVANCE_FONT_SIZE: f32 = 32.;

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq)]
pub struct RecognizedWord {
    /// Byte range in the line's text.
    pub range: Range<usize>,
    pub bounds: Rect,
}

#[derive(Debug, Clone, PartialEq)]
pub struct RecognizedLine {
    pub text: String,
    pub bounds: Rect,
    pub words: Vec<RecognizedWord>,
}

/// A character boundary: its byte offset in the line and its x in source
/// pixels.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Stop {
    pub byte: usize,
    pub x: f64,
}

#[derive(Debug, Clone)]
pub struct TextLine {
    pub text: String,
    pub bounds: Rect,
    /// One per character boundary, so `chars + 1` long, x non-decreasing.
    pub stops: Vec<Stop>,
}

impl TextLine {
    fn char_count(&self) -> usize {
        self.stops.len().saturating_sub(1)
    }

    fn char_at(&self, index: usize) -> Option<char> {
        let start = self.stops.get(index)?.byte;
        let end = self.stops.get(index + 1)?.byte;
        self.text.get(start..end)?.chars().next()
    }
}

/// A caret between two characters: the line's index in the layer and the
/// stop index in that line. Ordered the way the text reads.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub struct TextPosition {
    pub line: usize,
    pub index: usize,
}

/// The part of a line that survives the crop, as a stop range.
#[derive(Debug, Clone, PartialEq)]
pub struct VisibleLine {
    pub line: usize,
    pub stops: Range<usize>,
}

#[derive(Debug, Default)]
pub struct TextLayer {
    pub lines: Vec<TextLine>,
}

/// Lays each line's characters out across its recognised box. Word boxes pin
/// the words where the engine saw them; inside a word, and across the gaps
/// between words, characters share the span by their advance in the UI
/// font, the way the Tauri overlay stretched a measured run to the line.
pub fn layout_stops(
    text: &str,
    bounds: Rect,
    words: &[RecognizedWord],
    advance: &mut impl FnMut(char) -> f64,
) -> Vec<Stop> {
    let left = bounds.x;
    let right = bounds.x + bounds.width.max(0.);
    if text.is_empty() {
        return vec![Stop { byte: 0, x: left }];
    }

    let mut spans: Vec<(Range<usize>, f64, f64)> = Vec::new();
    let mut cursor = 0usize;
    let mut cursor_x = left;
    for word in words {
        let range = word.range.clone();
        if range.start < cursor
            || range.end <= range.start
            || range.end > text.len()
            || !text.is_char_boundary(range.start)
            || !text.is_char_boundary(range.end)
            || !word.bounds.width.is_finite()
            || !word.bounds.x.is_finite()
        {
            continue;
        }
        let word_left = word.bounds.x.clamp(cursor_x, right);
        let word_right = (word.bounds.x + word.bounds.width.max(0.)).clamp(word_left, right);
        if range.start > cursor {
            spans.push((cursor..range.start, cursor_x, word_left));
        }
        spans.push((range.clone(), word_left, word_right));
        cursor = range.end;
        cursor_x = word_right;
    }
    if cursor < text.len() || spans.is_empty() {
        spans.push((cursor..text.len(), cursor_x, right.max(cursor_x)));
    }

    let end_x = spans.last().map_or(left, |(_, _, span_right)| *span_right);
    let mut stops = Vec::with_capacity(text.len() + 1);
    for (range, span_left, span_right) in spans {
        let chars: Vec<(usize, char)> = text[range.clone()]
            .char_indices()
            .map(|(offset, ch)| (range.start + offset, ch))
            .collect();
        let advances: Vec<f64> = chars
            .iter()
            .map(|(_, ch)| {
                let value = advance(*ch);
                if value.is_finite() && value > 0. {
                    value
                } else {
                    0.
                }
            })
            .collect();
        let total: f64 = advances.iter().sum();
        let width = span_right - span_left;
        let mut running = 0.;
        for (index, (byte, _)) in chars.iter().enumerate() {
            let fraction = if total > 0. {
                running / total
            } else {
                index as f64 / chars.len() as f64
            };
            stops.push(Stop {
                byte: *byte,
                x: span_left + width * fraction,
            });
            running += advances[index];
        }
    }
    stops.push(Stop {
        byte: text.len(),
        x: end_x,
    });

    let mut floor = f64::NEG_INFINITY;
    for stop in &mut stops {
        stop.x = stop.x.max(floor);
        floor = stop.x;
    }
    stops
}

impl TextLayer {
    pub fn build(lines: Vec<RecognizedLine>, advance: &mut impl FnMut(char) -> f64) -> Self {
        let lines = lines
            .into_iter()
            .filter(|line| {
                !line.text.trim().is_empty()
                    && line.bounds.width > 0.
                    && line.bounds.height > 0.
                    && line.bounds.x.is_finite()
                    && line.bounds.y.is_finite()
            })
            .map(|line| {
                let stops = layout_stops(&line.text, line.bounds, &line.words, advance);
                TextLine {
                    text: line.text,
                    bounds: line.bounds,
                    stops,
                }
            })
            .collect();
        Self { lines }
    }

    /// What the crop leaves of each line: lines whose vertical centre is
    /// inside it, trimmed to the characters whose centre is inside it.
    pub fn visible_lines(&self, crop: Rect) -> Vec<VisibleLine> {
        let crop_right = crop.x + crop.width;
        let crop_bottom = crop.y + crop.height;
        self.lines
            .iter()
            .enumerate()
            .filter_map(|(index, line)| {
                let center_y = line.bounds.y + line.bounds.height / 2.;
                if center_y < crop.y || center_y > crop_bottom {
                    return None;
                }
                let inside = |char_index: usize| {
                    let center = (line.stops[char_index].x + line.stops[char_index + 1].x) / 2.;
                    center >= crop.x && center <= crop_right
                };
                let count = line.char_count();
                let first = (0..count).find(|index| inside(*index))?;
                let last = (first..count).rev().find(|index| inside(*index))?;
                Some(VisibleLine {
                    line: index,
                    stops: first..last + 1,
                })
            })
            .collect()
    }

    fn visible_rect(&self, visible: &VisibleLine) -> Rect {
        let line = &self.lines[visible.line];
        let left = line.stops[visible.stops.start].x;
        let right = line.stops[visible.stops.end].x;
        Rect {
            x: left,
            y: line.bounds.y,
            width: right - left,
            height: line.bounds.height,
        }
    }

    /// The visible line under `point`, grown by `slop` on every side.
    pub fn line_at(&self, visible: &[VisibleLine], point: (f64, f64), slop: f64) -> Option<usize> {
        visible.iter().position(|entry| {
            let rect = self.visible_rect(entry);
            point.0 >= rect.x - slop
                && point.0 <= rect.x + rect.width + slop
                && point.1 >= rect.y - slop
                && point.1 <= rect.y + rect.height + slop
        })
    }

    fn caret_in(&self, entry: &VisibleLine, x: f64) -> TextPosition {
        let line = &self.lines[entry.line];
        let index = (entry.stops.start..=entry.stops.end)
            .min_by(|a, b| {
                let da = (line.stops[*a].x - x).abs();
                let db = (line.stops[*b].x - x).abs();
                da.total_cmp(&db)
            })
            .unwrap_or(entry.stops.start);
        TextPosition {
            line: entry.line,
            index,
        }
    }

    /// The caret a drag at `point` reaches: the nearest visible line by
    /// distance to its box, then the nearest boundary along it.
    pub fn position_near(
        &self,
        visible: &[VisibleLine],
        point: (f64, f64),
    ) -> Option<TextPosition> {
        let entry = visible.iter().min_by(|a, b| {
            let da = distance_to_rect(self.visible_rect(a), point);
            let db = distance_to_rect(self.visible_rect(b), point);
            da.total_cmp(&db)
        })?;
        Some(self.caret_in(entry, point.0))
    }

    /// The run of same-class characters the caret touches -- a word, a run of
    /// spaces, or one piece of punctuation -- clamped to what is visible.
    pub fn word_at(
        &self,
        visible: &VisibleLine,
        position: TextPosition,
    ) -> (TextPosition, TextPosition) {
        let line = &self.lines[visible.line];
        let bounds = visible.stops.clone();
        let index = position.index.clamp(bounds.start, bounds.end);
        let probe = if index >= bounds.end {
            index.saturating_sub(1).max(bounds.start)
        } else {
            index
        };
        let at = |index: usize| TextPosition {
            line: visible.line,
            index,
        };
        let Some(class) = line.char_at(probe).map(char_class) else {
            return (at(index), at(index));
        };
        if class == CharClass::Other {
            return (at(probe), at((probe + 1).min(bounds.end)));
        }
        let mut start = probe;
        while start > bounds.start && line.char_at(start - 1).map(char_class) == Some(class) {
            start -= 1;
        }
        let mut end = probe + 1;
        while end < bounds.end && line.char_at(end).map(char_class) == Some(class) {
            end += 1;
        }
        (at(start), at(end.min(bounds.end)))
    }

    /// Each selected fragment as `(line, stop range)`, in reading order.
    pub fn fragments(
        &self,
        visible: &[VisibleLine],
        a: TextPosition,
        b: TextPosition,
    ) -> Vec<(usize, Range<usize>)> {
        let (low, high) = if a <= b { (a, b) } else { (b, a) };
        visible
            .iter()
            .filter(|entry| entry.line >= low.line && entry.line <= high.line)
            .filter_map(|entry| {
                let start = if entry.line == low.line {
                    low.index.max(entry.stops.start)
                } else {
                    entry.stops.start
                };
                let end = if entry.line == high.line {
                    high.index.min(entry.stops.end)
                } else {
                    entry.stops.end
                };
                (start < end).then_some((entry.line, start..end))
            })
            .collect()
    }

    /// The selection as text: each line's fragment, one per row, in the order
    /// the engine read them -- `Selection.toString()` over the Tauri spans.
    pub fn selected_text(
        &self,
        visible: &[VisibleLine],
        a: TextPosition,
        b: TextPosition,
    ) -> String {
        self.fragments(visible, a, b)
            .into_iter()
            .map(|(line, range)| {
                let line = &self.lines[line];
                &line.text[line.stops[range.start].byte..line.stops[range.end].byte]
            })
            .collect::<Vec<_>>()
            .join("\n")
    }

    /// The highlight, one source-space box per fragment.
    pub fn selection_rects(
        &self,
        visible: &[VisibleLine],
        a: TextPosition,
        b: TextPosition,
    ) -> Vec<Rect> {
        self.fragments(visible, a, b)
            .into_iter()
            .map(|(line, range)| {
                let line = &self.lines[line];
                let left = line.stops[range.start].x;
                Rect {
                    x: left,
                    y: line.bounds.y,
                    width: line.stops[range.end].x - left,
                    height: line.bounds.height,
                }
            })
            .collect()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CharClass {
    Word,
    Space,
    Other,
}

fn char_class(ch: char) -> CharClass {
    if ch.is_alphanumeric() || ch == '_' {
        CharClass::Word
    } else if ch.is_whitespace() {
        CharClass::Space
    } else {
        CharClass::Other
    }
}

fn distance_to_rect(rect: Rect, point: (f64, f64)) -> f64 {
    let dx = (rect.x - point.0)
        .max(point.0 - (rect.x + rect.width))
        .max(0.);
    let dy = (rect.y - point.1)
        .max(point.1 - (rect.y + rect.height))
        .max(0.);
    dx.hypot(dy)
}

/// The source rectangle the editor shows: the crop, or the whole image.
pub fn source_rect(image: (u32, u32), crop: Option<&cap_project::Crop>) -> Rect {
    match crop {
        Some(crop) => {
            let x = f64::from(crop.position.x.min(image.0));
            let y = f64::from(crop.position.y.min(image.1));
            Rect {
                x,
                y,
                width: (f64::from(crop.size.x)).min(f64::from(image.0) - x).max(0.),
                height: (f64::from(crop.size.y)).min(f64::from(image.1) - y).max(0.),
            }
        }
        None => Rect {
            x: 0.,
            y: 0.,
            width: f64::from(image.0),
            height: f64::from(image.1),
        },
    }
}

/// Source pixels to frame pixels: the crop lands on the image rect.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct SourceToFrame {
    pub source: Rect,
    pub image: Rect,
}

impl SourceToFrame {
    fn scale(&self) -> Option<(f64, f64)> {
        (self.source.width > 0.
            && self.source.height > 0.
            && self.image.width > 0.
            && self.image.height > 0.)
            .then(|| {
                (
                    self.image.width / self.source.width,
                    self.image.height / self.source.height,
                )
            })
    }

    pub fn rect_to_frame(&self, rect: Rect) -> Option<Rect> {
        let (sx, sy) = self.scale()?;
        Some(Rect {
            x: self.image.x + (rect.x - self.source.x) * sx,
            y: self.image.y + (rect.y - self.source.y) * sy,
            width: rect.width * sx,
            height: rect.height * sy,
        })
    }

    pub fn point_to_source(&self, point: (f64, f64)) -> Option<(f64, f64)> {
        let (sx, sy) = self.scale()?;
        Some((
            self.source.x + (point.0 - self.image.x) / sx,
            self.source.y + (point.1 - self.image.y) / sy,
        ))
    }

    /// Source pixels per frame pixel, for turning a screen slop into source.
    fn source_per_frame(&self) -> f64 {
        self.scale().map_or(1., |(sx, _)| 1. / sx)
    }
}

// ---------------------------------------------------------------------------
// Recognition
// ---------------------------------------------------------------------------

pub struct OcrImage {
    pub bgra: Vec<u8>,
    pub width: u32,
    pub height: u32,
}

/// The largest size, aspect kept, that fits `max_pixels` and `max_side`.
pub fn recognition_size(width: u32, height: u32, max_pixels: u64, max_side: u32) -> (u32, u32) {
    let area = u64::from(width) * u64::from(height);
    let mut scale = 1f64;
    if area > max_pixels {
        scale = scale.min((max_pixels as f64 / area as f64).sqrt());
    }
    let long = width.max(height);
    if long > max_side {
        scale = scale.min(f64::from(max_side) / f64::from(long));
    }
    if scale >= 1. {
        return (width, height);
    }
    (
        ((f64::from(width) * scale).floor() as u32).clamp(1, width),
        ((f64::from(height) * scale).floor() as u32).clamp(1, height),
    )
}

fn scale_rect(rect: Rect, sx: f64, sy: f64) -> Rect {
    Rect {
        x: rect.x * sx,
        y: rect.y * sy,
        width: rect.width * sx,
        height: rect.height * sy,
    }
}

/// Decode, fit, recognise, and map the boxes back to source pixels.
pub fn recognize_file(path: &Path, cancel: &AtomicBool) -> Result<Vec<RecognizedLine>, String> {
    let decoded = image::open(path)
        .map_err(|error| error.to_string())?
        .to_rgba8();
    let (width, height) = decoded.dimensions();
    if width == 0 || height == 0 {
        return Ok(Vec::new());
    }
    let (fit_width, fit_height) =
        recognition_size(width, height, MAX_RECOGNITION_PIXELS, platform::max_side()?);
    let rgba = if (fit_width, fit_height) == (width, height) {
        decoded
    } else {
        image::imageops::resize(
            &decoded,
            fit_width,
            fit_height,
            image::imageops::FilterType::Triangle,
        )
    };
    let mut bgra = rgba.into_raw();
    for pixel in bgra.chunks_exact_mut(4) {
        pixel.swap(0, 2);
    }
    let lines = recognize_tiled(&bgra, fit_width, fit_height, cancel)?;
    if (fit_width, fit_height) == (width, height) {
        return Ok(lines);
    }
    let sx = f64::from(width) / f64::from(fit_width);
    let sy = f64::from(height) / f64::from(fit_height);
    Ok(lines
        .into_iter()
        .map(|line| RecognizedLine {
            bounds: scale_rect(line.bounds, sx, sy),
            words: line
                .words
                .into_iter()
                .map(|word| RecognizedWord {
                    bounds: scale_rect(word.bounds, sx, sy),
                    range: word.range,
                })
                .collect(),
            text: line.text,
        })
        .collect())
}

/// Vision scales the whole image down to its own working size before it
/// reads it, so on a large capture ordinary text shrinks below what it can
/// see (an 8K capture of 22px text comes back empty). Past the threshold the
/// image is read in overlapping tiles and the pieces are stitched back.
fn recognize_tiled(
    bgra: &[u8],
    width: u32,
    height: u32,
    cancel: &AtomicBool,
) -> Result<Vec<RecognizedLine>, String> {
    let tiles = match platform::TILING {
        Some(tiling) if width.max(height) > tiling.threshold => {
            tile_rects(width, height, tiling.side, tiling.overlap)
        }
        _ => vec![(0, 0, width, height)],
    };
    if tiles.len() == 1 {
        return platform::recognize(OcrImage {
            bgra: bgra.to_vec(),
            width,
            height,
        });
    }
    let mut lines = Vec::new();
    for tile in tiles {
        if cancel.load(Ordering::Relaxed) {
            return Err("cancelled".to_string());
        }
        let found = platform::recognize(OcrImage {
            bgra: crop_bgra(bgra, width, tile),
            width: tile.2,
            height: tile.3,
        })?;
        lines.extend(place_tile_lines(found, tile, (width, height)));
    }
    Ok(merge_tile_lines(lines))
}

/// Tiles of `side` (clamped to the image) overlapping by at least
/// `overlap`, the last one in each direction flush with the far edge.
pub fn tile_rects(width: u32, height: u32, side: u32, overlap: u32) -> Vec<(u32, u32, u32, u32)> {
    let starts = |length: u32| -> Vec<u32> {
        if length <= side {
            return vec![0];
        }
        let step = side.saturating_sub(overlap).max(1);
        let mut starts = Vec::new();
        let mut start = 0;
        while start + side < length {
            starts.push(start);
            start += step;
        }
        starts.push(length - side);
        starts
    };
    let xs = starts(width);
    let ys = starts(height);
    ys.iter()
        .flat_map(|y| {
            xs.iter()
                .map(move |x| (*x, *y, side.min(width), side.min(height)))
        })
        .collect()
}

fn crop_bgra(bgra: &[u8], width: u32, (x, y, w, h): (u32, u32, u32, u32)) -> Vec<u8> {
    let row = width as usize * 4;
    let mut out = Vec::with_capacity(w as usize * h as usize * 4);
    for line in y as usize..(y + h) as usize {
        let start = line * row + x as usize * 4;
        out.extend_from_slice(&bgra[start..start + w as usize * 4]);
    }
    out
}

/// Tile lines into image space, without the ones the tile's inner top or
/// bottom edge cut through: the overlap is taller than a line, so the
/// neighbouring tile holds each of those whole.
pub fn place_tile_lines(
    lines: Vec<RecognizedLine>,
    (x, y, w, h): (u32, u32, u32, u32),
    image: (u32, u32),
) -> Vec<RecognizedLine> {
    const EDGE: f64 = 2.;
    let top_inner = y > 0;
    let bottom_inner = y + h < image.1;
    let offset = |rect: Rect| Rect {
        x: rect.x + f64::from(x),
        y: rect.y + f64::from(y),
        ..rect
    };
    lines
        .into_iter()
        .filter(|line| {
            !(top_inner && line.bounds.y <= EDGE)
                && !(bottom_inner && line.bounds.y + line.bounds.height >= f64::from(h) - EDGE)
        })
        .map(|line| RecognizedLine {
            bounds: offset(line.bounds),
            words: line
                .words
                .into_iter()
                .map(|word| RecognizedWord {
                    bounds: offset(word.bounds),
                    range: word.range,
                })
                .collect(),
            text: line.text,
        })
        .collect()
}

fn overlap(a_start: f64, a_len: f64, b_start: f64, b_len: f64) -> f64 {
    ((a_start + a_len).min(b_start + b_len) - a_start.max(b_start)).max(0.)
}

fn union(a: Rect, b: Rect) -> Rect {
    let left = a.x.min(b.x);
    let top = a.y.min(b.y);
    Rect {
        x: left,
        y: top,
        width: (a.x + a.width).max(b.x + b.width) - left,
        height: (a.y + a.height).max(b.y + b.height) - top,
    }
}

struct Piece {
    text: String,
    bounds: Rect,
}

/// Stitches lines read from overlapping tiles: pieces of one line seen by
/// two tiles join on their word boxes (a word both saw is kept once, the
/// taller then wider reading winning, since a tile edge clips glyphs), and
/// the result is put in reading order, row by row, left to right.
pub fn merge_tile_lines(lines: Vec<RecognizedLine>) -> Vec<RecognizedLine> {
    let mut rows: Vec<(Rect, Vec<Piece>)> = Vec::new();
    for line in lines {
        let pieces: Vec<Piece> = if line.words.is_empty() {
            vec![Piece {
                text: line.text.trim().to_string(),
                bounds: line.bounds,
            }]
        } else {
            line.words
                .iter()
                .filter_map(|word| {
                    Some(Piece {
                        text: line.text.get(word.range.clone())?.to_string(),
                        bounds: word.bounds,
                    })
                })
                .collect()
        };
        let bounds = line.bounds;
        let row = rows.iter_mut().find(|(row, _)| {
            let min_height = row.height.min(bounds.height);
            overlap(row.y, row.height, bounds.y, bounds.height) >= min_height * 0.6
                && overlap(row.x, row.width, bounds.x, bounds.width) > 0.
        });
        let Some((row, existing)) = row else {
            rows.push((bounds, pieces));
            continue;
        };
        *row = union(*row, bounds);
        for piece in pieces {
            let twin = existing.iter_mut().find(|other| {
                let min_width = other.bounds.width.min(piece.bounds.width);
                let min_height = other.bounds.height.min(piece.bounds.height);
                overlap(
                    other.bounds.x,
                    other.bounds.width,
                    piece.bounds.x,
                    piece.bounds.width,
                ) > min_width * 0.5
                    && overlap(
                        other.bounds.y,
                        other.bounds.height,
                        piece.bounds.y,
                        piece.bounds.height,
                    ) > min_height * 0.5
            });
            match twin {
                Some(other) => {
                    let taller = piece.bounds.height > other.bounds.height * 1.1;
                    let shorter = other.bounds.height > piece.bounds.height * 1.1;
                    if taller || (!shorter && piece.bounds.width > other.bounds.width) {
                        *other = piece;
                    }
                }
                None => existing.push(piece),
            }
        }
    }

    let mut merged: Vec<RecognizedLine> = rows
        .into_iter()
        .filter_map(|(_, mut pieces)| {
            pieces.retain(|piece| !piece.text.is_empty());
            pieces.sort_by(|a, b| a.bounds.x.total_cmp(&b.bounds.x));
            let mut text = String::new();
            let mut words = Vec::new();
            let mut bounds: Option<Rect> = None;
            for piece in pieces {
                if !text.is_empty() {
                    text.push(' ');
                }
                let start = text.len();
                text.push_str(&piece.text);
                words.push(RecognizedWord {
                    range: start..text.len(),
                    bounds: piece.bounds,
                });
                bounds = Some(bounds.map_or(piece.bounds, |rect| union(rect, piece.bounds)));
            }
            Some(RecognizedLine {
                text,
                bounds: bounds?,
                words,
            })
        })
        .collect();

    merged.sort_by(|a, b| {
        (a.bounds.y + a.bounds.height / 2.).total_cmp(&(b.bounds.y + b.bounds.height / 2.))
    });
    let mut ordered = Vec::with_capacity(merged.len());
    let mut row: Vec<RecognizedLine> = Vec::new();
    for line in merged {
        let joins = row.first().is_some_and(|first| {
            let first_center = first.bounds.y + first.bounds.height / 2.;
            let center = line.bounds.y + line.bounds.height / 2.;
            (center - first_center).abs() < first.bounds.height.min(line.bounds.height) * 0.5
        });
        if !joins {
            row.sort_by(|a, b| a.bounds.x.total_cmp(&b.bounds.x));
            ordered.append(&mut row);
        }
        row.push(line);
    }
    row.sort_by(|a, b| a.bounds.x.total_cmp(&b.bounds.x));
    ordered.append(&mut row);
    ordered
}

/// Byte ranges of the whitespace-separated words in `text`.
pub fn word_ranges(text: &str) -> Vec<Range<usize>> {
    let mut ranges = Vec::new();
    let mut start = None;
    for (index, ch) in text.char_indices() {
        match (ch.is_whitespace(), start) {
            (true, Some(begin)) => {
                ranges.push(begin..index);
                start = None;
            }
            (false, None) => start = Some(index),
            _ => {}
        }
    }
    if let Some(begin) = start {
        ranges.push(begin..text.len());
    }
    ranges
}

pub struct Tiling {
    pub threshold: u32,
    pub side: u32,
    pub overlap: u32,
}

#[cfg(target_os = "macos")]
mod platform {
    use super::{OcrImage, RecognizedLine, RecognizedWord, Rect, Tiling, word_ranges};

    /// 2880px wide captures read whole on macOS 15 and 26; 3456px lost a
    /// third of their lines on 15, and 4K and 5K lost most or all of them.
    pub const TILING: Option<Tiling> = Some(Tiling {
        threshold: 2560,
        side: 2048,
        overlap: 256,
    });

    pub fn max_side() -> Result<u32, String> {
        Ok(u32::MAX)
    }

    /// The Tauri app's `recognize_screenshot_ocr_image_macos`, plus a box per
    /// word (`boundingBoxForRange:`) so a selection lands on the glyphs.
    pub fn recognize(image: OcrImage) -> Result<Vec<RecognizedLine>, String> {
        cidre::objc::ar_pool(|| {
            use cidre::{cv, ns, vn};
            use std::ffi::c_void;

            extern "C" fn release_pixel_buffer_data(
                release_ref_con: *mut c_void,
                _base_address: *const *const c_void,
            ) {
                if !release_ref_con.is_null() {
                    unsafe {
                        drop(Box::from_raw(release_ref_con.cast::<Vec<u8>>()));
                    }
                }
            }

            let width = image.width as usize;
            let height = image.height as usize;
            let bytes_per_row = width
                .checked_mul(4)
                .ok_or_else(|| "OCR image row is too large".to_string())?;
            let mut data = Box::new(image.bgra);
            let base_address = data.as_mut_ptr().cast::<c_void>();
            let release_ref_con = Box::into_raw(data).cast::<c_void>();

            let pixel_buffer = match cv::PixelBuf::with_bytes(
                width,
                height,
                base_address,
                bytes_per_row,
                release_pixel_buffer_data,
                release_ref_con,
                cv::PixelFormat::_32_BGRA,
                None,
            ) {
                Ok(pixel_buffer) => pixel_buffer,
                Err(error) => {
                    unsafe {
                        drop(Box::from_raw(release_ref_con.cast::<Vec<u8>>()));
                    }
                    return Err(format!("Failed to create OCR image: {error}"));
                }
            };

            let mut request = vn::RecognizeTextRequest::new();
            request.set_recognition_level(vn::RequestTextRecognitionLevel::Accurate);
            request.set_uses_lang_correction(true);
            if cidre::version!(macos = 13.0) {
                request.set_revision(vn::RecognizeTextRequest::REVISION_3);
                unsafe {
                    request.set_automatically_detects_lang(true);
                }
            } else {
                request.set_revision(vn::RecognizeTextRequest::REVISION_2);
            }

            let handler = vn::ImageRequestHandler::with_cv_pixel_buf(&pixel_buffer, None)
                .ok_or_else(|| "Failed to initialize OCR image handler".to_string())?;
            let requests = ns::Array::<vn::Request>::from_slice(&[&request]);
            handler
                .perform(&requests)
                .map_err(|error| format!("macOS OCR failed: {error}"))?;

            let size = (f64::from(image.width), f64::from(image.height));
            let observations = request.results().unwrap_or_else(ns::Array::new);
            let mut lines = Vec::new();
            for observation in observations.iter() {
                let candidates = observation.top_candidates(1);
                let Some(candidate) = candidates.first() else {
                    continue;
                };
                let text = candidate.string().to_string();
                if text.trim().is_empty() {
                    continue;
                }
                let words = word_ranges(&text)
                    .into_iter()
                    .filter_map(|range| {
                        let loc = text[..range.start].encode_utf16().count();
                        let len = text[range.clone()].encode_utf16().count();
                        let rect = candidate
                            .bounding_box_for_range(ns::Range::new(loc, len))
                            .ok()?
                            .bounding_box();
                        Some(RecognizedWord {
                            range,
                            bounds: normalized_to_pixels(rect, size)?,
                        })
                    })
                    .collect();
                let Some(bounds) = normalized_to_pixels(observation.bounding_box(), size) else {
                    continue;
                };
                lines.push(RecognizedLine {
                    text,
                    bounds,
                    words,
                });
            }
            Ok(lines)
        })
    }

    /// Vision's boxes are normalised with a bottom-left origin.
    fn normalized_to_pixels(rect: cidre::cg::Rect, size: (f64, f64)) -> Option<Rect> {
        let values = [
            rect.origin.x,
            rect.origin.y,
            rect.size.width,
            rect.size.height,
        ];
        if values.iter().any(|value| !value.is_finite()) {
            return None;
        }
        let left = (rect.origin.x * size.0).clamp(0., size.0);
        let right = ((rect.origin.x + rect.size.width) * size.0).clamp(left, size.0);
        let top = ((1. - rect.origin.y - rect.size.height) * size.1).clamp(0., size.1);
        let bottom = ((1. - rect.origin.y) * size.1).clamp(top, size.1);
        Some(Rect {
            x: left,
            y: top,
            width: right - left,
            height: bottom - top,
        })
    }
}

#[cfg(target_os = "windows")]
mod platform {
    use super::{OcrImage, RecognizedLine, RecognizedWord, Rect, Tiling};
    use windows::Graphics::Imaging::{BitmapAlphaMode, BitmapPixelFormat, SoftwareBitmap};
    use windows::Media::Ocr::OcrEngine;
    use windows::Storage::Streams::DataWriter;
    use windows::Win32::System::WinRT::{RO_INIT_MULTITHREADED, RoInitialize, RoUninitialize};

    struct RuntimeGuard;

    impl Drop for RuntimeGuard {
        fn drop(&mut self) {
            unsafe { RoUninitialize() };
        }
    }

    fn runtime() -> Result<RuntimeGuard, String> {
        unsafe { RoInitialize(RO_INIT_MULTITHREADED) }
            .map_err(|error| format!("Windows OCR runtime failed: {error}"))?;
        Ok(RuntimeGuard)
    }

    pub const TILING: Option<Tiling> = None;

    pub fn max_side() -> Result<u32, String> {
        let _runtime = runtime()?;
        OcrEngine::MaxImageDimension().map_err(|error| format!("Windows OCR failed: {error}"))
    }

    /// The Tauri app's `recognize_screenshot_ocr_image_windows`, keeping the
    /// word boxes it used to union away.
    pub fn recognize(image: OcrImage) -> Result<Vec<RecognizedLine>, String> {
        let _runtime = runtime()?;
        let fail = |error: windows::core::Error| format!("Windows OCR failed: {error}");
        let engine = OcrEngine::TryCreateFromUserProfileLanguages()
            .map_err(|error| format!("Windows OCR is not available: {error}"))?;
        let width = i32::try_from(image.width).map_err(|_| "OCR image width is too large")?;
        let height = i32::try_from(image.height).map_err(|_| "OCR image height is too large")?;
        let writer = DataWriter::new().map_err(fail)?;
        writer.WriteBytes(&image.bgra).map_err(fail)?;
        let buffer = writer.DetachBuffer().map_err(fail)?;
        let bitmap = SoftwareBitmap::CreateCopyWithAlphaFromBuffer(
            &buffer,
            BitmapPixelFormat::Bgra8,
            width,
            height,
            BitmapAlphaMode::Premultiplied,
        )
        .map_err(fail)?;
        let result = engine
            .RecognizeAsync(&bitmap)
            .map_err(fail)?
            .get()
            .map_err(fail)?;
        let ocr_lines = result.Lines().map_err(fail)?;
        let mut lines = Vec::new();
        for index in 0..ocr_lines.Size().map_err(fail)? {
            let line = ocr_lines.GetAt(index).map_err(fail)?;
            let text = line.Text().map_err(fail)?.to_string_lossy();
            if text.trim().is_empty() {
                continue;
            }
            let ocr_words = line.Words().map_err(fail)?;
            let mut words = Vec::new();
            let mut union: Option<(f64, f64, f64, f64)> = None;
            let mut cursor = 0usize;
            for word_index in 0..ocr_words.Size().map_err(fail)? {
                let word = ocr_words.GetAt(word_index).map_err(fail)?;
                let rect = word.BoundingRect().map_err(fail)?;
                let (left, top) = (f64::from(rect.X), f64::from(rect.Y));
                let (right, bottom) = (left + f64::from(rect.Width), top + f64::from(rect.Height));
                if ![left, top, right, bottom]
                    .iter()
                    .all(|value| value.is_finite())
                {
                    continue;
                }
                union = Some(match union {
                    Some((l, t, r, b)) => (l.min(left), t.min(top), r.max(right), b.max(bottom)),
                    None => (left, top, right, bottom),
                });
                let word_text = word.Text().map_err(fail)?.to_string_lossy();
                if word_text.is_empty() {
                    continue;
                }
                if let Some(found) = text[cursor..].find(&word_text) {
                    let start = cursor + found;
                    let end = start + word_text.len();
                    cursor = end;
                    words.push(RecognizedWord {
                        range: start..end,
                        bounds: Rect {
                            x: left,
                            y: top,
                            width: right - left,
                            height: bottom - top,
                        },
                    });
                }
            }
            let Some((left, top, right, bottom)) = union else {
                continue;
            };
            lines.push(RecognizedLine {
                text,
                bounds: Rect {
                    x: left,
                    y: top,
                    width: right - left,
                    height: bottom - top,
                },
                words,
            });
        }
        Ok(lines)
    }
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
mod platform {
    use super::{OcrImage, RecognizedLine, Tiling};

    pub const TILING: Option<Tiling> = None;

    pub fn max_side() -> Result<u32, String> {
        Err("OCR is only available on macOS and Windows".to_string())
    }

    pub fn recognize(_image: OcrImage) -> Result<Vec<RecognizedLine>, String> {
        Err("OCR is only available on macOS and Windows".to_string())
    }
}

// ---------------------------------------------------------------------------
// Editor state
// ---------------------------------------------------------------------------

#[derive(Default)]
pub(crate) enum OcrStatus {
    #[default]
    NotStarted,
    Running {
        _task: gpui::Task<()>,
    },
    Ready(Arc<TextLayer>),
    Unavailable,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Granularity {
    Character,
    Word,
    Line,
}

#[derive(Debug, Clone, Copy)]
struct TextDrag {
    granularity: Granularity,
    origin: (TextPosition, TextPosition),
}

type VisibleKey = (u64, u64, u64, u64);

#[derive(Default)]
pub(crate) struct OcrState {
    pub(crate) status: OcrStatus,
    /// Anchor and focus.
    selection: Option<(TextPosition, TextPosition)>,
    drag: Option<TextDrag>,
    visible: std::cell::RefCell<Option<(VisibleKey, Arc<Vec<VisibleLine>>)>>,
    layer_bounds: std::rc::Rc<std::cell::Cell<Option<Bounds<Pixels>>>>,
    cancel: Arc<AtomicBool>,
}

impl Drop for OcrState {
    fn drop(&mut self) {
        self.cancel.store(true, Ordering::Relaxed);
    }
}

impl OcrState {
    pub(crate) fn dragging(&self) -> bool {
        self.drag.is_some()
    }
}

fn rect_key(rect: Rect) -> VisibleKey {
    (
        rect.x.to_bits(),
        rect.y.to_bits(),
        rect.width.to_bits(),
        rect.height.to_bits(),
    )
}

struct FrameStats {
    phase: &'static str,
    started: Instant,
    last: Instant,
    seconds: f64,
    intervals: Vec<f64>,
}

fn frame_stats_seconds() -> Option<f64> {
    std::env::var("CAP_GPUI_AUTO_SCREENSHOT_TEXT_STATS")
        .ok()
        .and_then(|value| value.parse::<f64>().ok())
        .filter(|seconds| seconds.is_finite() && *seconds > 0.)
}

fn text_system_advance(text_system: &gpui::TextSystem) -> impl FnMut(char) -> f64 + '_ {
    let font_id = text_system.resolve_font(&gpui::font(crate::theme::UI_FONT));
    let mut cache = std::collections::HashMap::<char, f64>::new();
    move |ch| {
        *cache.entry(ch).or_insert_with(|| {
            text_system
                .advance(font_id, px(ADVANCE_FONT_SIZE), ch)
                .map(|size| f64::from(f32::from(size.width)))
                .unwrap_or_else(|_| {
                    let wide = ch as u32 >= 0x1100;
                    f64::from(ADVANCE_FONT_SIZE) * if wide { 1. } else { 0.55 }
                })
        })
    }
}

impl ScreenshotEditorWindow {
    fn text_layer(&self) -> Option<&Arc<TextLayer>> {
        match &self.ocr.status {
            OcrStatus::Ready(layer) if !layer.lines.is_empty() => Some(layer),
            _ => None,
        }
    }

    fn source_to_frame(&self) -> Option<SourceToFrame> {
        let image_size = self.image_size?;
        Some(SourceToFrame {
            source: source_rect(image_size, self.project.background.crop.as_ref()),
            image: self.annotation_image_rect(),
        })
    }

    fn visible_lines(&self, layer: &TextLayer) -> Option<Arc<Vec<VisibleLine>>> {
        let source = self.source_to_frame()?.source;
        let key = rect_key(source);
        let mut cache = self.ocr.visible.borrow_mut();
        if let Some((cached, visible)) = cache.as_ref()
            && *cached == key
        {
            return Some(visible.clone());
        }
        let visible = Arc::new(layer.visible_lines(source));
        *cache = Some((key, visible.clone()));
        Some(visible)
    }

    /// Kicks recognition off once, after the first frame is on screen, on its
    /// own thread: Windows needs a clean multithreaded apartment, and a
    /// multi-second Vision pass should not hold a pool thread. A window that
    /// closes first drops the task, and the thread's late result goes nowhere.
    pub(crate) fn start_text_recognition(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if !SUPPORTED || !matches!(self.ocr.status, OcrStatus::NotStarted) {
            return;
        }
        let Some(path) = crate::screenshot_editor::bundle_image_path(&self.bundle) else {
            self.ocr.status = OcrStatus::Unavailable;
            return;
        };
        let text_system = cx.text_system().clone();
        let cancel = self.ocr.cancel.clone();
        let (tx, rx) = flume::bounded(1);
        let spawned = std::thread::Builder::new()
            .name("screenshot-ocr".to_string())
            .spawn(move || {
                let _ = tx.send(recognize_layer(&path, &text_system, &cancel));
            });
        if let Err(error) = spawned {
            tracing::warn!(%error, "screenshot text recognition could not start");
            self.ocr.status = OcrStatus::Unavailable;
            return;
        }
        self.start_text_frame_stats("recognizing", window, cx);
        let task = cx.spawn_in(window, async move |this, cx| {
            let status = match rx.recv_async().await {
                Ok(Ok(layer)) => OcrStatus::Ready(Arc::new(layer)),
                Ok(Err(error)) => {
                    tracing::warn!(%error, "screenshot text recognition failed");
                    OcrStatus::Unavailable
                }
                Err(_) => OcrStatus::Unavailable,
            };
            this.update_in(cx, |this, window, cx| {
                this.ocr.status = status;
                this.ocr.visible.borrow_mut().take();
                if frame_stats_seconds().is_some() && this.select_all_text(cx) {
                    let chars = this.selected_text().map_or(0, |text| text.chars().count());
                    let copied = this.copy_selected_text(window, cx);
                    tracing::info!(chars, copied, "auto text selection");
                    this.start_text_frame_stats("selected", window, cx);
                }
                cx.notify();
            })
            .ok();
        });
        self.ocr.status = OcrStatus::Running { _task: task };
    }

    /// Harness only (`CAP_GPUI_AUTO_SCREENSHOT_TEXT_STATS=<seconds>`): log
    /// frame intervals while recognition runs, then select and copy all the
    /// text and log them again with the whole highlight on screen.
    fn start_text_frame_stats(
        &mut self,
        phase: &'static str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(seconds) = frame_stats_seconds() else {
            return;
        };
        let started = Instant::now();
        self.text_frame_stats_tick(
            FrameStats {
                phase,
                started,
                last: started,
                seconds,
                intervals: Vec::new(),
            },
            window,
            cx,
        );
    }

    fn text_frame_stats_tick(
        &mut self,
        mut stats: FrameStats,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let now = Instant::now();
        if stats.last != stats.started {
            stats
                .intervals
                .push(now.duration_since(stats.last).as_secs_f64() * 1000.);
        }
        stats.last = now;
        if now.duration_since(stats.started).as_secs_f64() >= stats.seconds {
            let intervals = &mut stats.intervals;
            intervals.sort_by(f64::total_cmp);
            let at = |share: f64| {
                intervals
                    .get(((intervals.len() as f64 - 1.) * share).round() as usize)
                    .copied()
                    .unwrap_or(0.)
            };
            tracing::info!(
                phase = stats.phase,
                frames = intervals.len(),
                p50_ms = format!("{:.2}", at(0.5)),
                p99_ms = format!("{:.2}", at(0.99)),
                max_ms = format!("{:.2}", at(1.)),
                lines = self.text_layer().map_or(0, |layer| layer.lines.len()),
                "screenshot frame stats"
            );
            return;
        }
        cx.on_next_frame(window, move |this, window, cx| {
            this.text_frame_stats_tick(stats, window, cx);
        });
        cx.notify();
    }

    fn source_point(&self, position: Point<Pixels>) -> Option<(f64, f64)> {
        let bounds = self.ocr.layer_bounds.get()?;
        let width = f64::from(f32::from(bounds.size.width));
        if width <= 0. || self.frame_size.0 <= 0. {
            return None;
        }
        let scale = width / f64::from(self.frame_size.0);
        let frame = (
            f64::from(f32::from(position.x - bounds.origin.x)) / scale,
            f64::from(f32::from(position.y - bounds.origin.y)) / scale,
        );
        self.source_to_frame()?.point_to_source(frame)
    }

    /// Source pixels covered by `HIT_SLOP` screen pixels at the current zoom.
    fn source_slop(&self) -> f64 {
        let Some(bounds) = self.ocr.layer_bounds.get() else {
            return 0.;
        };
        let width = f64::from(f32::from(bounds.size.width));
        let Some(map) = self.source_to_frame() else {
            return 0.;
        };
        if width <= 0. {
            return 0.;
        }
        HIT_SLOP * f64::from(self.frame_size.0) / width * map.source_per_frame()
    }

    pub(crate) fn has_text_selection(&self) -> bool {
        self.ocr.selection.is_some_and(|(a, b)| a != b)
    }

    pub(crate) fn clear_text_selection(&mut self, cx: &mut Context<Self>) {
        self.ocr.drag = None;
        if self.ocr.selection.take().is_some() {
            cx.notify();
        }
    }

    /// A left press the annotation layer did not take. `true` when it landed
    /// on recognised text and started a selection; any other press clears
    /// the selection the way a click on the page does.
    pub(crate) fn text_mouse_down(
        &mut self,
        event: &MouseDownEvent,
        cx: &mut Context<Self>,
    ) -> bool {
        if self.tool != Tool::Select {
            return false;
        }
        let Some(layer) = self.text_layer().cloned() else {
            return false;
        };
        let hit = self.source_point(event.position).and_then(|point| {
            let visible = self.visible_lines(&layer)?;
            let entry = layer.line_at(&visible, point, self.source_slop())?;
            Some((visible[entry].clone(), point))
        });
        let Some((entry, point)) = hit else {
            self.clear_text_selection(cx);
            return false;
        };
        let caret = layer.caret_in(&entry, point.0);
        let (granularity, origin) = match event.click_count {
            1 if event.modifiers.shift => {
                let anchor = self.ocr.selection.map_or(caret, |(anchor, _)| anchor);
                (Granularity::Character, (anchor, anchor))
            }
            1 => (Granularity::Character, (caret, caret)),
            2 => (Granularity::Word, layer.word_at(&entry, caret)),
            _ => (
                Granularity::Line,
                (
                    TextPosition {
                        line: entry.line,
                        index: entry.stops.start,
                    },
                    TextPosition {
                        line: entry.line,
                        index: entry.stops.end,
                    },
                ),
            ),
        };
        self.selected_annotation = None;
        self.ocr.selection = Some(if event.modifiers.shift && event.click_count == 1 {
            (origin.0, caret)
        } else {
            origin
        });
        self.ocr.drag = Some(TextDrag {
            granularity,
            origin,
        });
        cx.notify();
        true
    }

    fn text_drag_to(&mut self, position: Point<Pixels>, cx: &mut Context<Self>) {
        let Some(drag) = self.ocr.drag else {
            return;
        };
        let Some(layer) = self.text_layer().cloned() else {
            return;
        };
        let Some(visible) = self.visible_lines(&layer) else {
            return;
        };
        let Some(caret) = self
            .source_point(position)
            .and_then(|point| layer.position_near(&visible, point))
        else {
            return;
        };
        let (start, end) = drag.origin;
        let snap = |caret: TextPosition| -> (TextPosition, TextPosition) {
            let Some(entry) = visible.iter().find(|entry| entry.line == caret.line) else {
                return (caret, caret);
            };
            match drag.granularity {
                Granularity::Character => (caret, caret),
                Granularity::Word => layer.word_at(entry, caret),
                Granularity::Line => (
                    TextPosition {
                        line: entry.line,
                        index: entry.stops.start,
                    },
                    TextPosition {
                        line: entry.line,
                        index: entry.stops.end,
                    },
                ),
            }
        };
        let (snap_start, snap_end) = snap(caret);
        let selection = if caret < start {
            (end, snap_start)
        } else {
            (start, snap_end.max(end))
        };
        if self.ocr.selection != Some(selection) {
            self.ocr.selection = Some(selection);
            cx.notify();
        }
    }

    fn text_drag_end(&mut self, cx: &mut Context<Self>) {
        if self.ocr.drag.take().is_some() {
            cx.notify();
        }
    }

    pub(crate) fn selected_text(&self) -> Option<String> {
        let (a, b) = self.ocr.selection?;
        let layer = self.text_layer()?;
        let visible = self.visible_lines(layer)?;
        let text = layer.selected_text(&visible, a, b);
        (!text.is_empty()).then_some(text)
    }

    /// Cmd/Ctrl-C with text selected: the text, not the picture.
    pub(crate) fn copy_selected_text(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> bool {
        let Some(text) = self.selected_text() else {
            return false;
        };
        cx.write_to_clipboard(ClipboardItem::new_string(text));
        self.toast_success(tr::screenshot_editor::toast::text_copied(), window, cx);
        true
    }

    pub(crate) fn select_all_text(&mut self, cx: &mut Context<Self>) -> bool {
        if self.tool != Tool::Select {
            return false;
        }
        let Some(layer) = self.text_layer().cloned() else {
            return false;
        };
        let Some(visible) = self.visible_lines(&layer) else {
            return false;
        };
        let (Some(first), Some(last)) = (visible.first(), visible.last()) else {
            return false;
        };
        self.selected_annotation = None;
        self.ocr.selection = Some((
            TextPosition {
                line: first.line,
                index: first.stops.start,
            },
            TextPosition {
                line: last.line,
                index: last.stops.end,
            },
        ));
        cx.notify();
        true
    }

    /// A right press on recognised text: keep a selection it lands inside,
    /// otherwise select the word under it, then offer Copy -- what a
    /// right-click on text does across macOS.
    pub(crate) fn text_context_menu(
        &mut self,
        event: &MouseDownEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> bool {
        if self.tool != Tool::Select || self.crop.is_some() {
            return false;
        }
        let Some(layer) = self.text_layer().cloned() else {
            return false;
        };
        let Some(point) = self.source_point(event.position) else {
            return false;
        };
        let Some(visible) = self.visible_lines(&layer) else {
            return false;
        };
        let Some(entry) = layer.line_at(&visible, point, self.source_slop()) else {
            return false;
        };
        let entry = &visible[entry];
        let caret = layer.caret_in(entry, point.0);
        let inside = self.ocr.selection.is_some_and(|(a, b)| {
            let (low, high) = if a <= b { (a, b) } else { (b, a) };
            low != high && caret >= low && caret <= high
        });
        if !inside {
            self.ocr.selection = Some(layer.word_at(entry, caret));
        }
        self.selected_annotation = None;
        self.open_text_menu(event.position, window, cx);
        true
    }

    /// The highlight and the I-beam, between the frame and the annotations
    /// -- `z-index: 15` under the annotation layer's 20 over there.
    pub(crate) fn render_text_layer(&self) -> Option<gpui::AnyElement> {
        let layer = self.text_layer()?.clone();
        let map = self.source_to_frame()?;
        let visible = self.visible_lines(&layer)?;
        let frame_width = f64::from(self.frame_size.0);
        let selection: Vec<Rect> = self
            .ocr
            .selection
            .map(|(a, b)| layer.selection_rects(&visible, a, b))
            .unwrap_or_default()
            .into_iter()
            .filter_map(|rect| map.rect_to_frame(rect))
            .collect();
        let hoverable =
            self.tool == Tool::Select && !self.annotation_hovered() && self.crop.is_none();
        let lines: Vec<Rect> = if hoverable {
            visible
                .iter()
                .filter_map(|entry| map.rect_to_frame(layer.visible_rect(entry)))
                .collect()
        } else {
            Vec::new()
        };
        let cell = self.ocr.layer_bounds.clone();
        let tint = ui::text_input::selection_tint();

        Some(
            canvas(
                move |bounds, _window, _cx| cell.set(Some(bounds)),
                move |bounds, _, window, _cx| {
                    let width = f64::from(f32::from(bounds.size.width));
                    if frame_width <= 0. || width <= 0. {
                        return;
                    }
                    let scale = width / frame_width;
                    let to_screen = |rect: &Rect| {
                        Bounds::new(
                            gpui::point(
                                bounds.origin.x + px((rect.x * scale) as f32),
                                bounds.origin.y + px((rect.y * scale) as f32),
                            ),
                            gpui::size(
                                px((rect.width * scale) as f32),
                                px((rect.height * scale) as f32),
                            ),
                        )
                    };
                    let clip = window.content_mask().bounds;
                    for rect in &selection {
                        let screen = to_screen(rect);
                        if screen.intersects(&clip) {
                            window.paint_quad(gpui::fill(screen, tint));
                        }
                    }
                    for rect in &lines {
                        let screen = to_screen(rect);
                        if !screen.intersects(&clip) {
                            continue;
                        }
                        let hitbox = window.insert_hitbox(screen, HitboxBehavior::Normal);
                        window.set_cursor_style(CursorStyle::IBeam, &hitbox);
                    }
                },
            )
            .absolute()
            .top_0()
            .left_0()
            .size_full()
            .into_any_element(),
        )
    }

    /// The drag layer a text selection keeps until the button comes up, so a
    /// drag that leaves the preview still extends it.
    pub(crate) fn render_text_drag_layer(
        &self,
        cx: &mut Context<Self>,
    ) -> Option<gpui::AnyElement> {
        self.ocr.dragging().then(|| {
            ui::Slider::drag_layer(
                "screenshot-text-drag",
                cx.listener(|this, event: &MouseMoveEvent, _window, cx| {
                    this.text_drag_to(event.position, cx);
                }),
                cx.listener(|this, _: &MouseUpEvent, _window, cx| {
                    this.text_drag_end(cx);
                }),
            )
            .into_any_element()
        })
    }
}

fn recognize_layer(
    path: &Path,
    text_system: &gpui::TextSystem,
    cancel: &AtomicBool,
) -> Result<TextLayer, String> {
    let started = Instant::now();
    let lines = recognize_file(path, cancel)?;
    let recognized = started.elapsed();
    let words: usize = lines.iter().map(|line| line.words.len()).sum();
    let line_count = lines.len();
    let layer = TextLayer::build(lines, &mut text_system_advance(text_system));
    tracing::info!(
        lines = line_count,
        words,
        recognize_ms = recognized.as_millis() as u64,
        total_ms = started.elapsed().as_millis() as u64,
        "screenshot text recognized"
    );
    Ok(layer)
}

#[cfg(all(test, target_os = "linux"))]
mod editor_tests {
    use gpui::{
        AppContext as _, Entity, InteractiveElement as _, IntoElement, Modifiers, MouseButton,
        ParentElement as _, Render, Styled as _, div, point, px,
    };

    use super::*;

    struct View {
        editor: Entity<ScreenshotEditorWindow>,
        _project: tempfile::TempDir,
    }

    impl Render for View {
        fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
            self.editor.update(cx, |editor, cx| {
                div()
                    .size_full()
                    .track_focus(&editor.focus)
                    .on_key_down(cx.listener(ScreenshotEditorWindow::on_key))
            })
        }
    }

    fn line(text: &str, x: f64, y: f64) -> RecognizedLine {
        RecognizedLine {
            text: text.to_string(),
            bounds: Rect {
                x,
                y,
                width: text.chars().count() as f64 * 10.,
                height: 20.,
            },
            words: Vec::new(),
        }
    }

    /// A 400x200 screenshot shown at 1:1 with no padding, so screen, frame
    /// and source pixels coincide, and three recognised lines on it.
    fn fixture(
        cx: &mut gpui::TestAppContext,
    ) -> (Entity<ScreenshotEditorWindow>, &mut gpui::VisualTestContext) {
        let project = tempfile::tempdir().unwrap();
        let (view, cx) = cx.add_window_view(move |window, cx| {
            let editor =
                cx.new(|cx| ScreenshotEditorWindow::new(project.path().into(), window, cx));
            editor.update(cx, |editor, cx| {
                editor.project.background.padding = 0.;
                editor.frame_size = (400., 200.);
                editor.image_size = Some((400, 200));
                editor.ocr.status = OcrStatus::Ready(Arc::new(TextLayer::build(
                    vec![
                        line("Hello Cap world", 10., 10.),
                        line("second line", 10., 50.),
                        line("right side", 250., 100.),
                    ],
                    &mut |_| 1.,
                )));
                editor.ocr.layer_bounds.set(Some(Bounds {
                    origin: point(px(0.), px(0.)),
                    size: gpui::size(px(400.), px(200.)),
                }));
                window.focus(&editor.focus, cx);
            });
            View {
                editor,
                _project: project,
            }
        });
        (view.read_with(cx, |view, _| view.editor.clone()), cx)
    }

    fn press(
        editor: &Entity<ScreenshotEditorWindow>,
        cx: &mut gpui::VisualTestContext,
        button: MouseButton,
        at: (f32, f32),
        click_count: usize,
    ) {
        let event = MouseDownEvent {
            button,
            position: point(px(at.0), px(at.1)),
            modifiers: Modifiers::default(),
            click_count,
            first_mouse: false,
        };
        editor.update_in(cx, |editor, window, cx| {
            if button == MouseButton::Right {
                editor.text_context_menu(&event, window, cx);
            } else {
                editor.preview_mouse_down(&event, window, cx);
            }
        });
    }

    fn drag_to(
        editor: &Entity<ScreenshotEditorWindow>,
        cx: &mut gpui::VisualTestContext,
        at: (f32, f32),
    ) {
        editor.update(cx, |editor, cx| {
            editor.text_drag_to(point(px(at.0), px(at.1)), cx);
            editor.text_drag_end(cx);
        });
    }

    fn clipboard(cx: &mut gpui::VisualTestContext) -> Option<String> {
        cx.read_from_clipboard().and_then(|item| item.text())
    }

    #[gpui::test]
    fn a_drag_across_lines_copies_the_text_with_the_shortcut(cx: &mut gpui::TestAppContext) {
        let (editor, cx) = fixture(cx);
        press(&editor, cx, MouseButton::Left, (70., 20.), 1);
        drag_to(&editor, cx, (68., 60.));
        assert!(editor.read_with(cx, |editor, _| editor.has_text_selection()));
        cx.simulate_keystrokes("ctrl-c");
        assert_eq!(clipboard(cx).as_deref(), Some("Cap world\nsecond"));
    }

    #[gpui::test]
    fn select_all_copies_every_line_and_escape_clears_it(cx: &mut gpui::TestAppContext) {
        let (editor, cx) = fixture(cx);
        cx.simulate_keystrokes("ctrl-a");
        cx.simulate_keystrokes("ctrl-c");
        assert_eq!(
            clipboard(cx).as_deref(),
            Some("Hello Cap world\nsecond line\nright side")
        );
        cx.simulate_keystrokes("escape");
        assert!(!editor.read_with(cx, |editor, _| editor.has_text_selection()));
    }

    #[gpui::test]
    fn double_and_triple_clicks_take_a_word_and_a_line(cx: &mut gpui::TestAppContext) {
        let (editor, cx) = fixture(cx);
        press(&editor, cx, MouseButton::Left, (75., 20.), 2);
        assert_eq!(
            editor.read_with(cx, |editor, _| editor.selected_text()),
            Some("Cap".to_string())
        );
        editor.update(cx, |editor, cx| editor.text_drag_end(cx));
        press(&editor, cx, MouseButton::Left, (40., 60.), 3);
        assert_eq!(
            editor.read_with(cx, |editor, _| editor.selected_text()),
            Some("second line".to_string())
        );
    }

    #[gpui::test]
    fn a_press_off_the_text_clears_the_selection_and_pans(cx: &mut gpui::TestAppContext) {
        let (editor, cx) = fixture(cx);
        cx.simulate_keystrokes("ctrl-a");
        press(&editor, cx, MouseButton::Left, (200., 180.), 1);
        assert!(!editor.read_with(cx, |editor, _| editor.has_text_selection()));
    }

    #[gpui::test]
    fn drawing_tools_never_start_a_text_selection(cx: &mut gpui::TestAppContext) {
        let (editor, cx) = fixture(cx);
        editor.update(cx, |editor, _| editor.tool = Tool::Rectangle);
        editor.update(cx, |editor, cx| {
            let event = MouseDownEvent {
                button: MouseButton::Left,
                position: point(px(70.), px(20.)),
                modifiers: Modifiers::default(),
                click_count: 1,
                first_mouse: false,
            };
            assert!(!editor.text_mouse_down(&event, cx));
        });
        assert!(!editor.read_with(cx, |editor, _| editor.has_text_selection()));
        cx.simulate_keystrokes("ctrl-a");
        assert!(!editor.read_with(cx, |editor, _| editor.has_text_selection()));
    }

    #[gpui::test]
    fn right_click_selects_the_word_and_its_menu_copies_it(cx: &mut gpui::TestAppContext) {
        let (editor, cx) = fixture(cx);
        press(&editor, cx, MouseButton::Right, (290., 110.), 1);
        assert_eq!(
            editor.read_with(cx, |editor, _| editor.selected_text()),
            Some("right".to_string())
        );
        cx.simulate_keystrokes("down enter");
        assert_eq!(clipboard(cx).as_deref(), Some("right"));
    }

    #[gpui::test]
    fn crop_limits_what_select_all_takes(cx: &mut gpui::TestAppContext) {
        let (editor, cx) = fixture(cx);
        editor.update(cx, |editor, _| {
            editor.project.background.crop = Some(cap_project::Crop {
                position: cap_project::XY { x: 200, y: 80 },
                size: cap_project::XY { x: 200, y: 120 },
            });
            editor.frame_size = (200., 120.);
            editor.ocr.layer_bounds.set(Some(Bounds {
                origin: point(px(0.), px(0.)),
                size: gpui::size(px(200.), px(120.)),
            }));
        });
        cx.simulate_keystrokes("ctrl-a");
        cx.simulate_keystrokes("ctrl-c");
        assert_eq!(clipboard(cx).as_deref(), Some("right side"));
        press(&editor, cx, MouseButton::Left, (125., 30.), 2);
        assert_eq!(
            editor.read_with(cx, |editor, _| editor.selected_text()),
            Some("side".to_string())
        );
    }

    #[gpui::test]
    fn a_text_press_drops_the_annotation_selection(cx: &mut gpui::TestAppContext) {
        let (editor, cx) = fixture(cx);
        editor.update(cx, |editor, _| {
            editor.selected_annotation = Some("gone".to_string());
        });
        press(&editor, cx, MouseButton::Left, (70., 20.), 1);
        assert!(editor.read_with(cx, |editor, _| editor.selected_annotation.is_none()));
    }
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use super::*;

    impl TextLayer {
        fn position_on(
            &self,
            visible: &[VisibleLine],
            point: (f64, f64),
            slop: f64,
        ) -> Option<TextPosition> {
            let entry = &visible[self.line_at(visible, point, slop)?];
            Some(self.caret_in(entry, point.0))
        }
    }

    fn rect(x: f64, y: f64, width: f64, height: f64) -> Rect {
        Rect {
            x,
            y,
            width,
            height,
        }
    }

    fn unit(_: char) -> f64 {
        1.
    }

    fn line(text: &str, bounds: Rect) -> RecognizedLine {
        RecognizedLine {
            text: text.to_string(),
            bounds,
            words: Vec::new(),
        }
    }

    fn layer(lines: Vec<RecognizedLine>) -> TextLayer {
        TextLayer::build(lines, &mut unit)
    }

    fn at(line: usize, index: usize) -> TextPosition {
        TextPosition { line, index }
    }

    fn whole(layer: &TextLayer) -> Vec<VisibleLine> {
        layer.visible_lines(rect(0., 0., 1e9, 1e9))
    }

    #[test]
    fn stops_spread_a_wordless_line_evenly_by_advance() {
        let stops = layout_stops("abcd", rect(10., 0., 40., 10.), &[], &mut unit);
        let xs: Vec<f64> = stops.iter().map(|stop| stop.x).collect();
        assert_eq!(xs, vec![10., 20., 30., 40., 50.]);
        assert_eq!(stops.last().unwrap().byte, 4);
    }

    #[test]
    fn stops_follow_advances_inside_a_span() {
        let mut advance = |ch: char| if ch == 'W' { 3. } else { 1. };
        let stops = layout_stops("Wi", rect(0., 0., 40., 10.), &[], &mut advance);
        let xs: Vec<f64> = stops.iter().map(|stop| stop.x).collect();
        assert_eq!(xs, vec![0., 30., 40.]);
    }

    #[test]
    fn word_boxes_pin_words_and_gaps_fill_between() {
        let words = vec![
            RecognizedWord {
                range: 0..2,
                bounds: rect(0., 0., 20., 10.),
            },
            RecognizedWord {
                range: 3..5,
                bounds: rect(60., 0., 20., 10.),
            },
        ];
        let stops = layout_stops("ab cd", rect(0., 0., 80., 10.), &words, &mut unit);
        let xs: Vec<f64> = stops.iter().map(|stop| stop.x).collect();
        assert_eq!(xs, vec![0., 10., 20., 60., 70., 80.]);
    }

    #[test]
    fn stops_index_multibyte_text_on_char_boundaries() {
        let stops = layout_stops("é漢x", rect(0., 0., 30., 10.), &[], &mut unit);
        let bytes: Vec<usize> = stops.iter().map(|stop| stop.byte).collect();
        assert_eq!(bytes, vec![0, 2, 5, 6]);
    }

    #[test]
    fn bad_word_ranges_are_ignored_and_stops_stay_monotonic() {
        let words = vec![
            RecognizedWord {
                range: 1..2,
                bounds: rect(50., 0., 10., 10.),
            },
            RecognizedWord {
                range: 0..1,
                bounds: rect(0., 0., 10., 10.),
            },
            RecognizedWord {
                range: 3..99,
                bounds: rect(0., 0., 10., 10.),
            },
        ];
        let stops = layout_stops("abc", rect(0., 0., 30., 10.), &words, &mut unit);
        assert_eq!(stops.len(), 4);
        assert!(stops.windows(2).all(|pair| pair[0].x <= pair[1].x));
        assert_eq!(stops.last().unwrap().x, 30.);
    }

    #[test]
    fn empty_and_degenerate_lines_are_dropped() {
        let layer = layer(vec![
            line("   ", rect(0., 0., 10., 10.)),
            line("zero", rect(0., 0., 0., 10.)),
            line("ok", rect(0., 0., 10., 10.)),
        ]);
        assert_eq!(layer.lines.len(), 1);
        assert_eq!(layer.lines[0].text, "ok");
    }

    #[test]
    fn no_text_means_nothing_is_visible_or_selectable() {
        let layer = layer(Vec::new());
        let visible = whole(&layer);
        assert!(visible.is_empty());
        assert_eq!(layer.position_near(&visible, (5., 5.)), None);
        assert_eq!(layer.selected_text(&visible, at(0, 0), at(0, 3)), "");
    }

    #[test]
    fn selection_text_joins_lines_in_reading_order_whichever_way_it_was_dragged() {
        let layer = layer(vec![
            line("Hello world", rect(0., 0., 110., 10.)),
            line("second", rect(0., 20., 60., 10.)),
            line("third line", rect(0., 40., 100., 10.)),
        ]);
        let visible = whole(&layer);
        let forward = layer.selected_text(&visible, at(0, 6), at(2, 5));
        let backward = layer.selected_text(&visible, at(2, 5), at(0, 6));
        assert_eq!(forward, "world\nsecond\nthird");
        assert_eq!(backward, forward);
    }

    #[test]
    fn a_collapsed_selection_has_no_text_and_no_highlight() {
        let layer = layer(vec![line("abc", rect(0., 0., 30., 10.))]);
        let visible = whole(&layer);
        assert_eq!(layer.selected_text(&visible, at(0, 1), at(0, 1)), "");
        assert!(
            layer
                .selection_rects(&visible, at(0, 1), at(0, 1))
                .is_empty()
        );
    }

    #[test]
    fn highlight_rects_cover_exactly_the_selected_glyphs() {
        let layer = layer(vec![
            line("abcd", rect(0., 0., 40., 10.)),
            line("efgh", rect(5., 20., 40., 12.)),
        ]);
        let visible = whole(&layer);
        let rects = layer.selection_rects(&visible, at(0, 2), at(1, 1));
        assert_eq!(
            rects,
            vec![rect(20., 0., 20., 10.), rect(5., 20., 10., 12.)]
        );
    }

    #[test]
    fn a_press_hits_a_line_only_inside_its_box_plus_slop() {
        let layer = layer(vec![line("abcd", rect(10., 10., 40., 10.))]);
        let visible = whole(&layer);
        assert_eq!(layer.line_at(&visible, (30., 15.), 0.), Some(0));
        assert_eq!(layer.line_at(&visible, (30., 22.), 0.), None);
        assert_eq!(layer.line_at(&visible, (30., 22.), 3.), Some(0));
        assert_eq!(layer.line_at(&visible, (5., 15.), 3.), None);
    }

    #[test]
    fn the_caret_snaps_to_the_nearest_boundary() {
        let layer = layer(vec![line("abcd", rect(0., 0., 40., 10.))]);
        let visible = whole(&layer);
        assert_eq!(layer.position_on(&visible, (14., 5.), 0.), Some(at(0, 1)));
        assert_eq!(layer.position_on(&visible, (16., 5.), 0.), Some(at(0, 2)));
    }

    #[test]
    fn a_drag_past_the_text_reaches_the_nearest_line_end() {
        let layer = layer(vec![
            line("abcd", rect(0., 0., 40., 10.)),
            line("efgh", rect(0., 20., 40., 10.)),
        ]);
        let visible = whole(&layer);
        assert_eq!(layer.position_near(&visible, (500., 300.)), Some(at(1, 4)));
        assert_eq!(layer.position_near(&visible, (-50., -50.)), Some(at(0, 0)));
        assert_eq!(layer.position_near(&visible, (20., 14.)), Some(at(0, 2)));
    }

    #[test]
    fn crop_keeps_lines_centred_inside_and_trims_their_characters() {
        let layer = layer(vec![
            line("abcdef", rect(0., 0., 60., 10.)),
            line("ghijkl", rect(0., 20., 60., 10.)),
            line("mnopqr", rect(0., 40., 60., 10.)),
        ]);
        let crop = rect(20., 18., 24., 20.);
        let visible = layer.visible_lines(crop);
        assert_eq!(
            visible,
            vec![VisibleLine {
                line: 1,
                stops: 2..4,
            }]
        );
        let text = layer.selected_text(&visible, at(0, 0), at(2, 6));
        assert_eq!(text, "ij");
        let rects = layer.selection_rects(&visible, at(0, 0), at(2, 6));
        assert_eq!(rects, vec![rect(20., 20., 20., 10.)]);
        assert_eq!(layer.position_near(&visible, (0., 25.)), Some(at(1, 2)));
    }

    #[test]
    fn a_crop_with_no_text_inside_shows_nothing() {
        let layer = layer(vec![line("abc", rect(0., 0., 30., 10.))]);
        assert!(layer.visible_lines(rect(100., 100., 50., 50.)).is_empty());
    }

    #[test]
    fn double_click_word_ranges_split_words_spaces_and_punctuation() {
        let layer = layer(vec![line("foo, bar_baz  qux", rect(0., 0., 170., 10.))]);
        let visible = whole(&layer);
        let entry = &visible[0];
        assert_eq!(layer.word_at(entry, at(0, 1)), (at(0, 0), at(0, 3)));
        assert_eq!(layer.word_at(entry, at(0, 3)), (at(0, 3), at(0, 4)));
        assert_eq!(layer.word_at(entry, at(0, 7)), (at(0, 5), at(0, 12)));
        assert_eq!(layer.word_at(entry, at(0, 13)), (at(0, 12), at(0, 14)));
        assert_eq!(layer.word_at(entry, at(0, 17)), (at(0, 14), at(0, 17)));
    }

    #[test]
    fn source_maps_through_crop_onto_the_image_rect_and_back() {
        let map = SourceToFrame {
            source: rect(100., 50., 200., 100.),
            image: rect(40., 20., 400., 200.),
        };
        assert_eq!(
            map.rect_to_frame(rect(100., 50., 10., 10.)),
            Some(rect(40., 20., 20., 20.))
        );
        assert_eq!(map.point_to_source((440., 220.)), Some((300., 150.)));
        let degenerate = SourceToFrame {
            source: rect(0., 0., 0., 10.),
            image: rect(0., 0., 10., 10.),
        };
        assert_eq!(degenerate.rect_to_frame(rect(0., 0., 1., 1.)), None);
    }

    #[test]
    fn source_rect_is_the_crop_clamped_to_the_image() {
        let crop = cap_project::Crop {
            position: cap_project::XY { x: 1900, y: 10 },
            size: cap_project::XY { x: 400, y: 100 },
        };
        assert_eq!(
            source_rect((2000, 1000), Some(&crop)),
            rect(1900., 10., 100., 100.)
        );
        assert_eq!(source_rect((2000, 1000), None), rect(0., 0., 2000., 1000.));
    }

    #[test]
    fn recognition_size_fits_area_and_side_keeping_aspect() {
        assert_eq!(
            recognition_size(7680, 4320, 50_000_000, u32::MAX),
            (7680, 4320)
        );
        let (width, height) = recognition_size(16_384, 16_384, 50_000_000, u32::MAX);
        assert!(u64::from(width) * u64::from(height) <= 50_000_000);
        assert_eq!(width, height);
        assert_eq!(
            recognition_size(1600, 16_000, 50_000_000, 10_000),
            (1000, 10_000)
        );
        assert_eq!(recognition_size(1, 1, 50_000_000, 10_000), (1, 1));
    }

    #[test]
    fn word_ranges_split_on_any_whitespace() {
        assert_eq!(word_ranges("  a bc\td  "), vec![2..3, 4..6, 7..8]);
        assert_eq!(word_ranges("漢字 テスト"), vec![0..6, 7..16]);
        assert!(word_ranges("   ").is_empty());
    }

    #[test]
    fn many_words_build_and_select_quickly() {
        let lines: Vec<RecognizedLine> = (0..2_000)
            .map(|index| {
                let text = "lorem ipsum dolor sit amet consectetur".to_string();
                let words = word_ranges(&text)
                    .into_iter()
                    .map(|range| RecognizedWord {
                        bounds: rect(
                            range.start as f64 * 8.,
                            index as f64 * 20.,
                            (range.len()) as f64 * 8.,
                            14.,
                        ),
                        range,
                    })
                    .collect();
                RecognizedLine {
                    text,
                    bounds: rect(0., index as f64 * 20., 304., 14.),
                    words,
                }
            })
            .collect();
        let started = Instant::now();
        let layer = layer(lines);
        let visible = whole(&layer);
        let text = layer.selected_text(&visible, at(0, 0), at(1_999, 38));
        let rects = layer.selection_rects(&visible, at(0, 0), at(1_999, 38));
        let near = layer.position_near(&visible, (150., 1e6));
        let elapsed = started.elapsed();
        assert_eq!(text.lines().count(), 2_000);
        assert_eq!(rects.len(), 2_000);
        assert_eq!(near.map(|position| position.line), Some(1_999));
        assert!(elapsed.as_millis() < 500, "took {elapsed:?}");
    }

    fn worded(text: &str, x: f64, y: f64, char_width: f64, height: f64) -> RecognizedLine {
        let words: Vec<RecognizedWord> = word_ranges(text)
            .into_iter()
            .map(|range| RecognizedWord {
                bounds: rect(
                    x + range.start as f64 * char_width,
                    y,
                    range.len() as f64 * char_width,
                    height,
                ),
                range,
            })
            .collect();
        RecognizedLine {
            text: text.to_string(),
            bounds: rect(x, y, text.len() as f64 * char_width, height),
            words,
        }
    }

    #[test]
    fn tiles_cover_the_image_with_the_overlap_and_end_flush() {
        assert_eq!(tile_rects(1000, 800, 2048, 256), vec![(0, 0, 1000, 800)]);
        let tiles = tile_rects(7680, 4320, 2048, 256);
        let xs: Vec<u32> = tiles.iter().filter(|t| t.1 == 0).map(|t| t.0).collect();
        assert_eq!(xs, vec![0, 1792, 3584, 5376, 5632]);
        let ys: Vec<u32> = tiles.iter().filter(|t| t.0 == 0).map(|t| t.1).collect();
        assert_eq!(ys, vec![0, 1792, 2272]);
        assert!(tiles.iter().all(|t| t.2 == 2048 && t.3 == 2048));
        assert!(tiles.iter().all(|t| t.0 + t.2 <= 7680 && t.1 + t.3 <= 4320));
        let tall = tile_rects(1600, 12_000, 2048, 256);
        assert!(tall.iter().all(|t| t.0 == 0 && t.2 == 1600));
        assert_eq!(tall.last().unwrap().1 + 2048, 12_000);
    }

    #[test]
    fn tile_lines_move_to_image_space_and_lines_cut_by_an_inner_edge_go() {
        let lines = vec![
            worded("top cut", 10., 0., 10., 20.),
            worded("whole", 10., 100., 10., 20.),
            worded("bottom cut", 10., 2030., 10., 18.),
        ];
        let placed = place_tile_lines(lines, (500, 1000, 2048, 2048), (4000, 5000));
        assert_eq!(placed.len(), 1);
        assert_eq!(placed[0].bounds, rect(510., 1100., 50., 20.));
        assert_eq!(placed[0].words[0].bounds, rect(510., 1100., 50., 20.));

        let edge_of_image = place_tile_lines(
            vec![worded("first", 0., 0., 10., 20.)],
            (0, 0, 2048, 2048),
            (2048, 2048),
        );
        assert_eq!(edge_of_image.len(), 1);
    }

    #[test]
    fn a_line_two_tiles_both_cut_is_stitched_once() {
        let left = worded("alpha bravo char", 0., 50., 10., 20.);
        let mut right = worded("charlie delta echo", 100., 50., 10., 20.);
        right.words[0].bounds.x = 120.;
        right.words[0].bounds.width = 70.;
        let merged = merge_tile_lines(vec![left, right]);
        assert_eq!(merged.len(), 1);
        assert_eq!(merged[0].text, "alpha bravo charlie delta echo");
        let words: Vec<&str> = merged[0]
            .words
            .iter()
            .map(|word| &merged[0].text[word.range.clone()])
            .collect();
        assert_eq!(words, vec!["alpha", "bravo", "charlie", "delta", "echo"]);
    }

    #[test]
    fn a_line_both_tiles_read_whole_is_kept_once_and_clipped_glyphs_lose() {
        let whole = worded("same line", 0., 10., 10., 20.);
        let clipped = worded("sarne line", 0., 14., 10., 12.);
        let merged = merge_tile_lines(vec![clipped, whole]);
        assert_eq!(merged.len(), 1);
        assert_eq!(merged[0].text, "same line");
    }

    #[test]
    fn stitched_lines_read_row_by_row_then_left_to_right() {
        let merged = merge_tile_lines(vec![
            worded("right one", 3000., 10., 10., 20.),
            worded("second row", 0., 60., 10., 20.),
            worded("left one", 0., 12., 10., 20.),
        ]);
        let texts: Vec<&str> = merged.iter().map(|line| line.text.as_str()).collect();
        assert_eq!(texts, vec!["left one", "right one", "second row"]);
    }

    fn fixture(name: &str) -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("tests/data/ocr")
            .join(name)
    }

    /// The real engine on a committed fixture: every line found, in reading
    /// order, with each word box inside its line box, and Select All copying
    /// the three lines back out.
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    #[test]
    fn the_platform_engine_reads_the_fixture_in_order() {
        let lines = match recognize_file(&fixture("ocr-lines.png"), &AtomicBool::new(false)) {
            Ok(lines) => lines,
            Err(error) if cfg!(windows) && error.contains("not available") => {
                eprintln!("skipping: {error}");
                return;
            }
            Err(error) => panic!("recognition failed: {error}"),
        };
        let texts: Vec<&str> = lines.iter().map(|line| line.text.as_str()).collect();
        assert_eq!(
            texts,
            vec!["Hello Cap world", "second line here", "Copy this text 42"]
        );
        for line in &lines {
            assert!(!line.words.is_empty(), "{line:?}");
            for word in &line.words {
                assert!(word.bounds.x >= line.bounds.x - 2., "{word:?} in {line:?}");
                assert!(
                    word.bounds.x + word.bounds.width <= line.bounds.x + line.bounds.width + 2.,
                    "{word:?} in {line:?}"
                );
            }
        }
        let layer = layer(lines);
        let visible = whole(&layer);
        let last = &layer.lines[2];
        assert_eq!(
            layer.selected_text(&visible, at(0, 0), at(2, last.char_count())),
            "Hello Cap world\nsecond line here\nCopy this text 42"
        );
        let cap = layer.position_on(
            &visible,
            (layer.lines[0].stops[7].x + 1., layer.lines[0].bounds.y + 5.),
            0.,
        );
        let entry = &visible[0];
        let (start, end) = layer.word_at(entry, cap.unwrap());
        assert_eq!(layer.selected_text(&visible, start, end), "Cap");
    }

    /// Wider than the tiling threshold on macOS, so it goes through tiles: the
    /// first tile cuts the middle sentence and the second reads it whole, and
    /// it must come back once, whole, between the other two.
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    #[test]
    fn the_platform_engine_stitches_a_tiled_capture() {
        let lines = match recognize_file(&fixture("ocr-tiled.png"), &AtomicBool::new(false)) {
            Ok(lines) => lines,
            Err(error) if cfg!(windows) && error.contains("not available") => {
                eprintln!("skipping: {error}");
                return;
            }
            Err(error) => panic!("recognition failed: {error}"),
        };
        let texts: Vec<&str> = lines.iter().map(|line| line.text.as_str()).collect();
        assert_eq!(
            texts,
            vec![
                "Top left heading",
                "This sentence crosses the tile overlap",
                "Bottom right footer"
            ]
        );
    }

    #[test]
    fn a_cancelled_recognition_stops_before_reading() {
        let Some(tiling) = platform::TILING else {
            return;
        };
        assert!(3000 > tiling.threshold);
        let bgra = vec![255; 3000 * 1200 * 4];
        let result = recognize_tiled(&bgra, 3000, 1200, &AtomicBool::new(true));
        assert_eq!(result.unwrap_err(), "cancelled");
    }

    /// `CAP_OCR_MEASURE_DIR=<dir of PNGs> cargo test ... measure_recognition
    /// -- --ignored --nocapture` prints recognition and layout time per file.
    #[test]
    #[ignore]
    fn measure_recognition() {
        let dir = std::env::var("CAP_OCR_MEASURE_DIR").expect("CAP_OCR_MEASURE_DIR");
        let mut paths: Vec<PathBuf> = std::fs::read_dir(dir)
            .unwrap()
            .flatten()
            .map(|entry| entry.path())
            .filter(|path| path.extension().is_some_and(|ext| ext == "png"))
            .collect();
        paths.sort();
        for path in paths {
            let started = Instant::now();
            let lines = match recognize_file(&path, &AtomicBool::new(false)) {
                Ok(lines) => lines,
                Err(error) => {
                    println!(
                        "{}: error after {} ms: {error}",
                        path.display(),
                        started.elapsed().as_millis()
                    );
                    continue;
                }
            };
            let recognized = started.elapsed();
            let words: usize = lines.iter().map(|line| line.words.len()).sum();
            let preview: Vec<String> = lines
                .iter()
                .take(14)
                .map(|line| line.text.clone())
                .collect();
            let layout_started = Instant::now();
            let layer = layer(lines);
            let visible = whole(&layer);
            let all = layer.selected_text(&visible, at(0, 0), at(usize::MAX, usize::MAX));
            println!(
                "{}: lines={} words={} recognize_ms={} layout_ms={} chars={}\n  {:?}",
                path.file_name().unwrap().to_string_lossy(),
                layer.lines.len(),
                words,
                recognized.as_millis(),
                layout_started.elapsed().as_millis(),
                all.chars().count(),
                preview
            );
        }
    }
}
