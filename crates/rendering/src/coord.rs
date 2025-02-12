use std::ops::{Add, Deref, Mul, Sub};

use cap_project::{ProjectConfiguration, XY};

use crate::{ProjectUniforms, RenderOptions};

#[derive(Default, Clone, Copy, Debug)]
pub struct RawDisplaySpace;

// raw cursor data
#[derive(Default, Clone, Copy, Debug)]
pub struct RawDisplayUVSpace;

#[derive(Default, Clone, Copy, Debug)]
pub struct CroppedDisplaySpace;

#[derive(Default, Clone, Copy, Debug)]
pub struct FrameSpace;

#[derive(Default, Clone, Copy, Debug)]
pub struct TransformedDisplaySpace;

#[derive(Clone, Copy, Debug)]
pub struct Coord<TSpace> {
    pub coord: XY<f64>,
    pub space: TSpace,
}

impl<TSpace: Default> Coord<TSpace> {
    pub fn new(coord: XY<f64>) -> Self {
        Self {
            coord,
            space: TSpace::default(),
        }
    }

    pub fn clamp(self, min: XY<f64>, max: XY<f64>) -> Self {
        Self {
            coord: XY {
                x: self.coord.x.clamp(min.x, max.x),
                y: self.coord.y.clamp(min.y, max.y),
            },
            space: self.space,
        }
    }
}

impl<T> Deref for Coord<T> {
    type Target = XY<f64>;

    fn deref(&self) -> &Self::Target {
        &self.coord
    }
}

impl Coord<RawDisplayUVSpace> {
    pub fn to_raw_display_space(&self, options: &RenderOptions) -> Coord<RawDisplaySpace> {
        Coord::new(self.coord * options.screen_size.map(|v| v as f64))
    }

    pub fn to_frame_space(
        &self,
        options: &RenderOptions,
        project: &ProjectConfiguration,
        resolution_base: XY<u32>,
    ) -> Coord<FrameSpace> {
        self.to_raw_display_space(options)
            .to_cropped_display_space(options, project)
            .to_frame_space(options, project, resolution_base)
    }
}

impl Coord<RawDisplaySpace> {
    pub fn to_cropped_display_space(
        &self,
        options: &RenderOptions,
        project: &ProjectConfiguration,
    ) -> Coord<CroppedDisplaySpace> {
        let crop = ProjectUniforms::get_crop(options, project);
        Coord::new(self.coord - crop.position.map(|v| v as f64))
    }
}

impl Coord<CroppedDisplaySpace> {
    pub fn to_frame_space(
        &self,
        options: &RenderOptions,
        project: &ProjectConfiguration,
        resolution_base: XY<u32>,
    ) -> Coord<FrameSpace> {
        let padding = ProjectUniforms::get_display_offset(options, project, resolution_base);
        Coord::new(self.coord + *padding)
    }
}

impl<T> Add for Coord<T> {
    type Output = Self;

    fn add(self, rhs: Self) -> Self {
        Coord {
            coord: self.coord + rhs.coord,
            space: self.space,
        }
    }
}

impl<T> Sub for Coord<T> {
    type Output = Self;

    fn sub(self, rhs: Self) -> Self {
        Coord {
            coord: self.coord - rhs.coord,
            space: self.space,
        }
    }
}

impl<T> Mul<f64> for Coord<T> {
    type Output = Self;

    fn mul(self, rhs: f64) -> Self {
        Coord {
            coord: self.coord * rhs,
            space: self.space,
        }
    }
}
