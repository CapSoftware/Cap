use crate::SkiaRenderingError;
use skia_safe::{Canvas, Picture, PictureRecorder, Rect};
use std::collections::HashMap;

pub mod background;

pub use background::BackgroundLayer;

/// Project uniforms for Skia rendering (placeholder for now)
#[derive(Debug, Clone)]
pub struct SkiaProjectUniforms {
    pub output_size: (u32, u32),
    pub background: cap_project::BackgroundSource,
    pub border: Option<cap_project::BorderConfiguration>,
    // Add more fields as needed
}

/// Frame data passed to layers during preparation
pub struct FrameData {
    pub uniforms: SkiaProjectUniforms,
    pub video_frame: Option<Vec<u8>>,
    pub camera_frame: Option<Vec<u8>>,
    pub cursor_position: Option<(f32, f32)>,
}

/// Unique identifier for layers
pub type LayerId = usize;

/// Records drawing commands for deferred playback
pub trait RecordableLayer: Send {
    /// Record drawing commands without immediate execution
    fn record(
        &mut self,
        recorder: &mut PictureRecorder,
        bounds: Rect,
        uniforms: &SkiaProjectUniforms,
    ) -> Option<Picture>;

    /// Indicates if this layer's content changed and needs re-recording
    fn needs_update(&self, uniforms: &SkiaProjectUniforms) -> bool;

    /// Prepare any resources needed for this frame (e.g., load images)
    fn prepare(&mut self, _frame_data: &FrameData) -> Result<(), SkiaRenderingError> {
        Ok(())
    }

    /// Whether this layer should be rendered at all
    fn is_enabled(&self) -> bool {
        true
    }
}

/// Direct canvas rendering for dynamic content
pub trait ImmediateLayer: Send {
    /// Render directly to the provided canvas
    fn render(&self, canvas: &Canvas, uniforms: &SkiaProjectUniforms);

    /// Prepare any resources needed for this frame
    fn prepare(&mut self, _frame_data: &FrameData) -> Result<(), SkiaRenderingError> {
        Ok(())
    }

    /// Whether this layer should be rendered at all
    fn is_enabled(&self) -> bool {
        true
    }
}

/// Layer that renders to an intermediate surface (for effects like blur)
pub trait SurfaceLayer: Send {
    /// Render to own surface, return picture for compositing
    fn render_to_surface(&mut self, uniforms: &SkiaProjectUniforms) -> Option<Picture>;

    /// Composite this layer's output onto the target canvas
    fn composite(&self, canvas: &Canvas, picture: &Picture, uniforms: &SkiaProjectUniforms);

    /// Prepare any resources needed for this frame
    fn prepare(&mut self, _frame_data: &FrameData) -> Result<(), SkiaRenderingError> {
        Ok(())
    }

    /// Whether this layer should be rendered at all
    fn is_enabled(&self) -> bool {
        true
    }
}

/// Layer entry in the stack
pub enum LayerEntry {
    Immediate(Box<dyn ImmediateLayer>),
    Recorded(Box<dyn RecordableLayer>),
    Surface(Box<dyn SurfaceLayer>),
}

/// Optimized layer stack with caching
pub struct LayerStack {
    layers: Vec<(LayerId, LayerEntry)>,
    picture_cache: HashMap<LayerId, Picture>,
    next_id: LayerId,
}

impl LayerStack {
    pub fn new() -> Self {
        Self {
            layers: Vec::new(),
            picture_cache: HashMap::new(),
            next_id: 0,
        }
    }

    /// Add a recordable layer (for static/semi-static content)
    pub fn add_recorded(&mut self, layer: Box<dyn RecordableLayer>) -> LayerId {
        let id = self.next_id;
        self.next_id += 1;
        self.layers.push((id, LayerEntry::Recorded(layer)));
        id
    }

    /// Add an immediate layer (for dynamic content)
    pub fn add_immediate(&mut self, layer: Box<dyn ImmediateLayer>) -> LayerId {
        let id = self.next_id;
        self.next_id += 1;
        self.layers.push((id, LayerEntry::Immediate(layer)));
        id
    }

    /// Add a surface layer (for effects)
    pub fn add_surface(&mut self, layer: Box<dyn SurfaceLayer>) -> LayerId {
        let id = self.next_id;
        self.next_id += 1;
        self.layers.push((id, LayerEntry::Surface(layer)));
        id
    }

    /// Prepare all layers for the next frame
    pub async fn prepare(&mut self, frame_data: &FrameData) -> Result<(), SkiaRenderingError> {
        for (_, layer) in &mut self.layers {
            match layer {
                LayerEntry::Immediate(layer) => layer.prepare(frame_data)?,
                LayerEntry::Recorded(layer) => layer.prepare(frame_data)?,
                LayerEntry::Surface(layer) => layer.prepare(frame_data)?,
            }
        }
        Ok(())
    }

    /// Render all layers to the canvas
    pub fn render(&mut self, canvas: &Canvas, uniforms: &SkiaProjectUniforms) {
        let bounds = canvas.local_clip_bounds().unwrap_or_else(|| {
            Rect::from_xywh(
                0.0,
                0.0,
                uniforms.output_size.0 as f32,
                uniforms.output_size.1 as f32,
            )
        });

        for (id, layer) in &mut self.layers {
            match layer {
                LayerEntry::Immediate(layer) => {
                    if layer.is_enabled() {
                        canvas.save();
                        layer.render(canvas, uniforms);
                        canvas.restore();
                    }
                }
                LayerEntry::Recorded(layer) => {
                    if !layer.is_enabled() {
                        continue;
                    }

                    // Check if we need to re-record
                    if layer.needs_update(uniforms) || !self.picture_cache.contains_key(id) {
                        let mut recorder = PictureRecorder::new();
                        if let Some(picture) = layer.record(&mut recorder, bounds, uniforms) {
                            self.picture_cache.insert(*id, picture);
                        }
                    }

                    // Play back the cached picture
                    if let Some(picture) = self.picture_cache.get(id) {
                        canvas.draw_picture(picture, None, None);
                    }
                }
                LayerEntry::Surface(layer) => {
                    if layer.is_enabled()
                        && let Some(picture) = layer.render_to_surface(uniforms)
                    {
                        layer.composite(canvas, &picture, uniforms);
                    }
                }
            }
        }
    }

    /// Clear cached pictures for all layers
    pub fn clear_cache(&mut self) {
        self.picture_cache.clear();
    }

    /// Clear cache for a specific layer
    pub fn invalidate_layer(&mut self, id: LayerId) {
        self.picture_cache.remove(&id);
    }
}

impl Default for LayerStack {
    fn default() -> Self {
        Self::new()
    }
}
