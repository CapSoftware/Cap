//! Seeded, reproducible fuzzing of the engines' file inputs. Each seed
//! derives a list of mutations of a valid input (structure-aware for JSON,
//! box-aware for MP4 and fragments); the harness runs a batch of seeds per
//! child process, isolates crashes and hangs per seed, and shrinks a failing
//! seed by dropping mutations while it still fails the same way.

use std::{path::Path, sync::Arc};

use anyhow::Context;
use cap_verify::fixture::Rng;
use serde_json::{Value, json};

use super::{
    harness::{Ctx, Probe, Verdict},
    project::{self, SEGMENT},
};

fn hostile_scalar(rng: &mut Rng) -> Value {
    match rng.range(0, 21) {
        0 => json!(0),
        1 => json!(-1),
        2 => json!(1),
        3 => json!(0.5),
        4 => json!(1e300),
        5 => json!(-1e300),
        6 => json!(1e-300),
        7 => json!(4_294_967_295u64),
        8 => json!(4_294_967_296u64),
        9 => json!(u64::MAX),
        10 => json!(i64::MIN),
        11 => json!(2_147_483_648u64),
        12 => json!(""),
        13 => json!("\u{0}\u{202E}\u{1F4A5}"),
        14 => json!("x".repeat(rng.range(1, 70_000) as usize)),
        15 => json!(true),
        16 => Value::Null,
        17 => json!([]),
        18 => json!({}),
        19 => json!(-0.0),
        20 => json!(65_536),
        _ => json!(3.0e38),
    }
}

/// Every path to a node of `value`, as a list of keys and indices.
fn paths(value: &Value, prefix: &mut Vec<Value>, out: &mut Vec<Vec<Value>>) {
    out.push(prefix.clone());
    match value {
        Value::Object(map) => {
            for (k, v) in map {
                prefix.push(json!(k));
                paths(v, prefix, out);
                prefix.pop();
            }
        }
        Value::Array(items) => {
            for (i, v) in items.iter().enumerate() {
                prefix.push(json!(i));
                paths(v, prefix, out);
                prefix.pop();
            }
        }
        _ => {}
    }
}

fn at<'a>(value: &'a mut Value, path: &[Value]) -> Option<&'a mut Value> {
    let mut cur = value;
    for key in path {
        cur = match key {
            Value::String(k) => cur.get_mut(k.as_str())?,
            Value::Number(i) => cur.get_mut(i.as_u64()? as usize)?,
            _ => return None,
        };
    }
    Some(cur)
}

/// One JSON mutation, fully determined by its own seed.
#[derive(Clone, Copy, Debug)]
pub struct JsonMutation(u64);

impl JsonMutation {
    pub fn apply(&self, root: &mut Value) {
        let mut rng = Rng::new(self.0);
        let mut all = Vec::new();
        paths(root, &mut Vec::new(), &mut all);
        // Bias towards leaves and numbers, where hostile values matter.
        let candidates: Vec<&Vec<Value>> = all.iter().filter(|p| !p.is_empty()).collect();
        if candidates.is_empty() {
            return;
        }
        let path = candidates[rng.range(0, candidates.len() as u64 - 1) as usize].clone();
        let op = rng.range(0, 11);
        let (parent_path, key) = path.split_at(path.len() - 1);
        let key = key[0].clone();
        let Some(target) = at(root, &path) else {
            return;
        };
        // Most mutations keep the node's type, so they reach the engines
        // instead of stopping at deserialization.
        if rng.range(0, 9) < 6 {
            match target {
                Value::Number(_) => {
                    *target = match rng.range(0, 13) {
                        0 => json!(0),
                        1 => json!(-1),
                        2 => json!(1e300),
                        3 => json!(-1e300),
                        4 => json!(1e-300),
                        5 => json!(u32::MAX),
                        6 => json!(u64::MAX),
                        7 => json!(-0.0),
                        8 => json!(i32::MIN),
                        9 => json!(3.0e38),
                        10 => json!(-3.0e38),
                        11 => json!(-target.as_f64().unwrap_or(1.0)),
                        _ => json!(target.as_f64().unwrap_or(1.0) * 1e6),
                    };
                    return;
                }
                Value::String(_) => {
                    *target = match rng.range(0, 4) {
                        0 => json!(""),
                        1 => json!("\u{0}\u{202E}\u{1F4A5}"),
                        2 => json!("\u{1F4A5}".repeat(rng.range(1, 20_000) as usize)),
                        _ => json!("../../../../../../dev/zero"),
                    };
                    return;
                }
                Value::Bool(b) => {
                    *b = !*b;
                    return;
                }
                _ => {}
            }
        }
        match op {
            0..=3 => *target = hostile_scalar(&mut rng),
            4 => {
                if let Some(n) = target.as_f64() {
                    *target = json!(match rng.range(0, 4) {
                        0 => -n,
                        1 => n * 1e6,
                        2 => n + 1e9,
                        3 => n - 1e9,
                        _ => n * 1e-9,
                    });
                } else {
                    *target = hostile_scalar(&mut rng);
                }
            }
            5 => {
                if let Value::Array(items) = target {
                    items.reverse();
                } else {
                    *target = json!([target.clone()]);
                }
            }
            6 => {
                if let Value::Array(items) = target
                    && let Some(first) = items.first().cloned()
                {
                    let copies = rng.range(1, 50) as usize;
                    items.extend(std::iter::repeat_n(first, copies));
                }
            }
            7 => {
                if let Value::Array(items) = target {
                    items.clear();
                } else if let Value::Object(map) = target {
                    map.clear();
                }
            }
            8 => {
                let Some(parent) = at(root, parent_path) else {
                    return;
                };
                match (parent, &key) {
                    (Value::Object(map), Value::String(k)) => {
                        map.remove(k);
                    }
                    (Value::Array(items), Value::Number(i)) => {
                        let i = i.as_u64().unwrap_or(0) as usize;
                        if i < items.len() {
                            items.remove(i);
                        }
                    }
                    _ => {}
                }
            }
            9 => {
                let mut nested = hostile_scalar(&mut rng);
                for _ in 0..rng.range(1, 200) {
                    nested = json!([nested]);
                }
                *target = nested;
            }
            _ => {
                let Some(parent) = at(root, parent_path) else {
                    return;
                };
                if let Value::Array(items) = parent
                    && items.len() > 1
                {
                    let a = rng.range(0, items.len() as u64 - 1) as usize;
                    let b = rng.range(0, items.len() as u64 - 1) as usize;
                    items.swap(a, b);
                }
            }
        }
    }
}

pub fn json_mutations(seed: u64, salt: u64) -> Vec<JsonMutation> {
    let mut rng = Rng::new(seed.wrapping_mul(0x9E37_79B9).wrapping_add(salt));
    let n = rng.range(1, 12);
    (0..n).map(|_| JsonMutation(rng.next_u64())).collect()
}

/// One byte-level mutation of a media file.
#[derive(Clone, Copy, Debug)]
pub struct ByteMutation(u64);

/// Offsets of plausible ISO BMFF box headers (size + four ASCII letters).
fn boxes(bytes: &[u8]) -> Vec<usize> {
    (0..bytes.len().saturating_sub(8))
        .filter(|&i| bytes[i + 4..i + 8].iter().all(|b| b.is_ascii_lowercase()))
        .collect()
}

impl ByteMutation {
    pub fn apply(&self, bytes: &mut Vec<u8>) {
        if bytes.is_empty() {
            return;
        }
        let mut rng = Rng::new(self.0);
        let len = bytes.len() as u64;
        match rng.range(0, 8) {
            0 => {
                for _ in 0..rng.range(1, 16) {
                    let i = rng.range(0, len - 1) as usize;
                    bytes[i] ^= 1 << rng.range(0, 7);
                }
            }
            1 => {
                let i = rng.range(0, len - 1) as usize;
                let n = rng.range(1, 256) as usize;
                for b in bytes.iter_mut().skip(i).take(n) {
                    *b = rng.next_u64() as u8;
                }
            }
            2 => {
                let keep = rng.range(0, len - 1) as usize;
                bytes.truncate(keep);
            }
            3 => {
                let i = rng.range(0, len - 1) as usize;
                let n = rng.range(1, 64) as usize;
                let insert: Vec<u8> = (0..n).map(|_| rng.next_u64() as u8).collect();
                bytes.splice(i..i, insert);
            }
            4 => {
                let i = rng.range(0, len - 1) as usize;
                let n = (rng.range(1, 4096) as usize).min(bytes.len() - i);
                let chunk = bytes[i..i + n].to_vec();
                bytes.splice(i..i, chunk);
            }
            5 => {
                let i = rng.range(0, len - 1) as usize;
                let n = rng.range(1, 2048) as usize;
                for b in bytes.iter_mut().skip(i).take(n) {
                    *b = 0;
                }
            }
            _ => {
                let headers = boxes(bytes);
                if headers.is_empty() {
                    return;
                }
                let at = headers[rng.range(0, headers.len() as u64 - 1) as usize];
                let size: u32 = match rng.range(0, 6) {
                    0 => 0,
                    1 => 1,
                    2 => 7,
                    3 => 8,
                    4 => u32::MAX,
                    5 => len as u32 * 2,
                    _ => rng.next_u64() as u32,
                };
                bytes[at..at + 4].copy_from_slice(&size.to_be_bytes());
            }
        }
    }
}

pub fn byte_mutations(seed: u64, salt: u64) -> Vec<ByteMutation> {
    let mut rng = Rng::new(seed.wrapping_mul(0xD1B5_4A32).wrapping_add(salt));
    let n = rng.range(1, 4);
    (0..n).map(|_| ByteMutation(rng.next_u64())).collect()
}

fn mutate_json_file(ctx: &Ctx, path: &Path, salt: u64) -> anyhow::Result<usize> {
    let mut value: Value = serde_json::from_slice(&std::fs::read(path)?)?;
    let mutations = json_mutations(ctx.seed, salt);
    for (i, m) in mutations.iter().enumerate() {
        if ctx.keeps(i) {
            m.apply(&mut value);
        }
    }
    std::fs::write(path, serde_json::to_vec(&value)?)?;
    Ok(mutations.len())
}

fn mutate_bytes_file(ctx: &Ctx, path: &Path, salt: u64) -> anyhow::Result<usize> {
    let mut bytes = std::fs::read(path)?;
    let mutations = byte_mutations(ctx.seed, salt);
    for (i, m) in mutations.iter().enumerate() {
        if ctx.keeps(i) {
            m.apply(&mut bytes);
        }
    }
    std::fs::write(path, bytes)?;
    Ok(mutations.len())
}

fn tag(verdict: Verdict, mutations: usize) -> Verdict {
    match verdict {
        Verdict::Ok(t) => Verdict::Ok(format!("mutations={mutations}; {t}")),
        Verdict::Rejected(t) => Verdict::Rejected(format!("mutations={mutations}; {t}")),
        Verdict::Wrong(t) => Verdict::Wrong(format!("mutations={mutations}; {t}")),
    }
}

type Target = Arc<dyn Fn(&Ctx) -> anyhow::Result<Verdict> + Send + Sync>;

fn target(f: impl Fn(&Ctx) -> anyhow::Result<Verdict> + Send + Sync + 'static) -> Target {
    Arc::new(f)
}

fn small_export(ctx: &Ctx, dir: &Path) -> anyhow::Result<Verdict> {
    ctx.block_on(project::export(
        dir,
        &ctx.path("out.mp4"),
        project::Format::Mp4 { bpp: None },
        5,
        (160, 90),
    ))
}

pub fn probes() -> Vec<Probe> {
    let targets: Vec<(&'static str, u64, u64, u64, Target)> = vec![
        (
            "project-config/open",
            80,
            800,
            30,
            target(|ctx| {
                let dir = project::prepare(ctx).context("prepare")?;
                let n = mutate_json_file(ctx, &dir.join("project-config.json"), 1)?;
                Ok(tag(project::open(&dir)?, n))
            }),
        ),
        (
            "project-config/export",
            10,
            60,
            90,
            target(|ctx| {
                let dir = project::prepare(ctx).context("prepare")?;
                let n = mutate_json_file(ctx, &dir.join("project-config.json"), 2)?;
                Ok(tag(small_export(ctx, &dir)?, n))
            }),
        ),
        (
            "project-config/editor",
            0,
            20,
            90,
            target(|ctx| {
                let dir = project::prepare(ctx).context("prepare")?;
                let n = mutate_json_file(ctx, &dir.join("project-config.json"), 3)?;
                Ok(tag(ctx.block_on(project::editor(&dir, false))?, n))
            }),
        ),
        (
            "recording-meta/open",
            60,
            600,
            30,
            target(|ctx| {
                let dir = project::prepare(ctx).context("prepare")?;
                let n = mutate_json_file(ctx, &dir.join("recording-meta.json"), 4)?;
                Ok(tag(project::open(&dir)?, n))
            }),
        ),
        (
            "recording-meta/export",
            8,
            50,
            90,
            target(|ctx| {
                let dir = project::prepare(ctx).context("prepare")?;
                let n = mutate_json_file(ctx, &dir.join("recording-meta.json"), 5)?;
                Ok(tag(small_export(ctx, &dir)?, n))
            }),
        ),
        (
            "cursor/export",
            10,
            60,
            90,
            target(|ctx| {
                let dir = project::prepare(ctx).context("prepare")?;
                let n = mutate_json_file(ctx, &dir.join(SEGMENT).join("cursor.json"), 6)?;
                Ok(tag(small_export(ctx, &dir)?, n))
            }),
        ),
        (
            "display-mp4/export",
            10,
            60,
            90,
            target(|ctx| {
                let dir = project::prepare(ctx).context("prepare")?;
                let n = mutate_bytes_file(ctx, &dir.join(SEGMENT).join("display.mp4"), 7)?;
                Ok(tag(small_export(ctx, &dir)?, n))
            }),
        ),
        (
            "camera-mp4/export",
            6,
            40,
            90,
            target(|ctx| {
                let dir = project::prepare(ctx).context("prepare")?;
                let n = mutate_bytes_file(ctx, &dir.join(SEGMENT).join("camera.mp4"), 8)?;
                Ok(tag(small_export(ctx, &dir)?, n))
            }),
        ),
        (
            "mic-ogg/export",
            6,
            40,
            90,
            target(|ctx| {
                let dir = project::prepare(ctx).context("prepare")?;
                let n = mutate_bytes_file(ctx, &dir.join(SEGMENT).join("audio-input.ogg"), 9)?;
                Ok(tag(small_export(ctx, &dir)?, n))
            }),
        ),
        (
            "display-mp4/open",
            30,
            300,
            30,
            target(|ctx| {
                let dir = project::prepare(ctx).context("prepare")?;
                let n = mutate_bytes_file(ctx, &dir.join(SEGMENT).join("display.mp4"), 10)?;
                Ok(tag(project::open(&dir)?, n))
            }),
        ),
    ];
    let mut out: Vec<Probe> = targets
        .into_iter()
        .map(|(name, fast, full, timeout, run)| {
            let mut probe = Probe::new(format!("chaos/fuzz/{name}"), timeout, move |ctx| run(ctx))
                .seeded(fast, full);
            if fast == 0 {
                probe = probe.full();
            }
            probe
        })
        .collect();
    out.extend(super::fragments::fuzz_probes());
    out
}
