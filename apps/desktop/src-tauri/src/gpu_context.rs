use std::{
    collections::HashMap,
    sync::{Arc, RwLock},
    time::Instant,
};
use tokio::sync::OnceCell;

#[derive(Clone)]
pub struct PendingScreenshot {
    pub data: Vec<u8>,
    pub width: u32,
    pub height: u32,
    pub created_at: Instant,
}

pub struct PendingScreenshots(pub Arc<RwLock<HashMap<String, PendingScreenshot>>>);

impl Default for PendingScreenshots {
    fn default() -> Self {
        Self(Arc::new(RwLock::new(HashMap::new())))
    }
}

impl PendingScreenshots {
    pub fn insert(&self, key: String, screenshot: PendingScreenshot) {
        let mut guard = self.0.write().unwrap();
        guard.retain(|_, v| v.created_at.elapsed() < std::time::Duration::from_secs(10));
        guard.insert(key, screenshot);
    }

    pub fn remove(&self, key: &str) -> Option<PendingScreenshot> {
        self.0.write().unwrap().remove(key)
    }

    pub fn get(&self, key: &str) -> Option<PendingScreenshot> {
        self.0.read().unwrap().get(key).cloned()
    }
}

pub struct SharedGpuContext {
    pub device: Arc<wgpu::Device>,
    pub queue: Arc<wgpu::Queue>,
    pub adapter: Arc<wgpu::Adapter>,
    pub instance: Arc<wgpu::Instance>,
    pub is_software_adapter: bool,
}

static GPU: OnceCell<Option<SharedGpuContext>> = OnceCell::const_new();

pub async fn get_shared_gpu() -> Option<&'static SharedGpuContext> {
    GPU.get_or_init(|| async {
        let instance = wgpu::Instance::new(&wgpu::InstanceDescriptor {
            backends: wgpu::Backends::all(),
            flags: wgpu::InstanceFlags::default()
                | wgpu::InstanceFlags::ALLOW_UNDERLYING_NONCOMPLIANT_ADAPTER,
            ..Default::default()
        });

        let adapters = instance.enumerate_adapters(wgpu::Backends::all());

        for adapter in &adapters {
            let info = adapter.get_info();
            tracing::info!(
                "Found GPU adapter: {} (Vendor: 0x{:04X}, Backend: {:?}, Type: {:?}, LUID: {:?})",
                info.name,
                info.vendor,
                info.backend,
                info.device_type,
                info.device
            );
        }

        let (adapter, is_software_adapter) = if let Some(hardware_adapter) = adapters
            .iter()
            .find(|a| {
                let info = a.get_info();
                // Prefer discrete GPU on Dx12 if available for zero-copy
                info.device_type == wgpu::DeviceType::DiscreteGpu
                    && info.backend == wgpu::Backend::Dx12
                    && info.name != "Microsoft Basic Render Driver"
            })
            .or_else(|| {
                // Secondary check for any hardware GPU on Dx12
                adapters.iter().find(|a| {
                    let info = a.get_info();
                    info.device_type != wgpu::DeviceType::Cpu
                        && info.backend == wgpu::Backend::Dx12
                        && info.name != "Microsoft Basic Render Driver"
                })
            })
            .or_else(|| {
                // Tertiary: try hardware on any backend (might have been missed by Dx12)
                adapters.iter().find(|a| {
                    let info = a.get_info();
                    info.device_type != wgpu::DeviceType::Cpu
                        && info.name != "Microsoft Basic Render Driver"
                        && !info.name.contains("WARP")
                })
            }) {
            let info = hardware_adapter.get_info();
            tracing::info!(
                adapter_name = info.name,
                adapter_backend = ?info.backend,
                "Using hardware GPU adapter for shared context"
            );
            (hardware_adapter.clone(), false)
        } else {
            tracing::warn!(
                "No clear hardware GPU adapter found via enumeration, attempting fallback"
            );
            let fallback_adapter = instance
                .request_adapter(&wgpu::RequestAdapterOptions {
                    power_preference: wgpu::PowerPreference::HighPerformance,
                    force_fallback_adapter: false,
                    compatible_surface: None,
                })
                .await
                .ok()?;

            let info = fallback_adapter.get_info();
            let is_software = info.device_type == wgpu::DeviceType::Cpu
                || info.name == "Microsoft Basic Render Driver";

            tracing::info!(
                adapter_name = info.name,
                adapter_backend = ?info.backend,
                is_software = is_software,
                "Using fallback GPU adapter for shared context"
            );
            (fallback_adapter, is_software)
        };

        let (device, queue) = adapter
            .request_device(&wgpu::DeviceDescriptor {
                label: Some("cap-shared-gpu-device"),
                required_features: wgpu::Features::empty(),
                ..Default::default()
            })
            .await
            .ok()?;

        Some(SharedGpuContext {
            device: Arc::new(device),
            queue: Arc::new(queue),
            adapter: Arc::new(adapter),
            instance: Arc::new(instance),
            is_software_adapter,
        })
    })
    .await
    .as_ref()
}

pub fn prewarm_gpu() {
    tokio::spawn(async {
        get_shared_gpu().await;
    });
}
