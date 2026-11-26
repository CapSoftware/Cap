use std::ffi::c_void;
use std::mem::ManuallyDrop;
use std::sync::Arc;

use cap_enc_ffmpeg::D3d11TextureLifetime;
use cap_enc_ffmpeg::capture_texel_feeds_nv12;
use windows::Win32::Graphics::Direct3D11::{
    D3D11_BIND_RENDER_TARGET, D3D11_BIND_VIDEO_ENCODER, D3D11_TEX2D_VPIV, D3D11_TEX2D_VPOV,
    D3D11_TEXTURE2D_DESC, D3D11_USAGE_DEFAULT, D3D11_VIDEO_FRAME_FORMAT_PROGRESSIVE,
    D3D11_VIDEO_PROCESSOR_COLOR_SPACE, D3D11_VIDEO_PROCESSOR_CONTENT_DESC,
    D3D11_VIDEO_PROCESSOR_INPUT_VIEW_DESC, D3D11_VIDEO_PROCESSOR_INPUT_VIEW_DESC_0,
    D3D11_VIDEO_PROCESSOR_NOMINAL_RANGE_0_255, D3D11_VIDEO_PROCESSOR_NOMINAL_RANGE_16_235,
    D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC, D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC_0,
    D3D11_VIDEO_PROCESSOR_STREAM, D3D11_VIDEO_USAGE_OPTIMAL_QUALITY,
    D3D11_VPIV_DIMENSION_TEXTURE2D, D3D11_VPOV_DIMENSION_TEXTURE2D, ID3D11Device,
    ID3D11DeviceContext, ID3D11Texture2D, ID3D11VideoContext, ID3D11VideoContext1,
    ID3D11VideoDevice, ID3D11VideoProcessor, ID3D11VideoProcessorEnumerator,
    ID3D11VideoProcessorOutputView,
};
use windows::Win32::Graphics::Dxgi::Common::{
    DXGI_COLOR_SPACE_RGB_FULL_G22_NONE_P709, DXGI_COLOR_SPACE_YCBCR_STUDIO_G22_LEFT_P709,
    DXGI_FORMAT, DXGI_FORMAT_B8G8R8A8_UNORM, DXGI_FORMAT_NV12, DXGI_FORMAT_R8G8B8A8_UNORM,
    DXGI_RATIONAL, DXGI_SAMPLE_DESC,
};
use windows::core::Interface;

use super::texture_slots::{TEXTURE_RING_CAPACITY, TextureSlots};

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

struct Nv12Converter {
    video_device: ID3D11VideoDevice,
    video_context: ID3D11VideoContext,
    enumerator: ID3D11VideoProcessorEnumerator,
    processor: ID3D11VideoProcessor,
    output_views: Vec<ID3D11VideoProcessorOutputView>,
    input_format: DXGI_FORMAT,
}

impl Nv12Converter {
    fn new(
        device: &ID3D11Device,
        context: &ID3D11DeviceContext,
        textures: &[ID3D11Texture2D],
        width: u32,
        height: u32,
        input_format: DXGI_FORMAT,
    ) -> Result<Self, String> {
        let video_device: ID3D11VideoDevice = device
            .cast()
            .map_err(|error| format!("video device: {error}"))?;
        let video_context: ID3D11VideoContext = context
            .cast()
            .map_err(|error| format!("video context: {error}"))?;
        let desc = D3D11_VIDEO_PROCESSOR_CONTENT_DESC {
            InputFrameFormat: D3D11_VIDEO_FRAME_FORMAT_PROGRESSIVE,
            InputFrameRate: DXGI_RATIONAL {
                Numerator: 60,
                Denominator: 1,
            },
            InputWidth: width,
            InputHeight: height,
            OutputFrameRate: DXGI_RATIONAL {
                Numerator: 60,
                Denominator: 1,
            },
            OutputWidth: width,
            OutputHeight: height,
            Usage: D3D11_VIDEO_USAGE_OPTIMAL_QUALITY,
        };
        let enumerator = unsafe { video_device.CreateVideoProcessorEnumerator(&desc) }
            .map_err(|error| format!("video processor enumerator: {error}"))?;
        let processor = unsafe { video_device.CreateVideoProcessor(&enumerator, 0) }
            .map_err(|error| format!("video processor: {error}"))?;
        set_studio_bt709(&video_context, &processor);
        let view_desc = D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC {
            ViewDimension: D3D11_VPOV_DIMENSION_TEXTURE2D,
            Anonymous: D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC_0 {
                Texture2D: D3D11_TEX2D_VPOV { MipSlice: 0 },
            },
        };
        let mut output_views = Vec::with_capacity(textures.len());
        for texture in textures {
            let mut view = None;
            unsafe {
                video_device
                    .CreateVideoProcessorOutputView(
                        texture,
                        &enumerator,
                        &view_desc,
                        Some(&mut view),
                    )
                    .map_err(|error| format!("NV12 output view: {error}"))?;
            }
            output_views.push(view.ok_or_else(|| "NV12 output view missing".to_string())?);
        }
        Ok(Self {
            video_device,
            video_context,
            enumerator,
            processor,
            output_views,
            input_format,
        })
    }

    fn blit(&self, src: &ID3D11Texture2D, slot: u32) -> Result<(), String> {
        let input_desc = D3D11_VIDEO_PROCESSOR_INPUT_VIEW_DESC {
            ViewDimension: D3D11_VPIV_DIMENSION_TEXTURE2D,
            Anonymous: D3D11_VIDEO_PROCESSOR_INPUT_VIEW_DESC_0 {
                Texture2D: D3D11_TEX2D_VPIV {
                    MipSlice: 0,
                    ..Default::default()
                },
            },
            ..Default::default()
        };
        let mut input = None;
        unsafe {
            self.video_device
                .CreateVideoProcessorInputView(src, &self.enumerator, &input_desc, Some(&mut input))
                .map_err(|error| format!("video processor input: {error}"))?;
        }
        let input = input.ok_or_else(|| "video processor input missing".to_string())?;
        let output = self
            .output_views
            .get(slot as usize)
            .ok_or_else(|| "NV12 output view missing".to_string())?;
        let mut stream = D3D11_VIDEO_PROCESSOR_STREAM {
            Enable: true.into(),
            OutputIndex: 0,
            InputFrameOrField: 0,
            pInputSurface: ManuallyDrop::new(Some(input)),
            ..Default::default()
        };
        let result = unsafe {
            self.video_context.VideoProcessorBlt(
                &self.processor,
                output,
                0,
                std::slice::from_ref(&stream),
            )
        };
        unsafe { ManuallyDrop::drop(&mut stream.pInputSurface) };
        result.map_err(|error| format!("video processor blit: {error}"))
    }
}

fn set_studio_bt709(context: &ID3D11VideoContext, processor: &ID3D11VideoProcessor) {
    if let Ok(context1) = context.cast::<ID3D11VideoContext1>() {
        unsafe {
            context1.VideoProcessorSetStreamColorSpace1(
                processor,
                0,
                DXGI_COLOR_SPACE_RGB_FULL_G22_NONE_P709,
            );
            context1.VideoProcessorSetOutputColorSpace1(
                processor,
                DXGI_COLOR_SPACE_YCBCR_STUDIO_G22_LEFT_P709,
            );
        }
        return;
    }
    let bt709 = 1u32 << 2;
    let full = (D3D11_VIDEO_PROCESSOR_NOMINAL_RANGE_0_255.0 as u32) << 4;
    let limited_rgb = 1u32 << 1;
    let studio = (D3D11_VIDEO_PROCESSOR_NOMINAL_RANGE_16_235.0 as u32) << 4;
    let input = D3D11_VIDEO_PROCESSOR_COLOR_SPACE {
        _bitfield: bt709 | full,
    };
    let output = D3D11_VIDEO_PROCESSOR_COLOR_SPACE {
        _bitfield: limited_rgb | bt709 | studio,
    };
    unsafe {
        context.VideoProcessorSetStreamColorSpace(processor, 0, &input);
        context.VideoProcessorSetOutputColorSpace(processor, &output);
    }
}

fn texel_name(format: DXGI_FORMAT) -> &'static str {
    if format == DXGI_FORMAT_R8G8B8A8_UNORM {
        "rgba"
    } else if format == DXGI_FORMAT_B8G8R8A8_UNORM {
        "bgra"
    } else if format == DXGI_FORMAT_NV12 {
        "nv12"
    } else {
        "other"
    }
}

pub struct GpuTextureRing {
    device: ID3D11Device,
    context: ID3D11DeviceContext,
    textures: Vec<ID3D11Texture2D>,
    converter: Option<Nv12Converter>,
    slots: Arc<TextureSlots>,
    last: Option<u32>,
    width: u32,
    height: u32,
    unusable: bool,
    refusal: Option<String>,
}

impl GpuTextureRing {
    pub fn new(device: ID3D11Device) -> Option<Self> {
        let context = unsafe { device.GetImmediateContext() }.ok()?;
        Some(Self {
            device,
            context,
            textures: Vec::new(),
            converter: None,
            slots: Arc::new(TextureSlots::new()),
            last: None,
            width: 0,
            height: 0,
            unusable: false,
            refusal: None,
        })
    }

    pub(crate) fn is_unusable(&self) -> bool {
        self.unusable
    }

    pub fn capacity(&self) -> u32 {
        TEXTURE_RING_CAPACITY
    }

    pub fn high_water(&self) -> u32 {
        self.slots.high_water()
    }

    pub fn refusal(&self) -> &str {
        self.refusal
            .as_deref()
            .unwrap_or("D3D11 texture path refused")
    }

    pub fn submit_from(
        &mut self,
        src: &ID3D11Texture2D,
        width: u32,
        height: u32,
    ) -> Option<(*mut c_void, D3d11TextureLifetime)> {
        self.copy_from(src, width, height)?.into_submit()
    }

    pub fn resubmit_last(&mut self) -> Option<(*mut c_void, D3d11TextureLifetime)> {
        self.repeat_last()?.into_submit()
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
            self.refuse("odd or zero size");
            return None;
        }
        let mut desc = D3D11_TEXTURE2D_DESC::default();
        unsafe { src.GetDesc(&mut desc) };
        let texel = texel_name(desc.Format);
        if !capture_texel_feeds_nv12(texel) || desc.Width != width || desc.Height != height {
            self.refuse(format!("capture format {texel} cannot feed NV12"));
            return None;
        }
        if self.width != 0 && (self.width != width || self.height != height) {
            self.refuse("size changed");
            return None;
        }
        if self.textures.is_empty()
            && let Err(error) = self.allocate(width, height)
        {
            self.refuse(error);
            return None;
        }
        let Some(slot) = self.slots.try_acquire() else {
            self.refusal = Some("texture ring full".to_string());
            return None;
        };
        if self.textures.get(slot as usize).is_none() {
            self.refuse("texture slot missing");
            return None;
        }
        let converted = if texel == "nv12" {
            let dest = &self.textures[slot as usize];
            unsafe { self.context.CopyResource(dest, src) };
            Ok(())
        } else {
            self.convert(src, desc.Format, slot)
        };
        if let Err(error) = converted {
            self.refuse(error);
            return None;
        }
        unsafe { self.context.Flush() };
        if unsafe { self.device.GetDeviceRemovedReason() }.is_err() {
            self.refuse("device removed");
            return None;
        }
        self.slots.hold(slot);
        self.last = Some(slot);
        self.refusal = None;
        let dest = self.textures[slot as usize].clone();
        Some(self.prepared(slot, &dest))
    }

    fn convert(
        &mut self,
        src: &ID3D11Texture2D,
        format: DXGI_FORMAT,
        slot: u32,
    ) -> Result<(), String> {
        self.ensure_converter(format)?;
        match self.converter.as_ref() {
            Some(converter) => converter.blit(src, slot),
            None => Err("NV12 converter missing".to_string()),
        }
    }

    pub(crate) fn repeat_last(&mut self) -> Option<PreparedTexture> {
        let slot = self.last?;
        let texture = self.textures.get(slot as usize)?;
        self.slots.hold(slot);
        Some(self.prepared(slot, texture))
    }

    fn refuse(&mut self, reason: impl Into<String>) {
        self.unusable = true;
        self.refusal = Some(reason.into());
    }

    fn ensure_converter(&mut self, format: DXGI_FORMAT) -> Result<(), String> {
        if self
            .converter
            .as_ref()
            .is_some_and(|converter| converter.input_format == format)
        {
            return Ok(());
        }
        let converter = Nv12Converter::new(
            &self.device,
            &self.context,
            &self.textures,
            self.width,
            self.height,
            format,
        )?;
        self.converter = Some(converter);
        Ok(())
    }

    fn allocate(&mut self, width: u32, height: u32) -> Result<(), String> {
        let binds = [
            (D3D11_BIND_RENDER_TARGET.0 | D3D11_BIND_VIDEO_ENCODER.0) as u32,
            D3D11_BIND_RENDER_TARGET.0 as u32,
        ];
        let mut last = "NV12 texture allocation failed".to_string();
        for bind in binds {
            match create_textures(&self.device, width, height, bind) {
                Ok(textures) => {
                    self.textures = textures;
                    self.width = width;
                    self.height = height;
                    return Ok(());
                }
                Err(error) => last = error,
            }
        }
        Err(last)
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

fn create_textures(
    device: &ID3D11Device,
    width: u32,
    height: u32,
    bind_flags: u32,
) -> Result<Vec<ID3D11Texture2D>, String> {
    let desc = D3D11_TEXTURE2D_DESC {
        Width: width,
        Height: height,
        MipLevels: 1,
        ArraySize: 1,
        Format: DXGI_FORMAT_NV12,
        SampleDesc: DXGI_SAMPLE_DESC {
            Count: 1,
            Quality: 0,
        },
        Usage: D3D11_USAGE_DEFAULT,
        BindFlags: bind_flags,
        CPUAccessFlags: 0,
        MiscFlags: 0,
    };
    let mut textures = Vec::with_capacity(TEXTURE_RING_CAPACITY as usize);
    for _ in 0..TEXTURE_RING_CAPACITY {
        let mut texture = None;
        unsafe {
            device
                .CreateTexture2D(&desc, None, Some(&mut texture))
                .map_err(|error| format!("NV12 texture: {error}"))?;
        }
        textures.push(texture.ok_or_else(|| "NV12 texture missing".to_string())?);
    }
    Ok(textures)
}
