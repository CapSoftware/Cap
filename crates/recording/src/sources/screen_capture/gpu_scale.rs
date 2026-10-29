use ::windows::Win32::Graphics::Direct3D11::{
    D3D11_CPU_ACCESS_READ, D3D11_MAP_READ, D3D11_MAPPED_SUBRESOURCE, D3D11_TEXTURE2D_DESC,
    D3D11_USAGE_STAGING, D3D11_VIDEO_PROCESSOR_CONTENT_DESC, D3D11_VIDEO_PROCESSOR_INPUT_VIEW_DESC,
    D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC, D3D11_VIDEO_PROCESSOR_STREAM,
    D3D11_VPIV_DIMENSION_TEXTURE2D, D3D11_VPOV_DIMENSION_TEXTURE2D, ID3D11Device,
    ID3D11DeviceContext, ID3D11Texture2D, ID3D11VideoContext, ID3D11VideoDevice,
    ID3D11VideoProcessor, ID3D11VideoProcessorEnumerator, ID3D11VideoProcessorInputView,
    ID3D11VideoProcessorOutputView,
};
use ::windows::Win32::Graphics::Dxgi::Common::{
    DXGI_FORMAT, DXGI_FORMAT_B8G8R8A8_UNORM, DXGI_FORMAT_R8G8B8A8_UNORM,
};
use ::windows::core::Interface;
use scap_direct3d::PixelFormat;
use std::mem::ManuallyDrop;
use std::ptr;

pub struct GpuTextureScaler {
    context: ID3D11DeviceContext,
    video_device: ID3D11VideoDevice,
    video_context: ID3D11VideoContext,
    processor: ID3D11VideoProcessor,
    enumerator: ID3D11VideoProcessorEnumerator,
    output_texture: ID3D11Texture2D,
    staging_output: ID3D11Texture2D,
    pixel_format: PixelFormat,
    src_width: u32,
    src_height: u32,
    dst_width: u32,
    dst_height: u32,
    row_bytes: usize,
    pixel_data: Vec<u8>,
}

impl GpuTextureScaler {
    pub fn try_new(
        device: &ID3D11Device,
        pixel_format: PixelFormat,
        src_width: u32,
        src_height: u32,
        dst_width: u32,
        dst_height: u32,
    ) -> Option<Self> {
        if src_width == 0 || src_height == 0 || dst_width == 0 || dst_height == 0 {
            return None;
        }

        let context = unsafe { device.GetImmediateContext().ok()? };
        let video_device: ID3D11VideoDevice = device.cast().ok()?;
        let video_context: ID3D11VideoContext = context.cast().ok()?;

        let content_desc = D3D11_VIDEO_PROCESSOR_CONTENT_DESC {
            InputFrameFormat:
                ::windows::Win32::Graphics::Direct3D11::D3D11_VIDEO_FRAME_FORMAT_PROGRESSIVE,
            InputFrameRate: ::windows::Win32::Graphics::Dxgi::Common::DXGI_RATIONAL {
                Numerator: 30,
                Denominator: 1,
            },
            InputWidth: src_width,
            InputHeight: src_height,
            OutputFrameRate: ::windows::Win32::Graphics::Dxgi::Common::DXGI_RATIONAL {
                Numerator: 30,
                Denominator: 1,
            },
            OutputWidth: dst_width,
            OutputHeight: dst_height,
            Usage: ::windows::Win32::Graphics::Direct3D11::D3D11_VIDEO_USAGE_PLAYBACK_NORMAL,
        };

        let enumerator = unsafe {
            video_device
                .CreateVideoProcessorEnumerator(&content_desc)
                .ok()?
        };
        let processor = unsafe { video_device.CreateVideoProcessor(&enumerator, 0).ok()? };

        let dxgi_format = pixel_format_to_dxgi(pixel_format);
        let output_texture = create_default_texture(device, dst_width, dst_height, dxgi_format)?;
        let staging_output = create_staging_texture(device, dst_width, dst_height, dxgi_format)?;

        let row_bytes = (dst_width * 4) as usize;
        let pixel_data = vec![0u8; row_bytes * dst_height as usize];

        Some(Self {
            context,
            video_device,
            video_context,
            processor,
            enumerator,
            output_texture,
            staging_output,
            pixel_format,
            src_width,
            src_height,
            dst_width,
            dst_height,
            row_bytes,
            pixel_data,
        })
    }

    pub fn scale_texture(&mut self, input: &ID3D11Texture2D) -> Option<&[u8]> {
        let input_view_desc = D3D11_VIDEO_PROCESSOR_INPUT_VIEW_DESC {
            FourCC: 0,
            ViewDimension: D3D11_VPIV_DIMENSION_TEXTURE2D,
            Anonymous:
                ::windows::Win32::Graphics::Direct3D11::D3D11_VIDEO_PROCESSOR_INPUT_VIEW_DESC_0 {
                    Texture2D: ::windows::Win32::Graphics::Direct3D11::D3D11_TEX2D_VPIV {
                        MipSlice: 0,
                        ArraySlice: 0,
                    },
                },
        };

        let mut input_view: Option<ID3D11VideoProcessorInputView> = None;
        unsafe {
            self.video_device
                .CreateVideoProcessorInputView(
                    input,
                    &self.enumerator,
                    &input_view_desc,
                    Some(&mut input_view),
                )
                .ok()?;
        }
        let input_view = input_view?;

        let output_view_desc = D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC {
            ViewDimension: D3D11_VPOV_DIMENSION_TEXTURE2D,
            Anonymous:
                ::windows::Win32::Graphics::Direct3D11::D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC_0 {
                    Texture2D: ::windows::Win32::Graphics::Direct3D11::D3D11_TEX2D_VPOV {
                        MipSlice: 0,
                    },
                },
        };

        let mut output_view: Option<ID3D11VideoProcessorOutputView> = None;
        unsafe {
            self.video_device
                .CreateVideoProcessorOutputView(
                    &self.output_texture,
                    &self.enumerator,
                    &output_view_desc,
                    Some(&mut output_view),
                )
                .ok()?;
        }
        let output_view = output_view?;

        let stream = D3D11_VIDEO_PROCESSOR_STREAM {
            Enable: true.into(),
            OutputIndex: 0,
            InputFrameOrField: 0,
            PastFrames: 0,
            FutureFrames: 0,
            ppPastSurfaces: ptr::null_mut(),
            pInputSurface: unsafe { std::mem::transmute_copy(&input_view) },
            ppFutureSurfaces: ptr::null_mut(),
            ppPastSurfacesRight: ptr::null_mut(),
            pInputSurfaceRight: ManuallyDrop::new(None),
            ppFutureSurfacesRight: ptr::null_mut(),
        };

        unsafe {
            self.video_context
                .VideoProcessorBlt(&self.processor, &output_view, 0, &[stream])
                .ok()?;

            self.context
                .CopyResource(&self.staging_output, &self.output_texture);

            let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
            self.context
                .Map(
                    &self.staging_output,
                    0,
                    D3D11_MAP_READ,
                    0,
                    Some(&mut mapped),
                )
                .ok()?;

            let src_ptr = mapped.pData as *const u8;
            let src_stride = mapped.RowPitch as usize;
            for row in 0..self.dst_height as usize {
                let src_start = row * src_stride;
                let dst_start = row * self.row_bytes;
                std::ptr::copy_nonoverlapping(
                    src_ptr.add(src_start),
                    self.pixel_data.as_mut_ptr().add(dst_start),
                    self.row_bytes,
                );
            }

            self.context.Unmap(&self.staging_output, 0);
        }

        Some(self.pixel_data.as_slice())
    }

    pub fn dimensions(&self) -> (u32, u32, PixelFormat) {
        (self.dst_width, self.dst_height, self.pixel_format)
    }

    pub fn pixel_data_for_frame(&self) -> &[u8] {
        &self.pixel_data
    }
}

fn pixel_format_to_dxgi(pixel_format: PixelFormat) -> DXGI_FORMAT {
    match pixel_format {
        PixelFormat::R8G8B8A8Unorm => DXGI_FORMAT_R8G8B8A8_UNORM,
        PixelFormat::B8G8R8A8Unorm => DXGI_FORMAT_B8G8R8A8_UNORM,
    }
}

fn create_default_texture(
    device: &ID3D11Device,
    width: u32,
    height: u32,
    format: DXGI_FORMAT,
) -> Option<ID3D11Texture2D> {
    let desc = D3D11_TEXTURE2D_DESC {
        Width: width,
        Height: height,
        MipLevels: 1,
        ArraySize: 1,
        Format: format,
        SampleDesc: ::windows::Win32::Graphics::Dxgi::Common::DXGI_SAMPLE_DESC {
            Count: 1,
            Quality: 0,
        },
        Usage: ::windows::Win32::Graphics::Direct3D11::D3D11_USAGE_DEFAULT,
        BindFlags: ::windows::Win32::Graphics::Direct3D11::D3D11_BIND_RENDER_TARGET.0 as u32,
        CPUAccessFlags: 0,
        MiscFlags: 0,
    };
    unsafe {
        let mut texture = None;
        device
            .CreateTexture2D(&desc, None, Some(&mut texture))
            .ok()?;
        texture
    }
}

fn create_staging_texture(
    device: &ID3D11Device,
    width: u32,
    height: u32,
    format: DXGI_FORMAT,
) -> Option<ID3D11Texture2D> {
    let desc = D3D11_TEXTURE2D_DESC {
        Width: width,
        Height: height,
        MipLevels: 1,
        ArraySize: 1,
        Format: format,
        SampleDesc: ::windows::Win32::Graphics::Dxgi::Common::DXGI_SAMPLE_DESC {
            Count: 1,
            Quality: 0,
        },
        Usage: D3D11_USAGE_STAGING,
        BindFlags: 0,
        CPUAccessFlags: D3D11_CPU_ACCESS_READ.0 as u32,
        MiscFlags: 0,
    };
    unsafe {
        let mut texture = None;
        device
            .CreateTexture2D(&desc, None, Some(&mut texture))
            .ok()?;
        texture
    }
}
