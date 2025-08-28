use windows::{
    Foundation::TimeSpan,
    Graphics::{
        Capture::{Direct3D11CaptureFrame, GraphicsCaptureItem, GraphicsCaptureSession},
        SizeInt32,
    },
    Win32::Graphics::{
        Direct3D11::{
            D3D11_BIND_RENDER_TARGET, D3D11_BIND_SHADER_RESOURCE, D3D11_BOX, D3D11_TEXTURE2D_DESC,
            D3D11_USAGE_DEFAULT, ID3D11Device, ID3D11DeviceContext, ID3D11RenderTargetView,
            ID3D11Texture2D,
        },
        Dxgi::Common::{DXGI_FORMAT_B8G8R8A8_UNORM, DXGI_SAMPLE_DESC},
    },
    core::Result,
};

use crate::{
    capture::{CaptureFrameGenerator, CaptureFrameGeneratorStopSignal},
    d3d::get_d3d_interface_from_object,
    video::CLEAR_COLOR,
};

use super::encoding_session::VideoEncoderInputSample;

pub struct SampleGenerator {
    d3d_device: ID3D11Device,
    d3d_context: ID3D11DeviceContext,

    compose_texture: ID3D11Texture2D,
    render_target_view: ID3D11RenderTargetView,

    frame_generator: CaptureFrameGenerator,

    seen_first_time_stamp: bool,
    first_timestamp: TimeSpan,
}

unsafe impl Send for SampleGenerator {}
impl SampleGenerator {
    pub fn new(
        d3d_device: ID3D11Device,
        item: GraphicsCaptureItem,
        input_size: SizeInt32,
        output_size: SizeInt32,
    ) -> Result<Self> {
        let d3d_context = unsafe { d3d_device.GetImmediateContext()? };

        let texture_desc = D3D11_TEXTURE2D_DESC {
            Width: output_size.Width as u32,
            Height: output_size.Height as u32,
            ArraySize: 1,
            MipLevels: 1,
            Format: DXGI_FORMAT_B8G8R8A8_UNORM,
            SampleDesc: DXGI_SAMPLE_DESC {
                Count: 1,
                ..Default::default()
            },
            Usage: D3D11_USAGE_DEFAULT,
            BindFlags: (D3D11_BIND_RENDER_TARGET.0 | D3D11_BIND_SHADER_RESOURCE.0) as u32,
            ..Default::default()
        };
        let compose_texture = unsafe {
            let mut texture = None;
            d3d_device.CreateTexture2D(&texture_desc, None, Some(&mut texture))?;
            texture.unwrap()
        };
        let render_target_view = unsafe {
            let mut rtv = None;
            d3d_device.CreateRenderTargetView(&compose_texture, None, Some(&mut rtv))?;
            rtv.unwrap()
        };

        let frame_generator =
            CaptureFrameGenerator::new(d3d_device.clone(), d3d_context.clone(), item)?;

        Ok(Self {
            d3d_device,
            d3d_context,

            compose_texture,
            render_target_view,

            frame_generator,

            seen_first_time_stamp: false,
            first_timestamp: TimeSpan::default(),
        })
    }

    pub fn capture_session(&self) -> &GraphicsCaptureSession {
        self.frame_generator.session()
    }

    pub fn generate(&mut self) -> Result<Option<VideoEncoderInputSample>> {
        if let Some(frame) = self.frame_generator.try_get_next_frame()? {
            let result = self.generate_from_frame(&frame);
            match result {
                Ok(sample) => Ok(Some(sample)),
                Err(error) => {
                    eprintln!(
                        "Error during input sample generation: {:?} - {}",
                        error.code(),
                        error.message()
                    );
                    self.stop_capture()?;
                    Ok(None)
                }
            }
        } else {
            self.stop_capture()?;
            Ok(None)
        }
    }

    pub fn stop_signal(&self) -> CaptureFrameGeneratorStopSignal {
        self.frame_generator.stop_signal()
    }

    fn stop_capture(&mut self) -> Result<()> {
        self.frame_generator.stop_capture()
    }

    fn generate_from_frame(
        &mut self,
        frame: &Direct3D11CaptureFrame,
    ) -> Result<VideoEncoderInputSample> {
        let frame_time = frame.SystemRelativeTime()?;

        if !self.seen_first_time_stamp {
            self.first_timestamp = frame_time;
            self.seen_first_time_stamp = true;
        }

        let timestamp = TimeSpan {
            Duration: frame_time.Duration - self.first_timestamp.Duration,
        };
        let content_size = frame.ContentSize()?;
        let frame_texture: ID3D11Texture2D = get_d3d_interface_from_object(&frame.Surface()?)?;
        let desc = unsafe {
            let mut desc = D3D11_TEXTURE2D_DESC::default();
            frame_texture.GetDesc(&mut desc);
            desc
        };

        // In order to support window resizing, we need to only copy out the part of
        // the buffer that contains the window. If the window is smaller than the buffer,
        // then it's a straight forward copy using the ContentSize. If the window is larger,
        // we need to clamp to the size of the buffer. For simplicity, we always clamp.
        let width = content_size.Width.clamp(0, desc.Width as i32) as u32;
        let height = content_size.Height.clamp(0, desc.Height as i32) as u32;

        let region = D3D11_BOX {
            left: 0,
            right: width,
            top: 0,
            bottom: height,
            back: 1,
            front: 0,
        };

        unsafe {
            self.d3d_context
                .ClearRenderTargetView(&self.render_target_view, &CLEAR_COLOR);
            self.d3d_context.CopySubresourceRegion(
                &self.compose_texture,
                0,
                0,
                0,
                0,
                &frame_texture,
                0,
                Some(&region),
            );

            dbg!(region);

            // Make a copy for the sample
            let desc = {
                let mut desc = D3D11_TEXTURE2D_DESC::default();
                self.compose_texture.GetDesc(&mut desc);
                desc
            };
            let sample_texture = {
                let mut texture = None;
                self.d3d_device
                    .CreateTexture2D(&desc, None, Some(&mut texture))?;
                texture.unwrap()
            };
            self.d3d_context
                .CopyResource(&sample_texture, &self.compose_texture);

            // Release the frame back to the frame pool
            frame.Close()?;

            Ok(VideoEncoderInputSample::new(timestamp, sample_texture))
        }
    }
}
