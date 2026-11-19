use std::path::Path;
use std::sync::Mutex;

use anyhow::Context;
use ort::session::Session;
use ort::value::TensorRef;

use crate::frame::{LumaFrame, Rect};

pub struct ModelFile {
    pub file_name: &'static str,
    pub url: &'static str,
    pub sha256: &'static str,
    pub size: u64,
}

pub const DETECTION_MODEL: ModelFile = ModelFile {
    file_name: "ch_PP-OCRv4_det_infer.onnx",
    url: "https://huggingface.co/SWHL/RapidOCR/resolve/1cfba2e90fc938db55889873735088de210cc173/PP-OCRv4/ch_PP-OCRv4_det_infer.onnx",
    sha256: "d2a7720d45a54257208b1e13e36a8479894cb74155a5efe29462512d42f49da9",
    size: 4_745_517,
};

pub const RECOGNITION_MODEL: ModelFile = ModelFile {
    file_name: "ch_PP-OCRv4_rec_infer.onnx",
    url: "https://huggingface.co/SWHL/RapidOCR/resolve/1cfba2e90fc938db55889873735088de210cc173/PP-OCRv4/ch_PP-OCRv4_rec_infer.onnx",
    sha256: "48fc40f24f6d2a207a2b1091d3437eb3cc3eb6b676dc3ef9c37384005483683b",
    size: 10_857_958,
};

pub const MODELS: [ModelFile; 2] = [DETECTION_MODEL, RECOGNITION_MODEL];

const DETECTION_ALIGN: usize = 32;
const PIXEL_THRESHOLD: f32 = 0.3;
const BOX_THRESHOLD: f32 = 0.5;
const UNCLIP_RATIO: f32 = 1.6;
const MIN_BOX_SIDE: f32 = 3.0;
const LINE_HEIGHT: usize = 48;
const MIN_LINE_WIDTH: usize = 320;
const RECOGNITION_BATCH: usize = 8;

#[derive(Clone, Debug)]
pub struct ReadLine {
    pub text: String,
    pub boxes: Vec<Rect>,
}

impl ReadLine {
    pub fn span_rect(&self, start: usize, end: usize) -> Option<Rect> {
        self.boxes
            .get(start..end.min(self.boxes.len()))?
            .iter()
            .copied()
            .reduce(|a, b| a.union(&b))
    }
}

pub struct TextReader {
    detection: Mutex<Session>,
    recognition: Mutex<Session>,
    charset: Vec<char>,
}

fn session(path: &Path) -> anyhow::Result<Session> {
    Session::builder()
        .context("Failed to create an ONNX session builder")?
        .with_intra_op_spinning(false)
        .map_err(|error| anyhow::anyhow!("Failed to configure ONNX Runtime: {error}"))?
        .commit_from_file(path)
        .with_context(|| format!("Failed to load {}", path.display()))
}

fn normalized(value: u8) -> f32 {
    f32::from(value) / 127.5 - 1.0
}

fn components(probability: &[f32], width: usize, height: usize) -> Vec<(Rect, f32)> {
    let mut seen = vec![false; probability.len()];
    let mut found = Vec::new();
    let mut stack = Vec::new();
    for start in 0..probability.len() {
        if seen[start] || probability[start] <= PIXEL_THRESHOLD {
            continue;
        }
        seen[start] = true;
        stack.push(start);
        let (mut x0, mut y0, mut x1, mut y1) = (width, height, 0, 0);
        let (mut score, mut count) = (0.0f32, 0usize);
        while let Some(index) = stack.pop() {
            let (x, y) = (index % width, index / width);
            x0 = x0.min(x);
            y0 = y0.min(y);
            x1 = x1.max(x);
            y1 = y1.max(y);
            score += probability[index];
            count += 1;
            let neighbours = [
                (x > 0).then(|| index - 1),
                (x + 1 < width).then(|| index + 1),
                (y > 0).then(|| index - width),
                (y + 1 < height).then(|| index + width),
            ];
            for next in neighbours.into_iter().flatten() {
                if !seen[next] && probability[next] > PIXEL_THRESHOLD {
                    seen[next] = true;
                    stack.push(next);
                }
            }
        }
        let rect = Rect::new(x0 as f32, y0 as f32, x1 as f32 + 1.0, y1 as f32 + 1.0);
        if rect.width().min(rect.height()) >= MIN_BOX_SIDE {
            found.push((rect, score / count as f32));
        }
    }
    found
}

fn unclipped(rect: Rect, bounds: Rect) -> Rect {
    let (width, height) = (rect.width(), rect.height());
    let distance = width * height * UNCLIP_RATIO / (2.0 * (width + height));
    rect.expanded(distance, distance).intersection(&bounds)
}

fn line_input(frame: &LumaFrame, rect: Rect, width: usize, out: &mut [f32]) -> usize {
    let scale = LINE_HEIGHT as f32 / rect.height().max(1.0);
    let used = ((rect.width() * scale).ceil() as usize).clamp(1, width);
    out.fill(0.0);
    for y in 0..LINE_HEIGHT {
        let sy = rect.y0 + (y as f32 + 0.5) / scale - 0.5;
        for x in 0..used {
            let sx = rect.x0 + (x as f32 + 0.5) / scale - 0.5;
            let value = normalized(frame.sample(sx, sy));
            for channel in 0..3 {
                out[(channel * LINE_HEIGHT + y) * width + x] = value;
            }
        }
    }
    used
}

impl TextReader {
    pub fn load(models_dir: &Path) -> anyhow::Result<Self> {
        let recognition = session(&models_dir.join(RECOGNITION_MODEL.file_name))?;
        let dictionary = recognition
            .metadata()?
            .custom("character")
            .context("The recognition model carries no character list")?;
        let charset = std::iter::once('\0')
            .chain(dictionary.lines().filter_map(|line| line.chars().next()))
            .chain(std::iter::once(' '))
            .collect();
        Ok(Self {
            detection: Mutex::new(session(&models_dir.join(DETECTION_MODEL.file_name))?),
            recognition: Mutex::new(recognition),
            charset,
        })
    }

    fn detect_lines(&self, frame: &LumaFrame) -> anyhow::Result<Vec<Rect>> {
        let (width, height) = (frame.width as usize, frame.height as usize);
        let padded_width = width.div_ceil(DETECTION_ALIGN) * DETECTION_ALIGN;
        let padded_height = height.div_ceil(DETECTION_ALIGN) * DETECTION_ALIGN;
        let plane = padded_width * padded_height;
        let mut input = vec![0.0f32; plane * 3];
        for y in 0..padded_height {
            let row = &frame.pixels[y.min(height - 1) * width..][..width];
            for x in 0..padded_width {
                let value = normalized(row[x.min(width - 1)]);
                let index = y * padded_width + x;
                input[index] = value;
                input[plane + index] = value;
                input[plane * 2 + index] = value;
            }
        }
        let probability = {
            let mut detection = self
                .detection
                .lock()
                .map_err(|_| anyhow::anyhow!("The text detector is poisoned"))?;
            let outputs = detection.run(ort::inputs![TensorRef::from_array_view((
                [1usize, 3, padded_height, padded_width],
                &*input
            ))?])?;
            let (_, data) = outputs[0].try_extract_tensor::<f32>()?;
            data.to_vec()
        };
        let bounds = frame.bounds();
        let mut lines: Vec<Rect> = components(&probability, padded_width, padded_height)
            .into_iter()
            .filter(|(_, score)| *score >= BOX_THRESHOLD)
            .map(|(rect, _)| unclipped(rect, bounds))
            .filter(|rect| rect.width().min(rect.height()) >= MIN_BOX_SIDE)
            .collect();
        lines.sort_by(|a, b| a.y0.total_cmp(&b.y0).then(a.x0.total_cmp(&b.x0)));
        Ok(lines)
    }

    fn decode(
        &self,
        steps: &[f32],
        classes: usize,
        used: usize,
        width: usize,
        rect: Rect,
    ) -> ReadLine {
        let count = steps.len() / classes;
        let step_width = width as f32 / count.max(1) as f32;
        let scale = rect.width() / used.max(1) as f32;
        let mut chars: Vec<(char, f32)> = Vec::new();
        let mut previous = 0;
        for (step, scores) in steps.chunks_exact(classes).enumerate() {
            let (best, _) =
                scores
                    .iter()
                    .enumerate()
                    .fold((0, f32::MIN), |acc, (index, &score)| {
                        if score > acc.1 { (index, score) } else { acc }
                    });
            if best != 0 && best != previous {
                let center = rect.x0 + (step as f32 + 0.5) * step_width * scale;
                if let Some(&character) = self.charset.get(best) {
                    chars.push((character, center.min(rect.x1)));
                }
            }
            previous = best;
        }
        let edges: Vec<f32> = std::iter::once(rect.x0)
            .chain(chars.windows(2).map(|pair| (pair[0].1 + pair[1].1) / 2.0))
            .chain(std::iter::once(rect.x1))
            .collect();
        ReadLine {
            text: chars.iter().map(|(character, _)| *character).collect(),
            boxes: edges
                .windows(2)
                .map(|edge| Rect::new(edge[0], rect.y0, edge[1].max(edge[0]), rect.y1))
                .collect(),
        }
    }

    pub fn read(&self, frame: &LumaFrame) -> anyhow::Result<Vec<ReadLine>> {
        let mut lines = self.detect_lines(frame)?;
        lines.sort_by(|a, b| {
            (a.width() / a.height().max(1.0)).total_cmp(&(b.width() / b.height().max(1.0)))
        });
        let mut read = Vec::with_capacity(lines.len());
        let mut recognition = self
            .recognition
            .lock()
            .map_err(|_| anyhow::anyhow!("The text recognizer is poisoned"))?;
        for batch in lines.chunks(RECOGNITION_BATCH) {
            let widest = batch
                .iter()
                .map(|rect| {
                    (rect.width() * LINE_HEIGHT as f32 / rect.height().max(1.0)).ceil() as usize
                })
                .max()
                .unwrap_or(MIN_LINE_WIDTH);
            let width = widest.max(MIN_LINE_WIDTH).div_ceil(8) * 8;
            let size = 3 * LINE_HEIGHT * width;
            let mut input = vec![0.0f32; size * batch.len()];
            let used: Vec<usize> = batch
                .iter()
                .zip(input.chunks_exact_mut(size))
                .map(|(rect, out)| line_input(frame, *rect, width, out))
                .collect();
            let outputs = recognition.run(ort::inputs![TensorRef::from_array_view((
                [batch.len(), 3, LINE_HEIGHT, width],
                &*input
            ))?])?;
            let (shape, data) = outputs[0].try_extract_tensor::<f32>()?;
            let classes = shape[2] as usize;
            let per_line = shape[1] as usize * classes;
            for ((rect, used), steps) in batch.iter().zip(used).zip(data.chunks_exact(per_line)) {
                let line = self.decode(steps, classes, used, width, *rect);
                if !line.text.trim().is_empty() {
                    read.push(line);
                }
            }
        }
        read.sort_by(|a, b| {
            let (a, b) = (a.boxes[0], b.boxes[0]);
            a.y0.total_cmp(&b.y0).then(a.x0.total_cmp(&b.x0))
        });
        Ok(read)
    }
}
