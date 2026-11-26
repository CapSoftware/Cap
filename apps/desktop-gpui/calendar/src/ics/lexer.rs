#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Property {
    pub name: String,
    pub params: Vec<(String, Vec<String>)>,
    pub value: String,
}

impl Property {
    pub fn param(&self, name: &str) -> Option<&str> {
        self.params
            .iter()
            .find(|(k, _)| k == name)
            .and_then(|(_, v)| v.first())
            .map(String::as_str)
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct Component {
    pub name: String,
    pub props: Vec<Property>,
    pub children: Vec<Component>,
}

impl Component {
    pub fn prop(&self, name: &str) -> Option<&Property> {
        self.props.iter().find(|p| p.name == name)
    }

    pub fn props_named<'a>(&'a self, name: &'a str) -> impl Iterator<Item = &'a Property> + 'a {
        self.props.iter().filter(move |p| p.name == name)
    }

    pub fn text(&self, name: &str) -> Option<String> {
        self.prop(name).map(|p| unescape_text(&p.value))
    }
}

pub(crate) struct Lexed {
    pub root: Component,
    pub warnings: Vec<String>,
}

const MAX_DEPTH: usize = 16;

pub(crate) fn unfold(text: &str) -> Vec<String> {
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    let mut lines: Vec<String> = Vec::new();
    for raw in text.split('\n') {
        let line = raw.strip_suffix('\r').unwrap_or(raw);
        if let Some(rest) = line.strip_prefix([' ', '\t']) {
            if let Some(last) = lines.last_mut() {
                last.push_str(rest);
                continue;
            }
            if rest.trim().is_empty() {
                continue;
            }
            lines.push(rest.to_string());
            continue;
        }
        if line.is_empty() {
            continue;
        }
        lines.push(line.to_string());
    }
    lines
}

pub(crate) fn parse_content_line(line: &str) -> Option<Property> {
    let mut name_end = None;
    for (i, c) in line.char_indices() {
        if c == ';' || c == ':' {
            name_end = Some(i);
            break;
        }
    }
    let name_end = name_end?;
    let name = line[..name_end].trim().to_ascii_uppercase();
    if name.is_empty() {
        return None;
    }
    let mut params = Vec::new();
    let mut rest = &line[name_end..];
    while let Some(after) = rest.strip_prefix(';') {
        let eq = after.find(['=', ':', ';'])?;
        if after.as_bytes()[eq] != b'=' {
            rest = &after[eq..];
            continue;
        }
        let key = after[..eq].trim().to_ascii_uppercase();
        let mut values = Vec::new();
        let mut cursor = &after[eq + 1..];
        loop {
            if let Some(quoted) = cursor.strip_prefix('"') {
                let close = quoted.find('"').unwrap_or(quoted.len());
                values.push(quoted[..close].to_string());
                cursor = quoted.get(close + 1..).unwrap_or("");
            } else {
                let end = cursor.find([',', ';', ':']).unwrap_or(cursor.len());
                values.push(cursor[..end].to_string());
                cursor = &cursor[end..];
            }
            match cursor.strip_prefix(',') {
                Some(next) => cursor = next,
                None => break,
            }
        }
        params.push((key, values));
        rest = cursor;
        if !rest.starts_with(';') && !rest.starts_with(':') {
            let skip = rest.find([';', ':'])?;
            rest = &rest[skip..];
        }
    }
    let value = rest.strip_prefix(':')?;
    Some(Property {
        name,
        params,
        value: value.to_string(),
    })
}

pub(crate) fn lex(text: &str) -> Lexed {
    let mut warnings = Vec::new();
    let mut stack: Vec<Component> = vec![Component {
        name: "ROOT".to_string(),
        ..Component::default()
    }];
    for line in unfold(text) {
        let Some(prop) = parse_content_line(&line) else {
            warnings.push(format!("unparseable line: {}", truncate(&line)));
            continue;
        };
        match prop.name.as_str() {
            "BEGIN" => {
                let name = prop.value.trim().to_ascii_uppercase();
                if stack.len() > MAX_DEPTH {
                    warnings.push(format!("component nesting too deep at {name}"));
                    continue;
                }
                stack.push(Component {
                    name,
                    ..Component::default()
                });
            }
            "END" => {
                let name = prop.value.trim().to_ascii_uppercase();
                let Some(pos) = stack.iter().skip(1).rposition(|c| c.name == name) else {
                    warnings.push(format!("END:{name} without BEGIN"));
                    continue;
                };
                let target = pos + 1;
                while stack.len() > target {
                    let Some(done) = stack.pop() else { break };
                    if stack.len() > target {
                        warnings.push(format!("component {} not closed", done.name));
                    }
                    if let Some(parent) = stack.last_mut() {
                        parent.children.push(done);
                    }
                }
            }
            _ => {
                if let Some(current) = stack.last_mut() {
                    current.props.push(prop);
                }
            }
        }
    }
    while stack.len() > 1 {
        let Some(done) = stack.pop() else { break };
        warnings.push(format!(
            "component {} not closed at end of input",
            done.name
        ));
        if let Some(parent) = stack.last_mut() {
            parent.children.push(done);
        }
    }
    let root = stack.pop().unwrap_or_default();
    Lexed { root, warnings }
}

fn truncate(line: &str) -> String {
    line.chars().take(60).collect()
}

pub(crate) fn unescape_text(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    let mut chars = value.chars();
    while let Some(c) = chars.next() {
        if c != '\\' {
            out.push(c);
            continue;
        }
        match chars.next() {
            Some('n' | 'N') => out.push('\n'),
            Some(',') => out.push(','),
            Some(';') => out.push(';'),
            Some('\\') => out.push('\\'),
            Some(':') => out.push(':'),
            Some(other) => {
                out.push('\\');
                out.push(other);
            }
            None => out.push('\\'),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unfolds_crlf_lf_space_and_tab() {
        let text =
            "BEGIN:VEVENT\r\nSUMMARY:Quarterly \r\n planning\r\nDESCRIPTION:a\n\tb\nEND:VEVENT\r\n";
        let lines = unfold(text);
        assert_eq!(
            lines,
            vec![
                "BEGIN:VEVENT",
                "SUMMARY:Quarterly planning",
                "DESCRIPTION:ab",
                "END:VEVENT"
            ]
        );
    }

    #[test]
    fn parses_quoted_params_with_separators() {
        let prop = parse_content_line(
            "ATTENDEE;CN=\"Doe, Jane: PM\";PARTSTAT=ACCEPTED;DELEGATED-FROM=\"mailto:a@x.com\",\"mailto:b@x.com\":mailto:jane@x.com",
        )
        .unwrap();
        assert_eq!(prop.name, "ATTENDEE");
        assert_eq!(prop.param("CN"), Some("Doe, Jane: PM"));
        assert_eq!(prop.param("PARTSTAT"), Some("ACCEPTED"));
        assert_eq!(
            prop.params[2].1,
            vec!["mailto:a@x.com".to_string(), "mailto:b@x.com".to_string()]
        );
        assert_eq!(prop.value, "mailto:jane@x.com");
    }

    #[test]
    fn value_keeps_colons() {
        let prop = parse_content_line("URL;VALUE=URI:https://example.com:8443/a?b=c").unwrap();
        assert_eq!(prop.value, "https://example.com:8443/a?b=c");
        assert_eq!(prop.param("VALUE"), Some("URI"));
    }

    #[test]
    fn rejects_lines_without_value() {
        assert!(parse_content_line("JUSTTEXT").is_none());
        assert!(parse_content_line(":value").is_none());
        assert!(parse_content_line("X;CN=\"unterminated").is_none());
    }

    #[test]
    fn unescapes_text() {
        assert_eq!(
            unescape_text("Line one\\nLine two\\, with comma\\; semi \\\\ backslash\\N"),
            "Line one\nLine two, with comma; semi \\ backslash\n"
        );
        assert_eq!(unescape_text("trailing\\"), "trailing\\");
    }

    #[test]
    fn lex_recovers_from_mismatched_components() {
        let lexed = lex(
            "BEGIN:VCALENDAR\nBEGIN:VEVENT\nUID:1\nBEGIN:VALARM\nEND:VEVENT\nEND:BOGUS\nBEGIN:VEVENT\nUID:2\n",
        );
        let cal = &lexed.root.children[0];
        assert_eq!(cal.children.len(), 2);
        assert_eq!(cal.children[0].prop("UID").unwrap().value, "1");
        assert_eq!(cal.children[1].prop("UID").unwrap().value, "2");
        assert!(lexed.warnings.len() >= 3);
    }
}
