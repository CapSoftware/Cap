pub(crate) const FEED_BUDGET: u64 = 3_000_000;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Budget {
    left: u64,
}

impl Budget {
    pub fn new(left: u64) -> Self {
        Self { left }
    }

    #[cfg(test)]
    pub fn left(&self) -> u64 {
        self.left
    }

    pub fn can_afford(&self, cost: u64) -> bool {
        self.left >= cost
    }

    pub fn charge(&mut self, cost: u64) {
        self.left = self.left.saturating_sub(cost);
    }
}
