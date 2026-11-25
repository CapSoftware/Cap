pub fn dot(a: &[f32], b: &[f32]) -> f32 {
    a.iter().zip(b).map(|(x, y)| x * y).sum()
}

pub fn normalize(v: &mut [f32]) {
    let norm = dot(v, v).sqrt();
    if norm > 0.0 {
        for x in v {
            *x /= norm;
        }
    }
}

/// A weighted running mean of unit vectors; `unit` is kept normalised so
/// comparisons are plain dot products.
#[derive(Clone, Debug)]
pub struct Centroid {
    sum: Vec<f32>,
    pub unit: Vec<f32>,
    pub weight: f32,
}

impl Centroid {
    pub fn new(dim: usize) -> Self {
        Self {
            sum: vec![0.0; dim],
            unit: vec![0.0; dim],
            weight: 0.0,
        }
    }

    pub fn from(v: &[f32], weight: f32) -> Self {
        let mut c = Self::new(v.len());
        c.add(v, weight);
        c
    }

    pub fn add(&mut self, v: &[f32], weight: f32) {
        for (s, x) in self.sum.iter_mut().zip(v) {
            *s += x * weight;
        }
        self.weight += weight;
        self.unit.copy_from_slice(&self.sum);
        normalize(&mut self.unit);
    }

    pub fn absorb(&mut self, other: &Centroid) {
        for (s, x) in self.sum.iter_mut().zip(&other.sum) {
            *s += x;
        }
        self.weight += other.weight;
        self.unit.copy_from_slice(&self.sum);
        normalize(&mut self.unit);
    }

    pub fn similarity(&self, v: &[f32]) -> f32 {
        dot(&self.unit, v)
    }
}

/// Greedy one-to-one matching of rows to columns by the largest weights,
/// ignoring zero weights. Returns `(row, column)` pairs.
pub fn greedy_match(weights: &[Vec<u64>]) -> Vec<(usize, usize)> {
    let mut cells: Vec<(u64, usize, usize)> = weights
        .iter()
        .enumerate()
        .flat_map(|(r, row)| row.iter().enumerate().map(move |(c, w)| (*w, r, c)))
        .filter(|(w, _, _)| *w > 0)
        .collect();
    cells.sort_by(|a, b| b.0.cmp(&a.0).then(a.1.cmp(&b.1)).then(a.2.cmp(&b.2)));
    let rows = weights.len();
    let cols = weights.iter().map(Vec::len).max().unwrap_or(0);
    let mut used_r = vec![false; rows];
    let mut used_c = vec![false; cols];
    let mut out = Vec::new();
    for (_, r, c) in cells {
        if !used_r[r] && !used_c[c] {
            used_r[r] = true;
            used_c[c] = true;
            out.push((r, c));
        }
    }
    out
}
