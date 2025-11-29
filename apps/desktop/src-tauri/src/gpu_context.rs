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
}

static GPU: OnceCell<Option<SharedGpuContext>> = OnceCell::const_new();

pub async fn get_shared_gpu() -> Option<&'static SharedGpuContext> {
    GPU.get_or_init(|| async {
        let instance = wgpu::Instance::new(&wgpu::InstanceDescriptor::default());
        let adapter = instance
            .request_adapter(&wgpu::RequestAdapterOptions {
                power_preference: wgpu::PowerPreference::HighPerformance,
                force_fallback_adapter: false,
                compatible_surface: None,
            })
            .await
            .ok()?;

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
