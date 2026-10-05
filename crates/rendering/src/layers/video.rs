use std::{collections::HashMap, path::Path, sync::Arc};

use cap_project::{VideoSegment, XY};

use crate::{
    DecodedSegmentFrames, ProjectUniforms, RenderVideoConstants, RenderingError,
    composite_frame::{CompositeVideoFramePipeline, CompositeVideoFrameUniforms},
    decoder::{ManagedVideoDecoder, spawn_managed_decoder},
    media_project::checked_project_video_source,
    yuv_converter::YuvConverterPipelines,
};

use super::DisplayLayer;

const MAX_ACTIVE_VIDEO_OVERLAYS: usize = 8;

struct VideoInstance {
    path: String,
    decoder: ManagedVideoDecoder,
    display: DisplayLayer,
}

pub struct VideoLayer {
    instances: HashMap<usize, VideoInstance>,
    draw_order: Vec<(u32, usize)>,
    yuv_pipelines: Arc<YuvConverterPipelines>,
    composite_pipeline: Arc<CompositeVideoFramePipeline>,
    prefer_cpu_conversion: bool,
}

impl VideoLayer {
    pub fn new(
        yuv_pipelines: Arc<YuvConverterPipelines>,
        composite_pipeline: Arc<CompositeVideoFramePipeline>,
        prefer_cpu_conversion: bool,
    ) -> Self {
        Self {
            instances: HashMap::new(),
            draw_order: Vec::new(),
            yuv_pipelines,
            composite_pipeline,
            prefer_cpu_conversion,
        }
    }

    async fn frames(
        &mut self,
        constants: &RenderVideoConstants,
        uniforms: &ProjectUniforms,
    ) -> Result<
        Vec<(
            usize,
            u32,
            DecodedSegmentFrames,
            CompositeVideoFrameUniforms,
        )>,
        RenderingError,
    > {
        self.draw_order.clear();
        let Some(timeline) = uniforms.project.timeline.as_ref() else {
            self.instances.clear();
            return Ok(Vec::new());
        };
        let time = f64::from(uniforms.frame_number) / f64::from(uniforms.frame_rate.max(1));
        let visible: Vec<_> = timeline
            .video_segments
            .iter()
            .enumerate()
            .filter_map(|(index, segment)| {
                let source_time = segment.source_time_at(time)?;
                (segment.opacity.is_finite()
                    && segment.opacity > 0.0
                    && segment.rotation.is_finite()
                    && segment.rounding.is_finite()
                    && !segment.path.is_empty())
                .then_some((index, segment, source_time))
            })
            .collect();
        if visible.len() > MAX_ACTIVE_VIDEO_OVERLAYS {
            return Err(RenderingError::VideoOverlayDecodeFailed(
                "At most eight video layers may overlap at one time".into(),
            ));
        }
        self.instances.retain(|index, instance| {
            timeline
                .video_segments
                .get(*index)
                .is_some_and(|segment| segment.path == instance.path)
        });
        let mut frames = Vec::with_capacity(visible.len());
        for (index, segment, source_time) in visible {
            if !self.instances.contains_key(&index) {
                let (source, _) = checked_project_video_source(
                    &constants.recording_meta.project_path,
                    &segment.path,
                )
                .map_err(|error| RenderingError::VideoOverlayDecodeFailed(error.to_string()))?;
                let decoder = spawn_managed_decoder(
                    "video-overlay",
                    source,
                    [Path::new(&segment.path)],
                    uniforms.frame_rate.max(1),
                    0.0,
                    true,
                )
                .map_err(|error| RenderingError::VideoOverlayDecodeFailed(error.to_string()))?;
                let display = DisplayLayer::new_with_all_shared_pipelines(
                    &constants.device,
                    self.yuv_pipelines.clone(),
                    self.composite_pipeline.clone(),
                    self.prefer_cpu_conversion,
                );
                self.instances.insert(
                    index,
                    VideoInstance {
                        path: segment.path.clone(),
                        decoder,
                        display,
                    },
                );
            }
            let instance = self.instances.get_mut(&index).unwrap();
            instance.decoder.wait_ready().await.map_err(|error| {
                RenderingError::VideoOverlayDecodeFailed(format!("{}: {error}", segment.name))
            })?;
            let frame = instance
                .decoder
                .get_frame(source_time as f32)
                .await
                .map_err(|error| {
                    RenderingError::VideoOverlayDecodeFailed(format!(
                        "{} at {source_time:.2}s: {error}",
                        segment.name
                    ))
                })?;
            let size = XY::new(frame.width(), frame.height());
            let composite = Self::uniforms_for(segment, size, uniforms.output_size);
            frames.push((
                index,
                segment.track,
                DecodedSegmentFrames {
                    screen_size: size,
                    screen_frame: Some(frame),
                    camera_frame: None,
                    segment_time: source_time as f32,
                    recording_time: source_time as f32,
                    segment_has_camera: false,
                },
                composite,
            ));
        }
        Ok(frames)
    }

    fn uniforms_for(
        segment: &VideoSegment,
        frame_size: XY<u32>,
        output_size: (u32, u32),
    ) -> CompositeVideoFrameUniforms {
        let output_width = output_size.0 as f32;
        let output_height = output_size.1 as f32;
        let center_x = segment.center.x as f32 * output_width;
        let center_y = segment.center.y as f32 * output_height;
        let width = segment.size.x as f32 * output_width;
        let height = segment.size.y as f32 * output_height;
        CompositeVideoFrameUniforms {
            crop_bounds: [0.0, 0.0, frame_size.x as f32, frame_size.y as f32],
            target_bounds: [
                center_x - width * 0.5,
                center_y - height * 0.5,
                center_x + width * 0.5,
                center_y + height * 0.5,
            ],
            output_size: [output_width, output_height],
            frame_size: [frame_size.x as f32, frame_size.y as f32],
            target_size: [width, height],
            rounding_px: segment.rounding.clamp(0.0, 100.0) * 0.005 * width.min(height),
            mirror_x: u8::from(segment.flip_x) as f32,
            opacity: segment.opacity.clamp(0.0, 1.0),
            _padding1: [
                segment.rotation.to_radians(),
                u8::from(segment.flip_y) as f32,
                0.0,
            ],
            ..Default::default()
        }
    }

    pub async fn prepare(
        &mut self,
        constants: &RenderVideoConstants,
        uniforms: &ProjectUniforms,
    ) -> Result<(), RenderingError> {
        for (index, track, frame, composite) in self.frames(constants, uniforms).await? {
            let display = &mut self.instances.get_mut(&index).unwrap().display;
            let (ready, _, _) = display.prepare(
                &constants.device,
                &constants.queue,
                &frame,
                frame.screen_size,
                composite,
            );
            if !ready {
                return Err(RenderingError::VideoOverlayDecodeFailed(
                    "Unable to upload an imported video frame".into(),
                ));
            }
            self.draw_order.push((track, index));
        }
        self.draw_order.sort_unstable();
        Ok(())
    }

    pub async fn prepare_with_encoder(
        &mut self,
        constants: &RenderVideoConstants,
        uniforms: &ProjectUniforms,
        encoder: &mut wgpu::CommandEncoder,
    ) -> Result<(), RenderingError> {
        for (index, track, frame, composite) in self.frames(constants, uniforms).await? {
            let display = &mut self.instances.get_mut(&index).unwrap().display;
            if !display.prepare_with_encoder(
                &constants.device,
                &constants.queue,
                &frame,
                composite,
                encoder,
            ) {
                return Err(RenderingError::VideoOverlayDecodeFailed(
                    "Unable to upload an imported video frame".into(),
                ));
            }
            self.draw_order.push((track, index));
        }
        self.draw_order.sort_unstable();
        Ok(())
    }

    pub fn copy_to_texture(&mut self, encoder: &mut wgpu::CommandEncoder) {
        for (_, index) in &self.draw_order {
            if let Some(instance) = self.instances.get_mut(index) {
                instance.display.copy_to_texture(encoder);
            }
        }
    }

    pub fn has_track(&self, track: u32) -> bool {
        self.draw_order.iter().any(|(draw_track, index)| {
            *draw_track == track
                && self
                    .instances
                    .get(index)
                    .is_some_and(|instance| instance.display.has_valid_frame())
        })
    }

    pub fn render_track(&self, pass: &mut wgpu::RenderPass<'_>, track: u32) {
        for (_, index) in self
            .draw_order
            .iter()
            .filter(|(draw_track, _)| *draw_track == track)
        {
            if let Some(instance) = self.instances.get(index) {
                instance.display.render(pass);
            }
        }
    }
}
