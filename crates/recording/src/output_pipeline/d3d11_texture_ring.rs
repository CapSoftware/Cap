use super::texture_slots::{TEXTURE_RING_CAPACITY, TextureSlots};
use cap_enc_ffmpeg::D3d11TextureLifetime;
use std::ffi::c_void;
use std::sync::Arc;
use windows::Win32::Graphics::Direct3D11::{
    D3D11_BIND_RENDER_TARGET, D3D11_BIND_SHADER_RESOURCE, D3D11_TEXTURE2D_DESC,
    D3D11_USAGE_DEFAULT, ID3D11Device, ID3D11DeviceContext, ID3D11Texture2D,
};
use windows::Win32::Graphics::Dxgi::Common::{DXGI_FORMAT_R8G8B8A8_UNORM, DXGI_SAMPLE_DESC};
use windows::core::Interface;

struct SlotRelease {
    slots: Arc<TextureSlots>,
    slot: u32,
}

unsafe extern "C" fn release_slot(data: *mut c_void) {
    let release = unsafe { Box::from_raw(data as *mut SlotRelease) };
    release.slots.release(release.slot);
}

pub(crate) struct PreparedTexture {
    ptr: *mut c_void,
    lifetime: Option<D3d11TextureLifetime>,
}

impl PreparedTexture {
    pub(crate) fn into_submit(mut self) -> Option<(*mut c_void, D3d11TextureLifetime)> {
        let lifetime = self.lifetime.take()?;
        let ptr = self.ptr;
        std::mem::forget(self);
        Some((ptr, lifetime))
    }
}

impl Drop for PreparedTexture {
    fn drop(&mut self) {
        if let Some(lifetime) = self.lifetime.take() {
            unsafe { (lifetime.free)(lifetime.data) };
        }
    }
}

pub(crate) struct GpuTextureRing {
    device: ID3D11Device,
    context: ID3D11DeviceContext,
    textures: Vec<ID3D11Texture2D>,
    slots: Arc<TextureSlots>,
    last: Option<u32>,
    width: u32,
    height: u32,
    unusable: bool,
}

impl GpuTextureRing {
    pub(crate) fn new(device: ID3D11Device) -> Option<Self> {
        let context = unsafe { device.GetImmediateContext() }.ok()?;
        Some(Self {
            device,
            context,
            textures: Vec::new(),
            slots: Arc::new(TextureSlots::new()),
            last: None,
            width: 0,
            height: 0,
            unusable: false,
        })
    }

    pub(crate) fn is_unusable(&self) -> bool {
        self.unusable
    }

    pub(crate) fn copy_from(
        &mut self,
        src: &ID3D11Texture2D,
        width: u32,
        height: u32,
    ) -> Option<PreparedTexture> {
        if self.unusable
            || width == 0
            || height == 0
            || !width.is_multiple_of(2)
            || !height.is_multiple_of(2)
        {
            self.unusable = true;
            return None;
        }
        let mut desc = D3D11_TEXTURE2D_DESC::default();
        unsafe { src.GetDesc(&mut desc) };
        if desc.Format != DXGI_FORMAT_R8G8B8A8_UNORM || desc.Width != width || desc.Height != height
        {
            self.unusable = true;
            return None;
        }
        if self.width != 0 && (self.width != width || self.height != height) {
            self.unusable = true;
            return None;
        }
        if self.textures.is_empty() && self.allocate(width, height).is_none() {
            self.unusable = true;
            return None;
        }
        let slot = self.slots.try_acquire()?;
        let dest = self.textures.get(slot as usize)?;
        unsafe {
            self.context.CopyResource(dest, src);
            self.context.Flush();
        }
        if unsafe { self.device.GetDeviceRemovedReason() }.is_err() {
            self.unusable = true;
            return None;
        }
        self.slots.hold(slot);
        self.last = Some(slot);
        Some(self.prepared(slot, dest))
    }

    pub(crate) fn repeat_last(&mut self) -> Option<PreparedTexture> {
        let slot = self.last?;
        let texture = self.textures.get(slot as usize)?;
        self.slots.hold(slot);
        Some(self.prepared(slot, texture))
    }

    fn allocate(&mut self, width: u32, height: u32) -> Option<()> {
        let desc = D3D11_TEXTURE2D_DESC {
            Width: width,
            Height: height,
            MipLevels: 1,
            ArraySize: 1,
            Format: DXGI_FORMAT_R8G8B8A8_UNORM,
            SampleDesc: DXGI_SAMPLE_DESC {
                Count: 1,
                Quality: 0,
            },
            Usage: D3D11_USAGE_DEFAULT,
            BindFlags: (D3D11_BIND_SHADER_RESOURCE.0 | D3D11_BIND_RENDER_TARGET.0) as u32,
            CPUAccessFlags: 0,
            MiscFlags: 0,
        };
        let mut textures = Vec::with_capacity(TEXTURE_RING_CAPACITY as usize);
        for _ in 0..TEXTURE_RING_CAPACITY {
            let mut texture = None;
            unsafe {
                self.device
                    .CreateTexture2D(&desc, None, Some(&mut texture))
                    .ok()?;
            }
            textures.push(texture?);
        }
        self.textures = textures;
        self.width = width;
        self.height = height;
        Some(())
    }

    fn prepared(&self, slot: u32, texture: &ID3D11Texture2D) -> PreparedTexture {
        let release = Box::new(SlotRelease {
            slots: Arc::clone(&self.slots),
            slot,
        });
        PreparedTexture {
            ptr: texture.as_raw(),
            lifetime: Some(D3d11TextureLifetime {
                data: Box::into_raw(release) as *mut c_void,
                free: release_slot,
            }),
        }
    }
}
