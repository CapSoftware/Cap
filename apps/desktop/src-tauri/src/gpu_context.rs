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
        let instance = wgpu::Instance::new(&wgpu::InstanceDescriptor::default());

        let hardware_adapter = instance
            .request_adapter(&wgpu::RequestAdapterOptions {
                power_preference: wgpu::PowerPreference::HighPerformance,
                force_fallback_adapter: false,
                compatible_surface: None,
            })
            .await
            .ok();

        let (adapter, is_software_adapter) = if let Some(adapter) = hardware_adapter {
            tracing::info!(
                adapter_name = adapter.get_info().name,
                adapter_backend = ?adapter.get_info().backend,
                "Using hardware GPU adapter for shared context"
            );
            (adapter, false)
        } else {
            tracing::warn!("No hardware GPU adapter found, attempting software fallback for shared context");
            let software_adapter = instance
                .request_adapter(&wgpu::RequestAdapterOptions {
                    power_preference: wgpu::PowerPreference::LowPower,
                    force_fallback_adapter: true,
                    compatible_surface: None,
                })
                .await
                .ok()?;

            tracing::info!(
                adapter_name = software_adapter.get_info().name,
                adapter_backend = ?software_adapter.get_info().backend,
                "Using software adapter for shared context (CPU rendering - performance may be reduced)"
            );
            (software_adapter, true)
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
