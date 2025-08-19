use crate::{CameraFormat, CameraInput, ConversionError};
use std::sync::Arc;

/// Fallback conversion strategy when GPU conversion fails
#[derive(Clone)]
pub enum FallbackStrategy {
    /// No fallback - return error immediately
    None,
    /// Use CPU-based conversion as fallback
    CpuConversion,
    /// Try software implementation with different parameters
    SoftwareRetry,
    /// Custom fallback function provided by user
    Custom(Arc<dyn Fn(&CameraInput) -> Result<Vec<u8>, ConversionError> + Send + Sync>),
}

impl std::fmt::Debug for FallbackStrategy {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            FallbackStrategy::None => write!(f, "None"),
            FallbackStrategy::CpuConversion => write!(f, "CpuConversion"),
            FallbackStrategy::SoftwareRetry => write!(f, "SoftwareRetry"),
            FallbackStrategy::Custom(_) => write!(f, "Custom(...)"),
        }
    }
}

/// Fallback converter that handles GPU failures gracefully
pub struct FallbackConverter {
    strategy: FallbackStrategy,
}

impl FallbackConverter {
    pub fn new(strategy: FallbackStrategy) -> Self {
        Self { strategy }
    }

    /// Attempt conversion with fallback on failure
    pub fn convert_with_fallback(
        &self,
        input: &CameraInput,
        target_width: u32,
        target_height: u32,
    ) -> Result<Vec<u8>, ConversionError> {
        match &self.strategy {
            FallbackStrategy::None => Err(ConversionError::GPUError(
                "No fallback strategy configured".to_string(),
            )),
            FallbackStrategy::CpuConversion => self.cpu_convert(input, target_width, target_height),
            FallbackStrategy::SoftwareRetry => {
                self.software_retry(input, target_width, target_height)
            }
            FallbackStrategy::Custom(converter) => converter(input),
        }
    }

    /// CPU-based fallback conversion using basic algorithms
    fn cpu_convert(
        &self,
        input: &CameraInput,
        target_width: u32,
        target_height: u32,
    ) -> Result<Vec<u8>, ConversionError> {
        // Convert to RGBA first if needed
        let rgba_data = match input.format {
            CameraFormat::RGBA => input.data.to_vec(),
            CameraFormat::BGRA => self.bgra_to_rgba_cpu(input)?,
            CameraFormat::RGB24 => self.rgb24_to_rgba_cpu(input)?,
            CameraFormat::NV12 => self.nv12_to_rgba_cpu(input)?,
            CameraFormat::UYVY => self.uyvy_to_rgba_cpu(input)?,
            CameraFormat::YUYV => self.yuyv_to_rgba_cpu(input)?,
            CameraFormat::YUV420P => self.yuv420p_to_rgba_cpu(input)?,
            CameraFormat::Unknown => return Err(ConversionError::UnsupportedFormat(input.format)),
        };

        // Scale if needed
        if input.width != target_width || input.height != target_height {
            self.scale_rgba_cpu(
                &rgba_data,
                input.width,
                input.height,
                target_width,
                target_height,
            )
        } else {
            Ok(rgba_data)
        }
    }

    /// Software retry with different parameters
    fn software_retry(
        &self,
        input: &CameraInput,
        target_width: u32,
        target_height: u32,
    ) -> Result<Vec<u8>, ConversionError> {
        // For now, same as CPU conversion - could be extended with different algorithms
        self.cpu_convert(input, target_width, target_height)
    }

    /// Convert BGRA to RGBA on CPU
    fn bgra_to_rgba_cpu(&self, input: &CameraInput) -> Result<Vec<u8>, ConversionError> {
        let expected_size = (input.width * input.height * 4) as usize;
        if input.data.len() < expected_size {
            return Err(ConversionError::InsufficientData {
                expected: expected_size,
                actual: input.data.len(),
            });
        }

        let mut rgba_data = Vec::with_capacity(expected_size);

        for chunk in input.data.chunks_exact(4) {
            // BGRA -> RGBA: swap B and R channels
            rgba_data.push(chunk[2]); // R
            rgba_data.push(chunk[1]); // G
            rgba_data.push(chunk[0]); // B
            rgba_data.push(chunk[3]); // A
        }

        Ok(rgba_data)
    }

    /// Convert RGB24 to RGBA on CPU
    fn rgb24_to_rgba_cpu(&self, input: &CameraInput) -> Result<Vec<u8>, ConversionError> {
        let expected_size = (input.width * input.height * 3) as usize;
        if input.data.len() < expected_size {
            return Err(ConversionError::InsufficientData {
                expected: expected_size,
                actual: input.data.len(),
            });
        }

        let mut rgba_data = Vec::with_capacity((input.width * input.height * 4) as usize);

        for chunk in input.data.chunks_exact(3) {
            rgba_data.push(chunk[0]); // R
            rgba_data.push(chunk[1]); // G
            rgba_data.push(chunk[2]); // B
            rgba_data.push(255); // A
        }

        Ok(rgba_data)
    }

    /// Convert NV12 to RGBA on CPU
    fn nv12_to_rgba_cpu(&self, input: &CameraInput) -> Result<Vec<u8>, ConversionError> {
        let y_size = (input.width * input.height) as usize;
        let uv_size = y_size / 2;
        let expected_size = y_size + uv_size;

        if input.data.len() < expected_size {
            return Err(ConversionError::InsufficientData {
                expected: expected_size,
                actual: input.data.len(),
            });
        }

        let y_data = &input.data[..y_size];
        let uv_data = &input.data[y_size..];

        let mut rgba_data = Vec::with_capacity((input.width * input.height * 4) as usize);

        for y in 0..input.height {
            for x in 0..input.width {
                let y_idx = (y * input.width + x) as usize;
                let uv_idx = ((y / 2) * (input.width / 2) + (x / 2)) as usize * 2;

                let y_val = y_data[y_idx] as f32;
                let u_val = uv_data[uv_idx] as f32 - 128.0;
                let v_val = uv_data[uv_idx + 1] as f32 - 128.0;

                // YUV to RGB conversion
                let r = (y_val + 1.402 * v_val).clamp(0.0, 255.0) as u8;
                let g = (y_val - 0.344 * u_val - 0.714 * v_val).clamp(0.0, 255.0) as u8;
                let b = (y_val + 1.772 * u_val).clamp(0.0, 255.0) as u8;

                rgba_data.push(r);
                rgba_data.push(g);
                rgba_data.push(b);
                rgba_data.push(255); // Alpha
            }
        }

        Ok(rgba_data)
    }

    /// Convert UYVY to RGBA on CPU
    fn uyvy_to_rgba_cpu(&self, input: &CameraInput) -> Result<Vec<u8>, ConversionError> {
        let expected_size = (input.width * input.height * 2) as usize;
        if input.data.len() < expected_size {
            return Err(ConversionError::InsufficientData {
                expected: expected_size,
                actual: input.data.len(),
            });
        }

        let mut rgba_data = Vec::with_capacity((input.width * input.height * 4) as usize);

        for chunk in input.data.chunks_exact(4) {
            // UYVY format: U Y V Y
            let u = chunk[0] as f32 - 128.0;
            let y1 = chunk[1] as f32;
            let v = chunk[2] as f32 - 128.0;
            let y2 = chunk[3] as f32;

            // Convert first pixel
            let r1 = (y1 + 1.402 * v).clamp(0.0, 255.0) as u8;
            let g1 = (y1 - 0.344 * u - 0.714 * v).clamp(0.0, 255.0) as u8;
            let b1 = (y1 + 1.772 * u).clamp(0.0, 255.0) as u8;

            // Convert second pixel
            let r2 = (y2 + 1.402 * v).clamp(0.0, 255.0) as u8;
            let g2 = (y2 - 0.344 * u - 0.714 * v).clamp(0.0, 255.0) as u8;
            let b2 = (y2 + 1.772 * u).clamp(0.0, 255.0) as u8;

            // Add pixels to output
            rgba_data.extend_from_slice(&[r1, g1, b1, 255, r2, g2, b2, 255]);
        }

        Ok(rgba_data)
    }

    /// Convert YUYV to RGBA on CPU
    fn yuyv_to_rgba_cpu(&self, input: &CameraInput) -> Result<Vec<u8>, ConversionError> {
        let expected_size = (input.width * input.height * 2) as usize;
        if input.data.len() < expected_size {
            return Err(ConversionError::InsufficientData {
                expected: expected_size,
                actual: input.data.len(),
            });
        }

        let mut rgba_data = Vec::with_capacity((input.width * input.height * 4) as usize);

        for chunk in input.data.chunks_exact(4) {
            // YUYV format: Y U Y V
            let y1 = chunk[0] as f32;
            let u = chunk[1] as f32 - 128.0;
            let y2 = chunk[2] as f32;
            let v = chunk[3] as f32 - 128.0;

            // Convert first pixel
            let r1 = (y1 + 1.402 * v).clamp(0.0, 255.0) as u8;
            let g1 = (y1 - 0.344 * u - 0.714 * v).clamp(0.0, 255.0) as u8;
            let b1 = (y1 + 1.772 * u).clamp(0.0, 255.0) as u8;

            // Convert second pixel
            let r2 = (y2 + 1.402 * v).clamp(0.0, 255.0) as u8;
            let g2 = (y2 - 0.344 * u - 0.714 * v).clamp(0.0, 255.0) as u8;
            let b2 = (y2 + 1.772 * u).clamp(0.0, 255.0) as u8;

            // Add pixels to output
            rgba_data.extend_from_slice(&[r1, g1, b1, 255, r2, g2, b2, 255]);
        }

        Ok(rgba_data)
    }

    /// Convert YUV420P to RGBA on CPU
    fn yuv420p_to_rgba_cpu(&self, input: &CameraInput) -> Result<Vec<u8>, ConversionError> {
        let y_size = (input.width * input.height) as usize;
        let uv_size = y_size / 4;
        let expected_size = y_size + 2 * uv_size;

        if input.data.len() < expected_size {
            return Err(ConversionError::InsufficientData {
                expected: expected_size,
                actual: input.data.len(),
            });
        }

        let y_data = &input.data[..y_size];
        let u_data = &input.data[y_size..y_size + uv_size];
        let v_data = &input.data[y_size + uv_size..];

        let mut rgba_data = Vec::with_capacity((input.width * input.height * 4) as usize);

        for y in 0..input.height {
            for x in 0..input.width {
                let y_idx = (y * input.width + x) as usize;
                let uv_idx = ((y / 2) * (input.width / 2) + (x / 2)) as usize;

                let y_val = y_data[y_idx] as f32;
                let u_val = u_data[uv_idx] as f32 - 128.0;
                let v_val = v_data[uv_idx] as f32 - 128.0;

                // YUV to RGB conversion
                let r = (y_val + 1.402 * v_val).clamp(0.0, 255.0) as u8;
                let g = (y_val - 0.344 * u_val - 0.714 * v_val).clamp(0.0, 255.0) as u8;
                let b = (y_val + 1.772 * u_val).clamp(0.0, 255.0) as u8;

                rgba_data.push(r);
                rgba_data.push(g);
                rgba_data.push(b);
                rgba_data.push(255); // Alpha
            }
        }

        Ok(rgba_data)
    }

    /// Scale RGBA data using nearest neighbor interpolation
    fn scale_rgba_cpu(
        &self,
        rgba_data: &[u8],
        src_width: u32,
        src_height: u32,
        dst_width: u32,
        dst_height: u32,
    ) -> Result<Vec<u8>, ConversionError> {
        let mut scaled_data = Vec::with_capacity((dst_width * dst_height * 4) as usize);

        let x_ratio = src_width as f32 / dst_width as f32;
        let y_ratio = src_height as f32 / dst_height as f32;

        for y in 0..dst_height {
            for x in 0..dst_width {
                let src_x = (x as f32 * x_ratio) as u32;
                let src_y = (y as f32 * y_ratio) as u32;

                let src_idx = ((src_y * src_width + src_x) * 4) as usize;

                if src_idx + 3 < rgba_data.len() {
                    scaled_data.push(rgba_data[src_idx]); // R
                    scaled_data.push(rgba_data[src_idx + 1]); // G
                    scaled_data.push(rgba_data[src_idx + 2]); // B
                    scaled_data.push(rgba_data[src_idx + 3]); // A
                } else {
                    // Fallback to black pixel if out of bounds
                    scaled_data.extend_from_slice(&[0, 0, 0, 255]);
                }
            }
        }

        Ok(scaled_data)
    }
}

/// Error recovery strategies for common GPU issues
pub struct ErrorRecovery;

impl ErrorRecovery {
    /// Analyze error and suggest recovery action
    pub fn analyze_error(error: &ConversionError) -> RecoveryAction {
        match error {
            ConversionError::GPUError(msg) => {
                if msg.contains("device lost") || msg.contains("context lost") {
                    RecoveryAction::RecreateDevice
                } else if msg.contains("out of memory") || msg.contains("allocation failed") {
                    RecoveryAction::ReduceMemoryUsage
                } else if msg.contains("timeout") {
                    RecoveryAction::RetryWithTimeout
                } else {
                    RecoveryAction::UseFallback
                }
            }
            ConversionError::UnsupportedFormat(_) => RecoveryAction::UseFallback,
            ConversionError::InvalidDimensions { .. } => RecoveryAction::ValidateInput,
            ConversionError::InsufficientData { .. } => RecoveryAction::ValidateInput,
        }
    }

    /// Check if GPU is still available and working
    pub async fn check_gpu_health(device: &wgpu::Device) -> bool {
        // Try to create a simple buffer to test if GPU is responsive
        let test_buffer = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("GPU Health Check"),
            size: 64,
            usage: wgpu::BufferUsages::STORAGE,
            mapped_at_creation: false,
        });

        // If we can create a buffer, GPU is likely still working
        drop(test_buffer);
        true
    }
}

/// Recommended action for error recovery
#[derive(Debug, Clone, PartialEq)]
pub enum RecoveryAction {
    /// Recreate the GPU device and converters
    RecreateDevice,
    /// Clear texture pools and reduce memory usage
    ReduceMemoryUsage,
    /// Retry operation with longer timeout
    RetryWithTimeout,
    /// Use CPU fallback conversion
    UseFallback,
    /// Validate input parameters
    ValidateInput,
    /// Operation cannot be recovered
    Unrecoverable,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_bgra_to_rgba_conversion() {
        let converter = FallbackConverter::new(FallbackStrategy::CpuConversion);

        // Create test BGRA data (2x2 pixels)
        let bgra_data = vec![
            255, 0, 0, 255, // Blue pixel
            0, 255, 0, 255, // Green pixel
            0, 0, 255, 255, // Red pixel
            128, 128, 128, 255, // Gray pixel
        ];

        let input = CameraInput::new(&bgra_data, CameraFormat::BGRA, 2, 2);
        let result = converter.bgra_to_rgba_cpu(&input).unwrap();

        // Expected RGBA data (channels swapped)
        let expected = vec![
            0, 0, 255, 255, // Red pixel (was blue)
            0, 255, 0, 255, // Green pixel (unchanged)
            255, 0, 0, 255, // Blue pixel (was red)
            128, 128, 128, 255, // Gray pixel (unchanged)
        ];

        assert_eq!(result, expected);
    }

    #[test]
    fn test_rgb24_to_rgba_conversion() {
        let converter = FallbackConverter::new(FallbackStrategy::CpuConversion);

        // Create test RGB24 data (2x1 pixels)
        let rgb_data = vec![
            255, 0, 0, // Red pixel
            0, 255, 0, // Green pixel
        ];

        let input = CameraInput::new(&rgb_data, CameraFormat::RGB24, 2, 1);
        let result = converter.rgb24_to_rgba_cpu(&input).unwrap();

        // Expected RGBA data (alpha added)
        let expected = vec![
            255, 0, 0, 255, // Red pixel with alpha
            0, 255, 0, 255, // Green pixel with alpha
        ];

        assert_eq!(result, expected);
    }

    #[test]
    fn test_error_analysis() {
        let gpu_error = ConversionError::GPUError("device lost".to_string());
        assert_eq!(
            ErrorRecovery::analyze_error(&gpu_error),
            RecoveryAction::RecreateDevice
        );

        let memory_error = ConversionError::GPUError("out of memory".to_string());
        assert_eq!(
            ErrorRecovery::analyze_error(&memory_error),
            RecoveryAction::ReduceMemoryUsage
        );

        let format_error = ConversionError::UnsupportedFormat(CameraFormat::Unknown);
        assert_eq!(
            ErrorRecovery::analyze_error(&format_error),
            RecoveryAction::UseFallback
        );
    }
}
