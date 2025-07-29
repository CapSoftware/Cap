use crate::cursor_svg::{analyze_cursor_image, CommonCursorType};
use cap_project::XY;
use image::GenericImageView;
use std::collections::HashMap;
use std::path::Path;

/// A cursor texture that can be either from a captured PNG or a high-quality SVG
#[derive(Debug)]
pub struct EnhancedCursorTexture {
    pub inner: wgpu::Texture,
    pub hotspot: XY<f32>,
    pub source_type: CursorSourceType,
    pub cursor_type: Option<CommonCursorType>,
}

#[derive(Debug, Clone)]
pub enum CursorSourceType {
    /// Original captured cursor image
    Captured,
    /// High-quality SVG version
    Svg,
}

/// Enhanced cursor texture manager that prefers SVG versions when available
pub struct CursorTextureManager {
    /// Map of cursor_id to detected cursor type
    cursor_type_cache: HashMap<String, Option<CommonCursorType>>,
    /// Loaded SVG textures by cursor type
    svg_textures: HashMap<CommonCursorType, EnhancedCursorTexture>,
    /// Fallback captured textures by cursor_id
    captured_textures: HashMap<String, EnhancedCursorTexture>,
}

impl CursorTextureManager {
    pub fn new() -> Self {
        Self {
            cursor_type_cache: HashMap::new(),
            svg_textures: HashMap::new(),
            captured_textures: HashMap::new(),
        }
    }

    /// Get the best available texture for a cursor ID
    /// Prefers SVG version if available, cursor type is detected, and SVG is enabled
    pub fn get_texture(&self, cursor_id: &str, use_svg: bool) -> Option<&EnhancedCursorTexture> {
        // First, check if we have a detected cursor type and SVG texture for it (and SVG is enabled)
        if use_svg {
            if let Some(Some(cursor_type)) = self.cursor_type_cache.get(cursor_id) {
                if let Some(svg_texture) = self.svg_textures.get(cursor_type) {
                    return Some(svg_texture);
                }
            }
        }

        // Fall back to captured texture
        self.captured_textures.get(cursor_id)
    }

    /// Load and analyze a captured cursor image
    /// Detect its type and cache the result
    pub fn load_captured_cursor(
        &mut self,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        cursor_id: String,
        image_path: &Path,
        hotspot: XY<f32>,
    ) -> Result<(), String> {
        // Analyze the cursor image to detect its type
        let detected_type = analyze_cursor_image(image_path);
        self.cursor_type_cache
            .insert(cursor_id.clone(), detected_type.clone());

        // Load the captured texture as fallback
        let img =
            image::open(image_path).map_err(|e| format!("Failed to load cursor image: {}", e))?;

        let rgba = img.to_rgba8();
        let dimensions = img.dimensions();

        let size = wgpu::Extent3d {
            width: dimensions.0,
            height: dimensions.1,
            depth_or_array_layers: 1,
        };

        let texture = device.create_texture(&wgpu::TextureDescriptor {
            label: Some(&format!("Captured Cursor Texture {}", cursor_id)),
            size,
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba8UnormSrgb,
            usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
            view_formats: &[],
        });

        queue.write_texture(
            wgpu::ImageCopyTexture {
                aspect: wgpu::TextureAspect::All,
                texture: &texture,
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
            },
            &rgba,
            wgpu::ImageDataLayout {
                offset: 0,
                bytes_per_row: Some(4 * dimensions.0),
                rows_per_image: Some(dimensions.1),
            },
            size,
        );

        let enhanced_texture = EnhancedCursorTexture {
            inner: texture,
            hotspot,
            source_type: CursorSourceType::Captured,
            cursor_type: detected_type,
        };

        self.captured_textures.insert(cursor_id, enhanced_texture);
        Ok(())
    }

    /// Load an SVG cursor texture for a specific cursor type
    pub fn load_svg_cursor(
        &mut self,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        cursor_type: CommonCursorType,
        svg_content: &[u8],
        size: u32,
    ) -> Result<(), String> {
        // Rasterize the SVG using resvg
        let svg_data =
            std::str::from_utf8(svg_content).map_err(|e| format!("Invalid UTF-8 in SVG: {}", e))?;

        let rtree = resvg::usvg::Tree::from_str(svg_data, &resvg::usvg::Options::default())
            .map_err(|e| format!("Failed to parse SVG: {}", e))?;

        let pixmap_size = rtree.size().to_int_size();
        let target_size = tiny_skia::IntSize::from_wh(size, size).ok_or("Invalid target size")?;

        let mut pixmap = tiny_skia::Pixmap::new(target_size.width(), target_size.height())
            .ok_or("Failed to create pixmap")?;

        // Calculate scale to fit the SVG into the target size while maintaining aspect ratio
        let scale_x = target_size.width() as f32 / pixmap_size.width() as f32;
        let scale_y = target_size.height() as f32 / pixmap_size.height() as f32;
        let scale = scale_x.min(scale_y);

        let transform = tiny_skia::Transform::from_scale(scale, scale);

        resvg::render(&rtree, transform, &mut pixmap.as_mut());

        // Convert pixmap to RGBA format for wgpu
        let rgba_data: Vec<u8> = pixmap
            .pixels()
            .iter()
            .flat_map(|pixel| {
                // let [b, g, r, a] = pixel.to_array();
                // [r, g, b, a]

                [pixel.red(), pixel.green(), pixel.red(), pixel.alpha()]
            })
            .collect();

        let texture_size = wgpu::Extent3d {
            width: size,
            height: size,
            depth_or_array_layers: 1,
        };

        let texture = device.create_texture(&wgpu::TextureDescriptor {
            label: Some(&format!("SVG Cursor Texture {:?}", cursor_type)),
            size: texture_size,
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba8UnormSrgb,
            usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
            view_formats: &[],
        });

        queue.write_texture(
            wgpu::ImageCopyTexture {
                aspect: wgpu::TextureAspect::All,
                texture: &texture,
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
            },
            &rgba_data,
            wgpu::ImageDataLayout {
                offset: 0,
                bytes_per_row: Some(4 * size),
                rows_per_image: Some(size),
            },
            texture_size,
        );

        // Set default hotspot for SVG cursors based on type
        let hotspot = match cursor_type {
            CommonCursorType::Arrow => XY::new(0.1, 0.1), // Top-left point
            CommonCursorType::IBeam => XY::new(0.5, 0.5), // Center
            CommonCursorType::Crosshair => XY::new(0.5, 0.5), // Center
            CommonCursorType::PointingHand => XY::new(0.3, 0.1), // Finger tip
            CommonCursorType::ResizeNWSE => XY::new(0.5, 0.5), // Center
            CommonCursorType::ResizeEW => XY::new(0.5, 0.5), // Center
        };

        let enhanced_texture = EnhancedCursorTexture {
            inner: texture,
            hotspot,
            source_type: CursorSourceType::Svg,
            cursor_type: Some(cursor_type.clone()),
        };

        self.svg_textures.insert(cursor_type, enhanced_texture);
        Ok(())
    }

    /// Initialize all built-in SVG cursors
    pub fn initialize_svg_cursors(
        &mut self,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
    ) -> Result<(), String> {
        use crate::cursor_svg::{load_cursor_svg, CommonCursorType};

        // Load all the SVG cursors we have
        let cursor_types = vec![
            CommonCursorType::Arrow,
            CommonCursorType::IBeam,
            CommonCursorType::Crosshair,
            CommonCursorType::PointingHand,
            CommonCursorType::ResizeNWSE,
            CommonCursorType::ResizeEW,
        ];

        for cursor_type in cursor_types {
            if let Some(svg_content) = load_cursor_svg(&cursor_type) {
                // Use a higher resolution for SVG cursors (64x64) for better quality
                self.load_svg_cursor(device, queue, cursor_type, &svg_content, 64)?;
            } else {
                return Err(format!(
                    "Failed to load SVG content for cursor type: {:?}",
                    cursor_type
                ));
            }
        }

        Ok(())
    }
}
