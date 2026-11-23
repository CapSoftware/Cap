fn fence_marker(line: &str) -> Option<(char, usize)> {
    let trimmed = line.trim_start_matches(' ');
    if line.len() - trimmed.len() > 3 {
        return None;
    }
    let ch = trimmed.chars().next()?;
    if ch != '`' && ch != '~' {
        return None;
    }
    let run = trimmed.chars().take_while(|c| *c == ch).count();
    (run >= 3).then_some((ch, run))
}

fn closes_block(line: &str) -> bool {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return true;
    }
    let hashes = trimmed.chars().take_while(|c| *c == '#').count();
    if (1..=6).contains(&hashes) && trimmed[hashes..].starts_with(' ') {
        return true;
    }
    let compact: String = trimmed.chars().filter(|c| !c.is_whitespace()).collect();
    compact.len() >= 3
        && ['-', '*', '_']
            .iter()
            .any(|marker| compact.chars().all(|c| c == *marker))
}

/// The length of the longest prefix of streamed markdown that ends on a block
/// boundary no later chunk can change: after a blank line, a heading, a rule
/// or a closed code fence, outside any open fence.
pub(crate) fn settled_prefix(markdown: &str) -> usize {
    let mut fence: Option<(char, usize)> = None;
    let mut settled = 0;
    let mut offset = 0;
    for line in markdown.split_inclusive('\n') {
        let complete = line.ends_with('\n');
        let content = line.trim_end_matches('\n');
        offset += line.len();
        if !complete {
            break;
        }
        match fence {
            Some((ch, len)) => {
                if let Some((close, run)) = fence_marker(content)
                    && close == ch
                    && run >= len
                    && content
                        .trim_start()
                        .chars()
                        .skip(run)
                        .all(char::is_whitespace)
                {
                    fence = None;
                    settled = offset;
                }
            }
            None => {
                if let Some(marker) = fence_marker(content) {
                    fence = Some(marker);
                } else if closes_block(content) {
                    settled = offset;
                }
            }
        }
    }
    settled
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_unfinished_paragraph_is_never_settled() {
        assert_eq!(settled_prefix("Hello wor"), 0);
        assert_eq!(settled_prefix("Hello world\n"), 0);
        assert_eq!(settled_prefix("Hello world\nmore"), 0);
    }

    #[test]
    fn a_blank_line_settles_everything_before_it() {
        let md = "First paragraph\n\nSecond";
        assert_eq!(settled_prefix(md), "First paragraph\n\n".len());
    }

    #[test]
    fn headings_and_rules_settle_on_their_newline() {
        assert_eq!(settled_prefix("# Title\nBody"), "# Title\n".len());
        assert_eq!(settled_prefix("text\n---\nmore"), "text\n---\n".len());
    }

    #[test]
    fn nothing_inside_an_open_fence_settles() {
        let md = "```rust\nfn main() {}\n\nlet x = 1;\n";
        assert_eq!(settled_prefix(md), 0);
        let closed = "```rust\nfn main() {}\n```\nafter";
        assert_eq!(settled_prefix(closed), "```rust\nfn main() {}\n```\n".len());
    }
}
