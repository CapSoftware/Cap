//! Keeps a tracked box's sides on the straight edges they started on.
//!
//! Some targets are defined by their outline more than by anything inside
//! it: a window being resized from its corner has a border that moves while
//! its title bar, its text and the page behind it all stay still, so patch
//! matching sees nothing move. A side the user clicked along lies on such an
//! edge when the target's outline there is one even colour (a border, a
//! card's fill) that the page just outside does not share. That colour is
//! remembered, and each frame every line near the side gets a vote from
//! each position along it where the line has that colour and the pixels
//! just beyond do not; the line most positions vote for is the edge.
//! Content inside or outside the target can change freely, since only the
//! edge line and what is just beyond it are compared. The box around a
//! round shape touches its sides at a point, so no edge is remembered there.

use crate::motion_track::{LumaFrame, TrackPoint};

/// How far a side may be moved from where it was last seen, or from where
/// the fit put it, in pixels.
const SEARCH: isize = 28;
/// How many lines in from the side the outline may run.
const OUTLINE_DEPTH: isize = 3;
/// How many frames in a row an edge may go unfound and still hold its side.
const HOLD_FRAMES: u32 = 15;
/// How far an edge may move between frames and still count as staying put.
const STAY: isize = 3;
/// How far, in pixels, a clicked point may be from a side and be on it.
const ON_SIDE: f64 = 4.0;
/// The middle share of a side that is sampled, clear of rounded corners.
const SPAN: f64 = 0.6;
/// Samples along a side are this many pixels apart.
const STRIDE: usize = 2;
/// How far a pixel may be from the edge's colour and still be the edge.
const COLOUR_TOLERANCE: f32 = 10.0;
/// How far an outline's colour must be from what is beyond it...
const DISTINCT: f32 = 2.0 * COLOUR_TOLERANCE;
/// ...over this many pixels beyond it...
const BEYOND_BAND: isize = 8;
/// ...for all but this share of those pixels.
const MAX_SHARED: f64 = 0.1;
/// The edge line is compared with the line this far outward, past the
/// pixel that scaling and compression blend from both sides.
const BEYOND: isize = 2;
/// Share of positions that must agree for a line to be the edge.
const MIN_AGREEMENT: f64 = 0.6;

#[derive(Clone, Copy, PartialEq, Debug)]
enum Side {
    Left,
    Right,
    Top,
    Bottom,
}

impl Side {
    /// The step from a side's line to the line just outside the target.
    fn outward(self) -> isize {
        match self {
            Side::Left | Side::Top => -1,
            Side::Right | Side::Bottom => 1,
        }
    }

    fn vertical(self) -> bool {
        matches!(self, Side::Left | Side::Right)
    }
}

struct Edge {
    side: Side,
    colour: f32,
    /// Where the edge line was found relative to the side, in pixels.
    offset: f64,
    /// The line the edge was last found on. The search also covers the
    /// fitted side, but starts here, so a fit that drifts (patches stuck on
    /// content that does not move with the edge) cannot lose the edge.
    last: isize,
    /// Frames in a row the edge has not been found.
    missed: u32,
}

pub(crate) struct BoxEdges {
    edges: Vec<Edge>,
}

impl BoxEdges {
    /// `points` are the clicked points, normalized to the frame. Only a
    /// side the user clicked along (two points on it, spanning most of it,
    /// as a rectangle's corners do) can be an edge: the box around a round
    /// or slanted shape touches it at a point, and the straight lines it
    /// runs along are the page behind, which must not pull it.
    pub(crate) fn new(frame: &LumaFrame, start: TrackPoint, points: &[(f64, f64)]) -> Self {
        let rect = Rect::from(start, frame);
        let edges = [Side::Left, Side::Right, Side::Top, Side::Bottom]
            .into_iter()
            .filter(|&side| clicked_along(frame, &rect, side, points))
            .filter_map(|side| {
                let at = rect.side(side).round() as isize;
                // The outline is the band of lines, near the side, that are
                // each one colour along their length and stand out from
                // what is beyond. Points are clicked on or just inside
                // it, so the band is searched inwards; searching outwards
                // finds the page around the target. The edge is the
                // outermost line of the band's typical colour: on scaled,
                // compressed video the outermost pixel is often a blend
                // with what is beyond, off the band's colour, and moves in
                // colour as the edge moves by a fraction of a pixel.
                let qualifies = |line: isize| {
                    let colour = even_colour(frame, &rect, side, line)?;
                    rare_beyond(frame, &rect, side, line, colour)?.then_some((line, colour))
                };
                // A thin rim the page shares (a grey border on dark text)
                // is skipped: the band starts at the first line in reach
                // that stands out, such as the fill just inside the rim.
                let band = (0..=OUTLINE_DEPTH)
                    .map(|inward| at - inward * side.outward())
                    .skip_while(|&line| qualifies(line).is_none())
                    .map_while(qualifies)
                    .collect::<Vec<_>>();
                let mut colours = band.iter().map(|&(_, colour)| colour).collect::<Vec<_>>();
                colours.sort_by(f32::total_cmp);
                let typical = *colours.get(colours.len() / 2)?;
                band.into_iter()
                    .find(|&(_, colour)| (colour - typical).abs() <= COLOUR_TOLERANCE / 2.0)
                    .and_then(|(line, colour)| {
                        let edge = Edge {
                            side,
                            colour,
                            offset: line as f64 - rect.side(side),
                            last: line,
                            missed: 0,
                        };
                        locate(frame, &rect, &edge, &[line])
                            .is_some_and(|found| (found - line).abs() <= 1)
                            .then_some(edge)
                    })
            })
            .collect();
        Self { edges }
    }

    /// `fitted` with each remembered side moved onto its edge, where enough
    /// positions along the side agree on where the edge is, and how many
    /// sides were found. Positions are taken along the fitted box, so the
    /// fit only has to be roughly right.
    pub(crate) fn snap(&mut self, frame: &LumaFrame, fitted: TrackPoint) -> (TrackPoint, usize) {
        let original = Rect::from(fitted, frame);
        let mut rect = original;
        let mut found = 0;
        for edge in &mut self.edges {
            let predicted = (original.side(edge.side) + edge.offset).round() as isize;
            match locate(frame, &original, edge, &[edge.last, predicted]) {
                Some(line) => {
                    edge.last = line;
                    edge.missed = 0;
                    rect.set_side(edge.side, line as f64 - edge.offset);
                    found += 1;
                }
                // Missed for a frame or two (a cursor over it, an encoding
                // glitch): the side stays where the edge just was rather
                // than jumping back to the estimate it was correcting.
                None if edge.missed < HOLD_FRAMES => {
                    edge.missed += 1;
                    rect.set_side(edge.side, edge.last as f64 - edge.offset);
                }
                None => edge.missed += 1,
            }
        }
        (rect.into_point(fitted.time, frame), found)
    }
}

/// Whether at least two of `points` lie on `side` (within a few pixels)
/// and between them cover the sampled middle of it.
fn clicked_along(frame: &LumaFrame, rect: &Rect, side: Side, points: &[(f64, f64)]) -> bool {
    let (width, height) = (frame.width() as f64, frame.height() as f64);
    let at = rect.side(side);
    let along = points
        .iter()
        .map(|&(x, y)| (x * width, y * height))
        .filter(|&(x, y)| ((if side.vertical() { x } else { y }) - at).abs() <= ON_SIDE)
        .map(|(x, y)| if side.vertical() { y } else { x })
        .collect::<Vec<_>>();
    let (from, to) = if side.vertical() {
        (rect.top, rect.bottom)
    } else {
        (rect.left, rect.right)
    };
    let covered = along.iter().copied().fold(f64::INFINITY, f64::min)
        ..=along.iter().copied().fold(f64::NEG_INFINITY, f64::max);
    let trim = (to - from) * (1.0 - SPAN) / 2.0;
    along.len() >= 2 && covered.contains(&(from + trim)) && covered.contains(&(to - trim))
}

/// Where the edge is now: near `around[0]` (where it was last seen) if
/// enough positions along the side still see it there, otherwise the line
/// within [`SEARCH`] of any of `around` that the most positions see, if
/// enough do. Staying put first keeps an edge that has not moved (the
/// anchored side of a resized panel) from being pulled onto a look-alike
/// line elsewhere in the target.
fn locate(frame: &LumaFrame, rect: &Rect, edge: &Edge, around: &[isize]) -> Option<isize> {
    let positions = positions(frame, rect, edge.side)?;
    let needed = positions.len() as f64 * MIN_AGREEMENT;
    let limit = if edge.side.vertical() {
        frame.width()
    } else {
        frame.height()
    } as isize;
    let votes = |line: isize| {
        if !(0..limit).contains(&line)
            || !(0..limit).contains(&(line + BEYOND * edge.side.outward()))
        {
            return 0;
        }
        positions
            .clone()
            .filter(|&along| {
                let on = pixel(frame, edge.side, line, along);
                let out = pixel(frame, edge.side, line + BEYOND * edge.side.outward(), along);
                (on - edge.colour).abs() <= COLOUR_TOLERANCE
                    && (out - edge.colour).abs() > COLOUR_TOLERANCE
            })
            .count()
    };
    let best = |lines: &mut dyn Iterator<Item = isize>| {
        lines
            .map(|line| (line, votes(line)))
            .max_by_key(|&(line, votes)| (votes, std::cmp::Reverse((line - around[0]).abs())))
            .filter(|&(_, votes)| votes as f64 >= needed)
            .map(|(line, _)| line)
    };
    best(&mut (around[0] - STAY..=around[0] + STAY)).or_else(|| {
        let mut lines = around
            .iter()
            .flat_map(|center| center - SEARCH..=center + SEARCH)
            .collect::<Vec<_>>();
        lines.sort_unstable();
        lines.dedup();
        best(&mut lines.into_iter())
    })
}

/// Whether `colour` stands out from nearly everything just outside `line`.
/// If the page around the target has much the same colour (a light title
/// bar on a white page), video encoding soon blurs the difference and the
/// edge gets found on the page's lines or the target's own.
fn rare_beyond(
    frame: &LumaFrame,
    rect: &Rect,
    side: Side,
    line: isize,
    colour: f32,
) -> Option<bool> {
    let limit = if side.vertical() {
        frame.width()
    } else {
        frame.height()
    } as isize;
    let (mut near, mut total) = (0usize, 0usize);
    for distance in BEYOND..=BEYOND_BAND {
        let beyond = line + distance * side.outward();
        if !(0..limit).contains(&beyond) {
            break;
        }
        for along in positions(frame, rect, side)? {
            total += 1;
            near += usize::from((pixel(frame, side, beyond, along) - colour).abs() <= DISTINCT);
        }
    }
    (total > 0).then(|| (near as f64) <= total as f64 * MAX_SHARED)
}

/// The colour of `line` along the side, when most of it is within
/// [`COLOUR_TOLERANCE`] of its median.
fn even_colour(frame: &LumaFrame, rect: &Rect, side: Side, line: isize) -> Option<f32> {
    let limit = if side.vertical() {
        frame.width()
    } else {
        frame.height()
    } as isize;
    if !(0..limit).contains(&line) {
        return None;
    }
    let mut values = positions(frame, rect, side)?
        .map(|along| pixel(frame, side, line, along))
        .collect::<Vec<_>>();
    values.sort_by(f32::total_cmp);
    let median = values[values.len() / 2];
    let even = values
        .iter()
        .filter(|value| (**value - median).abs() <= COLOUR_TOLERANCE)
        .count();
    (even as f64 >= values.len() as f64 * 0.8).then_some(median)
}

fn pixel(frame: &LumaFrame, side: Side, line: isize, along: usize) -> f32 {
    if side.vertical() {
        frame.at(line as usize, along)
    } else {
        frame.at(along, line as usize)
    }
}

/// Positions along the middle of a side, clipped to the frame.
fn positions(
    frame: &LumaFrame,
    rect: &Rect,
    side: Side,
) -> Option<std::iter::StepBy<std::ops::Range<usize>>> {
    let (from, to, limit) = if side.vertical() {
        (rect.top, rect.bottom, frame.height())
    } else {
        (rect.left, rect.right, frame.width())
    };
    let trim = (to - from) * (1.0 - SPAN) / 2.0;
    let from = (from + trim).max(0.0).round() as usize;
    let to = ((to - trim).max(0.0).round() as usize).min(limit);
    (to > from + 4 * STRIDE).then(|| (from..to).step_by(STRIDE))
}

#[derive(Clone, Copy)]
struct Rect {
    left: f64,
    top: f64,
    right: f64,
    bottom: f64,
}

impl Rect {
    fn from(point: TrackPoint, frame: &LumaFrame) -> Self {
        let (width, height) = (frame.width() as f64, frame.height() as f64);
        Self {
            left: (point.center.0 - point.size.0 / 2.0) * width,
            top: (point.center.1 - point.size.1 / 2.0) * height,
            right: (point.center.0 + point.size.0 / 2.0) * width,
            bottom: (point.center.1 + point.size.1 / 2.0) * height,
        }
    }

    fn into_point(self, time: f64, frame: &LumaFrame) -> TrackPoint {
        let (width, height) = (frame.width() as f64, frame.height() as f64);
        TrackPoint {
            time,
            center: (
                (self.left + self.right) / 2.0 / width,
                (self.top + self.bottom) / 2.0 / height,
            ),
            size: (
                (self.right - self.left) / width,
                (self.bottom - self.top) / height,
            ),
        }
    }

    fn side(&self, side: Side) -> f64 {
        match side {
            Side::Left => self.left,
            Side::Right => self.right,
            Side::Top => self.top,
            Side::Bottom => self.bottom,
        }
    }

    fn set_side(&mut self, side: Side, value: f64) {
        match side {
            Side::Left => self.left = value.min(self.right - 1.0),
            Side::Right => self.right = value.max(self.left + 1.0),
            Side::Top => self.top = value.min(self.bottom - 1.0),
            Side::Bottom => self.bottom = value.max(self.top + 1.0),
        }
    }
}
