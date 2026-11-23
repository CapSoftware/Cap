//! Smart folders: a name plus rules ("title contains standup", "speaker is
//! Ana", "longer than 30 minutes"), matched against every item.
//!
//! Rules are data, saved as JSON next to the rest of Cap's settings. A rule
//! this build does not understand (written by a newer Cap) is kept byte for
//! byte and never matches, so an older build can open a newer file without
//! losing anything.

use std::collections::HashMap;

use chrono::{DateTime, Duration, NaiveDate, Utc};
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use serde_json::Value;

use super::items::{Item, ItemKind};
use super::text::{contains, fold};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Matching {
    #[default]
    All,
    Any,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TextOp {
    Contains,
    DoesNotContain,
    Is,
    StartsWith,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum IsOp {
    Is,
    IsNot,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum LengthOp {
    LongerThan,
    ShorterThan,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Content {
    Transcript,
    Summary,
    Notes,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum DateRange {
    Today,
    LastDays { days: u32 },
    After { date: NaiveDate },
    Before { date: NaiveDate },
    Between { from: NaiveDate, to: NaiveDate },
}

/// One condition. Unknown rules round-trip untouched.
#[derive(Clone, Debug, PartialEq)]
pub enum Rule {
    Title { op: TextOp, value: String },
    Person { op: TextOp, value: String },
    App { op: TextOp, value: String },
    Kind { op: IsOp, value: ItemKind },
    Date { range: DateRange },
    Length { op: LengthOp, minutes: u32 },
    Has { what: Content, value: bool },
    Folder { op: IsOp, id: String },
    Pinned { value: bool },
    Unknown(Value),
}

/// The serde shape of the known rules; [`Rule`] adds the unknown arm.
#[derive(Serialize, Deserialize)]
#[serde(tag = "field", rename_all = "camelCase")]
enum KnownRule {
    Title { op: TextOp, value: String },
    Person { op: TextOp, value: String },
    App { op: TextOp, value: String },
    Kind { op: IsOp, value: ItemKind },
    Date { range: DateRange },
    Length { op: LengthOp, minutes: u32 },
    Has { what: Content, value: bool },
    Folder { op: IsOp, id: String },
    Pinned { value: bool },
}

impl From<KnownRule> for Rule {
    fn from(rule: KnownRule) -> Self {
        match rule {
            KnownRule::Title { op, value } => Rule::Title { op, value },
            KnownRule::Person { op, value } => Rule::Person { op, value },
            KnownRule::App { op, value } => Rule::App { op, value },
            KnownRule::Kind { op, value } => Rule::Kind { op, value },
            KnownRule::Date { range } => Rule::Date { range },
            KnownRule::Length { op, minutes } => Rule::Length { op, minutes },
            KnownRule::Has { what, value } => Rule::Has { what, value },
            KnownRule::Folder { op, id } => Rule::Folder { op, id },
            KnownRule::Pinned { value } => Rule::Pinned { value },
        }
    }
}

impl Serialize for Rule {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let known = match self.clone() {
            Rule::Title { op, value } => KnownRule::Title { op, value },
            Rule::Person { op, value } => KnownRule::Person { op, value },
            Rule::App { op, value } => KnownRule::App { op, value },
            Rule::Kind { op, value } => KnownRule::Kind { op, value },
            Rule::Date { range } => KnownRule::Date { range },
            Rule::Length { op, minutes } => KnownRule::Length { op, minutes },
            Rule::Has { what, value } => KnownRule::Has { what, value },
            Rule::Folder { op, id } => KnownRule::Folder { op, id },
            Rule::Pinned { value } => KnownRule::Pinned { value },
            Rule::Unknown(value) => return value.serialize(serializer),
        };
        known.serialize(serializer)
    }
}

impl<'de> Deserialize<'de> for Rule {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let value = Value::deserialize(deserializer)?;
        Ok(match KnownRule::deserialize(&value) {
            Ok(known) => known.into(),
            Err(_) => Rule::Unknown(value),
        })
    }
}

impl Rule {
    /// Whether the rule's value is typed text (and so needs a text field).
    pub fn takes_text(&self) -> bool {
        matches!(
            self,
            Rule::Title { .. } | Rule::Person { .. } | Rule::App { .. }
        )
    }

    /// The next field in the sheet's field menu, keeping the typed text when
    /// both fields take text. The cycle comes back round to Title.
    pub fn next_field(&self, text: String) -> Rule {
        match self {
            Rule::Title { op, .. } => Rule::Person {
                op: *op,
                value: text,
            },
            Rule::Person { op, .. } => Rule::App {
                op: *op,
                value: text,
            },
            Rule::App { .. } => Rule::Kind {
                op: IsOp::Is,
                value: ItemKind::Meeting,
            },
            Rule::Kind { .. } => Rule::Date {
                range: DateRange::LastDays { days: 7 },
            },
            Rule::Date { .. } => Rule::Length {
                op: LengthOp::LongerThan,
                minutes: 30,
            },
            Rule::Length { .. } => Rule::Has {
                what: Content::Transcript,
                value: true,
            },
            _ => Rule::Title {
                op: TextOp::Contains,
                value: text,
            },
        }
    }

    /// A rule still being written (no text yet) takes no part in matching.
    pub fn is_complete(&self) -> bool {
        match self {
            Rule::Title { value, .. } | Rule::Person { value, .. } | Rule::App { value, .. } => {
                !fold(value).is_empty()
            }
            Rule::Folder { id, .. } => !id.is_empty(),
            Rule::Date {
                range: DateRange::Between { from, to },
            } => from <= to,
            Rule::Unknown(_) => true,
            _ => true,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SmartFolder {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub matching: Matching,
    #[serde(default)]
    pub rules: Vec<Rule>,
    #[serde(flatten)]
    pub extra: serde_json::Map<String, Value>,
}

/// A smart folder's rules, folded once so matching thousands of items is a
/// handful of `str::contains` calls each.
#[derive(Clone, Debug)]
pub struct Compiled {
    matching: Matching,
    rules: Vec<CompiledRule>,
}

#[derive(Clone, Debug)]
enum CompiledRule {
    Text {
        field: TextField,
        op: TextOp,
        needle: String,
    },
    Kind {
        op: IsOp,
        value: ItemKind,
    },
    Date {
        from: Option<NaiveDate>,
        to: Option<NaiveDate>,
    },
    Length {
        op: LengthOp,
        ms: u64,
    },
    Has {
        what: Content,
        value: bool,
    },
    Folder {
        op: IsOp,
        id: String,
    },
    Pinned(bool),
    Never,
}

#[derive(Clone, Copy, Debug)]
enum TextField {
    Title,
    Person,
    App,
}

/// What matching needs besides the item: today's date in the person's time
/// zone, and which manual folders hold which items.
pub struct EvalContext<'a> {
    pub today: NaiveDate,
    /// The person's calendar day of a moment, with that date's own offset.
    pub local_day: &'a dyn Fn(DateTime<Utc>) -> NaiveDate,
    /// Manual folder membership: does folder `id` hold this item?
    pub in_folder: &'a dyn Fn(&str, &Item) -> bool,
}

impl SmartFolder {
    pub fn compile(&self, today: NaiveDate) -> Compiled {
        let rules = self
            .rules
            .iter()
            .filter(|rule| rule.is_complete())
            .map(|rule| compile_rule(rule, today))
            .collect();
        Compiled {
            matching: self.matching,
            rules,
        }
    }
}

fn compile_rule(rule: &Rule, today: NaiveDate) -> CompiledRule {
    let text = |field, op: &TextOp, value: &str| CompiledRule::Text {
        field,
        op: *op,
        needle: fold(value),
    };
    match rule {
        Rule::Title { op, value } => text(TextField::Title, op, value),
        Rule::Person { op, value } => text(TextField::Person, op, value),
        Rule::App { op, value } => text(TextField::App, op, value),
        Rule::Kind { op, value } => CompiledRule::Kind {
            op: *op,
            value: *value,
        },
        Rule::Date { range } => {
            let (from, to) = match *range {
                DateRange::Today => (Some(today), Some(today)),
                DateRange::LastDays { days } => {
                    let days = i64::from(days.max(1)) - 1;
                    (today.checked_sub_signed(Duration::days(days)), Some(today))
                }
                DateRange::After { date } => (Some(date), None),
                DateRange::Before { date } => (None, Some(date)),
                DateRange::Between { from, to } => (Some(from), Some(to)),
            };
            CompiledRule::Date { from, to }
        }
        Rule::Length { op, minutes } => CompiledRule::Length {
            op: *op,
            ms: u64::from(*minutes) * 60_000,
        },
        Rule::Has { what, value } => CompiledRule::Has {
            what: *what,
            value: *value,
        },
        Rule::Folder { op, id } => CompiledRule::Folder {
            op: *op,
            id: id.clone(),
        },
        Rule::Pinned { value } => CompiledRule::Pinned(*value),
        Rule::Unknown(_) => CompiledRule::Never,
    }
}

fn text_matches(op: TextOp, haystack: &str, needle: &str) -> bool {
    match op {
        TextOp::Contains => contains(haystack, needle),
        TextOp::DoesNotContain => !contains(haystack, needle),
        TextOp::Is => haystack == needle,
        TextOp::StartsWith => {
            haystack.starts_with(needle)
                || haystack
                    .split(' ')
                    .skip(1)
                    .any(|word| word.starts_with(needle))
        }
    }
}

impl Compiled {
    /// Whether the folder has any rule that takes part in matching. A folder
    /// with none shows nothing rather than everything.
    #[cfg(test)]
    pub fn is_empty(&self) -> bool {
        self.rules.is_empty()
    }

    pub fn matches(&self, item: &Item, cx: &EvalContext<'_>) -> bool {
        if self.rules.is_empty() || item.trashed {
            return false;
        }
        let test = |rule: &CompiledRule| rule_matches(rule, item, cx);
        match self.matching {
            Matching::All => self.rules.iter().all(test),
            Matching::Any => self.rules.iter().any(test),
        }
    }
}

fn rule_matches(rule: &CompiledRule, item: &Item, cx: &EvalContext<'_>) -> bool {
    match rule {
        CompiledRule::Text { field, op, needle } => match field {
            TextField::Title => text_matches(*op, item.folded_title(), needle),
            TextField::App => text_matches(*op, item.folded_app(), needle),
            TextField::Person => {
                let mut people = item.folded_people();
                match op {
                    // "speaker does not contain Ana" = nobody in the meeting
                    // is Ana, not "someone other than Ana was there".
                    TextOp::DoesNotContain => !people.any(|p| contains(p, needle)),
                    _ => people.any(|p| text_matches(*op, p, needle)),
                }
            }
        },
        CompiledRule::Kind { op, value } => (item.kind == *value) == (*op == IsOp::Is),
        CompiledRule::Date { from, to } => {
            let local = (cx.local_day)(item.at);
            from.is_none_or(|from| local >= from) && to.is_none_or(|to| local <= to)
        }
        CompiledRule::Length { op, ms } => match item.duration_ms {
            Some(duration) => match op {
                LengthOp::LongerThan => duration > *ms,
                LengthOp::ShorterThan => duration < *ms,
            },
            None => false,
        },
        CompiledRule::Has { what, value } => {
            let has = match what {
                Content::Transcript => item.has_transcript,
                Content::Summary => item.has_summary,
                Content::Notes => item.has_notes,
            };
            has == *value
        }
        CompiledRule::Folder { op, id } => (cx.in_folder)(id, item) == (*op == IsOp::Is),
        CompiledRule::Pinned(value) => item.pinned == *value,
        CompiledRule::Never => false,
    }
}

/// Counts and members for every smart folder in one pass over the items.
/// Members are item indexes, newest first because items are.
pub fn evaluate_all(
    folders: &[SmartFolder],
    items: &[Item],
    cx: &EvalContext<'_>,
) -> HashMap<String, Vec<u32>> {
    let compiled: Vec<(String, Compiled)> = folders
        .iter()
        .map(|f| (f.id.clone(), f.compile(cx.today)))
        .collect();
    let mut out: HashMap<String, Vec<u32>> = compiled
        .iter()
        .map(|(id, _)| (id.clone(), Vec::new()))
        .collect();
    for (index, item) in items.iter().enumerate() {
        for (id, rules) in &compiled {
            if rules.matches(item, cx)
                && let Some(members) = out.get_mut(id)
            {
                members.push(index as u32);
            }
        }
    }
    out
}

#[cfg(test)]
mod tests;
