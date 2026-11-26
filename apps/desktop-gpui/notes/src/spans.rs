use std::ops::Range;

use crate::model::{Block, Mark, Span};
use crate::unicode::floor_char;

#[derive(Clone, Debug, Default, PartialEq, Eq, Hash)]
pub struct MarkSet(Vec<Mark>);

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Run {
    pub range: Range<usize>,
    pub marks: MarkSet,
}

impl MarkSet {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn contains(&self, mark: &Mark) -> bool {
        self.0.binary_search(mark).is_ok()
    }

    pub fn contains_kind(&self, mark: &Mark) -> bool {
        self.0.iter().any(|m| m.kind_eq(mark))
    }

    pub fn insert(&mut self, mark: Mark) {
        if mark.is_exclusive() {
            self.0.retain(|m| !m.is_exclusive());
        }
        if let Err(index) = self.0.binary_search(&mark) {
            self.0.insert(index, mark);
        }
    }

    pub fn remove(&mut self, mark: &Mark) {
        self.0.retain(|m| m != mark);
    }

    pub fn remove_kind(&mut self, mark: &Mark) {
        self.0.retain(|m| !m.kind_eq(mark));
    }

    pub fn toggle(&mut self, mark: Mark) {
        if self.contains(&mark) {
            self.remove(&mark);
        } else {
            self.insert(mark);
        }
    }

    pub fn iter(&self) -> impl Iterator<Item = &Mark> {
        self.0.iter()
    }

    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    pub fn len(&self) -> usize {
        self.0.len()
    }

    pub fn link(&self) -> Option<&str> {
        self.0.iter().find_map(|mark| match mark {
            Mark::Link { url } => Some(url.as_str()),
            _ => None,
        })
    }

    pub(crate) fn intersect(&mut self, other: &MarkSet) {
        self.0.retain(|mark| other.contains(mark));
    }
}

impl FromIterator<Mark> for MarkSet {
    fn from_iter<T: IntoIterator<Item = Mark>>(iter: T) -> Self {
        let mut set = MarkSet::new();
        for mark in iter {
            set.insert(mark);
        }
        set
    }
}

pub(crate) fn normalize_spans(text: &str, spans: &mut Vec<Span>) {
    for span in spans.iter_mut() {
        let start = floor_char(text, span.range.start);
        let end = floor_char(text, span.range.end);
        span.range = start..end.max(start);
    }
    spans.retain(|span| !span.range.is_empty());
    spans.sort_by(|a, b| a.mark.cmp(&b.mark).then(a.range.start.cmp(&b.range.start)));
    let mut merged: Vec<Span> = Vec::with_capacity(spans.len());
    for span in spans.drain(..) {
        if let Some(last) = merged.last_mut()
            && last.mark == span.mark
            && span.range.start <= last.range.end
        {
            last.range.end = last.range.end.max(span.range.end);
            continue;
        }
        merged.push(span);
    }
    merged.sort_by(|a, b| {
        a.range
            .start
            .cmp(&b.range.start)
            .then(a.range.end.cmp(&b.range.end))
            .then(a.mark.cmp(&b.mark))
    });
    let mut exclusive_end = 0;
    let mut result: Vec<Span> = Vec::with_capacity(merged.len());
    for mut span in merged {
        if span.mark.is_exclusive() {
            span.range.start = span.range.start.max(exclusive_end);
            if span.range.is_empty() {
                continue;
            }
            exclusive_end = span.range.end;
        }
        result.push(span);
    }
    result.sort_by(|a, b| {
        a.range
            .start
            .cmp(&b.range.start)
            .then(a.range.end.cmp(&b.range.end))
            .then(a.mark.cmp(&b.mark))
    });
    *spans = result;
}

pub(crate) fn is_normalized(text: &str, spans: &[Span]) -> bool {
    let mut copy = spans.to_vec();
    normalize_spans(text, &mut copy);
    copy == spans
        && spans.iter().all(|span| {
            span.range.end <= text.len()
                && text.is_char_boundary(span.range.start)
                && text.is_char_boundary(span.range.end)
        })
}

fn map_delete(p: usize, range: &Range<usize>) -> usize {
    if p <= range.start {
        p
    } else if p >= range.end {
        p - (range.end - range.start)
    } else {
        range.start
    }
}

pub(crate) fn delete_spans(spans: &mut Vec<Span>, range: Range<usize>) {
    if range.is_empty() {
        return;
    }
    for span in spans.iter_mut() {
        span.range = map_delete(span.range.start, &range)..map_delete(span.range.end, &range);
    }
    spans.retain(|span| !span.range.is_empty());
}

pub(crate) fn shift_for_insert(spans: &mut [Span], offset: usize, len: usize) {
    for span in spans.iter_mut() {
        if span.range.start >= offset {
            span.range.start += len;
        }
        if span.range.end > offset {
            span.range.end += len;
        }
    }
}

pub(crate) fn split_spans(spans: &[Span], offset: usize) -> (Vec<Span>, Vec<Span>) {
    let mut left = Vec::new();
    let mut right = Vec::new();
    for span in spans {
        if span.range.start < offset {
            left.push(Span {
                range: span.range.start..span.range.end.min(offset),
                mark: span.mark.clone(),
            });
        }
        if span.range.end > offset {
            right.push(Span {
                range: span.range.start.max(offset) - offset..span.range.end - offset,
                mark: span.mark.clone(),
            });
        }
    }
    (left, right)
}

pub(crate) fn carve(spans: &mut Vec<Span>, range: Range<usize>, matches: impl Fn(&Mark) -> bool) {
    if range.is_empty() {
        return;
    }
    let mut out = Vec::with_capacity(spans.len() + 1);
    for span in spans.drain(..) {
        let overlaps = span.range.start < range.end && span.range.end > range.start;
        if !overlaps || !matches(&span.mark) {
            out.push(span);
            continue;
        }
        if span.range.start < range.start {
            out.push(Span {
                range: span.range.start..range.start,
                mark: span.mark.clone(),
            });
        }
        if span.range.end > range.end {
            out.push(Span {
                range: range.end..span.range.end,
                mark: span.mark,
            });
        }
    }
    *spans = out;
}

pub(crate) fn marks_covering(spans: &[Span], range: Range<usize>) -> MarkSet {
    let mut set = MarkSet::new();
    for span in spans {
        let covers = if range.is_empty() {
            span.range.start <= range.start && range.start < span.range.end
        } else {
            span.range.start <= range.start && span.range.end >= range.end
        };
        if covers {
            set.0.push(span.mark.clone());
        }
    }
    set.0.sort();
    set.0.dedup();
    set
}

impl Block {
    pub fn runs(&self) -> Vec<Run> {
        let len = self.text.len();
        if len == 0 {
            return Vec::new();
        }
        let mut cuts = vec![0, len];
        for span in &self.spans {
            cuts.push(span.range.start.min(len));
            cuts.push(span.range.end.min(len));
        }
        cuts.sort_unstable();
        cuts.dedup();
        cuts.windows(2)
            .map(|pair| Run {
                range: pair[0]..pair[1],
                marks: marks_covering(&self.spans, pair[0]..pair[1]),
            })
            .collect()
    }

    pub fn marks_at(&self, offset: usize) -> MarkSet {
        marks_covering(&self.spans, offset..offset)
    }

    pub fn insertion_marks(&self, offset: usize) -> MarkSet {
        if !self.kind.takes_marks() {
            return MarkSet::new();
        }
        let offset = offset.min(self.text.len());
        let mut set = MarkSet::new();
        for span in &self.spans {
            let inside = span.range.start < offset && offset < span.range.end;
            let at_end = offset > 0 && span.range.end == offset && span.mark.extends_at_end();
            let at_start = offset == 0 && span.range.start == 0 && span.mark.extends_at_end();
            if inside || at_end || at_start {
                set.insert(span.mark.clone());
            }
        }
        set
    }

    pub(crate) fn insert_text_at(&mut self, offset: usize, text: &str, marks: &MarkSet) {
        let offset = floor_char(&self.text, offset);
        if text.is_empty() {
            return;
        }
        self.text.insert_str(offset, text);
        if !self.kind.takes_marks() {
            self.spans.clear();
            return;
        }
        let range = offset..offset + text.len();
        shift_for_insert(&mut self.spans, offset, text.len());
        carve(&mut self.spans, range.clone(), |mark| !marks.contains(mark));
        for mark in marks.iter() {
            self.spans.push(Span {
                range: range.clone(),
                mark: mark.clone(),
            });
        }
        normalize_spans(&self.text, &mut self.spans);
    }

    pub(crate) fn delete_text(&mut self, range: Range<usize>) {
        let start = floor_char(&self.text, range.start);
        let end = floor_char(&self.text, range.end).max(start);
        if start == end {
            return;
        }
        self.text.replace_range(start..end, "");
        delete_spans(&mut self.spans, start..end);
        normalize_spans(&self.text, &mut self.spans);
    }

    pub(crate) fn split_off_at(&mut self, offset: usize) -> (String, Vec<Span>) {
        let offset = floor_char(&self.text, offset);
        let tail = self.text.split_off(offset);
        let (left, right) = split_spans(&self.spans, offset);
        self.spans = left;
        normalize_spans(&self.text, &mut self.spans);
        (tail, right)
    }

    pub(crate) fn append(&mut self, text: &str, spans: &[Span]) {
        let shift = self.text.len();
        if self.kind.is_code() {
            self.text.push_str(text);
            return;
        }
        if text.contains(['\n', '\r']) {
            self.text.push_str(&text.replace(['\n', '\r'], " "));
        } else {
            self.text.push_str(text);
        }
        if self.kind.takes_marks() {
            self.spans.extend(spans.iter().map(|span| Span {
                range: span.range.start + shift..span.range.end + shift,
                mark: span.mark.clone(),
            }));
            normalize_spans(&self.text, &mut self.spans);
        }
    }

    pub(crate) fn add_mark(&mut self, range: Range<usize>, mark: Mark) {
        if !self.kind.takes_marks() || range.is_empty() {
            return;
        }
        if mark.is_exclusive() {
            carve(&mut self.spans, range.clone(), Mark::is_exclusive);
        }
        self.spans.push(Span { range, mark });
        normalize_spans(&self.text, &mut self.spans);
    }

    pub(crate) fn remove_mark(&mut self, range: Range<usize>, matches: impl Fn(&Mark) -> bool) {
        carve(&mut self.spans, range, matches);
        normalize_spans(&self.text, &mut self.spans);
    }

    pub(crate) fn has_mark_over(&self, range: Range<usize>, mark: &Mark) -> bool {
        if range.is_empty() {
            return false;
        }
        let mut covered = range.start;
        let mut relevant: Vec<&Span> = self.spans.iter().filter(|s| &s.mark == mark).collect();
        relevant.sort_by_key(|s| s.range.start);
        for span in relevant {
            if span.range.start > covered {
                break;
            }
            covered = covered.max(span.range.end);
            if covered >= range.end {
                return true;
            }
        }
        covered >= range.end
    }
}
