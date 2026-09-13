use std::{ffi::c_void, ptr::NonNull};

pub const FRAME_SIZE: usize = 480;
pub const DELAY_SAMPLES: usize = FRAME_SIZE * 2;

#[repr(align(64))]
struct AlignedModel([u8; include_bytes!("../vendor/weights.bin").len()]);

static MODEL: AlignedModel = AlignedModel(*include_bytes!("../vendor/weights.bin"));

unsafe extern "C" {
    fn rnnoise_model_from_buffer(data: *const c_void, length: i32) -> *mut c_void;
    fn rnnoise_model_free(model: *mut c_void);
    fn rnnoise_create(model: *mut c_void) -> *mut c_void;
    fn rnnoise_destroy(state: *mut c_void);
    fn rnnoise_process_frame(state: *mut c_void, output: *mut f32, input: *const f32) -> f32;
}

pub struct DenoiseState {
    state: NonNull<c_void>,
    model: NonNull<c_void>,
}

// Each state owns its C allocations; the only shared storage is the immutable, aligned model.
unsafe impl Send for DenoiseState {}

impl Default for DenoiseState {
    fn default() -> Self {
        Self::new()
    }
}

impl DenoiseState {
    pub fn new() -> Self {
        let model = NonNull::new(unsafe {
            rnnoise_model_from_buffer(MODEL.0.as_ptr().cast(), MODEL.0.len() as i32)
        })
        .expect("the bundled RNNoise model must load");
        let state = NonNull::new(unsafe { rnnoise_create(model.as_ptr()) });
        match state {
            Some(state) => Self { state, model },
            None => {
                unsafe { rnnoise_model_free(model.as_ptr()) };
                panic!("the bundled RNNoise model must initialize");
            }
        }
    }

    pub fn process_frame(
        &mut self,
        output: &mut [f32; FRAME_SIZE],
        input: &[f32; FRAME_SIZE],
    ) -> f32 {
        unsafe { rnnoise_process_frame(self.state.as_ptr(), output.as_mut_ptr(), input.as_ptr()) }
    }
}

impl Drop for DenoiseState {
    fn drop(&mut self) {
        unsafe {
            rnnoise_destroy(self.state.as_ptr());
            rnnoise_model_free(self.model.as_ptr());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    fn buffered_model_cleanup_handles_nonzero_allocations() {
        let mut child = std::process::Command::new(std::env::current_exe().unwrap());
        child.args([
            "--exact",
            "tests::bundled_model_is_aligned_and_handles_silence",
            "--nocapture",
        ]);
        #[cfg(target_os = "macos")]
        child
            .env("MallocNanoZone", "0")
            .env("MallocScribble", "1")
            .env("MallocPreScribble", "1");
        #[cfg(target_os = "linux")]
        child
            .env("MALLOC_PERTURB_", "165")
            .env("GLIBC_TUNABLES", "glibc.malloc.tcache_count=0");
        assert!(child.status().unwrap().success());
    }

    #[test]
    fn bundled_model_is_aligned_and_handles_silence() {
        assert_eq!(MODEL.0.as_ptr() as usize % 64, 0);
        let mut state = DenoiseState::new();
        let mut output = [0.0; FRAME_SIZE];
        for _ in 0..30 {
            let probability = state.process_frame(&mut output, &[0.0; FRAME_SIZE]);
            assert!(probability.is_finite());
            assert!(output.iter().all(|sample| *sample == 0.0));
        }
    }

    #[test]
    fn bundled_model_processes_non_silent_audio() {
        let mut state = DenoiseState::new();
        let mut output = [0.0; FRAME_SIZE];
        for frame in 0..30 {
            let input = std::array::from_fn(|sample| {
                let phase =
                    (frame * FRAME_SIZE + sample) as f32 * std::f32::consts::TAU * 220.0 / 48_000.0;
                phase.sin() * 10_000.0
            });
            let probability = state.process_frame(&mut output, &input);
            assert!(probability.is_finite());
            assert!(output.iter().all(|sample| sample.is_finite()));
        }
    }
}
