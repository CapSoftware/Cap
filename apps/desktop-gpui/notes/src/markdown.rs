use crate::inline::{export_inline, exportable_spans, parse_inline};
use crate::model::{Block, BlockId, BlockKind, Document, MAX_HEADING, Mark, Span};

const INDENT_UNIT: &str = "    ";

enum Line<'a> {
    Blank,
    Fence {
        ch: u8,
        len: usize,
        info: &'a str,
        indent: usize,
    },
    Heading(u8, &'a str),
    Rule,
    Quote(&'a str),
    List {
        col: usize,
        kind: BlockKind,
        number: Option<u32>,
        content: &'a str,
    },
    Text(&'a str),
}

fn is_ws(b: u8) -> bool {
    b == b' ' || b == b'\t'
}

fn trim_ws(s: &str) -> &str {
    s.trim_matches([' ', '\t'])
}

fn leading(line: &str) -> (usize, usize) {
    let mut col = 0;
    let mut bytes = 0;
    for b in line.bytes() {
        match b {
            b' ' => col += 1,
            b'\t' => col += 4 - col % 4,
            _ => break,
        }
        bytes += 1;
    }
    (col, bytes)
}

fn is_rule(rest: &str) -> bool {
    let mut marker = None;
    let mut count = 0;
    for c in rest.chars() {
        match c {
            ' ' | '\t' => {}
            '-' | '*' | '_' => {
                if marker.is_some_and(|m| m != c) {
                    return false;
                }
                marker = Some(c);
                count += 1;
            }
            _ => return false,
        }
    }
    count >= 3
}

fn list_marker(rest: &str) -> Option<(BlockKind, Option<u32>, &str)> {
    let bytes = rest.as_bytes();
    let first = *bytes.first()?;
    let followed_by_space = |at: usize| bytes.get(at).is_none_or(|b| is_ws(*b));
    if matches!(first, b'-' | b'*' | b'+') && followed_by_space(1) {
        let content = rest[1..].trim_start_matches([' ', '\t']);
        for (prefix, checked) in [("[ ]", false), ("[x]", true), ("[X]", true)] {
            if let Some(after) = content.strip_prefix(prefix)
                && after.as_bytes().first().is_none_or(|b| is_ws(*b))
            {
                return Some((
                    BlockKind::Task { checked },
                    None,
                    after.trim_start_matches([' ', '\t']),
                ));
            }
        }
        return Some((BlockKind::Bullet, None, content));
    }
    let digits = bytes.iter().take_while(|b| b.is_ascii_digit()).count();
    if (1..=9).contains(&digits)
        && matches!(bytes.get(digits), Some(b'.' | b')'))
        && followed_by_space(digits + 1)
    {
        let number = rest[..digits].parse().ok()?;
        let content = rest[digits + 1..].trim_start_matches([' ', '\t']);
        return Some((BlockKind::Ordered, Some(number), content));
    }
    None
}

fn heading_content(rest: &str) -> &str {
    let content = trim_ws(rest);
    let without = content.trim_end_matches('#');
    if without.is_empty() {
        ""
    } else if without.len() < content.len() && without.ends_with([' ', '\t']) {
        trim_ws(without)
    } else {
        content
    }
}

fn classify(line: &str) -> Line<'_> {
    if trim_ws(line).is_empty() {
        return Line::Blank;
    }
    let (col, skip) = leading(line);
    let rest = &line[skip..];
    if col <= 3 {
        for &fence in b"`~" {
            let len = rest.bytes().take_while(|b| *b == fence).count();
            if len >= 3 {
                let info = trim_ws(&rest[len..]);
                if fence == b'~' || !info.contains('`') {
                    return Line::Fence {
                        ch: fence,
                        len,
                        info,
                        indent: skip,
                    };
                }
            }
        }
        let hashes = rest.bytes().take_while(|b| *b == b'#').count();
        if (1..=6).contains(&hashes) && rest.as_bytes().get(hashes).is_none_or(|b| is_ws(*b)) {
            return Line::Heading(
                (hashes as u8).min(MAX_HEADING),
                heading_content(&rest[hashes..]),
            );
        }
        if is_rule(rest) {
            return Line::Rule;
        }
        if let Some(after) = rest.strip_prefix('>') {
            return Line::Quote(after.strip_prefix([' ', '\t']).unwrap_or(after));
        }
    }
    if let Some((kind, number, content)) = list_marker(rest) {
        return Line::List {
            col,
            kind,
            number,
            content,
        };
    }
    Line::Text(rest)
}

fn is_closing_fence(line: &str, ch: u8, len: usize) -> bool {
    let (col, skip) = leading(line);
    let rest = &line[skip..];
    let run = rest.bytes().take_while(|b| *b == ch).count();
    col <= 3 && run >= len && trim_ws(&rest[run..]).is_empty()
}

fn strip_indent(line: &str, indent: usize) -> &str {
    let spaces = line.bytes().take(indent).take_while(|b| *b == b' ').count();
    &line[spaces..]
}

struct Pending {
    block: Block,
    raw: String,
}

impl Document {
    pub fn from_markdown(src: &str) -> Document {
        let normalized;
        let src = if src.contains('\r') {
            normalized = src.replace("\r\n", "\n").replace('\r', "\n");
            normalized.as_str()
        } else {
            src
        };
        let lines: Vec<&str> = src.split('\n').collect();
        let mut pending: Vec<Pending> = Vec::new();
        let mut open = false;
        let mut stack: Vec<usize> = Vec::new();
        let mut i = 0;
        let new_block = |kind: BlockKind, raw: &str| Pending {
            block: Block {
                kind,
                ..Block::default()
            },
            raw: trim_ws(raw).to_string(),
        };
        while i < lines.len() {
            let line = lines[i];
            i += 1;
            let classified = classify(line);
            match classified {
                Line::Blank => open = false,
                Line::Fence {
                    ch,
                    len,
                    info,
                    indent,
                } => {
                    let mut body: Vec<&str> = Vec::new();
                    while i < lines.len() {
                        let content = lines[i];
                        i += 1;
                        if is_closing_fence(content, ch, len) {
                            break;
                        }
                        body.push(strip_indent(content, indent));
                    }
                    let language = info.split_whitespace().next().unwrap_or_default();
                    let mut block = new_block(
                        BlockKind::Code {
                            language: language.to_string(),
                        },
                        "",
                    );
                    block.block.text = body.join("\n");
                    pending.push(block);
                    open = false;
                    stack.clear();
                }
                Line::Heading(level, content) => {
                    pending.push(new_block(BlockKind::Heading(level), content));
                    open = false;
                    stack.clear();
                }
                Line::Rule => {
                    pending.push(new_block(BlockKind::Rule, ""));
                    open = false;
                    stack.clear();
                }
                Line::Quote(content) => {
                    stack.clear();
                    let continuing = open
                        && pending
                            .last()
                            .is_some_and(|last| last.block.kind == BlockKind::Quote);
                    if trim_ws(content).is_empty() {
                        open = false;
                    } else if continuing {
                        if let Some(last) = pending.last_mut() {
                            last.raw.push(' ');
                            last.raw.push_str(trim_ws(content));
                        }
                    } else {
                        pending.push(new_block(BlockKind::Quote, content));
                        open = true;
                    }
                }
                Line::List {
                    col,
                    kind,
                    number,
                    content,
                } => {
                    while stack.last().is_some_and(|top| *top > col) {
                        stack.pop();
                    }
                    if stack.last() != Some(&col) {
                        stack.push(col);
                    }
                    let mut item = new_block(kind, content);
                    item.block.indent = (stack.len() - 1).min(u8::MAX as usize) as u8;
                    item.block.start = number;
                    pending.push(item);
                    open = true;
                }
                Line::Text(content) => {
                    let accepts = open
                        && pending.last().is_some_and(|last| {
                            last.block.kind.is_list()
                                || matches!(
                                    last.block.kind,
                                    BlockKind::Paragraph | BlockKind::Quote
                                )
                        });
                    if accepts {
                        if let Some(last) = pending.last_mut() {
                            last.raw.push(' ');
                            last.raw.push_str(trim_ws(content));
                        }
                    } else {
                        pending.push(new_block(BlockKind::Paragraph, content));
                        stack.clear();
                        open = true;
                    }
                }
            }
        }
        let blocks = pending
            .into_iter()
            .enumerate()
            .map(|(index, Pending { mut block, raw })| {
                block.id = BlockId(index as u64 + 1);
                if block.kind.takes_marks() {
                    let (text, spans) = parse_inline(&raw);
                    block.text = text;
                    block.spans = spans;
                }
                block
            })
            .collect();
        Document::from_blocks(blocks)
    }

    pub fn to_markdown(&self) -> String {
        let ordinals = self.ordinals();
        let mut out = String::new();
        let mut prev: Option<&Block> = None;
        for (index, block) in self.blocks.iter().enumerate() {
            let droppable = block.kind.is_paragraph_like() || block.kind == BlockKind::Quote;
            if droppable && block.text.is_empty() {
                continue;
            }
            if let Some(prev) = prev {
                out.push_str(separator(prev, block));
            }
            write_block(&mut out, block, ordinals.get(index).copied().flatten());
            prev = Some(block);
        }
        if !out.is_empty() {
            out.push('\n');
        }
        out
    }

    pub fn to_plain_text(&self) -> String {
        let ordinals = self.ordinals();
        let mut lines = Vec::with_capacity(self.blocks.len());
        for (index, block) in self.blocks.iter().enumerate() {
            let indent = "  ".repeat(block.indent as usize);
            let line = match &block.kind {
                BlockKind::Bullet => format!("{indent}- {}", block.text),
                BlockKind::Ordered => format!(
                    "{indent}{}. {}",
                    ordinals.get(index).copied().flatten().unwrap_or(1),
                    block.text
                ),
                BlockKind::Task { checked } => {
                    format!(
                        "{indent}[{}] {}",
                        if *checked { "x" } else { " " },
                        block.text
                    )
                }
                BlockKind::Rule => "---".to_string(),
                _ => block.text.clone(),
            };
            lines.push(line);
        }
        lines.join("\n")
    }

    pub fn to_html(&self) -> String {
        let ordinals = self.ordinals();
        let mut out = String::new();
        let mut lists: Vec<(u8, &'static str)> = Vec::new();
        let mut in_quote = false;
        for (index, block) in self.blocks.iter().enumerate() {
            if block.kind.is_list() {
                if in_quote {
                    out.push_str("</blockquote>");
                    in_quote = false;
                }
                let tag = if block.kind == BlockKind::Ordered {
                    "ol"
                } else {
                    "ul"
                };
                while let Some(&(depth, open_tag)) = lists.last() {
                    if depth > block.indent || (depth == block.indent && open_tag != tag) {
                        out.push_str(&format!("</li></{open_tag}>"));
                        lists.pop();
                    } else {
                        break;
                    }
                }
                let ordinal = ordinals.get(index).copied().flatten();
                if lists.last().map(|(depth, _)| *depth) == Some(block.indent) {
                    out.push_str("</li>");
                } else {
                    match ordinal {
                        Some(n) if n != 1 => out.push_str(&format!("<ol start=\"{n}\">")),
                        _ => {
                            out.push('<');
                            out.push_str(tag);
                            out.push('>');
                        }
                    }
                    lists.push((block.indent, tag));
                }
                match (block.start, ordinal) {
                    (Some(_), Some(n)) => out.push_str(&format!("<li value=\"{n}\">")),
                    _ => out.push_str("<li>"),
                }
                if let BlockKind::Task { checked } = block.kind {
                    out.push_str(if checked {
                        "<input type=\"checkbox\" checked disabled> "
                    } else {
                        "<input type=\"checkbox\" disabled> "
                    });
                }
                inline_html(&mut out, block);
                continue;
            }
            while let Some((_, tag)) = lists.pop() {
                out.push_str(&format!("</li></{tag}>"));
            }
            if block.kind == BlockKind::Quote {
                if !in_quote {
                    out.push_str("<blockquote>");
                    in_quote = true;
                }
            } else if in_quote {
                out.push_str("</blockquote>");
                in_quote = false;
            }
            match &block.kind {
                BlockKind::Heading(level) => {
                    out.push_str(&format!("<h{level}>"));
                    inline_html(&mut out, block);
                    out.push_str(&format!("</h{level}>"));
                }
                BlockKind::Code { language } => {
                    if language.is_empty() {
                        out.push_str("<pre><code>");
                    } else {
                        out.push_str(&format!(
                            "<pre><code class=\"language-{}\">",
                            escape_html(language)
                        ));
                    }
                    out.push_str(&escape_html(&block.text));
                    out.push_str("</code></pre>");
                }
                BlockKind::Rule => out.push_str("<hr>"),
                _ => {
                    out.push_str("<p>");
                    if block.text.is_empty() {
                        out.push_str("<br>");
                    } else {
                        inline_html(&mut out, block);
                    }
                    out.push_str("</p>");
                }
            }
        }
        while let Some((_, tag)) = lists.pop() {
            out.push_str(&format!("</li></{tag}>"));
        }
        if in_quote {
            out.push_str("</blockquote>");
        }
        out
    }
}

fn separator(prev: &Block, next: &Block) -> &'static str {
    if prev.kind.is_list() && next.kind.is_list() {
        "\n"
    } else if prev.kind == BlockKind::Quote && next.kind == BlockKind::Quote {
        "\n>\n"
    } else {
        "\n\n"
    }
}

fn escape_block_start(line: String) -> String {
    let bytes = line.as_bytes();
    let Some(&first) = bytes.first() else {
        return line;
    };
    let spaced = |at: usize| bytes.get(at).is_none_or(|b| is_ws(*b));
    if matches!(first, b'#' | b'>')
        || (matches!(first, b'-' | b'+' | b'*') && spaced(1))
        || (matches!(first, b'-' | b'_' | b'*') && is_rule(&line))
    {
        return format!("\\{line}");
    }
    let digits = bytes.iter().take_while(|b| b.is_ascii_digit()).count();
    if (1..=9).contains(&digits)
        && matches!(bytes.get(digits), Some(b'.' | b')'))
        && spaced(digits + 1)
    {
        let mut escaped = line;
        escaped.insert(digits, '\\');
        return escaped;
    }
    line
}

fn write_content(out: &mut String, prefix: &str, content: &str) {
    out.push_str(prefix);
    if !content.is_empty() {
        out.push(' ');
        out.push_str(content);
    }
}

fn write_block(out: &mut String, block: &Block, ordinal: Option<u32>) {
    let indent = INDENT_UNIT.repeat(block.indent as usize);
    match &block.kind {
        BlockKind::Paragraph | BlockKind::Unknown { .. } => {
            out.push_str(&escape_block_start(export_inline(
                &block.text,
                &block.spans,
            )));
        }
        BlockKind::Heading(level) => {
            let mut content = export_inline(&block.text, &block.spans);
            if content.ends_with('#') {
                content.insert(content.len() - 1, '\\');
            }
            write_content(out, &"#".repeat(*level as usize), &content);
        }
        BlockKind::Bullet => {
            let mut content = export_inline(&block.text, &block.spans);
            if is_rule(&format!("- {content}")) {
                content.insert(0, '\\');
            }
            write_content(out, &format!("{indent}-"), &content);
        }
        BlockKind::Ordered => write_content(
            out,
            &format!("{indent}{}.", ordinal.unwrap_or(1)),
            &export_inline(&block.text, &block.spans),
        ),
        BlockKind::Task { checked } => write_content(
            out,
            &format!("{indent}- [{}]", if *checked { "x" } else { " " }),
            &export_inline(&block.text, &block.spans),
        ),
        BlockKind::Quote => {
            write_content(out, ">", &export_inline(&block.text, &block.spans));
        }
        BlockKind::Code { language } => {
            let fence_char = b'`';
            let mut longest = 0;
            let mut current = 0;
            for b in block.text.bytes() {
                if b == fence_char {
                    current += 1;
                    longest = longest.max(current);
                } else {
                    current = 0;
                }
            }
            let fence = (fence_char as char)
                .to_string()
                .repeat((longest + 1).max(3));
            out.push_str(&fence);
            out.push_str(language);
            out.push('\n');
            if !block.text.is_empty() {
                out.push_str(&block.text);
                out.push('\n');
            }
            out.push_str(&fence);
        }
        BlockKind::Rule => out.push_str("---"),
    }
}

pub(crate) fn escape_html(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            _ => out.push(c),
        }
    }
    out
}

fn inline_html(out: &mut String, block: &Block) {
    let spans: Vec<Span> = exportable_spans(&block.text, &block.spans);
    let tidy = Block {
        text: block.text.clone(),
        spans,
        ..Block::default()
    };
    for run in tidy.runs() {
        let piece = &block.text[run.range.clone()];
        let mut close = Vec::new();
        for mark in run.marks.iter() {
            let (open, end) = match mark {
                Mark::Bold => ("<strong>".to_string(), "</strong>"),
                Mark::Italic => ("<em>".to_string(), "</em>"),
                Mark::Underline => ("<u>".to_string(), "</u>"),
                Mark::Strike => ("<s>".to_string(), "</s>"),
                Mark::Code => ("<code>".to_string(), "</code>"),
                Mark::Highlight => ("<mark>".to_string(), "</mark>"),
                Mark::Link { url } => (format!("<a href=\"{}\">", escape_html(url)), "</a>"),
                Mark::Mention { id } => (
                    format!("<span data-mention=\"{}\">", escape_html(id)),
                    "</span>",
                ),
                Mark::Unknown { .. } => continue,
            };
            out.push_str(&open);
            close.push(end);
        }
        out.push_str(&escape_html(piece));
        for end in close.iter().rev() {
            out.push_str(end);
        }
    }
}
