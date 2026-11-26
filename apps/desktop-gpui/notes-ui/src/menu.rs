use gpui::SharedString;

use crate::theme::NotesLabels;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SlashItem {
    pub id: SharedString,
    pub label: SharedString,
    pub keywords: Vec<SharedString>,
}

impl SlashItem {
    pub fn new(id: impl Into<SharedString>, label: impl Into<SharedString>) -> Self {
        Self {
            id: id.into(),
            label: label.into(),
            keywords: Vec::new(),
        }
    }

    pub fn with_keywords(mut self, keywords: Vec<SharedString>) -> Self {
        self.keywords = keywords;
        self
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Builtin {
    Text,
    Heading1,
    Heading2,
    Heading3,
    Bullet,
    Numbered,
    Checkbox,
    Quote,
    Code,
    Divider,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum SlashAction {
    Builtin(Builtin),
    Host(usize),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Entry {
    pub action: SlashAction,
    pub label: SharedString,
}

const BUILTINS: [(Builtin, &[&str]); 10] = [
    (Builtin::Text, &["paragraph", "plain", "body"]),
    (Builtin::Heading1, &["h1", "title", "heading"]),
    (Builtin::Heading2, &["h2", "subtitle", "heading"]),
    (Builtin::Heading3, &["h3", "heading"]),
    (Builtin::Bullet, &["ul", "unordered", "list", "-"]),
    (Builtin::Numbered, &["ol", "ordered", "list", "1."]),
    (Builtin::Checkbox, &["todo", "task", "check", "[]"]),
    (Builtin::Quote, &["blockquote", "citation", ">"]),
    (Builtin::Code, &["pre", "snippet", "```"]),
    (
        Builtin::Divider,
        &["hr", "rule", "line", "separator", "---"],
    ),
];

pub(crate) fn builtin_label(builtin: Builtin, labels: &NotesLabels) -> SharedString {
    match builtin {
        Builtin::Text => labels.slash_text.clone(),
        Builtin::Heading1 => labels.slash_heading_1.clone(),
        Builtin::Heading2 => labels.slash_heading_2.clone(),
        Builtin::Heading3 => labels.slash_heading_3.clone(),
        Builtin::Bullet => labels.slash_bullet_list.clone(),
        Builtin::Numbered => labels.slash_numbered_list.clone(),
        Builtin::Checkbox => labels.slash_checkbox.clone(),
        Builtin::Quote => labels.slash_quote.clone(),
        Builtin::Code => labels.slash_code_block.clone(),
        Builtin::Divider => labels.slash_divider.clone(),
    }
}

pub(crate) fn score(query: &str, label: &str, keywords: &[&str]) -> Option<u32> {
    if query.is_empty() {
        return Some(0);
    }
    let query = query.to_lowercase();
    let label = label.to_lowercase();
    if label.starts_with(&query) {
        return Some(0);
    }
    if label
        .split_whitespace()
        .any(|word| word.starts_with(&query))
    {
        return Some(1);
    }
    if label.contains(&query) {
        return Some(2);
    }
    if keywords
        .iter()
        .any(|keyword| keyword.to_lowercase().starts_with(&query))
    {
        return Some(3);
    }
    let mut chars = label.chars();
    let subsequence = query
        .chars()
        .filter(|c| !c.is_whitespace())
        .all(|wanted| chars.any(|c| c == wanted));
    subsequence.then_some(4)
}

pub(crate) fn filter(query: &str, labels: &NotesLabels, extra: &[SlashItem]) -> Vec<Entry> {
    let mut scored: Vec<(u32, usize, Entry)> = Vec::new();
    for (order, (builtin, keywords)) in BUILTINS.iter().enumerate() {
        let label = builtin_label(*builtin, labels);
        if let Some(score) = score(query, &label, keywords) {
            scored.push((
                score,
                order,
                Entry {
                    action: SlashAction::Builtin(*builtin),
                    label,
                },
            ));
        }
    }
    for (index, item) in extra.iter().enumerate() {
        let keywords: Vec<&str> = item.keywords.iter().map(|k| k.as_ref()).collect();
        if let Some(score) = score(query, &item.label, &keywords) {
            scored.push((
                score,
                BUILTINS.len() + index,
                Entry {
                    action: SlashAction::Host(index),
                    label: item.label.clone(),
                },
            ));
        }
    }
    scored.sort_by_key(|(score, order, _)| (*score, *order));
    scored.into_iter().map(|(_, _, entry)| entry).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn labels_of(query: &str) -> Vec<String> {
        filter(query, &NotesLabels::default(), &[])
            .into_iter()
            .map(|entry| entry.label.to_string())
            .collect()
    }

    #[test]
    fn an_empty_query_lists_every_builtin_in_order() {
        assert_eq!(
            labels_of(""),
            vec![
                "Text",
                "Heading 1",
                "Heading 2",
                "Heading 3",
                "Bullet list",
                "Numbered list",
                "Checkbox",
                "Quote",
                "Code block",
                "Divider"
            ]
        );
    }

    #[test]
    fn prefix_matches_rank_before_fuzzy_ones() {
        assert_eq!(
            labels_of("he")[..3],
            ["Heading 1", "Heading 2", "Heading 3"]
        );
        assert_eq!(labels_of("code")[0], "Code block");
        assert_eq!(labels_of("todo"), vec!["Checkbox"]);
        assert_eq!(labels_of("hr"), vec!["Divider"]);
        assert!(labels_of("zzz").is_empty());
    }

    #[test]
    fn subsequences_match_fuzzily() {
        assert_eq!(labels_of("bllst"), vec!["Bullet list"]);
    }

    #[test]
    fn host_items_follow_the_builtins() {
        let extra = [SlashItem::new("standup", "Standup template")];
        let entries = filter("", &NotesLabels::default(), &extra);
        assert_eq!(entries.last().unwrap().action, SlashAction::Host(0));
        let entries = filter("stand", &NotesLabels::default(), &extra);
        assert_eq!(entries[0].action, SlashAction::Host(0));
    }
}
