use std::time::{Duration, Instant};

#[cfg(feature = "memory-profiling")]
#[global_allocator]
static ALLOC: dhat::Alloc = dhat::Alloc;

pub struct MemoryProfiler {
    #[cfg(feature = "memory-profiling")]
    _profiler: dhat::Profiler,
    tracker: MemoryTracker,
}

impl Default for MemoryProfiler {
    fn default() -> Self {
        Self::new()
    }
}

impl MemoryProfiler {
    pub fn new() -> Self {
        Self {
            #[cfg(feature = "memory-profiling")]
            _profiler: dhat::Profiler::builder().build(),
            tracker: MemoryTracker::new(),
        }
    }

    pub fn sample(&mut self) {
        self.tracker.sample();
    }

    pub fn print_report(&self) {
        self.tracker.print_report();

        #[cfg(feature = "memory-profiling")]
        {
            let stats = dhat::HeapStats::get();
            println!("\n=== dhat Heap Statistics ===\n");
            println!("Total allocations:     {}", stats.total_blocks);
            println!("Total bytes allocated:  {}", stats.total_bytes);
            println!("Peak live allocations:  {}", stats.max_blocks);
            println!("Peak live bytes:        {}", stats.max_bytes);
            println!("Current live allocs:    {}", stats.curr_blocks);
            println!("Current live bytes:     {}", stats.curr_bytes);

            if stats.curr_blocks > 0 {
                println!(
                    "\n*** {} allocations ({} bytes) still alive at report time ***",
                    stats.curr_blocks, stats.curr_bytes
                );
            }
        }
    }

    pub fn check_for_leaks(&self) -> LeakCheckResult {
        let growth = self.tracker.analyze_growth();

        #[cfg(feature = "memory-profiling")]
        {
            let stats = dhat::HeapStats::get();
            return LeakCheckResult {
                growth_rate_mb_per_sec: growth.rate_mb_per_sec,
                total_growth_mb: growth.total_mb,
                peak_mb: growth.peak_mb,
                dhat_current_blocks: Some(stats.curr_blocks as u64),
                dhat_current_bytes: Some(stats.curr_bytes as u64),
                dhat_peak_bytes: Some(stats.max_bytes as u64),
                verdict: classify_leak(growth.rate_mb_per_sec),
            };
        }

        #[cfg(not(feature = "memory-profiling"))]
        LeakCheckResult {
            growth_rate_mb_per_sec: growth.rate_mb_per_sec,
            total_growth_mb: growth.total_mb,
            peak_mb: growth.peak_mb,
            dhat_current_blocks: None,
            dhat_current_bytes: None,
            dhat_peak_bytes: None,
            verdict: classify_leak(growth.rate_mb_per_sec),
        }
    }
}

#[derive(Debug, Clone)]
pub struct LeakCheckResult {
    pub growth_rate_mb_per_sec: f64,
    pub total_growth_mb: f64,
    pub peak_mb: f64,
    pub dhat_current_blocks: Option<u64>,
    pub dhat_current_bytes: Option<u64>,
    pub dhat_peak_bytes: Option<u64>,
    pub verdict: LeakVerdict,
}

#[derive(Debug, Clone, PartialEq)]
pub enum LeakVerdict {
    Clean,
    PossibleLeak,
    Leak,
    SevereLeak,
}

impl std::fmt::Display for LeakVerdict {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Clean => write!(f, "CLEAN - No leak detected"),
            Self::PossibleLeak => write!(f, "POSSIBLE LEAK - Growth > 1 MB/s"),
            Self::Leak => write!(f, "LEAK DETECTED - Growth > 5 MB/s"),
            Self::SevereLeak => write!(f, "SEVERE LEAK - Growth > 20 MB/s"),
        }
    }
}

fn classify_leak(rate_mb_per_sec: f64) -> LeakVerdict {
    if rate_mb_per_sec > 20.0 {
        LeakVerdict::SevereLeak
    } else if rate_mb_per_sec > 5.0 {
        LeakVerdict::Leak
    } else if rate_mb_per_sec > 1.0 {
        LeakVerdict::PossibleLeak
    } else {
        LeakVerdict::Clean
    }
}

#[derive(Debug, Clone, Copy)]
pub struct MemoryStats {
    pub resident_mb: f64,
    pub footprint_mb: Option<f64>,
}

impl MemoryStats {
    pub fn primary_metric(&self) -> f64 {
        self.footprint_mb.unwrap_or(self.resident_mb)
    }
}

#[derive(Debug, Clone, Copy)]
pub struct ProcessStats {
    pub resident_mb: f64,
    pub cpu_user_secs: f64,
    pub cpu_system_secs: f64,
    pub thread_count: u32,
    pub wall_time: Instant,
}

impl ProcessStats {
    pub fn cpu_total_secs(&self) -> f64 {
        self.cpu_user_secs + self.cpu_system_secs
    }

    pub fn cpu_percent_since(&self, prev: &ProcessStats) -> f64 {
        let cpu_delta = self.cpu_total_secs() - prev.cpu_total_secs();
        let wall_delta = self.wall_time.duration_since(prev.wall_time).as_secs_f64();
        if wall_delta > 0.0 {
            (cpu_delta / wall_delta) * 100.0
        } else {
            0.0
        }
    }
}

#[cfg(target_os = "macos")]
fn time_value_to_secs(tv: &libc::time_value_t) -> f64 {
    tv.seconds as f64 + tv.microseconds as f64 / 1_000_000.0
}

#[cfg(target_os = "macos")]
fn get_task_basic_info() -> Option<libc::mach_task_basic_info> {
    let mut info = libc::mach_task_basic_info {
        virtual_size: 0,
        resident_size: 0,
        resident_size_max: 0,
        user_time: libc::time_value_t {
            seconds: 0,
            microseconds: 0,
        },
        system_time: libc::time_value_t {
            seconds: 0,
            microseconds: 0,
        },
        policy: 0,
        suspend_count: 0,
    };
    let mut count = (std::mem::size_of::<libc::mach_task_basic_info>()
        / std::mem::size_of::<libc::natural_t>())
        as libc::mach_msg_type_number_t;

    let ret = unsafe {
        libc::task_info(
            libc::mach_task_self(),
            libc::MACH_TASK_BASIC_INFO,
            &mut info as *mut _ as libc::task_info_t,
            &mut count,
        )
    };

    if ret != libc::KERN_SUCCESS {
        return None;
    }

    Some(info)
}

#[cfg(target_os = "macos")]
fn get_thread_count() -> u32 {
    unsafe {
        let mut thread_list: libc::thread_act_array_t = std::ptr::null_mut();
        let mut thread_count: libc::mach_msg_type_number_t = 0;

        let ret = libc::task_threads(libc::mach_task_self(), &mut thread_list, &mut thread_count);

        if ret != libc::KERN_SUCCESS {
            return 0;
        }

        if !thread_list.is_null() && thread_count > 0 {
            libc::vm_deallocate(
                libc::mach_task_self(),
                thread_list as libc::vm_address_t,
                (thread_count as usize) * std::mem::size_of::<libc::thread_act_t>(),
            );
        }

        thread_count
    }
}

#[cfg(target_os = "macos")]
pub fn get_memory_usage() -> Option<MemoryStats> {
    let info = get_task_basic_info()?;
    Some(MemoryStats {
        resident_mb: info.resident_size as f64 / 1024.0 / 1024.0,
        footprint_mb: None,
    })
}

#[cfg(target_os = "macos")]
pub fn get_process_stats() -> Option<ProcessStats> {
    let info = get_task_basic_info()?;
    Some(ProcessStats {
        resident_mb: info.resident_size as f64 / 1024.0 / 1024.0,
        cpu_user_secs: time_value_to_secs(&info.user_time),
        cpu_system_secs: time_value_to_secs(&info.system_time),
        thread_count: get_thread_count(),
        wall_time: Instant::now(),
    })
}

#[cfg(not(target_os = "macos"))]
pub fn get_memory_usage() -> Option<MemoryStats> {
    None
}

#[cfg(not(target_os = "macos"))]
pub fn get_process_stats() -> Option<ProcessStats> {
    None
}

pub struct CpuTracker {
    samples: Vec<ProcessStats>,
    num_cores: usize,
}

impl Default for CpuTracker {
    fn default() -> Self {
        Self::new()
    }
}

impl CpuTracker {
    pub fn new() -> Self {
        Self {
            samples: Vec::new(),
            num_cores: std::thread::available_parallelism()
                .map(|p| p.get())
                .unwrap_or(1),
        }
    }

    pub fn sample(&mut self) -> Option<&ProcessStats> {
        let stats = get_process_stats()?;
        self.samples.push(stats);
        self.samples.last()
    }

    pub fn latest_cpu_percent(&self) -> Option<f64> {
        if self.samples.len() < 2 {
            return None;
        }
        let prev = &self.samples[self.samples.len() - 2];
        let curr = &self.samples[self.samples.len() - 1];
        Some(curr.cpu_percent_since(prev))
    }

    pub fn print_report(&self) {
        if self.samples.len() < 2 {
            println!("Not enough CPU samples to analyze");
            return;
        }

        println!("\n=== CPU Usage Report ===\n");
        println!("CPU cores: {}", self.num_cores);

        let first = &self.samples[0];
        let last = &self.samples[self.samples.len() - 1];
        let wall_secs = last.wall_time.duration_since(first.wall_time).as_secs_f64();
        let total_cpu_secs = last.cpu_total_secs() - first.cpu_total_secs();
        let user_secs = last.cpu_user_secs - first.cpu_user_secs;
        let system_secs = last.cpu_system_secs - first.cpu_system_secs;

        let avg_cpu_pct = if wall_secs > 0.0 {
            (total_cpu_secs / wall_secs) * 100.0
        } else {
            0.0
        };
        let avg_per_core_pct = avg_cpu_pct / self.num_cores as f64;

        println!("Duration: {wall_secs:.1}s");
        println!("CPU time (user):   {user_secs:.2}s");
        println!("CPU time (system): {system_secs:.2}s");
        println!("CPU time (total):  {total_cpu_secs:.2}s");
        println!("Average CPU: {avg_cpu_pct:.1}% ({avg_per_core_pct:.1}% per core)");

        let mut cpu_percents: Vec<f64> = Vec::new();
        for i in 1..self.samples.len() {
            cpu_percents.push(self.samples[i].cpu_percent_since(&self.samples[i - 1]));
        }

        if !cpu_percents.is_empty() {
            let max_cpu = cpu_percents.iter().cloned().fold(0.0_f64, f64::max);
            let min_cpu = cpu_percents.iter().cloned().fold(f64::MAX, f64::min);

            let mut sorted = cpu_percents.clone();
            sorted.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
            let p50 = sorted[sorted.len() / 2];
            let p95_idx = ((sorted.len() as f64) * 0.95) as usize;
            let p95 = sorted[p95_idx.min(sorted.len() - 1)];

            println!("\nCPU % timeline (per sample interval):");
            println!("  Min:  {min_cpu:.1}%");
            println!("  P50:  {p50:.1}%");
            println!("  P95:  {p95:.1}%");
            println!("  Max:  {max_cpu:.1}%");
        }

        let thread_counts: Vec<u32> = self.samples.iter().map(|s| s.thread_count).collect();
        let max_threads = thread_counts.iter().copied().max().unwrap_or(0);
        let min_threads = thread_counts.iter().copied().min().unwrap_or(0);
        let last_threads = thread_counts.last().copied().unwrap_or(0);

        println!("\nThreads:");
        println!("  Current:  {last_threads}");
        println!("  Min:      {min_threads}");
        println!("  Max:      {max_threads}");

        if max_threads > min_threads + 10 {
            println!("  *** Thread count variance is high — possible thread leak ***");
        }

        println!("\n=== CPU Assessment ===");
        let max_cpu_per_core = if !cpu_percents.is_empty() {
            cpu_percents.iter().cloned().fold(0.0_f64, f64::max) / self.num_cores as f64
        } else {
            0.0
        };

        if avg_per_core_pct < 10.0 {
            println!("  CPU usage: LOW ({avg_per_core_pct:.1}% per core avg)");
        } else if avg_per_core_pct < 30.0 {
            println!("  CPU usage: MODERATE ({avg_per_core_pct:.1}% per core avg)");
        } else {
            println!(
                "  CPU usage: HIGH ({avg_per_core_pct:.1}% per core avg) — investigate hot paths"
            );
        }

        if max_cpu_per_core > 80.0 {
            println!("  CPU spikes: Peak {max_cpu_per_core:.0}% per core — may cause frame drops");
        }
    }
}

struct GrowthAnalysis {
    rate_mb_per_sec: f64,
    total_mb: f64,
    peak_mb: f64,
}

pub struct MemoryTracker {
    samples: Vec<(Duration, MemoryStats)>,
    start: Instant,
}

impl Default for MemoryTracker {
    fn default() -> Self {
        Self::new()
    }
}

impl MemoryTracker {
    pub fn new() -> Self {
        Self {
            samples: Vec::new(),
            start: Instant::now(),
        }
    }

    pub fn sample(&mut self) {
        if let Some(stats) = get_memory_usage() {
            self.samples.push((self.start.elapsed(), stats));
        }
    }

    fn analyze_growth(&self) -> GrowthAnalysis {
        if self.samples.len() < 2 {
            return GrowthAnalysis {
                rate_mb_per_sec: 0.0,
                total_mb: 0.0,
                peak_mb: 0.0,
            };
        }

        let first = &self.samples[0];
        let last = &self.samples[self.samples.len() - 1];
        let duration_secs = last.0.as_secs_f64() - first.0.as_secs_f64();
        let total_mb = last.1.primary_metric() - first.1.primary_metric();
        let peak_mb = self
            .samples
            .iter()
            .map(|(_, s)| s.primary_metric())
            .fold(0.0_f64, |a, b| a.max(b));

        let rate = if duration_secs > 0.0 {
            total_mb / duration_secs
        } else {
            0.0
        };

        GrowthAnalysis {
            rate_mb_per_sec: rate,
            total_mb,
            peak_mb,
        }
    }

    pub fn print_report(&self) {
        println!("\n=== Memory Usage Report ===\n");

        if self.samples.len() < 2 {
            println!("Not enough samples to analyze");
            return;
        }

        let first = &self.samples[0];
        let last = &self.samples[self.samples.len() - 1];
        let duration_secs = last.0.as_secs_f64() - first.0.as_secs_f64();
        let growth = last.1.primary_metric() - first.1.primary_metric();
        let growth_rate = if duration_secs > 0.0 {
            growth / duration_secs
        } else {
            0.0
        };

        println!("Memory Timeline:");
        println!(
            "{:>8} {:>14} {:>10} {:>12}",
            "Time(s)", "Footprint(MB)", "Delta", "RSS(MB)"
        );
        println!("{:-<50}", "");

        let mut prev = first.1.primary_metric();
        for (time, stats) in &self.samples {
            let current = stats.primary_metric();
            let delta = current - prev;
            let delta_str = if delta.abs() > 0.5 {
                format!("{delta:+.1}")
            } else {
                "~0".to_string()
            };
            println!(
                "{:>8.1} {:>14.1} {:>10} {:>12.1}",
                time.as_secs_f64(),
                current,
                delta_str,
                stats.resident_mb
            );
            prev = current;
        }

        println!("\n=== Summary ===");
        println!("Duration: {duration_secs:.1}s");
        println!("Start: {:.1} MB", first.1.primary_metric());
        println!("End: {:.1} MB", last.1.primary_metric());
        println!("Growth: {growth:.1} MB");
        println!(
            "Rate: {:.2} MB/s ({:.1} MB/min)",
            growth_rate,
            growth_rate * 60.0
        );
        println!(
            "Peak: {:.1} MB",
            self.samples
                .iter()
                .map(|(_, s)| s.primary_metric())
                .fold(0.0_f64, |a, b| a.max(b))
        );
        println!("\nVerdict: {}", classify_leak(growth_rate));
    }
}

pub struct SubsystemTest {
    pub name: String,
    pub duration_secs: u64,
    pub result: Option<LeakCheckResult>,
}

impl SubsystemTest {
    pub fn new(name: &str, duration_secs: u64) -> Self {
        Self {
            name: name.to_string(),
            duration_secs,
            result: None,
        }
    }
}

pub struct CycleTestConfig {
    pub cycles: u32,
    pub active_duration: Duration,
    pub idle_duration: Duration,
}

impl Default for CycleTestConfig {
    fn default() -> Self {
        Self {
            cycles: 5,
            active_duration: Duration::from_secs(10),
            idle_duration: Duration::from_secs(2),
        }
    }
}

pub struct CycleTestResult {
    pub cycle_memories: Vec<(f64, f64)>,
    pub total_growth_mb: f64,
    pub per_cycle_growth_mb: f64,
    pub verdict: LeakVerdict,
}

impl CycleTestResult {
    pub fn print_report(&self, name: &str) {
        println!("\n=== {name} Cycle Test Results ===\n");
        println!("{:>6} {:>16} {:>16}", "Cycle", "Before(MB)", "After(MB)");
        println!("{:-<42}", "");

        for (i, (before, after)) in self.cycle_memories.iter().enumerate() {
            let delta = after - before;
            println!(
                "{:>6} {:>16.1} {:>16.1}  ({:+.1})",
                i + 1,
                before,
                after,
                delta
            );
        }

        println!(
            "\nTotal growth across {} cycles: {:.1} MB",
            self.cycle_memories.len(),
            self.total_growth_mb
        );
        println!(
            "Average growth per cycle: {:.2} MB",
            self.per_cycle_growth_mb
        );
        println!("Verdict: {}", self.verdict);
    }

    pub fn from_memories(cycle_memories: Vec<(f64, f64)>) -> Self {
        let total_growth = if cycle_memories.len() >= 2 {
            cycle_memories.last().map(|l| l.1).unwrap_or(0.0)
                - cycle_memories.first().map(|f| f.0).unwrap_or(0.0)
        } else {
            0.0
        };

        let per_cycle = if !cycle_memories.is_empty() {
            total_growth / cycle_memories.len() as f64
        } else {
            0.0
        };

        let verdict = if per_cycle > 10.0 {
            LeakVerdict::SevereLeak
        } else if per_cycle > 2.0 {
            LeakVerdict::Leak
        } else if per_cycle > 0.5 {
            LeakVerdict::PossibleLeak
        } else {
            LeakVerdict::Clean
        };

        Self {
            cycle_memories,
            total_growth_mb: total_growth,
            per_cycle_growth_mb: per_cycle,
            verdict,
        }
    }
}

pub fn print_channel_stats(name: &str, len: usize, capacity: Option<usize>) {
    match capacity {
        Some(cap) => {
            let fill_pct = if cap > 0 {
                len as f64 / cap as f64 * 100.0
            } else {
                0.0
            };
            println!("  {name}: {len}/{cap} ({fill_pct:.0}% full)");
        }
        None => {
            println!("  {name}: {len} queued (unbounded)");
        }
    }
}

pub fn print_arc_stats(name: &str, strong_count: usize, weak_count: usize) {
    if strong_count > 1 || weak_count > 0 {
        println!(
            "  {name}: strong={strong_count}, weak={weak_count}{}",
            if strong_count > 10 {
                " *** HIGH REFCOUNT"
            } else {
                ""
            }
        );
    }
}
