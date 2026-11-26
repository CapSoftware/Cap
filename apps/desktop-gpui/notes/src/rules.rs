use std::ops::Range;

use crate::editor::InputRules;
use crate::inline::bare_url_end;
use crate::model::{Block, BlockKind, Mark};

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum RuleEdit {
    Kind {
        kind: BlockKind,
        start: Option<u32>,
        strip: usize,
    },
    Rule,
    Code {
        language: String,
    },
    Inline {
        open: Range<usize>,
        close: Range<usize>,
        inner: Range<usize>,
        mark: Mark,
    },
    Replace {
        range: Range<usize>,
        with: String,
    },
    Link {
        range: Range<usize>,
        url: String,
    },
}

pub(crate) fn is_rule_text(text: &str) -> bool {
    matches!(text, "---" | "***" | "___")
}

pub(crate) fn code_fence(text: &str) -> Option<String> {
    let language = text.strip_prefix("```")?;
    let valid = language
        .chars()
        .all(|c| c.is_alphanumeric() || matches!(c, '_' | '+' | '#' | '.' | '-'));
    valid.then(|| language.to_string())
}

fn has_mark_at(block: &Block, offset: usize, matches: impl Fn(&Mark) -> bool) -> bool {
    block
        .spans
        .iter()
        .any(|span| span.range.start <= offset && offset < span.range.end && matches(&span.mark))
}

pub(crate) fn detect(
    block: &Block,
    caret: usize,
    typed: &str,
    rules: &InputRules,
) -> Option<RuleEdit> {
    if !block.kind.takes_marks() || typed.len() != 1 || caret == 0 {
        return None;
    }
    let typed_start = caret - 1;
    if block.text.get(typed_start..caret) != Some(typed) {
        return None;
    }
    if has_mark_at(block, typed_start, |m| *m == Mark::Code) {
        return None;
    }
    let c = typed.chars().next()?;
    let before = &block.text[..caret];
    if rules.markdown {
        if let Some(edit) = block_rule(block, caret, before, c) {
            return Some(edit);
        }
        if let Some(edit) = inline_rule(block, caret, before, c) {
            return Some(edit);
        }
        if c == ' '
            && let Some((range, url)) = trailing_url(block, typed_start)
        {
            return Some(RuleEdit::Link { range, url });
        }
    }
    if rules.typography {
        return typography(block, caret, before, c);
    }
    None
}

fn block_rule(block: &Block, caret: usize, before: &str, c: char) -> Option<RuleEdit> {
    let kind_edit = |kind: BlockKind, start: Option<u32>| {
        Some(RuleEdit::Kind {
            kind,
            start,
            strip: before.len(),
        })
    };
    let task = match before {
        "[] " | "[ ] " => Some(false),
        "[x] " | "[X] " => Some(true),
        _ => None,
    };
    if c == ' ' && block.kind == BlockKind::Bullet {
        return task.and_then(|checked| kind_edit(BlockKind::Task { checked }, None));
    }
    if block.kind != BlockKind::Paragraph {
        return None;
    }
    if c == ' ' {
        if let Some(checked) = task {
            return kind_edit(BlockKind::Task { checked }, None);
        }
        match before {
            "# " => return kind_edit(BlockKind::Heading(1), None),
            "## " => return kind_edit(BlockKind::Heading(2), None),
            "### " => return kind_edit(BlockKind::Heading(3), None),
            "- " | "* " | "+ " => return kind_edit(BlockKind::Bullet, None),
            "> " => return kind_edit(BlockKind::Quote, None),
            _ => {}
        }
        let digits = before.bytes().take_while(u8::is_ascii_digit).count();
        if (1..=9).contains(&digits) && before.len() == digits + 2 {
            let punct = before.as_bytes().get(digits);
            if matches!(punct, Some(b'.' | b')')) {
                let number: u32 = before[..digits].parse().ok()?;
                return kind_edit(BlockKind::Ordered, (number != 1).then_some(number));
            }
        }
    }
    if matches!(c, '-' | '*' | '_') && caret == block.text.len() && is_rule_text(&block.text) {
        return Some(RuleEdit::Rule);
    }
    None
}

fn delimited(
    block: &Block,
    caret: usize,
    delim: &str,
    word_boundary: bool,
    mark: Mark,
) -> Option<RuleEdit> {
    let text = &block.text;
    let before = &text[..caret];
    if !before.ends_with(delim) {
        return None;
    }
    let close_start = caret - delim.len();
    let open_start = before[..close_start].rfind(delim)?;
    let inner = open_start + delim.len()..close_start;
    let inner_text = text.get(inner.clone())?;
    if inner_text.is_empty()
        || inner_text.starts_with(char::is_whitespace)
        || inner_text.ends_with(char::is_whitespace)
    {
        return None;
    }
    let dch = delim.chars().next()?;
    if text[..open_start].ends_with(dch) || inner_text.starts_with(dch) || inner_text.ends_with(dch)
    {
        return None;
    }
    if word_boundary {
        let prev_alnum = text[..open_start]
            .chars()
            .next_back()
            .is_some_and(char::is_alphanumeric);
        let next_alnum = text[caret..]
            .chars()
            .next()
            .is_some_and(char::is_alphanumeric);
        if prev_alnum || next_alnum {
            return None;
        }
    }
    if has_mark_at(block, open_start, |m| *m == Mark::Code) {
        return None;
    }
    Some(RuleEdit::Inline {
        open: open_start..open_start + delim.len(),
        close: close_start..caret,
        inner,
        mark,
    })
}

fn inline_rule(block: &Block, caret: usize, before: &str, c: char) -> Option<RuleEdit> {
    match c {
        '*' => delimited(block, caret, "**", false, Mark::Bold)
            .or_else(|| delimited(block, caret, "*", false, Mark::Italic)),
        '_' => delimited(block, caret, "__", true, Mark::Bold)
            .or_else(|| delimited(block, caret, "_", true, Mark::Italic)),
        '~' => delimited(block, caret, "~~", false, Mark::Strike),
        '=' => delimited(block, caret, "==", false, Mark::Highlight),
        '`' => delimited(block, caret, "`", false, Mark::Code),
        ')' => {
            let body = &before[..caret - 1];
            let mid = body.rfind("](")?;
            let open = body[..mid].rfind('[')?;
            let label = &body[open + 1..mid];
            let url = &body[mid + 2..];
            if label.is_empty()
                || label.contains([']', '['])
                || url.is_empty()
                || url.contains(char::is_whitespace)
            {
                return None;
            }
            Some(RuleEdit::Inline {
                open: open..open + 1,
                close: mid..caret,
                inner: open + 1..mid,
                mark: Mark::Link {
                    url: url.to_string(),
                },
            })
        }
        _ => None,
    }
}

pub(crate) fn trailing_url(block: &Block, end: usize) -> Option<(Range<usize>, String)> {
    if !block.kind.takes_marks() {
        return None;
    }
    let before = block.text.get(..end)?;
    let word_start = before
        .char_indices()
        .rev()
        .find(|(_, c)| c.is_whitespace())
        .map_or(0, |(i, c)| i + c.len_utf8());
    let url_end = bare_url_end(before, word_start)?;
    let range = word_start..url_end;
    let linked = block.spans.iter().any(|span| {
        matches!(
            span.mark,
            Mark::Link { .. } | Mark::Mention { .. } | Mark::Code
        ) && span.range.start < range.end
            && span.range.end > range.start
    });
    if linked {
        return None;
    }
    Some((range.clone(), before[range].to_string()))
}

fn typography(block: &Block, caret: usize, before: &str, c: char) -> Option<RuleEdit> {
    if has_mark_at(block, caret - 1, |m| matches!(m, Mark::Link { .. })) {
        return None;
    }
    let word_start = before
        .char_indices()
        .rev()
        .find(|(_, ch)| ch.is_whitespace())
        .map_or(0, |(i, ch)| i + ch.len_utf8());
    let word = &before[word_start..];
    if word.contains("://") || word.to_ascii_lowercase().starts_with("mailto:") {
        return None;
    }
    let replace = |len: usize, with: &str| {
        Some(RuleEdit::Replace {
            range: caret - len..caret,
            with: with.to_string(),
        })
    };
    let ends_ci = |suffix: &str| {
        before.len() >= suffix.len()
            && before
                .get(before.len() - suffix.len()..)
                .is_some_and(|tail| tail.eq_ignore_ascii_case(suffix))
    };
    let digit_before = |index: usize| {
        before[..index]
            .chars()
            .next_back()
            .is_some_and(|ch| ch.is_ascii_digit())
    };
    match c {
        '-' if before.ends_with("+/-") => replace(3, "\u{b1}"),
        '-' if before.ends_with("<-") => replace(2, "\u{2190}"),
        '-' if before.ends_with("--") => {
            if block.kind == BlockKind::Paragraph && block.text == "--" {
                None
            } else {
                replace(2, "\u{2014}")
            }
        }
        '.' if before.ends_with("...") => replace(3, "\u{2026}"),
        '>' if before.ends_with("->") => replace(2, "\u{2192}"),
        '>' if before.ends_with(">>") => replace(2, "\u{bb}"),
        '<' if before.ends_with("<<") => replace(2, "\u{ab}"),
        ')' if ends_ci("(c)") => replace(3, "\u{a9}"),
        ')' if ends_ci("(r)") => replace(3, "\u{ae}"),
        ')' if ends_ci("(tm)") => replace(4, "\u{2122}"),
        '=' if before.ends_with("!=") => replace(2, "\u{2260}"),
        '2' | '3'
            if before.len() >= 3
                && before.ends_with(['2', '3'])
                && before[..caret - 1].ends_with('^') =>
        {
            if digit_before(caret - 2) {
                replace(2, if c == '2' { "\u{b2}" } else { "\u{b3}" })
            } else {
                None
            }
        }
        d if d.is_ascii_digit() => {
            let bytes = before.as_bytes();
            let n = bytes.len();
            if n >= 3 && bytes[n - 2] == b'x' && bytes[n - 3].is_ascii_digit() {
                Some(RuleEdit::Replace {
                    range: caret - 2..caret - 1,
                    with: "\u{d7}".to_string(),
                })
            } else {
                None
            }
        }
        '/' => None,
        _ => {
            let head = &before[..caret - 1];
            for (fraction, glyph) in [("1/2", "\u{bd}"), ("1/4", "\u{bc}"), ("3/4", "\u{be}")] {
                if head.ends_with(fraction) {
                    let start = head.len() - fraction.len();
                    let blocked = head[..start]
                        .chars()
                        .next_back()
                        .is_some_and(|ch| ch.is_ascii_digit() || ch == '/');
                    if !blocked {
                        return Some(RuleEdit::Replace {
                            range: start..start + fraction.len(),
                            with: glyph.to_string(),
                        });
                    }
                }
            }
            None
        }
    }
}
