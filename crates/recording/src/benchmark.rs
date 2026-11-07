use std::{
    sync::{
        Arc, RwLock,
        atomic::{AtomicU64, Ordering},
    },
    time::{Duration, Instant},
};

// Bound retained latency samples so long recording sessions do not grow Vec<u64> buffers without limit.
const MAX_TIMING_SAMPLES: usize = 4_096;

fn push_bounded_sample(samples: &RwLock<Vec<u64>>, value_ns: u64) {
    let mut guard = samples.write().unwrap();
    if guard.len() >= MAX_TIMING_SAMPLES {
        let drain_count = MAX_TIMING_SAMPLES / 4;
        guard.drain(..drain_count);
    }
    guard.push(value_ns);
}

#[derive(Debug, Clone)]
pub struct FrameTiming {
    pub receive_time: Instant,
    pub conversion_start: Option<Instant>,
    pub conversion_end: Option<Instant>,
    pub encode_start: Option<Instant>,
    pub encode_end: Option<Instant>,
    pub sequence: u64,
}

impl FrameTiming {
    pub fn new(sequence: u64) -> Self {
        Self {
            receive_time: Instant::now(),
            conversion_start: None,
            conversion_end: None,
            encode_start: None,
            encode_end: None,
            sequence,
        }
    }

    pub fn conversion_duration(&self) -> Option<Duration> {
        match (self.conversion_start, self.conversion_end) {
            (Some(start), Some(end)) => Some(end.duration_since(start)),
            _ => None,
        }
    }

    pub fn encode_duration(&self) -> Option<Duration> {
        match (self.encode_start, self.encode_end) {
            (Some(start), Some(end)) => Some(end.duration_since(start)),
            _ => None,
        }
    }

    pub fn total_pipeline_latency(&self) -> Option<Duration> {
        self.encode_end
            .map(|end| end.duration_since(self.receive_time))
    }
}

#[derive(Default)]
pub struct PipelineMetrics {
    pub frames_received: AtomicU64,
    pub frames_converted: AtomicU64,
    pub frames_encoded: AtomicU64,
    pub frames_dropped_input: AtomicU64,
    pub frames_dropped_output: AtomicU64,
    pub frames_dropped_conversion: AtomicU64,
    conversion_times_ns: RwLock<Vec<u64>>,
    encode_times_ns: RwLock<Vec<u64>>,
    pipeline_latencies_ns: RwLock<Vec<u64>>,
    pub start_time: RwLock<Option<Instant>>,
    pub end_time: RwLock<Option<Instant>>,
}

impl PipelineMetrics {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    pub fn start(&self) {
        *self.start_time.write().unwrap() = Some(Instant::now());
    }

    pub fn stop(&self) {
        *self.end_time.write().unwrap() = Some(Instant::now());
    }

    pub fn record_frame_received(&self) {
        self.frames_received.fetch_add(1, Ordering::Relaxed);
    }

    pub fn record_frame_converted(&self, duration: Duration) {
        self.frames_converted.fetch_add(1, Ordering::Relaxed);
        push_bounded_sample(&self.conversion_times_ns, duration.as_nanos() as u64);
    }

    pub fn record_frame_encoded(&self, encode_duration: Duration, pipeline_latency: Duration) {
        self.frames_encoded.fetch_add(1, Ordering::Relaxed);
        push_bounded_sample(&self.encode_times_ns, encode_duration.as_nanos() as u64);
        push_bounded_sample(
            &self.pipeline_latencies_ns,
            pipeline_latency.as_nanos() as u64,
        );
    }

    pub fn record_dropped_input(&self) {
        self.frames_dropped_input.fetch_add(1, Ordering::Relaxed);
    }

    pub fn record_dropped_output(&self) {
        self.frames_dropped_output.fetch_add(1, Ordering::Relaxed);
    }

    pub fn record_dropped_conversion(&self) {
        self.frames_dropped_conversion
            .fetch_add(1, Ordering::Relaxed);
    }

    pub fn snapshot(&self) -> MetricsSnapshot {
        let conversion_times = self.conversion_times_ns.read().unwrap().clone();
        let encode_times = self.encode_times_ns.read().unwrap().clone();
        let pipeline_latencies = self.pipeline_latencies_ns.read().unwrap().clone();

        let start = *self.start_time.read().unwrap();
        let end = *self.end_time.read().unwrap();
        let duration = match (start, end) {
            (Some(s), Some(e)) => Some(e.duration_since(s)),
            (Some(s), None) => Some(Instant::now().duration_since(s)),
            _ => None,
        };

        MetricsSnapshot {
            frames_received: self.frames_received.load(Ordering::Relaxed),
            frames_converted: self.frames_converted.load(Ordering::Relaxed),
            frames_encoded: self.frames_encoded.load(Ordering::Relaxed),
            frames_dropped_input: self.frames_dropped_input.load(Ordering::Relaxed),
            frames_dropped_output: self.frames_dropped_output.load(Ordering::Relaxed),
            frames_dropped_conversion: self.frames_dropped_conversion.load(Ordering::Relaxed),
            conversion_times_ns: conversion_times,
            encode_times_ns: encode_times,
            pipeline_latencies_ns: pipeline_latencies,
            duration,
        }
    }
}

#[derive(Debug, Clone)]
pub struct MetricsSnapshot {
    pub frames_received: u64,
    pub frames_converted: u64,
    pub frames_encoded: u64,
    pub frames_dropped_input: u64,
    pub frames_dropped_output: u64,
    pub frames_dropped_conversion: u64,
    pub conversion_times_ns: Vec<u64>,
    pub encode_times_ns: Vec<u64>,
    pub pipeline_latencies_ns: Vec<u64>,
    pub duration: Option<Duration>,
}

fn print_timing_section(title: &str, samples_ns: &[u64]) {
    println!("\n--- {title} ---");
    if let Some(avg) = average_duration(samples_ns) {
        println!("  Average:  {avg:?}");
    }
    for (label, pct) in [("P50:     ", 50.0), ("P95:     ", 95.0), ("P99:     ", 99.0)] {
        if let Some(val) = percentile_duration(samples_ns, pct) {
            println!("  {label} {val:?}");
        }
    }
    if let Some(max) = max_duration(samples_ns) {
        println!("  Max:      {max:?}");
    }
}

fn average_duration(samples_ns: &[u64]) -> Option<Duration> {
    if samples_ns.is_empty() {
        return None;
    }
    let sum: u64 = samples_ns.iter().sum();
    Some(Duration::from_nanos(sum / samples_ns.len() as u64))
}

fn max_duration(samples_ns: &[u64]) -> Option<Duration> {
    samples_ns.iter().max().map(|&ns| Duration::from_nanos(ns))
}

fn timing_json_object(samples_ns: &[u64]) -> serde_json::Value {
    let to_ms = |d: Option<Duration>| d.map(|v| v.as_secs_f64() * 1000.0);
    serde_json::json!({
        "avg": to_ms(average_duration(samples_ns)),
        "p50": to_ms(percentile_duration(samples_ns, 50.0)),
        "p95": to_ms(percentile_duration(samples_ns, 95.0)),
        "p99": to_ms(percentile_duration(samples_ns, 99.0)),
        "max": to_ms(max_duration(samples_ns)),
    })
}

impl MetricsSnapshot {
    pub fn total_frames_dropped(&self) -> u64 {
        self.frames_dropped_input + self.frames_dropped_output + self.frames_dropped_conversion
    }

    pub fn drop_rate(&self) -> f64 {
        if self.frames_received == 0 {
            0.0
        } else {
            self.total_frames_dropped() as f64 / self.frames_received as f64 * 100.0
        }
    }

    pub fn effective_fps(&self) -> f64 {
        match self.duration {
            Some(d) if d.as_secs_f64() > 0.0 => self.frames_encoded as f64 / d.as_secs_f64(),
            _ => 0.0,
        }
    }

    pub fn avg_conversion_time(&self) -> Option<Duration> {
        average_duration(&self.conversion_times_ns)
    }

    pub fn avg_encode_time(&self) -> Option<Duration> {
        average_duration(&self.encode_times_ns)
    }

    pub fn avg_pipeline_latency(&self) -> Option<Duration> {
        average_duration(&self.pipeline_latencies_ns)
    }

    pub fn percentile_encode_time(&self, p: f64) -> Option<Duration> {
        percentile_duration(&self.encode_times_ns, p)
    }

    pub fn percentile_conversion_time(&self, p: f64) -> Option<Duration> {
        percentile_duration(&self.conversion_times_ns, p)
    }

    pub fn percentile_pipeline_latency(&self, p: f64) -> Option<Duration> {
        percentile_duration(&self.pipeline_latencies_ns, p)
    }

    pub fn max_encode_time(&self) -> Option<Duration> {
        max_duration(&self.encode_times_ns)
    }

    pub fn max_conversion_time(&self) -> Option<Duration> {
        max_duration(&self.conversion_times_ns)
    }

    pub fn max_pipeline_latency(&self) -> Option<Duration> {
        max_duration(&self.pipeline_latencies_ns)
    }

    fn print_assessment(&self) {
        println!("\n--- Performance Assessment ---");
        let can_sustain_30fps = self.effective_fps() >= 29.5;
        let low_drop_rate = self.drop_rate() < 1.0;
        let acceptable_latency = self
            .percentile_pipeline_latency(95.0)
            .is_none_or(|l| l < Duration::from_millis(100));

        let verdict = |ok: bool| if ok { "YES ✓" } else { "NO ✗" };
        println!("  Can sustain 30 FPS:   {}", verdict(can_sustain_30fps));
        println!("  Low drop rate (<1%):  {}", verdict(low_drop_rate));
        println!("  Acceptable latency:   {}", verdict(acceptable_latency));
    }

    pub fn print_report(&self) {
        println!("\n=== Pipeline Performance Report ===\n");

        if let Some(duration) = self.duration {
            println!("Recording Duration: {:.2}s", duration.as_secs_f64());
        }

        println!("\n--- Frame Statistics ---");
        println!("  Frames Received:    {}", self.frames_received);
        println!("  Frames Converted:   {}", self.frames_converted);
        println!("  Frames Encoded:     {}", self.frames_encoded);
        println!("  Effective FPS:      {:.1}", self.effective_fps());

        println!("\n--- Drop Statistics ---");
        println!("  Dropped (Input):      {}", self.frames_dropped_input);
        println!("  Dropped (Conversion): {}", self.frames_dropped_conversion);
        println!("  Dropped (Output):     {}", self.frames_dropped_output);
        println!("  Total Dropped:        {}", self.total_frames_dropped());
        println!("  Drop Rate:            {:.2}%", self.drop_rate());

        print_timing_section("Conversion Timing", &self.conversion_times_ns);
        print_timing_section("Encoding Timing", &self.encode_times_ns);
        print_timing_section("Total Pipeline Latency", &self.pipeline_latencies_ns);
        self.print_assessment();

        println!("\n=== End Report ===\n");
    }

    pub fn to_json(&self) -> String {
        serde_json::json!({
            "duration_secs": self.duration.map(|d| d.as_secs_f64()),
            "frames": {
                "received": self.frames_received,
                "converted": self.frames_converted,
                "encoded": self.frames_encoded,
                "dropped_input": self.frames_dropped_input,
                "dropped_conversion": self.frames_dropped_conversion,
                "dropped_output": self.frames_dropped_output,
                "total_dropped": self.total_frames_dropped(),
                "drop_rate_percent": self.drop_rate(),
                "effective_fps": self.effective_fps(),
            },
            "conversion_ms": timing_json_object(&self.conversion_times_ns),
            "encoding_ms": timing_json_object(&self.encode_times_ns),
            "pipeline_latency_ms": timing_json_object(&self.pipeline_latencies_ns),
        })
        .to_string()
    }
}

fn percentile_duration(times_ns: &[u64], p: f64) -> Option<Duration> {
    if times_ns.is_empty() {
        return None;
    }
    let mut sorted: Vec<u64> = times_ns.to_vec();
    sorted.sort_unstable();
    let idx = ((p / 100.0) * (sorted.len() - 1) as f64).round() as usize;
    Some(Duration::from_nanos(sorted[idx]))
}

#[derive(Debug, Clone)]
pub struct BenchmarkConfig {
    pub duration_secs: u64,
    pub warmup_secs: u64,
    pub target_fps: u32,
    pub camera_resolution: Option<(u32, u32)>,
    pub output_json: bool,
}

impl Default for BenchmarkConfig {
    fn default() -> Self {
        Self {
            duration_secs: 10,
            warmup_secs: 2,
            target_fps: 30,
            camera_resolution: None,
            output_json: false,
        }
    }
}

pub struct EncoderInfo {
    pub name: String,
    pub is_hardware: bool,
    pub gpu_type: Option<String>,
}

impl EncoderInfo {
    pub fn detect() -> Self {
        #[cfg(target_os = "macos")]
        {
            Self {
                name: "h264_videotoolbox".to_string(),
                is_hardware: true,
                gpu_type: Some(detect_macos_gpu()),
            }
        }

        #[cfg(target_os = "windows")]
        {
            let (name, gpu) = detect_windows_encoder();
            Self {
                name,
                is_hardware: true,
                gpu_type: gpu,
            }
        }

        #[cfg(not(any(target_os = "macos", target_os = "windows")))]
        {
            Self {
                name: "libx264".to_string(),
                is_hardware: false,
                gpu_type: None,
            }
        }
    }

    pub fn print_info(&self) {
        println!("Encoder: {} (Hardware: {})", self.name, self.is_hardware);
        if let Some(gpu) = &self.gpu_type {
            println!("GPU: {gpu}");
        }
    }
}

#[cfg(target_os = "macos")]
fn detect_macos_gpu() -> String {
    "Apple Silicon / Intel UHD".to_string()
}

#[cfg(target_os = "windows")]
fn detect_windows_encoder() -> (String, Option<String>) {
    let encoders = ["h264_nvenc", "h264_qsv", "h264_amf", "h264_mf"];
    for name in encoders {
        if ffmpeg::codec::encoder::find_by_name(name).is_some() {
            let gpu = match name {
                "h264_nvenc" => Some("NVIDIA".to_string()),
                "h264_qsv" => Some("Intel QuickSync".to_string()),
                "h264_amf" => Some("AMD".to_string()),
                "h264_mf" => Some("Windows Media Foundation".to_string()),
                _ => None,
            };
            return (name.to_string(), gpu);
        }
    }
    ("libx264".to_string(), None)
}
