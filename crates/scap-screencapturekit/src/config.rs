use cidre::{arc, cg, cm, sc};

pub struct StreamCfgBuilder(arc::R<sc::StreamCfg>);

impl StreamCfgBuilder {
    /// Logical width of the capture area
    pub fn set_width(&mut self, width: usize) {
        self.0.set_width(width);
    }

    /// Logical height of the capture area
    pub fn set_height(&mut self, height: usize) {
        self.0.set_height(height);
    }

    /// Logical source rect within the capture area
    pub fn set_src_rect(&mut self, rect: cg::Rect) {
        self.0.set_src_rect(rect);
    }

    pub fn set_shows_cursor(&mut self, shows_cursor: bool) {
        self.0.set_shows_cursor(shows_cursor);
    }

    pub fn set_fps(&mut self, fps: f32) {
        self.0.set_minimum_frame_interval(cm::Time {
            value: (1000.0 / fps) as i64,
            scale: 1000,
            epoch: 0,
            flags: cm::TimeFlags::VALID,
        });
    }

    pub fn set_captures_audio(&mut self, captures_audio: bool) {
        self.0.set_captures_audio(captures_audio);
    }

    /// Sets the queue depth (number of frames to buffer).
    /// Higher values provide more tolerance for processing delays but use more memory.
    /// Apple's default is 3. Maximum is 8.
    pub fn set_queue_depth(&mut self, depth: isize) {
        self.0.set_queue_depth(depth.min(8));
    }

    /// Logical width of the capture area
    pub fn with_width(mut self, width: usize) -> Self {
        self.set_width(width);
        self
    }

    /// Logical height of the capture area
    pub fn with_height(mut self, height: usize) -> Self {
        self.set_height(height);
        self
    }

    /// Logical source rect within the capture area
    pub fn with_src_rect(mut self, rect: cg::Rect) -> Self {
        self.set_src_rect(rect);
        self
    }

    pub fn with_shows_cursor(mut self, shows_cursor: bool) -> Self {
        self.set_shows_cursor(shows_cursor);
        self
    }

    pub fn with_captures_audio(mut self, captures_audio: bool) -> Self {
        self.set_captures_audio(captures_audio);
        self
    }

    pub fn with_fps(mut self, fps: f32) -> Self {
        self.set_fps(fps);
        self
    }

    pub fn with_queue_depth(mut self, depth: isize) -> Self {
        self.set_queue_depth(depth);
        self
    }

    pub fn build(self) -> arc::R<sc::StreamCfg> {
        self.0
    }
}

impl Default for StreamCfgBuilder {
    fn default() -> Self {
        Self(sc::StreamCfg::new())
    }
}
