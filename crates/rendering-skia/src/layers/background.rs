use crate::SkiaRenderingError;
use crate::layers::{FrameData, RecordableLayer, SkiaProjectUniforms};
use cap_project::BackgroundSource;
use skia_safe::{
    Canvas, Color, Image, Paint, Picture, PictureRecorder, Point, Rect, Shader, TileMode,
};
use std::path::PathBuf;

/// Background configuration
#[derive(Debug, Clone, PartialEq)]
pub enum Background {
    Color([u16; 3]),
    Gradient {
        from: [u16; 3],
        to: [u16; 3],
        angle: u16,
    },
    Image {
        path: PathBuf,
    },
    Wallpaper {
        path: PathBuf,
    },
}

impl From<BackgroundSource> for Background {
    fn from(source: BackgroundSource) -> Self {
        match source {
            BackgroundSource::Color { value } => Background::Color(value),
            BackgroundSource::Gradient { from, to, angle } => {
                Background::Gradient { from, to, angle }
            }
            BackgroundSource::Image { path } => {
                if let Some(path) = path {
                    Background::Image {
                        path: PathBuf::from(path),
                    }
                } else {
                    // Default to black if no path
                    Background::Color([0, 0, 0])
                }
            }
            BackgroundSource::Wallpaper { path } => {
                if let Some(path) = path {
                    Background::Wallpaper {
                        path: PathBuf::from(path),
                    }
                } else {
                    // Default to black if no path
                    Background::Color([0, 0, 0])
                }
            }
        }
    }
}

/// Skia-based background layer with picture caching
pub struct BackgroundLayer {
    // Current background configuration
    current_background: Option<Background>,
    current_border: Option<cap_project::BorderConfiguration>,

    // Track what we rendered last to detect changes
    last_rendered_background: Option<Background>,
    last_rendered_border: Option<cap_project::BorderConfiguration>,
    last_rendered_size: (u32, u32),

    // For image backgrounds
    image_path: Option<PathBuf>,
    loaded_image: Option<Image>,
}

impl BackgroundLayer {
    pub fn new() -> Self {
        Self {
            current_background: None,
            current_border: None,
            last_rendered_background: None,
            last_rendered_border: None,
            last_rendered_size: (0, 0),
            image_path: None,
            loaded_image: None,
        }
    }

    fn render_background(&self, canvas: &Canvas, bounds: Rect) {
        match &self.current_background {
            Some(Background::Color(color)) => {
                self.render_color(canvas, color, bounds);
            }
            Some(Background::Gradient { from, to, angle }) => {
                self.render_gradient(canvas, from, to, *angle, bounds);
            }
            Some(Background::Image { .. }) | Some(Background::Wallpaper { .. }) => {
                if let Some(image) = &self.loaded_image {
                    self.render_image(canvas, image, bounds);
                } else {
                    // Fallback to black if image not loaded
                    canvas.clear(Color::BLACK);
                }
            }
            None => {
                // Clear to black as default
                canvas.clear(Color::BLACK);
            }
        }
    }

    fn render_border(
        &self,
        canvas: &Canvas,
        bounds: Rect,
        border: &cap_project::BorderConfiguration,
    ) {
        if !border.enabled || border.width <= 0.0 {
            return;
        }

        let mut paint = Paint::default();
        paint.set_style(skia_safe::PaintStyle::Stroke);
        paint.set_stroke_width(border.width);
        paint.set_anti_alias(true);

        let alpha = ((border.opacity / 100.0).clamp(0.0, 1.0) * 255.0) as u8;
        let border_color = Color::from_argb(
            alpha,
            (border.color[0] >> 8) as u8,
            (border.color[1] >> 8) as u8,
            (border.color[2] >> 8) as u8,
        );
        paint.set_color(border_color);

        let inset = border.width / 2.0;
        let border_rect = Rect::from_xywh(
            bounds.left() + inset,
            bounds.top() + inset,
            (bounds.width() - border.width).max(0.0),
            (bounds.height() - border.width).max(0.0),
        );

        canvas.draw_rect(border_rect, &paint);
    }

    fn render_color(&self, canvas: &Canvas, color: &[u16; 3], _bounds: Rect) {
        // Convert from u16 (0-65535) to u8 (0-255)
        let skia_color = Color::from_argb(
            255, // Full opacity
            (color[0] >> 8) as u8,
            (color[1] >> 8) as u8,
            (color[2] >> 8) as u8,
        );
        canvas.clear(skia_color);
    }

    fn render_gradient(
        &self,
        canvas: &Canvas,
        from: &[u16; 3],
        to: &[u16; 3],
        angle: u16,
        bounds: Rect,
    ) {
        let start_color = Color::from_argb(
            255, // Full opacity
            (from[0] >> 8) as u8,
            (from[1] >> 8) as u8,
            (from[2] >> 8) as u8,
        );
        let end_color = Color::from_argb(
            255, // Full opacity
            (to[0] >> 8) as u8,
            (to[1] >> 8) as u8,
            (to[2] >> 8) as u8,
        );

        // Convert angle to radians and add 270 degrees to match the original shader
        let angle_rad = (angle as f32 + 270.0).to_radians();
        let center = Point::new(bounds.width() / 2.0, bounds.height() / 2.0);

        // Calculate gradient vector based on angle
        // Use diagonal length to ensure gradient covers entire bounds
        let gradient_length = (bounds.width().powi(2) + bounds.height().powi(2)).sqrt();
        let dx = angle_rad.cos() * gradient_length / 2.0;
        let dy = angle_rad.sin() * gradient_length / 2.0;

        let start_point = Point::new(center.x - dx, center.y - dy);
        let end_point = Point::new(center.x + dx, center.y + dy);

        // Create gradient shader
        let colors = vec![start_color, end_color];
        if let Some(shader) = Shader::linear_gradient(
            (start_point, end_point),
            colors.as_slice(),
            None,
            TileMode::Clamp,
            None,
            None,
        ) {
            let mut paint = Paint::default();
            paint.set_shader(shader);
            canvas.draw_rect(bounds, &paint);
        } else {
            // Fallback to start color if gradient creation fails
            canvas.clear(start_color);
        }
    }

    fn render_image(&self, canvas: &Canvas, image: &Image, bounds: Rect) {
        // Calculate scaling to cover the entire background (similar to CSS background-size: cover)
        let image_aspect = image.width() as f32 / image.height() as f32;
        let bounds_aspect = bounds.width() / bounds.height();

        let scale = if image_aspect > bounds_aspect {
            // Image is wider - fit to height
            bounds.height() / image.height() as f32
        } else {
            // Image is taller - fit to width
            bounds.width() / image.width() as f32
        };

        // Center the image
        let scaled_width = image.width() as f32 * scale;
        let scaled_height = image.height() as f32 * scale;
        let x = bounds.left() + (bounds.width() - scaled_width) / 2.0;
        let y = bounds.top() + (bounds.height() - scaled_height) / 2.0;

        canvas.save();
        canvas.translate((x, y));
        canvas.scale((scale, scale));

        let mut paint = Paint::default();
        paint.set_anti_alias(true);

        canvas.draw_image(image, Point::default(), Some(&paint));
        canvas.restore();
    }
}

impl RecordableLayer for BackgroundLayer {
    fn record(
        &mut self,
        recorder: &mut PictureRecorder,
        bounds: Rect,
        uniforms: &SkiaProjectUniforms,
    ) -> Option<Picture> {
        let canvas = recorder.begin_recording(bounds, None);
        self.render_background(canvas, bounds);

        // Render border if enabled
        if let Some(border) = &uniforms.border
            && border.enabled
        {
            self.render_border(canvas, bounds, border);
        }

        // Update what was last rendered
        self.last_rendered_background = self.current_background.clone();
        self.last_rendered_border = self.current_border.clone();
        self.last_rendered_size = uniforms.output_size;

        recorder.finish_recording_as_picture(None)
    }

    fn needs_update(&self, uniforms: &SkiaProjectUniforms) -> bool {
        let new_background = Background::from(uniforms.background.clone());
        let new_border = uniforms.border.clone();
        let new_size = uniforms.output_size;

        // Check against what was last rendered, not what's currently prepared
        self.last_rendered_background.as_ref() != Some(&new_background)
            || self.last_rendered_border != new_border
            || self.last_rendered_size != new_size
    }

    fn prepare(&mut self, frame_data: &FrameData) -> Result<(), SkiaRenderingError> {
        let new_background = Background::from(frame_data.uniforms.background.clone());

        // Handle image loading if needed
        match &new_background {
            Background::Image { path } | Background::Wallpaper { path } => {
                if self.image_path.as_ref() != Some(path) || self.loaded_image.is_none() {
                    // For now, we'll do synchronous loading. In a real implementation,
                    // this should be async or cached at a higher level
                    match std::fs::read(path) {
                        Ok(image_data) => {
                            let data = skia_safe::Data::new_copy(&image_data);
                            if let Some(image) = Image::from_encoded(&data) {
                                self.loaded_image = Some(image);
                                self.image_path = Some(path.clone());
                            } else {
                                tracing::error!("Failed to decode image: {:?}", path);
                                return Err(SkiaRenderingError::Other(anyhow::anyhow!(
                                    "Failed to decode image"
                                )));
                            }
                        }
                        Err(e) => {
                            tracing::error!("Failed to load image: {:?}, error: {}", path, e);
                            return Err(SkiaRenderingError::Other(anyhow::anyhow!(
                                "Failed to load image: {}",
                                e
                            )));
                        }
                    }
                }
            }
            _ => {}
        }

        // Update current state (but not last_rendered, that happens in record())
        self.current_background = Some(new_background);
        self.current_border = frame_data.uniforms.border.clone();

        Ok(())
    }

    fn is_enabled(&self) -> bool {
        self.current_background.is_some()
    }
}

impl Default for BackgroundLayer {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_background_from_source() {
        // Test color conversion
        let color_source = BackgroundSource::Color {
            value: [65535, 32768, 0],
        };
        let color_bg = Background::from(color_source);
        assert!(matches!(color_bg, Background::Color([65535, 32768, 0])));

        // Test gradient conversion
        let gradient_source = BackgroundSource::Gradient {
            from: [65535, 0, 0],
            to: [0, 0, 65535],
            angle: 45,
        };
        let gradient_bg = Background::from(gradient_source);
        assert!(matches!(
            gradient_bg,
            Background::Gradient { angle: 45, .. }
        ));
    }

    #[test]
    fn test_needs_update() {
        let mut layer = BackgroundLayer::new();
        let uniforms = SkiaProjectUniforms {
            output_size: (800, 600),
            background: BackgroundSource::Color {
                value: [65535, 0, 0],
            },
            border: None,
        };

        // Should need update on first check
        assert!(layer.needs_update(&uniforms));

        // Prepare the layer
        let frame_data = FrameData {
            uniforms: uniforms.clone(),
            video_frame: None,
            camera_frame: None,
            cursor_position: None,
        };
        layer.prepare(&frame_data).unwrap();

        // Should not need update with same uniforms
        assert!(!layer.needs_update(&uniforms));

        // Should need update with different color
        let new_uniforms = SkiaProjectUniforms {
            output_size: (800, 600),
            background: BackgroundSource::Color {
                value: [0, 65535, 0],
            },
            border: None,
        };
        assert!(layer.needs_update(&new_uniforms));
    }
}
