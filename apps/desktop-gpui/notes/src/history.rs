use std::collections::VecDeque;

use crate::model::{Block, Selection};

pub(crate) const MAX_STEPS: usize = 500;

#[derive(Clone, Debug)]
pub(crate) struct Op {
    pub at: usize,
    pub remove: usize,
    pub insert: Vec<Block>,
}

#[derive(Clone, Debug)]
pub(crate) struct Step {
    pub ops: Vec<Op>,
    pub before: Selection,
    pub after: Selection,
    pub typing: bool,
}

#[derive(Clone, Debug, Default)]
pub(crate) struct History {
    undo: VecDeque<Step>,
    redo: Vec<Step>,
    open: bool,
}

impl History {
    pub fn push(&mut self, step: Step, keep_open: bool) {
        self.redo.clear();
        let foldable = step.typing && self.open && step.ops.len() == 1;
        if foldable
            && let Some(last) = self.undo.back_mut()
            && last.typing
            && last.after == step.before
            && let (Some(prev), Some(op)) = (last.ops.first(), step.ops.first())
            && op.remove == 1
            && op.insert.len() == 1
            && op.at >= prev.at
            && op.at < prev.at + prev.remove
        {
            last.after = step.after;
            self.open = keep_open;
            return;
        }
        self.undo.push_back(step);
        while self.undo.len() > MAX_STEPS {
            self.undo.pop_front();
        }
        self.open = keep_open;
    }

    pub fn break_group(&mut self) {
        self.open = false;
    }

    pub fn pop_undo(&mut self) -> Option<Step> {
        self.open = false;
        self.undo.pop_back()
    }

    pub fn pop_redo(&mut self) -> Option<Step> {
        self.open = false;
        self.redo.pop()
    }

    pub fn push_redo(&mut self, step: Step) {
        self.redo.push(step);
    }

    pub fn push_undo_after_redo(&mut self, step: Step) {
        self.undo.push_back(step);
        while self.undo.len() > MAX_STEPS {
            self.undo.pop_front();
        }
    }

    pub fn last_mut(&mut self) -> Option<&mut Step> {
        self.undo.back_mut()
    }

    pub fn can_undo(&self) -> bool {
        !self.undo.is_empty()
    }

    pub fn can_redo(&self) -> bool {
        !self.redo.is_empty()
    }

    pub fn len(&self) -> usize {
        self.undo.len()
    }

    pub fn clear(&mut self) {
        self.undo.clear();
        self.redo.clear();
        self.open = false;
    }
}
