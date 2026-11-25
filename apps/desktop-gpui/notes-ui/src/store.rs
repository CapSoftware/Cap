use std::collections::HashMap;
use std::time::{Duration, Instant};

use cap_notes::{BlockKind, Document};
use gpui::{Bounds, Pixels, Point, ShapedLine, SharedString, Window};

use crate::heights::HeightIndex;
use crate::layout::{self, BlockLayout, LayoutKey, Marked, ShapeInput};
use crate::theme::NotesTheme;

const LIVE_LAYOUT_BUDGET: usize = 1500;
const EVICTION_MARGIN: usize = 200;

#[derive(Default)]
pub(crate) struct Slot {
    pub layout: Option<BlockLayout>,
    pub content: f32,
    pub measured: bool,
    pub ordinal: Option<u32>,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct Geometry {
    pub bounds: Bounds<Pixels>,
    pub column_left: f32,
    pub column_width: f32,
    pub top_padding: f32,
    pub bottom_padding: f32,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct Painted {
    pub index: usize,
    pub top: f32,
    pub text_left: f32,
    pub text_top: f32,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) enum Autoscroll {
    Caret,
    Block(usize),
    Center(usize, usize),
}

#[derive(Default, Clone, Copy, Debug)]
pub struct FrameStats {
    pub frames: u64,
    pub render_started: Option<Instant>,
    pub last_paint_end: Option<Instant>,
    pub last_frame: Duration,
    pub shaped_blocks: u64,
    pub painted_blocks: usize,
    pub live_layouts: usize,
    /// The last frame asked for another one straight away.
    pub animating: bool,
    /// The last frame drew the caret.
    pub caret: bool,
}

#[derive(Default)]
pub(crate) struct Store {
    pub slots: Vec<Slot>,
    pub heights: HeightIndex,
    pub anchor: (usize, f32),
    pub geometry: Option<Geometry>,
    pub epoch: u64,
    pub live_layouts: usize,
    pub numbers: HashMap<u32, ShapedLine>,
    pub labels: HashMap<SharedString, ShapedLine>,
    /// Where this frame drew people's name pills, for clicks.
    pub pills: Vec<(gpui::Bounds<gpui::Pixels>, String)>,
    /// Where this frame drew points with a known source: the area, the
    /// mark and whether it is the timestamp.
    pub source_hits: Vec<(gpui::Bounds<gpui::Pixels>, usize, bool)>,
    /// A scroll the host should make to keep the caret in view (fit mode).
    pub fit_reveal: Option<f32>,
    pub painted: Vec<Painted>,
    pub scrollbar_activity: Option<Instant>,
    pub scrollbar_drag: Option<f32>,
    pub autoscroll: Option<Autoscroll>,
    pub drag_point: Option<Point<Pixels>>,
    pub stats: FrameStats,
    /// Text someone else is writing in: its fading words and waiting motion.
    pub reveal: Option<crate::reveal::Reveal>,
    pub reveal_epoch: Option<Instant>,
}

pub(crate) struct LayoutRequest<'a> {
    pub doc: &'a Document,
    pub theme: &'a NotesTheme,
    pub marked: Option<(usize, &'a Marked)>,
    pub hover: Option<(usize, std::ops::Range<usize>)>,
}

impl Store {
    pub fn reset(&mut self, doc: &Document, theme: &NotesTheme) {
        let width = self.wrap_basis();
        self.slots = doc
            .blocks
            .iter()
            .map(|block| Slot {
                layout: None,
                content: layout::estimate_height(block, theme, width),
                measured: false,
                ordinal: None,
            })
            .collect();
        self.live_layouts = 0;
        self.rebuild_heights(doc, theme);
        self.refresh_ordinals(doc, 0, doc.blocks.len());
        self.anchor = (0, -self.top_padding());
    }

    fn wrap_basis(&self) -> f32 {
        self.geometry.map_or(560., |g| g.column_width)
    }

    pub fn top_padding(&self) -> f32 {
        self.geometry.map_or(28., |g| g.top_padding)
    }

    pub fn rebuild_heights(&mut self, doc: &Document, theme: &NotesTheme) {
        let gaps = (0..doc.blocks.len()).map(|i| {
            layout::gap_before(
                i.checked_sub(1).map(|p| &doc.blocks[p]),
                &doc.blocks[i],
                theme,
            )
        });
        self.heights = HeightIndex::from_values(
            gaps.zip(self.slots.iter())
                .map(|(gap, slot)| gap + slot.content),
        );
    }

    fn gap(doc: &Document, index: usize, theme: &NotesTheme) -> f32 {
        layout::gap_before(
            index.checked_sub(1).and_then(|p| doc.blocks.get(p)),
            &doc.blocks[index],
            theme,
        )
    }

    pub fn gap_of(&self, doc: &Document, index: usize, theme: &NotesTheme) -> f32 {
        Self::gap(doc, index, theme)
    }

    pub fn splice(
        &mut self,
        start: usize,
        removed: usize,
        inserted: usize,
        doc: &Document,
        theme: &NotesTheme,
    ) {
        let start = start.min(self.slots.len());
        let end = (start + removed).min(self.slots.len());
        let width = self.wrap_basis();
        let dropped = self.slots[start..end]
            .iter()
            .filter(|slot| slot.layout.is_some())
            .count();
        self.live_layouts = self.live_layouts.saturating_sub(dropped);
        let fresh = (start..start + inserted).map(|i| {
            let block = &doc.blocks[i];
            Slot {
                layout: None,
                content: layout::estimate_height(block, theme, width),
                measured: false,
                ordinal: None,
            }
        });
        self.slots.splice(start..end, fresh);
        let values: Vec<f32> = (start..start + inserted)
            .map(|i| Self::gap(doc, i, theme) + self.slots[i].content)
            .collect();
        self.heights.splice(start..end, values);
        let next = start + inserted;
        if next < self.slots.len() {
            let value = Self::gap(doc, next, theme) + self.slots[next].content;
            self.heights.set(next, value);
        }
        let (anchor, offset) = self.anchor;
        if anchor >= end {
            self.anchor = (anchor - (end - start) + inserted, offset);
        } else if anchor >= start {
            self.anchor = (
                start.min(self.slots.len().saturating_sub(1)),
                offset.min(0.),
            );
        }
        self.refresh_ordinals(doc, start, start + inserted + 1);
    }

    pub fn refresh_ordinals(&mut self, doc: &Document, from: usize, dirty_end: usize) {
        let blocks = &doc.blocks;
        let mut start = from.min(blocks.len());
        while start > 0 && blocks[start - 1].kind.is_list() {
            start -= 1;
        }
        let mut counters = [None::<u32>; 9];
        let mut depth_len = 0usize;
        let mut index = start;
        while index < blocks.len() {
            let block = &blocks[index];
            if !block.kind.is_list() {
                depth_len = 0;
                self.slots[index].ordinal = None;
                if index >= dirty_end {
                    break;
                }
                index += 1;
                continue;
            }
            let depth = (block.indent as usize).min(counters.len() - 1);
            for counter in counters.iter_mut().take(depth_len).skip(depth + 1) {
                *counter = None;
            }
            for counter in counters.iter_mut().take(depth + 1).skip(depth_len) {
                *counter = None;
            }
            depth_len = depth + 1;
            let value = if block.kind == BlockKind::Ordered {
                let value = match (block.start, counters[depth]) {
                    (Some(start), _) => start,
                    (None, Some(prev)) => prev.saturating_add(1),
                    (None, None) => 1,
                };
                counters[depth] = Some(value);
                Some(value)
            } else {
                counters[depth] = None;
                None
            };
            self.slots[index].ordinal = value;
            index += 1;
        }
    }

    pub fn invalidate_all(&mut self) {
        for slot in &mut self.slots {
            slot.measured = false;
        }
        self.numbers.clear();
        self.labels.clear();
    }

    pub fn block_top(&self, index: usize) -> f32 {
        self.top_padding() + self.heights.prefix(index)
    }

    pub fn scroll_y(&self) -> f32 {
        self.block_top(self.anchor.0) + self.anchor.1
    }

    pub fn content_height(&self) -> f32 {
        let bottom = self.geometry.map_or(0., |g| g.bottom_padding);
        self.top_padding() + self.heights.total() + bottom
    }

    pub fn max_scroll(&self) -> f32 {
        let viewport = self
            .geometry
            .map_or(0., |g| f32::from(g.bounds.size.height));
        (self.content_height() - viewport).max(0.)
    }

    pub fn set_scroll_y(&mut self, y: f32) {
        let y = y.clamp(0., self.max_scroll().max(0.));
        let top = self.top_padding();
        if y < top || self.slots.is_empty() {
            self.anchor = (0, y - top);
        } else {
            self.anchor = self.heights.find(y - top);
        }
    }

    pub fn wrap_width(&self, index: usize, doc: &Document, theme: &NotesTheme) -> f32 {
        let m = layout::metrics(&doc.blocks[index], theme);
        (self.wrap_basis() - m.inset - m.inset_right).max(24.)
    }

    pub fn key_for(&self, index: usize, request: &LayoutRequest<'_>) -> LayoutKey {
        let wrap = self.wrap_width(index, request.doc, request.theme);
        LayoutKey {
            wrap_width: wrap.to_bits(),
            epoch: self.epoch,
            marked: request
                .marked
                .filter(|(block, _)| *block == index)
                .map(|(_, marked)| marked.clone()),
            hover: request
                .hover
                .clone()
                .filter(|(block, _)| *block == index)
                .map(|(_, range)| range),
        }
    }

    pub fn ensure(
        &mut self,
        index: usize,
        request: &LayoutRequest<'_>,
        window: &mut Window,
    ) -> bool {
        if index >= self.slots.len() {
            return false;
        }
        let key = self.key_for(index, request);
        if self.slots[index]
            .layout
            .as_ref()
            .is_some_and(|layout| layout.key == key)
        {
            return false;
        }
        let wrap_width = f32::from_bits(key.wrap_width);
        let shaped = layout::shape(
            ShapeInput {
                block: &request.doc.blocks[index],
                theme: request.theme,
                key,
                wrap_width,
            },
            window,
        );
        self.stats.shaped_blocks += 1;
        let content = shaped.content_height;
        let slot = &mut self.slots[index];
        if slot.layout.is_none() {
            self.live_layouts += 1;
        }
        slot.layout = Some(shaped);
        slot.measured = true;
        if slot.content != content {
            slot.content = content;
            let value = Self::gap(request.doc, index, request.theme) + content;
            self.heights.set(index, value);
        }
        true
    }

    pub fn evict_far(&mut self, visible: std::ops::Range<usize>, keep: &[usize]) {
        if self.live_layouts <= LIVE_LAYOUT_BUDGET {
            return;
        }
        let lo = visible.start.saturating_sub(EVICTION_MARGIN);
        let hi = visible.end + EVICTION_MARGIN;
        let mut live = 0;
        for (index, slot) in self.slots.iter_mut().enumerate() {
            if slot.layout.is_none() {
                continue;
            }
            if (lo..hi).contains(&index) || keep.contains(&index) {
                live += 1;
            } else {
                slot.layout = None;
            }
        }
        self.live_layouts = live;
    }

    pub fn painted(&self, index: usize) -> Option<Painted> {
        self.painted
            .binary_search_by(|painted| painted.index.cmp(&index))
            .ok()
            .map(|i| self.painted[i])
    }
}
