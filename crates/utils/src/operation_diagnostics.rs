use serde::{Deserialize, Serialize};
use std::{
    collections::hash_map::RandomState,
    hash::BuildHasher,
    io::Write,
    path::Path,
    sync::{
        Mutex, OnceLock,
        atomic::{AtomicU64, Ordering},
    },
    time::{Instant, SystemTime, UNIX_EPOCH},
};

const CAPACITY: usize = 64;
const MAX_FIELDS: usize = 16;
static HISTORY: History = History::new();
type DiagnosticSink = Box<dyn Fn(&[u8]) + Send + Sync>;
static SINK: OnceLock<DiagnosticSink> = OnceLock::new();
static APP: OnceLock<AppInfo> = OnceLock::new();
static PARENT: OnceLock<Option<OperationId>> = OnceLock::new();
static SESSION: OnceLock<u64> = OnceLock::new();
static RESOURCE_HASH: OnceLock<RandomState> = OnceLock::new();
static OMITTED_RECORDS: AtomicU64 = AtomicU64::new(0);
static EMISSION_EPOCH: OnceLock<Instant> = OnceLock::new();
static EMISSION_BUDGET: ByteBudget = ByteBudget(AtomicU64::new(0));
pub const MAX_BYTES_PER_SECOND: u32 = 32 * 1024;
type QueueLossCounter = Box<dyn Fn() -> usize + Send + Sync>;
static QUEUE_LOSS_COUNTER: OnceLock<QueueLossCounter> = OnceLock::new();
const HEALTH_KINDS: usize = 16;
static HEALTH_COUNTS: [AtomicU64; HEALTH_KINDS] = [const { AtomicU64::new(0) }; HEALTH_KINDS];
static HEALTH_LAST_MS: [AtomicU64; HEALTH_KINDS] = [const { AtomicU64::new(0) }; HEALTH_KINDS];

pub fn health_event(kind: usize, name: &'static str, fields: &[Field]) {
    let (Some(count), Some(last)) = (HEALTH_COUNTS.get(kind), HEALTH_LAST_MS.get(kind)) else {
        return;
    };
    let occurrences = count.fetch_add(1, Ordering::Relaxed).saturating_add(1);
    let now = unix_ms();
    let previous = last.load(Ordering::Relaxed);
    if previous != 0 && now.saturating_sub(previous) < 60_000 {
        return;
    }
    if last
        .compare_exchange(previous, now, Ordering::Relaxed, Ordering::Relaxed)
        .is_err()
    {
        return;
    }
    let mut event = Operation::new_in(&HISTORY, "process_health", fields);
    event.field(Field::label("event", name));
    event.field(Field::number("occurrences_in_process", occurrences));
    event.record.outcome = Outcome::Observed;
    event.finished = true;
    event.publish();
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct OperationId {
    session: u64,
    process: u32,
    sequence: u64,
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    pub flavor: &'static str,
    pub version: &'static str,
    pub source_revision: Option<&'static str>,
    pub debug_build: bool,
    pub source_dirty: Option<bool>,
}

pub fn install_sink(app: AppInfo, sink: impl Fn(&[u8]) + Send + Sync + 'static) {
    let _ = APP.set(app);
    let _ = RESOURCE_HASH.set(RandomState::new());
    let _ = SESSION.set(unix_ms());
    let _ = EMISSION_EPOCH.set(Instant::now());
    let _ = PARENT.set(
        std::env::var("CAP_DIAGNOSTIC_PARENT")
            .ok()
            .filter(|value| value.len() <= 160)
            .and_then(|value| serde_json::from_str(&value).ok()),
    );
    let _ = SINK.set(Box::new(sink));
}

struct ByteBudget(AtomicU64);

impl ByteBudget {
    fn acquire(&self, second: u32, bytes: u32) -> bool {
        let mut previous = self.0.load(Ordering::Relaxed);
        for _ in 0..4 {
            if previous >> 32 > u64::from(second) {
                return false;
            }
            let used = if previous >> 32 == u64::from(second) {
                previous as u32
            } else {
                0
            };
            let next = used.saturating_add(bytes);
            if next > MAX_BYTES_PER_SECOND {
                return false;
            }
            let state = (u64::from(second) << 32) | u64::from(next);
            match self.0.compare_exchange_weak(
                previous,
                state,
                Ordering::Relaxed,
                Ordering::Relaxed,
            ) {
                Ok(_) => return true,
                Err(actual) => previous = actual,
            }
        }
        false
    }
}

fn emit_bytes(sink: &DiagnosticSink, bytes: &[u8]) {
    let second = EMISSION_EPOCH.get_or_init(Instant::now).elapsed().as_secs() as u32;
    if EMISSION_BUDGET.acquire(second, bytes.len() as u32) {
        sink(bytes);
    } else {
        OMITTED_RECORDS.fetch_add(1, Ordering::Relaxed);
    }
}

pub fn install_queue_loss_counter(counter: impl Fn() -> usize + Send + Sync + 'static) {
    let _ = QUEUE_LOSS_COUNTER.set(Box::new(counter));
}

fn unix_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u64::MAX as u128) as u64
}

pub fn resource_id(path: &Path) -> u64 {
    RESOURCE_HASH.get_or_init(RandomState::new).hash_one(path)
}

struct RecordBuffer {
    bytes: [u8; crate::diagnostic_writer::MAX_RECORD_BYTES],
    length: usize,
}

impl Write for RecordBuffer {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        let remaining = self.bytes.len().saturating_sub(self.length);
        if bytes.len() > remaining {
            return Err(std::io::Error::other(
                "Diagnostic record exceeded its budget",
            ));
        }
        self.bytes[self.length..self.length + bytes.len()].copy_from_slice(bytes);
        self.length += bytes.len();
        Ok(bytes.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

fn emit(record: &Record) {
    let Some(sink) = SINK.get() else { return };
    let mut buffer = RecordBuffer {
        bytes: [0; crate::diagnostic_writer::MAX_RECORD_BYTES],
        length: 0,
    };
    let result = (|| {
        buffer.write_all(crate::diagnostic_writer::RECORD_PREFIX)?;
        serde_json::to_writer(&mut buffer, record)?;
        buffer.write_all(b"\n")
    })();
    if result.is_ok() {
        emit_bytes(sink, &buffer.bytes[..buffer.length]);
    } else {
        OMITTED_RECORDS.fetch_add(1, Ordering::Relaxed);
    }
}

pub fn relay_worker_record(line: &str) -> bool {
    let prefix = crate::diagnostic_writer::RECORD_PREFIX;
    if !line.as_bytes().starts_with(prefix)
        || line.len() >= crate::diagnostic_writer::MAX_RECORD_BYTES
    {
        return false;
    }
    let Some(sink) = SINK.get() else { return false };
    let mut buffer = RecordBuffer {
        bytes: [0; crate::diagnostic_writer::MAX_RECORD_BYTES],
        length: 0,
    };
    if buffer
        .write_all(line.as_bytes())
        .and_then(|_| buffer.write_all(b"\n"))
        .is_ok()
    {
        emit_bytes(sink, &buffer.bytes[..buffer.length]);
        true
    } else {
        false
    }
}

pub fn checkpoint_active() {
    let captured = HISTORY.snapshot_records();
    if let Some(records) = captured {
        for mut record in records
            .into_iter()
            .flatten()
            .filter(|record| matches!(record.outcome, Outcome::InProgress))
        {
            record.elapsed_ms = record.started.elapsed().as_millis().min(u64::MAX as u128) as u64;
            emit(&record);
        }
    }
}

pub async fn run_checkpoints() {
    loop {
        tokio::time::sleep(std::time::Duration::from_secs(60)).await;
        checkpoint_active();
    }
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(untagged)]
pub enum Value {
    Number(u64),
    Identifier(#[serde(serialize_with = "serialize_identifier")] u64),
    Flag(bool),
    Label(&'static str),
}

fn serialize_identifier<S: serde::Serializer>(
    value: &u64,
    serializer: S,
) -> Result<S::Ok, S::Error> {
    serializer.collect_str(&format_args!("{value:016x}"))
}

#[derive(Clone, Copy, Debug, Serialize)]
pub struct Field {
    name: &'static str,
    value: Value,
}

impl Field {
    pub const fn number(name: &'static str, value: u64) -> Self {
        Self {
            name,
            value: Value::Number(value),
        }
    }

    pub const fn identifier(name: &'static str, value: u64) -> Self {
        Self {
            name,
            value: Value::Identifier(value),
        }
    }

    pub const fn flag(name: &'static str, value: bool) -> Self {
        Self {
            name,
            value: Value::Flag(value),
        }
    }

    pub const fn label(name: &'static str, value: &'static str) -> Self {
        Self {
            name,
            value: Value::Label(value),
        }
    }
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Outcome {
    InProgress,
    ReturnedOk,
    ReturnedError,
    Incomplete,
    Observed,
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Record {
    schema_version: u32,
    id: u64,
    revision: u64,
    operation_id: OperationId,
    parent_operation_id: Option<OperationId>,
    app: Option<AppInfo>,
    os: &'static str,
    binary_architecture: &'static str,
    #[serde(skip)]
    started: Instant,
    operation: &'static str,
    started_at_unix_ms: u64,
    elapsed_ms: u64,
    stage: &'static str,
    outcome: Outcome,
    fields: [Option<Field>; MAX_FIELDS],
    omitted_fields: usize,
}

struct History {
    records: Mutex<[Option<Record>; CAPACITY]>,
    active_sequences: [AtomicU64; CAPACITY],
    sequence: AtomicU64,
    dropped_updates: AtomicU64,
}

impl History {
    const fn new() -> Self {
        Self {
            records: Mutex::new([None; CAPACITY]),
            active_sequences: [const { AtomicU64::new(0) }; CAPACITY],
            sequence: AtomicU64::new(0),
            dropped_updates: AtomicU64::new(0),
        }
    }

    fn is_active(&self, index: usize, record: Record) -> bool {
        matches!(record.outcome, Outcome::InProgress)
            && self.active_sequences[index].load(Ordering::Relaxed) == record.id.wrapping_add(1)
    }

    fn retire(&self, index: usize, id: u64) {
        let _ = self.active_sequences[index].compare_exchange(
            id.wrapping_add(1),
            0,
            Ordering::Relaxed,
            Ordering::Relaxed,
        );
    }

    fn publish(&self, record: Record) -> Option<usize> {
        let index = if let Ok(mut records) = self.records.try_lock() {
            let index = records
                .iter()
                .position(|slot| slot.is_some_and(|previous| previous.id == record.id))
                .or_else(|| records.iter().position(Option::is_none))
                .or_else(|| {
                    records
                        .iter()
                        .enumerate()
                        .filter_map(|(index, slot)| {
                            slot.filter(|previous| !self.is_active(index, *previous))
                                .map(|previous| (index, previous.id))
                        })
                        .min_by_key(|(_, id)| *id)
                        .map(|(index, _)| index)
                });
            if let Some(index) = index {
                self.active_sequences[index].store(
                    if matches!(record.outcome, Outcome::InProgress) {
                        record.id.wrapping_add(1)
                    } else {
                        0
                    },
                    Ordering::Relaxed,
                );
                records[index] = Some(record);
            } else {
                self.dropped_updates.fetch_add(1, Ordering::Relaxed);
            }
            index
        } else {
            self.dropped_updates.fetch_add(1, Ordering::Relaxed);
            None
        };
        emit(&record);
        index
    }

    fn snapshot_records(&self) -> Option<[Option<Record>; CAPACITY]> {
        let mut captured = self.records.try_lock().ok().map(|records| *records)?;
        for (index, slot) in captured.iter_mut().enumerate() {
            if slot.is_some_and(|record| {
                matches!(record.outcome, Outcome::InProgress) && !self.is_active(index, record)
            }) {
                *slot = None;
            }
        }
        Some(captured)
    }

    fn snapshot(&self) -> Snapshot {
        let captured = self.snapshot_records();
        let mut records: Vec<_> = captured.into_iter().flatten().flatten().collect();
        records.sort_unstable_by_key(|record| record.id);
        Snapshot {
            schema_version: 2,
            scope: "current_process_only",
            outcome_semantics: "return_value_only_not_media_validation",
            status: if captured.is_some() {
                "available"
            } else {
                "busy"
            },
            process_id: std::process::id(),
            capacity: CAPACITY,
            storage_bytes: std::mem::size_of::<Self>(),
            total_started: self.sequence.load(Ordering::Relaxed),
            dropped_updates: self.dropped_updates.load(Ordering::Relaxed),
            journal_sink_installed: SINK.get().is_some(),
            journal_write_failures: crate::diagnostic_writer::write_failures(),
            logger_dropped_messages: QUEUE_LOSS_COUNTER.get().map(|counter| counter()),
            omitted_records: OMITTED_RECORDS.load(Ordering::Relaxed),
            records,
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    schema_version: u32,
    scope: &'static str,
    outcome_semantics: &'static str,
    status: &'static str,
    process_id: u32,
    capacity: usize,
    storage_bytes: usize,
    total_started: u64,
    dropped_updates: u64,
    journal_sink_installed: bool,
    journal_write_failures: u64,
    logger_dropped_messages: Option<usize>,
    omitted_records: u64,
    records: Vec<Record>,
}

pub fn snapshot() -> Snapshot {
    HISTORY.snapshot()
}

pub struct Operation {
    history: &'static History,
    history_slot: Option<usize>,
    started: Instant,
    record: Record,
    finished: bool,
}

impl Operation {
    pub fn start(operation: &'static str, fields: &[Field]) -> Self {
        Self::start_in(&HISTORY, operation, fields)
    }

    fn start_in(history: &'static History, operation: &'static str, fields: &[Field]) -> Self {
        let mut value = Self::new_in(history, operation, fields);
        value.publish();
        value
    }

    fn new_in(history: &'static History, operation: &'static str, fields: &[Field]) -> Self {
        let id = history.sequence.fetch_add(1, Ordering::Relaxed);
        let started = Instant::now();
        let mut record = Record {
            schema_version: 2,
            id,
            revision: 0,
            operation_id: OperationId {
                session: *SESSION.get_or_init(unix_ms),
                process: std::process::id(),
                sequence: id,
            },
            parent_operation_id: PARENT.get().copied().flatten(),
            app: APP.get().copied(),
            os: std::env::consts::OS,
            binary_architecture: std::env::consts::ARCH,
            started,
            operation,
            started_at_unix_ms: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis()
                .min(u64::MAX as u128) as u64,
            elapsed_ms: 0,
            stage: "started",
            outcome: Outcome::InProgress,
            fields: [None; MAX_FIELDS],
            omitted_fields: fields.len().saturating_sub(MAX_FIELDS),
        };
        for (slot, field) in record.fields.iter_mut().zip(fields) {
            *slot = Some(*field);
        }
        Self {
            history,
            history_slot: None,
            started,
            record,
            finished: false,
        }
    }

    pub fn id(&self) -> OperationId {
        self.record.operation_id
    }

    pub fn set_parent(&mut self, parent: OperationId) {
        self.record.parent_operation_id = Some(parent);
        self.publish();
    }

    pub fn stage(&mut self, stage: &'static str) {
        self.record.stage = stage;
        self.publish();
    }

    pub fn field(&mut self, field: Field) {
        if let Some(slot) = self
            .record
            .fields
            .iter_mut()
            .find(|slot| slot.is_some_and(|value| value.name == field.name))
        {
            *slot = Some(field);
        } else if let Some(slot) = self.record.fields.iter_mut().find(|slot| slot.is_none()) {
            *slot = Some(field);
        } else {
            self.record.omitted_fields = self.record.omitted_fields.saturating_add(1);
        }
    }

    pub fn finish(mut self, succeeded: bool) {
        self.record.outcome = if succeeded {
            Outcome::ReturnedOk
        } else {
            Outcome::ReturnedError
        };
        self.publish();
        self.finished = true;
    }

    fn publish(&mut self) {
        if !matches!(self.record.outcome, Outcome::InProgress)
            && let Some(index) = self.history_slot
        {
            self.history.retire(index, self.record.id);
        }
        self.record.revision = self.record.revision.saturating_add(1);
        self.record.elapsed_ms = self.started.elapsed().as_millis().min(u64::MAX as u128) as u64;
        if let Some(index) = self.history.publish(self.record) {
            self.history_slot = Some(index);
        }
    }
}

impl Drop for Operation {
    fn drop(&mut self) {
        if !self.finished {
            self.record.outcome = Outcome::Incomplete;
            self.publish();
        }
    }
}

pub async fn observe<T, E>(
    operation: &'static str,
    fields: &[Field],
    future: impl Future<Output = Result<T, E>>,
) -> Result<T, E> {
    let diagnostic = Operation::start(operation, fields);
    let result = future.await;
    diagnostic.finish(result.is_ok());
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn event_storms_have_a_fixed_byte_budget_without_waiting() {
        let budget = ByteBudget(AtomicU64::new(0));
        for _ in 0..MAX_BYTES_PER_SECOND / 1024 {
            assert!(budget.acquire(0, 1024));
        }
        for _ in 0..10_000 {
            assert!(!budget.acquire(0, 1024));
        }
        assert!(budget.acquire(1, 1024));
        assert!(!budget.acquire(1, MAX_BYTES_PER_SECOND));
        assert!(!budget.acquire(0, 1024));
    }

    struct ChildGuard(std::process::Child);

    impl Drop for ChildGuard {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }

    #[test]
    fn killed_process_leaves_context_in_the_upload() {
        let dir = tempfile::tempdir().unwrap();
        let child = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--ignored",
                "--exact",
                "operation_diagnostics::tests::diagnostic_child",
                "--nocapture",
            ])
            .env("CAP_DIAGNOSTIC_TEST_DIRECTORY", dir.path())
            .env("CAP_DIAGNOSTIC_TEST_MODE", "crash")
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .unwrap();
        let mut child = ChildGuard(child);
        let started = Instant::now();
        loop {
            let bundle = crate::log_upload::collect(dir.path(), "cap-test.log");
            if bundle.text.contains("waiting_for_encoder") {
                break;
            }
            assert!(
                started.elapsed() < std::time::Duration::from_secs(10),
                "child did not persist its checkpoint"
            );
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        child.0.kill().unwrap();
        child.0.wait().unwrap();
        let bundle = crate::log_upload::collect(dir.path(), "cap-test.log");
        let records: Vec<serde_json::Value> = bundle
            .text
            .lines()
            .filter_map(|line| line.strip_prefix("CAP_DIAGNOSTIC "))
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        assert!(records.len() >= 2);
        assert!(
            records
                .iter()
                .any(|record| record["stage"] == "waiting_for_encoder")
        );
        assert!(
            records
                .iter()
                .all(|record| record["outcome"] == "in_progress")
        );
        assert!(
            records
                .iter()
                .all(|record| record["operationId"] == records[0]["operationId"])
        );
        assert_eq!(records[0]["app"]["version"], "test-build");
        assert!(
            bundle
                .files
                .iter()
                .any(|file| file.name.ends_with("diagnostic-current.jsonl"))
        );
    }

    #[test]
    fn worker_records_keep_the_parent_operation_identity() {
        let dir = tempfile::tempdir().unwrap();
        let parent = OperationId {
            session: 123,
            process: 456,
            sequence: 789,
        };
        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--ignored",
                "--exact",
                "operation_diagnostics::tests::diagnostic_child",
                "--nocapture",
            ])
            .env("CAP_DIAGNOSTIC_TEST_DIRECTORY", dir.path())
            .env("CAP_DIAGNOSTIC_TEST_MODE", "complete")
            .env(
                "CAP_DIAGNOSTIC_PARENT",
                serde_json::to_string(&parent).unwrap(),
            )
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let bundle = crate::log_upload::collect(dir.path(), "cap-test.log");
        let records: Vec<serde_json::Value> = bundle
            .text
            .lines()
            .filter_map(|line| line.strip_prefix("CAP_DIAGNOSTIC "))
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        assert!(
            records
                .iter()
                .any(|record| record["outcome"] == "returned_ok")
        );
        assert!(
            records
                .iter()
                .all(|record| record["parentOperationId"] == serde_json::to_value(parent).unwrap())
        );
    }

    #[test]
    #[ignore]
    fn diagnostic_child() {
        let Some(directory) = std::env::var_os("CAP_DIAGNOSTIC_TEST_DIRECTORY") else {
            return;
        };
        let writer = crate::diagnostic_writer::DiagnosticWriter::new(
            std::io::sink(),
            Path::new(&directory),
            "cap-test.log",
        );
        let (writer, guard) = tracing_appender::non_blocking(writer);
        install_sink(
            AppInfo {
                flavor: "test",
                version: "test-build",
                source_revision: Some("test-revision"),
                debug_build: cfg!(debug_assertions),
                source_dirty: Some(false),
            },
            move |bytes| {
                let _ = writer.clone().write_all(bytes);
            },
        );
        let mut operation = Operation::start(
            "recording",
            &[
                Field::number("requested_fps", 60),
                Field::flag("microphone", true),
            ],
        );
        operation.stage("waiting_for_encoder");
        checkpoint_active();
        if std::env::var("CAP_DIAGNOSTIC_TEST_MODE").as_deref() == Ok("crash") {
            loop {
                std::thread::sleep(std::time::Duration::from_secs(1));
            }
        }
        operation.finish(true);
        drop(guard);
    }

    fn history() -> &'static History {
        Box::leak(Box::new(History::new()))
    }

    #[test]
    fn history_stays_bounded_and_keeps_recent_operations() {
        let history = history();
        for _ in 0..CAPACITY * 20 {
            Operation::start_in(history, "export", &[]).finish(true);
        }
        let snapshot = history.snapshot();
        assert_eq!(snapshot.records.len(), CAPACITY);
        assert_eq!(snapshot.total_started, (CAPACITY * 20) as u64);
        assert_eq!(snapshot.records[0].id, (CAPACITY * 19) as u64);
        assert!(snapshot.storage_bytes < 64 * 1024);
    }

    #[test]
    fn contention_drops_diagnostics_without_waiting() {
        let history = history();
        let guard = history.records.lock().unwrap();
        Operation::start_in(history, "recording", &[]).finish(false);
        assert_eq!(history.snapshot().status, "busy");
        drop(guard);
        assert_eq!(history.snapshot().dropped_updates, 2);
    }

    #[test]
    fn lost_completions_cannot_checkpoint_forever_or_exhaust_history() {
        let history = history();
        for _ in 0..CAPACITY * 2 {
            let operation = Operation::start_in(history, "recording", &[]);
            let guard = history.records.lock().unwrap();
            operation.finish(true);
            drop(guard);
            assert!(
                history
                    .snapshot_records()
                    .unwrap()
                    .into_iter()
                    .all(|slot| slot.is_none())
            );
        }
        Operation::start_in(history, "recent_export", &[]).finish(false);
        let snapshot = history.snapshot();
        assert_eq!(snapshot.dropped_updates, (CAPACITY * 2) as u64);
        assert_eq!(snapshot.records.len(), 1);
        assert_eq!(snapshot.records[0].operation, "recent_export");
        assert!(matches!(
            snapshot.records[0].outcome,
            Outcome::ReturnedError
        ));
    }

    #[test]
    fn cancelled_operations_retire_while_history_is_busy() {
        let history = history();
        let operation = Operation::start_in(history, "export", &[]);
        let guard = history.records.lock().unwrap();
        drop(operation);
        drop(guard);
        assert!(history.snapshot().records.is_empty());
        assert_eq!(history.snapshot().dropped_updates, 1);
    }

    #[test]
    fn active_operations_survive_recent_completed_operations() {
        let history = history();
        let old = Operation::start_in(history, "old", &[]);
        for _ in 0..CAPACITY {
            Operation::start_in(history, "new", &[]).finish(true);
        }
        old.finish(false);
        let snapshot = history.snapshot();
        assert!(
            snapshot
                .records
                .iter()
                .any(|record| record.operation == "old")
        );
        assert_eq!(snapshot.records.len(), CAPACITY);
        assert_eq!(snapshot.dropped_updates, 0);
    }

    #[test]
    fn dropped_operations_and_missing_fields_are_explicit() {
        let history = history();
        let fields = [Field::number("fps", 60); MAX_FIELDS + 3];
        let mut operation = Operation::start_in(history, "playback", &fields);
        operation.stage("audio_initialization");
        drop(operation);
        let snapshot = history.snapshot();
        let record = snapshot.records[0];
        assert!(matches!(record.outcome, Outcome::Incomplete));
        assert_eq!(record.omitted_fields, 3);
        assert_eq!(record.stage, "audio_initialization");
        serde_json::to_string(&snapshot).unwrap();
    }

    #[tokio::test]
    async fn observation_preserves_results_and_cancellation() {
        let error = String::from("original error");
        let pointer = error.as_ptr();
        let result = observe("test", &[], async { Err::<(), _>(error) }).await;
        let returned_error = result.unwrap_err();
        assert_eq!(returned_error.as_ptr(), pointer);
        let result = observe("test", &[], async { Ok::<_, ()>(42) }).await;
        assert_eq!(result, Ok(42));
        let mut pending = Box::pin(observe(
            "test_pending",
            &[],
            std::future::pending::<Result<(), ()>>(),
        ));
        assert!(futures::poll!(pending.as_mut()).is_pending());
        drop(pending);
    }

    #[test]
    #[ignore]
    fn operation_boundary_overhead() {
        let history = history();
        let fields = [Field::number("measurement", 60); MAX_FIELDS];
        let measure = |paced: bool| {
            let mut samples = Vec::with_capacity(100);
            for _ in 0..100 {
                if paced {
                    std::thread::sleep(std::time::Duration::from_millis(100));
                }
                let started = Instant::now();
                let mut operation = Operation::start_in(history, "export", &fields);
                operation.stage("encoding");
                operation.finish(true);
                samples.push(started.elapsed().as_nanos());
            }
            samples.sort_unstable();
            serde_json::json!({
                "p50Ns": samples[50],
                "p95Ns": samples[95],
                "p99Ns": samples[99],
                "maxNs": samples[99],
                "meanNs": samples.iter().sum::<u128>() / samples.len() as u128,
            })
        };
        let without_sink = measure(false);
        let dir = tempfile::tempdir().unwrap();
        let writer = crate::diagnostic_writer::DiagnosticWriter::new(
            std::io::sink(),
            dir.path(),
            "cap-benchmark.log",
        );
        let (writer, guard) = tracing_appender::non_blocking(writer);
        let errors = writer.error_counter();
        let bytes_emitted = std::sync::Arc::new(AtomicU64::new(0));
        let emitted = bytes_emitted.clone();
        install_sink(
            AppInfo {
                flavor: "benchmark",
                version: "test",
                source_revision: None,
                debug_build: cfg!(debug_assertions),
                source_dirty: Some(true),
            },
            move |bytes| {
                emitted.fetch_add(bytes.len() as u64, Ordering::Relaxed);
                let _ = writer.clone().write_all(bytes);
            },
        );
        let with_disk_sink = measure(true);
        drop(guard);
        let retained_bytes: u64 = std::fs::read_dir(dir.path())
            .unwrap()
            .map(|entry| entry.unwrap().metadata().unwrap().len())
            .sum();
        assert!(retained_bytes <= 2 * crate::diagnostic_writer::MAX_FILE_BYTES);
        println!(
            "{}",
            serde_json::json!({
                "unit": "one_start_stage_finish_with_16_fields",
                "iterations": 100,
                "operationsPerSecond": 10,
                "omittedRecords": OMITTED_RECORDS.load(Ordering::Relaxed),
                "withoutSink": without_sink,
                "withAsyncDiskSink": with_disk_sink,
                "emittedBytes": bytes_emitted.load(Ordering::Relaxed),
                "retainedBytes": retained_bytes,
                "droppedMessages": errors.dropped_lines(),
                "fixedHistoryBytes": std::mem::size_of::<History>(),
                "debugBuild": cfg!(debug_assertions),
            })
        );
    }
}
