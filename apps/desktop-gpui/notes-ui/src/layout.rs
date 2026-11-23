use std::ops::Range;

use cap_notes::{Block, BlockKind, Mark, MarkSet, Origin};
use gpui::{
    Font, FontFallbacks, FontFeatures, FontStyle, FontWeight, Hsla, LineLayout, SharedString,
    StrikethroughStyle, TextRun, UnderlineStyle, Window, WrappedLine, px,
};
use unicode_segmentation::UnicodeSegmentation;

use crate::theme::NotesTheme;

#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct BlockMetrics {
    pub font_size: f32,
    pub line_height: f32,
    pub inset: f32,
    pub inset_right: f32,
    pub pad_top: f32,
    pub pad_bottom: f32,
    pub mono: bool,
    pub weight: FontWeight,
}

pub(crate) fn metrics(block: &Block, theme: &NotesTheme) -> BlockMetrics {
    let body = f32::from(theme.body_size);
    let body_line = (body * theme.body_line_height).round();
    let plain = BlockMetrics {
        font_size: body,
        line_height: body_line,
        inset: 0.,
        inset_right: 0.,
        pad_top: 0.,
        pad_bottom: 0.,
        mono: false,
        weight: FontWeight::NORMAL,
    };
    match &block.kind {
        BlockKind::Heading(level) => {
            let index = (*level).clamp(1, 3) as usize - 1;
            let size = f32::from(theme.heading_sizes[index]);
            BlockMetrics {
                font_size: size,
                line_height: (size * theme.heading_line_height).round(),
                weight: FontWeight::SEMIBOLD,
                ..plain
            }
        }
        BlockKind::Bullet | BlockKind::Ordered | BlockKind::Task { .. } => BlockMetrics {
            inset: f32::from(theme.list_indent) * (block.indent as f32 + 1.),
            ..plain
        },
        BlockKind::Quote => BlockMetrics {
            inset: f32::from(theme.quote_inset),
            ..plain
        },
        BlockKind::Code { .. } => {
            let size = f32::from(theme.code_size);
            BlockMetrics {
                font_size: size,
                line_height: (size * theme.code_line_height).round(),
                inset: f32::from(theme.code_padding_x),
                inset_right: f32::from(theme.code_padding_x),
                pad_top: f32::from(theme.code_padding_y),
                pad_bottom: f32::from(theme.code_padding_y),
                mono: true,
                weight: FontWeight::NORMAL,
            }
        }
        BlockKind::Rule => BlockMetrics {
            line_height: 1. + 2. * f32::from(theme.rule_margin),
            ..plain
        },
        BlockKind::Paragraph | BlockKind::Unknown { .. } => plain,
    }
}

pub(crate) fn gap_before(prev: Option<&Block>, block: &Block, theme: &NotesTheme) -> f32 {
    let Some(prev) = prev else {
        return 0.;
    };
    if let BlockKind::Heading(level) = block.kind {
        return f32::from(theme.heading_space_above[(level.clamp(1, 3) - 1) as usize]);
    }
    if let BlockKind::Heading(level) = prev.kind {
        return f32::from(theme.heading_space_below[(level.clamp(1, 3) - 1) as usize]);
    }
    if prev.kind.is_list() && block.kind.is_list() {
        return f32::from(theme.list_spacing);
    }
    if prev.kind.is_code() || block.kind.is_code() {
        return f32::from(theme.code_spacing);
    }
    f32::from(theme.block_spacing)
}

pub(crate) fn body_font(theme: &NotesTheme, weight: FontWeight, italic: bool) -> Font {
    Font {
        family: theme.body_font.clone(),
        features: FontFeatures::default(),
        fallbacks: None,
        weight,
        style: if italic {
            FontStyle::Italic
        } else {
            FontStyle::Normal
        },
    }
}

pub(crate) fn mono_font(theme: &NotesTheme, weight: FontWeight, italic: bool) -> Font {
    let family = theme
        .mono_fonts
        .first()
        .cloned()
        .unwrap_or_else(|| "Menlo".into());
    let fallbacks = (theme.mono_fonts.len() > 1).then(|| {
        FontFallbacks::from_fonts(
            theme.mono_fonts[1..]
                .iter()
                .map(|name| name.to_string())
                .collect(),
        )
    });
    Font {
        family,
        features: FontFeatures::default(),
        fallbacks,
        weight,
        style: if italic {
            FontStyle::Italic
        } else {
            FontStyle::Normal
        },
    }
}

pub(crate) fn tabular_font(theme: &NotesTheme) -> Font {
    Font {
        features: FontFeatures(std::sync::Arc::new(vec![("tnum".into(), 1)])),
        ..body_font(theme, FontWeight::NORMAL, false)
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Marked {
    pub at: usize,
    pub text: String,
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct LayoutKey {
    pub wrap_width: u32,
    pub epoch: u64,
    pub marked: Option<Marked>,
    pub hover: Option<Range<usize>>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Decor {
    Highlight,
    Code,
    Mention,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct Row {
    pub start: usize,
    pub end: usize,
    pub line: usize,
    pub x0: f32,
    pub width: f32,
    pub top: f32,
}

pub(crate) struct BlockLayout {
    pub key: LayoutKey,
    pub text: SharedString,
    pub lines: Vec<WrappedLine>,
    pub line_starts: Vec<usize>,
    pub rows: Vec<Row>,
    pub metrics: BlockMetrics,
    pub content_height: f32,
    pub ascent: f32,
    pub descent: f32,
    pub x_height: f32,
    pub cap_height: f32,
    pub decor: Vec<(Range<usize>, Decor)>,
    pub marked: Option<(usize, usize)>,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct Caret {
    pub x: f32,
    pub top: f32,
    pub height: f32,
    pub row: usize,
}

impl BlockLayout {
    pub fn text_height(&self) -> f32 {
        self.rows.len().max(1) as f32 * self.metrics.line_height
    }

    pub fn to_virtual(&self, offset: usize) -> usize {
        match self.marked {
            Some((at, len)) if offset >= at => offset + len,
            _ => offset,
        }
    }

    pub fn to_real(&self, offset: usize) -> usize {
        match self.marked {
            Some((at, len)) if offset >= at + len => offset - len,
            Some((at, _)) if offset > at => at,
            _ => offset,
        }
    }

    pub fn row_of(&self, offset: usize, upstream: bool) -> usize {
        let index = match self.rows.binary_search_by(|row| row.start.cmp(&offset)) {
            Ok(index) => {
                let mut index = index;
                while index + 1 < self.rows.len() && self.rows[index + 1].start == offset {
                    index += 1;
                }
                index
            }
            Err(0) => 0,
            Err(index) => index - 1,
        };
        if upstream
            && index > 0
            && self.rows[index].start == offset
            && self.rows[index - 1].line == self.rows[index].line
        {
            index - 1
        } else {
            index
        }
    }

    pub fn x_in_row(&self, offset: usize, row: usize) -> f32 {
        let Some(row) = self.rows.get(row) else {
            return 0.;
        };
        let Some(line) = self.lines.get(row.line) else {
            return 0.;
        };
        let offset = offset.clamp(row.start, row.end);
        if offset == row.start {
            return 0.;
        }
        let local = offset - self.line_starts[row.line];
        (caret_x(&line.unwrapped_layout, local) - row.x0).clamp(0., row.width)
    }

    pub fn baseline(&self, row: usize) -> f32 {
        let top = self.rows.get(row).map_or(0., |row| row.top);
        top + (self.metrics.line_height - self.ascent - self.descent) / 2. + self.ascent
    }

    pub fn caret(&self, offset: usize, upstream: bool) -> Caret {
        let row = self.row_of(offset, upstream);
        let baseline = self.baseline(row);
        Caret {
            x: self.x_in_row(offset, row),
            top: baseline - self.ascent,
            height: self.ascent + self.descent,
            row,
        }
    }

    pub fn hit(&self, x: f32, y: f32) -> (usize, bool) {
        if self.rows.is_empty() {
            return (0, false);
        }
        let row_index = if y <= 0. {
            0
        } else {
            ((y / self.metrics.line_height) as usize).min(self.rows.len() - 1)
        };
        self.hit_row(row_index, x)
    }

    pub fn hit_row(&self, row_index: usize, x: f32) -> (usize, bool) {
        let Some(row) = self.rows.get(row_index).copied() else {
            return (0, false);
        };
        let slice = self.text.get(row.start..row.end).unwrap_or_default();
        let mut best = row.start;
        let mut best_distance = f32::MAX;
        let consider = |offset: usize, best: &mut usize, best_distance: &mut f32| {
            let distance = (self.x_in_row(offset, row_index) - x).abs();
            if distance < *best_distance {
                *best_distance = distance;
                *best = offset;
            }
        };
        for (index, _) in slice.grapheme_indices(true) {
            consider(row.start + index, &mut best, &mut best_distance);
        }
        consider(row.end, &mut best, &mut best_distance);
        let continues = self
            .rows
            .get(row_index + 1)
            .is_some_and(|next| next.line == row.line);
        (best, best == row.end && continues)
    }

    /// Horizontal spans, relative to the row start, of the glyphs in `range`.
    /// Right-to-left runs reorder glyphs visually, so one logical range can
    /// cover several separate spans on a row.
    pub fn row_spans(&self, row_index: usize, range: Range<usize>) -> Vec<(f32, f32)> {
        let mut spans: Vec<(f32, f32)> = Vec::new();
        let Some(row) = self.rows.get(row_index) else {
            return spans;
        };
        let Some(line) = self.lines.get(row.line) else {
            return spans;
        };
        let base = self.line_starts[row.line];
        let width = f32::from(line.unwrapped_layout.width);
        let mut glyphs = line
            .unwrapped_layout
            .runs
            .iter()
            .flat_map(|run| run.glyphs.iter())
            .map(|glyph| (glyph.index + base, f32::from(glyph.position.x)))
            .peekable();
        let row_end = row.x0 + row.width;
        while let Some((index, x)) = glyphs.next() {
            let right = glyphs.peek().map_or(width, |next| next.1);
            if x < row.x0 - 0.01 || x >= row_end - 0.01 || index < row.start || index >= row.end {
                continue;
            }
            if index < range.start || index >= range.end {
                continue;
            }
            let (x0, x1) = (x - row.x0, right.min(row_end) - row.x0);
            match spans.last_mut() {
                Some(last) if (last.1 - x0).abs() < 0.5 => last.1 = x1,
                _ => spans.push((x0, x1)),
            }
        }
        spans
    }

    pub fn range_rects(&self, range: Range<usize>) -> Vec<(f32, f32, f32, f32)> {
        let mut out = Vec::new();
        for (index, row) in self.rows.iter().enumerate() {
            if range.start.max(row.start) >= range.end.min(row.end) {
                continue;
            }
            for (x0, x1) in self.row_spans(index, range.clone()) {
                out.push((x0, row.top, x1, row.top + self.metrics.line_height));
            }
        }
        out
    }
}

/// gpui's `LineLayout::x_for_index` assumes glyphs run left to right, which
/// puts the caret on the wrong edge of every right-to-left glyph. A boundary
/// sits on the leading edge of the glyph that starts there: its left side in a
/// left-to-right run, its right side in a right-to-left one.
pub(crate) fn caret_x(line: &LineLayout, index: usize) -> f32 {
    let width = f32::from(line.width);
    let glyphs = || {
        line.runs
            .iter()
            .flat_map(|run| run.glyphs.iter())
            .map(|glyph| (glyph.index, f32::from(glyph.position.x)))
    };
    let mut before: Option<(usize, f32)> = None;
    let mut best: Option<((usize, f32), bool, f32)> = None;
    let mut iter = glyphs().peekable();
    while let Some(here) = iter.next() {
        let next = iter.peek().copied();
        let rtl = next.is_some_and(|n| n.0 < here.0) || before.is_some_and(|b| b.0 > here.0);
        let right = next.map_or(width, |n| n.1);
        if here.0 == index {
            return if rtl { right } else { here.1 };
        }
        if here.0 < index && best.is_none_or(|(b, _, _)| here.0 > b.0) {
            best = Some((here, rtl, right));
        }
        before = Some(here);
    }
    match best {
        Some((here, true, _)) => here.1,
        Some((_, false, right)) => right,
        None => glyphs().next().map_or(0., |glyph| glyph.1),
    }
}

pub(crate) struct ShapeInput<'a> {
    pub block: &'a Block,
    pub theme: &'a NotesTheme,
    pub key: LayoutKey,
    pub wrap_width: f32,
}

struct Style {
    color: Hsla,
    strike_all: bool,
}

fn block_style(block: &Block, theme: &NotesTheme) -> Style {
    let checked = matches!(block.kind, BlockKind::Task { checked: true });
    let color = if checked {
        theme.ink_tertiary
    } else if block.origin == Origin::Generated || block.kind == BlockKind::Quote {
        theme.ink_secondary
    } else {
        theme.ink
    };
    Style {
        color,
        strike_all: checked,
    }
}

fn run_for(
    len: usize,
    marks: &MarkSet,
    m: &BlockMetrics,
    style: &Style,
    theme: &NotesTheme,
    hovered: bool,
) -> TextRun {
    let mut weight = m.weight;
    let mut italic = false;
    let mut code = m.mono;
    let mut color = style.color;
    let mut underline = None;
    let mut strikethrough = style.strike_all.then_some(StrikethroughStyle {
        thickness: px(1.),
        color: Some(style.color),
    });
    for mark in marks.iter() {
        match mark {
            Mark::Bold => {
                weight = if m.weight == FontWeight::NORMAL {
                    FontWeight::SEMIBOLD
                } else {
                    FontWeight::BOLD
                }
            }
            Mark::Italic => italic = true,
            Mark::Underline => {
                underline = Some(UnderlineStyle {
                    thickness: px(1.),
                    color: Some(color),
                    wavy: false,
                })
            }
            Mark::Strike => {
                strikethrough = Some(StrikethroughStyle {
                    thickness: px(1.),
                    color: Some(color),
                })
            }
            Mark::Code => code = true,
            Mark::Highlight | Mark::Unknown { .. } => {}
            Mark::Link { .. } => {
                color = theme.accent;
                let alpha = if hovered {
                    1.
                } else {
                    theme.link_underline_alpha
                };
                underline = Some(UnderlineStyle {
                    thickness: px(1.),
                    color: Some(theme.accent_alpha(alpha)),
                    wavy: false,
                });
            }
            Mark::Mention { .. } => {
                color = theme.accent;
                weight = FontWeight(weight.0.max(FontWeight::MEDIUM.0));
            }
        }
    }
    if let Some(strike) = strikethrough.as_mut() {
        strike.color = Some(color);
    }
    if let Some(line) = underline.as_mut()
        && !marks.iter().any(|mark| matches!(mark, Mark::Link { .. }))
    {
        line.color = Some(color);
    }
    let font = if code {
        mono_font(theme, weight, italic)
    } else {
        body_font(theme, weight, italic)
    };
    TextRun {
        len,
        font,
        color,
        background_color: None,
        underline,
        strikethrough,
    }
}

pub(crate) fn shape(input: ShapeInput<'_>, window: &mut Window) -> BlockLayout {
    let ShapeInput {
        block,
        theme,
        key,
        wrap_width,
    } = input;
    let m = metrics(block, theme);
    let style = block_style(block, theme);
    let base_font = if m.mono {
        mono_font(theme, m.weight, false)
    } else {
        body_font(theme, m.weight, false)
    };
    let font_id = window.text_system().resolve_font(&base_font);
    let font_ascent = f32::from(window.text_system().ascent(font_id, px(m.font_size)));
    let font_descent = f32::from(window.text_system().descent(font_id, px(m.font_size))).abs();
    let x_height = f32::from(window.text_system().x_height(font_id, px(m.font_size)));
    let cap_height = f32::from(window.text_system().cap_height(font_id, px(m.font_size)));

    if block.kind.is_rule() {
        return BlockLayout {
            key,
            text: SharedString::default(),
            lines: Vec::new(),
            line_starts: vec![0],
            rows: vec![Row {
                start: 0,
                end: 0,
                line: 0,
                x0: 0.,
                width: wrap_width,
                top: 0.,
            }],
            metrics: m,
            content_height: m.line_height,
            ascent: font_ascent,
            descent: font_descent,
            x_height,
            cap_height,
            decor: Vec::new(),
            marked: None,
        };
    }

    let marked = key.marked.clone();
    let text: SharedString = match &marked {
        Some(marked) => {
            let at = crate::editor::floor_char_boundary(&block.text, marked.at);
            let mut virtual_text = String::with_capacity(block.text.len() + marked.text.len());
            virtual_text.push_str(&block.text[..at]);
            virtual_text.push_str(&marked.text);
            virtual_text.push_str(&block.text[at..]);
            virtual_text.into()
        }
        None => block.text.clone().into(),
    };
    let marked_span = marked.as_ref().map(|marked| {
        (
            crate::editor::floor_char_boundary(&block.text, marked.at),
            marked.text.len(),
        )
    });

    let mut runs: Vec<TextRun> = Vec::new();
    let mut decor: Vec<(Range<usize>, Decor)> = Vec::new();
    let shift = |offset: usize| match marked_span {
        Some((at, len)) if offset >= at => offset + len,
        _ => offset,
    };
    let empty = MarkSet::new();
    let block_runs = block.runs();
    let mut push_real = |range: Range<usize>, marks: &MarkSet, runs: &mut Vec<TextRun>| {
        if range.is_empty() {
            return;
        }
        let hovered = key
            .hover
            .as_ref()
            .is_some_and(|hover| hover.start <= range.start && range.end <= hover.end);
        runs.push(run_for(range.len(), marks, &m, &style, theme, hovered));
        for mark in marks.iter() {
            let kind = match mark {
                Mark::Highlight => Decor::Highlight,
                Mark::Code if !m.mono => Decor::Code,
                Mark::Mention { .. } => Decor::Mention,
                _ => continue,
            };
            let span = shift(range.start)..shift(range.end);
            match decor.last_mut() {
                Some((last, last_kind)) if *last_kind == kind && last.end == span.start => {
                    last.end = span.end;
                }
                _ => decor.push((span, kind)),
            }
        }
    };
    let mut marked_pushed = false;
    for run in &block_runs {
        let marks = if block.kind.takes_marks() {
            &run.marks
        } else {
            &empty
        };
        match marked_span {
            Some((at, len)) if !marked_pushed && run.range.start <= at && at <= run.range.end => {
                push_real(run.range.start..at, marks, &mut runs);
                let mut marked_run = run_for(len, marks, &m, &style, theme, false);
                marked_run.underline = Some(UnderlineStyle {
                    thickness: px(1.),
                    color: Some(marked_run.color),
                    wavy: false,
                });
                if len > 0 {
                    runs.push(marked_run);
                }
                marked_pushed = true;
                push_real(at..run.range.end, marks, &mut runs);
            }
            _ => push_real(run.range.clone(), marks, &mut runs),
        }
    }
    if let Some((_, len)) = marked_span
        && !marked_pushed
        && len > 0
    {
        let mut marked_run = run_for(len, &empty, &m, &style, theme, false);
        marked_run.underline = Some(UnderlineStyle {
            thickness: px(1.),
            color: Some(marked_run.color),
            wavy: false,
        });
        runs.push(marked_run);
    }
    if runs.is_empty() {
        runs.push(run_for(0, &empty, &m, &style, theme, false));
    }

    let lines: Vec<WrappedLine> = window
        .text_system()
        .shape_text(
            text.clone(),
            px(m.font_size),
            &runs,
            Some(px(wrap_width.max(1.))),
            None,
        )
        .map(|lines| lines.into_iter().collect())
        .unwrap_or_default();

    let mut line_starts = Vec::with_capacity(lines.len().max(1));
    line_starts.push(0);
    for (index, ch) in text.char_indices() {
        if ch == '\n' {
            line_starts.push(index + 1);
        }
    }

    let mut rows = Vec::new();
    for (line_index, line) in lines.iter().enumerate() {
        let base = line_starts.get(line_index).copied().unwrap_or(text.len());
        let total_width = f32::from(line.unwrapped_layout.width);
        let glyph_runs = line.runs();
        let mut starts: Vec<(usize, f32)> = vec![(0, 0.)];
        for boundary in line.wrap_boundaries() {
            if let Some(glyph) = glyph_runs
                .get(boundary.run_ix)
                .and_then(|run| run.glyphs.get(boundary.glyph_ix))
            {
                starts.push((glyph.index, f32::from(glyph.position.x)));
            }
        }
        for (k, &(start, x0)) in starts.iter().enumerate() {
            let (end, x1) = starts
                .get(k + 1)
                .copied()
                .unwrap_or((line.len(), total_width));
            rows.push(Row {
                start: base + start,
                end: base + end,
                line: line_index,
                x0,
                width: (x1 - x0).max(0.),
                top: rows.len() as f32 * m.line_height,
            });
        }
    }
    if rows.is_empty() {
        rows.push(Row {
            start: 0,
            end: 0,
            line: 0,
            x0: 0.,
            width: 0.,
            top: 0.,
        });
    }

    let (ascent, descent) = lines
        .first()
        .filter(|line| line.len() > 0)
        .map(|line| (f32::from(line.ascent()), f32::from(line.descent()).abs()))
        .unwrap_or((font_ascent, font_descent));

    let content_height = rows.len() as f32 * m.line_height + m.pad_top + m.pad_bottom;
    BlockLayout {
        key,
        text,
        lines,
        line_starts,
        rows,
        metrics: m,
        content_height,
        ascent,
        descent,
        x_height,
        cap_height,
        decor,
        marked: marked_span,
    }
}

pub(crate) fn estimate_height(block: &Block, theme: &NotesTheme, wrap_width: f32) -> f32 {
    let m = metrics(block, theme);
    if block.kind.is_rule() {
        return m.line_height;
    }
    let per_line = (wrap_width.max(40.) / (m.font_size * 0.5)).max(1.);
    let rows: f32 = if m.mono {
        block
            .text
            .split('\n')
            .map(|line| (line.chars().count() as f32 / per_line).ceil().max(1.))
            .sum()
    } else {
        (block.text.chars().count() as f32 / per_line)
            .ceil()
            .max(1.)
    };
    rows * m.line_height + m.pad_top + m.pad_bottom
}

#[cfg(test)]
mod tests {
    use super::*;
    use gpui::{FontId, GlyphId, ShapedGlyph, ShapedRun, point};

    fn line(glyphs: &[(usize, f32)], width: f32) -> LineLayout {
        LineLayout {
            font_size: px(10.),
            width: px(width),
            ascent: px(8.),
            descent: px(2.),
            runs: vec![ShapedRun {
                font_id: FontId(0),
                glyphs: glyphs
                    .iter()
                    .map(|(index, x)| ShapedGlyph {
                        id: GlyphId(1),
                        position: point(px(*x), px(0.)),
                        index: *index,
                        is_emoji: false,
                    })
                    .collect(),
            }],
            len: glyphs.iter().map(|g| g.0).max().map_or(0, |m| m + 1),
        }
    }

    #[test]
    fn left_to_right_boundaries_sit_on_left_edges() {
        let l = line(&[(0, 0.), (1, 10.), (2, 20.)], 30.);
        assert_eq!(caret_x(&l, 0), 0.);
        assert_eq!(caret_x(&l, 2), 20.);
        assert_eq!(caret_x(&l, 3), 30.);
    }

    #[test]
    fn right_to_left_boundaries_sit_on_right_edges() {
        let l = line(&[(2, 0.), (1, 10.), (0, 20.)], 30.);
        assert_eq!(caret_x(&l, 0), 30.);
        assert_eq!(caret_x(&l, 1), 20.);
        assert_eq!(caret_x(&l, 2), 10.);
        assert_eq!(caret_x(&l, 3), 0.);
    }

    #[test]
    fn a_right_to_left_run_inside_left_to_right_text() {
        let l = line(
            &[(0, 0.), (1, 10.), (4, 20.), (3, 30.), (2, 40.), (5, 50.)],
            60.,
        );
        assert_eq!(caret_x(&l, 1), 10.);
        assert_eq!(caret_x(&l, 2), 50.);
        assert_eq!(caret_x(&l, 4), 30.);
        assert_eq!(caret_x(&l, 5), 50.);
        assert_eq!(caret_x(&l, 6), 60.);
    }
}
