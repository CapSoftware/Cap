use std::{
    collections::{HashMap, HashSet},
    fs::{File, Metadata},
    io::{BufReader, ErrorKind},
    path::{Path, PathBuf},
    time::SystemTime,
};

use bytemuck::{Pod, Zeroable};
use cap_project::ImageSegment;
use image::{ImageDecoder, RgbaImage};
use wgpu::util::DeviceExt;

use crate::{ProjectUniforms, RenderVideoConstants};

const MAX_TEXTURES: usize = 16;
const MAX_TEXTURE_BYTES: u64 = 256 * 1024 * 1024;
const MAX_RGBA_BYTES: u64 = 64 * 1024 * 1024;
const MAX_DECODE_ALLOC: u64 = 512 * 1024 * 1024;
pub const MAX_IMAGE_SOURCE_DIMENSION: u32 = 32_768;
pub const MAX_IMAGE_SOURCE_PIXELS: u64 = 64 * 1024 * 1024;
pub const MAX_IMAGE_SOURCE_BYTES: u64 = 256 * 1024 * 1024;
pub const MAX_IMAGE_DECODED_BYTES: u64 = 256 * 1024 * 1024;

#[derive(Clone, Debug, PartialEq, Eq)]
enum FileVersion {
    File {
        length: u64,
        modified: Option<SystemTime>,
        created: Option<SystemTime>,
        #[cfg(unix)]
        identity: (u64, u64, i64, i64),
    },
    Unavailable(ErrorKind),
    NotFile,
}

impl FileVersion {
    fn from_metadata(metadata: &Metadata) -> Self {
        if !metadata.is_file() {
            return Self::NotFile;
        }
        Self::File {
            length: metadata.len(),
            modified: metadata.modified().ok(),
            created: metadata.created().ok(),
            #[cfg(unix)]
            identity: {
                use std::os::unix::fs::MetadataExt;
                (
                    metadata.dev(),
                    metadata.ino(),
                    metadata.ctime(),
                    metadata.ctime_nsec(),
                )
            },
        }
    }

    fn read(path: &Path) -> Self {
        match std::fs::metadata(path) {
            Ok(metadata) => Self::from_metadata(&metadata),
            Err(error) => Self::Unavailable(error.kind()),
        }
    }
}

struct CachedTexture {
    texture: wgpu::Texture,
    byte_len: u64,
    last_used: u64,
}

enum CacheState {
    Ready(CachedTexture),
    Evicted,
    Failed,
}

struct CacheEntry {
    version: FileVersion,
    state: CacheState,
}

struct ActiveTexture {
    version: FileVersion,
    texture: wgpu::Texture,
}

#[repr(C)]
#[derive(Clone, Copy, PartialEq, Pod, Zeroable)]
struct ImageUniforms {
    center_size: [f32; 4],
    rotation_opacity_radius: [f32; 4],
    flips: [f32; 4],
}

struct CachedDraw {
    texture: wgpu::Texture,
    uniforms: ImageUniforms,
    group: wgpu::BindGroup,
}

fn visible_images(
    segments: &[ImageSegment],
    frame_number: u32,
    frame_rate: u32,
    output_size: (u32, u32),
) -> Vec<(&ImageSegment, ImageUniforms)> {
    if frame_rate == 0 || output_size.0 == 0 || output_size.1 == 0 {
        return Vec::new();
    }
    let time = f64::from(frame_number) / f64::from(frame_rate);
    let mut images: Vec<_> = segments
        .iter()
        .enumerate()
        .filter_map(|(index, segment)| {
            if !segment.is_active_at(time)
                || segment.path.is_empty()
                || !segment.opacity.is_finite()
                || segment.opacity <= 0.0
                || !segment.rotation.is_finite()
                || !segment.rounding.is_finite()
            {
                return None;
            }
            let center_size = [
                (segment.center.x * f64::from(output_size.0)) as f32,
                (segment.center.y * f64::from(output_size.1)) as f32,
                (segment.size.x * f64::from(output_size.0)) as f32,
                (segment.size.y * f64::from(output_size.1)) as f32,
            ];
            if center_size
                .iter()
                .any(|value| !value.is_finite() || value.abs() > 1.0e7)
                || center_size[2] <= 0.0
                || center_size[3] <= 0.0
            {
                return None;
            }
            let (sin, cos) = (segment.rotation % 360.0).to_radians().sin_cos();
            let half_width = (cos.abs() * center_size[2] + sin.abs() * center_size[3]) * 0.5;
            let half_height = (sin.abs() * center_size[2] + cos.abs() * center_size[3]) * 0.5;
            if center_size[0] + half_width < 0.0
                || center_size[1] + half_height < 0.0
                || center_size[0] - half_width > output_size.0 as f32
                || center_size[1] - half_height > output_size.1 as f32
            {
                return None;
            }
            Some((
                index,
                segment,
                ImageUniforms {
                    center_size,
                    rotation_opacity_radius: [
                        cos,
                        sin,
                        segment.opacity.clamp(0.0, 1.0),
                        segment.rounding.clamp(0.0, 100.0)
                            * 0.005
                            * center_size[2].min(center_size[3]),
                    ],
                    flips: [
                        u8::from(segment.flip_x) as f32,
                        u8::from(segment.flip_y) as f32,
                        0.0,
                        0.0,
                    ],
                },
            ))
        })
        .collect();
    images.sort_unstable_by_key(|(index, segment, _)| (segment.track, *index));
    images
        .into_iter()
        .map(|(_, segment, uniforms)| (segment, uniforms))
        .collect()
}

fn texture_dimensions(width: u32, height: u32, max_dimension: u32) -> (u32, u32) {
    let scale = (MAX_RGBA_BYTES as f64 / (f64::from(width) * f64::from(height) * 4.0))
        .sqrt()
        .min(f64::from(max_dimension) / f64::from(width.max(height)))
        .min(1.0);
    (
        ((f64::from(width) * scale) as u32).max(1),
        ((f64::from(height) * scale) as u32).max(1),
    )
}

fn premultiplied_mips(mut rgba: RgbaImage, max_dimension: u32) -> Vec<RgbaImage> {
    for pixel in rgba.pixels_mut() {
        let alpha = u16::from(pixel[3]);
        for channel in &mut pixel.0[..3] {
            *channel = ((u16::from(*channel) * alpha + 127) / 255) as u8;
        }
    }
    let (width, height) = texture_dimensions(rgba.width(), rgba.height(), max_dimension);
    if rgba.dimensions() != (width, height) {
        rgba = image::imageops::resize(&rgba, width, height, image::imageops::FilterType::Triangle);
    }
    let mut levels = vec![rgba];
    while let Some(previous) = levels.last() {
        let (width, height) = previous.dimensions();
        if width == 1 && height == 1 {
            break;
        }
        levels.push(image::imageops::resize(
            previous,
            (width / 2).max(1),
            (height / 2).max(1),
            image::imageops::FilterType::Triangle,
        ));
    }
    levels
}

fn decode_image(
    path: &Path,
    expected: &FileVersion,
    max_dimension: u32,
) -> anyhow::Result<Vec<RgbaImage>> {
    let file = File::open(path)?;
    let metadata = file.metadata()?;
    anyhow::ensure!(
        FileVersion::from_metadata(&metadata) == *expected,
        "Image changed before decoding"
    );
    anyhow::ensure!(
        metadata.is_file() && metadata.len() <= MAX_IMAGE_SOURCE_BYTES,
        "Image file exceeds the decode limit"
    );
    let mut reader = image::ImageReader::new(BufReader::new(file)).with_guessed_format()?;
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(MAX_IMAGE_SOURCE_DIMENSION);
    limits.max_image_height = Some(MAX_IMAGE_SOURCE_DIMENSION);
    limits.max_alloc = Some(MAX_DECODE_ALLOC);
    reader.limits(limits.clone());
    let mut decoder = reader.into_decoder()?;
    let (width, height) = decoder.dimensions();
    anyhow::ensure!(
        width > 0 && height > 0 && u64::from(width) * u64::from(height) <= MAX_IMAGE_SOURCE_PIXELS,
        "Image dimensions exceed the source pixel limit"
    );
    anyhow::ensure!(
        decoder.total_bytes() <= MAX_IMAGE_DECODED_BYTES,
        "Image exceeds the source decode allocation limit"
    );
    limits.reserve(decoder.total_bytes())?;
    decoder.set_limits(limits)?;
    let orientation = decoder.orientation()?;
    let mut decoded = image::DynamicImage::from_decoder(decoder)?;
    decoded.apply_orientation(orientation);
    let levels = premultiplied_mips(decoded.into_rgba8(), max_dimension);
    anyhow::ensure!(
        FileVersion::read(path) == *expected,
        "Image changed while decoding"
    );
    Ok(levels)
}

fn upload_texture(
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    levels: &[RgbaImage],
) -> wgpu::Texture {
    let texture = device.create_texture(&wgpu::TextureDescriptor {
        label: Some("Image overlay texture"),
        size: wgpu::Extent3d {
            width: levels[0].width(),
            height: levels[0].height(),
            depth_or_array_layers: 1,
        },
        mip_level_count: levels.len() as u32,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: wgpu::TextureFormat::Rgba8Unorm,
        usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
        view_formats: &[],
    });
    for (level, rgba) in levels.iter().enumerate() {
        queue.write_texture(
            wgpu::TexelCopyTextureInfo {
                texture: &texture,
                mip_level: level as u32,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
            },
            rgba.as_raw(),
            wgpu::TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(rgba.width() * 4),
                rows_per_image: Some(rgba.height()),
            },
            wgpu::Extent3d {
                width: rgba.width(),
                height: rgba.height(),
                depth_or_array_layers: 1,
            },
        );
    }
    texture
}

pub struct ImageLayer {
    pipeline: wgpu::RenderPipeline,
    sampler: wgpu::Sampler,
    draws: Vec<wgpu::BindGroup>,
    cached_draws: Vec<CachedDraw>,
    cache: HashMap<PathBuf, CacheEntry>,
    active_textures: HashMap<PathBuf, ActiveTexture>,
    counter: u64,
}

impl ImageLayer {
    pub fn new(device: &wgpu::Device) -> Self {
        let shader = device.create_shader_module(wgpu::include_wgsl!("../shaders/image.wgsl"));
        let pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("Image overlay pipeline"),
            layout: None,
            vertex: wgpu::VertexState {
                module: &shader,
                entry_point: Some("vs_main"),
                compilation_options: Default::default(),
                buffers: &[],
            },
            fragment: Some(wgpu::FragmentState {
                module: &shader,
                entry_point: Some("fs_main"),
                compilation_options: Default::default(),
                targets: &[Some(wgpu::ColorTargetState {
                    format: wgpu::TextureFormat::Rgba8Unorm,
                    blend: Some(wgpu::BlendState::PREMULTIPLIED_ALPHA_BLENDING),
                    write_mask: wgpu::ColorWrites::ALL,
                })],
            }),
            primitive: wgpu::PrimitiveState::default(),
            depth_stencil: None,
            multisample: wgpu::MultisampleState::default(),
            multiview: None,
            cache: None,
        });
        Self {
            pipeline,
            sampler: device.create_sampler(&wgpu::SamplerDescriptor {
                label: Some("Image overlay sampler"),
                address_mode_u: wgpu::AddressMode::ClampToEdge,
                address_mode_v: wgpu::AddressMode::ClampToEdge,
                mag_filter: wgpu::FilterMode::Linear,
                min_filter: wgpu::FilterMode::Linear,
                mipmap_filter: wgpu::FilterMode::Linear,
                ..Default::default()
            }),
            draws: Vec::new(),
            cached_draws: Vec::new(),
            cache: HashMap::new(),
            active_textures: HashMap::new(),
            counter: 0,
        }
    }

    fn make_room(&mut self, byte_len: u64) {
        loop {
            let mut count = 0;
            let mut used = 0;
            let mut oldest = None;
            for (path, entry) in &self.cache {
                if let CacheState::Ready(texture) = &entry.state {
                    count += 1;
                    used += texture.byte_len;
                    if oldest
                        .as_ref()
                        .is_none_or(|(_, last_used)| texture.last_used < *last_used)
                    {
                        oldest = Some((path.clone(), texture.last_used));
                    }
                }
            }
            if count < MAX_TEXTURES && used + byte_len <= MAX_TEXTURE_BYTES {
                return;
            }
            let Some((path, _)) = oldest else {
                return;
            };
            if let Some(entry) = self.cache.get_mut(&path) {
                entry.state = CacheState::Evicted;
            }
        }
    }

    async fn ensure_texture(
        &mut self,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        path: &Path,
        version: &FileVersion,
        reusable: Option<wgpu::Texture>,
    ) -> Option<wgpu::Texture> {
        let entry = self
            .cache
            .entry(path.to_path_buf())
            .or_insert_with(|| CacheEntry {
                version: version.clone(),
                state: CacheState::Evicted,
            });
        if entry.version != *version {
            entry.version = version.clone();
            entry.state = CacheState::Evicted;
        }
        if matches!(entry.state, CacheState::Failed) {
            return None;
        }
        if !matches!(version, FileVersion::File { .. }) {
            tracing::warn!(path = %path.display(), ?version, "Image overlay is unavailable");
            entry.state = CacheState::Failed;
            return None;
        }
        self.counter = self.counter.saturating_add(1);
        if let CacheState::Ready(texture) = &mut entry.state {
            texture.last_used = self.counter;
            return Some(texture.texture.clone());
        }
        if let Some(texture) = reusable {
            self.cache_texture(path, texture.clone());
            return Some(texture);
        }
        let decode_path = path.to_path_buf();
        let decode_version = version.clone();
        let max_dimension = device.limits().max_texture_dimension_2d;
        let decoded = tokio::task::spawn_blocking(move || {
            decode_image(&decode_path, &decode_version, max_dimension)
        })
        .await;
        let levels = match decoded
            .map_err(anyhow::Error::from)
            .and_then(|result| result)
        {
            Ok(levels) => levels,
            Err(error) => {
                tracing::warn!(path = %path.display(), %error, "Failed to decode image overlay");
                if let Some(entry) = self.cache.get_mut(path) {
                    entry.state = CacheState::Failed;
                }
                return None;
            }
        };
        let texture = upload_texture(device, queue, &levels);
        self.cache_texture(path, texture.clone());
        Some(texture)
    }

    fn cache_texture(&mut self, path: &Path, texture: wgpu::Texture) {
        let byte_len = (0..texture.mip_level_count())
            .map(|level| {
                u64::from((texture.width() >> level).max(1))
                    * u64::from((texture.height() >> level).max(1))
                    * 4
            })
            .sum();
        self.make_room(byte_len);
        if let Some(entry) = self.cache.get_mut(path) {
            entry.state = CacheState::Ready(CachedTexture {
                texture,
                byte_len,
                last_used: self.counter,
            });
        }
    }

    fn push_draw(
        &mut self,
        device: &wgpu::Device,
        texture: &wgpu::Texture,
        uniforms: ImageUniforms,
    ) {
        let index = self.draws.len();
        if let Some(draw) = self.cached_draws.get(index)
            && draw.texture == *texture
            && draw.uniforms == uniforms
        {
            self.draws.push(draw.group.clone());
            return;
        }
        let buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("Image overlay uniforms"),
            contents: bytemuck::bytes_of(&uniforms),
            usage: wgpu::BufferUsages::UNIFORM,
        });
        let group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("Image overlay bind group"),
            layout: &self.pipeline.get_bind_group_layout(0),
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: buffer.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: wgpu::BindingResource::TextureView(
                        &texture.create_view(&wgpu::TextureViewDescriptor::default()),
                    ),
                },
                wgpu::BindGroupEntry {
                    binding: 2,
                    resource: wgpu::BindingResource::Sampler(&self.sampler),
                },
            ],
        });
        let draw = CachedDraw {
            texture: texture.clone(),
            uniforms,
            group: group.clone(),
        };
        if let Some(cached) = self.cached_draws.get_mut(index) {
            *cached = draw;
        } else {
            self.cached_draws.push(draw);
        }
        self.draws.push(group);
    }

    pub async fn prepare(&mut self, constants: &RenderVideoConstants, uniforms: &ProjectUniforms) {
        self.draws.clear();
        let mut previous_textures = std::mem::take(&mut self.active_textures);
        let Some(timeline) = &uniforms.project.timeline else {
            self.cache.clear();
            self.cached_draws.clear();
            return;
        };
        let project_path = &constants.recording_meta.project_path;
        let referenced: HashSet<_> = timeline
            .image_segments
            .iter()
            .filter(|segment| !segment.path.is_empty())
            .map(|segment| project_path.join(&segment.path))
            .collect();
        self.cache.retain(|path, _| referenced.contains(path));
        let images = visible_images(
            &timeline.image_segments,
            uniforms.frame_number,
            uniforms.frame_rate,
            uniforms.output_size,
        );
        if images.is_empty() {
            self.cached_draws.clear();
            return;
        }
        let paths: HashSet<_> = images
            .iter()
            .map(|(segment, _)| project_path.join(&segment.path))
            .collect();
        let versions = match tokio::task::spawn_blocking(move || {
            paths
                .into_iter()
                .map(|path| {
                    let version = FileVersion::read(&path);
                    (path, version)
                })
                .collect::<HashMap<_, _>>()
        })
        .await
        {
            Ok(versions) => versions,
            Err(error) => {
                tracing::warn!(%error, "Image overlay metadata task failed");
                self.cached_draws.clear();
                return;
            }
        };
        for (segment, image_uniforms) in images {
            let path = project_path.join(&segment.path);
            let Some(version) = versions.get(&path) else {
                continue;
            };
            let reusable = self
                .active_textures
                .get(&path)
                .filter(|active| active.version == *version)
                .map(|active| active.texture.clone())
                .or_else(|| {
                    previous_textures
                        .remove(&path)
                        .filter(|active| active.version == *version)
                        .map(|active| active.texture)
                });
            if let Some(texture) = self
                .ensure_texture(
                    &constants.device,
                    &constants.queue,
                    &path,
                    version,
                    reusable,
                )
                .await
            {
                self.active_textures.insert(
                    path,
                    ActiveTexture {
                        version: version.clone(),
                        texture: texture.clone(),
                    },
                );
                self.push_draw(&constants.device, &texture, image_uniforms);
            }
        }
        self.cached_draws.truncate(self.draws.len());
    }

    pub fn has_content(&self) -> bool {
        !self.draws.is_empty()
    }

    pub fn render(&self, pass: &mut wgpu::RenderPass<'_>) {
        if !self.has_content() {
            return;
        }
        pass.set_pipeline(&self.pipeline);
        for group in &self.draws {
            pass.set_bind_group(0, group, &[]);
            pass.draw(0..3, 0..1);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use cap_project::XY;

    fn segment(path: &str) -> ImageSegment {
        ImageSegment {
            start: 1.0,
            end: 2.0,
            path: path.to_owned(),
            center: XY::new(0.5, 0.5),
            size: XY::new(0.5, 0.5),
            ..Default::default()
        }
    }

    #[test]
    fn image_timing_order_and_invalid_geometry() {
        let mut images = vec![segment("top"), segment("bottom"), segment("top-later")];
        images[0].track = 2;
        images[1].track = 1;
        images[2].track = 2;
        let visible = visible_images(&images, 30, 30, (64, 64));
        assert_eq!(
            visible
                .iter()
                .map(|(image, _)| image.path.as_str())
                .collect::<Vec<_>>(),
            ["bottom", "top", "top-later"]
        );
        for frame in [0, 29, 60, 61] {
            assert!(visible_images(&images, frame, 30, (64, 64)).is_empty());
        }
        assert!(visible_images(&images, 30, 0, (64, 64)).is_empty());
        assert!(visible_images(&images, 30, 30, (0, 64)).is_empty());
        images[0].enabled = false;
        images[1].center.x = f64::NAN;
        images[2].size.y = -0.1;
        assert!(visible_images(&images, 30, 30, (64, 64)).is_empty());
        let mut clamped = segment("clamped");
        clamped.opacity = 2.0;
        clamped.rounding = 200.0;
        let clamped = [clamped];
        let visible = visible_images(&clamped, 30, 30, (64, 64));
        assert_eq!(visible[0].1.rotation_opacity_radius[2..], [1.0, 16.0]);
    }

    #[test]
    fn image_mips_do_not_bleed_transparent_rgb() {
        let rgba = RgbaImage::from_raw(2, 1, vec![255, 0, 0, 255, 0, 255, 255, 0]).unwrap();
        let levels = premultiplied_mips(rgba.clone(), 8192);
        assert_eq!(levels[0].get_pixel(1, 0).0, [0; 4]);
        let mip = levels[1].get_pixel(0, 0).0;
        assert_eq!(mip[0], mip[3]);
        assert_eq!(&mip[1..3], &[0, 0]);
        assert!((127..=128).contains(&mip[3]));
        let downscaled = premultiplied_mips(rgba, 1);
        assert_eq!(downscaled[0].dimensions(), (1, 1));
        assert_eq!(downscaled[0].get_pixel(0, 0).0, mip);
    }

    #[test]
    fn image_texture_size_preserves_large_sources_within_gpu_limits() {
        assert_eq!(texture_dimensions(800, 600, 8192), (800, 600));
        assert_eq!(texture_dimensions(8192, 8192, 8192), (4096, 4096));
        assert_eq!(texture_dimensions(32_768, 1, 8192), (8192, 1));
        for dimensions in [(12_000, 5_000), (5_000, 12_000), (8192, 8192)] {
            let (width, height) = texture_dimensions(dimensions.0, dimensions.1, 4096);
            assert!(width <= 4096 && height <= 4096);
            assert!(u64::from(width) * u64::from(height) * 4 <= MAX_RGBA_BYTES);
        }
    }

    fn render_pixels(device: &wgpu::Device, queue: &wgpu::Queue, layer: &ImageLayer) -> Vec<u8> {
        let output = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("Image overlay test output"),
            size: wgpu::Extent3d {
                width: 64,
                height: 64,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba8Unorm,
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC,
            view_formats: &[],
        });
        let buffer = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("Image overlay test readback"),
            size: 64 * 64 * 4,
            usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
            mapped_at_creation: false,
        });
        let view = output.create_view(&Default::default());
        let mut encoder = device.create_command_encoder(&Default::default());
        {
            let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("Image overlay pixel test"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &view,
                    resolve_target: None,
                    ops: wgpu::Operations {
                        load: wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT),
                        store: wgpu::StoreOp::Store,
                    },
                })],
                depth_stencil_attachment: None,
                timestamp_writes: None,
                occlusion_query_set: None,
            });
            layer.render(&mut pass);
        }
        encoder.copy_texture_to_buffer(
            output.as_image_copy(),
            wgpu::TexelCopyBufferInfo {
                buffer: &buffer,
                layout: wgpu::TexelCopyBufferLayout {
                    offset: 0,
                    bytes_per_row: Some(256),
                    rows_per_image: Some(64),
                },
            },
            output.size(),
        );
        queue.submit([encoder.finish()]);
        let (sender, receiver) = std::sync::mpsc::channel();
        buffer
            .slice(..)
            .map_async(wgpu::MapMode::Read, move |result| {
                sender.send(result).expect("Image readback receiver");
            });
        device
            .poll(wgpu::PollType::Wait)
            .expect("Poll image GPU test");
        receiver.recv().unwrap().unwrap();
        let pixels = buffer.slice(..).get_mapped_range().to_vec();
        buffer.unmap();
        pixels
    }

    fn pixel(pixels: &[u8], x: usize, y: usize) -> [u8; 4] {
        pixels[(y * 64 + x) * 4..(y * 64 + x + 1) * 4]
            .try_into()
            .unwrap()
    }

    fn assert_pixel(actual: [u8; 4], expected: [u8; 4]) {
        assert!(
            actual.iter().zip(expected).all(|(a, b)| a.abs_diff(b) <= 2),
            "Expected {expected:?}, got {actual:?}"
        );
    }

    fn test_device() -> Option<(wgpu::Device, wgpu::Queue)> {
        let instance = crate::create_wgpu_instance_sync();
        let Ok(adapter) = pollster::block_on(instance.request_adapter(&Default::default())) else {
            eprintln!("No GPU adapter available; skipping image overlay pixel tests");
            return None;
        };
        Some(pollster::block_on(adapter.request_device(&Default::default())).unwrap())
    }

    #[test]
    fn unchanged_image_draws_reuse_resources_without_mutating_queued_frames() {
        let Some((device, queue)) = test_device() else {
            return;
        };
        let mut layer = ImageLayer::new(&device);
        let red = upload_texture(
            &device,
            &queue,
            &[RgbaImage::from_pixel(1, 1, image::Rgba([255, 0, 0, 255]))],
        );
        let image = [segment("red")];
        let uniforms = visible_images(&image, 30, 30, (64, 64))[0].1;
        layer.push_draw(&device, &red, uniforms);
        let original_group = layer.draws[0].clone();
        let original_pixels = render_pixels(&device, &queue, &layer);
        for _ in 0..120 {
            layer.draws.clear();
            layer.push_draw(&device, &red, uniforms);
            assert_eq!(layer.draws[0], original_group);
        }
        assert_eq!(render_pixels(&device, &queue, &layer), original_pixels);

        let mut moved = uniforms;
        moved.center_size[0] = 48.0;
        layer.draws.clear();
        layer.push_draw(&device, &red, moved);
        assert_ne!(layer.draws[0], original_group);
        let moved_pixels = render_pixels(&device, &queue, &layer);
        assert_eq!(pixel(&moved_pixels, 20, 32), [0; 4]);
        assert_pixel(pixel(&moved_pixels, 56, 32), [255, 0, 0, 255]);
        layer.draws[0] = original_group;
        assert_eq!(render_pixels(&device, &queue, &layer), original_pixels);

        let blue = upload_texture(
            &device,
            &queue,
            &[RgbaImage::from_pixel(1, 1, image::Rgba([0, 0, 255, 255]))],
        );
        layer.draws.clear();
        layer.push_draw(&device, &blue, moved);
        assert_pixel(
            pixel(&render_pixels(&device, &queue, &layer), 56, 32),
            [0, 0, 255, 255],
        );
    }

    #[test]
    fn image_overlay_gpu_pixels() {
        let Some((device, queue)) = test_device() else {
            return;
        };
        let mut layer = ImageLayer::new(&device);
        let rgba = RgbaImage::from_raw(2, 1, vec![255, 0, 0, 255, 0, 255, 255, 0]).unwrap();
        let transparent = upload_texture(&device, &queue, &premultiplied_mips(rgba, 8192));
        let mut image = segment("transparent");
        image.center = XY::new(0.25, 0.25);
        image.size = XY::new(0.25, 0.25);
        image.opacity = 0.5;
        for (_, uniforms) in visible_images(&[image], 30, 30, (64, 64)) {
            layer.push_draw(&device, &transparent, uniforms);
        }
        let pixels = render_pixels(&device, &queue, &layer);
        assert_pixel(pixel(&pixels, 10, 16), [128, 0, 0, 128]);
        assert_eq!(pixel(&pixels, 22, 16), [0; 4]);
        assert_eq!(pixel(&pixels, 32, 32), [0; 4]);
        let edge = pixel(&pixels, 15, 16);
        assert_eq!(edge[0], edge[3]);
        assert_eq!(&edge[1..3], &[0, 0]);
        assert!((1..128).contains(&edge[3]));

        let rgba = RgbaImage::from_raw(2, 1, vec![255, 0, 0, 255, 0, 0, 255, 255]).unwrap();
        let two_color = upload_texture(&device, &queue, &premultiplied_mips(rgba, 8192));
        for flip in [false, true] {
            layer.draws.clear();
            let mut image = segment("rotated");
            image.size = XY::new(0.5, 0.25);
            image.rotation = 90.0;
            image.flip_x = flip;
            for (_, uniforms) in visible_images(&[image], 30, 30, (64, 64)) {
                layer.push_draw(&device, &two_color, uniforms);
            }
            let pixels = render_pixels(&device, &queue, &layer);
            let (top, bottom) = if flip {
                ([0, 0, 255, 255], [255, 0, 0, 255])
            } else {
                ([255, 0, 0, 255], [0, 0, 255, 255])
            };
            assert_pixel(pixel(&pixels, 32, 20), top);
            assert_pixel(pixel(&pixels, 32, 44), bottom);
            assert_eq!(pixel(&pixels, 20, 32), [0; 4]);
        }

        let red = upload_texture(
            &device,
            &queue,
            &[RgbaImage::from_pixel(1, 1, image::Rgba([255, 0, 0, 255]))],
        );
        layer.draws.clear();
        let mut rounded = segment("rounded");
        rounded.rounding = 100.0;
        for (_, uniforms) in visible_images(&[rounded], 30, 30, (64, 64)) {
            layer.push_draw(&device, &red, uniforms);
        }
        let pixels = render_pixels(&device, &queue, &layer);
        assert_eq!(pixel(&pixels, 17, 17), [0; 4]);
        assert_pixel(pixel(&pixels, 32, 32), [255, 0, 0, 255]);
    }

    struct ImageFixture(PathBuf);

    impl ImageFixture {
        fn new() -> Self {
            let id = SystemTime::now()
                .duration_since(SystemTime::UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let directory =
                std::env::temp_dir().join(format!("cap-image-test-{}-{id}", std::process::id()));
            std::fs::create_dir(&directory).unwrap();
            Self(directory)
        }
    }

    impl Drop for ImageFixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn image_cache_retries_missing_corrupt_and_replaced_files() {
        let Some((device, queue)) = test_device() else {
            return;
        };
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        runtime.block_on(async {
            let fixture = ImageFixture::new();
            let path = fixture.0.join("image.png");
            let mut layer = ImageLayer::new(&device);
            let missing = FileVersion::read(&path);
            for _ in 0..2 {
                assert!(
                    layer
                        .ensure_texture(&device, &queue, &path, &missing, None)
                        .await
                        .is_none()
                );
                assert!(matches!(layer.cache[&path].state, CacheState::Failed));
            }

            RgbaImage::from_pixel(33, 9, image::Rgba([255, 0, 0, 255]))
                .save(&path)
                .unwrap();
            let original_version = FileVersion::read(&path);
            let resized = decode_image(&path, &original_version, 16).unwrap();
            assert_eq!(resized[0].dimensions(), (16, 4));
            let original = layer
                .ensure_texture(&device, &queue, &path, &original_version, None)
                .await
                .unwrap();
            std::fs::write(&path, b"invalid image").unwrap();
            assert!(
                layer
                    .ensure_texture(&device, &queue, &path, &original_version, None)
                    .await
                    .is_some()
            );
            let corrupt = FileVersion::read(&path);
            assert_ne!(corrupt, original_version);
            for _ in 0..2 {
                assert!(
                    layer
                        .ensure_texture(&device, &queue, &path, &corrupt, None)
                        .await
                        .is_none()
                );
                assert!(matches!(layer.cache[&path].state, CacheState::Failed));
            }

            let replacement = fixture.0.join("replacement.png");
            RgbaImage::from_pixel(33, 9, image::Rgba([0, 0, 255, 255]))
                .save(&replacement)
                .unwrap();
            std::fs::rename(&replacement, &path).unwrap();
            let replaced = FileVersion::read(&path);
            assert_ne!(replaced, corrupt);
            let texture = layer
                .ensure_texture(&device, &queue, &path, &replaced, None)
                .await
                .unwrap();
            for (_, uniforms) in visible_images(&[segment("replaced")], 30, 30, (64, 64)) {
                layer.push_draw(&device, &texture, uniforms);
            }
            assert_pixel(
                pixel(&render_pixels(&device, &queue, &layer), 32, 32),
                [0, 0, 255, 255],
            );

            for index in 0..=MAX_TEXTURES {
                let path = fixture.0.join(format!("active-{index}.png"));
                assert!(
                    layer
                        .ensure_texture(&device, &queue, &path, &replaced, Some(original.clone()))
                        .await
                        .is_some()
                );
            }
            assert_eq!(
                layer
                    .cache
                    .values()
                    .filter(|entry| matches!(entry.state, CacheState::Ready(_)))
                    .count(),
                MAX_TEXTURES
            );
            let evicted = fixture.0.join("active-0.png");
            assert!(matches!(layer.cache[&evicted].state, CacheState::Evicted));
            assert!(
                layer
                    .ensure_texture(&device, &queue, &evicted, &replaced, Some(original))
                    .await
                    .is_some()
            );
            std::fs::remove_file(&path).unwrap();
            let removed = FileVersion::read(&path);
            assert!(
                layer
                    .ensure_texture(&device, &queue, &path, &removed, Some(texture))
                    .await
                    .is_none()
            );
        });
    }
}
