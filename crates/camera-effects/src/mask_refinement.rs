pub struct MaskRefiner {
    width: usize,
    previous_frame: Vec<u8>,
    frame_difference: Vec<u8>,
    row_motion: Vec<u8>,
    motion_history: Vec<u8>,
    components: Components,
    near_subject: Vec<bool>,
}

impl MaskRefiner {
    pub fn new(width: usize, height: usize) -> Self {
        Self {
            width,
            previous_frame: vec![0; width * height * 4],
            frame_difference: vec![0; width * height],
            row_motion: vec![0; width * height],
            motion_history: vec![0; width * height],
            components: Components::default(),
            near_subject: Vec::new(),
        }
    }

    pub fn refine(
        &mut self,
        mask: &mut [f32],
        previous: &[f32],
        frame: &mut Vec<u8>,
        initialized: bool,
    ) {
        self.remove_weak_regions(mask);
        if initialized {
            for ((difference, current), previous) in self
                .frame_difference
                .iter_mut()
                .zip(frame.chunks_exact(4))
                .zip(self.previous_frame.chunks_exact(4))
            {
                *difference = current[0]
                    .abs_diff(previous[0])
                    .max(current[1].abs_diff(previous[1]))
                    .max(current[2].abs_diff(previous[2]));
            }
            // 3x3 neighbourhood max, separably: along rows, then columns.
            let width = self.width;
            for (row, output) in self
                .frame_difference
                .chunks_exact(width)
                .zip(self.row_motion.chunks_exact_mut(width))
            {
                output[0] = row[0].max(row[1.min(width - 1)]);
                for (output, window) in output[1..].iter_mut().zip(row.windows(3)) {
                    *output = window[0].max(window[1]).max(window[2]);
                }
                output[width - 1] = row[width.saturating_sub(2)].max(row[width - 1]);
            }
            let height = mask.len() / width;
            for y in 0..height {
                let above = &self.row_motion[y.saturating_sub(1) * width..][..width];
                let current = &self.row_motion[y * width..][..width];
                let below = &self.row_motion[(y + 1).min(height - 1) * width..][..width];
                let start = y * width;
                for (((((history, value), &previous), &above), &current), &below) in self
                    .motion_history[start..][..width]
                    .iter_mut()
                    .zip(&mut mask[start..][..width])
                    .zip(&previous[start..][..width])
                    .zip(above)
                    .zip(current)
                    .zip(below)
                {
                    let decayed = (u16::from(*history) * 3 / 4) as u8;
                    let motion = decayed.max(above).max(current).max(below);
                    *history = motion;
                    *value = smooth_mask_value(previous, *value, f32::from(motion) / 255.0);
                }
            }
        } else {
            self.motion_history.fill(0);
        }
        std::mem::swap(&mut self.previous_frame, frame);
    }

    /// Fills pockets inside the person that the background cannot reach from
    /// the frame edge. Segmentation dips over printed logos, glasses glare
    /// and bright jewellery; the guided filter then sharpens those dips into
    /// holes shaped like the detail. Pockets larger than `max_area` samples
    /// are left alone, so a real gap such as an arm on a hip stays open.
    #[cfg(any(target_os = "macos", test))]
    pub fn fill_holes(&mut self, mask: &mut [f32], max_area: usize) {
        const SOLID: f32 = 0.9;
        let width = self.width;
        let components = &mut self.components;
        components.label(mask, width, |value| value < SOLID);
        components.sizes.clear();
        components.sizes.resize(components.runs.len(), 0);
        components.flags.clear();
        components.flags.resize(components.runs.len(), false);
        // The bottom edge cuts through the presenter's torso, so only the top
        // and sides seed the background; background beside the shoulders
        // always reaches one of those.
        for y in 0..components.row_starts.len() - 1 {
            for index in components.row_starts[y]..components.row_starts[y + 1] {
                let run = components.runs[index];
                let root = components.roots[index] as usize;
                components.sizes[root] += run.len();
                components.flags[root] |= y == 0 || run.start == 0 || run.end as usize == width;
            }
        }
        for y in 0..components.row_starts.len() - 1 {
            for index in components.row_starts[y]..components.row_starts[y + 1] {
                let root = components.roots[index] as usize;
                if !components.flags[root] && components.sizes[root] <= max_area {
                    let run = components.runs[index];
                    mask[y * width..][run.start as usize..run.end as usize].fill(1.0);
                }
            }
        }
    }

    pub fn remove_weak_regions(&mut self, mask: &mut [f32]) {
        let threshold = (peak(mask) * 0.5).clamp(0.1, 0.5);
        let width = self.width;
        let components = &mut self.components;
        components.label(mask, width, |value| value >= threshold);
        if components.runs.is_empty() {
            mask.fill(0.0);
            return;
        }
        let height = components.row_starts.len() - 1;
        components.sizes.clear();
        components.sizes.resize(components.runs.len(), 0);
        components.confident.clear();
        components.confident.resize(components.runs.len(), 0);
        for y in 0..height {
            let row = &mask[y * width..][..width];
            for index in components.row_starts[y]..components.row_starts[y + 1] {
                let run = components.runs[index];
                let root = components.roots[index] as usize;
                components.sizes[root] += run.len();
                components.confident[root] += row[run.start as usize..run.end as usize]
                    .iter()
                    .filter(|value| **value >= 0.9)
                    .count();
            }
        }
        // Regions are numbered in scan order of their first sample and the
        // last of equally large ones wins.
        let mut largest = 0;
        for (index, &root) in components.roots.iter().enumerate() {
            if root as usize == index && components.sizes[index] >= components.sizes[largest] {
                largest = index;
            }
        }
        components.flags.clear();
        components
            .flags
            .extend(components.roots.iter().enumerate().map(|(index, &root)| {
                root as usize == index && (index == largest || components.confident[index] >= 8)
            }));
        // Samples below the threshold survive within two samples of a kept
        // region, so painting each kept run grown by two marks them.
        self.near_subject.clear();
        self.near_subject.resize(mask.len(), false);
        for y in 0..height {
            for index in components.row_starts[y]..components.row_starts[y + 1] {
                if !components.flags[components.roots[index] as usize] {
                    continue;
                }
                let run = components.runs[index];
                let start = (run.start as usize).saturating_sub(2);
                let end = (run.end as usize + 2).min(width);
                for row in y.saturating_sub(2)..=(y + 2).min(height - 1) {
                    self.near_subject[row * width..][start..end].fill(true);
                }
            }
        }
        for y in 0..height {
            let row = &mut mask[y * width..][..width];
            let near_subject = &self.near_subject[y * width..][..width];
            let mut x = 0;
            for index in components.row_starts[y]..components.row_starts[y + 1] {
                let run = components.runs[index];
                let (start, end) = (run.start as usize, run.end as usize);
                clear_far_samples(&mut row[x..start], &near_subject[x..start]);
                if !components.flags[components.roots[index] as usize] {
                    row[start..end].fill(0.0);
                }
                x = end;
            }
            clear_far_samples(&mut row[x..], &near_subject[x..]);
        }
    }
}

/// The largest sample, in independent lanes so the comparisons pipeline.
/// Only the sign of a zero peak can differ from a sequential fold, and the
/// threshold clamps that away.
fn peak(mask: &[f32]) -> f32 {
    let mut lanes = [0.0_f32; 16];
    let chunks = mask.chunks_exact(lanes.len());
    let tail = chunks.remainder();
    for chunk in chunks {
        for (lane, &value) in lanes.iter_mut().zip(chunk) {
            *lane = lane.max(value);
        }
    }
    lanes
        .into_iter()
        .chain(tail.iter().copied())
        .fold(0.0, f32::max)
}

fn clear_far_samples(values: &mut [f32], near_subject: &[bool]) {
    for (value, &near) in values.iter_mut().zip(near_subject) {
        if !(near && *value > 0.0) {
            *value = 0.0;
        }
    }
}

/// 4-connected regions of the samples matching a predicate, found as
/// horizontal runs joined across rows with union-find. A run's root is the
/// region's first run in scan order.
#[derive(Default)]
struct Components {
    runs: Vec<Run>,
    row_starts: Vec<usize>,
    roots: Vec<u32>,
    sizes: Vec<usize>,
    confident: Vec<usize>,
    flags: Vec<bool>,
}

#[derive(Clone, Copy)]
struct Run {
    start: u32,
    end: u32,
}

impl Run {
    fn len(self) -> usize {
        (self.end - self.start) as usize
    }
}

impl Components {
    fn label(&mut self, mask: &[f32], width: usize, matches: impl Fn(f32) -> bool) {
        self.runs.clear();
        self.row_starts.clear();
        self.roots.clear();
        let mut previous_row = 0;
        for row in mask.chunks_exact(width) {
            let row_start = self.runs.len();
            self.row_starts.push(row_start);
            let mut x = 0;
            while x < width {
                if !matches(row[x]) {
                    x += 1;
                    continue;
                }
                let start = x;
                while x < width && matches(row[x]) {
                    x += 1;
                }
                self.roots.push(self.runs.len() as u32);
                self.runs.push(Run {
                    start: start as u32,
                    end: x as u32,
                });
            }
            let (mut above, mut below) = (previous_row, row_start);
            while above < row_start && below < self.runs.len() {
                let (upper, lower) = (self.runs[above], self.runs[below]);
                if upper.start < lower.end && lower.start < upper.end {
                    self.union(above, below);
                }
                if upper.end < lower.end {
                    above += 1;
                } else {
                    below += 1;
                }
            }
            previous_row = row_start;
        }
        self.row_starts.push(self.runs.len());
        // Every run points at an earlier or equal run, so one forward pass
        // resolves them all to their region's root.
        for index in 0..self.roots.len() {
            self.roots[index] = self.roots[self.roots[index] as usize];
        }
    }

    fn find(&mut self, mut index: usize) -> usize {
        while self.roots[index] as usize != index {
            let parent = self.roots[index] as usize;
            self.roots[index] = self.roots[parent];
            index = parent;
        }
        index
    }

    fn union(&mut self, a: usize, b: usize) {
        let (a, b) = (self.find(a), self.find(b));
        let (root, child) = if a < b { (a, b) } else { (b, a) };
        self.roots[child] = root as u32;
    }
}

pub fn smooth_mask_value(previous: f32, next: f32, image_motion: f32) -> f32 {
    let motion = ((image_motion - 0.01) / 0.06).clamp(0.0, 1.0);
    let alpha = 0.18 + motion * 0.72;
    (previous + (next - previous) * alpha).clamp(0.0, 1.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stationary_image_noise_is_smoothed_without_delaying_motion() {
        assert!((smooth_mask_value(0.8, 0.2, 0.0) - 0.692).abs() < 0.001);
        assert!(smooth_mask_value(0.0, 1.0, 0.3) >= 0.89);
        assert!(smooth_mask_value(1.0, 0.0, 0.3) <= 0.11);
    }

    #[test]
    fn weak_background_islands_are_removed_without_removing_detached_hands() {
        let mut refiner = MaskRefiner::new(32, 32);
        let mut mask = vec![0.0; 1024];
        for y in 8..30 {
            for x in 5..15 {
                mask[y * 32 + x] = 1.0;
            }
        }
        for y in 20..24 {
            for x in 24..28 {
                mask[y * 32 + x] = 0.7;
            }
        }
        for y in 2..5 {
            for x in 20..24 {
                mask[y * 32 + x] = 1.0;
            }
        }
        refiner.remove_weak_regions(&mut mask);
        assert_eq!(mask[22 * 32 + 25], 0.0);
        assert_eq!(mask[3 * 32 + 21], 1.0);
        assert_eq!(mask[20 * 32 + 10], 1.0);
    }

    #[test]
    fn enclosed_dips_are_filled_but_open_and_large_gaps_are_kept() {
        let mut refiner = MaskRefiner::new(40, 40);
        let mut mask = vec![0.0; 1600];
        for y in 10..40 {
            for x in 5..35 {
                mask[y * 40 + x] = 1.0;
            }
        }
        // A logo-sized dip, one touching the bottom edge, a large enclosed
        // gap and a notch open to the background.
        for y in 20..23 {
            for x in 10..13 {
                mask[y * 40 + x] = 0.5;
            }
        }
        for y in 25..35 {
            for x in 20..32 {
                mask[y * 40 + x] = 0.0;
            }
        }
        for y in 10..15 {
            mask[y * 40 + 18] = 0.2;
        }
        for x in 26..29 {
            mask[38 * 40 + x] = 0.0;
            mask[39 * 40 + x] = 0.0;
        }
        refiner.fill_holes(&mut mask, 20);
        assert_eq!(mask[21 * 40 + 11], 1.0);
        assert_eq!(mask[30 * 40 + 25], 0.0);
        assert_eq!(mask[12 * 40 + 18], 0.2);
        assert_eq!(mask[39 * 40 + 27], 1.0);
    }

    #[test]
    fn a_small_or_low_confidence_primary_subject_is_preserved() {
        let mut refiner = MaskRefiner::new(8, 8);
        let mut mask = vec![0.0; 64];
        mask[18] = 0.3;
        mask[19] = 0.2;
        refiner.remove_weak_regions(&mut mask);
        assert_eq!(mask[18], 0.3);
        assert_eq!(mask[19], 0.2);
    }

    #[test]
    fn recent_motion_stays_responsive_when_the_image_stops_moving() {
        let mut refiner = MaskRefiner::new(4, 4);
        let mut frame = vec![255; 64];
        let frame_pointer = frame.as_ptr();
        let previous_pointer = refiner.previous_frame.as_ptr();
        let mut mask = vec![1.0; 16];
        refiner.refine(&mut mask, &[0.0; 16], &mut frame, true);
        assert!(mask.iter().all(|value| *value >= 0.89));
        assert_eq!(refiner.previous_frame.as_ptr(), frame_pointer);
        assert_eq!(frame.as_ptr(), previous_pointer);
        let previous = mask.clone();
        mask.fill(0.0);
        frame.fill(255);
        refiner.refine(&mut mask, &previous, &mut frame, true);
        assert!(mask.iter().all(|value| *value < 0.1));
        assert_eq!(refiner.previous_frame.as_ptr(), previous_pointer);
        assert_eq!(frame.as_ptr(), frame_pointer);
    }

    mod reference {
        pub struct Reference {
            width: usize,
            previous_frame: Vec<u8>,
            frame_difference: Vec<u8>,
            row_motion: Vec<u8>,
            motion_history: Vec<u8>,
            labels: Vec<usize>,
            queue: Vec<usize>,
            regions: Vec<(usize, usize)>,
        }

        impl Reference {
            pub fn new(width: usize, height: usize) -> Self {
                Self {
                    width,
                    previous_frame: vec![0; width * height * 4],
                    frame_difference: vec![0; width * height],
                    row_motion: vec![0; width * height],
                    motion_history: vec![0; width * height],
                    labels: vec![0; width * height],
                    queue: Vec::with_capacity(width * height),
                    regions: Vec::with_capacity(128),
                }
            }

            pub fn refine(
                &mut self,
                mask: &mut [f32],
                previous: &[f32],
                frame: &mut Vec<u8>,
                initialized: bool,
            ) {
                self.remove_weak_regions(mask);
                if initialized {
                    for ((difference, current), previous) in self
                        .frame_difference
                        .iter_mut()
                        .zip(frame.chunks_exact(4))
                        .zip(self.previous_frame.chunks_exact(4))
                    {
                        *difference = current[0]
                            .abs_diff(previous[0])
                            .max(current[1].abs_diff(previous[1]))
                            .max(current[2].abs_diff(previous[2]));
                    }
                    let width = self.width;
                    for (row, output) in self
                        .frame_difference
                        .chunks_exact(width)
                        .zip(self.row_motion.chunks_exact_mut(width))
                    {
                        for x in 0..width {
                            output[x] = row[x.saturating_sub(1)]
                                .max(row[x])
                                .max(row[(x + 1).min(width - 1)]);
                        }
                    }
                    let height = mask.len() / width;
                    for y in 0..height {
                        let above = &self.row_motion[y.saturating_sub(1) * width..][..width];
                        let current = &self.row_motion[y * width..][..width];
                        let below = &self.row_motion[(y + 1).min(height - 1) * width..][..width];
                        let start = y * width;
                        for x in 0..width {
                            let index = start + x;
                            let decayed = (u16::from(self.motion_history[index]) * 3 / 4) as u8;
                            let motion = decayed.max(above[x]).max(current[x]).max(below[x]);
                            self.motion_history[index] = motion;
                            mask[index] =
                                smooth(previous[index], mask[index], f32::from(motion) / 255.0);
                        }
                    }
                } else {
                    self.motion_history.fill(0);
                }
                std::mem::swap(&mut self.previous_frame, frame);
            }

            pub fn fill_holes(&mut self, mask: &mut [f32], max_area: usize) {
                const SOLID: f32 = 0.9;
                self.labels.fill(0);
                self.queue.clear();
                let height = mask.len() / self.width;
                let top = 0..self.width;
                let sides =
                    (1..height).flat_map(|y| [y * self.width, y * self.width + self.width - 1]);
                for index in top.chain(sides) {
                    if mask[index] < SOLID && self.labels[index] == 0 {
                        self.labels[index] = 1;
                        self.queue.push(index);
                    }
                }
                self.flood(mask, SOLID, 1);
                for start in 0..mask.len() {
                    if mask[start] >= SOLID || self.labels[start] != 0 {
                        continue;
                    }
                    self.labels[start] = 2;
                    self.queue.clear();
                    self.queue.push(start);
                    self.flood(mask, SOLID, 2);
                    if self.queue.len() <= max_area {
                        for &index in &self.queue {
                            mask[index] = 1.0;
                        }
                    }
                }
            }

            fn flood(&mut self, mask: &[f32], limit: f32, label: usize) {
                let mut cursor = 0;
                while cursor < self.queue.len() {
                    let index = self.queue[cursor];
                    cursor += 1;
                    let x = index % self.width;
                    let neighbors = [
                        (x > 0).then(|| index - 1),
                        (x + 1 < self.width).then_some(index + 1),
                        index.checked_sub(self.width),
                        (index + self.width < mask.len()).then_some(index + self.width),
                    ];
                    for neighbor in neighbors.into_iter().flatten() {
                        if self.labels[neighbor] == 0 && mask[neighbor] < limit {
                            self.labels[neighbor] = label;
                            self.queue.push(neighbor);
                        }
                    }
                }
            }

            pub fn remove_weak_regions(&mut self, mask: &mut [f32]) {
                self.labels.fill(0);
                self.regions.clear();
                self.regions.push((0, 0));
                let threshold =
                    (mask.iter().copied().fold(0.0_f32, f32::max) * 0.5).clamp(0.1, 0.5);
                for (start, &value) in mask.iter().enumerate() {
                    if value < threshold || self.labels[start] != 0 {
                        continue;
                    }
                    let label = self.regions.len();
                    self.labels[start] = label;
                    self.queue.clear();
                    self.queue.push(start);
                    let mut cursor = 0;
                    let mut confident = 0;
                    while cursor < self.queue.len() {
                        let index = self.queue[cursor];
                        cursor += 1;
                        confident += usize::from(mask[index] >= 0.9);
                        let x = index % self.width;
                        let neighbors = [
                            (x > 0).then(|| index - 1),
                            (x + 1 < self.width).then_some(index + 1),
                            index.checked_sub(self.width),
                            (index + self.width < mask.len()).then_some(index + self.width),
                        ];
                        for neighbor in neighbors.into_iter().flatten() {
                            if self.labels[neighbor] == 0 && mask[neighbor] >= threshold {
                                self.labels[neighbor] = label;
                                self.queue.push(neighbor);
                            }
                        }
                    }
                    self.regions.push((self.queue.len(), confident));
                }
                let largest = self
                    .regions
                    .iter()
                    .enumerate()
                    .max_by_key(|(_, region)| region.0)
                    .map_or(0, |(label, _)| label);
                if largest == 0 {
                    mask.fill(0.0);
                    return;
                }
                for (index, value) in mask.iter_mut().enumerate() {
                    let label = self.labels[index];
                    let x = index % self.width;
                    let y = index / self.width;
                    let near_subject = label == 0
                        && *value > 0.0
                        && (y.saturating_sub(2)..=(y + 2).min(self.labels.len() / self.width - 1))
                            .any(|row| {
                                (x.saturating_sub(2)..=(x + 2).min(self.width - 1)).any(|col| {
                                    let label = self.labels[row * self.width + col];
                                    label == largest || self.regions[label].1 >= 8
                                })
                            });
                    if label != largest && self.regions[label].1 < 8 && !near_subject {
                        *value = 0.0;
                    }
                }
            }
        }

        fn smooth(previous: f32, next: f32, image_motion: f32) -> f32 {
            let motion = ((image_motion - 0.01) / 0.06).clamp(0.0, 1.0);
            let alpha = 0.18 + motion * 0.72;
            (previous + (next - previous) * alpha).clamp(0.0, 1.0)
        }
    }

    struct Random(u64);

    impl Random {
        fn next(&mut self) -> u32 {
            self.0 = self
                .0
                .wrapping_mul(6364136223846793005)
                .wrapping_add(1442695040888963407);
            (self.0 >> 33) as u32
        }

        fn below(&mut self, limit: usize) -> usize {
            self.next() as usize % limit.max(1)
        }

        fn sample(&mut self) -> f32 {
            const EDGES: [f32; 10] = [0.0, -0.0, 0.05, 0.1, 0.3, 0.5, 0.89, 0.9, 0.95, 1.0];
            if self.next() % 2 == 0 {
                EDGES[self.below(EDGES.len())]
            } else {
                self.next() as f32 / u32::MAX as f32
            }
        }
    }

    /// Blobs of every confidence over a noisy floor: holes, islands,
    /// touching and diagonal regions, ties and edge contact.
    fn random_mask(random: &mut Random, width: usize, height: usize) -> Vec<f32> {
        let floor = random.sample() * 0.2;
        let mut mask: Vec<f32> = (0..width * height)
            .map(|_| {
                if random.below(4) == 0 {
                    random.sample() * floor
                } else {
                    0.0
                }
            })
            .collect();
        for _ in 0..random.below(24) {
            let (x, y) = (random.below(width), random.below(height));
            let (w, h) = (1 + random.below(width / 2), 1 + random.below(height / 2));
            let value = random.sample();
            let noisy = random.below(3) == 0;
            for row in y..(y + h).min(height) {
                for col in x..(x + w).min(width) {
                    mask[row * width + col] = if noisy && random.below(5) == 0 {
                        random.sample()
                    } else {
                        value
                    };
                }
            }
        }
        mask
    }

    fn bits(mask: &[f32]) -> Vec<u32> {
        mask.iter().map(|value| value.to_bits()).collect()
    }

    #[test]
    fn run_regions_match_the_breadth_first_reference_bit_for_bit() {
        let mut random = Random(0x5eed);
        for case in 0..3000 {
            let width = 1 + random.below(if case % 10 == 0 { 4 } else { 48 });
            let height = 1 + random.below(if case % 10 == 1 { 4 } else { 40 });
            let mask = random_mask(&mut random, width, height);
            let max_area = random.below(width * height / 4 + 2);

            let mut expected = mask.clone();
            reference::Reference::new(width, height).fill_holes(&mut expected, max_area);
            let mut actual = mask.clone();
            MaskRefiner::new(width, height).fill_holes(&mut actual, max_area);
            assert_eq!(bits(&expected), bits(&actual), "fill_holes case {case}");

            let mut expected = mask.clone();
            reference::Reference::new(width, height).remove_weak_regions(&mut expected);
            let mut actual = mask;
            MaskRefiner::new(width, height).remove_weak_regions(&mut actual);
            assert_eq!(
                bits(&expected),
                bits(&actual),
                "remove_weak_regions case {case}"
            );
        }
    }

    #[test]
    fn refinement_sequences_match_the_reference_bit_for_bit() {
        let mut random = Random(0xca5e);
        for case in 0..200 {
            let width = 1 + random.below(40);
            let height = 1 + random.below(30);
            let mut expected_refiner = reference::Reference::new(width, height);
            let mut actual_refiner = MaskRefiner::new(width, height);
            let mut previous = Vec::new();
            for step in 0..12 {
                let mask = random_mask(&mut random, width, height);
                let frame: Vec<u8> = (0..width * height * 4)
                    .map(|_| random.next() as u8)
                    .collect();
                let initialized = step > 0 && random.below(6) != 0;
                if !initialized {
                    previous = vec![0.0; width * height];
                }
                let max_area = random.below(width * height / 8 + 2);

                let (mut expected, mut expected_frame) = (mask.clone(), frame.clone());
                expected_refiner.fill_holes(&mut expected, max_area);
                expected_refiner.refine(&mut expected, &previous, &mut expected_frame, initialized);
                let (mut actual, mut actual_frame) = (mask, frame);
                actual_refiner.fill_holes(&mut actual, max_area);
                actual_refiner.refine(&mut actual, &previous, &mut actual_frame, initialized);

                assert_eq!(bits(&expected), bits(&actual), "case {case} step {step}");
                assert_eq!(expected_frame, actual_frame);
                previous = actual;
            }
        }
    }
}
