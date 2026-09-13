use std::{future::Future, path::PathBuf, time::Duration};

const GIB: u64 = 1024 * 1024 * 1024;
const DISK_RESERVE: u64 = 512 * 1024 * 1024;
const DISK_WARNING: u64 = 5 * GIB;
const SAMPLE_INTERVAL: Duration = Duration::from_secs(2);
const DISK_SAMPLE_TIMEOUT: Duration = Duration::from_millis(500);
static DISK_SAMPLE_SLOT: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(1);
const CRITICAL_MEMORY_SAMPLES: u8 = 3;
const STOP_PREFIX: &str = "Export stopped to protect your computer: ";

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
enum MemoryPressure {
    #[default]
    Unknown,
    Normal,
    Warning,
    Critical,
}

#[derive(Clone)]
pub struct DiskBudget {
    pub path: PathBuf,
    pub description: &'static str,
    pub estimated_bytes: u64,
}

#[derive(Clone)]
pub struct ExportResources {
    disks: Vec<DiskBudget>,
}

#[derive(Default)]
struct Sample {
    free_bytes: Vec<Option<u64>>,
    memory: MemoryPressure,
}

#[derive(Default)]
struct PressureHistory {
    critical_memory_samples: u8,
}

impl ExportResources {
    pub fn new(mut disks: Vec<DiskBudget>) -> Self {
        #[cfg(target_os = "macos")]
        let system_path = Some(PathBuf::from("/System/Volumes/Data"));
        #[cfg(not(target_os = "macos"))]
        let system_path = directories::BaseDirs::new().map(|home| home.home_dir().to_path_buf());
        if let Some(path) = system_path {
            disks.push(DiskBudget {
                path,
                description: "your system drive",
                estimated_bytes: 0,
            });
        }
        Self { disks }
    }

    fn disk_free_bytes(&self) -> Vec<Option<u64>> {
        self.disks
            .iter()
            .map(|disk| crate::disk_space::free_bytes_for_path(&disk.path).ok())
            .collect()
    }

    async fn read(&self) -> Sample {
        let resources = self.clone();
        let free_bytes = read_disk_space(
            move || resources.disk_free_bytes(),
            &DISK_SAMPLE_SLOT,
            DISK_SAMPLE_TIMEOUT,
        )
        .await;
        Sample {
            free_bytes,
            memory: memory_pressure(),
        }
    }

    fn disk_failure(&self, sample: &Sample) -> Option<String> {
        self.disks.iter().zip(&sample.free_bytes).find_map(|(disk, free)| {
            free.filter(|free| *free <= DISK_RESERVE).map(|free| {
                format!("{STOP_PREFIX}{} has only {:.2} GiB free. Free up disk space and try again. Your original recording has been kept.", disk.description, free as f64 / GIB as f64)
            })
        })
    }

    pub async fn check(&self) -> Result<Option<String>, String> {
        let sample = self.read().await;
        if let Some(error) = self.disk_failure(&sample) {
            return Err(error);
        }
        Ok(self.warning(&sample))
    }

    fn warning(&self, sample: &Sample) -> Option<String> {
        let mut warnings = Vec::new();
        let lowest = self
            .disks
            .iter()
            .zip(&sample.free_bytes)
            .filter_map(|(disk, free)| free.map(|free| (disk, free)))
            .filter(|(disk, free)| *free < DISK_WARNING.saturating_add(disk.estimated_bytes))
            .min_by_key(|(disk, free)| free.saturating_sub(disk.estimated_bytes));
        if let Some((disk, free)) = lowest {
            let estimate = if disk.estimated_bytes > 0 {
                format!(
                    " This export may need approximately {:.2} GiB, including temporary files.",
                    disk.estimated_bytes as f64 / GIB as f64
                )
            } else {
                String::new()
            };
            warnings.push(format!(
                "Only {:.2} GiB is available on {}.{estimate}",
                free as f64 / GIB as f64,
                disk.description
            ));
        }
        if matches!(
            sample.memory,
            MemoryPressure::Warning | MemoryPressure::Critical
        ) {
            warnings.push("Your computer is already under memory pressure. Close other applications before exporting.".to_string());
        }
        if warnings.is_empty() {
            None
        } else {
            warnings.push("The export may fail or your computer may become unresponsive if resources run out. Cap monitors resources during export and may stop if they become critically low.".to_string());
            Some(warnings.join("\n\n"))
        }
    }

    pub async fn supervise<T>(
        &self,
        export: impl Future<Output = Result<T, String>>,
        stop: impl FnOnce(),
    ) -> Result<T, String> {
        self.supervise_with(export, stop, || self.read(), SAMPLE_INTERVAL)
            .await
    }

    async fn supervise_with<T, F, S>(
        &self,
        export: impl Future<Output = Result<T, String>>,
        stop: impl FnOnce(),
        mut sample: F,
        interval: Duration,
    ) -> Result<T, String>
    where
        F: FnMut() -> S,
        S: Future<Output = Sample>,
    {
        tokio::pin!(export);
        let mut history = PressureHistory::default();
        let mut ticks = tokio::time::interval(interval);
        ticks.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            let observation = tokio::select! {
                biased;
                result = &mut export => return result,
                _ = ticks.tick() => {
                    tokio::select! {
                        biased;
                        result = &mut export => return result,
                        observation = sample() => observation,
                    }
                }
            };
            if let Some(error) = self
                .disk_failure(&observation)
                .or_else(|| history.observe(observation.memory))
            {
                tracing::warn!(reason = %error, "Stopping export because resources are exhausted");
                stop();
                let _ = export.await;
                return Err(error);
            }
        }
    }
}

async fn read_disk_space(
    probe: impl FnOnce() -> Vec<Option<u64>> + Send + 'static,
    slot: &'static tokio::sync::Semaphore,
    timeout: Duration,
) -> Vec<Option<u64>> {
    let Ok(permit) = slot.try_acquire() else {
        return Vec::new();
    };
    let (sender, sample) = tokio::sync::oneshot::channel();
    // Windows exports drop a per-command Tokio runtime; a stalled disk probe
    // must not hold that runtime's shutdown open.
    if std::thread::Builder::new()
        .name("export-resource-check".into())
        .spawn(move || {
            let _permit = permit;
            let _ = sender.send(probe());
        })
        .is_err()
    {
        return Vec::new();
    }
    tokio::time::timeout(timeout, sample)
        .await
        .ok()
        .and_then(Result::ok)
        .unwrap_or_default()
}

impl PressureHistory {
    fn observe(&mut self, pressure: MemoryPressure) -> Option<String> {
        self.critical_memory_samples = if pressure == MemoryPressure::Critical {
            self.critical_memory_samples.saturating_add(1)
        } else {
            0
        };
        (self.critical_memory_samples >= CRITICAL_MEMORY_SAMPLES).then(|| {
            format!("{STOP_PREFIX}memory pressure stayed critically high. Close other applications or choose a lower export resolution and try again. Your original recording has been kept.")
        })
    }
}

pub fn is_resource_stop(error: &str) -> bool {
    error.starts_with(STOP_PREFIX)
}

pub fn estimated_working_bytes(megabytes: f64) -> u64 {
    if megabytes.is_finite() && megabytes > 0.0 {
        (megabytes * 1024.0 * 1024.0 * 2.0).ceil() as u64
    } else {
        0
    }
}

#[cfg(target_os = "macos")]
fn memory_pressure() -> MemoryPressure {
    let mut level = 0u32;
    let mut length = std::mem::size_of_val(&level);
    let result = unsafe {
        libc::sysctlbyname(
            c"kern.memorystatus_vm_pressure_level".as_ptr(),
            (&mut level as *mut u32).cast(),
            &mut length,
            std::ptr::null_mut(),
            0,
        )
    };
    if result != 0 || length != std::mem::size_of_val(&level) {
        return MemoryPressure::Unknown;
    }
    match level {
        1 => MemoryPressure::Normal,
        2 => MemoryPressure::Warning,
        4 => MemoryPressure::Critical,
        _ => MemoryPressure::Unknown,
    }
}

#[cfg(not(target_os = "macos"))]
fn memory_pressure() -> MemoryPressure {
    MemoryPressure::Unknown
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        cell::Cell,
        sync::{
            Arc,
            atomic::{AtomicBool, Ordering},
        },
    };

    fn resources() -> ExportResources {
        ExportResources {
            disks: vec![DiskBudget {
                path: PathBuf::from("unused"),
                description: "your export drive",
                estimated_bytes: 2 * GIB,
            }],
        }
    }

    fn sample(free: Option<u64>, memory: MemoryPressure) -> Sample {
        Sample {
            free_bytes: vec![free],
            memory,
        }
    }

    #[test]
    fn warns_for_working_space_without_blocking_estimates() {
        let resources = resources();
        for (free, warns, stops) in [
            (9 * GIB, false, false),
            (6 * GIB, true, false),
            (GIB, true, false),
            (DISK_RESERVE, true, true),
            (0, true, true),
        ] {
            let observation = sample(Some(free), MemoryPressure::Normal);
            assert_eq!(resources.warning(&observation).is_some(), warns);
            assert_eq!(resources.disk_failure(&observation).is_some(), stops);
        }
    }

    #[test]
    fn unknown_metrics_do_not_reject_healthy_exports() {
        let observation = sample(None, MemoryPressure::Unknown);
        assert!(resources().warning(&observation).is_none());
        assert!(resources().disk_failure(&observation).is_none());
    }

    #[test]
    fn a_transient_or_unknown_pressure_sample_resets_the_stop_threshold() {
        let mut history = PressureHistory::default();
        for pressure in [
            MemoryPressure::Critical,
            MemoryPressure::Critical,
            MemoryPressure::Normal,
            MemoryPressure::Critical,
            MemoryPressure::Critical,
            MemoryPressure::Unknown,
            MemoryPressure::Critical,
            MemoryPressure::Warning,
        ] {
            assert!(history.observe(pressure).is_none());
        }
        assert!(history.observe(MemoryPressure::Critical).is_none());
        assert!(history.observe(MemoryPressure::Critical).is_none());
        assert!(history.observe(MemoryPressure::Critical).is_some());
    }

    #[test]
    fn invalid_or_oversized_estimates_do_not_wrap() {
        for invalid in [f64::NAN, f64::INFINITY, -1.0, 0.0] {
            assert_eq!(estimated_working_bytes(invalid), 0);
        }
        assert_eq!(estimated_working_bytes(1024.0), 2 * GIB);
        assert_eq!(estimated_working_bytes(f64::MAX), u64::MAX);
    }

    #[tokio::test]
    async fn stops_without_progress_and_waits_for_export_cleanup() {
        let (tx, rx) = tokio::sync::oneshot::channel();
        let cleaned = Arc::new(AtomicBool::new(false));
        let observed = cleaned.clone();
        let result = resources()
            .supervise_with(
                async move {
                    rx.await.unwrap();
                    observed.store(true, Ordering::Release);
                    Err::<(), _>("Export cancelled".into())
                },
                move || {
                    tx.send(()).unwrap();
                },
                || async { sample(Some(0), MemoryPressure::Normal) },
                Duration::from_millis(1),
            )
            .await;
        assert!(is_resource_stop(&result.unwrap_err()));
        assert!(cleaned.load(Ordering::Acquire));
    }

    #[tokio::test]
    async fn reports_resource_stop_and_preserves_files_when_completion_races() {
        let (tx, rx) = tokio::sync::oneshot::channel();
        let directory = tempfile::tempdir().unwrap();
        let output = directory.path().join("completed.mp4");
        let completed = output.clone();
        let result = resources()
            .supervise_with(
                async move {
                    rx.await.unwrap();
                    std::fs::write(&completed, b"completed output").unwrap();
                    Ok(completed)
                },
                move || {
                    tx.send(()).unwrap();
                },
                || async { sample(Some(0), MemoryPressure::Normal) },
                Duration::from_millis(1),
            )
            .await;
        assert!(is_resource_stop(&result.unwrap_err()));
        assert_eq!(std::fs::read(output).unwrap(), b"completed output");
    }

    #[tokio::test]
    async fn completion_is_not_delayed_by_a_stalled_storage_sample() {
        let result = resources()
            .supervise_with(
                async {
                    tokio::task::yield_now().await;
                    Ok(42)
                },
                || panic!("Healthy export should not stop"),
                std::future::pending::<Sample>,
                Duration::from_millis(1),
            )
            .await;
        assert_eq!(result.unwrap(), 42);
    }

    #[tokio::test]
    async fn no_samples_or_stop_callbacks_survive_completion() {
        let samples = Cell::new(0);
        let result = resources()
            .supervise_with(
                async { Ok(42) },
                || panic!("Completed export should not stop"),
                || {
                    samples.set(samples.get() + 1);
                    async { sample(None, MemoryPressure::Unknown) }
                },
                Duration::from_millis(1),
            )
            .await;
        assert_eq!(result.unwrap(), 42);
        assert_eq!(samples.get(), 0);
    }

    #[tokio::test]
    async fn stalled_disk_checks_time_out_without_accumulating_workers() {
        static SLOT: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(1);
        let (release, blocked) = std::sync::mpsc::channel();
        let result = read_disk_space(
            move || {
                blocked.recv().unwrap();
                vec![Some(GIB)]
            },
            &SLOT,
            Duration::from_millis(1),
        )
        .await;
        assert!(result.is_empty());
        for _ in 0..100 {
            let skipped = read_disk_space(
                || panic!("A stalled sample must retain the only worker slot"),
                &SLOT,
                Duration::from_millis(1),
            )
            .await;
            assert!(skipped.is_empty());
        }
        release.send(()).unwrap();
        let permit = tokio::time::timeout(Duration::from_secs(2), SLOT.acquire())
            .await
            .unwrap()
            .unwrap();
        drop(permit);
        assert_eq!(
            read_disk_space(|| vec![Some(GIB)], &SLOT, Duration::from_secs(2)).await,
            vec![Some(GIB)]
        );
    }

    #[test]
    fn stalled_disk_check_does_not_hold_an_export_runtime_open() {
        static SLOT: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(1);
        let (release, blocked) = std::sync::mpsc::channel();
        let (finished, completion) = std::sync::mpsc::channel();
        let worker = std::thread::spawn(move || {
            let runtime = tokio::runtime::Builder::new_current_thread()
                .enable_time()
                .build()
                .unwrap();
            let sample = runtime.block_on(read_disk_space(
                move || {
                    blocked.recv().unwrap();
                    Vec::new()
                },
                &SLOT,
                Duration::from_millis(1),
            ));
            assert!(sample.is_empty());
            drop(runtime);
            finished.send(()).unwrap();
        });
        let result = completion.recv_timeout(Duration::from_secs(2));
        release.send(()).unwrap();
        worker.join().unwrap();
        result.unwrap();
    }

    #[tokio::test]
    async fn cancellation_drops_the_sampling_future() {
        let (sample_started, started) = tokio::sync::oneshot::channel();
        let (sample_dropped, dropped) = tokio::sync::oneshot::channel();
        struct SamplingGuard(Option<tokio::sync::oneshot::Sender<()>>);
        impl Drop for SamplingGuard {
            fn drop(&mut self) {
                self.0.take().unwrap().send(()).unwrap();
            }
        }
        let mut started_tx = Some(sample_started);
        let mut dropped_tx = Some(sample_dropped);
        let task = tokio::spawn(async move {
            resources()
                .supervise_with(
                    std::future::pending::<Result<(), String>>(),
                    || panic!("Dropping supervision must not request a resource stop"),
                    move || {
                        let guard = SamplingGuard(dropped_tx.take());
                        started_tx.take().unwrap().send(()).unwrap();
                        async move {
                            let _guard = guard;
                            std::future::pending::<Sample>().await
                        }
                    },
                    Duration::from_millis(1),
                )
                .await
        });
        started.await.unwrap();
        task.abort();
        assert!(task.await.unwrap_err().is_cancelled());
        dropped.await.unwrap();
    }

    #[test]
    fn live_sampling_has_bounded_storage_and_valid_memory_state() {
        let resources = ExportResources::new(vec![DiskBudget {
            path: std::env::temp_dir(),
            description: "your export drive",
            estimated_bytes: 0,
        }]);
        let observation = Sample {
            free_bytes: resources.disk_free_bytes(),
            memory: memory_pressure(),
        };
        assert_eq!(observation.free_bytes.len(), resources.disks.len());
        assert!(observation.free_bytes[0].is_some());
    }
    #[cfg(target_os = "macos")]
    #[tokio::test]
    #[ignore]
    async fn sample_cost_and_footprint_probe() {
        fn usage() -> libc::rusage_info_v2 {
            let mut usage = std::mem::MaybeUninit::<libc::rusage_info_v2>::zeroed();
            let result = unsafe {
                libc::proc_pid_rusage(
                    std::process::id() as i32,
                    libc::RUSAGE_INFO_V2,
                    usage.as_mut_ptr().cast(),
                )
            };
            assert_eq!(result, 0);
            unsafe { usage.assume_init() }
        }
        let resources = ExportResources::new(vec![DiskBudget {
            path: std::env::temp_dir(),
            description: "your export drive",
            estimated_bytes: 0,
        }]);
        for _ in 0..100 {
            drop(resources.read().await);
        }
        let before = usage();
        let start = std::time::Instant::now();
        let mut samples = 0;
        let mut skipped = 0;
        while samples < 50_000 {
            let observation = resources.read().await;
            if observation.free_bytes.len() == resources.disks.len() {
                samples += 1;
                if samples % 10_000 == 0 {
                    println!("samples={samples} footprint={}", usage().ri_phys_footprint);
                }
            } else {
                skipped += 1;
                tokio::task::yield_now().await;
            }
        }
        let elapsed = start.elapsed();
        let after = usage();
        let cpu_ns = after
            .ri_user_time
            .saturating_add(after.ri_system_time)
            .saturating_sub(before.ri_user_time.saturating_add(before.ri_system_time));
        println!(
            "samples={samples} skipped={skipped} wall_ms={} cpu_ms={:.3} footprint_before={} footprint_after={}",
            elapsed.as_millis(),
            cpu_ns as f64 / 1_000_000.0,
            before.ri_phys_footprint,
            after.ri_phys_footprint
        );
    }
}
