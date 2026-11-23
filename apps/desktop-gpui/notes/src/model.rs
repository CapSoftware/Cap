use std::cmp::Ordering;
use std::collections::{BTreeMap, HashSet};
use std::ops::Range;

use serde::de::Deserializer;
use serde::ser::{SerializeMap, Serializer};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::spans::normalize_spans;

pub const SCHEMA: u32 = 1;
pub const MAX_INDENT: u8 = 7;
pub const MAX_HEADING: u8 = 3;

#[derive(
    Clone, Copy, Debug, Default, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize,
)]
#[serde(transparent)]
pub struct BlockId(pub u64);

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Document {
    pub schema: u32,
    pub kind: String,
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    pub meta: BTreeMap<String, Value>,
    pub blocks: Vec<Block>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Block {
    pub id: BlockId,
    pub kind: BlockKind,
    #[serde(skip_serializing_if = "is_zero")]
    pub indent: u8,
    pub text: String,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub spans: Vec<Span>,
    #[serde(skip_serializing_if = "Origin::is_author")]
    pub origin: Origin,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub start: Option<u32>,
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    pub attrs: BTreeMap<String, Value>,
}

fn is_zero(value: &u8) -> bool {
    *value == 0
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub enum BlockKind {
    #[default]
    Paragraph,
    Heading(u8),
    Bullet,
    Ordered,
    Task {
        checked: bool,
    },
    Quote,
    Code {
        language: String,
    },
    Rule,
    Unknown {
        kind: String,
        data: Value,
    },
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Span {
    pub range: Range<usize>,
    pub mark: Mark,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Hash)]
pub enum Mark {
    #[default]
    Bold,
    Italic,
    Underline,
    Strike,
    Code,
    Highlight,
    Link {
        url: String,
    },
    Mention {
        id: String,
    },
    Unknown {
        kind: String,
        data: Value,
    },
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Origin {
    #[default]
    Author,
    Generated,
}

impl Origin {
    pub fn is_author(&self) -> bool {
        *self == Origin::Author
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct Pos {
    pub block: usize,
    pub offset: usize,
}

impl Pos {
    pub fn new(block: usize, offset: usize) -> Self {
        Self { block, offset }
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub struct Selection {
    pub anchor: Pos,
    pub head: Pos,
}

impl Selection {
    pub fn new(anchor: Pos, head: Pos) -> Self {
        Self { anchor, head }
    }

    pub fn caret(pos: Pos) -> Self {
        Self {
            anchor: pos,
            head: pos,
        }
    }

    pub fn start(&self) -> Pos {
        self.anchor.min(self.head)
    }

    pub fn end(&self) -> Pos {
        self.anchor.max(self.head)
    }

    pub fn is_collapsed(&self) -> bool {
        self.anchor == self.head
    }

    pub fn is_reversed(&self) -> bool {
        self.head < self.anchor
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OutlineItem {
    pub block: usize,
    pub level: u8,
    pub text: String,
}

impl BlockKind {
    pub fn is_list(&self) -> bool {
        matches!(
            self,
            BlockKind::Bullet | BlockKind::Ordered | BlockKind::Task { .. }
        )
    }

    pub fn is_code(&self) -> bool {
        matches!(self, BlockKind::Code { .. })
    }

    pub fn is_rule(&self) -> bool {
        matches!(self, BlockKind::Rule)
    }

    pub fn takes_marks(&self) -> bool {
        !self.is_code() && !self.is_rule()
    }

    pub fn is_paragraph_like(&self) -> bool {
        matches!(self, BlockKind::Paragraph | BlockKind::Unknown { .. })
    }

    pub fn same_type(&self, other: &BlockKind) -> bool {
        match (self, other) {
            (BlockKind::Heading(a), BlockKind::Heading(b)) => a == b,
            (BlockKind::Task { .. }, BlockKind::Task { .. }) => true,
            (BlockKind::Code { .. }, BlockKind::Code { .. }) => true,
            (BlockKind::Unknown { kind: a, .. }, BlockKind::Unknown { kind: b, .. }) => a == b,
            _ => std::mem::discriminant(self) == std::mem::discriminant(other),
        }
    }

    fn tag(&self) -> &str {
        match self {
            BlockKind::Paragraph => "paragraph",
            BlockKind::Heading(_) => "heading",
            BlockKind::Bullet => "bullet",
            BlockKind::Ordered => "ordered",
            BlockKind::Task { .. } => "task",
            BlockKind::Quote => "quote",
            BlockKind::Code { .. } => "code",
            BlockKind::Rule => "rule",
            BlockKind::Unknown { kind, .. } => kind,
        }
    }
}

impl Mark {
    pub fn kind_eq(&self, other: &Mark) -> bool {
        match (self, other) {
            (Mark::Unknown { kind: a, .. }, Mark::Unknown { kind: b, .. }) => a == b,
            _ => std::mem::discriminant(self) == std::mem::discriminant(other),
        }
    }

    pub fn is_exclusive(&self) -> bool {
        matches!(self, Mark::Link { .. } | Mark::Mention { .. })
    }

    pub fn extends_at_end(&self) -> bool {
        matches!(
            self,
            Mark::Bold | Mark::Italic | Mark::Underline | Mark::Strike | Mark::Highlight
        )
    }

    fn rank(&self) -> u8 {
        match self {
            Mark::Bold => 0,
            Mark::Italic => 1,
            Mark::Underline => 2,
            Mark::Strike => 3,
            Mark::Code => 4,
            Mark::Highlight => 5,
            Mark::Link { .. } => 6,
            Mark::Mention { .. } => 7,
            Mark::Unknown { .. } => 8,
        }
    }

    fn tag(&self) -> &str {
        match self {
            Mark::Bold => "bold",
            Mark::Italic => "italic",
            Mark::Underline => "underline",
            Mark::Strike => "strike",
            Mark::Code => "code",
            Mark::Highlight => "highlight",
            Mark::Link { .. } => "link",
            Mark::Mention { .. } => "mention",
            Mark::Unknown { kind, .. } => kind,
        }
    }
}

impl Ord for Mark {
    fn cmp(&self, other: &Self) -> Ordering {
        self.rank()
            .cmp(&other.rank())
            .then_with(|| match (self, other) {
                (Mark::Link { url: a }, Mark::Link { url: b }) => a.cmp(b),
                (Mark::Mention { id: a }, Mark::Mention { id: b }) => a.cmp(b),
                (Mark::Unknown { kind: a, data: x }, Mark::Unknown { kind: b, data: y }) => {
                    a.cmp(b).then_with(|| x.to_string().cmp(&y.to_string()))
                }
                _ => Ordering::Equal,
            })
    }
}

impl PartialOrd for Mark {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

fn serialize_tagged<S: Serializer>(
    serializer: S,
    tag: &str,
    fields: &[(&str, Value)],
) -> Result<S::Ok, S::Error> {
    let mut map = serializer.serialize_map(Some(fields.len() + 1))?;
    map.serialize_entry("type", tag)?;
    for (key, value) in fields {
        map.serialize_entry(key, value)?;
    }
    map.end()
}

fn serialize_unknown<S: Serializer>(
    serializer: S,
    kind: &str,
    data: &Value,
) -> Result<S::Ok, S::Error> {
    match data {
        Value::Object(object) if !kind.is_empty() => {
            let mut map = serializer.serialize_map(Some(object.len() + 1))?;
            map.serialize_entry("type", kind)?;
            for (key, value) in object {
                if key != "type" {
                    map.serialize_entry(key, value)?;
                }
            }
            map.end()
        }
        other => other.serialize(serializer),
    }
}

fn split_tagged(value: Value) -> (String, Map<String, Value>, Value) {
    match value {
        Value::Object(object) => {
            let tag = object
                .get("type")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            // Copied rather than `remove`d: with serde_json's `preserve_order`
            // (which gpui turns on in the app) `remove` swaps the last field
            // into the gap, so a newer app's fields would come back reordered.
            let rest = object
                .iter()
                .filter(|(key, _)| key.as_str() != "type")
                .map(|(key, value)| (key.clone(), value.clone()))
                .collect();
            (tag, rest, Value::Object(object))
        }
        Value::String(tag) => (tag.clone(), Map::new(), Value::String(tag)),
        other => (String::new(), Map::new(), other),
    }
}

fn unknown_data(tag: &str, rest: Map<String, Value>, original: Value) -> Value {
    if tag.is_empty() || !original.is_object() {
        original
    } else {
        Value::Object(rest)
    }
}

fn str_field(fields: &Map<String, Value>, key: &str) -> String {
    fields
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
}

impl Serialize for BlockKind {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self {
            BlockKind::Heading(level) => {
                serialize_tagged(serializer, self.tag(), &[("level", Value::from(*level))])
            }
            BlockKind::Task { checked } => serialize_tagged(
                serializer,
                self.tag(),
                &[("checked", Value::from(*checked))],
            ),
            BlockKind::Code { language } => serialize_tagged(
                serializer,
                self.tag(),
                &[("language", Value::from(language.as_str()))],
            ),
            BlockKind::Unknown { kind, data } => serialize_unknown(serializer, kind, data),
            _ => serialize_tagged(serializer, self.tag(), &[]),
        }
    }
}

impl<'de> Deserialize<'de> for BlockKind {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let (tag, fields, original) = split_tagged(Value::deserialize(deserializer)?);
        Ok(match tag.as_str() {
            "paragraph" => BlockKind::Paragraph,
            "heading" => BlockKind::Heading(
                fields
                    .get("level")
                    .and_then(Value::as_u64)
                    .map_or(1, |level| level.clamp(1, MAX_HEADING as u64) as u8),
            ),
            "bullet" => BlockKind::Bullet,
            "ordered" => BlockKind::Ordered,
            "task" => BlockKind::Task {
                checked: fields
                    .get("checked")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
            },
            "quote" => BlockKind::Quote,
            "code" => BlockKind::Code {
                language: str_field(&fields, "language"),
            },
            "rule" => BlockKind::Rule,
            _ => BlockKind::Unknown {
                data: unknown_data(&tag, fields, original),
                kind: tag,
            },
        })
    }
}

impl Serialize for Mark {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self {
            Mark::Link { url } => serialize_tagged(
                serializer,
                self.tag(),
                &[("url", Value::from(url.as_str()))],
            ),
            Mark::Mention { id } => {
                serialize_tagged(serializer, self.tag(), &[("id", Value::from(id.as_str()))])
            }
            Mark::Unknown { kind, data } => serialize_unknown(serializer, kind, data),
            _ => serialize_tagged(serializer, self.tag(), &[]),
        }
    }
}

impl<'de> Deserialize<'de> for Mark {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let (tag, fields, original) = split_tagged(Value::deserialize(deserializer)?);
        Ok(match tag.as_str() {
            "bold" => Mark::Bold,
            "italic" => Mark::Italic,
            "underline" => Mark::Underline,
            "strike" => Mark::Strike,
            "code" => Mark::Code,
            "highlight" => Mark::Highlight,
            "link" => Mark::Link {
                url: str_field(&fields, "url"),
            },
            "mention" => Mark::Mention {
                id: str_field(&fields, "id"),
            },
            _ => Mark::Unknown {
                data: unknown_data(&tag, fields, original),
                kind: tag,
            },
        })
    }
}

impl Block {
    pub fn new(id: BlockId, kind: BlockKind, text: impl Into<String>) -> Self {
        let mut block = Self {
            id,
            kind,
            text: text.into(),
            ..Self::default()
        };
        block.normalize();
        block
    }

    pub fn paragraph(id: BlockId, text: impl Into<String>) -> Self {
        Self::new(id, BlockKind::Paragraph, text)
    }

    pub fn with_spans(mut self, spans: Vec<Span>) -> Self {
        self.spans = spans;
        self.normalize();
        self
    }

    pub fn with_indent(mut self, indent: u8) -> Self {
        self.indent = indent;
        self
    }

    pub fn len(&self) -> usize {
        self.text.len()
    }

    pub fn is_empty(&self) -> bool {
        self.text.is_empty()
    }

    pub fn normalize(&mut self) {
        if let BlockKind::Heading(level) = &mut self.kind {
            *level = (*level).clamp(1, MAX_HEADING);
        }
        match self.kind {
            BlockKind::Rule => {
                self.text.clear();
                self.spans.clear();
            }
            BlockKind::Code { ref mut language } => {
                if language.contains(|c: char| c.is_whitespace() || c == '`' || c == '~') {
                    language.retain(|c| !c.is_whitespace() && c != '`' && c != '~');
                }
                if self.text.contains('\r') {
                    self.text = self.text.replace("\r\n", "\n").replace('\r', "\n");
                }
                self.spans.clear();
            }
            _ => {
                if self.text.contains(['\n', '\r']) {
                    self.text = self.text.replace("\r\n", " ").replace(['\n', '\r'], " ");
                }
                normalize_spans(&self.text, &mut self.spans);
            }
        }
        if !self.kind.is_list() {
            self.indent = 0;
        }
        self.indent = self.indent.min(MAX_INDENT);
        if self.kind != BlockKind::Ordered {
            self.start = None;
        }
    }
}

impl Default for Document {
    fn default() -> Self {
        Self {
            schema: SCHEMA,
            kind: "note".to_string(),
            meta: BTreeMap::new(),
            blocks: vec![Block::paragraph(BlockId(1), "")],
        }
    }
}

impl Document {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn from_blocks(blocks: Vec<Block>) -> Self {
        let mut doc = Self {
            blocks,
            ..Self::default()
        };
        doc.normalize();
        doc
    }

    pub fn from_json(json: &str) -> Result<Self, serde_json::Error> {
        let mut doc: Document = serde_json::from_str(json)?;
        doc.normalize();
        Ok(doc)
    }

    pub fn to_json(&self) -> String {
        serde_json::to_string(self).unwrap_or_default()
    }

    pub fn max_id(&self) -> u64 {
        self.blocks
            .iter()
            .map(|block| block.id.0)
            .max()
            .unwrap_or(0)
    }

    pub fn normalize(&mut self) {
        if self.blocks.is_empty() {
            self.blocks.push(Block::paragraph(BlockId(1), ""));
        }
        let mut next = self.max_id() + 1;
        let mut seen = HashSet::new();
        for block in &mut self.blocks {
            if !seen.insert(block.id) {
                block.id = BlockId(next);
                seen.insert(block.id);
                next += 1;
            }
            block.normalize();
        }
        fix_indents(&mut self.blocks, 0, usize::MAX);
        normalize_starts(&mut self.blocks);
    }

    pub fn ordinal(&self, index: usize) -> Option<u32> {
        let block = self.blocks.get(index)?;
        if block.kind != BlockKind::Ordered {
            return None;
        }
        let mut count = 0u32;
        let mut i = index;
        loop {
            let item = &self.blocks[i];
            if item.indent == block.indent && item.kind == BlockKind::Ordered {
                if let Some(start) = item.start {
                    return Some(start.saturating_add(count));
                }
                count = count.saturating_add(1);
            }
            if i == 0 {
                return Some(count);
            }
            let prev = &self.blocks[i - 1];
            let continues = prev.kind.is_list()
                && (prev.indent > block.indent
                    || (prev.indent == block.indent && prev.kind == BlockKind::Ordered));
            if !continues {
                return Some(count);
            }
            i -= 1;
        }
    }

    pub fn ordinals(&self) -> Vec<Option<u32>> {
        let mut counters: Vec<Option<u32>> = Vec::new();
        self.blocks
            .iter()
            .map(|block| {
                if !block.kind.is_list() {
                    counters.clear();
                    return None;
                }
                let depth = block.indent as usize;
                counters.truncate(depth + 1);
                counters.resize(depth + 1, None);
                if block.kind != BlockKind::Ordered {
                    counters[depth] = None;
                    return None;
                }
                let value = match (block.start, counters[depth]) {
                    (Some(start), _) => start,
                    (None, Some(prev)) => prev.saturating_add(1),
                    (None, None) => 1,
                };
                counters[depth] = Some(value);
                Some(value)
            })
            .collect()
    }

    pub fn outline(&self) -> Vec<OutlineItem> {
        self.blocks
            .iter()
            .enumerate()
            .filter_map(|(block, item)| match item.kind {
                BlockKind::Heading(level) => Some(OutlineItem {
                    block,
                    level,
                    text: item.text.clone(),
                }),
                _ => None,
            })
            .collect()
    }

    pub fn plain_blocks(&self) -> impl Iterator<Item = (&BlockKind, u8, &str)> {
        self.blocks
            .iter()
            .map(|block| (&block.kind, block.indent, block.text.as_str()))
    }
}

pub(crate) fn max_indent_after(prev: Option<&Block>) -> u8 {
    match prev {
        Some(prev) if prev.kind.is_list() => prev.indent.saturating_add(1).min(MAX_INDENT),
        _ => 0,
    }
}

pub(crate) fn clamp_indent(prev: Option<&Block>, block: &mut Block) -> bool {
    let target = if block.kind.is_list() {
        block.indent.min(max_indent_after(prev))
    } else {
        0
    };
    let changed = target != block.indent;
    block.indent = target;
    changed
}

pub(crate) fn fix_indents(blocks: &mut [Block], from: usize, until: usize) -> usize {
    let mut i = from;
    while i < blocks.len() {
        let (head, tail) = blocks.split_at_mut(i);
        let changed = clamp_indent(head.last(), &mut tail[0]);
        if !changed && i >= until {
            break;
        }
        i += 1;
    }
    i
}

pub(crate) fn normalize_starts(blocks: &mut [Block]) {
    let mut counters: Vec<Option<u32>> = Vec::new();
    for block in blocks.iter_mut() {
        if !block.kind.is_list() {
            counters.clear();
            continue;
        }
        let depth = block.indent as usize;
        counters.truncate(depth + 1);
        counters.resize(depth + 1, None);
        if block.kind != BlockKind::Ordered {
            counters[depth] = None;
            block.start = None;
            continue;
        }
        let implied = counters[depth].map_or(1, |prev| prev.saturating_add(1));
        if block.start == Some(implied) {
            block.start = None;
        }
        counters[depth] = Some(block.start.unwrap_or(implied));
    }
}
