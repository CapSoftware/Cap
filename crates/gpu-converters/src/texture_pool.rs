use std::collections::HashMap;
use wgpu::{Device, Queue, Texture, TextureDescriptor};

/// A pool for managing GPU textures to avoid frequent allocation/deallocation
pub struct TexturePool {
    device: Device,
    queue: Queue,
    // Key: (width, height, format), Value: Vec of available textures
    available_textures: HashMap<TextureKey, Vec<Texture>>,
    // Track textures currently in use
    in_use_count: HashMap<TextureKey, usize>,
    max_pool_size: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
struct TextureKey {
    width: u32,
    height: u32,
    format: wgpu::TextureFormat,
    usage: wgpu::TextureUsages,
}

impl TextureKey {
    fn new(desc: &TextureDescriptor) -> Self {
        Self {
            width: desc.size.width,
            height: desc.size.height,
            format: desc.format,
            usage: desc.usage,
        }
    }
}

pub struct PooledTexture {
    texture: Option<Texture>,
    key: TextureKey,
    pool: *mut TexturePool,
}

impl PooledTexture {
    pub fn texture(&self) -> &Texture {
        self.texture
            .as_ref()
            .expect("Texture was already returned to pool")
    }
}

impl Drop for PooledTexture {
    fn drop(&mut self) {
        if let Some(texture) = self.texture.take() {
            // Safety: The pool pointer is valid as long as the PooledTexture exists
            // and the pool is guaranteed to outlive all PooledTextures
            unsafe {
                (*self.pool).return_texture(texture, self.key);
            }
        }
    }
}

impl TexturePool {
    pub fn new(device: Device, queue: Queue) -> Self {
        Self {
            device,
            queue,
            available_textures: HashMap::new(),
            in_use_count: HashMap::new(),
            max_pool_size: 16, // Default max textures per format
        }
    }

    pub fn with_max_pool_size(mut self, max_size: usize) -> Self {
        self.max_pool_size = max_size;
        self
    }

    /// Get a texture from the pool or create a new one
    pub fn get_texture(&mut self, desc: &TextureDescriptor) -> PooledTexture {
        let key = TextureKey::new(desc);

        // Try to get from pool first
        let texture = if let Some(textures) = self.available_textures.get_mut(&key) {
            if let Some(texture) = textures.pop() {
                texture
            } else {
                self.create_texture(desc)
            }
        } else {
            self.create_texture(desc)
        };

        // Track usage
        *self.in_use_count.entry(key).or_insert(0) += 1;

        PooledTexture {
            texture: Some(texture),
            key,
            pool: self as *mut TexturePool,
        }
    }

    /// Create a new texture with the given descriptor
    fn create_texture(&self, desc: &TextureDescriptor) -> Texture {
        self.device.create_texture(desc)
    }

    /// Return a texture to the pool
    fn return_texture(&mut self, texture: Texture, key: TextureKey) {
        // Decrease usage count
        if let Some(count) = self.in_use_count.get_mut(&key) {
            *count = count.saturating_sub(1);
        }

        // Add to available pool if we haven't exceeded max size
        let available = self.available_textures.entry(key).or_insert_with(Vec::new);
        if available.len() < self.max_pool_size {
            available.push(texture);
        }
        // If pool is full, texture will be dropped automatically
    }

    /// Get statistics about the texture pool
    pub fn stats(&self) -> TexturePoolStats {
        let total_available: usize = self.available_textures.values().map(|v| v.len()).sum();
        let total_in_use: usize = self.in_use_count.values().sum();
        let format_count = self.available_textures.len();

        TexturePoolStats {
            total_available,
            total_in_use,
            format_count,
            max_pool_size: self.max_pool_size,
        }
    }

    /// Clear all cached textures from the pool
    pub fn clear(&mut self) {
        self.available_textures.clear();
        self.in_use_count.clear();
    }

    /// Create a standard RGBA8 output texture descriptor
    pub fn rgba_output_descriptor(width: u32, height: u32) -> TextureDescriptor<'static> {
        TextureDescriptor {
            label: Some("RGBA Output Texture"),
            size: wgpu::Extent3d {
                width,
                height,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba8Unorm,
            usage: wgpu::TextureUsages::STORAGE_BINDING
                | wgpu::TextureUsages::COPY_SRC
                | wgpu::TextureUsages::TEXTURE_BINDING,
            view_formats: &[],
        }
    }

    /// Create a standard input texture descriptor for a given format
    pub fn input_descriptor(
        width: u32,
        height: u32,
        format: wgpu::TextureFormat,
    ) -> TextureDescriptor<'static> {
        TextureDescriptor {
            label: Some("Input Texture"),
            size: wgpu::Extent3d {
                width,
                height,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format,
            usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
            view_formats: &[],
        }
    }

    /// Synchronize all pending operations on the texture pool
    pub fn sync(&self) {
        // Use the queue to ensure all operations are completed
        self.queue.submit(std::iter::empty());
    }

    /// Pre-warm the texture pool with textures of a specific size
    pub fn pre_warm(&mut self, width: u32, height: u32, format: wgpu::TextureFormat, count: usize) {
        let desc = TextureDescriptor {
            label: Some("Pre-warmed Texture"),
            size: wgpu::Extent3d {
                width,
                height,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format,
            usage: wgpu::TextureUsages::STORAGE_BINDING
                | wgpu::TextureUsages::COPY_SRC
                | wgpu::TextureUsages::TEXTURE_BINDING,
            view_formats: &[],
        };

        let key = TextureKey::new(&desc);

        // Check current texture count to avoid borrowing issues
        let current_count = self
            .available_textures
            .get(&key)
            .map(|v| v.len())
            .unwrap_or(0);
        let needed_count = count.min(self.max_pool_size.saturating_sub(current_count));

        // Create textures first
        let mut new_textures = Vec::with_capacity(needed_count);
        for _ in 0..needed_count {
            let texture = self.create_texture(&desc);
            new_textures.push(texture);
        }

        // Then add them to the pool
        let textures = self.available_textures.entry(key).or_insert_with(Vec::new);
        textures.extend(new_textures);

        // Ensure all texture creation operations are completed
        self.sync();
    }
}

#[derive(Debug, Clone)]
pub struct TexturePoolStats {
    pub total_available: usize,
    pub total_in_use: usize,
    pub format_count: usize,
    pub max_pool_size: usize,
}

impl std::fmt::Display for TexturePoolStats {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "TexturePool: {} available, {} in use, {} formats, max size {}",
            self.total_available, self.total_in_use, self.format_count, self.max_pool_size
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Note: These tests would require a WGPU instance to run properly
    // They're included for documentation purposes

    #[tokio::test]
    #[ignore] // Requires GPU hardware
    async fn test_texture_pool_basic_usage() {
        let instance = wgpu::Instance::new(&wgpu::InstanceDescriptor::default());
        let adapter = instance
            .request_adapter(&wgpu::RequestAdapterOptions::default())
            .await
            .expect("Failed to find adapter");
        let (device, queue) = adapter
            .request_device(&wgpu::DeviceDescriptor::default())
            .await
            .expect("Failed to create device");

        let mut pool = TexturePool::new(device, queue);

        let desc = TexturePool::rgba_output_descriptor(1920, 1080);

        // Get texture from pool
        let texture1 = pool.get_texture(&desc);
        assert_eq!(pool.stats().total_in_use, 1);
        assert_eq!(pool.stats().total_available, 0);

        // Drop texture should return it to pool
        drop(texture1);
        assert_eq!(pool.stats().total_in_use, 0);
        assert_eq!(pool.stats().total_available, 1);

        // Getting another texture should reuse the pooled one
        let texture2 = pool.get_texture(&desc);
        assert_eq!(pool.stats().total_in_use, 1);
        assert_eq!(pool.stats().total_available, 0);

        drop(texture2);
    }

    #[tokio::test]
    #[ignore] // Requires GPU hardware
    async fn test_texture_pool_max_size() {
        let instance = wgpu::Instance::new(&wgpu::InstanceDescriptor::default());
        let adapter = instance
            .request_adapter(&wgpu::RequestAdapterOptions::default())
            .await
            .expect("Failed to find adapter");
        let (device, queue) = adapter
            .request_device(&wgpu::DeviceDescriptor::default())
            .await
            .expect("Failed to create device");

        let mut pool = TexturePool::new(device, queue).with_max_pool_size(2);

        let desc = TexturePool::rgba_output_descriptor(1920, 1080);

        // Create and drop multiple textures
        for _ in 0..5 {
            let texture = pool.get_texture(&desc);
            drop(texture);
        }

        // Should only keep max_pool_size textures
        assert!(pool.stats().total_available <= 2);
    }
}
