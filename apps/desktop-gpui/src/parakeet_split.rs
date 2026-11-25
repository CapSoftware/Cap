//! The Recommended Parakeet encoder ships as one ONNX file with its weights
//! inside. ONNX Runtime keeps those embedded bytes for the whole session on
//! top of the copies it prepares for its kernels, so the model held about
//! 1.4 GB. With the weights in a side file it maps them from disk instead,
//! and the same model holds about half of that.
//!
//! The split is done here, once, on this computer: the side file holds the
//! weights byte for byte and the graph is untouched, so the transcript is
//! the same. If anything goes wrong the original file stays and is used.
//!
//! Wire format (onnx.proto): ModelProto.graph = 7, GraphProto.initializer =
//! 5, TensorProto.raw_data = 9, TensorProto.external_data = 13
//! (StringStringEntryProto key = 1, value = 2), TensorProto.data_location =
//! 14 (EXTERNAL = 1).

use std::{
    fs::File,
    io::{BufWriter, Write},
    path::{Path, PathBuf},
    sync::{Arc, Mutex, PoisonError},
};

pub const ENCODER: &str = "encoder-model.onnx";
pub const WEIGHTS: &str = "encoder-model.onnx.data";
/// Tensors smaller than this stay in the graph file.
const MIN_EXTERNAL_BYTES: usize = 1024;
/// Every moved tensor starts on this boundary (Windows maps at 64 KB).
const ALIGN: u64 = 64 * 1024;
/// A graph file this large still holds its weights.
const EMBEDDED_ABOVE: u64 = 200 * 1024 * 1024;
/// Room to keep free besides the side file while splitting.
const SPARE_BYTES: u64 = 512 * 1024 * 1024;

#[derive(Debug, PartialEq, Eq)]
pub enum Error {
    Malformed(&'static str),
    AlreadyExternal,
    Io(String),
}

impl From<std::io::Error> for Error {
    fn from(e: std::io::Error) -> Self {
        Error::Io(e.to_string())
    }
}

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Error::Malformed(what) => write!(f, "not a model file ({what})"),
            Error::AlreadyExternal => write!(f, "the weights are already outside the graph"),
            Error::Io(error) => write!(f, "{error}"),
        }
    }
}

fn varint(buf: &[u8], pos: &mut usize) -> Result<u64, Error> {
    let mut value = 0u64;
    for shift in (0..64).step_by(7) {
        let byte = *buf.get(*pos).ok_or(Error::Malformed("truncated varint"))?;
        *pos += 1;
        value |= u64::from(byte & 0x7f) << shift;
        if byte & 0x80 == 0 {
            return Ok(value);
        }
    }
    Err(Error::Malformed("varint too long"))
}

fn put_varint(out: &mut Vec<u8>, mut value: u64) {
    while value >= 0x80 {
        out.push((value as u8) | 0x80);
        value >>= 7;
    }
    out.push(value as u8);
}

fn put_bytes(out: &mut Vec<u8>, field: u32, bytes: &[u8]) {
    put_varint(out, (u64::from(field) << 3) | 2);
    put_varint(out, bytes.len() as u64);
    out.extend_from_slice(bytes);
}

struct Field<'a> {
    number: u32,
    /// The whole field as written.
    raw: &'a [u8],
    /// Length-delimited payload.
    payload: Option<&'a [u8]>,
    /// Varint value.
    value: Option<u64>,
}

fn fields(buf: &[u8]) -> impl Iterator<Item = Result<Field<'_>, Error>> {
    let mut pos = 0usize;
    let mut failed = false;
    std::iter::from_fn(move || {
        if failed || pos >= buf.len() {
            return None;
        }
        let start = pos;
        let result = (|| {
            let key = varint(buf, &mut pos)?;
            let number = (key >> 3) as u32;
            let (payload, value) = match key & 7 {
                0 => (None, Some(varint(buf, &mut pos)?)),
                1 => {
                    pos = pos.checked_add(8).ok_or(Error::Malformed("length"))?;
                    (None, None)
                }
                5 => {
                    pos = pos.checked_add(4).ok_or(Error::Malformed("length"))?;
                    (None, None)
                }
                2 => {
                    let len = usize::try_from(varint(buf, &mut pos)?)
                        .map_err(|_| Error::Malformed("length"))?;
                    let end = pos.checked_add(len).ok_or(Error::Malformed("length"))?;
                    let payload = buf
                        .get(pos..end)
                        .ok_or(Error::Malformed("truncated field"))?;
                    pos = end;
                    (Some(payload), None)
                }
                _ => return Err(Error::Malformed("unsupported wire type")),
            };
            if pos > buf.len() {
                return Err(Error::Malformed("truncated field"));
            }
            Ok(Field {
                number,
                raw: &buf[start..pos],
                payload,
                value,
            })
        })();
        failed = result.is_err();
        Some(result)
    })
}

struct Writer<W: Write> {
    weights: W,
    offset: u64,
    moved: usize,
}

impl<W: Write> Writer<W> {
    fn tensor(&mut self, tensor: &[u8]) -> Result<Vec<u8>, Error> {
        let mut raw_data = None;
        for field in fields(tensor) {
            let field = field?;
            match field.number {
                9 => raw_data = field.payload,
                13 => return Err(Error::AlreadyExternal),
                // DEFAULT (0) may be written out; anything else is external.
                14 if field.value != Some(0) => return Err(Error::AlreadyExternal),
                _ => {}
            }
        }
        let Some(raw) = raw_data.filter(|r| r.len() >= MIN_EXTERNAL_BYTES) else {
            return Ok(tensor.to_vec());
        };
        let pad = (ALIGN - self.offset % ALIGN) % ALIGN;
        self.weights.write_all(&vec![0u8; pad as usize])?;
        self.offset += pad;
        let offset = self.offset;
        self.weights.write_all(raw)?;
        self.offset += raw.len() as u64;
        self.moved += 1;
        let mut out = Vec::with_capacity(tensor.len() - raw.len() + 96);
        for field in fields(tensor) {
            let field = field?;
            if field.number != 9 && field.number != 14 {
                out.extend_from_slice(field.raw);
            }
        }
        for (key, value) in [
            ("location", WEIGHTS.to_string()),
            ("offset", offset.to_string()),
            ("length", raw.len().to_string()),
        ] {
            let mut entry = Vec::new();
            put_bytes(&mut entry, 1, key.as_bytes());
            put_bytes(&mut entry, 2, value.as_bytes());
            put_bytes(&mut out, 13, &entry);
        }
        put_varint(&mut out, 14 << 3);
        put_varint(&mut out, 1);
        Ok(out)
    }

    fn graph(&mut self, graph: &[u8]) -> Result<Vec<u8>, Error> {
        let mut out = Vec::new();
        for field in fields(graph) {
            let field = field?;
            match (field.number, field.payload) {
                (5, Some(tensor)) => put_bytes(&mut out, 5, &self.tensor(tensor)?),
                _ => out.extend_from_slice(field.raw),
            }
        }
        Ok(out)
    }
}

/// The graph with its large initializers moved into `weights`, and how many
/// moved.
pub fn split<W: Write>(model: &[u8], weights: W) -> Result<(Vec<u8>, usize), Error> {
    let mut writer = Writer {
        weights,
        offset: 0,
        moved: 0,
    };
    let mut out = Vec::new();
    let mut graphs = 0;
    for field in fields(model) {
        let field = field?;
        match (field.number, field.payload) {
            (7, Some(graph)) => {
                graphs += 1;
                put_bytes(&mut out, 7, &writer.graph(graph)?);
            }
            _ => out.extend_from_slice(field.raw),
        }
    }
    if graphs != 1 {
        return Err(Error::Malformed("expected one graph"));
    }
    writer.weights.flush()?;
    Ok((out, writer.moved))
}

/// Whether the encoder in `dir` still holds its weights.
fn needs_split_above(dir: &Path, above: u64) -> bool {
    std::fs::metadata(dir.join(ENCODER)).is_ok_and(|m| m.len() > above)
}

/// Whether the encoder in `dir` is installed and still holds its weights (a
/// model from before splits ran after downloads), without waiting for a
/// split already under way.
pub fn needs_split(dir: &Path) -> bool {
    needs_split_above(dir, EMBEDDED_ABOVE)
}

/// One lock per model folder: a split of one model (say right after its
/// download) never makes another model's load wait for it.
fn folder_lock(dir: &Path) -> Arc<Mutex<()>> {
    static LOCKS: Mutex<Vec<(PathBuf, Arc<Mutex<()>>)>> = Mutex::new(Vec::new());
    let key = dir.canonicalize().unwrap_or_else(|_| dir.to_path_buf());
    let mut locks = LOCKS.lock().unwrap_or_else(PoisonError::into_inner);
    if let Some((_, lock)) = locks.iter().find(|(folder, _)| *folder == key) {
        return lock.clone();
    }
    let lock = Arc::new(Mutex::new(()));
    locks.push((key, lock.clone()));
    lock
}

/// Splits the encoder in `dir` once. Safe to call before every load: it does
/// nothing when the split is done, there is too little disk, or the file is
/// not what it expects, and a failure leaves the original in place.
pub fn ensure_split(dir: &Path, free_bytes: impl Fn(&Path) -> Option<u64>) -> Result<bool, Error> {
    ensure_split_above(dir, EMBEDDED_ABOVE, free_bytes)
}

fn ensure_split_above(
    dir: &Path,
    above: u64,
    free_bytes: impl Fn(&Path) -> Option<u64>,
) -> Result<bool, Error> {
    let lock = folder_lock(dir);
    let _one = lock.lock().unwrap_or_else(PoisonError::into_inner);
    if !needs_split_above(dir, above) {
        return Ok(false);
    }
    let encoder = dir.join(ENCODER);
    let size = std::fs::metadata(&encoder)?.len();
    if free_bytes(dir).is_some_and(|free| free < size.saturating_add(SPARE_BYTES)) {
        return Err(Error::Io("not enough free space to split the model".into()));
    }
    let graph_tmp = dir.join(format!("{ENCODER}.split"));
    let weights_tmp = dir.join(format!("{WEIGHTS}.split"));
    let result = (|| {
        let source = File::open(&encoder)?;
        // Mapped, so the split never holds the whole model in memory.
        let model = unsafe { memmap2::Mmap::map(&source)? };
        let weights = File::create(&weights_tmp)?;
        let (graph, moved) = split(&model, BufWriter::with_capacity(1 << 20, &weights))?;
        weights.sync_all()?;
        let mut graph_file = File::create(&graph_tmp)?;
        graph_file.write_all(&graph)?;
        graph_file.sync_all()?;
        drop(model);
        drop(source);
        // The side file first: until the graph is replaced, the old file
        // still holds every weight and ignores it.
        std::fs::rename(&weights_tmp, dir.join(WEIGHTS))?;
        std::fs::rename(&graph_tmp, &encoder)?;
        Ok(moved)
    })();
    match result {
        Ok(moved) => {
            tracing::info!(moved, dir = %dir.display(), "Parakeet encoder weights now map from disk");
            Ok(true)
        }
        Err(error) => {
            let _ = std::fs::remove_file(&graph_tmp);
            let _ = std::fs::remove_file(&weights_tmp);
            Err(error)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tensor(name: &str, raw: &[u8], explicit_default: bool) -> Vec<u8> {
        let mut t = Vec::new();
        put_varint(&mut t, 1 << 3); // dims
        put_varint(&mut t, raw.len() as u64);
        put_varint(&mut t, 2 << 3); // data_type
        put_varint(&mut t, 2);
        put_bytes(&mut t, 8, name.as_bytes());
        put_bytes(&mut t, 9, raw);
        if explicit_default {
            put_varint(&mut t, 14 << 3);
            put_varint(&mut t, 0);
        }
        t
    }

    fn model(tensors: &[Vec<u8>]) -> Vec<u8> {
        let mut graph = Vec::new();
        put_bytes(&mut graph, 1, b"node bytes stay as they are");
        for t in tensors {
            put_bytes(&mut graph, 5, t);
        }
        put_bytes(&mut graph, 2, b"graph name");
        let mut m = Vec::new();
        put_varint(&mut m, 1 << 3); // ir_version
        put_varint(&mut m, 8);
        put_bytes(&mut m, 7, &graph);
        put_bytes(&mut m, 8, b"opset");
        m
    }

    fn entries(tensor: &[u8]) -> Vec<(String, String)> {
        fields(tensor)
            .filter_map(Result::ok)
            .filter(|f| f.number == 13)
            .map(|f| {
                let mut kv = fields(f.payload.unwrap()).filter_map(Result::ok);
                let k = kv.next().unwrap().payload.unwrap();
                let v = kv.next().unwrap().payload.unwrap();
                (
                    String::from_utf8(k.to_vec()).unwrap(),
                    String::from_utf8(v.to_vec()).unwrap(),
                )
            })
            .collect()
    }

    fn graph_tensors(model: &[u8]) -> Vec<Vec<u8>> {
        let graph = fields(model)
            .filter_map(Result::ok)
            .find(|f| f.number == 7)
            .unwrap()
            .payload
            .unwrap();
        fields(graph)
            .filter_map(Result::ok)
            .filter(|f| f.number == 5)
            .map(|f| f.payload.unwrap().to_vec())
            .collect()
    }

    #[test]
    fn large_weights_move_out_byte_for_byte_and_small_ones_stay() {
        let big: Vec<u8> = (0..5000u32).map(|i| (i % 251) as u8).collect();
        let big2: Vec<u8> = (0..3000u32).map(|i| (i % 13) as u8).collect();
        let small = vec![7u8; 16];
        let original = model(&[
            tensor("a", &big, false),
            tensor("s", &small, false),
            tensor("b", &big2, true),
        ]);
        let mut weights = Vec::new();
        let (graph, moved) = split(&original, &mut weights).unwrap();
        assert_eq!(moved, 2);
        let tensors = graph_tensors(&graph);
        assert_eq!(
            tensors[1],
            tensor("s", &small, false),
            "a small tensor is untouched"
        );
        for (t, raw) in [(&tensors[0], &big), (&tensors[2], &big2)] {
            let e = entries(t);
            assert_eq!(e[0], ("location".into(), WEIGHTS.into()));
            let offset: usize = e[1].1.parse().unwrap();
            let length: usize = e[2].1.parse().unwrap();
            assert_eq!(
                offset as u64 % ALIGN,
                0,
                "each tensor starts on a mapping boundary"
            );
            assert_eq!(&weights[offset..offset + length], raw.as_slice());
            assert!(
                fields(t).filter_map(Result::ok).all(|f| f.number != 9),
                "no bytes left inline"
            );
            let location: Vec<u64> = fields(t)
                .filter_map(Result::ok)
                .filter(|f| f.number == 14)
                .filter_map(|f| f.value)
                .collect();
            assert_eq!(location, vec![1], "marked external exactly once");
        }
        // Everything but the initializers is as it was, in order.
        let strip = |m: &[u8]| {
            let graph = fields(m)
                .filter_map(Result::ok)
                .find(|f| f.number == 7)
                .unwrap()
                .payload
                .unwrap()
                .to_vec();
            fields(&graph)
                .filter_map(Result::ok)
                .filter(|f| f.number != 5)
                .map(|f| f.raw.to_vec())
                .collect::<Vec<_>>()
        };
        assert_eq!(strip(&graph), strip(&original));
    }

    #[test]
    fn a_model_already_split_or_broken_is_refused() {
        let big = vec![1u8; 4096];
        let original = model(&[tensor("a", &big, false)]);
        let (graph, _) = split(&original, &mut Vec::new()).unwrap();
        assert_eq!(
            split(&graph, &mut Vec::new()).unwrap_err(),
            Error::AlreadyExternal
        );
        assert!(matches!(
            split(&original[..original.len() - 3], &mut Vec::new()),
            Err(Error::Malformed(_))
        ));
        assert!(matches!(
            split(b"\x3a\xff\xff\xff\xff\x0f", &mut Vec::new()),
            Err(Error::Malformed(_))
        ));
    }

    #[test]
    fn ensure_split_replaces_the_file_once_and_leaves_it_on_failure() {
        let dir = tempfile::tempdir().unwrap();
        let big = vec![3u8; 70_000];
        let original = model(&[tensor("a", &big, false)]);
        std::fs::write(dir.path().join(ENCODER), &original).unwrap();

        assert!(
            matches!(
                ensure_split_above(dir.path(), 1024, |_| Some(10)),
                Err(Error::Io(_))
            ),
            "too little disk"
        );
        assert_eq!(
            std::fs::read(dir.path().join(ENCODER)).unwrap(),
            original,
            "original kept"
        );
        assert!(!dir.path().join(WEIGHTS).exists());

        assert_eq!(ensure_split_above(dir.path(), 1024, |_| None), Ok(true));
        assert!(!needs_split_above(dir.path(), 1024));
        assert_eq!(
            ensure_split_above(dir.path(), 1024, |_| None),
            Ok(false),
            "done once"
        );
        let weights = std::fs::read(dir.path().join(WEIGHTS)).unwrap();
        assert_eq!(&weights[..big.len()], big.as_slice());
        let leftovers: Vec<_> = std::fs::read_dir(dir.path())
            .unwrap()
            .filter_map(Result::ok)
            .filter(|e| e.file_name().to_string_lossy().ends_with(".split"))
            .collect();
        assert!(leftovers.is_empty());
    }

    #[test]
    fn a_split_of_one_model_never_holds_up_another() {
        let best = tempfile::tempdir().unwrap();
        let max = tempfile::tempdir().unwrap();
        let held = folder_lock(best.path());
        let _splitting = held.lock().unwrap();
        assert!(
            folder_lock(max.path()).try_lock().is_ok(),
            "another model's folder is free while this one splits"
        );
        assert!(
            folder_lock(&best.path().join(".")).try_lock().is_err(),
            "the same folder, however it is spelled, shares the lock"
        );
    }

    #[test]
    fn a_new_download_over_a_split_model_is_split_again() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join(WEIGHTS), b"left from before").unwrap();
        let big = vec![9u8; 70_000];
        std::fs::write(dir.path().join(ENCODER), model(&[tensor("a", &big, false)])).unwrap();
        assert!(needs_split_above(dir.path(), 1024));
        assert_eq!(ensure_split_above(dir.path(), 1024, |_| None), Ok(true));
        let weights = std::fs::read(dir.path().join(WEIGHTS)).unwrap();
        assert_eq!(&weights[..big.len()], big.as_slice());
    }
}
