use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};

#[derive(Clone)]
pub struct GpuDeviceHealth {
    lost: Arc<AtomicBool>,
}

impl GpuDeviceHealth {
    pub fn track(
        device: &wgpu::Device,
        on_lost: impl Fn(wgpu::DeviceLostReason, String) + Send + 'static,
    ) -> Self {
        let lost = Arc::new(AtomicBool::new(false));
        let callback_lost = lost.clone();
        device.set_device_lost_callback(move |reason, message| {
            callback_lost.store(true, Ordering::Release);
            on_lost(reason, message);
        });
        Self { lost }
    }

    pub fn ensure_available(&self) -> Result<(), &'static str> {
        if self.lost.load(Ordering::Acquire) {
            return Err("The graphics device was lost. Restart Cap to generate an export preview.");
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;

    fn device() -> (wgpu::Device, wgpu::Queue) {
        wgpu::Device::noop(&wgpu::DeviceDescriptor::default())
    }

    fn preview_pipeline(
        health: &GpuDeviceHealth,
        device: &wgpu::Device,
    ) -> Result<wgpu::PipelineLayout, &'static str> {
        health.ensure_available()?;
        Ok(device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor::default()))
    }

    #[test]
    fn unguarded_repeated_previews_panic_after_device_loss() {
        let (device, _queue) = device();
        device.destroy();
        device.poll(wgpu::PollType::Poll).unwrap();

        for _ in 0..9 {
            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
                    label: Some("NV12 Converter Pipeline Layout"),
                    ..Default::default()
                })
            }));
            assert!(result.is_err());
        }
    }

    #[test]
    fn repeated_previews_reject_a_lost_device_and_its_clones() {
        let (device, _queue) = device();
        let reports = Arc::new(AtomicUsize::new(0));
        let callback_reports = reports.clone();
        let health = GpuDeviceHealth::track(&device, move |_, _| {
            callback_reports.fetch_add(1, Ordering::Relaxed);
        });
        let editor_device = device.clone();
        let editor_health = health.clone();
        let _retained_pipeline = preview_pipeline(&editor_health, &editor_device).unwrap();

        device.destroy();
        device.poll(wgpu::PollType::Poll).unwrap();

        for _ in 0..9 {
            assert_eq!(
                preview_pipeline(&editor_health, &editor_device).unwrap_err(),
                "The graphics device was lost. Restart Cap to generate an export preview."
            );
        }
        assert_eq!(reports.load(Ordering::Relaxed), 1);
    }

    #[test]
    fn loss_does_not_disable_an_independent_device() {
        let (lost_device, _lost_queue) = device();
        let health = GpuDeviceHealth::track(&lost_device, |_, _| {});
        lost_device.destroy();
        lost_device.poll(wgpu::PollType::Poll).unwrap();

        let (independent_device, _queue) = device();
        let independent_health = GpuDeviceHealth::track(&independent_device, |_, _| {});
        preview_pipeline(&independent_health, &independent_device).unwrap();
        assert!(preview_pipeline(&health, &lost_device).is_err());
    }

    #[test]
    fn healthy_device_validation_errors_still_panic() {
        let (device, _queue) = device();
        let health = GpuDeviceHealth::track(&device, |_, _| {});
        health.ensure_available().unwrap();

        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            device.create_shader_module(wgpu::ShaderModuleDescriptor {
                label: Some("invalid synthetic shader"),
                source: wgpu::ShaderSource::Wgsl("invalid wgsl".into()),
            })
        }));
        assert!(result.is_err());
        health.ensure_available().unwrap();
    }
}
