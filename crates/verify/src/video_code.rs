//! Video frame markers.
//!
//! Every synthetic source frame is filled with its stream's key colour and
//! carries an 8x8 block code in its centre: a ring of 28 alternating pilot
//! cells (which give the local black and white levels and lock the geometry)
//! around 36 data cells holding a 16-bit frame index, a 4-bit tag (stream kind
//! and recording segment) and a CRC-16 of both.
//!
//! The reader does not need to know where the renderer put the stream: it
//! finds the stream's key-coloured region, derives the code square from the
//! region's centre and height (centre crops, rounded corners, circular camera
//! bubbles and padding all preserve both), refines the geometry against the
//! pilot ring and only then reads the data cells. A cell whose level is not
//! clearly black or white, a pilot that disagrees, or a CRC mismatch makes the
//! frame unreadable rather than wrong: a decoded index is either right or the
//! frame is reported as damaged.

use serde::{Deserialize, Serialize};

pub const GRID: usize = 8;
#[cfg(test)]
const DATA_CELLS: usize = (GRID - 2) * (GRID - 2);
const INDEX_BITS: u32 = 16;
const TAG_BITS: u32 = 4;
const PAYLOAD_BITS: u32 = INDEX_BITS + TAG_BITS;
const WHITENING: u64 = 0x9_A5C3_5E71;
pub const MAX_INDEX: u32 = (1 << INDEX_BITS) - 1;
pub const MAX_SEGMENT: u8 = 3;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum StreamKind {
    Screen,
    Camera,
}

impl StreamKind {
    pub const ALL: [StreamKind; 2] = [StreamKind::Screen, StreamKind::Camera];

    pub fn key_rgb(self) -> [u8; 3] {
        match self {
            StreamKind::Screen => [32, 96, 224],
            StreamKind::Camera => [224, 64, 128],
        }
    }

    /// Side of the code square as a fraction of the frame height. The camera
    /// code is larger because the bubble is small, and stays inside the
    /// inscribed circle of the centre square (half diagonal 0.42 < 0.5).
    pub fn code_side_fraction(self) -> f64 {
        match self {
            StreamKind::Screen => 0.5,
            StreamKind::Camera => 0.6,
        }
    }

    fn tag(self) -> u8 {
        match self {
            StreamKind::Screen => 0,
            StreamKind::Camera => 1,
        }
    }

    fn from_tag(tag: u8) -> Option<Self> {
        match tag {
            0 => Some(StreamKind::Screen),
            1 => Some(StreamKind::Camera),
            _ => None,
        }
    }

    fn key_chroma(self) -> (f64, f64) {
        let [r, g, b] = self.key_rgb();
        let (_, cb, cr) = rgb_to_ycbcr(r, g, b);
        (cb, cr)
    }

    pub fn name(self) -> &'static str {
        match self {
            StreamKind::Screen => "screen",
            StreamKind::Camera => "camera",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct FrameMarker {
    pub kind: StreamKind,
    pub segment: u8,
    pub index: u32,
}

impl FrameMarker {
    pub fn new(kind: StreamKind, segment: u8, index: u32) -> Self {
        assert!(
            index <= MAX_INDEX,
            "frame index {index} exceeds {MAX_INDEX}"
        );
        assert!(
            segment <= MAX_SEGMENT,
            "segment {segment} exceeds {MAX_SEGMENT}"
        );
        Self {
            kind,
            segment,
            index,
        }
    }

    fn payload(self) -> u32 {
        let tag = u32::from(self.kind.tag() | (self.segment << 2));
        self.index | (tag << INDEX_BITS)
    }

    fn bits(self) -> u64 {
        let payload = self.payload();
        let crc = crc16(&payload.to_le_bytes()[..3]);
        (u64::from(payload) | (u64::from(crc) << PAYLOAD_BITS)) ^ WHITENING
    }

    fn from_bits(bits: u64) -> Option<Self> {
        let bits = bits ^ WHITENING;
        let payload = (bits & ((1 << PAYLOAD_BITS) - 1)) as u32;
        let crc = (bits >> PAYLOAD_BITS) as u16;
        if crc16(&payload.to_le_bytes()[..3]) != crc {
            return None;
        }
        let tag = (payload >> INDEX_BITS) as u8;
        Some(Self {
            kind: StreamKind::from_tag(tag & 0b11)?,
            segment: tag >> 2,
            index: payload & MAX_INDEX,
        })
    }
}

pub(crate) fn crc16(bytes: &[u8]) -> u16 {
    let mut crc: u16 = 0xFFFF;
    for &byte in bytes {
        crc ^= u16::from(byte) << 8;
        for _ in 0..8 {
            crc = if crc & 0x8000 != 0 {
                (crc << 1) ^ 0x1021
            } else {
                crc << 1
            };
        }
    }
    crc
}

fn pilot_is_white(row: usize, col: usize) -> bool {
    (row + col) % 2 == 1
}

fn is_pilot(row: usize, col: usize) -> bool {
    row == 0 || col == 0 || row == GRID - 1 || col == GRID - 1
}

fn data_bit_index(row: usize, col: usize) -> usize {
    (row - 1) * (GRID - 2) + (col - 1)
}

fn cell_is_white(bits: u64, row: usize, col: usize) -> bool {
    if is_pilot(row, col) {
        pilot_is_white(row, col)
    } else {
        bits >> data_bit_index(row, col) & 1 == 1
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PixelOrder {
    Rgba,
    Bgra,
}

/// Square code geometry in pixel space.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct CodeGeometry {
    pub x0: f64,
    pub y0: f64,
    pub side: f64,
}

impl CodeGeometry {
    pub fn for_frame(kind: StreamKind, width: usize, height: usize) -> Self {
        let side = (kind.code_side_fraction() * height as f64)
            .min(width as f64)
            .floor();
        Self {
            x0: ((width as f64 - side) / 2.0).floor(),
            y0: ((height as f64 - side) / 2.0).floor(),
            side,
        }
    }

    fn cell_center(&self, row: usize, col: usize) -> (f64, f64) {
        let cell = self.side / GRID as f64;
        (
            self.x0 + (col as f64 + 0.5) * cell,
            self.y0 + (row as f64 + 0.5) * cell,
        )
    }
}

/// Draws a full marker frame (key colour background plus the code) into a
/// packed 4-byte-per-pixel buffer.
pub fn draw_marker(
    marker: FrameMarker,
    data: &mut [u8],
    width: usize,
    height: usize,
    stride: usize,
    order: PixelOrder,
) {
    let [kr, kg, kb] = marker.kind.key_rgb();
    let key = match order {
        PixelOrder::Rgba => [kr, kg, kb, 255],
        PixelOrder::Bgra => [kb, kg, kr, 255],
    };
    let geometry = CodeGeometry::for_frame(marker.kind, width, height);
    let bits = marker.bits();
    let cell = geometry.side / GRID as f64;
    for y in 0..height {
        let row = &mut data[y * stride..y * stride + width * 4];
        let fy = y as f64 + 0.5 - geometry.y0;
        let code_row = (fy >= 0.0 && fy < geometry.side).then(|| (fy / cell) as usize);
        for (x, px) in row.chunks_exact_mut(4).enumerate() {
            let fx = x as f64 + 0.5 - geometry.x0;
            let value = match code_row {
                Some(r) if fx >= 0.0 && fx < geometry.side => {
                    let c = ((fx / cell) as usize).min(GRID - 1);
                    let r = r.min(GRID - 1);
                    Some(if cell_is_white(bits, r, c) { 255 } else { 0 })
                }
                _ => None,
            };
            match value {
                Some(v) => px.copy_from_slice(&[v, v, v, 255]),
                None => px.copy_from_slice(&key),
            }
        }
    }
}

/// Allocates and draws an RGBA marker frame.
pub fn marker_rgba(marker: FrameMarker, width: usize, height: usize) -> Vec<u8> {
    let mut data = vec![0u8; width * height * 4];
    draw_marker(
        marker,
        &mut data,
        width,
        height,
        width * 4,
        PixelOrder::Rgba,
    );
    data
}

pub fn rgb_to_ycbcr(r: u8, g: u8, b: u8) -> (f64, f64, f64) {
    let (r, g, b) = (f64::from(r), f64::from(g), f64::from(b));
    (
        0.299 * r + 0.587 * g + 0.114 * b,
        -0.168_736 * r - 0.331_264 * g + 0.5 * b,
        0.5 * r - 0.418_688 * g - 0.081_312 * b,
    )
}

/// Tightly packed limited-range NV12 (BT.601) of an RGBA picture: the Y
/// plane, then interleaved Cb/Cr sampled at each 2x2 block's top-left pixel.
pub fn rgba_to_nv12(rgba: &[u8], width: usize, height: usize) -> Vec<u8> {
    let ycc = |x: usize, y: usize| {
        let i = (y * width + x) * 4;
        rgb_to_ycbcr(rgba[i], rgba[i + 1], rgba[i + 2])
    };
    let mut out = Vec::with_capacity(width * height * 3 / 2);
    for y in 0..height {
        for x in 0..width {
            let (l, _, _) = ycc(x, y);
            out.push((16.0 + l * 219.0 / 255.0).round() as u8);
        }
    }
    for y in 0..height / 2 {
        for x in 0..width / 2 {
            let (_, cb, cr) = ycc(x * 2, y * 2);
            out.push((128.0 + cb * 224.0 / 255.0).round() as u8);
            out.push((128.0 + cr * 224.0 / 255.0).round() as u8);
        }
    }
    out
}

/// Read access to a decoded picture in luma + centred chroma.
pub trait PixelSource {
    fn width(&self) -> usize;
    fn height(&self) -> usize;
    fn luma(&self, x: usize, y: usize) -> f64;
    /// (Cb - 128, Cr - 128) at the pixel.
    fn chroma(&self, x: usize, y: usize) -> (f64, f64);
}

pub struct PackedFrame<'a> {
    pub data: &'a [u8],
    pub width: usize,
    pub height: usize,
    pub stride: usize,
    pub order: PixelOrder,
}

impl PackedFrame<'_> {
    fn rgb(&self, x: usize, y: usize) -> (u8, u8, u8) {
        let i = y * self.stride + x * 4;
        let px = &self.data[i..i + 3];
        match self.order {
            PixelOrder::Rgba => (px[0], px[1], px[2]),
            PixelOrder::Bgra => (px[2], px[1], px[0]),
        }
    }
}

impl PixelSource for PackedFrame<'_> {
    fn width(&self) -> usize {
        self.width
    }

    fn height(&self) -> usize {
        self.height
    }

    fn luma(&self, x: usize, y: usize) -> f64 {
        let (r, g, b) = self.rgb(x, y);
        rgb_to_ycbcr(r, g, b).0
    }

    fn chroma(&self, x: usize, y: usize) -> (f64, f64) {
        let (r, g, b) = self.rgb(x, y);
        let (_, cb, cr) = rgb_to_ycbcr(r, g, b);
        (cb, cr)
    }
}

/// Planar 4:2:0 picture (YUV420P), or semi-planar NV12 when `v` is `None`
/// and `u` holds interleaved CbCr.
pub struct Yuv420Frame<'a> {
    pub width: usize,
    pub height: usize,
    pub y: &'a [u8],
    pub y_stride: usize,
    pub u: &'a [u8],
    pub u_stride: usize,
    pub v: Option<(&'a [u8], usize)>,
}

impl PixelSource for Yuv420Frame<'_> {
    fn width(&self) -> usize {
        self.width
    }

    fn height(&self) -> usize {
        self.height
    }

    fn luma(&self, x: usize, y: usize) -> f64 {
        f64::from(self.y[y * self.y_stride + x])
    }

    fn chroma(&self, x: usize, y: usize) -> (f64, f64) {
        let (cx, cy) = (x / 2, y / 2);
        let (cb, cr) = match self.v {
            Some((v, v_stride)) => (self.u[cy * self.u_stride + cx], v[cy * v_stride + cx]),
            None => {
                let i = cy * self.u_stride + cx * 2;
                (self.u[i], self.u[i + 1])
            }
        };
        (f64::from(cb) - 128.0, f64::from(cr) - 128.0)
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "state", rename_all = "lowercase")]
pub enum Readout {
    /// No region of this stream's key colour is visible.
    Absent,
    /// The stream is visible but its code could not be read reliably.
    Unreadable { reason: String },
    Marker {
        marker: FrameMarker,
        /// Worst data-cell distance from the black/white threshold, as a
        /// fraction of the pilot contrast (0.5 = perfect).
        margin: f64,
        mirrored: bool,
    },
    /// A cross-fade of two codes (`progress` 0 = all outgoing).
    Blend {
        outgoing: FrameMarker,
        incoming: FrameMarker,
        progress: f64,
        residual: f64,
    },
}

impl Readout {
    pub fn marker(&self) -> Option<FrameMarker> {
        match self {
            Readout::Marker { marker, .. } => Some(*marker),
            _ => None,
        }
    }
}

#[derive(Clone, Copy, Debug)]
pub struct Region {
    pub x0: f64,
    pub y0: f64,
    pub x1: f64,
    pub y1: f64,
}

const KEY_CHROMA_TOLERANCE: f64 = 38.0;
const KEY_MIN_CHROMA: f64 = 36.0;

fn is_key(chroma: (f64, f64), key: (f64, f64)) -> bool {
    let magnitude = chroma.0.hypot(chroma.1);
    if magnitude < KEY_MIN_CHROMA {
        return false;
    }
    // Limited-range video scales chroma by 224/255; compare against both.
    let full = (chroma.0 - key.0).hypot(chroma.1 - key.1);
    let limited = (chroma.0 - key.0 * 0.878).hypot(chroma.1 - key.1 * 0.878);
    full.min(limited) < KEY_CHROMA_TOLERANCE
}

/// Bounding box of the stream's key-coloured region.
pub fn locate_region(img: &impl PixelSource, kind: StreamKind) -> Option<Region> {
    let (w, h) = (img.width(), img.height());
    if w < 8 || h < 8 {
        return None;
    }
    let step = (w.min(h) / 240).max(1);
    let key = kind.key_chroma();
    let cols = w.div_ceil(step);
    let rows = h.div_ceil(step);
    let mut row_counts = vec![0usize; rows];
    let mut col_counts = vec![0usize; cols];
    for (ry, row_count) in row_counts.iter_mut().enumerate() {
        let y = ry * step;
        for (cx, col_count) in col_counts.iter_mut().enumerate() {
            if is_key(img.chroma(cx * step, y), key) {
                *row_count += 1;
                *col_count += 1;
            }
        }
    }
    let total: usize = row_counts.iter().sum();
    if total < 12 {
        return None;
    }
    let extent = |counts: &[usize]| -> Option<(usize, usize)> {
        let max = *counts.iter().max()?;
        let threshold = (max / 10).max(2);
        let first = counts.iter().position(|&c| c >= threshold)?;
        let last = counts.iter().rposition(|&c| c >= threshold)?;
        Some((first, last))
    };
    let (r0, r1) = extent(&row_counts)?;
    let (c0, c1) = extent(&col_counts)?;
    let refine = |coarse: usize, dir: isize, horizontal: bool| -> f64 {
        // Walk outward from the coarse edge at full resolution along the
        // centre line of the region to find the exact key boundary.
        let (lo, hi) = if horizontal { (0, w) } else { (0, h) };
        let mid_other = if horizontal {
            ((r0 + r1) * step / 2).min(h - 1)
        } else {
            ((c0 + c1) * step / 2).min(w - 1)
        };
        let probe = |p: usize| {
            let (x, y) = if horizontal {
                (p, mid_other)
            } else {
                (mid_other, p)
            };
            is_key(img.chroma(x, y), key)
        };
        let mut p = (coarse * step).clamp(lo, hi - 1) as isize;
        let limit = (2 * step) as isize + 2;
        let mut moved = 0;
        while moved < limit {
            let next = p + dir;
            if next < lo as isize || next >= hi as isize || !probe(next as usize) {
                break;
            }
            p = next;
            moved += 1;
        }
        if dir < 0 { p as f64 } else { p as f64 + 1.0 }
    };
    // Rows/columns through the centre may cross the code (no key colour),
    // so refine horizontal edges on the region's top band instead when the
    // centre line misses; the coarse value is kept when refinement fails.
    let x0 = refine(c0, -1, true).min((c0 * step) as f64);
    let x1 = refine(c1, 1, true).max((c1 * step + 1) as f64);
    let y0 = refine(r0, -1, false).min((r0 * step) as f64);
    let y1 = refine(r1, 1, false).max((r1 * step + 1) as f64);
    Some(Region { x0, y0, x1, y1 })
}

struct CellSample {
    levels: [[f64; GRID]; GRID],
}

fn sample_cells(img: &impl PixelSource, geometry: &CodeGeometry) -> Option<CellSample> {
    let (w, h) = (img.width() as f64, img.height() as f64);
    let cell = geometry.side / GRID as f64;
    let mut levels = [[0.0; GRID]; GRID];
    let offsets = [-0.22, 0.0, 0.22];
    for (row, row_levels) in levels.iter_mut().enumerate() {
        for (col, level) in row_levels.iter_mut().enumerate() {
            let (cx, cy) = geometry.cell_center(row, col);
            let mut sum = 0.0;
            let mut n = 0.0;
            for oy in offsets {
                for ox in offsets {
                    let x = cx + ox * cell;
                    let y = cy + oy * cell;
                    if x < 0.0 || y < 0.0 || x >= w || y >= h {
                        return None;
                    }
                    sum += img.luma(x as usize, y as usize);
                    n += 1.0;
                }
            }
            *level = sum / n;
        }
    }
    Some(CellSample { levels })
}

struct PilotFit {
    black: f64,
    white: f64,
    margin: f64,
}

fn pilot_fit(sample: &CellSample) -> PilotFit {
    let mut black_sum = 0.0;
    let mut white_sum = 0.0;
    let mut black_max = f64::MIN;
    let mut white_min = f64::MAX;
    let mut nb = 0.0;
    let mut nw = 0.0;
    for (row, row_levels) in sample.levels.iter().enumerate() {
        for (col, &v) in row_levels.iter().enumerate() {
            if !is_pilot(row, col) {
                continue;
            }
            if pilot_is_white(row, col) {
                white_sum += v;
                nw += 1.0;
                white_min = white_min.min(v);
            } else {
                black_sum += v;
                nb += 1.0;
                black_max = black_max.max(v);
            }
        }
    }
    PilotFit {
        black: black_sum / nb,
        white: white_sum / nw,
        margin: white_min - black_max,
    }
}

const MIN_CONTRAST: f64 = 48.0;
const MIN_CELL_MARGIN: f64 = 0.18;

/// Reads the code of one stream from a picture, locating it by key colour.
pub fn read_stream(img: &impl PixelSource, kind: StreamKind) -> Readout {
    match stream_square(img, kind) {
        Ok((cx, cy, side)) => read_code_near(img, kind, cx, cy, side),
        Err(readout) => readout,
    }
}

/// Cell levels of a located code, normalised so the pilot black level is 0
/// and white is 1.
#[derive(Clone, Debug)]
pub struct CodeCells {
    pub levels: [[f64; GRID]; GRID],
    pub contrast: f64,
}

/// Finds the code square near (cx, cy) with the given side, refining
/// position and scale against the pilot ring.
fn locate_cells(
    img: &impl PixelSource,
    cx: f64,
    cy: f64,
    side: f64,
) -> Result<(PilotFit, CellSample), Readout> {
    let cell = side / GRID as f64;
    let shift_step = (cell / 6.0).max(0.5);
    let mut best: Option<(PilotFit, CellSample)> = None;
    for scale in [1.0, 0.97, 1.03, 0.94, 1.06] {
        for dy in -2..=2 {
            for dx in -2..=2 {
                let s = side * scale;
                let geometry = CodeGeometry {
                    x0: cx - s / 2.0 + f64::from(dx) * shift_step,
                    y0: cy - s / 2.0 + f64::from(dy) * shift_step,
                    side: s,
                };
                let Some(sample) = sample_cells(img, &geometry) else {
                    continue;
                };
                let fit = pilot_fit(&sample);
                if best.as_ref().is_none_or(|(b, _)| fit.margin > b.margin) {
                    best = Some((fit, sample));
                }
            }
        }
    }
    let Some((fit, sample)) = best else {
        return Err(Readout::Unreadable {
            reason: "code square falls outside the picture".into(),
        });
    };
    let contrast = fit.white - fit.black;
    if contrast < MIN_CONTRAST {
        return Err(Readout::Unreadable {
            reason: format!("pilot contrast {contrast:.0} too low"),
        });
    }
    if fit.margin < contrast * 0.3 {
        return Err(Readout::Unreadable {
            reason: format!(
                "pilot ring not resolved (margin {:.2})",
                fit.margin / contrast
            ),
        });
    }
    Ok((fit, sample))
}

/// Locates the stream's code square from its key-coloured region.
fn stream_square(img: &impl PixelSource, kind: StreamKind) -> Result<(f64, f64, f64), Readout> {
    let Some(region) = locate_region(img, kind) else {
        return Err(Readout::Absent);
    };
    let height = region.y1 - region.y0;
    let width = region.x1 - region.x0;
    let side = (kind.code_side_fraction() * height).min(width);
    if side < 12.0 {
        return Err(Readout::Unreadable {
            reason: format!("{} region too small ({width:.0}x{height:.0})", kind.name()),
        });
    }
    Ok((
        (region.x0 + region.x1) / 2.0,
        (region.y0 + region.y1) / 2.0,
        side,
    ))
}

/// Normalised cell levels of the stream's code (for blend checks).
pub fn read_cells(img: &impl PixelSource, kind: StreamKind) -> Result<CodeCells, Readout> {
    let (cx, cy, side) = stream_square(img, kind)?;
    let (fit, sample) = locate_cells(img, cx, cy, side)?;
    let contrast = fit.white - fit.black;
    let mut levels = [[0.0; GRID]; GRID];
    for (row, row_levels) in levels.iter_mut().enumerate() {
        for (col, level) in row_levels.iter_mut().enumerate() {
            *level = (sample.levels[row][col] - fit.black) / contrast;
        }
    }
    Ok(CodeCells { levels, contrast })
}

/// How well a cross-fade of `outgoing` into `incoming` explains the cells:
/// fits the mix `progress` over the cells whose bits differ and returns
/// (progress, worst residual over all data cells).
pub fn blend_fit(cells: &CodeCells, outgoing: FrameMarker, incoming: FrameMarker) -> (f64, f64) {
    let (a, b) = (outgoing.bits(), incoming.bits());
    let bit =
        |bits: u64, row: usize, col: usize| f64::from(u8::from(cell_is_white(bits, row, col)));
    let mut num = 0.0;
    let mut den = 0.0;
    for (row, row_levels) in cells.levels.iter().enumerate() {
        for (col, &v) in row_levels.iter().enumerate() {
            let (x, y) = (bit(a, row, col), bit(b, row, col));
            if x != y {
                // v = x + p (y - x)
                num += (v - x) * (y - x);
                den += (y - x) * (y - x);
            }
        }
    }
    let p = if den > 0.0 {
        (num / den).clamp(0.0, 1.0)
    } else {
        0.5
    };
    let mut worst: f64 = 0.0;
    for (row, row_levels) in cells.levels.iter().enumerate() {
        for (col, &v) in row_levels.iter().enumerate() {
            if is_pilot(row, col) {
                continue;
            }
            let (x, y) = (bit(a, row, col), bit(b, row, col));
            worst = worst.max((v - (x + p * (y - x))).abs());
        }
    }
    (p, worst)
}

/// Largest per-cell residual a blend may leave and still count as a match.
pub const BLEND_TOLERANCE: f64 = 0.3;

/// Reads a code whose square is approximately centred at (cx, cy) with the
/// given side, refining position and scale against the pilot ring.
pub fn read_code_near(
    img: &impl PixelSource,
    kind: StreamKind,
    cx: f64,
    cy: f64,
    side: f64,
) -> Readout {
    let (fit, sample) = match locate_cells(img, cx, cy, side) {
        Ok(found) => found,
        Err(readout) => return readout,
    };
    let contrast = fit.white - fit.black;
    let threshold = (fit.white + fit.black) / 2.0;
    let mut worst = f64::MAX;
    let mut bits = 0u64;
    let mut mirrored_bits = 0u64;
    for (row, row_levels) in sample.levels.iter().enumerate() {
        for (col, &v) in row_levels.iter().enumerate() {
            if is_pilot(row, col) {
                continue;
            }
            worst = worst.min((v - threshold).abs() / contrast);
            if v > threshold {
                bits |= 1 << data_bit_index(row, col);
                mirrored_bits |= 1 << data_bit_index(row, GRID - 1 - col);
            }
        }
    }
    if worst < MIN_CELL_MARGIN {
        return Readout::Unreadable {
            reason: format!("ambiguous data cell (margin {worst:.2})"),
        };
    }
    for (candidate, mirrored) in [(bits, false), (mirrored_bits, true)] {
        if let Some(marker) = FrameMarker::from_bits(candidate) {
            if marker.kind != kind {
                return Readout::Unreadable {
                    reason: format!(
                        "{} region carries a {} code",
                        kind.name(),
                        marker.kind.name()
                    ),
                };
            }
            return Readout::Marker {
                marker,
                margin: worst,
                mirrored,
            };
        }
    }
    Readout::Unreadable {
        reason: "checksum mismatch".into(),
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct FrameReadout {
    pub screen: Readout,
    pub camera: Readout,
}

impl FrameReadout {
    pub fn get(&self, kind: StreamKind) -> &Readout {
        match kind {
            StreamKind::Screen => &self.screen,
            StreamKind::Camera => &self.camera,
        }
    }
}

pub fn read_frame(img: &impl PixelSource) -> FrameReadout {
    FrameReadout {
        screen: read_stream(img, StreamKind::Screen),
        camera: read_stream(img, StreamKind::Camera),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn packed(data: &[u8], w: usize, h: usize) -> PackedFrame<'_> {
        PackedFrame {
            data,
            width: w,
            height: h,
            stride: w * 4,
            order: PixelOrder::Rgba,
        }
    }

    #[test]
    fn bits_round_trip_for_every_tag() {
        for kind in StreamKind::ALL {
            for segment in 0..=MAX_SEGMENT {
                for index in [0, 1, 2, 255, 256, 4095, 30_000, MAX_INDEX] {
                    let marker = FrameMarker::new(kind, segment, index);
                    assert_eq!(FrameMarker::from_bits(marker.bits()), Some(marker));
                }
            }
        }
    }

    #[test]
    fn single_and_double_bit_errors_never_decode_as_another_marker() {
        let marker = FrameMarker::new(StreamKind::Screen, 0, 1234);
        let bits = marker.bits();
        for i in 0..DATA_CELLS {
            assert_eq!(FrameMarker::from_bits(bits ^ (1 << i)), None);
            for j in i + 1..DATA_CELLS {
                assert_eq!(FrameMarker::from_bits(bits ^ (1 << i) ^ (1 << j)), None);
            }
        }
    }

    #[test]
    fn clean_frames_decode_at_many_sizes() {
        for (w, h) in [(320, 180), (640, 360), (1280, 720), (100, 100), (64, 48)] {
            for kind in StreamKind::ALL {
                for index in [0, 7, 1000, MAX_INDEX] {
                    let marker = FrameMarker::new(kind, 2, index);
                    let data = marker_rgba(marker, w, h);
                    let readout = read_stream(&packed(&data, w, h), kind);
                    assert_eq!(readout.marker(), Some(marker), "{w}x{h} {readout:?}");
                }
            }
        }
    }

    #[test]
    fn other_stream_reads_absent() {
        let data = marker_rgba(FrameMarker::new(StreamKind::Screen, 0, 5), 320, 180);
        assert_eq!(
            read_stream(&packed(&data, 320, 180), StreamKind::Camera),
            Readout::Absent
        );
    }
}
