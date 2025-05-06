use core_graphics::display::CGDisplay;

#[derive(Clone, Copy)]
pub struct DisplayImpl(CGDisplay);

impl DisplayImpl {
    pub fn primary() -> Self {
        Self(CGDisplay::main())
    }

    pub fn list() -> Vec<Self> {
        CGDisplay::active_displays()
            .into_iter()
            .flatten()
            .map(|v| Self(CGDisplay::new(v)))
            .collect()
    }

    pub fn inner(&self) -> CGDisplay {
        self.0
    }
}
