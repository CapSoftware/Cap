use std::collections::HashMap;
use std::time::{Duration, Instant};

/// Performance metrics for GPU conversion operations
#[derive(Debug, Clone)]
pub struct ConversionMetrics {
    /// Total time spent on conversion (including GPU work)
    pub total_duration: Duration,
    /// Time spent on CPU preparation (buffer creation, etc.)
    pub cpu_duration: Duration,
    /// Time spent on GPU computation
    pub gpu_duration: Duration,
    /// Time spent on memory transfers
    pub memory_transfer_duration: Duration,
    /// Input data size in bytes
    pub input_size: usize,
    /// Output data size in bytes
    pub output_size: usize,
    /// Source format of the conversion
    pub source_format: String,
    /// Target format of the conversion
    pub target_format: String,
    /// Input dimensions
    pub input_dimensions: (u32, u32),
    /// Output dimensions
    pub output_dimensions: (u32, u32),
}

impl ConversionMetrics {
    /// Calculate throughput in megabytes per second
    pub fn throughput_mbps(&self) -> f64 {
        if self.total_duration.is_zero() {
            return 0.0;
        }
        let mb_processed = self.input_size as f64 / (1024.0 * 1024.0);
        mb_processed / self.total_duration.as_secs_f64()
    }

    /// Calculate pixels per second processed
    pub fn pixels_per_second(&self) -> f64 {
        if self.total_duration.is_zero() {
            return 0.0;
        }
        let pixels = (self.input_dimensions.0 * self.input_dimensions.1) as f64;
        pixels / self.total_duration.as_secs_f64()
    }

    /// Get efficiency ratio (GPU time / total time)
    pub fn gpu_efficiency(&self) -> f64 {
        if self.total_duration.is_zero() {
            return 0.0;
        }
        self.gpu_duration.as_secs_f64() / self.total_duration.as_secs_f64()
    }
}

/// Performance tracker for monitoring conversion operations
pub struct PerformanceTracker {
    metrics_history: Vec<ConversionMetrics>,
    operation_stats: HashMap<String, OperationStats>,
    max_history_size: usize,
}

#[derive(Debug, Clone)]
pub struct OperationStats {
    pub count: usize,
    pub total_duration: Duration,
    pub min_duration: Duration,
    pub max_duration: Duration,
    pub avg_throughput_mbps: f64,
    pub avg_pixels_per_second: f64,
}

impl OperationStats {
    fn new() -> Self {
        Self {
            count: 0,
            total_duration: Duration::ZERO,
            min_duration: Duration::MAX,
            max_duration: Duration::ZERO,
            avg_throughput_mbps: 0.0,
            avg_pixels_per_second: 0.0,
        }
    }

    fn update(&mut self, metrics: &ConversionMetrics) {
        self.count += 1;
        self.total_duration += metrics.total_duration;
        self.min_duration = self.min_duration.min(metrics.total_duration);
        self.max_duration = self.max_duration.max(metrics.total_duration);

        // Update running averages
        let weight = 1.0 / self.count as f64;
        self.avg_throughput_mbps =
            (self.avg_throughput_mbps * (1.0 - weight)) + (metrics.throughput_mbps() * weight);
        self.avg_pixels_per_second =
            (self.avg_pixels_per_second * (1.0 - weight)) + (metrics.pixels_per_second() * weight);
    }

    pub fn average_duration(&self) -> Duration {
        if self.count == 0 {
            Duration::ZERO
        } else {
            self.total_duration / self.count as u32
        }
    }
}

impl PerformanceTracker {
    pub fn new() -> Self {
        Self {
            metrics_history: Vec::new(),
            operation_stats: HashMap::new(),
            max_history_size: 1000,
        }
    }

    pub fn with_max_history(mut self, max_size: usize) -> Self {
        self.max_history_size = max_size;
        self
    }

    /// Record a new conversion operation
    pub fn record_conversion(&mut self, metrics: ConversionMetrics) {
        let operation_key = format!("{}→{}", metrics.source_format, metrics.target_format);

        // Update operation statistics
        let stats = self
            .operation_stats
            .entry(operation_key)
            .or_insert_with(OperationStats::new);
        stats.update(&metrics);

        // Add to history
        self.metrics_history.push(metrics);

        // Maintain history size limit
        if self.metrics_history.len() > self.max_history_size {
            self.metrics_history.remove(0);
        }
    }

    /// Get statistics for a specific operation type
    pub fn get_operation_stats(
        &self,
        source_format: &str,
        target_format: &str,
    ) -> Option<&OperationStats> {
        let key = format!("{}→{}", source_format, target_format);
        self.operation_stats.get(&key)
    }

    /// Get overall performance summary
    pub fn get_summary(&self) -> PerformanceSummary {
        if self.metrics_history.is_empty() {
            return PerformanceSummary::default();
        }

        let total_operations = self.metrics_history.len();
        let total_duration: Duration = self.metrics_history.iter().map(|m| m.total_duration).sum();

        let avg_duration = total_duration / total_operations as u32;

        let avg_throughput = self
            .metrics_history
            .iter()
            .map(|m| m.throughput_mbps())
            .sum::<f64>()
            / total_operations as f64;

        let avg_gpu_efficiency = self
            .metrics_history
            .iter()
            .map(|m| m.gpu_efficiency())
            .sum::<f64>()
            / total_operations as f64;

        PerformanceSummary {
            total_operations,
            avg_duration,
            avg_throughput_mbps: avg_throughput,
            avg_gpu_efficiency,
            operation_types: self.operation_stats.len(),
        }
    }

    /// Get recent performance (last N operations)
    pub fn get_recent_summary(&self, last_n: usize) -> PerformanceSummary {
        if self.metrics_history.is_empty() {
            return PerformanceSummary::default();
        }

        let start_idx = self.metrics_history.len().saturating_sub(last_n);
        let recent_metrics = &self.metrics_history[start_idx..];

        if recent_metrics.is_empty() {
            return PerformanceSummary::default();
        }

        let total_operations = recent_metrics.len();
        let total_duration: Duration = recent_metrics.iter().map(|m| m.total_duration).sum();

        let avg_duration = total_duration / total_operations as u32;

        let avg_throughput = recent_metrics
            .iter()
            .map(|m| m.throughput_mbps())
            .sum::<f64>()
            / total_operations as f64;

        let avg_gpu_efficiency = recent_metrics
            .iter()
            .map(|m| m.gpu_efficiency())
            .sum::<f64>()
            / total_operations as f64;

        // Count unique operation types in recent history
        let mut operation_types = std::collections::HashSet::new();
        for metrics in recent_metrics {
            operation_types.insert(format!(
                "{}→{}",
                metrics.source_format, metrics.target_format
            ));
        }

        PerformanceSummary {
            total_operations,
            avg_duration,
            avg_throughput_mbps: avg_throughput,
            avg_gpu_efficiency,
            operation_types: operation_types.len(),
        }
    }

    /// Clear all recorded metrics
    pub fn clear(&mut self) {
        self.metrics_history.clear();
        self.operation_stats.clear();
    }

    /// Get all operation types that have been recorded
    pub fn get_operation_types(&self) -> Vec<String> {
        self.operation_stats.keys().cloned().collect()
    }
}

#[derive(Debug, Clone, Default)]
pub struct PerformanceSummary {
    pub total_operations: usize,
    pub avg_duration: Duration,
    pub avg_throughput_mbps: f64,
    pub avg_gpu_efficiency: f64,
    pub operation_types: usize,
}

impl std::fmt::Display for PerformanceSummary {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "GPU Conversion Performance Summary:\n\
             Operations: {}\n\
             Avg Duration: {:.2}ms\n\
             Avg Throughput: {:.2} MB/s\n\
             Avg GPU Efficiency: {:.1}%\n\
             Operation Types: {}",
            self.total_operations,
            self.avg_duration.as_secs_f64() * 1000.0,
            self.avg_throughput_mbps,
            self.avg_gpu_efficiency * 100.0,
            self.operation_types
        )
    }
}

/// Helper struct for timing operations
pub struct OperationTimer {
    start_time: Instant,
    cpu_start: Option<Instant>,
    gpu_start: Option<Instant>,
    memory_start: Option<Instant>,
    cpu_duration: Duration,
    gpu_duration: Duration,
    memory_transfer_duration: Duration,
}

impl OperationTimer {
    pub fn new() -> Self {
        Self {
            start_time: Instant::now(),
            cpu_start: None,
            gpu_start: None,
            memory_start: None,
            cpu_duration: Duration::ZERO,
            gpu_duration: Duration::ZERO,
            memory_transfer_duration: Duration::ZERO,
        }
    }

    pub fn start_cpu_phase(&mut self) {
        self.cpu_start = Some(Instant::now());
    }

    pub fn end_cpu_phase(&mut self) {
        if let Some(start) = self.cpu_start.take() {
            self.cpu_duration += start.elapsed();
        }
    }

    pub fn start_gpu_phase(&mut self) {
        self.gpu_start = Some(Instant::now());
    }

    pub fn end_gpu_phase(&mut self) {
        if let Some(start) = self.gpu_start.take() {
            self.gpu_duration += start.elapsed();
        }
    }

    pub fn start_memory_phase(&mut self) {
        self.memory_start = Some(Instant::now());
    }

    pub fn end_memory_phase(&mut self) {
        if let Some(start) = self.memory_start.take() {
            self.memory_transfer_duration += start.elapsed();
        }
    }

    pub fn finish(
        self,
        source_format: String,
        target_format: String,
        input_size: usize,
        output_size: usize,
        input_dimensions: (u32, u32),
        output_dimensions: (u32, u32),
    ) -> ConversionMetrics {
        ConversionMetrics {
            total_duration: self.start_time.elapsed(),
            cpu_duration: self.cpu_duration,
            gpu_duration: self.gpu_duration,
            memory_transfer_duration: self.memory_transfer_duration,
            input_size,
            output_size,
            source_format,
            target_format,
            input_dimensions,
            output_dimensions,
        }
    }
}

impl Default for OperationTimer {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_performance_tracker() {
        let mut tracker = PerformanceTracker::new();

        let metrics = ConversionMetrics {
            total_duration: Duration::from_millis(10),
            cpu_duration: Duration::from_millis(2),
            gpu_duration: Duration::from_millis(7),
            memory_transfer_duration: Duration::from_millis(1),
            input_size: 1920 * 1080 * 4,
            output_size: 1920 * 1080 * 4,
            source_format: "NV12".to_string(),
            target_format: "RGBA".to_string(),
            input_dimensions: (1920, 1080),
            output_dimensions: (1920, 1080),
        };

        tracker.record_conversion(metrics);

        let summary = tracker.get_summary();
        assert_eq!(summary.total_operations, 1);
        assert!(summary.avg_throughput_mbps > 0.0);

        let stats = tracker.get_operation_stats("NV12", "RGBA").unwrap();
        assert_eq!(stats.count, 1);
    }

    #[test]
    fn test_operation_timer() {
        let mut timer = OperationTimer::new();

        timer.start_cpu_phase();
        std::thread::sleep(Duration::from_millis(1));
        timer.end_cpu_phase();

        timer.start_gpu_phase();
        std::thread::sleep(Duration::from_millis(1));
        timer.end_gpu_phase();

        let metrics = timer.finish(
            "NV12".to_string(),
            "RGBA".to_string(),
            1000,
            2000,
            (100, 100),
            (100, 100),
        );

        assert!(metrics.total_duration >= Duration::from_millis(2));
        assert!(metrics.cpu_duration >= Duration::from_millis(1));
        assert!(metrics.gpu_duration >= Duration::from_millis(1));
    }

    #[test]
    fn test_conversion_metrics() {
        let metrics = ConversionMetrics {
            total_duration: Duration::from_secs(1),
            cpu_duration: Duration::from_millis(100),
            gpu_duration: Duration::from_millis(800),
            memory_transfer_duration: Duration::from_millis(100),
            input_size: 1024 * 1024, // 1 MB
            output_size: 1024 * 1024,
            source_format: "NV12".to_string(),
            target_format: "RGBA".to_string(),
            input_dimensions: (1024, 1024),
            output_dimensions: (1024, 1024),
        };

        assert_eq!(metrics.throughput_mbps(), 1.0);
        assert_eq!(metrics.pixels_per_second(), 1024.0 * 1024.0);
        assert_eq!(metrics.gpu_efficiency(), 0.8);
    }
}
