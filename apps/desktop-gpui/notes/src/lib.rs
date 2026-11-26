mod blocks;
mod clipboard;
mod edit;
mod editor;
mod history;
mod inline;
mod markdown;
mod model;
mod rules;
mod spans;
mod unicode;

pub use clipboard::{Match, token_ranges};
pub use edit::LinkAt;
pub use editor::{BlockChange, Change, Editor, InputRules};
pub use model::{
    Block, BlockId, BlockKind, Document, MAX_HEADING, MAX_INDENT, Mark, Origin, OutlineItem, Pos,
    SCHEMA, Selection, Span,
};
pub use spans::{MarkSet, Run};
pub use unicode::{
    clamp_to_grapheme, is_grapheme_boundary, next_grapheme, next_word, prev_grapheme, prev_word,
    word_range_at,
};

pub fn spans_are_normalized(text: &str, spans: &[Span]) -> bool {
    spans::is_normalized(text, spans)
}
