//! Text that keeps its shaping between frames.
//!
//! GPUI keeps a shaped line only while consecutive frames draw it. A view that
//! comes back after a frame away (the Library's list and magazine toggle, a
//! section switch) shapes every string it shows again, and with a full page of
//! cards that shaping is most of the frame. [`KeptText`] measures, wraps,
//! clamps, truncates and paints exactly like a plain string child: it reads the
//! same inherited text style and runs the same steps as GPUI's `TextLayout`.
//! It only looks the shaped lines up in a [`TextCache`] the view owns first.

use std::{borrow::Cow, cell::RefCell, collections::HashMap, rc::Rc};

use gpui::{
    App, AvailableSpace, Bounds, Element, ElementId, Font, GlobalElementId, InspectorElementId,
    IntoElement, LayoutId, Pixels, SharedString, Size, TextOverflow, TruncateFrom, WhiteSpace,
    Window, WrappedLine,
};
use smallvec::SmallVec;

/// Lines kept before the least recently drawn half is dropped.
const KEEP: usize = 1024;

type Lines = Rc<SmallVec<[WrappedLine; 1]>>;

#[derive(Clone, PartialEq, Eq, Hash)]
struct Key {
    text: SharedString,
    font: Font,
    font_size: u32,
    color: [u32; 4],
    wrap_width: Option<u32>,
    truncate: Option<(u32, SharedString, u8)>,
    line_clamp: Option<usize>,
}

struct Entry {
    lines: Lines,
    used: u64,
}

/// Shaped lines one view keeps across frames. Call [`TextCache::next_frame`]
/// once per render of the owning view.
#[derive(Default)]
pub struct TextCache {
    lines: HashMap<Key, Entry>,
    frame: u64,
}

pub type SharedTextCache = Rc<RefCell<TextCache>>;

impl TextCache {
    pub fn shared() -> SharedTextCache {
        Rc::new(RefCell::new(Self::default()))
    }

    pub fn next_frame(&mut self) {
        self.frame += 1;
        if self.lines.len() <= KEEP {
            return;
        }
        // Keep the KEEP / 2 most recently drawn; ties at the cut go first come.
        let mut used: Vec<u64> = self.lines.values().map(|e| e.used).collect();
        let cut = used.len() - KEEP / 2;
        let (_, threshold, newer) = used.select_nth_unstable(cut);
        let threshold = *threshold;
        let mut room = KEEP / 2 - newer.iter().filter(|u| **u > threshold).count();
        self.lines.retain(|_, e| {
            if e.used > threshold {
                return true;
            }
            if e.used == threshold && room > 0 {
                room -= 1;
                return true;
            }
            false
        });
    }

    #[cfg(test)]
    fn len(&self) -> usize {
        self.lines.len()
    }

    fn get(&mut self, key: &Key) -> Option<Lines> {
        let frame = self.frame;
        self.lines.get_mut(key).map(|e| {
            e.used = frame;
            e.lines.clone()
        })
    }

    fn insert(&mut self, key: Key, lines: Lines) {
        let used = self.frame;
        self.lines.insert(key, Entry { lines, used });
    }
}

pub struct KeptText {
    text: SharedString,
    cache: SharedTextCache,
}

pub fn kept_text(cache: &SharedTextCache, text: impl Into<SharedString>) -> KeptText {
    KeptText {
        text: text.into(),
        cache: cache.clone(),
    }
}

impl IntoElement for KeptText {
    type Element = Self;

    fn into_element(self) -> Self::Element {
        self
    }
}

struct Measured {
    lines: Lines,
    line_height: Pixels,
    wrap_width: Option<Pixels>,
    truncate_width: Option<Pixels>,
    size: Size<Pixels>,
}

#[derive(Default, Clone)]
pub struct KeptTextState(Rc<RefCell<Option<Measured>>>);

fn bits(px: Pixels) -> u32 {
    f32::from(px).to_bits()
}

fn definite(space: AvailableSpace) -> Option<Pixels> {
    match space {
        AvailableSpace::Definite(x) => Some(x),
        _ => None,
    }
}

impl Element for KeptText {
    type RequestLayoutState = KeptTextState;
    type PrepaintState = Option<Bounds<Pixels>>;

    fn id(&self) -> Option<ElementId> {
        None
    }

    fn source_location(&self) -> Option<&'static std::panic::Location<'static>> {
        None
    }

    fn request_layout(
        &mut self,
        _id: Option<&GlobalElementId>,
        _inspector_id: Option<&InspectorElementId>,
        window: &mut Window,
        _cx: &mut App,
    ) -> (LayoutId, Self::RequestLayoutState) {
        let text_style = window.text_style();
        let font_size = text_style.font_size.to_pixels(window.rem_size());
        let line_height = window.pixel_snap(
            text_style
                .line_height
                .to_pixels(font_size.into(), window.rem_size()),
        );
        let run = text_style.to_run(self.text.len());
        // Only plain runs are kept: the key has no room for decorations.
        let keepable = run.background_color.is_none()
            && run.underline.is_none()
            && run.strikethrough.is_none();
        let state = KeptTextState::default();
        let layout_id = window.request_measured_layout(Default::default(), {
            let state = state.clone();
            let text = self.text.clone();
            let cache = self.cache.clone();
            move |known_dimensions, available_space, window, cx| {
                let wrap_width = if text_style.white_space == WhiteSpace::Normal {
                    known_dimensions.width.or(definite(available_space.width))
                } else {
                    None
                };
                let (truncate_width, affix, truncate_from) = match text_style.text_overflow.clone()
                {
                    Some(overflow) => {
                        let width = known_dimensions.width.or(match available_space.width {
                            AvailableSpace::Definite(x) => match text_style.line_clamp {
                                Some(max_lines) => Some(x * max_lines),
                                None => Some(x),
                            },
                            _ => None,
                        });
                        match overflow {
                            TextOverflow::Truncate(s) => (width, s, TruncateFrom::End),
                            TextOverflow::TruncateStart(s) => (width, s, TruncateFrom::Start),
                            TextOverflow::TruncateMiddle(s) => (width, s, TruncateFrom::Middle),
                        }
                    }
                    None => (None, SharedString::default(), TruncateFrom::End),
                };

                // The same early answer GPUI's text gives a repeated probe.
                if let Some(measured) = state.0.borrow().as_ref()
                    && (wrap_width.is_none() || wrap_width == measured.wrap_width)
                    && truncate_width.is_none()
                    && measured.truncate_width.is_none()
                {
                    return measured.size;
                }

                let key = keepable.then(|| Key {
                    text: text.clone(),
                    font: run.font.clone(),
                    font_size: bits(font_size),
                    color: [
                        run.color.h.to_bits(),
                        run.color.s.to_bits(),
                        run.color.l.to_bits(),
                        run.color.a.to_bits(),
                    ],
                    wrap_width: wrap_width.map(bits),
                    truncate: truncate_width.map(|w| {
                        let from = match truncate_from {
                            TruncateFrom::Start => 0,
                            TruncateFrom::End => 1,
                            TruncateFrom::Middle => 2,
                        };
                        (bits(w), affix.clone(), from)
                    }),
                    line_clamp: text_style.line_clamp,
                });
                let kept = key.as_ref().and_then(|k| cache.borrow_mut().get(k));
                let lines = match kept {
                    Some(lines) => lines,
                    None => {
                        let runs = [run.clone()];
                        let mut line_wrapper =
                            cx.text_system().line_wrapper(run.font.clone(), font_size);
                        let (shaped_text, shaped_runs) =
                            if let Some(truncate_width) = truncate_width {
                                if let Some(max_lines) = text_style.line_clamp
                                    && let Some(wrap_width) = wrap_width
                                {
                                    line_wrapper.truncate_wrapped_line(
                                        text.clone(),
                                        wrap_width,
                                        max_lines,
                                        &affix,
                                        &runs,
                                        truncate_from,
                                    )
                                } else if let Ok(unclipped) = window.text_system().shape_text(
                                    text.clone(),
                                    font_size,
                                    &runs,
                                    None,
                                    None,
                                ) && unclipped
                                    .iter()
                                    .all(|line| line.size(line_height).width <= truncate_width)
                                {
                                    (text.clone(), Cow::Borrowed(&runs[..]))
                                } else {
                                    line_wrapper.truncate_line(
                                        text.clone(),
                                        truncate_width,
                                        &affix,
                                        &runs,
                                        truncate_from,
                                    )
                                }
                            } else {
                                (text.clone(), Cow::Borrowed(&runs[..]))
                            };
                        let lines: Lines = Rc::new(
                            window
                                .text_system()
                                .shape_text(
                                    shaped_text,
                                    font_size,
                                    &shaped_runs,
                                    wrap_width,
                                    text_style.line_clamp,
                                )
                                .unwrap_or_default(),
                        );
                        if let Some(key) = key {
                            cache.borrow_mut().insert(key, lines.clone());
                        }
                        lines
                    }
                };

                let mut size: Size<Pixels> = Size::default();
                for line in lines.iter() {
                    let line_size = line.size(line_height);
                    size.height += line_size.height;
                    size.width = size.width.max(line_size.width).ceil();
                }
                state.0.borrow_mut().replace(Measured {
                    lines,
                    line_height,
                    wrap_width,
                    truncate_width,
                    size,
                });
                size
            }
        });
        (layout_id, state)
    }

    fn prepaint(
        &mut self,
        _id: Option<&GlobalElementId>,
        _inspector_id: Option<&InspectorElementId>,
        bounds: Bounds<Pixels>,
        _state: &mut Self::RequestLayoutState,
        _window: &mut Window,
        _cx: &mut App,
    ) -> Self::PrepaintState {
        Some(bounds)
    }

    fn paint(
        &mut self,
        _id: Option<&GlobalElementId>,
        _inspector_id: Option<&InspectorElementId>,
        _bounds: Bounds<Pixels>,
        state: &mut Self::RequestLayoutState,
        bounds: &mut Self::PrepaintState,
        window: &mut Window,
        cx: &mut App,
    ) {
        let Some(bounds) = *bounds else {
            return;
        };
        let measured = state.0.borrow();
        let Some(measured) = measured.as_ref() else {
            return;
        };
        let line_height = measured.line_height;
        let align = window.text_style().text_align;
        let mut origin = bounds.origin;
        for line in measured.lines.iter() {
            line.paint_background(origin, line_height, align, Some(bounds), window, cx)
                .ok();
            line.paint(origin, line_height, align, Some(bounds), window, cx)
                .ok();
            origin.y += line.size(line_height).height;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(text: &str) -> Key {
        Key {
            text: SharedString::from(text.to_string()),
            font: gpui::font("Test"),
            font_size: 13,
            color: [0; 4],
            wrap_width: None,
            truncate: None,
            line_clamp: None,
        }
    }

    #[test]
    fn the_cache_drops_the_least_recently_drawn_half_once_full() {
        let mut cache = TextCache::default();
        for i in 0..KEEP {
            cache.insert(key(&format!("old {i}")), Lines::default());
        }
        cache.next_frame();
        assert_eq!(cache.len(), KEEP, "nothing goes while there is room");
        assert!(cache.get(&key("old 7")).is_some());
        cache.insert(key("new"), Lines::default());
        cache.next_frame();
        assert!(cache.len() <= KEEP / 2 + 2, "len {}", cache.len());
        assert!(cache.get(&key("new")).is_some());
        assert!(cache.get(&key("old 7")).is_some());
    }
}
