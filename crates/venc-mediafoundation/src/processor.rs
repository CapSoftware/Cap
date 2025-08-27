use windows::{
    Graphics::{RectInt32, SizeInt32},
    Win32::{
        Foundation::RECT,
        Graphics::{
            Direct3D11::{
                D3D11_BIND_RENDER_TARGET, D3D11_BIND_SHADER_RESOURCE, D3D11_BIND_VIDEO_ENCODER,
                D3D11_TEX2D_VPIV, D3D11_TEX2D_VPOV, D3D11_TEXTURE2D_DESC, D3D11_USAGE_DEFAULT,
                D3D11_VIDEO_FRAME_FORMAT_PROGRESSIVE, D3D11_VIDEO_PROCESSOR_COLOR_SPACE,
                D3D11_VIDEO_PROCESSOR_CONTENT_DESC, D3D11_VIDEO_PROCESSOR_INPUT_VIEW_DESC,
                D3D11_VIDEO_PROCESSOR_INPUT_VIEW_DESC_0, D3D11_VIDEO_PROCESSOR_NOMINAL_RANGE_0_255,
                D3D11_VIDEO_PROCESSOR_NOMINAL_RANGE_16_235, D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC,
                D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC_0, D3D11_VIDEO_PROCESSOR_STREAM,
                D3D11_VIDEO_USAGE_OPTIMAL_QUALITY, D3D11_VPIV_DIMENSION_TEXTURE2D,
                D3D11_VPOV_DIMENSION_TEXTURE2D, ID3D11Device, ID3D11DeviceContext, ID3D11Texture2D,
                ID3D11VideoContext, ID3D11VideoDevice, ID3D11VideoProcessor,
                ID3D11VideoProcessorInputView, ID3D11VideoProcessorOutputView,
            },
            Dxgi::Common::{DXGI_FORMAT, DXGI_RATIONAL, DXGI_SAMPLE_DESC},
        },
    },
    core::{Interface, Result},
};
use windows_numerics::Vector2;

pub struct VideoProcessor {
    _d3d_device: ID3D11Device,
    d3d_context: ID3D11DeviceContext,

    _video_device: ID3D11VideoDevice,
    video_context: ID3D11VideoContext,
    video_processor: ID3D11VideoProcessor,
    video_output_texture: ID3D11Texture2D,
    video_output: ID3D11VideoProcessorOutputView,
    video_input_texture: ID3D11Texture2D,
    video_input: ID3D11VideoProcessorInputView,
}

impl VideoProcessor {
    pub fn new(
        d3d_device: ID3D11Device,
        input_format: DXGI_FORMAT,
        input_size: SizeInt32,
        output_format: DXGI_FORMAT,
        output_size: SizeInt32,
    ) -> Result<Self> {
        let d3d_context = unsafe { d3d_device.GetImmediateContext()? };

        // Setup video conversion
        let video_device: ID3D11VideoDevice = d3d_device.cast()?;
        let video_context: ID3D11VideoContext = d3d_context.cast()?;

        let video_desc = D3D11_VIDEO_PROCESSOR_CONTENT_DESC {
            InputFrameFormat: D3D11_VIDEO_FRAME_FORMAT_PROGRESSIVE,
            InputFrameRate: DXGI_RATIONAL {
                Numerator: 60,
                Denominator: 1,
            },
            InputWidth: input_size.Width as u32,
            InputHeight: input_size.Height as u32,
            OutputFrameRate: DXGI_RATIONAL {
                Numerator: 60,
                Denominator: 1,
            },
            OutputWidth: input_size.Width as u32,
            OutputHeight: input_size.Height as u32,
            Usage: D3D11_VIDEO_USAGE_OPTIMAL_QUALITY,
        };
        let video_enum = unsafe { video_device.CreateVideoProcessorEnumerator(&video_desc)? };

        let video_processor = unsafe { video_device.CreateVideoProcessor(&video_enum, 0)? };

        let mut color_space = D3D11_VIDEO_PROCESSOR_COLOR_SPACE {
            _bitfield: 1 | (D3D11_VIDEO_PROCESSOR_NOMINAL_RANGE_16_235.0 as u32) << 4, // Usage: 1 (Video processing), Nominal_Range: D3D11_VIDEO_PROCESSOR_NOMINAL_RANGE_16_235
        };
        unsafe { video_context.VideoProcessorSetOutputColorSpace(&video_processor, &color_space) };
        color_space._bitfield = 1 | (D3D11_VIDEO_PROCESSOR_NOMINAL_RANGE_0_255.0 as u32) << 4; // Usage: 1 (Video processing), Nominal_Range: D3D11_VIDEO_PROCESSOR_NOMINAL_RANGE_0_255
        unsafe {
            video_context.VideoProcessorSetStreamColorSpace(&video_processor, 0, &color_space)
        };

        // If the input and output resolutions don't match, setup the
        // video processor to preserve the aspect ratio when scaling.
        if input_size.Width != output_size.Width || input_size.Height != output_size.Height {
            let dest_rect = compute_dest_rect(&output_size, &input_size);
            let rect = RECT {
                left: dest_rect.X,
                top: dest_rect.Y,
                right: dest_rect.X + dest_rect.Width,
                bottom: dest_rect.Y + dest_rect.Height,
            };
            unsafe {
                video_context.VideoProcessorSetStreamDestRect(
                    &video_processor,
                    0,
                    true,
                    Some(&rect),
                )
            };
        }

        let mut texture_desc = D3D11_TEXTURE2D_DESC {
            Width: output_size.Width as u32,
            Height: output_size.Height as u32,
            ArraySize: 1,
            MipLevels: 1,
            Format: output_format,
            SampleDesc: DXGI_SAMPLE_DESC {
                Count: 1,
                ..Default::default()
            },
            Usage: D3D11_USAGE_DEFAULT,
            BindFlags: (D3D11_BIND_RENDER_TARGET.0 | D3D11_BIND_VIDEO_ENCODER.0) as u32,
            ..Default::default()
        };
        let video_output_texture = unsafe {
            let mut texture = None;
            d3d_device.CreateTexture2D(&texture_desc, None, Some(&mut texture))?;
            texture.unwrap()
        };

        let output_view_desc = D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC {
            ViewDimension: D3D11_VPOV_DIMENSION_TEXTURE2D,
            Anonymous: D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC_0 {
                Texture2D: D3D11_TEX2D_VPOV { MipSlice: 0 },
            },
        };
        let video_output = unsafe {
            let mut output = None;
            video_device.CreateVideoProcessorOutputView(
                &video_output_texture,
                &video_enum,
                &output_view_desc,
                Some(&mut output),
            )?;
            output.unwrap()
        };

        texture_desc.Width = input_size.Width as u32;
        texture_desc.Height = input_size.Height as u32;
        texture_desc.Format = input_format;
        texture_desc.BindFlags = (D3D11_BIND_RENDER_TARGET.0 | D3D11_BIND_SHADER_RESOURCE.0) as u32;
        let video_input_texture = unsafe {
            let mut texture = None;
            d3d_device.CreateTexture2D(&texture_desc, None, Some(&mut texture))?;
            texture.unwrap()
        };

        let input_view_desc = D3D11_VIDEO_PROCESSOR_INPUT_VIEW_DESC {
            ViewDimension: D3D11_VPIV_DIMENSION_TEXTURE2D,
            Anonymous: D3D11_VIDEO_PROCESSOR_INPUT_VIEW_DESC_0 {
                Texture2D: D3D11_TEX2D_VPIV {
                    MipSlice: 0,
                    ..Default::default()
                },
            },
            ..Default::default()
        };
        let video_input = unsafe {
            let mut input = None;
            video_device.CreateVideoProcessorInputView(
                &video_input_texture,
                &video_enum,
                &input_view_desc,
                Some(&mut input),
            )?;
            input.unwrap()
        };

        Ok(Self {
            _d3d_device: d3d_device,
            d3d_context,

            _video_device: video_device,
            video_context,
            video_processor,
            video_output_texture,
            video_output,
            video_input_texture,
            video_input,
        })
    }

    pub fn output_texture(&self) -> &ID3D11Texture2D {
        &self.video_output_texture
    }

    pub fn process_texture(&mut self, input_texture: &ID3D11Texture2D) -> Result<()> {
        // The caller is responsible for making sure they give us a
        // texture that matches the input size we were initialized with.

        unsafe {
            // Copy the texture to the video input texture
            self.d3d_context
                .CopyResource(&self.video_input_texture, input_texture);

            // Convert to NV12
            let video_stream = D3D11_VIDEO_PROCESSOR_STREAM {
                Enable: true.into(),
                OutputIndex: 0,
                InputFrameOrField: 0,
                pInputSurface: std::mem::transmute_copy(&self.video_input),
                ..Default::default()
            };
            self.video_context.VideoProcessorBlt(
                &self.video_processor,
                &self.video_output,
                0,
                &[video_stream],
            )
        }
    }
}

fn compute_scale_factor(output_size: Vector2, input_size: Vector2) -> f32 {
    let output_ratio = output_size.X / output_size.Y;
    let input_ratio = input_size.X / input_size.Y;

    let mut scale_factor = output_size.X / input_size.X;
    if output_ratio > input_ratio {
        scale_factor = output_size.Y / input_size.Y;
    }

    scale_factor
}

fn compute_dest_rect(output_size: &SizeInt32, input_size: &SizeInt32) -> RectInt32 {
    let scale = compute_scale_factor(
        Vector2 {
            X: output_size.Width as f32,
            Y: output_size.Height as f32,
        },
        Vector2 {
            X: input_size.Width as f32,
            Y: input_size.Height as f32,
        },
    );
    let new_size = SizeInt32 {
        Width: (input_size.Width as f32 * scale) as i32,
        Height: (input_size.Height as f32 * scale) as i32,
    };
    let mut offset_x = 0;
    let mut offset_y = 0;
    if new_size.Width != output_size.Width {
        offset_x = (output_size.Width - new_size.Width) / 2;
    }
    if new_size.Height != output_size.Height {
        offset_y = (output_size.Height - new_size.Height) / 2;
    }
    RectInt32 {
        X: offset_x,
        Y: offset_y,
        Width: new_size.Width,
        Height: new_size.Height,
    }
}
