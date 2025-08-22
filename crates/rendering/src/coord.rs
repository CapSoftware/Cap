use std::ops::{Add, Deref, Mul, Sub, SubAssign};

use cap_project::{ProjectConfiguration, XY};

use crate::{
    layout_coordinates::{get_crop, get_output_size, display_offset, display_size},
    zoom::InterpolatedZoom, RenderOptions,
};

/// Coordinate system for display frames
/// `(0, 0)` is the top left of the frame,
/// not the top left of the display
#[derive(Default, Clone, Copy, Debug)]
pub struct RawDisplaySpace;

/// Same as `RawDisplaySpace` except UV (0<->1)
/// Cursor positions are stored as this
#[derive(Default, Clone, Copy, Debug)]
pub struct RawDisplayUVSpace;

/// Coordinate system for display frames after they've been croppped.
/// `(0, 0)` is the top left of the crop.
/// The top left of the raw display would be negative
#[derive(Default, Clone, Copy, Debug)]
pub struct CroppedDisplaySpace;

/// Coordinate system for rendered frames.
/// `(0, 0)` is the top left of the final frame.
/// Going from CroppedDisplaySpace to FrameSpace will account for padding.
/// Cursor positions are defined in this coordinate space.
///
/// Rendered frame size is calculated before inner layouts,
/// so this can be used during layout calculations.
#[derive(Default, Clone, Copy, Debug)]
pub struct FrameSpace;

/// Coordinate system for FrameSpace coordinates after zoom has been interpolated and applied.
/// (0, 0) is the top left of the frame itself,
/// so after a zoom is applied the original top left will likely be negative.
///
/// Used to account for zoom in calculating cursor positions.
#[derive(Default, Clone, Copy, Debug)]
pub struct ZoomedFrameSpace;

#[derive(Clone, Copy, Debug, Default)]
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
        let crop = get_crop(options, project);
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
        let crop = get_crop(options, project);
        let output_size = get_output_size(options, project, resolution_base);
        let padding_offset = display_offset(options, project, resolution_base);

        let output_size = XY::new(output_size.0, output_size.1).map(|v| v as f64);

        let position_ratio = self.coord / crop.size.map(|v| v as f64);

        Coord::new(
            padding_offset.coord + (output_size - padding_offset.coord * 2.0) * position_ratio,
        )
    }
}

impl Coord<FrameSpace> {
    pub fn to_zoomed_frame_space(
        &self,
        options: &RenderOptions,
        project: &ProjectConfiguration,
        resolution_base: XY<u32>,
        zoom: &InterpolatedZoom,
    ) -> Coord<ZoomedFrameSpace> {
        let padding_offset = display_offset(options, project, resolution_base);
        let display_size = display_size(options, project, resolution_base);

        let size_ratio = zoom.bounds.bottom_right - zoom.bounds.top_left;

        let screen_position = (*self - padding_offset).coord;

        Coord::new(
            screen_position * size_ratio
                + zoom.bounds.top_left * display_size.coord
                + padding_offset.coord,
        )
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

impl<T> SubAssign for Coord<T> {
    fn sub_assign(&mut self, rhs: Self) {
        self.coord -= rhs.coord;
    }
}
