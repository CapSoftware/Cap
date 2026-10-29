use crate::{AudioSampleSource, VoiceAudio};
use std::{collections::VecDeque, f64::consts::PI, ops::Range, sync::LazyLock};

const SAMPLE_RATE: f64 = 48_000.0;
const BLOCK_FRAMES: usize = 24_000;
const EQ_PREROLL_FRAMES: usize = 9_600;
const AR_ORDER: usize = 16;
const SUB_BLOCK: usize = 512;
const DETECTION_MARGIN: usize = 512;
const DEPENDENCY_MARGIN: usize = 3 * SUB_BLOCK + AR_ORDER;
const MERGE_DISTANCE: usize = 2 * AR_ORDER;
const GAP_PADDING: usize = 2;
const DETECTION_FLOOR: f64 = 3e-4;
const CACHED_BLOCKS: usize = 3;
const BUTTERWORTH_Q: [f64; 2] = [0.541_196_100_146_197, 1.306_562_964_876_376_5];
const MAX_SECTIONS: usize = 10;

pub const VOICE_TONE_LOOKBEHIND_SAMPLES: usize =
    BLOCK_FRAMES + EQ_PREROLL_FRAMES + DETECTION_MARGIN + DEPENDENCY_MARGIN;
pub const VOICE_TONE_LOOKAHEAD_SAMPLES: usize = BLOCK_FRAMES + DETECTION_MARGIN + DEPENDENCY_MARGIN;

#[derive(Clone, Copy, Debug)]
pub enum ToneFilter {
    HighPass { hz: f32 },
    LowShelf { hz: f32, gain_db: f32 },
    Bell { hz: f32, gain_db: f32, q: f32 },
    HighShelf { hz: f32, gain_db: f32 },
}

impl ToneFilter {
    fn bits(self) -> (u8, u32, u32, u32) {
        match self {
            Self::HighPass { hz } => (0, hz.to_bits(), 0, 0),
            Self::LowShelf { hz, gain_db } => (1, hz.to_bits(), gain_db.to_bits(), 0),
            Self::Bell { hz, gain_db, q } => (2, hz.to_bits(), gain_db.to_bits(), q.to_bits()),
            Self::HighShelf { hz, gain_db } => (3, hz.to_bits(), gain_db.to_bits(), 0),
        }
    }

    fn sections(self) -> [Option<Biquad>; 2] {
        match self {
            Self::HighPass { hz } => {
                BUTTERWORTH_Q.map(|q| finite(hz).and_then(|hz| Biquad::high_pass(hz, q)))
            }
            Self::LowShelf { hz, gain_db } => [
                finite(hz)
                    .zip(audible_gain(gain_db))
                    .and_then(|(hz, gain)| Biquad::shelf(hz, gain, false)),
                None,
            ],
            Self::HighShelf { hz, gain_db } => [
                finite(hz)
                    .zip(audible_gain(gain_db))
                    .and_then(|(hz, gain)| Biquad::shelf(hz, gain, true)),
                None,
            ],
            Self::Bell { hz, gain_db, q } => [
                finite(hz)
                    .zip(audible_gain(gain_db))
                    .zip(finite(q))
                    .and_then(|((hz, gain), q)| Biquad::bell(hz, gain, q)),
                None,
            ],
        }
    }
}

impl PartialEq for ToneFilter {
    fn eq(&self, other: &Self) -> bool {
        self.bits() == other.bits()
    }
}

impl Eq for ToneFilter {}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DeclickStrength {
    Light,
    Strong,
}

impl DeclickStrength {
    fn threshold(self) -> f64 {
        match self {
            Self::Light => 3.5,
            Self::Strong => 2.5,
        }
    }

    fn max_gap(self) -> usize {
        match self {
            Self::Light => 48,
            Self::Strong => 128,
        }
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct VoiceToneSettings {
    pub filters: [Option<ToneFilter>; 5],
    pub declick: Option<DeclickStrength>,
}

impl VoiceToneSettings {
    pub fn is_active(&self) -> bool {
        self.declick.is_some() || !self.sections().is_empty()
    }

    fn sections(&self) -> Vec<Biquad> {
        self.filters
            .iter()
            .flatten()
            .flat_map(|filter| filter.sections())
            .flatten()
            .collect()
    }

    pub fn response_db(&self, hz: f32) -> f32 {
        self.response().db(hz)
    }

    pub fn response(&self) -> ToneResponse {
        ToneResponse(self.sections())
    }
}

pub struct ToneResponse(Vec<Biquad>);

impl ToneResponse {
    pub fn db(&self, hz: f32) -> f32 {
        let omega = 2.0 * PI * f64::from(hz).clamp(1.0, SAMPLE_RATE / 2.0) / SAMPLE_RATE;
        self.0
            .iter()
            .map(|section| 10.0 * section.magnitude_squared(omega).max(1e-12).log10())
            .sum::<f64>() as f32
    }
}

fn finite(value: f32) -> Option<f64> {
    value.is_finite().then_some(f64::from(value))
}

fn audible_gain(gain_db: f32) -> Option<f64> {
    finite(gain_db)
        .filter(|gain| gain.abs() >= 0.01)
        .map(|gain| gain.clamp(-24.0, 24.0))
}

#[derive(Clone, Copy, Debug)]
struct Biquad {
    b0: f64,
    b1: f64,
    b2: f64,
    a1: f64,
    a2: f64,
}

impl Biquad {
    fn omega(hz: f64) -> (f64, f64) {
        let omega = 2.0 * PI * hz.clamp(10.0, SAMPLE_RATE * 0.45) / SAMPLE_RATE;
        (omega.cos(), omega.sin())
    }

    fn normalized(b: [f64; 3], a: [f64; 3]) -> Option<Self> {
        let section = Self {
            b0: b[0] / a[0],
            b1: b[1] / a[0],
            b2: b[2] / a[0],
            a1: a[1] / a[0],
            a2: a[2] / a[0],
        };
        [section.b0, section.b1, section.b2, section.a1, section.a2]
            .iter()
            .all(|value| value.is_finite())
            .then_some(section)
    }

    fn high_pass(hz: f64, q: f64) -> Option<Self> {
        let (cos, sin) = Self::omega(hz);
        let alpha = sin / (2.0 * q);
        Self::normalized(
            [(1.0 + cos) / 2.0, -(1.0 + cos), (1.0 + cos) / 2.0],
            [1.0 + alpha, -2.0 * cos, 1.0 - alpha],
        )
    }

    fn shelf(hz: f64, gain_db: f64, high: bool) -> Option<Self> {
        let (cos, sin) = Self::omega(hz);
        let a = 10f64.powf(gain_db / 40.0);
        let root = 2.0 * a.sqrt() * sin / std::f64::consts::SQRT_2;
        let sign = if high { -1.0 } else { 1.0 };
        let plus = a + 1.0;
        let minus = a - 1.0;
        Self::normalized(
            [
                a * (plus - sign * minus * cos + root),
                sign * 2.0 * a * (minus - sign * plus * cos),
                a * (plus - sign * minus * cos - root),
            ],
            [
                plus + sign * minus * cos + root,
                -sign * 2.0 * (minus + sign * plus * cos),
                plus + sign * minus * cos - root,
            ],
        )
    }

    fn bell(hz: f64, gain_db: f64, q: f64) -> Option<Self> {
        let (cos, sin) = Self::omega(hz);
        let a = 10f64.powf(gain_db / 40.0);
        let alpha = sin / (2.0 * q.clamp(0.1, 20.0));
        Self::normalized(
            [1.0 + alpha * a, -2.0 * cos, 1.0 - alpha * a],
            [1.0 + alpha / a, -2.0 * cos, 1.0 - alpha / a],
        )
    }

    fn magnitude_squared(&self, omega: f64) -> f64 {
        let (cos, cos2) = (omega.cos(), (2.0 * omega).cos());
        let numerator = self.b0 * self.b0
            + self.b1 * self.b1
            + self.b2 * self.b2
            + 2.0 * (self.b0 * self.b1 + self.b1 * self.b2) * cos
            + 2.0 * self.b0 * self.b2 * cos2;
        let denominator = 1.0
            + self.a1 * self.a1
            + self.a2 * self.a2
            + 2.0 * (self.a1 + self.a1 * self.a2) * cos
            + 2.0 * self.a2 * cos2;
        numerator / denominator
    }

    /// Runs every section on each sample before moving to the next, so the
    /// sections' feedback chains overlap instead of each section making its
    /// own serial pass. Every section still sees the same inputs in the same
    /// order, so the output is bit-identical to filtering one section at a
    /// time.
    fn process_cascade(sections: &[Biquad], samples: &mut [f64]) {
        let mut states = [[0.0f64; 4]; MAX_SECTIONS];
        let states = &mut states[..sections.len()];
        for sample in samples {
            let mut x0 = *sample;
            for (section, [x1, x2, y1, y2]) in sections.iter().zip(states.iter_mut()) {
                let y0 = section.b0 * x0 + section.b1 * *x1 + section.b2 * *x2
                    - section.a1 * *y1
                    - section.a2 * *y2;
                (*x2, *x1, *y2, *y1) = (*x1, x0, *y1, y0);
                x0 = y0;
            }
            *sample = x0;
        }
    }
}

/// Renders a microphone track through the voice EQ and de-click. Every output
/// block is computed from a fresh filter state primed over a fixed pre-roll
/// on an absolute sample grid, so a sample's value never depends on where
/// playback, a seek or an export started.
pub struct VoiceTone {
    settings: VoiceToneSettings,
    sections: Vec<Biquad>,
    channels: usize,
    blocks: VecDeque<(usize, usize, Vec<f32>)>,
}

impl VoiceTone {
    pub fn new(channels: u16, settings: VoiceToneSettings) -> Self {
        Self {
            sections: settings.sections(),
            settings,
            channels: usize::from(channels.max(1)),
            blocks: VecDeque::with_capacity(CACHED_BLOCKS),
        }
    }

    pub fn settings(&self) -> VoiceToneSettings {
        self.settings
    }

    fn region_start(&self, block_start: usize) -> usize {
        if self.sections.is_empty() {
            block_start
        } else {
            block_start.saturating_sub(EQ_PREROLL_FRAMES)
        }
    }

    fn context(&self) -> usize {
        if self.settings.declick.is_some() {
            DETECTION_MARGIN + DEPENDENCY_MARGIN
        } else {
            0
        }
    }

    pub fn source_range(&self, start: usize, count: usize) -> Range<usize> {
        if count == 0 {
            return start..start;
        }
        let first_block = start / BLOCK_FRAMES * BLOCK_FRAMES;
        let last_block_end = (start + count - 1) / BLOCK_FRAMES * BLOCK_FRAMES + BLOCK_FRAMES;
        self.region_start(first_block)
            .saturating_sub(self.context())..last_block_end.saturating_add(self.context())
    }

    pub fn render<T: AudioSampleSource>(
        &mut self,
        source: &T,
        start: usize,
        count: usize,
    ) -> VoiceAudio {
        let total = source.sample_count();
        let end = start.saturating_add(count).min(total);
        let mut samples = Vec::with_capacity(end.saturating_sub(start) * self.channels);
        let mut position = start;
        while position < end {
            let block_start = position / BLOCK_FRAMES * BLOCK_FRAMES;
            let block_end = (block_start + BLOCK_FRAMES).min(total);
            let index = self.block(source, block_start, block_end);
            let until = end.min(block_end);
            let data = &self.blocks[index].2;
            samples.extend_from_slice(
                &data[(position - block_start) * self.channels
                    ..(until - block_start) * self.channels],
            );
            position = until;
        }
        VoiceAudio {
            samples,
            channels: self.channels as u16,
            start,
            total_samples: total,
        }
    }

    fn block<T: AudioSampleSource>(
        &mut self,
        source: &T,
        block_start: usize,
        block_end: usize,
    ) -> usize {
        if let Some(index) = self
            .blocks
            .iter()
            .position(|(start, end, _)| *start == block_start && *end == block_end)
        {
            return index;
        }
        let data = self.compute_block(source, block_start, block_end);
        if self.blocks.len() == CACHED_BLOCKS {
            self.blocks.pop_front();
        }
        self.blocks.push_back((block_start, block_end, data));
        self.blocks.len() - 1
    }

    fn compute_block<T: AudioSampleSource>(
        &self,
        source: &T,
        block_start: usize,
        block_end: usize,
    ) -> Vec<f32> {
        let total = source.sample_count();
        let channels = self.channels;
        let region_start = self.region_start(block_start);
        let read_start = region_start.saturating_sub(self.context());
        let read_end = block_end.saturating_add(self.context()).min(total);
        let mut output = vec![0.0; (block_end - block_start) * channels];
        let mut input = Vec::with_capacity(read_end - read_start);
        let mut region = Vec::with_capacity(block_end - region_start);
        for channel in 0..channels {
            input.clear();
            input.extend((read_start..read_end).map(|frame| {
                source
                    .sample(frame * channels + channel)
                    .copied()
                    .filter(|value| value.is_finite())
                    .map_or(0.0, f64::from)
            }));
            region.clear();
            region.extend_from_slice(&input[region_start - read_start..block_end - read_start]);
            if let Some(strength) = self.settings.declick {
                let signal = Signal {
                    samples: &input,
                    offset: read_start,
                    total,
                };
                declick(&signal, region_start, &mut region, strength);
            }
            Biquad::process_cascade(&self.sections, &mut region);
            for (frame, value) in region[block_start - region_start..].iter().enumerate() {
                output[frame * channels + channel] = *value as f32;
            }
        }
        output
    }
}

struct Signal<'a> {
    samples: &'a [f64],
    offset: usize,
    total: usize,
}

impl Signal<'_> {
    fn at(&self, frame: isize) -> f64 {
        usize::try_from(frame)
            .ok()
            .filter(|frame| *frame < self.total)
            .and_then(|frame| frame.checked_sub(self.offset))
            .and_then(|index| self.samples.get(index))
            .copied()
            .unwrap_or(0.0)
    }
}

type Coefficients = [f64; AR_ORDER + 1];

const IDENTITY: Coefficients = {
    let mut coefficients = [0.0; AR_ORDER + 1];
    coefficients[0] = 1.0;
    coefficients
};

const WINDOW: usize = 2 * SUB_BLOCK;

static HANN: LazyLock<[f64; WINDOW]> = LazyLock::new(|| {
    std::array::from_fn(|index| 0.5 - 0.5 * (2.0 * PI * (index as f64 + 0.5) / WINDOW as f64).cos())
});

fn sub_block_coefficients(signal: &Signal, block: usize) -> Coefficients {
    let start = (block * SUB_BLOCK) as isize - (SUB_BLOCK / 2) as isize;
    let mut window = [0.0; WINDOW];
    for (index, (value, hann)) in window.iter_mut().zip(HANN.iter()).enumerate() {
        *value = signal.at(start + index as isize) * hann;
    }
    let mut correlation = [0.0; AR_ORDER + 1];
    for (lag, value) in correlation.iter_mut().enumerate() {
        *value = window[lag..].iter().zip(&window).map(|(a, b)| a * b).sum();
    }
    levinson(&correlation).unwrap_or(IDENTITY)
}

fn levinson(correlation: &[f64; AR_ORDER + 1]) -> Option<Coefficients> {
    if correlation[0] <= 1e-12 || !correlation[0].is_finite() {
        return None;
    }
    let mut coefficients = IDENTITY;
    let mut error = correlation[0] * (1.0 + 1e-5);
    for order in 1..=AR_ORDER {
        let accumulated = correlation[order]
            + (1..order)
                .map(|index| coefficients[index] * correlation[order - index])
                .sum::<f64>();
        let reflection = -accumulated / error;
        let previous = coefficients;
        for index in 1..order {
            coefficients[index] = previous[index] + reflection * previous[order - index];
        }
        coefficients[order] = reflection;
        error *= 1.0 - reflection * reflection;
        if !reflection.is_finite() || error <= 0.0 {
            return None;
        }
    }
    Some(coefficients)
}

fn percentile_98(values: &mut [f64]) -> f64 {
    if values.is_empty() {
        return 0.0;
    }
    let rank = (values.len() * 98 / 100).min(values.len() - 1);
    *values.select_nth_unstable_by(rank, f64::total_cmp).1
}

/// Detection measures the forward and backward prediction error of a local AR
/// model against the 98th percentile of that error nearby, so glottal pulses in
/// voiced speech set the bar instead of tripping it. Everything is evaluated on
/// a fixed sub-block grid with margins wider than any gap, so two overlapping
/// regions agree on every sample they share.
fn declick(
    signal: &Signal,
    region_start: usize,
    region: &mut [f64],
    strength: DeclickStrength,
) -> usize {
    let region_end = region_start + region.len();
    let detect_start = region_start.saturating_sub(DETECTION_MARGIN);
    let detect_end = (region_end + DETECTION_MARGIN).min(signal.total);
    if detect_end <= detect_start {
        return 0;
    }
    let first_block = detect_start / SUB_BLOCK;
    let last_block = (detect_end - 1) / SUB_BLOCK;
    let residual_first = first_block.saturating_sub(1);
    let residual_end = last_block + 2;
    let coefficients = (residual_first..residual_end)
        .map(|block| sub_block_coefficients(signal, block))
        .collect::<Vec<_>>();
    let base = residual_first * SUB_BLOCK;
    let length = (residual_end - residual_first) * SUB_BLOCK;
    let padded = (0..length + 2 * AR_ORDER)
        .map(|index| signal.at((base + index) as isize - AR_ORDER as isize))
        .collect::<Vec<_>>();
    let mut forward = vec![0.0; length];
    let mut backward = vec![0.0; length];
    for index in 0..length {
        let a = &coefficients[index / SUB_BLOCK];
        let center = index + AR_ORDER;
        let (mut ahead, mut behind) = (0.0, 0.0);
        for (lag, coefficient) in a.iter().enumerate() {
            behind += coefficient * padded[center - lag];
            ahead += coefficient * padded[center + lag];
        }
        forward[index] = behind.abs();
        backward[index] = ahead.abs();
    }
    let threshold = strength.threshold();
    let mut scratch = Vec::with_capacity(3 * SUB_BLOCK);
    let thresholds = (first_block..=last_block)
        .map(|block| {
            let from = block.saturating_sub(1) * SUB_BLOCK - base;
            let to = (block + 2) * SUB_BLOCK - base;
            let mut level = |values: &[f64]| {
                scratch.clear();
                scratch.extend_from_slice(&values[from..to]);
                percentile_98(&mut scratch) * threshold
            };
            (level(&forward), level(&backward))
        })
        .collect::<Vec<_>>();
    let outliers = |frame: usize| {
        let index = frame - base;
        let (forward_limit, backward_limit) = thresholds[frame / SUB_BLOCK - first_block];
        (
            forward[index] > forward_limit && forward[index] > DETECTION_FLOOR,
            backward[index] > backward_limit && backward[index] > DETECTION_FLOOR,
        )
    };

    let mut repaired = 0;
    let mut frame = detect_start;
    while frame < detect_end {
        let (ahead, behind) = outliers(frame);
        if !ahead && !behind {
            frame += 1;
            continue;
        }
        let first = frame;
        let mut last = frame;
        let mut onset = None;
        let mut release = None;
        let mut confirmed = false;
        let mut cursor = frame;
        while cursor < detect_end && cursor <= last + MERGE_DISTANCE {
            let (ahead, behind) = outliers(cursor);
            if ahead || behind {
                last = cursor;
            }
            if ahead {
                onset.get_or_insert(cursor);
            }
            if behind {
                release = Some(cursor);
            }
            confirmed |= ahead && behind;
            cursor += 1;
        }
        frame = last + 1;
        let (Some(onset), Some(release)) = (onset, release) else {
            continue;
        };
        let touches_edge = first == detect_start || last + 1 >= detect_end;
        let gap_start = onset.min(release).saturating_sub(GAP_PADDING);
        let gap_end = (onset.max(release) + GAP_PADDING + 1).min(signal.total);
        if !confirmed
            || touches_edge
            || gap_end - gap_start > strength.max_gap()
            || gap_start < AR_ORDER
            || gap_end + AR_ORDER > signal.total
            || gap_end <= region_start
            || gap_start >= region_end
        {
            continue;
        }
        let a = &coefficients[((gap_start + gap_end) / 2) / SUB_BLOCK - residual_first];
        let values = interpolate(signal, a, gap_start, gap_end);
        for (offset, value) in values.into_iter().enumerate() {
            let frame = gap_start + offset;
            if (region_start..region_end).contains(&frame) {
                region[frame - region_start] = value;
            }
        }
        repaired += 1;
    }
    repaired
}

/// Least-squares AR interpolation of `start..end`: the missing samples that
/// minimise the model's prediction error across the gap and `AR_ORDER`
/// samples past it, with a straight line as the fallback.
fn interpolate(signal: &Signal, a: &Coefficients, start: usize, end: usize) -> Vec<f64> {
    let gap = end - start;
    let known = |frame: usize| {
        if (start..end).contains(&frame) {
            0.0
        } else {
            signal.at(frame as isize)
        }
    };
    let autocorrelation = (0..=AR_ORDER)
        .map(|lag| {
            (0..=AR_ORDER - lag)
                .map(|index| a[index] * a[index + lag])
                .sum::<f64>()
        })
        .collect::<Vec<_>>();
    let excitation = (start..end + AR_ORDER)
        .map(|frame| {
            (0..=AR_ORDER)
                .filter(|lag| *lag <= frame)
                .map(|lag| a[lag] * known(frame - lag))
                .sum::<f64>()
        })
        .collect::<Vec<_>>();
    let mut matrix = vec![0.0; gap * gap];
    let mut rhs = vec![0.0; gap];
    for row in 0..gap {
        for column in 0..gap {
            let lag = row.abs_diff(column);
            if lag <= AR_ORDER {
                matrix[row * gap + column] = autocorrelation[lag];
            }
        }
        matrix[row * gap + row] += autocorrelation[0] * 1e-9;
        rhs[row] = -(0..=AR_ORDER)
            .map(|lag| a[lag] * excitation[row + lag])
            .sum::<f64>();
    }
    solve_cholesky(&mut matrix, &mut rhs, gap)
        .filter(|values| values.iter().all(|value| value.is_finite()))
        .unwrap_or_else(|| {
            let before = signal.at(start as isize - 1);
            let after = signal.at(end as isize);
            (0..gap)
                .map(|index| before + (after - before) * (index + 1) as f64 / (gap + 1) as f64)
                .collect()
        })
}

fn solve_cholesky(matrix: &mut [f64], rhs: &mut [f64], size: usize) -> Option<Vec<f64>> {
    for column in 0..size {
        let mut diagonal = matrix[column * size + column];
        for index in 0..column {
            diagonal -= matrix[column * size + index] * matrix[column * size + index];
        }
        if diagonal <= 0.0 || !diagonal.is_finite() {
            return None;
        }
        let diagonal = diagonal.sqrt();
        matrix[column * size + column] = diagonal;
        for row in column + 1..size {
            let mut value = matrix[row * size + column];
            for index in 0..column {
                value -= matrix[row * size + index] * matrix[column * size + index];
            }
            matrix[row * size + column] = value / diagonal;
        }
    }
    for row in 0..size {
        let mut value = rhs[row];
        for index in 0..row {
            value -= matrix[row * size + index] * rhs[index];
        }
        rhs[row] = value / matrix[row * size + row];
    }
    for row in (0..size).rev() {
        let mut value = rhs[row];
        for index in row + 1..size {
            value -= matrix[index * size + row] * rhs[index];
        }
        rhs[row] = value / matrix[row * size + row];
    }
    Some(rhs.to_vec())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    struct Samples {
        data: Vec<f32>,
        channels: u16,
    }

    impl AudioSampleSource for Samples {
        fn channels(&self) -> u16 {
            self.channels
        }
        fn sample_count(&self) -> usize {
            self.data.len() / usize::from(self.channels)
        }
        fn sample(&self, index: usize) -> Option<&f32> {
            self.data.get(index)
        }
    }

    struct Probe<'a> {
        inner: &'a Samples,
        window: Range<usize>,
        reads: Cell<(usize, usize)>,
    }

    impl AudioSampleSource for Probe<'_> {
        fn channels(&self) -> u16 {
            self.inner.channels
        }
        fn sample_count(&self) -> usize {
            self.inner.sample_count()
        }
        fn sample(&self, index: usize) -> Option<&f32> {
            let frame = index / usize::from(self.inner.channels);
            let (low, high) = self.reads.get();
            self.reads.set((low.min(frame), high.max(frame + 1)));
            if self.window.contains(&frame) {
                self.inner.sample(index)
            } else {
                None
            }
        }
    }

    struct Random(u64);

    impl Random {
        fn next(&mut self) -> f64 {
            self.0 ^= self.0 << 13;
            self.0 ^= self.0 >> 7;
            self.0 ^= self.0 << 17;
            (self.0 >> 11) as f64 / (1u64 << 53) as f64
        }
        fn noise(&mut self) -> f64 {
            self.next() * 2.0 - 1.0
        }
    }

    /// Formant-filtered glottal pulses with a drifting pitch, syllable
    /// envelopes, breath noise and fricative bursts: the residual peaks of
    /// real voiced speech that a click detector must not mistake for clicks.
    fn voice(seconds: f64, seed: u64) -> Vec<f32> {
        let frames = (seconds * SAMPLE_RATE) as usize;
        let mut random = Random(seed);
        let formants = [(700.0, 90.0), (1_220.0, 110.0), (2_600.0, 160.0)].map(
            |(hz, bandwidth): (f64, f64)| {
                let radius = (-PI * bandwidth / SAMPLE_RATE).exp();
                let theta = 2.0 * PI * hz / SAMPLE_RATE;
                (2.0 * radius * theta.cos(), -radius * radius, [0.0f64; 2])
            },
        );
        let mut formants = formants;
        let mut phase = 0.0;
        let mut fricative = [0.0f64; 2];
        let mut output = Vec::with_capacity(frames);
        for frame in 0..frames {
            let t = frame as f64 / SAMPLE_RATE;
            let pitch = 125.0 + 35.0 * (t * 1.7).sin() + 10.0 * (t * 5.3).sin();
            phase += pitch / SAMPLE_RATE;
            let pulse = if phase >= 1.0 {
                phase -= 1.0;
                1.0
            } else {
                0.0
            };
            let syllable = (t * 3.1 * PI).sin().max(0.0).powf(0.6);
            let mut sample = pulse * syllable + random.noise() * 0.002;
            for (a1, a2, state) in &mut formants {
                let y = sample + *a1 * state[0] + *a2 * state[1];
                state[1] = state[0];
                state[0] = y;
                sample = y * 0.08;
            }
            let hiss = random.noise();
            let high = hiss - 1.6 * fricative[0] + 0.64 * fricative[1];
            fricative = [hiss, fricative[0]];
            let fricative_gate = if (t % 1.3) > 1.05 { 0.05 } else { 0.0 };
            output.push((sample * 3.0 + high * fricative_gate) as f32);
        }
        let peak = output
            .iter()
            .fold(0.0f32, |peak, value| peak.max(value.abs()));
        output.iter().map(|value| value / peak * 0.3).collect()
    }

    fn render_all(settings: VoiceToneSettings, source: &Samples) -> Vec<f32> {
        VoiceTone::new(source.channels, settings)
            .render(source, 0, source.sample_count())
            .samples
    }

    fn eq_only() -> VoiceToneSettings {
        VoiceToneSettings {
            filters: [
                Some(ToneFilter::HighPass { hz: 90.0 }),
                Some(ToneFilter::LowShelf {
                    hz: 150.0,
                    gain_db: -3.0,
                }),
                Some(ToneFilter::Bell {
                    hz: 350.0,
                    gain_db: -4.0,
                    q: 1.2,
                }),
                Some(ToneFilter::Bell {
                    hz: 3_500.0,
                    gain_db: 5.0,
                    q: 0.9,
                }),
                Some(ToneFilter::HighShelf {
                    hz: 9_000.0,
                    gain_db: 3.0,
                }),
            ],
            declick: None,
        }
    }

    fn assert_same(actual: &[f32], expected: &[f32], context: &str) {
        assert_eq!(actual.len(), expected.len(), "{context}");
        if let Some(index) = actual
            .iter()
            .zip(expected)
            .position(|(a, b)| a.to_bits() != b.to_bits())
        {
            panic!(
                "{context}: first difference at {index}: {} vs {}",
                actual[index], expected[index]
            );
        }
    }

    fn rms(samples: &[f32]) -> f64 {
        (samples.iter().map(|v| f64::from(*v).powi(2)).sum::<f64>() / samples.len() as f64).sqrt()
    }

    #[test]
    fn flat_settings_do_nothing_and_report_a_flat_curve() {
        let flat = VoiceToneSettings {
            filters: [
                None,
                Some(ToneFilter::LowShelf {
                    hz: 120.0,
                    gain_db: 0.0,
                }),
                Some(ToneFilter::Bell {
                    hz: 1_000.0,
                    gain_db: 0.004,
                    q: 1.0,
                }),
                Some(ToneFilter::HighShelf {
                    hz: 8_000.0,
                    gain_db: f32::NAN,
                }),
                Some(ToneFilter::HighPass { hz: f32::INFINITY }),
            ],
            declick: None,
        };
        assert!(!flat.is_active());
        assert!(!VoiceToneSettings::default().is_active());
        for hz in [20.0, 1_000.0, 20_000.0] {
            assert_eq!(flat.response_db(hz), 0.0);
        }
    }

    #[test]
    fn measured_gain_matches_the_reported_response() {
        let cases = [
            ToneFilter::HighPass { hz: 80.0 },
            ToneFilter::LowShelf {
                hz: 200.0,
                gain_db: 6.0,
            },
            ToneFilter::Bell {
                hz: 1_000.0,
                gain_db: -9.0,
                q: 2.0,
            },
            ToneFilter::HighShelf {
                hz: 6_000.0,
                gain_db: -6.0,
            },
        ];
        for filter in cases {
            let settings = VoiceToneSettings {
                filters: [Some(filter), None, None, None, None],
                declick: None,
            };
            for hz in [30.0, 80.0, 200.0, 1_000.0, 3_000.0, 6_000.0, 12_000.0] {
                let frames = 96_000;
                let data = (0..frames)
                    .map(|frame| (0.25 * (2.0 * PI * hz * frame as f64 / SAMPLE_RATE).sin()) as f32)
                    .collect::<Vec<_>>();
                let source = Samples { data, channels: 1 };
                let output = render_all(settings, &source);
                let measured =
                    20.0 * (rms(&output[48_000..]) / rms(&source.data[48_000..])).log10();
                let expected = f64::from(settings.response_db(hz as f32));
                assert!(
                    (measured - expected).abs() < 0.05,
                    "{filter:?} at {hz} Hz: measured {measured:.3} dB, expected {expected:.3} dB"
                );
            }
        }
        let high_pass = VoiceToneSettings {
            filters: [
                Some(ToneFilter::HighPass { hz: 80.0 }),
                None,
                None,
                None,
                None,
            ],
            declick: None,
        };
        assert!(high_pass.response_db(20.0) < -45.0);
        assert!(high_pass.response_db(1_000.0).abs() < 0.01);
        let bell = VoiceToneSettings {
            filters: [
                Some(ToneFilter::Bell {
                    hz: 2_000.0,
                    gain_db: 6.0,
                    q: 1.0,
                }),
                None,
                None,
                None,
                None,
            ],
            declick: None,
        };
        assert!((bell.response_db(2_000.0) - 6.0).abs() < 0.01);
    }

    #[test]
    fn chunked_and_seeking_renders_match_one_whole_render() {
        let settings = [
            eq_only(),
            VoiceToneSettings {
                filters: [None; 5],
                declick: Some(DeclickStrength::Strong),
            },
            VoiceToneSettings {
                declick: Some(DeclickStrength::Light),
                ..eq_only()
            },
        ];
        for channels in [1u16, 2] {
            let mono = voice(3.3, 7);
            let data = mono
                .iter()
                .enumerate()
                .flat_map(|(index, value)| {
                    let other = if index.is_multiple_of(997) {
                        0.4
                    } else {
                        *value * 0.7
                    };
                    [*value, other].into_iter().take(usize::from(channels))
                })
                .collect::<Vec<_>>();
            let source = Samples { data, channels };
            let total = source.sample_count();
            for settings in settings {
                let expected = render_all(settings, &source);
                assert_eq!(expected.len(), source.data.len());
                let mut tone = VoiceTone::new(channels, settings);
                let mut random = Random(99);
                for _ in 0..60 {
                    let start = (random.next() * total as f64) as usize;
                    let count = 1 + (random.next() * 30_000.0) as usize;
                    let audio = tone.render(&source, start, count);
                    let end = (start + count).min(total);
                    assert_same(
                        &audio.samples,
                        &expected[start * usize::from(channels)..end * usize::from(channels)],
                        &format!("{settings:?} {channels}ch {start}+{count}"),
                    );
                }
                let mut cursor = 0;
                let mut streamed = Vec::new();
                for count in [1, 479, 4_096, 23_999, 1, 24_001, 7].into_iter().cycle() {
                    if cursor == total {
                        break;
                    }
                    streamed.extend(tone.render(&source, cursor, count).samples);
                    cursor = (cursor + count).min(total);
                }
                assert_same(
                    &streamed,
                    &expected,
                    &format!("{settings:?} {channels}ch stream"),
                );
            }
        }
    }

    #[test]
    fn renders_read_only_inside_their_source_range() {
        let settings = VoiceToneSettings {
            declick: Some(DeclickStrength::Strong),
            ..eq_only()
        };
        let source = Samples {
            data: voice(4.0, 3),
            channels: 1,
        };
        let total = source.sample_count();
        let expected = render_all(settings, &source);
        let mut random = Random(5);
        for _ in 0..40 {
            let start = (random.next() * total as f64) as usize;
            let count = 1 + (random.next() * 8_192.0) as usize;
            let tone = VoiceTone::new(1, settings);
            let range = tone.source_range(start, count);
            assert!(start - range.start.min(start) <= VOICE_TONE_LOOKBEHIND_SAMPLES);
            assert!(range.end - (start + count) <= VOICE_TONE_LOOKAHEAD_SAMPLES);
            let probe = Probe {
                inner: &source,
                window: range.clone(),
                reads: Cell::new((usize::MAX, 0)),
            };
            let audio = VoiceTone::new(1, settings).render(&probe, start, count);
            let (low, high) = probe.reads.get();
            assert!(low >= range.start && high <= range.end, "{start}+{count}");
            let end = (start + count).min(total);
            assert_eq!(audio.samples, &expected[start..end]);
        }
        let eq = VoiceTone::new(1, eq_only());
        assert_eq!(eq.source_range(50_000, 10), 38_400..72_000);
        assert_eq!(eq.source_range(50_000, 0), 50_000..50_000);
    }

    fn with_clicks(clean: &[f32], seed: u64, per_second: f64) -> (Vec<f32>, Vec<usize>) {
        let mut random = Random(seed);
        let mut data = clean.to_vec();
        let mut positions = Vec::new();
        let mut frame = 4_000;
        while frame + 200 < data.len() {
            frame += (SAMPLE_RATE / per_second * (0.5 + random.next())) as usize;
            if frame + 200 >= data.len() {
                break;
            }
            let width = 1 + (random.next() * 6.0) as usize;
            let amplitude =
                (0.08 + random.next() * 0.5) * if random.next() > 0.5 { 1.0 } else { -1.0 };
            for offset in 0..width {
                let shape = 1.0 - offset as f64 / (width as f64 + 1.0);
                data[frame + offset] += (amplitude * shape) as f32;
            }
            positions.push(frame);
        }
        (data, positions)
    }

    fn error_db(signal: &[f32], reference: &[f32]) -> f64 {
        let error = signal
            .iter()
            .zip(reference)
            .map(|(a, b)| f64::from(a - b).powi(2))
            .sum::<f64>();
        let power = reference.iter().map(|v| f64::from(*v).powi(2)).sum::<f64>();
        10.0 * (error / power).log10()
    }

    #[test]
    fn declick_removes_clicks_and_crackle_from_voice() {
        let clean = voice(12.0, 11);
        for (strength, rate, minimum_gain_db) in [
            (DeclickStrength::Light, 4.0, 15.0),
            (DeclickStrength::Strong, 4.0, 20.0),
            (DeclickStrength::Strong, 40.0, 15.0),
        ] {
            let (noisy, positions) = with_clicks(&clean, 21, rate);
            let source = Samples {
                data: noisy.clone(),
                channels: 1,
            };
            let output = render_all(
                VoiceToneSettings {
                    filters: [None; 5],
                    declick: Some(strength),
                },
                &source,
            );
            let before = error_db(&noisy, &clean);
            let after = error_db(&output, &clean);
            let repaired = positions
                .iter()
                .filter(|frame| {
                    let range = **frame..**frame + 8;
                    error_db(&output[range.clone()], &clean[range.clone()])
                        < error_db(&noisy[range.clone()], &clean[range]) - 10.0
                })
                .count();
            eprintln!(
                "{strength:?} {rate}/s: error {before:.1} dB -> {after:.1} dB, {repaired}/{} clicks repaired",
                positions.len()
            );
            assert!(before - after >= minimum_gain_db);
            assert!(repaired * 100 >= positions.len() * 90);
        }
    }

    #[test]
    fn declick_leaves_clean_voice_alone() {
        for seed in [1, 2, 3] {
            let clean = voice(10.0, seed);
            let source = Samples {
                data: clean.clone(),
                channels: 1,
            };
            for strength in [DeclickStrength::Light, DeclickStrength::Strong] {
                let output = render_all(
                    VoiceToneSettings {
                        filters: [None; 5],
                        declick: Some(strength),
                    },
                    &source,
                );
                let changed = output.iter().zip(&clean).filter(|(a, b)| a != b).count();
                eprintln!("seed {seed} {strength:?}: {changed} samples changed");
                if strength == DeclickStrength::Light {
                    assert_eq!(changed, 0);
                } else {
                    assert!(changed < clean.len() / 2_000);
                    assert!(error_db(&output, &clean) < -45.0);
                }
            }
        }
    }

    #[test]
    fn silence_short_tracks_and_non_finite_samples_stay_safe() {
        let settings = VoiceToneSettings {
            declick: Some(DeclickStrength::Strong),
            ..eq_only()
        };
        for frames in [0, 1, 17, 480, 23_999, 24_001] {
            let source = Samples {
                data: vec![0.0; frames],
                channels: 1,
            };
            assert_eq!(render_all(settings, &source), vec![0.0; frames]);
        }
        let mut data = voice(1.0, 4);
        data[100] = f32::NAN;
        data[20_000] = f32::INFINITY;
        data[30_000] = f32::NEG_INFINITY;
        let output = render_all(settings, &Samples { data, channels: 1 });
        assert!(
            output
                .iter()
                .all(|value| value.is_finite() && value.abs() < 2.0)
        );
        let mut impulse = vec![0.0; 48_000];
        impulse[20_000] = 0.9;
        let output = render_all(
            VoiceToneSettings {
                filters: [None; 5],
                declick: Some(DeclickStrength::Strong),
            },
            &Samples {
                data: impulse,
                channels: 1,
            },
        );
        assert!(output.iter().all(|value| value.abs() < 1e-6));
    }

    #[test]
    #[ignore = "requires CAP_VOICE_TONE_TEST_AUDIO pointing to local microphone recordings"]
    fn declick_rarely_touches_real_voice() {
        ffmpeg::init().unwrap();
        let paths = std::env::var("CAP_VOICE_TONE_TEST_AUDIO").unwrap();
        for path in paths.split(';') {
            let audio = crate::AudioData::from_file(path).unwrap();
            let channels = audio.channels();
            let source = Samples {
                data: audio.samples().to_vec(),
                channels,
            };
            let minutes = source.sample_count() as f64 / SAMPLE_RATE / 60.0;
            for strength in [DeclickStrength::Light, DeclickStrength::Strong] {
                let output = render_all(
                    VoiceToneSettings {
                        filters: [None; 5],
                        declick: Some(strength),
                    },
                    &source,
                );
                let changed = output
                    .iter()
                    .zip(&source.data)
                    .filter(|(a, b)| a != b)
                    .count();
                eprintln!(
                    "{strength:?} {minutes:.1} min: {changed} samples changed ({:.1} per minute), error {:.1} dB",
                    changed as f64 / minutes,
                    error_db(&output, &source.data)
                );
            }
        }
    }

    #[test]
    #[ignore = "timing probe"]
    fn tone_render_speed() {
        let source = Samples {
            data: voice(60.0, 9),
            channels: 1,
        };
        for settings in [
            eq_only(),
            VoiceToneSettings {
                declick: Some(DeclickStrength::Strong),
                ..eq_only()
            },
        ] {
            let started = std::time::Instant::now();
            let output = render_all(settings, &source);
            eprintln!(
                "{:?}: {:.1} ms per audio second",
                settings.declick,
                started.elapsed().as_secs_f64() * 1_000.0 / 60.0
            );
            assert_eq!(output.len(), source.data.len());
        }
    }
}
