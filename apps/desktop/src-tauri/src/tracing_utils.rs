use std::time::Instant;
#[cfg(debug_assertions)]
use tracing::{Instrument, info_span};
use tracing::{debug, info};

/// A tracing-based replacement for UploadDebugEvent that provides structured logging
/// and OpenTelemetry spans for upload debugging in debug builds.
pub struct UploadTracer {
    pub video_id: String,
    pub upload_id: String,
    start_time: Instant,
}

impl UploadTracer {
    pub fn new(video_id: String, upload_id: String) -> Self {
        debug!(
            video_id = %video_id,
            upload_id = %upload_id,
            "Initializing upload tracer"
        );

        Self {
            video_id,
            upload_id,
            start_time: Instant::now(),
        }
    }

    /// Create a span for the entire upload operation
    #[cfg(debug_assertions)]
    pub fn upload_span<F, R>(&self, operation: F) -> R
    where
        F: FnOnce() -> R,
    {
        let span = info_span!(
            "upload_operation",
            video_id = %self.video_id,
            upload_id = %self.upload_id,
            elapsed_ms = tracing::field::Empty
        );

        let _enter = span.enter();
        let start = Instant::now();
        let result = operation();
        let elapsed = start.elapsed();

        span.record("elapsed_ms", elapsed.as_millis());
        info!(
            elapsed_ms = elapsed.as_millis(),
            "Upload operation completed"
        );

        result
    }

    /// For release builds, just execute the operation without tracing overhead
    #[cfg(not(debug_assertions))]
    pub fn upload_span<F, R>(&self, operation: F) -> R
    where
        F: FnOnce() -> R,
    {
        operation()
    }

    /// Create a span for presigning operations
    #[cfg(debug_assertions)]
    pub async fn presign_span<F, R>(
        &self,
        part_number: u32,
        chunk_size: usize,
        total_size: u64,
        operation: F,
    ) -> R
    where
        F: std::future::Future<Output = R>,
    {
        let span = info_span!(
            "presign_part",
            video_id = %self.video_id,
            upload_id = %self.upload_id,
            part_number = part_number,
            chunk_size = chunk_size,
            total_size = total_size,
            elapsed_ms = tracing::field::Empty
        );

        let start = Instant::now();
        let result = operation.instrument(span.clone()).await;
        let elapsed = start.elapsed();

        span.record("elapsed_ms", elapsed.as_millis());
        info!(
            part_number = part_number,
            chunk_size = chunk_size,
            elapsed_ms = elapsed.as_millis(),
            "Presigning completed"
        );

        result
    }

    #[cfg(not(debug_assertions))]
    pub async fn presign_span<F, R>(
        &self,
        _part_number: u32,
        _chunk_size: usize,
        _total_size: u64,
        operation: F,
    ) -> R
    where
        F: std::future::Future<Output = R>,
    {
        operation.await
    }

    /// Create a span for chunk upload operations
    #[cfg(debug_assertions)]
    pub async fn upload_chunk_span<F, R>(
        &self,
        part_number: u32,
        chunk_size: usize,
        total_size: u64,
        operation: F,
    ) -> R
    where
        F: std::future::Future<Output = R>,
    {
        let span = info_span!(
            "upload_chunk",
            video_id = %self.video_id,
            upload_id = %self.upload_id,
            part_number = part_number,
            chunk_size = chunk_size,
            total_size = total_size,
            elapsed_ms = tracing::field::Empty
        );

        let start = Instant::now();
        let result = operation.instrument(span.clone()).await;
        let elapsed = start.elapsed();

        span.record("elapsed_ms", elapsed.as_millis());
        info!(
            part_number = part_number,
            chunk_size = chunk_size,
            elapsed_ms = elapsed.as_millis(),
            "Chunk upload completed"
        );

        result
    }

    #[cfg(not(debug_assertions))]
    pub async fn upload_chunk_span<F, R>(
        &self,
        _part_number: u32,
        _chunk_size: usize,
        _total_size: u64,
        operation: F,
    ) -> R
    where
        F: std::future::Future<Output = R>,
    {
        operation.await
    }

    /// Log when waiting for next chunk
    pub fn log_pending_next_chunk(&self, prev_part_number: u32) {
        debug!(
            video_id = %self.video_id,
            upload_id = %self.upload_id,
            prev_part_number = prev_part_number,
            "Pending next chunk"
        );
    }

    /// Log upload completion with total time
    pub fn log_completion(&self) {
        let total_elapsed = self.start_time.elapsed();
        info!(
            video_id = %self.video_id,
            upload_id = %self.upload_id,
            total_elapsed_ms = total_elapsed.as_millis(),
            total_elapsed_secs = total_elapsed.as_secs(),
            "Upload completed"
        );
    }

    /// Create a span for the entire multipart upload process
    #[cfg(debug_assertions)]
    pub async fn multipart_upload_span<F, R>(&self, operation: F) -> R
    where
        F: std::future::Future<Output = R>,
    {
        let span = info_span!(
            "multipart_upload",
            video_id = %self.video_id,
            upload_id = %self.upload_id,
            total_elapsed_ms = tracing::field::Empty
        );

        let start = Instant::now();
        let result = operation.instrument(span.clone()).await;
        let elapsed = start.elapsed();

        span.record("total_elapsed_ms", elapsed.as_millis());

        result
    }

    #[cfg(not(debug_assertions))]
    pub async fn multipart_upload_span<F, R>(&self, operation: F) -> R
    where
        F: std::future::Future<Output = R>,
    {
        operation.await
    }
}

/// Helper macro for creating timed spans with automatic timing
#[macro_export]
macro_rules! timed_span {
    ($span_name:expr, $($field:ident = $value:expr),*) => {{
        #[cfg(debug_assertions)]
        {
            let span = tracing::info_span!(
                $span_name,
                elapsed_ms = tracing::field::Empty,
                $($field = $value),*
            );
            let _enter = span.enter();
            let start = std::time::Instant::now();
            let result = {
                // Code block will be inserted here by the caller
            };
            let elapsed = start.elapsed();
            span.record("elapsed_ms", elapsed.as_millis());
            result
        }
        #[cfg(not(debug_assertions))]
        {
            // Code block will be inserted here by the caller
        }
    }};
}
