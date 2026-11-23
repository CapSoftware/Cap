use std::borrow::Cow;

pub(crate) fn decode_entities(text: &str) -> Cow<'_, str> {
    if !text.contains('&') {
        return Cow::Borrowed(text);
    }
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(idx) = rest.find('&') {
        out.push_str(&rest[..idx]);
        let after = &rest[idx + 1..];
        let end = after
            .char_indices()
            .take(12)
            .find(|(_, c)| *c == ';')
            .map(|(i, _)| i);
        let decoded = end.and_then(|end| decode_entity(&after[..end]).map(|c| (c, end)));
        match decoded {
            Some((c, end)) => {
                out.push(c);
                rest = &after[end + 1..];
            }
            None => {
                out.push('&');
                rest = after;
            }
        }
    }
    out.push_str(rest);
    Cow::Owned(out)
}

fn decode_entity(name: &str) -> Option<char> {
    if let Some(num) = name.strip_prefix('#') {
        let code = match num.strip_prefix(['x', 'X']) {
            Some(hex) => u32::from_str_radix(hex, 16).ok()?,
            None => num.parse::<u32>().ok()?,
        };
        return char::from_u32(code);
    }
    Some(match name {
        "amp" => '&',
        "lt" => '<',
        "gt" => '>',
        "quot" => '"',
        "apos" => '\'',
        "nbsp" => ' ',
        "ndash" => '-',
        "hellip" => '…',
        _ => return None,
    })
}

pub(crate) fn html_to_text(html: &str) -> String {
    let lower = html.to_ascii_lowercase();
    let mut out = String::with_capacity(html.len() / 2);
    let mut i = 0;
    let bytes = html.as_bytes();
    while i < bytes.len() {
        if bytes[i] == b'<' {
            let skip_block = ["style", "script", "head"].into_iter().find(|tag| {
                lower[i + 1..].starts_with(tag)
                    && lower[i + 1 + tag.len()..]
                        .chars()
                        .next()
                        .is_some_and(|c| c == '>' || c.is_whitespace())
            });
            if let Some(tag) = skip_block {
                let close = format!("</{tag}");
                i = match lower[i..].find(&close) {
                    Some(pos) => i + pos + close.len(),
                    None => bytes.len(),
                };
                if let Some(gt) = lower[i..].find('>') {
                    i += gt + 1;
                }
                continue;
            }
            let end = lower[i..].find('>').map_or(bytes.len(), |p| i + p + 1);
            let tag = &lower[i..end];
            if tag.starts_with("<br")
                || tag.starts_with("<p")
                || tag.starts_with("</p")
                || tag.starts_with("<div")
                || tag.starts_with("</div")
                || tag.starts_with("<li")
                || tag.starts_with("<tr")
            {
                out.push('\n');
            }
            i = end;
            continue;
        }
        let next = lower[i..].find('<').map_or(bytes.len(), |p| i + p);
        out.push_str(&html[i..next]);
        i = next;
    }
    let decoded = decode_entities(&out).replace('\u{a0}', " ");
    let mut lines: Vec<&str> = Vec::new();
    for line in decoded.lines().map(str::trim_end) {
        if line.trim().is_empty() && lines.last().is_none_or(|l| l.trim().is_empty()) {
            continue;
        }
        lines.push(line);
    }
    while lines.last().is_some_and(|l| l.trim().is_empty()) {
        lines.pop();
    }
    lines.join("\n")
}

pub(crate) fn looks_like_html(text: &str) -> bool {
    let lower = text.to_ascii_lowercase();
    [
        "<html", "<body", "<div", "<p>", "<p ", "<br", "<a ", "<span", "<table",
    ]
    .iter()
    .any(|t| lower.contains(t))
}

pub(crate) fn normalize_title(title: &str) -> String {
    let mut out = String::with_capacity(title.len());
    let mut space = false;
    for c in title.chars().flat_map(char::to_lowercase) {
        if c.is_alphanumeric() {
            if space && !out.is_empty() {
                out.push(' ');
            }
            space = false;
            out.push(c);
        } else {
            space = true;
        }
    }
    out
}

pub(crate) fn non_empty(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(str::to_string)
}
