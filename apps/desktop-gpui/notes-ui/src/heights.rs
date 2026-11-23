use std::ops::Range;

#[derive(Clone, Debug, Default)]
pub(crate) struct HeightIndex {
    values: Vec<f64>,
    tree: Vec<f64>,
}

fn lowbit(i: usize) -> usize {
    // `isolate_lowest_one` is not stable on the CI toolchain (1.95).
    i & i.wrapping_neg()
}

impl HeightIndex {
    pub fn from_values(values: impl IntoIterator<Item = f32>) -> Self {
        let mut index = Self {
            values: values.into_iter().map(f64::from).collect(),
            tree: Vec::new(),
        };
        index.rebuild();
        index
    }

    fn rebuild(&mut self) {
        let n = self.values.len();
        self.tree.clear();
        self.tree.resize(n + 1, 0.);
        for i in 1..=n {
            self.tree[i] += self.values[i - 1];
            let j = i + lowbit(i);
            if j <= n {
                let carried = self.tree[i];
                self.tree[j] += carried;
            }
        }
    }

    #[cfg(test)]
    pub fn len(&self) -> usize {
        self.values.len()
    }

    pub fn set(&mut self, index: usize, value: f32) {
        let Some(slot) = self.values.get_mut(index) else {
            return;
        };
        let value = f64::from(value);
        let delta = value - *slot;
        if delta == 0. {
            return;
        }
        *slot = value;
        let mut i = index + 1;
        while i < self.tree.len() {
            self.tree[i] += delta;
            i += lowbit(i);
        }
    }

    pub fn prefix(&self, end: usize) -> f32 {
        let mut i = end.min(self.values.len());
        let mut sum = 0.;
        while i > 0 {
            sum += self.tree[i];
            i -= lowbit(i);
        }
        sum as f32
    }

    pub fn total(&self) -> f32 {
        self.prefix(self.values.len())
    }

    pub fn find(&self, y: f32) -> (usize, f32) {
        let n = self.values.len();
        if n == 0 {
            return (0, y);
        }
        let y = f64::from(y);
        let mut pos = 0usize;
        let mut remaining = y;
        let mut step = n.next_power_of_two();
        while step > 0 {
            let next = pos + step;
            if next <= n && self.tree[next] <= remaining {
                pos = next;
                remaining -= self.tree[next];
            }
            step >>= 1;
        }
        if pos >= n {
            let last = n - 1;
            let offset = y - f64::from(self.prefix(last));
            return (last, offset as f32);
        }
        (pos, remaining as f32)
    }

    pub fn splice(&mut self, range: Range<usize>, values: impl IntoIterator<Item = f32>) {
        let start = range.start.min(self.values.len());
        let end = range.end.clamp(start, self.values.len());
        let new: Vec<f64> = values.into_iter().map(f64::from).collect();
        if new.len() == end - start {
            for (offset, value) in new.into_iter().enumerate() {
                self.set(start + offset, value as f32);
            }
            return;
        }
        self.values.splice(start..end, new);
        self.rebuild();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn naive_prefix(values: &[f32], end: usize) -> f32 {
        values[..end].iter().sum()
    }

    #[test]
    fn prefix_sums_match_a_naive_sum() {
        let values: Vec<f32> = (0..37).map(|i| (i % 7) as f32 * 3.5 + 1.).collect();
        let index = HeightIndex::from_values(values.clone());
        for end in 0..=values.len() {
            assert!((index.prefix(end) - naive_prefix(&values, end)).abs() < 1e-3);
        }
    }

    #[test]
    fn set_updates_every_later_prefix() {
        let mut values: Vec<f32> = vec![10.; 20];
        let mut index = HeightIndex::from_values(values.clone());
        index.set(5, 42.);
        values[5] = 42.;
        for end in 0..=values.len() {
            assert!((index.prefix(end) - naive_prefix(&values, end)).abs() < 1e-3);
        }
    }

    #[test]
    fn find_returns_the_block_under_an_offset() {
        let index = HeightIndex::from_values([10., 20., 30.]);
        assert_eq!(index.find(0.), (0, 0.));
        assert_eq!(index.find(9.5), (0, 9.5));
        assert_eq!(index.find(10.), (1, 0.));
        assert_eq!(index.find(29.), (1, 19.));
        assert_eq!(index.find(30.), (2, 0.));
        assert_eq!(index.find(100.), (2, 70.));
    }

    #[test]
    fn splice_with_a_different_length_rebuilds() {
        let mut index = HeightIndex::from_values([1., 2., 3., 4.]);
        index.splice(1..3, [10., 20., 30.]);
        assert_eq!(index.len(), 5);
        assert_eq!(index.total(), 1. + 10. + 20. + 30. + 4.);
        index.splice(0..5, []);
        assert_eq!(index.len(), 0);
        assert_eq!(index.find(5.), (0, 5.));
    }
}
