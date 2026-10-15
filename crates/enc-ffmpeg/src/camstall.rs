use serde_json::{Value, json};
use std::{
    cell::RefCell,
    fs::File,
    io::{BufWriter, Write},
    path::PathBuf,
    sync::{
        OnceLock,
        atomic::{AtomicU64, Ordering},
    },
    time::Instant,
};

static DIRECTORY: OnceLock<Option<PathBuf>> = OnceLock::new();
static ORIGIN: OnceLock<Instant> = OnceLock::new();
static NEXT_ID: AtomicU64 = AtomicU64::new(0);

pub fn enabled() -> bool {
    DIRECTORY
        .get_or_init(|| std::env::var_os("CAP_CAMSTALL_DIR").map(PathBuf::from))
        .is_some()
}

thread_local! {
    static WRITER: RefCell<Option<BufWriter<File>>> = const { RefCell::new(None) };
}

pub fn event(stage: &str, fields: Value) {
    if !enabled() {
        return;
    }
    let time_us = ORIGIN.get_or_init(Instant::now).elapsed().as_micros();
    let thread = std::thread::current();
    WRITER.with_borrow_mut(|writer| {
        if writer.is_none() {
            let directory = DIRECTORY.get().and_then(Option::as_ref).unwrap();
            std::fs::create_dir_all(directory).expect("camstall directory");
            let file = File::create(directory.join(format!(
                "{}-{:?}.jsonl",
                std::process::id(),
                thread.id()
            )))
            .expect("camstall file");
            *writer = Some(BufWriter::with_capacity(262144, file));
        }
        let writer = writer.as_mut().unwrap();
        let record =
            json!({"time_us": time_us, "thread": thread.name(), "stage": stage, "fields": fields});
        serde_json::to_writer(&mut *writer, &record).expect("camstall record");
        writer.write_all(b"\n").expect("camstall newline");
    });
}

pub struct Span {
    stage: &'static str,
    fields: Value,
    id: u64,
    started: Instant,
}

pub fn span(stage: &'static str, fields: Value) -> Option<Span> {
    if !enabled() {
        return None;
    }
    let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
    let started = Instant::now();
    event(stage, json!({"edge": "begin", "id": id, "data": fields}));
    Some(Span {
        stage,
        fields,
        id,
        started,
    })
}

impl Drop for Span {
    fn drop(&mut self) {
        let duration_us = self.started.elapsed().as_micros();
        event(
            self.stage,
            json!({"edge": "end", "id": self.id, "duration_us": duration_us, "data": self.fields}),
        );
    }
}
