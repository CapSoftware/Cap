use std::ops::Range;

use crate::model::{Mark, Span};
use crate::spans::{marks_covering, normalize_spans};

const TAGS: &[(&str, Mark)] = &[
    ("u", Mark::Underline),
    ("strong", Mark::Bold),
    ("b", Mark::Bold),
    ("em", Mark::Italic),
    ("i", Mark::Italic),
    ("s", Mark::Strike),
    ("del", Mark::Strike),
    ("mark", Mark::Highlight),
    ("code", Mark::Code),
];

const BARE_SCHEMES: &[&str] = &["https://", "http://", "mailto:"];

enum Node {
    Text {
        text: String,
        spans: Vec<Span>,
    },
    Delim {
        ch: char,
        orig: usize,
        count: usize,
        can_open: bool,
        can_close: bool,
        active: bool,
    },
    Tag {
        mark: Mark,
        open: bool,
        raw: String,
        matched: bool,
    },
}

fn is_punct(c: char) -> bool {
    !c.is_alphanumeric() && !c.is_whitespace()
}

fn char_at(src: &str, i: usize) -> Option<char> {
    src.get(i..).and_then(|rest| rest.chars().next())
}

fn run_len(src: &str, i: usize, c: u8) -> usize {
    src.as_bytes()
        .get(i..)
        .map_or(0, |rest| rest.iter().take_while(|b| **b == c).count())
}

pub(crate) fn decode_entity(rest: &str) -> Option<(char, usize)> {
    let named: &[(&str, char)] = &[
        ("&amp;", '&'),
        ("&lt;", '<'),
        ("&gt;", '>'),
        ("&quot;", '"'),
        ("&apos;", '\''),
        ("&nbsp;", '\u{a0}'),
    ];
    for (name, ch) in named {
        if rest.starts_with(name) {
            return Some((*ch, name.len()));
        }
    }
    let body = rest.strip_prefix("&#")?;
    let (digits, radix, prefix) = match body.strip_prefix(['x', 'X']) {
        Some(hex) => (hex, 16, 3),
        None => (body, 10, 2),
    };
    let max = if radix == 16 { 6 } else { 7 };
    let len = digits.bytes().take_while(|b| b.is_ascii_hexdigit()).count();
    let len = if radix == 10 {
        digits.bytes().take_while(u8::is_ascii_digit).count()
    } else {
        len
    };
    if len == 0 || len > max || digits.as_bytes().get(len) != Some(&b';') {
        return None;
    }
    let value = u32::from_str_radix(&digits[..len], radix).ok()?;
    let ch = if value == 0 {
        '\u{fffd}'
    } else {
        char::from_u32(value).unwrap_or('\u{fffd}')
    };
    Some((ch, prefix + len + 1))
}

fn code_span(src: &str, i: usize, n: usize) -> Option<(String, usize)> {
    let mut j = i + n;
    while j < src.len() {
        if src.as_bytes()[j] == b'`' {
            let m = run_len(src, j, b'`');
            if m == n {
                let content = src.get(i + n..j)?;
                let stripped = if content.len() >= 2
                    && content.starts_with(' ')
                    && content.ends_with(' ')
                    && content.bytes().any(|b| b != b' ')
                {
                    &content[1..content.len() - 1]
                } else {
                    content
                };
                return Some((stripped.to_string(), j + m));
            }
            j += m;
        } else {
            j += 1;
        }
    }
    None
}

fn autolink(src: &str, i: usize) -> Option<(String, usize)> {
    let rest = src.get(i + 1..)?;
    let scheme_len = rest
        .bytes()
        .take_while(|b| b.is_ascii_alphanumeric() || matches!(b, b'+' | b'.' | b'-'))
        .count();
    if !(2..=32).contains(&scheme_len) || !rest.as_bytes()[0].is_ascii_alphabetic() {
        return None;
    }
    if rest.as_bytes().get(scheme_len) != Some(&b':') {
        return None;
    }
    let body_start = scheme_len + 1;
    let body_len = rest[body_start..]
        .find(|c: char| c == '>' || c == '<' || c.is_whitespace() || c.is_control())?;
    if rest.as_bytes().get(body_start + body_len) != Some(&b'>') {
        return None;
    }
    let url = &rest[..body_start + body_len];
    Some((url.to_string(), i + 1 + url.len() + 1))
}

fn html_tag(src: &str, i: usize) -> Option<(Mark, bool, usize)> {
    let rest = src.get(i + 1..)?;
    let (open, name_part) = match rest.strip_prefix('/') {
        Some(after) => (false, after),
        None => (true, rest),
    };
    for (name, mark) in TAGS {
        let Some(candidate) = name_part.get(..name.len() + 1) else {
            continue;
        };
        if candidate
            .get(..name.len())
            .is_some_and(|part| part.eq_ignore_ascii_case(name))
            && candidate.ends_with('>')
        {
            let len = 1 + usize::from(!open) + name.len() + 1;
            return Some((mark.clone(), open, len));
        }
    }
    None
}

fn starts_with_ci(src: &str, i: usize, prefix: &str) -> bool {
    src.get(i..i + prefix.len())
        .is_some_and(|part| part.eq_ignore_ascii_case(prefix))
}

pub(crate) fn bare_url_end(src: &str, i: usize) -> Option<usize> {
    let scheme = BARE_SCHEMES
        .iter()
        .find(|scheme| starts_with_ci(src, i, scheme))?;
    let body = &src[i + scheme.len()..];
    let mut end = i
        + scheme.len()
        + body
            .find(|c: char| c.is_whitespace() || c == '<' || c == '>')
            .unwrap_or(body.len());
    loop {
        let candidate = &src[i..end];
        let Some(last) = candidate.chars().next_back() else {
            break;
        };
        let unbalanced_paren =
            last == ')' && candidate.matches(')').count() > candidate.matches('(').count();
        if matches!(
            last,
            '.' | ',' | ':' | ';' | '!' | '?' | '"' | '\'' | '*' | '_' | '~'
        ) || unbalanced_paren
        {
            end -= last.len_utf8();
        } else {
            break;
        }
    }
    (end > i + scheme.len()).then_some(end)
}

fn unescape(src: &str) -> String {
    let mut out = String::with_capacity(src.len());
    let mut chars = src.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\\'
            && let Some(&next) = chars.peek()
            && next.is_ascii_punctuation()
        {
            out.push(next);
            chars.next();
            continue;
        }
        out.push(c);
    }
    out
}

fn skip_char(src: &str, j: usize) -> usize {
    j + char_at(src, j).map_or(1, char::len_utf8)
}

fn link(src: &str, i: usize) -> Option<(String, Vec<Span>, usize)> {
    let mut depth = 1usize;
    let mut j = i + 1;
    loop {
        let c = char_at(src, j)?;
        match c {
            '\\' => j = skip_char(src, j + 1),
            '`' => {
                let n = run_len(src, j, b'`');
                j = code_span(src, j, n).map_or(j + n, |(_, end)| end);
            }
            '[' => {
                depth += 1;
                j += 1;
            }
            ']' => {
                depth -= 1;
                if depth == 0 {
                    break;
                }
                j += 1;
            }
            _ => j += c.len_utf8(),
        }
    }
    let label = &src[i + 1..j];
    let mut k = j + 1;
    if char_at(src, k) != Some('(') {
        return None;
    }
    k += 1;
    let skip_ws = |src: &str, mut k: usize| {
        while matches!(char_at(src, k), Some(' ' | '\t')) {
            k += 1;
        }
        k
    };
    k = skip_ws(src, k);
    let url = if char_at(src, k) == Some('<') {
        let start = k + 1;
        let mut e = start;
        loop {
            match char_at(src, e)? {
                '\\' => e = skip_char(src, e + 1),
                '>' => break,
                '<' | '\n' => return None,
                other => e += other.len_utf8(),
            }
        }
        k = e + 1;
        unescape(&src[start..e])
    } else {
        let start = k;
        let mut parens = 0usize;
        loop {
            match char_at(src, k) {
                Some('\\') => k = skip_char(src, k + 1),
                Some('(') => {
                    parens += 1;
                    k += 1;
                }
                Some(')') if parens > 0 => {
                    parens -= 1;
                    k += 1;
                }
                Some(c) if c != ')' && !c.is_whitespace() && !c.is_control() => {
                    k += c.len_utf8();
                }
                _ => break,
            }
        }
        unescape(src.get(start..k)?)
    };
    k = skip_ws(src, k);
    if let Some(open) = char_at(src, k).filter(|c| matches!(c, '"' | '\'' | '(')) {
        let close = if open == '(' { ')' } else { open };
        k += 1;
        loop {
            match char_at(src, k)? {
                '\\' => k = skip_char(src, k + 1),
                c if c == close => {
                    k += 1;
                    break;
                }
                c => k += c.len_utf8(),
            }
        }
        k = skip_ws(src, k);
    }
    if char_at(src, k) != Some(')') {
        return None;
    }
    let (text, mut spans) = parse(label, true);
    if text.is_empty() {
        return None;
    }
    let mark = match url.strip_prefix("mention:") {
        Some(id) => Mark::Mention { id: id.to_string() },
        None => Mark::Link { url },
    };
    spans.retain(|span| !span.mark.is_exclusive());
    spans.push(Span {
        range: 0..text.len(),
        mark,
    });
    Some((text, spans, k + 1))
}

pub(crate) fn parse_inline(src: &str) -> (String, Vec<Span>) {
    parse(src, false)
}

fn flush(buf: &mut String, nodes: &mut Vec<Node>) {
    if !buf.is_empty() {
        nodes.push(Node::Text {
            text: std::mem::take(buf),
            spans: Vec::new(),
        });
    }
}

fn parse(src: &str, in_link: bool) -> (String, Vec<Span>) {
    let mut nodes: Vec<Node> = Vec::new();
    let mut buf = String::new();
    let mut i = 0;
    while let Some(c) = char_at(src, i) {
        match c {
            '\\' => {
                if let Some(next) = char_at(src, i + 1).filter(char::is_ascii_punctuation) {
                    buf.push(next);
                    i += 2;
                } else {
                    buf.push('\\');
                    i += 1;
                }
            }
            '`' => {
                let n = run_len(src, i, b'`');
                if let Some((content, end)) = code_span(src, i, n) {
                    flush(&mut buf, &mut nodes);
                    let spans = vec![Span {
                        range: 0..content.len(),
                        mark: Mark::Code,
                    }];
                    nodes.push(Node::Text {
                        text: content,
                        spans,
                    });
                    i = end;
                } else {
                    buf.push_str(&src[i..i + n]);
                    i += n;
                }
            }
            '*' | '_' | '~' | '=' => {
                let n = run_len(src, i, c as u8);
                if matches!(c, '~' | '=') && n != 2 {
                    buf.push_str(&src[i..i + n]);
                    i += n;
                    continue;
                }
                let prev = src[..i].chars().next_back().unwrap_or(' ');
                let next = char_at(src, i + n).unwrap_or(' ');
                let left = !next.is_whitespace()
                    && (!is_punct(next) || prev.is_whitespace() || is_punct(prev));
                let right = !prev.is_whitespace()
                    && (!is_punct(prev) || next.is_whitespace() || is_punct(next));
                let (can_open, can_close) = if c == '_' {
                    (
                        left && (!right || is_punct(prev)),
                        right && (!left || is_punct(next)),
                    )
                } else {
                    (left, right)
                };
                flush(&mut buf, &mut nodes);
                nodes.push(Node::Delim {
                    ch: c,
                    orig: n,
                    count: n,
                    can_open,
                    can_close,
                    active: true,
                });
                i += n;
            }
            '<' => {
                if !in_link && let Some((url, end)) = autolink(src, i) {
                    flush(&mut buf, &mut nodes);
                    let spans = vec![Span {
                        range: 0..url.len(),
                        mark: Mark::Link { url: url.clone() },
                    }];
                    nodes.push(Node::Text { text: url, spans });
                    i = end;
                } else if let Some((mark, open, len)) = html_tag(src, i) {
                    flush(&mut buf, &mut nodes);
                    nodes.push(Node::Tag {
                        mark,
                        open,
                        raw: src[i..i + len].to_string(),
                        matched: false,
                    });
                    i += len;
                } else {
                    buf.push('<');
                    i += 1;
                }
            }
            '[' if !in_link => {
                if let Some((text, spans, end)) = link(src, i) {
                    flush(&mut buf, &mut nodes);
                    nodes.push(Node::Text { text, spans });
                    i = end;
                } else {
                    buf.push('[');
                    i += 1;
                }
            }
            '&' => {
                if let Some((ch, len)) = decode_entity(&src[i..]) {
                    buf.push(ch);
                    i += len;
                } else {
                    buf.push('&');
                    i += 1;
                }
            }
            _ => {
                let at_boundary = src[..i]
                    .chars()
                    .next_back()
                    .is_none_or(|prev| !prev.is_alphanumeric());
                if !in_link
                    && at_boundary
                    && matches!(c, 'h' | 'H' | 'm' | 'M')
                    && let Some(end) = bare_url_end(src, i)
                {
                    flush(&mut buf, &mut nodes);
                    let url = src[i..end].to_string();
                    let spans = vec![Span {
                        range: 0..url.len(),
                        mark: Mark::Link { url: url.clone() },
                    }];
                    nodes.push(Node::Text { text: url, spans });
                    i = end;
                } else {
                    buf.push(c);
                    i += c.len_utf8();
                }
            }
        }
    }
    flush(&mut buf, &mut nodes);
    let pairs = resolve(&mut nodes);
    render_nodes(&nodes, &pairs)
}

fn resolve(nodes: &mut [Node]) -> Vec<(usize, usize, Mark)> {
    let mut pairs = Vec::new();
    for ci in 0..nodes.len() {
        loop {
            let (cch, ccount, corig, ccan_open) = match &nodes[ci] {
                Node::Delim {
                    ch,
                    count,
                    orig,
                    can_open,
                    can_close: true,
                    active: true,
                } if *count > 0 => (*ch, *count, *orig, *can_open),
                _ => break,
            };
            let mut found = None;
            for oi in (0..ci).rev() {
                if let Node::Delim {
                    ch,
                    count,
                    orig,
                    can_open: true,
                    can_close,
                    active: true,
                } = &nodes[oi]
                    && *ch == cch
                    && *count > 0
                {
                    let multiple_of_three = (*can_close || ccan_open)
                        && (orig + corig) % 3 == 0
                        && !(orig % 3 == 0 && corig % 3 == 0);
                    if matches!(cch, '*' | '_') && multiple_of_three {
                        continue;
                    }
                    found = Some((oi, *count));
                    break;
                }
            }
            let Some((oi, ocount)) = found else {
                if !ccan_open && let Node::Delim { active, .. } = &mut nodes[ci] {
                    *active = false;
                }
                break;
            };
            let used = if matches!(cch, '~' | '=') || (ocount >= 2 && ccount >= 2) {
                2
            } else {
                1
            };
            let mark = match (cch, used) {
                ('~', _) => Mark::Strike,
                ('=', _) => Mark::Highlight,
                (_, 2) => Mark::Bold,
                _ => Mark::Italic,
            };
            pairs.push((oi, ci, mark));
            for (index, node) in nodes.iter_mut().enumerate().take(ci + 1).skip(oi) {
                if let Node::Delim { count, active, .. } = node {
                    if index == oi || index == ci {
                        *count -= used;
                    } else {
                        *active = false;
                    }
                }
            }
        }
    }
    for ci in 0..nodes.len() {
        let close_mark = match &nodes[ci] {
            Node::Tag {
                mark, open: false, ..
            } => mark.clone(),
            _ => continue,
        };
        let opener = (0..ci).rev().find(|&oi| {
            matches!(&nodes[oi], Node::Tag { mark, open: true, matched: false, .. } if *mark == close_mark)
        });
        if let Some(oi) = opener {
            for index in [oi, ci] {
                if let Node::Tag { matched, .. } = &mut nodes[index] {
                    *matched = true;
                }
            }
            pairs.push((oi, ci, close_mark));
        }
    }
    pairs
}

fn render_nodes(nodes: &[Node], pairs: &[(usize, usize, Mark)]) -> (String, Vec<Span>) {
    let mut text = String::new();
    let mut spans = Vec::new();
    let mut before = Vec::with_capacity(nodes.len());
    let mut after = Vec::with_capacity(nodes.len());
    for node in nodes {
        before.push(text.len());
        match node {
            Node::Text {
                text: piece,
                spans: piece_spans,
            } => {
                let shift = text.len();
                spans.extend(piece_spans.iter().map(|span| Span {
                    range: span.range.start + shift..span.range.end + shift,
                    mark: span.mark.clone(),
                }));
                text.push_str(piece);
            }
            Node::Delim { ch, count, .. } => {
                for _ in 0..*count {
                    text.push(*ch);
                }
            }
            Node::Tag { raw, matched, .. } => {
                if !matched {
                    text.push_str(raw);
                }
            }
        }
        after.push(text.len());
    }
    for (open, close, mark) in pairs {
        spans.push(Span {
            range: after[*open]..before[*close],
            mark: mark.clone(),
        });
    }
    normalize_spans(&text, &mut spans);
    (text, spans)
}

fn trim_ws(s: &str) -> &str {
    s.trim_matches([' ', '\t'])
}

pub(crate) fn exportable_spans(text: &str, spans: &[Span]) -> Vec<Span> {
    let mut out: Vec<Span> = spans
        .iter()
        .filter(|span| !matches!(span.mark, Mark::Unknown { .. }))
        .cloned()
        .collect();
    normalize_spans(text, &mut out);
    out
}

pub(crate) fn export_inline(text: &str, spans: &[Span]) -> String {
    let spans = exportable_spans(text, spans);
    let compact = Exporter::new(text, &spans, false).render();
    let (parsed_text, parsed_spans) = parse_inline(trim_ws(&compact));
    if parsed_text == text && parsed_spans == spans {
        compact
    } else {
        Exporter::new(text, &spans, true).render()
    }
}

struct Exporter<'a> {
    text: &'a str,
    spans: &'a [Span],
    tags: bool,
    lead_end: usize,
    trail_start: usize,
    out: String,
}

fn open_delim(mark: &Mark, tags: bool) -> &'static str {
    match (mark, tags) {
        (Mark::Bold, false) => "**",
        (Mark::Italic, false) => "*",
        (Mark::Strike, false) => "~~",
        (Mark::Highlight, false) => "==",
        (Mark::Bold, true) => "<strong>",
        (Mark::Italic, true) => "<em>",
        (Mark::Strike, true) => "<s>",
        (Mark::Highlight, true) => "<mark>",
        (Mark::Code, _) => "<code>",
        _ => "<u>",
    }
}

fn close_delim(mark: &Mark, tags: bool) -> &'static str {
    match (mark, tags) {
        (Mark::Bold, false) => "**",
        (Mark::Italic, false) => "*",
        (Mark::Strike, false) => "~~",
        (Mark::Highlight, false) => "==",
        (Mark::Bold, true) => "</strong>",
        (Mark::Italic, true) => "</em>",
        (Mark::Strike, true) => "</s>",
        (Mark::Highlight, true) => "</mark>",
        (Mark::Code, _) => "</code>",
        _ => "</u>",
    }
}

fn is_autolinkable(url: &str) -> bool {
    let scheme_len = url
        .bytes()
        .take_while(|b| b.is_ascii_alphanumeric() || matches!(b, b'+' | b'.' | b'-'))
        .count();
    (2..=32).contains(&scheme_len)
        && url.as_bytes()[0].is_ascii_alphabetic()
        && url.as_bytes().get(scheme_len) == Some(&b':')
        && !url
            .chars()
            .any(|c| c == '<' || c == '>' || c.is_whitespace() || c.is_control())
}

pub(crate) fn escape_url(url: &str) -> String {
    let needs_angle = url.is_empty()
        || url
            .chars()
            .any(|c| matches!(c, '(' | ')' | '<' | '>') || c.is_whitespace() || c.is_control());
    let mut out = String::with_capacity(url.len() + 2);
    if needs_angle {
        out.push('<');
    }
    for c in url.chars() {
        if c == '\\' || (needs_angle && matches!(c, '<' | '>')) {
            out.push('\\');
        }
        out.push(c);
    }
    if needs_angle {
        out.push('>');
    }
    out
}

fn code_span_source(content: &str) -> String {
    let mut longest = 0;
    let mut current = 0;
    for b in content.bytes() {
        if b == b'`' {
            current += 1;
            longest = longest.max(current);
        } else {
            current = 0;
        }
    }
    let fence = "`".repeat(longest + 1);
    let pad = content.starts_with('`')
        || content.ends_with('`')
        || (content.starts_with(' ')
            && content.ends_with(' ')
            && content.bytes().any(|b| b != b' '));
    let space = if pad { " " } else { "" };
    format!("{fence}{space}{content}{space}{fence}")
}

impl<'a> Exporter<'a> {
    fn new(text: &'a str, spans: &'a [Span], tags: bool) -> Self {
        let lead_end = text.len() - text.trim_start_matches([' ', '\t']).len();
        let trail_start = text.trim_end_matches([' ', '\t']).len().max(lead_end);
        Self {
            text,
            spans,
            tags,
            lead_end,
            trail_start,
            out: String::with_capacity(text.len() + 8),
        }
    }

    fn render(mut self) -> String {
        let mut pos = 0;
        let exclusive: Vec<&Span> = self
            .spans
            .iter()
            .filter(|s| s.mark.is_exclusive())
            .collect();
        for span in exclusive {
            if span.range.start < pos {
                continue;
            }
            self.emit_marked(pos..span.range.start);
            self.emit_link(span);
            pos = span.range.end;
        }
        self.emit_marked(pos..self.text.len());
        self.out
    }

    fn emit_link(&mut self, span: &Span) {
        let label = &self.text[span.range.clone()];
        let inner_marks = self.spans.iter().any(|s| {
            !s.mark.is_exclusive()
                && s.range.start < span.range.end
                && s.range.end > span.range.start
        });
        match &span.mark {
            Mark::Link { url }
                if !self.tags && !inner_marks && label == url && is_autolinkable(url) =>
            {
                self.out.push('<');
                self.out.push_str(url);
                self.out.push('>');
            }
            Mark::Link { url } => {
                self.out.push('[');
                self.emit_marked(span.range.clone());
                self.out.push_str("](");
                self.out.push_str(&escape_url(url));
                self.out.push(')');
            }
            Mark::Mention { id } => {
                self.out.push('[');
                self.emit_marked(span.range.clone());
                self.out.push_str("](");
                self.out.push_str(&escape_url(&format!("mention:{id}")));
                self.out.push(')');
            }
            _ => self.emit_marked(span.range.clone()),
        }
    }

    fn emit_marked(&mut self, range: Range<usize>) {
        if range.is_empty() {
            return;
        }
        let inner: Vec<Span> = self
            .spans
            .iter()
            .filter(|s| !s.mark.is_exclusive())
            .filter(|s| s.range.start < range.end && s.range.end > range.start)
            .map(|s| Span {
                range: s.range.start.max(range.start)..s.range.end.min(range.end),
                mark: s.mark.clone(),
            })
            .collect();
        let mut cuts = vec![range.start, range.end];
        for span in &inner {
            cuts.push(span.range.start);
            cuts.push(span.range.end);
        }
        cuts.sort_unstable();
        cuts.dedup();
        let runs: Vec<(Range<usize>, Vec<Mark>)> = cuts
            .windows(2)
            .map(|pair| {
                let marks = marks_covering(&inner, pair[0]..pair[1]);
                (
                    pair[0]..pair[1],
                    marks
                        .iter()
                        .filter(|m| self.tags || **m != Mark::Code)
                        .cloned()
                        .collect(),
                )
            })
            .collect();
        let code_runs: Vec<bool> = cuts
            .windows(2)
            .map(|pair| marks_covering(&inner, pair[0]..pair[1]).contains(&Mark::Code))
            .collect();
        let mut stack: Vec<Mark> = Vec::new();
        for (index, (run, marks)) in runs.iter().enumerate() {
            if let Some(first_stale) = stack.iter().position(|m| !marks.contains(m)) {
                while stack.len() > first_stale {
                    if let Some(mark) = stack.pop() {
                        self.out.push_str(close_delim(&mark, self.tags));
                    }
                }
            }
            let mut opening: Vec<(usize, Mark)> = marks
                .iter()
                .filter(|m| !stack.contains(m))
                .map(|m| {
                    let extent = runs[index..]
                        .iter()
                        .take_while(|(_, later)| later.contains(m))
                        .count();
                    (extent, m.clone())
                })
                .collect();
            opening.sort_by(|a, b| b.0.cmp(&a.0).then(a.1.cmp(&b.1)));
            for (_, mark) in opening {
                self.out.push_str(open_delim(&mark, self.tags));
                stack.push(mark);
            }
            if !self.tags && code_runs[index] {
                self.out
                    .push_str(&code_span_source(&self.text[run.clone()]));
            } else {
                self.escape(run.clone());
            }
        }
        while let Some(mark) = stack.pop() {
            self.out.push_str(close_delim(&mark, self.tags));
        }
    }

    fn escape(&mut self, range: Range<usize>) {
        let text = self.text;
        for (offset, c) in text[range.clone()].char_indices() {
            let p = range.start + offset;
            if (p < self.lead_end || p >= self.trail_start) && matches!(c, ' ' | '\t') {
                self.out.push_str(if c == ' ' { "&#32;" } else { "&#9;" });
                continue;
            }
            let prev = text[..p].chars().next_back();
            let next = text[p + c.len_utf8()..].chars().next();
            let aggressive = self.tags;
            let needs = match c {
                '\\' | '`' | '*' | '[' | ']' => true,
                '_' => {
                    aggressive
                        || !(prev.is_some_and(char::is_alphanumeric)
                            && next.is_some_and(char::is_alphanumeric))
                }
                '~' | '=' => aggressive || prev == Some(c) || next == Some(c),
                '<' => {
                    aggressive
                        || next.is_some_and(|n| {
                            n.is_ascii_alphabetic() || matches!(n, '/' | '!' | '?')
                        })
                }
                '>' => aggressive,
                '&' => decode_entity(&text[p..]).is_some(),
                ':' => ends_with_scheme_word(&text[..p]),
                _ => false,
            };
            if needs {
                self.out.push('\\');
            }
            self.out.push(c);
        }
    }
}

fn ends_with_scheme_word(before: &str) -> bool {
    ["http", "mailto"].iter().any(|word| {
        let lower = before.len() >= word.len()
            && before
                .get(before.len() - word.len()..)
                .is_some_and(|tail| tail.eq_ignore_ascii_case(word));
        let secure = before.len() > word.len()
            && (before.ends_with('s') || before.ends_with('S'))
            && before
                .get(before.len() - word.len() - 1..before.len() - 1)
                .is_some_and(|tail| tail.eq_ignore_ascii_case(word));
        lower || secure
    })
}
