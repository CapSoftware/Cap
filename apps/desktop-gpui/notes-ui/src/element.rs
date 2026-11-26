use std::cell::RefCell;
use std::rc::Rc;
use std::time::{Duration, Instant};

use cap_notes::{BlockKind, Pos};
use gpui::{
    AnyElement, App, AvailableSpace, Bounds, ContentMask, Corners, CursorStyle, DispatchPhase,
    Element, ElementId, ElementInputHandler, Entity, Font, GlobalElementId, Hitbox,
    HitboxBehavior, Hsla,
    IntoElement, LayoutId, MouseButton, MouseDownEvent, MouseMoveEvent, MouseUpEvent, PaintQuad,
    Path, PathBuilder, Pixels, Point, ScrollWheelEvent, SharedString, Size, Style, TextAlign,
    TextRun, Window, fill, point, px, quad, relative, size, transparent_black,
};

use crate::editor::NotesEditor;
use crate::layout::{self, BlockLayout, Decor, Marked, tabular_font};
use crate::outline::{self, Band, Segment};
use crate::reveal::Reveal;
use crate::store::{Autoscroll, Geometry, LayoutRequest, Painted, Store};

/// The caret blinks in two steps, like the system's text fields: a fade
/// repainted the whole editor every frame for a third of each second.
const BLINK_ON: u128 = 530;
const BLINK_OFF: u128 = 530;
const CHECK_DRAW: Duration = Duration::from_millis(140);
const CHECK_FILL: Duration = Duration::from_millis(100);
const SCROLLBAR_HOLD: u128 = 800;
const SCROLLBAR_FADE: u128 = 200;
/// Room under the last block of a page laid out at its full height.
const FIT_BOTTOM: f32 = 12.;
const SOURCE_FADE: Duration = Duration::from_millis(140);

#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) enum Anchor {
    SelectionTop,
    SelectionBelow,
    Point(Point<Pixels>),
    Below(Pos),
}

pub(crate) struct Popover {
    pub element: AnyElement,
    pub size: Size<Pixels>,
    pub anchor: Anchor,
}

pub(crate) struct NotesElement {
    pub view: Entity<NotesEditor>,
    pub store: Rc<RefCell<Store>>,
    pub popovers: Vec<Popover>,
}

impl IntoElement for NotesElement {
    type Element = Self;

    fn into_element(self) -> Self::Element {
        self
    }
}

pub(crate) struct Frame {
    hitbox: Hitbox,
    under: Vec<PaintQuad>,
    selection: Vec<Path<Pixels>>,
    selection_color: Hsla,
    lines: Vec<(usize, usize, Point<Pixels>, Pixels)>,
    numbers: Vec<(u32, Point<Pixels>, Pixels)>,
    labels: Vec<(SharedString, Point<Pixels>, Pixels)>,
    over: Vec<PaintQuad>,
    strokes: Vec<(Path<Pixels>, Hsla)>,
    veils: Vec<PaintQuad>,
    writer: Option<crate::writing::Scene>,
    caret: Option<PaintQuad>,
    caret_drawn: bool,
    scrollbar: Option<PaintQuad>,
    cursor: CursorStyle,
    animating: bool,
    wake: Option<Instant>,
}

fn ease_out(t: f32) -> f32 {
    let t = t.clamp(0., 1.);
    1. - (1. - t).powi(3)
}

pub(crate) fn blink(elapsed: Duration) -> (f32, Result<Duration, ()>) {
    let t = elapsed.as_millis() % (BLINK_ON + BLINK_OFF);
    if t < BLINK_ON {
        (1., Ok(Duration::from_millis((BLINK_ON - t) as u64)))
    } else {
        (
            0.,
            Ok(Duration::from_millis((BLINK_ON + BLINK_OFF - t) as u64)),
        )
    }
}

fn rect(x0: f32, y0: f32, x1: f32, y1: f32) -> Bounds<Pixels> {
    Bounds::from_corners(point(px(x0), px(y0)), point(px(x1.max(x0)), px(y1.max(y0))))
}

fn with_alpha(color: Hsla, alpha: f32) -> Hsla {
    Hsla {
        a: color.a * alpha,
        ..color
    }
}

fn build_path(segments: &[Segment]) -> Option<Path<Pixels>> {
    let mut builder = PathBuilder::fill();
    for segment in segments {
        match *segment {
            Segment::Move(x, y) => builder.move_to(point(px(x), px(y))),
            Segment::Line(x, y) => builder.line_to(point(px(x), px(y))),
            Segment::Curve { ctrl, to } => {
                builder.curve_to(point(px(to.0), px(to.1)), point(px(ctrl.0), px(ctrl.1)))
            }
        }
    }
    builder.close();
    builder.build().ok()
}

/// A polyline stroked with round caps and joins, drawn as a stroke plus a
/// dot on every vertex, which is how the caps stay round without lyon's
/// cap options (gpui does not re-export them).
fn stroke_polyline(
    points: &[(f32, f32)],
    width: f32,
    color: Hsla,
    strokes: &mut Vec<(Path<Pixels>, Hsla)>,
    dots: &mut Vec<PaintQuad>,
) {
    if points.len() < 2 {
        return;
    }
    let mut builder = PathBuilder::stroke(px(width));
    builder.move_to(point(px(points[0].0), px(points[0].1)));
    for p in &points[1..] {
        builder.line_to(point(px(p.0), px(p.1)));
    }
    if let Ok(path) = builder.build() {
        strokes.push((path, color));
    }
    for p in points {
        dots.push(quad(
            rect(
                p.0 - width / 2.,
                p.1 - width / 2.,
                p.0 + width / 2.,
                p.1 + width / 2.,
            ),
            px(width / 2.),
            color,
            px(0.),
            transparent_black(),
            Default::default(),
        ));
    }
}

fn partial_polyline(points: &[(f32, f32)], progress: f32) -> Vec<(f32, f32)> {
    let lengths: Vec<f32> = points
        .windows(2)
        .map(|w| ((w[1].0 - w[0].0).powi(2) + (w[1].1 - w[0].1).powi(2)).sqrt())
        .collect();
    let total: f32 = lengths.iter().sum();
    let mut remaining = total * progress.clamp(0., 1.);
    let mut out = vec![points[0]];
    for (i, len) in lengths.iter().enumerate() {
        if remaining >= *len {
            out.push(points[i + 1]);
            remaining -= len;
        } else {
            let t = if *len > 0. { remaining / len } else { 0. };
            let (a, b) = (points[i], points[i + 1]);
            out.push((a.0 + (b.0 - a.0) * t, a.1 + (b.1 - a.1) * t));
            break;
        }
    }
    out
}

impl NotesEditor {
    pub(crate) fn frame_prelude(&mut self, bounds: Bounds<Pixels>, window: &mut Window) -> bool {
        let width = f32::from(bounds.size.width);
        let padding = if width < f32::from(self.theme.narrow_breakpoint) {
            f32::from(self.theme.narrow_side_padding)
        } else {
            f32::from(self.theme.side_padding)
        };
        let column_width = (width - padding * 2.)
            .min(f32::from(self.theme.max_content_width))
            .max(60.);
        let geometry = Geometry {
            bounds,
            column_left: f32::from(bounds.left()) + (width - column_width) / 2.,
            column_width,
            top_padding: f32::from(self.theme.top_padding),
            bottom_padding: if self.fit {
                FIT_BOTTOM
            } else {
                f32::from(bounds.size.height) * self.theme.bottom_padding_ratio
            },
        };
        let mut drag_scroll = false;
        {
            let mut store = self.store.borrow_mut();
            let resized = store
                .geometry
                .is_none_or(|old| old.column_width != geometry.column_width);
            let first = store.geometry.is_none();
            let top_changed = store
                .geometry
                .is_some_and(|old| old.top_padding != geometry.top_padding);
            store.geometry = Some(geometry);
            if first {
                store.reset(self.editor.document(), &self.theme);
            } else if resized || top_changed {
                store.invalidate_all();
            }
            if self.drag.is_some()
                && !self.fit
                && let Some(p) = store.drag_point
            {
                let top = f32::from(bounds.top());
                let bottom = f32::from(bounds.bottom());
                let y = f32::from(p.y);
                let dy = if y < top {
                    -((top - y) * 0.4).clamp(2., 48.)
                } else if y > bottom {
                    ((y - bottom) * 0.4).clamp(2., 48.)
                } else {
                    0.
                };
                if dy != 0. {
                    let next = store.scroll_y() + dy;
                    store.set_scroll_y(next);
                    drag_scroll = true;
                }
            }
        }
        if drag_scroll {
            let point = self.store.borrow().drag_point;
            if let Some(point) = point {
                self.extend_drag(point, window);
            }
        }
        drag_scroll
    }
}

impl NotesEditor {
    /// Lay every block out at this width and say how tall the page is.
    pub(crate) fn measure_fit(&mut self, width: Pixels, window: &mut Window) -> f32 {
        let (origin, height) = self
            .store
            .borrow()
            .geometry
            .map_or((Point::default(), px(0.)), |g| {
                (g.bounds.origin, g.bounds.size.height)
            });
        self.frame_prelude(
            Bounds {
                origin,
                size: size(width, height),
            },
            window,
        );
        let marked: Option<(usize, Marked)> =
            self.composition.as_ref().map(|c| (c.block, c.marked()));
        let request = LayoutRequest {
            doc: self.editor.document(),
            theme: &self.theme,
            marked: marked.as_ref().map(|(b, m)| (*b, m)),
            hover: self.hover.link.as_ref().map(|l| (l.block, l.range.clone())),
        };
        let store = self.store.clone();
        let mut store = store.borrow_mut();
        // Heights only change for blocks whose text or width changed (those
        // are not measured); the rest keep their layout until painted.
        for index in 0..store.slots.len() {
            let slot = &store.slots[index];
            if !slot.measured || slot.layout.is_none() {
                store.ensure(index, &request, window);
            }
        }
        store.content_height()
    }
}

/// The blocks of a full-height page that the host's viewport shows.
fn fit_visible(
    store: &mut Store,
    request: &LayoutRequest<'_>,
    bounds: Bounds<Pixels>,
    mask: Bounds<Pixels>,
    window: &mut Window,
) -> std::ops::Range<usize> {
    let n = store.slots.len();
    if n == 0 {
        return 0..0;
    }
    for index in 0..n {
        let slot = &store.slots[index];
        if !slot.measured || slot.layout.is_none() {
            store.ensure(index, request, window);
        }
    }
    let from = f32::from(mask.top() - bounds.top());
    let to = f32::from(mask.bottom() - bounds.top());
    let top = store.top_padding();
    let start = if from <= top {
        0
    } else {
        store.heights.find(from - top).0.min(n - 1)
    };
    let mut end = start;
    while end < n && store.block_top(end) < to {
        store.ensure(end, request, window);
        end += 1;
    }
    start..end.max(start)
}

fn layout_pass(
    store: &mut Store,
    request: &LayoutRequest<'_>,
    window: &mut Window,
) -> std::ops::Range<usize> {
    let Some(geometry) = store.geometry else {
        return 0..0;
    };
    let n = store.slots.len();
    if n == 0 {
        return 0..0;
    }
    let scroll = store.scroll_y();
    let top = store.top_padding();
    let viewport = f32::from(geometry.bounds.size.height);
    let start = if scroll <= top {
        0
    } else {
        store.heights.find(scroll - top).0
    };
    let bottom = scroll + viewport;
    let mut index = start;
    while index < n {
        if store.block_top(index) >= bottom {
            break;
        }
        store.ensure(index, request, window);
        index += 1;
    }
    start..index
}

fn caret_extent(
    store: &mut Store,
    request: &LayoutRequest<'_>,
    pos: Pos,
    upstream: bool,
    window: &mut Window,
) -> Option<(f32, f32)> {
    store.ensure(pos.block, request, window);
    let gap = store.gap_of(request.doc, pos.block, request.theme);
    let top = store.block_top(pos.block) + gap;
    let layout = store.slots.get(pos.block)?.layout.as_ref()?;
    let caret = layout.caret(layout.to_virtual(pos.offset), upstream);
    let row_top = top + layout.metrics.pad_top + layout.rows[caret.row].top;
    Some((row_top, row_top + layout.metrics.line_height))
}

impl Element for NotesElement {
    type RequestLayoutState = ();
    type PrepaintState = Frame;

    fn id(&self) -> Option<ElementId> {
        None
    }

    fn source_location(&self) -> Option<&'static core::panic::Location<'static>> {
        None
    }

    fn request_layout(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&gpui::InspectorElementId>,
        window: &mut Window,
        cx: &mut App,
    ) -> (LayoutId, ()) {
        let mut style = Style::default();
        style.size.width = relative(1.).into();
        if self.view.read(cx).fit {
            let view = self.view.clone();
            let id = window.request_measured_layout(style, move |known, available, window, cx| {
                let width = known
                    .width
                    .or(match available.width {
                        AvailableSpace::Definite(width) => Some(width),
                        _ => None,
                    })
                    .unwrap_or(px(640.));
                let height = view.update(cx, |this, _| this.measure_fit(width, window));
                size(width, px(height))
            });
            return (id, ());
        }
        style.size.height = relative(1.).into();
        (window.request_layout(style, [], cx), ())
    }

    fn prepaint(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&gpui::InspectorElementId>,
        bounds: Bounds<Pixels>,
        _: &mut (),
        window: &mut Window,
        cx: &mut App,
    ) -> Frame {
        let now = Instant::now();
        let drag_scroll = self
            .view
            .update(cx, |this, _| this.frame_prelude(bounds, window));
        let hitbox = window.insert_hitbox(bounds, HitboxBehavior::Normal);
        let reduce_motion = cx.reduce_motion();
        let view = self.view.clone();
        let this = view.read(cx);
        let theme = &this.theme;
        let doc = this.editor.document();
        let marked: Option<(usize, Marked)> =
            this.composition.as_ref().map(|c| (c.block, c.marked()));
        let request = LayoutRequest {
            doc,
            theme,
            marked: marked.as_ref().map(|(b, m)| (*b, m)),
            hover: this.hover.link.as_ref().map(|l| (l.block, l.range.clone())),
        };
        let mut store = self.store.borrow_mut();
        let geometry = store.geometry.expect("geometry set in frame prelude");
        let viewport_height = f32::from(bounds.size.height);
        let selection = this.editor.selection();
        let head = match &this.composition {
            Some(c) => Pos::new(c.block, c.at),
            None => selection.head,
        };

        let fit = this.fit;
        let mask = window.content_mask().bounds;
        if fit {
            store.set_scroll_y(0.);
        }
        let mut visible = if fit {
            fit_visible(&mut store, &request, bounds, mask, window)
        } else {
            layout_pass(&mut store, &request, window)
        };
        if fit && let Some(target) = store.autoscroll.take() {
            let margin = f32::from(theme.body_size) * theme.body_line_height * 1.5;
            let pos = match target {
                Autoscroll::Caret => Some((head, this.upstream)),
                Autoscroll::Center(block, offset) => Some((Pos::new(block, offset), false)),
                Autoscroll::Block(index) => Some((Pos::new(index, 0), false)),
            };
            let extent = pos.and_then(|(pos, upstream)| {
                caret_extent(&mut store, &request, pos, upstream, window)
            });
            if let Some((top, bottom)) = extent {
                let top = f32::from(bounds.top()) + top;
                let bottom = f32::from(bounds.top()) + bottom;
                let (view_top, view_bottom) = (f32::from(mask.top()), f32::from(mask.bottom()));
                let delta = if top - margin < view_top {
                    top - margin - view_top
                } else if bottom + margin > view_bottom {
                    (bottom + margin - view_bottom).min(top - margin - view_top)
                } else {
                    0.
                };
                if delta.abs() > 0.5 {
                    store.fit_reveal = Some(delta);
                }
            }
        }
        if let Some(target) = store.autoscroll.take() {
            let scroll = store.scroll_y();
            let margin = (f32::from(theme.body_size) * theme.body_line_height * 1.5)
                .min(viewport_height / 4.);
            let wanted = match target {
                Autoscroll::Caret => {
                    caret_extent(&mut store, &request, head, this.upstream, window).map(
                        |(top, bottom)| {
                            if top - margin < scroll {
                                top - margin
                            } else if bottom + margin > scroll + viewport_height {
                                bottom + margin - viewport_height
                            } else {
                                scroll
                            }
                        },
                    )
                }
                Autoscroll::Block(index) => Some(store.block_top(index) - 12.),
                Autoscroll::Center(block, offset) => {
                    caret_extent(&mut store, &request, Pos::new(block, offset), false, window).map(
                        |(top, bottom)| {
                            if top - margin < scroll || bottom + margin > scroll + viewport_height {
                                (top + bottom) / 2. - viewport_height / 2.
                            } else {
                                scroll
                            }
                        },
                    )
                }
            };
            if let Some(wanted) = wanted
                && (wanted - scroll).abs() > 0.5
            {
                store.set_scroll_y(wanted);
                visible = layout_pass(&mut store, &request, window);
            }
        }
        if store.scroll_y() > store.max_scroll() + 0.5 {
            let max = store.max_scroll();
            store.set_scroll_y(max);
            visible = layout_pass(&mut store, &request, window);
        }
        let keep = [head.block, selection.anchor.block];
        if !fit {
            store.evict_far(visible.clone(), &keep);
        }

        let scroll = store.scroll_y();
        let focused = this.focus.is_focused(window);
        let active = window.is_window_active();
        let column_left = geometry.column_left;
        let column_width = geometry.column_width;
        let top = f32::from(bounds.top());

        let mut under = Vec::new();
        let mut over = Vec::new();
        let mut strokes = Vec::new();
        let mut lines = Vec::new();
        let mut numbers = Vec::new();
        let mut labels = Vec::new();
        let mut bands: Vec<Band> = Vec::new();
        let mut painted = Vec::with_capacity(visible.len());
        let mut animating = drag_scroll;
        let mut wake: Option<Instant> = None;

        let (sel_start, sel_end) = (selection.start(), selection.end());
        let selection_is_match = this.find.as_ref().is_some_and(|find| {
            find.current
                .and_then(|i| find.matches.get(i))
                .is_some_and(|found| {
                    sel_start == Pos::new(found.block, found.range.start)
                        && sel_end == Pos::new(found.block, found.range.end)
                })
        });
        let paint_selection = !selection.is_collapsed() && !selection_is_match;
        let find_matches = this.find.as_ref().map(|f| (&f.matches, f.current));
        let mut match_cursor = find_matches
            .map(|(matches, _)| matches.partition_point(|m| m.block < visible.start))
            .unwrap_or(0);
        let empty_doc = doc.blocks.len() == 1
            && doc.blocks[0].kind == BlockKind::Paragraph
            && doc.blocks[0].text.is_empty()
            && this.composition.is_none();
        // Someone is about to write into this empty page.
        let waiting_look = (!reduce_motion
            && empty_doc
            && store
                .reveal
                .as_ref()
                .is_some_and(|r| r.writing && r.first_text.is_none()))
        .then(crate::writing::look);
        let mut placeholder_key: Option<SharedString> = None;

        for index in visible.clone() {
            let block = &doc.blocks[index];
            let Some(layout) = store.slots[index].layout.as_ref() else {
                continue;
            };
            let m = layout.metrics;
            let gap =
                layout::gap_before(index.checked_sub(1).map(|p| &doc.blocks[p]), block, theme);
            let content_top = top + store.block_top(index) + gap - scroll;
            let text_top = content_top + m.pad_top;
            let text_left = column_left + m.inset;
            let lh = m.line_height;
            painted.push(Painted {
                index,
                top: content_top,
                text_left,
                text_top,
            });
            let glyph_top = (lh - layout.ascent - layout.descent) / 2. - 1.;
            let glyph_bottom = glyph_top + layout.ascent + layout.descent + 2.;

            match &block.kind {
                BlockKind::Code { .. } => under.push(quad(
                    rect(
                        column_left,
                        content_top,
                        column_left + column_width,
                        content_top + layout.content_height,
                    ),
                    theme.code_radius,
                    theme.code_fill,
                    px(0.),
                    transparent_black(),
                    Default::default(),
                )),
                BlockKind::Quote => {
                    let prev_quote = index > 0 && doc.blocks[index - 1].kind == BlockKind::Quote;
                    let next_quote = doc
                        .blocks
                        .get(index + 1)
                        .is_some_and(|b| b.kind == BlockKind::Quote);
                    let bar_top = if prev_quote {
                        content_top - gap
                    } else {
                        content_top
                    };
                    let w = f32::from(theme.quote_bar_width);
                    let r = px(w / 2.);
                    under.push(quad(
                        rect(
                            column_left,
                            bar_top,
                            column_left + w,
                            content_top + layout.content_height,
                        ),
                        Corners {
                            top_left: if prev_quote { px(0.) } else { r },
                            top_right: if prev_quote { px(0.) } else { r },
                            bottom_left: if next_quote { px(0.) } else { r },
                            bottom_right: if next_quote { px(0.) } else { r },
                        },
                        with_alpha(theme.accent, theme.quote_bar_alpha),
                        px(0.),
                        transparent_black(),
                        Default::default(),
                    ));
                }
                BlockKind::Rule => {
                    let caret_here = focused
                        && !this.read_only
                        && selection.is_collapsed()
                        && selection.head.block == index;
                    let thickness = if caret_here { 2. } else { 1. };
                    let mid = content_top + layout.content_height / 2.;
                    over.push(fill(
                        rect(
                            column_left,
                            mid - thickness / 2.,
                            column_left + column_width,
                            mid + thickness / 2.,
                        ),
                        if caret_here {
                            theme.accent
                        } else {
                            theme.separator
                        },
                    ));
                }
                _ => {}
            }

            for (range, kind) in &layout.decor {
                let (color, radius, pad) = match kind {
                    Decor::Highlight => (theme.highlight, theme.highlight_radius, 1.),
                    Decor::Code => (
                        theme.code_fill,
                        theme.inline_code_radius,
                        f32::from(theme.inline_code_padding),
                    ),
                    Decor::Mention => (theme.accent_alpha(0.12), px(4.), 2.),
                };
                for (x0, y0, x1, _) in layout.range_rects(range.clone()) {
                    under.push(quad(
                        rect(
                            text_left + x0 - pad,
                            text_top + y0 + glyph_top,
                            text_left + x1 + pad,
                            text_top + y0 + glyph_bottom,
                        ),
                        radius,
                        color,
                        px(0.),
                        transparent_black(),
                        Default::default(),
                    ));
                }
            }

            if let Some((matches, current)) = find_matches {
                while match_cursor < matches.len() && matches[match_cursor].block < index {
                    match_cursor += 1;
                }
                let mut cursor = match_cursor;
                while cursor < matches.len() && matches[cursor].block == index {
                    let found = &matches[cursor];
                    let color = if current == Some(cursor) {
                        theme.find_current
                    } else {
                        theme.find_match
                    };
                    let range =
                        layout.to_virtual(found.range.start)..layout.to_virtual(found.range.end);
                    for (x0, y0, x1, _) in layout.range_rects(range) {
                        under.push(quad(
                            rect(
                                text_left + x0 - 1.,
                                text_top + y0 + glyph_top,
                                text_left + x1 + 1.,
                                text_top + y0 + glyph_bottom,
                            ),
                            px(3.),
                            color,
                            px(0.),
                            transparent_black(),
                            Default::default(),
                        ));
                    }
                    cursor += 1;
                }
            }

            if paint_selection && index >= sel_start.block && index <= sel_end.block {
                selection_bands(
                    &mut bands,
                    BandInput {
                        layout,
                        rule: block.kind.is_rule(),
                        index,
                        start: sel_start,
                        end: sel_end,
                        text_left,
                        text_top,
                        content_top,
                        column_left,
                        column_width,
                    },
                );
            }

            for (line_index, _) in layout.lines.iter().enumerate() {
                let Some(first) = layout.rows.iter().find(|row| row.line == line_index) else {
                    continue;
                };
                let last = layout
                    .rows
                    .iter()
                    .rev()
                    .find(|row| row.line == line_index)
                    .copied()
                    .unwrap_or(*first);
                let y0 = text_top + first.top;
                let y1 = text_top + last.top + lh;
                if y1 < top - lh || y0 > top + viewport_height + lh {
                    continue;
                }
                lines.push((index, line_index, point(px(text_left), px(y0)), px(lh)));
            }

            if block.kind.is_list() {
                let baseline = text_top + layout.baseline(0);
                match block.kind {
                    BlockKind::Bullet => {
                        let cx_ = text_left - f32::from(theme.list_indent) / 2. - 1.;
                        let cy = baseline - layout.x_height / 2.;
                        let color = theme.ink_secondary;
                        match block.indent % 3 {
                            0 => over.push(quad(
                                rect(cx_ - 2.5, cy - 2.5, cx_ + 2.5, cy + 2.5),
                                px(2.5),
                                color,
                                px(0.),
                                transparent_black(),
                                Default::default(),
                            )),
                            1 => over.push(quad(
                                rect(cx_ - 2.5, cy - 2.5, cx_ + 2.5, cy + 2.5),
                                px(2.5),
                                transparent_black(),
                                px(1.1),
                                color,
                                Default::default(),
                            )),
                            _ => over.push(quad(
                                rect(cx_ - 2.25, cy - 2.25, cx_ + 2.25, cy + 2.25),
                                px(1.),
                                color,
                                px(0.),
                                transparent_black(),
                                Default::default(),
                            )),
                        }
                    }
                    BlockKind::Ordered => {
                        if let Some(number) = store.slots[index].ordinal {
                            numbers.push((
                                number,
                                point(px(text_left - 6.), px(text_top + layout.rows[0].top)),
                                px(lh),
                            ));
                        }
                    }
                    BlockKind::Task { checked } => {
                        let size_ = f32::from(theme.checkbox_size);
                        let cy = baseline - layout.cap_height / 2.;
                        let left = text_left - f32::from(theme.list_indent);
                        let box_top = cy - size_ / 2.;
                        let anim = this.checks.iter().find(|a| a.id == block.id);
                        let elapsed = anim.map(|a| now.saturating_duration_since(a.started));
                        if elapsed.is_some_and(|e| e < CHECK_DRAW) {
                            animating = true;
                        }
                        let fill_t = elapsed
                            .map_or(1., |e| ease_out(e.as_secs_f32() / CHECK_FILL.as_secs_f32()));
                        let draw_t = elapsed
                            .map_or(1., |e| ease_out(e.as_secs_f32() / CHECK_DRAW.as_secs_f32()));
                        let fill_alpha = if checked { fill_t } else { 1. - fill_t };
                        let bounds_ = rect(left, box_top, left + size_, box_top + size_);
                        if fill_alpha < 1. {
                            over.push(quad(
                                bounds_,
                                theme.checkbox_radius,
                                transparent_black(),
                                theme.checkbox_border,
                                theme.ink_tertiary,
                                Default::default(),
                            ));
                        }
                        if fill_alpha > 0. {
                            over.push(quad(
                                bounds_,
                                theme.checkbox_radius,
                                with_alpha(theme.accent, fill_alpha),
                                px(0.),
                                transparent_black(),
                                Default::default(),
                            ));
                        }
                        if checked {
                            let s = size_ / 16.;
                            let mark = [
                                (left + 4.3 * s, box_top + 8.4 * s),
                                (left + 7.0 * s, box_top + 11.0 * s),
                                (left + 11.8 * s, box_top + 5.4 * s),
                            ];
                            let partial = partial_polyline(&mark, draw_t);
                            stroke_polyline(
                                &partial,
                                1.8,
                                theme.check_mark,
                                &mut strokes,
                                &mut over,
                            );
                        }
                    }
                    _ => {}
                }
            }

            let heading_placeholder = matches!(block.kind, BlockKind::Heading(_))
                && block.text.is_empty()
                && focused
                && selection.is_collapsed()
                && selection.head.block == index
                && this.composition.is_none();
            let placeholder = if index == 0 && empty_doc && !this.placeholder.is_empty() {
                Some(this.placeholder.clone())
            } else if heading_placeholder {
                Some(this.labels.heading_placeholder.clone())
            } else {
                None
            };
            if let Some(text) = placeholder {
                // Sweep draws its line in full ink under a moving veil.
                let swept = index == 0 && waiting_look == Some(crate::writing::Look::Sweep);
                let key: SharedString =
                    format!("{}|{}|{}|{}", m.font_size, m.weight.0, swept, text).into();
                if index == 0 {
                    placeholder_key = Some(key.clone());
                }
                if !store.labels.contains_key(&key) {
                    let font = layout::body_font(theme, m.weight, false);
                    let run = TextRun {
                        len: text.len(),
                        font,
                        color: if swept {
                            theme.ink_secondary
                        } else {
                            theme.ink_tertiary
                        },
                        background_color: None,
                        underline: None,
                        strikethrough: None,
                    };
                    let shaped = window.text_system().shape_line(
                        text.clone(),
                        px(m.font_size),
                        &[run],
                        None,
                    );
                    store.labels.insert(key.clone(), shaped);
                }
                labels.push((key, point(px(text_left), px(text_top)), px(lh)));
            }
        }

        // People named in Cap's text sit on a soft pill in their colour, the
        // same badge the transcript shows; a click renames them.
        store.pills.clear();
        if !this.people.is_empty() {
            for p in &painted {
                let block = &doc.blocks[p.index];
                if block.origin != cap_notes::Origin::Generated || block.text.is_empty() {
                    continue;
                }
                let Some(layout) = store.slots[p.index].layout.as_ref() else {
                    continue;
                };
                let lh = layout.metrics.line_height;
                let mut found = Vec::new();
                for (name, color) in &this.people {
                    for range in crate::writing::name_ranges(&block.text, name) {
                        let virt = layout.to_virtual(range.start)..layout.to_virtual(range.end);
                        for (x0, y0, x1, _) in layout.range_rects(virt) {
                            let bounds = rect(
                                p.text_left + x0 - 4.,
                                p.text_top + y0 + 1.,
                                p.text_left + x1 + 4.,
                                p.text_top + y0 + lh - 1.,
                            );
                            under.push(quad(
                                bounds,
                                px(6.),
                                with_alpha(*color, 0.13),
                                px(0.),
                                transparent_black(),
                                Default::default(),
                            ));
                            found.push((bounds, name.clone()));
                        }
                    }
                }
                store.pills.extend(found);
            }
        }

        // Points whose source is known: the transcript time after the point
        // and, while hovered, a soft wash over it.
        store.source_hits.clear();
        for (mark_ix, mark) in this.sources.iter().enumerate() {
            let Some(p) = painted.iter().find(|p| p.index == mark.block) else {
                continue;
            };
            let Some(block) = doc.blocks.get(mark.block) else {
                continue;
            };
            if block.text.len() != mark.text_len || block.text.is_empty() {
                continue;
            }
            let Some(layout) = store.slots[mark.block].layout.as_ref() else {
                continue;
            };
            let lh = layout.metrics.line_height;
            let virt = layout.to_virtual(0)..layout.to_virtual(block.text.len());
            let rects: Vec<(f32, f32, f32, f32)> = layout.range_rects(virt);
            let Some(&(_, last_y, last_x, _)) = rects.last() else {
                continue;
            };
            let hover = this.source_hover.filter(|h| h.mark == mark_ix);
            if let Some(hover) = hover {
                let t = if reduce_motion {
                    1.
                } else {
                    let elapsed = now.saturating_duration_since(hover.since);
                    let t = elapsed.as_secs_f32() / SOURCE_FADE.as_secs_f32();
                    if t < 1. {
                        animating = true;
                    }
                    ease_out(t)
                };
                for &(x0, y0, x1, _) in &rects {
                    under.push(quad(
                        rect(
                            p.text_left + x0 - 5.,
                            p.text_top + y0 + 1.,
                            p.text_left + x1 + 5.,
                            p.text_top + y0 + lh - 1.,
                        ),
                        px(5.),
                        with_alpha(theme.accent, 0.12 * t),
                        px(0.),
                        transparent_black(),
                        Default::default(),
                    ));
                }
            }
            for &(x0, y0, x1, _) in &rects {
                store.source_hits.push((
                    rect(
                        p.text_left + x0,
                        p.text_top + y0,
                        p.text_left + x1,
                        p.text_top + y0 + lh,
                    ),
                    mark_ix,
                    false,
                ));
            }
            let key: SharedString = format!("\u{1}src {}", mark.label).into();
            if !store.labels.contains_key(&key) {
                let run = TextRun {
                    len: mark.label.len(),
                    font: Font {
                        weight: gpui::FontWeight::MEDIUM,
                        ..tabular_font(theme)
                    },
                    color: theme.accent,
                    background_color: None,
                    underline: None,
                    strikethrough: None,
                };
                let shaped = window.text_system().shape_line(
                    mark.label.clone(),
                    px((f32::from(theme.body_size) * 0.8).round()),
                    &[run],
                    None,
                );
                store.labels.insert(key.clone(), shaped);
            }
            let width = f32::from(store.labels[&key].width);
            // After the point's last word; when that line is full the time
            // may run into the margin beside it, never past the page.
            let x = p.text_left + last_x + 8.;
            if x + width <= f32::from(bounds.right()) - 4. {
                let y = p.text_top + last_y;
                labels.push((key, point(px(x), px(y)), px(lh)));
                store
                    .source_hits
                    .push((rect(x - 4., y, x + width + 4., y + lh), mark_ix, true));
            }
        }

        for (number, _, _) in &numbers {
            if !store.numbers.contains_key(number) {
                let text: SharedString = format!("{number}.").into();
                let run = TextRun {
                    len: text.len(),
                    font: tabular_font(theme),
                    color: theme.ink_secondary,
                    background_color: None,
                    underline: None,
                    strikethrough: None,
                };
                let shaped = window
                    .text_system()
                    .shape_line(text, theme.body_size, &[run], None);
                store.numbers.insert(*number, shaped);
            }
        }
        let numbers: Vec<(u32, Point<Pixels>, Pixels)> = numbers
            .into_iter()
            .map(|(number, origin, lh)| {
                let width = store.numbers.get(&number).map_or(px(0.), |l| l.width());
                (number, point(origin.x - width, origin.y), lh)
            })
            .collect();

        let mut selection_paths = Vec::new();
        for pair in 1..bands.len() {
            let next_top = bands[pair].y0;
            if next_top > bands[pair - 1].y1 && next_top - bands[pair - 1].y1 < 64. {
                bands[pair - 1].y1 = next_top;
            }
        }
        for region in outline::regions(&bands) {
            let points = outline::outline(&bands[region]);
            let segments = outline::rounded(&points, f32::from(theme.selection_radius));
            if let Some(path) = build_path(&segments) {
                selection_paths.push(path);
            }
        }
        let selection_color =
            if active && (focused || this.find.is_some() || this.link_edit.is_some()) {
                theme.selection
            } else {
                theme.ink_alpha(0.10)
            };

        let mut caret_quad = None;
        let show_caret = focused
            && active
            && !this.read_only
            && (selection.is_collapsed() || this.composition.is_some())
            && doc
                .blocks
                .get(head.block)
                .is_some_and(|b| !b.kind.is_rule());
        if show_caret
            && let Some(p) = painted.iter().find(|p| p.index == head.block).copied()
            && let Some(layout) = store.slots[head.block].layout.as_ref()
        {
            let virtual_offset = match &this.composition {
                Some(c) => c.at + c.caret,
                None => layout.to_virtual(head.offset),
            };
            let upstream = this.composition.is_none() && this.upstream;
            let caret = layout.caret(virtual_offset, upstream);
            let target_x = p.text_left + caret.x - column_left;
            let target_y = p.text_top + caret.top - top + scroll;
            // The caret sits where the text is, the moment it is painted. It
            // used to glide 70 ms to each new place: every keystroke started
            // a run of animation frames, so the next key waited for the
            // display's next refresh and the caret trailed the text.
            let (x, y) = (target_x, target_y);
            let (alpha, next) = blink(now.saturating_duration_since(this.caret_epoch));
            match next {
                Ok(delay) => wake = Some(now + delay),
                Err(()) => animating = true,
            }
            let w = f32::from(theme.caret_width);
            let x = column_left + x - w / 2.;
            let y = top + y - scroll;
            if alpha > 0.01 {
                caret_quad = Some(quad(
                    rect(x, y, x + w, y + caret.height),
                    px(w / 2.),
                    with_alpha(theme.accent, alpha),
                    px(0.),
                    transparent_black(),
                    Default::default(),
                ));
            }
        }

        let mut veils = Vec::new();
        let mut writer = None;
        if let Some(mut writing) = store.reveal.take() {
            if reduce_motion {
                writing.words.clear();
            }
            if writing.prune(now) {
                animating = true;
            }
            for word in &writing.words {
                let alpha = Reveal::veil(word, now);
                if alpha <= 0.001 {
                    continue;
                }
                let Some(p) = painted.iter().find(|p| p.index == word.block) else {
                    continue;
                };
                let Some(layout) = store.slots[word.block].layout.as_ref() else {
                    continue;
                };
                let lh = layout.metrics.line_height;
                let range = layout.to_virtual(word.start)..layout.to_virtual(word.end);
                for (x0, y0, x1, _) in layout.range_rects(range) {
                    // A block's first word also covers its bullet or box.
                    let left = if word.start == 0 && y0 < 0.5 {
                        column_left
                    } else {
                        p.text_left + x0 - 1.
                    };
                    veils.push(fill(
                        rect(
                            left,
                            p.text_top + y0,
                            p.text_left + x1 + 1.,
                            p.text_top + y0 + lh,
                        ),
                        with_alpha(theme.page, alpha),
                    ));
                }
            }
            let epoch = store.reveal_epoch.unwrap_or(now);
            let look = crate::writing::look();
            let waiting_phase = !reduce_motion && writing.writing && writing.first_text.is_none();
            let shown = if reduce_motion || (look == crate::writing::Look::Sweep && !empty_doc) {
                0.
            } else {
                writing.waiting(now, epoch)
            };
            if shown > 0. || waiting_phase {
                let first = painted.iter().find(|p| p.index == 0);
                if let (Some(p), Some(layout)) =
                    (first, store.slots.first().and_then(|s| s.layout.as_ref()))
                {
                    let label_width = placeholder_key
                        .as_ref()
                        .and_then(|k| store.labels.get(k))
                        .map_or(0., |l| f32::from(l.width));
                    let place = crate::writing::Place {
                        left: p.text_left,
                        width: column_width - (p.text_left - column_left),
                        top: p.text_top,
                        line_height: layout.metrics.line_height,
                        label_width,
                    };
                    let scene = crate::writing::scene(
                        look,
                        &place,
                        now.saturating_duration_since(epoch).as_secs_f32(),
                        shown,
                        theme.accent,
                        theme.ink_tertiary,
                        theme.page,
                    );
                    writer = Some(scene);
                }
                animating = true;
            }
            if !writing.finished(now, epoch) {
                store.reveal = Some(writing);
            }
        }

        let mut scrollbar = None;
        let content = store.content_height();
        if content > viewport_height + 1. {
            let since = store
                .scrollbar_activity
                .map(|t| now.saturating_duration_since(t).as_millis());
            let pinned = this.hover.scrollbar || store.scrollbar_drag.is_some();
            let alpha = match since {
                _ if pinned => 1.,
                Some(ms) if ms < SCROLLBAR_HOLD => 1.,
                Some(ms) if ms < SCROLLBAR_HOLD + SCROLLBAR_FADE => {
                    animating = true;
                    1. - (ms - SCROLLBAR_HOLD) as f32 / SCROLLBAR_FADE as f32
                }
                _ => 0.,
            };
            if alpha > 0. {
                let track_top = top + 3.;
                let track = viewport_height - 6.;
                let thumb = (viewport_height / content * track).max(28.).min(track);
                let max = store.max_scroll().max(1.);
                let thumb_top = track_top + (scroll / max).clamp(0., 1.) * (track - thumb);
                let width = if pinned { 8. } else { 6. };
                let x = f32::from(bounds.right()) - 3. - width;
                scrollbar = Some(quad(
                    rect(x, thumb_top, x + width, thumb_top + thumb),
                    px(width / 2.),
                    with_alpha(theme.scrollbar, alpha),
                    px(0.),
                    transparent_black(),
                    Default::default(),
                ));
            }
        }

        let cursor = if this.hover.scrollbar {
            CursorStyle::Arrow
        } else if this.hover.checkbox.is_some()
            || this.hover.link.is_some()
            || this.source_hover.is_some_and(|h| h.on_label)
        {
            CursorStyle::PointingHand
        } else {
            CursorStyle::IBeam
        };

        store.painted = painted;
        let anchors: Vec<Option<Bounds<Pixels>>> = self
            .popovers
            .iter()
            .map(|popover| anchor_rect(popover.anchor, &store, this, &geometry))
            .collect();
        drop(store);

        let margin = 8.;
        for (mut popover, anchor) in self.popovers.drain(..).zip(anchors) {
            let Some(anchor) = anchor else {
                continue;
            };
            let measured = popover.element.layout_as_root(
                size(AvailableSpace::MinContent, AvailableSpace::MinContent),
                window,
                cx,
            );
            let w = f32::from(measured.width.max(popover.size.width));
            let h = f32::from(measured.height.max(popover.size.height));
            let (mut x, mut y) = match popover.anchor {
                Anchor::SelectionTop => (
                    f32::from(anchor.left() + anchor.size.width / 2.) - w / 2.,
                    f32::from(anchor.top()) - h - 8.,
                ),
                Anchor::Point(_) => (f32::from(anchor.left()), f32::from(anchor.top()) + 2.),
                _ => (
                    f32::from(anchor.left()) - 6.,
                    f32::from(anchor.bottom()) + 6.,
                ),
            };
            if popover.anchor == Anchor::SelectionTop && y < top + margin {
                y = f32::from(anchor.bottom()) + 8.;
            }
            if y + h > f32::from(bounds.bottom()) - margin {
                let above = match popover.anchor {
                    Anchor::Point(_) => f32::from(anchor.top()) - h - 2.,
                    _ => f32::from(anchor.top()) - h - 6.,
                };
                if above >= top + margin {
                    y = above;
                }
            }
            x = x
                .min(f32::from(bounds.right()) - w - margin)
                .max(f32::from(bounds.left()) + margin);
            window.defer_draw(popover.element, point(px(x), px(y)), 1, None);
        }

        Frame {
            hitbox,
            under,
            selection: selection_paths,
            selection_color,
            lines,
            numbers,
            labels,
            over,
            strokes,
            veils,
            writer,
            caret: caret_quad,
            caret_drawn: false,
            scrollbar,
            cursor,
            animating,
            wake,
        }
    }

    fn paint(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&gpui::InspectorElementId>,
        bounds: Bounds<Pixels>,
        _: &mut (),
        frame: &mut Frame,
        window: &mut Window,
        cx: &mut App,
    ) {
        let focus = self.view.read(cx).focus.clone();
        window.handle_input(
            &focus,
            ElementInputHandler::new(bounds, self.view.clone()),
            cx,
        );
        window.set_cursor_style(frame.cursor, &frame.hitbox);

        window.with_content_mask(Some(ContentMask { bounds }), |window| {
            for q in frame.under.drain(..) {
                window.paint_quad(q);
            }
            for path in frame.selection.drain(..) {
                window.paint_path(path, frame.selection_color);
            }
            let store = self.store.borrow();
            for (block, line, origin, lh) in &frame.lines {
                if let Some(layout) = store.slots.get(*block).and_then(|s| s.layout.as_ref())
                    && let Some(line) = layout.lines.get(*line)
                {
                    line.paint(*origin, *lh, TextAlign::Left, None, window, cx)
                        .ok();
                }
            }
            for (number, origin, lh) in &frame.numbers {
                if let Some(shaped) = store.numbers.get(number) {
                    shaped
                        .paint(*origin, *lh, TextAlign::Left, None, window, cx)
                        .ok();
                }
            }
            for (key, origin, lh) in &frame.labels {
                if let Some(shaped) = store.labels.get(key) {
                    shaped
                        .paint(*origin, *lh, TextAlign::Left, None, window, cx)
                        .ok();
                }
            }
            drop(store);
            for q in frame.over.drain(..) {
                window.paint_quad(q);
            }
            for (path, color) in frame.strokes.drain(..) {
                window.paint_path(path, color);
            }
            for q in frame.veils.drain(..) {
                window.paint_quad(q);
            }
            if let Some(scene) = frame.writer.take() {
                for q in scene.quads {
                    window.paint_quad(q);
                }
                for (path, color) in scene.strokes {
                    window.paint_path(path, color);
                }
            }
            if let Some(caret) = frame.caret.take() {
                frame.caret_drawn = true;
                window.paint_quad(caret);
            }
            if let Some(thumb) = frame.scrollbar.take() {
                window.paint_quad(thumb);
            }
        });

        let hitbox = frame.hitbox.clone();
        let view = self.view.clone();
        window.on_mouse_event({
            let view = view.clone();
            let hitbox = hitbox.clone();
            move |event: &MouseDownEvent, phase, window, cx| {
                if phase == DispatchPhase::Bubble
                    && hitbox.is_hovered(window)
                    && matches!(event.button, MouseButton::Left | MouseButton::Right)
                {
                    view.update(cx, |this, cx| this.mouse_down(event, window, cx));
                }
            }
        });
        window.on_mouse_event({
            let view = view.clone();
            let hitbox = hitbox.clone();
            move |event: &MouseMoveEvent, phase, window, cx| {
                if phase == DispatchPhase::Bubble {
                    let hovered = hitbox.is_hovered(window);
                    view.update(cx, |this, cx| this.mouse_move(event, hovered, window, cx));
                }
            }
        });
        window.on_mouse_event({
            let view = view.clone();
            move |event: &MouseUpEvent, phase, window, cx| {
                if phase == DispatchPhase::Bubble {
                    view.update(cx, |this, cx| this.mouse_up(event, window, cx));
                }
            }
        });
        window.on_mouse_event({
            let view = view.clone();
            move |event: &ScrollWheelEvent, phase, window, cx| {
                if phase == DispatchPhase::Bubble
                    && hitbox.should_handle_scroll(window)
                    && !view.read(cx).fit
                {
                    view.update(cx, |this, cx| this.scroll_wheel(event, window, cx));
                }
            }
        });

        if frame.animating {
            window.request_animation_frame();
        } else if let Some(at) = frame.wake {
            view.update(cx, |this, cx| this.schedule_wake(at, cx));
        }

        let reveal = self.store.borrow_mut().fit_reveal.take();
        if let Some(delta) = reveal
            && let Some(host) = view.read(cx).reveal_host.clone()
        {
            cx.defer(move |cx| host(delta, cx));
        }
        let mut store = self.store.borrow_mut();
        let end = Instant::now();
        store.stats.animating = frame.animating;
        store.stats.caret = frame.caret_drawn;
        store.stats.frames += 1;
        store.stats.last_paint_end = Some(end);
        if let Some(start) = store.stats.render_started {
            store.stats.last_frame = end.saturating_duration_since(start);
        }
    }
}

struct BandInput<'a> {
    layout: &'a BlockLayout,
    rule: bool,
    index: usize,
    start: Pos,
    end: Pos,
    text_left: f32,
    text_top: f32,
    content_top: f32,
    column_left: f32,
    column_width: f32,
}

fn selection_bands(bands: &mut Vec<Band>, input: BandInput<'_>) {
    let BandInput {
        layout,
        rule,
        index,
        start,
        end,
        text_left,
        text_top,
        content_top,
        column_left,
        column_width,
    } = input;
    let continues = index < end.block;
    let from = if index == start.block {
        start.offset
    } else {
        0
    };
    let to = if index == end.block {
        end.offset
    } else {
        usize::MAX
    };
    if rule {
        if from == 0 && (continues || to > 0) {
            bands.push(Band {
                x0: column_left,
                x1: column_left + column_width,
                y0: content_top,
                y1: content_top + layout.content_height,
            });
        }
        return;
    }
    let from = layout.to_virtual(from);
    let to = if to == usize::MAX {
        usize::MAX
    } else {
        layout.to_virtual(to)
    };
    let last = layout.rows.len().saturating_sub(1);
    let lh = layout.metrics.line_height;
    for (row_index, row) in layout.rows.iter().enumerate() {
        let next_same_line = layout
            .rows
            .get(row_index + 1)
            .is_some_and(|next| next.line == row.line);
        if from > row.end || (from == row.end && next_same_line && from > row.start) {
            continue;
        }
        let passes = to > row.end || (row_index == last && continues);
        let lo = from.max(row.start);
        let hi = to.min(row.end);
        if !passes && hi <= lo {
            continue;
        }
        let mut spans = if from <= row.start && to >= row.end {
            vec![(0., row.width)]
        } else {
            layout.row_spans(row_index, lo..hi)
        };
        if passes {
            match spans.last_mut() {
                Some(last) if last.1 >= row.width - 0.5 => last.1 = last.1.max(last.0 + 5.),
                _ => {
                    let x0 = if from > row.start {
                        layout.x_in_row(from, row_index)
                    } else {
                        row.width
                    };
                    spans.push((x0.min(row.width), row.width.max(x0 + 5.)));
                }
            }
        }
        for (x0, x1) in spans {
            if x1 - x0 < 0.5 {
                continue;
            }
            bands.push(Band {
                x0: text_left + x0,
                x1: text_left + x1,
                y0: text_top + row.top,
                y1: text_top + row.top + lh,
            });
        }
    }
}

fn anchor_rect(
    anchor: Anchor,
    store: &Store,
    this: &NotesEditor,
    geometry: &Geometry,
) -> Option<Bounds<Pixels>> {
    let caret_rect = |pos: Pos, upstream: bool| -> Option<(Bounds<Pixels>, f32)> {
        let painted = store.painted(pos.block)?;
        let layout = store.slots.get(pos.block)?.layout.as_ref()?;
        let virtual_offset = match &this.composition {
            Some(c) if c.block == pos.block => c.at + c.caret,
            _ => layout.to_virtual(pos.offset),
        };
        let caret = layout.caret(virtual_offset, upstream);
        let row = layout.rows[caret.row];
        Some((
            rect(
                painted.text_left + caret.x,
                painted.text_top + row.top,
                painted.text_left + caret.x + 1.,
                painted.text_top + row.top + layout.metrics.line_height,
            ),
            painted.text_left + row.width,
        ))
    };
    let selection = this.editor.selection();
    let bounds = geometry.bounds;
    let visible = |r: Bounds<Pixels>| r.bottom() >= bounds.top() && r.top() <= bounds.bottom();
    match anchor {
        Anchor::SelectionBelow => {
            let end = caret_rect(selection.end(), false)
                .or_else(|| caret_rect(selection.head, this.upstream))?;
            Some(end.0).filter(|r| visible(*r))
        }
        Anchor::SelectionTop => {
            let (start, row_right) = caret_rect(selection.start(), false)?;
            let end = caret_rect(selection.end(), true);
            let right = match end {
                Some((end, _)) if end.top() == start.top() => f32::from(end.left()),
                _ => row_right,
            };
            let left = f32::from(start.left());
            let r = rect(
                left,
                f32::from(start.top()),
                right.max(left + 1.),
                f32::from(start.bottom()),
            );
            Some(r).filter(|r| visible(*r))
        }
        Anchor::Point(p) => Some(Bounds::new(p, size(px(1.), px(1.)))),
        Anchor::Below(pos) => caret_rect(pos, false)
            .map(|(r, _)| r)
            .filter(|r| visible(*r)),
    }
}
