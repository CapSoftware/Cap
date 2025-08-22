use cap_project::{CameraShape, CameraXPosition, CameraYPosition, Crop, ProjectConfiguration, XY};

use crate::{
    Coord, FrameSpace, RawDisplaySpace, ZoomedFrameSpace,
    RenderOptions, zoom::InterpolatedZoom, layout::InterpolatedLayout,
    cursor_interpolation::InterpolatedCursorPosition,
};

const CAMERA_PADDING: f32 = 50.0;
const SCREEN_MAX_PADDING: f64 = 0.4;

#[derive(Debug, Clone)]
pub struct LayoutCoordinates {
    pub display: DisplayCoordinates,
    pub camera: Option<CameraCoordinates>,
    pub camera_only: Option<CameraOnlyCoordinates>,
    pub cursor: Option<CursorCoordinates>,
    pub output_size: XY<u32>,
    pub resolution_base: XY<u32>,
}

#[derive(Debug, Clone)]
pub struct DisplayCoordinates {
    pub crop_start: Coord<RawDisplaySpace>,
    pub crop_end: Coord<RawDisplaySpace>,
    pub target_start: Coord<FrameSpace>,
    pub target_end: Coord<FrameSpace>,
    pub target_size: Coord<FrameSpace>,
    pub zoom_start: Coord<FrameSpace>,
    pub zoom_end: Coord<FrameSpace>,
}

#[derive(Debug, Clone)]
pub struct CameraCoordinates {
    pub position: Coord<FrameSpace>,
    pub size: Coord<FrameSpace>,
    pub target_start: Coord<FrameSpace>,
    pub target_end: Coord<FrameSpace>,
    pub crop_start: Coord<RawDisplaySpace>,
    pub crop_end: Coord<RawDisplaySpace>,
}

#[derive(Debug, Clone)]
pub struct CameraOnlyCoordinates {
    pub position: Coord<FrameSpace>,
    pub size: Coord<FrameSpace>,
    pub target_start: Coord<FrameSpace>,
    pub target_end: Coord<FrameSpace>,
    pub crop_start: Coord<RawDisplaySpace>,
    pub crop_end: Coord<RawDisplaySpace>,
}

#[derive(Debug, Clone)]
pub struct CursorCoordinates {
    pub position: Coord<ZoomedFrameSpace>,
    pub size: Coord<ZoomedFrameSpace>,
    pub hotspot: Coord<FrameSpace>,
    pub base_position: Coord<FrameSpace>,
    pub base_size: Coord<FrameSpace>,
}

impl LayoutCoordinates {
    pub fn calculate(
        options: &RenderOptions,
        project: &ProjectConfiguration,
        resolution_base: XY<u32>,
        zoom: &InterpolatedZoom,
        layout: &InterpolatedLayout,
        interpolated_cursor: Option<&InterpolatedCursorPosition>,
        cursor_size: f32,
    ) -> Self {
        let output_size = get_output_size(options, project, resolution_base);
        let output_size_xy = XY::new(output_size.0, output_size.1);

        // Calculate display coordinates
        let display = Self::calculate_display_coordinates(
            options, 
            project, 
            resolution_base, 
            output_size_xy, 
            zoom
        );

        // Calculate camera coordinates if should render
        let camera = if options.camera_size.is_some() 
            && !project.camera.hide 
            && layout.should_render_camera() 
        {
            Some(Self::calculate_camera_coordinates(
                options,
                project,
                output_size_xy,
                zoom,
                layout,
            ))
        } else {
            None
        };

        // Calculate camera-only coordinates if transitioning
        let camera_only = if options.camera_size.is_some()
            && !project.camera.hide
            && layout.is_transitioning_camera_only()
        {
            Some(Self::calculate_camera_only_coordinates(
                options,
                project,
                output_size_xy,
                layout,
            ))
        } else {
            None
        };

        // Calculate cursor coordinates if cursor is visible and available
        let cursor = if let Some(interpolated_cursor) = interpolated_cursor {
            if !project.cursor.hide {
                Some(Self::calculate_cursor_coordinates(
                    options,
                    project,
                    resolution_base,
                    zoom,
                    interpolated_cursor,
                    cursor_size,
                    &display,
                ))
            } else {
                None
            }
        } else {
            None
        };

        Self {
            display,
            camera,
            camera_only,
            cursor,
            output_size: output_size_xy,
            resolution_base,
        }
    }

    fn calculate_display_coordinates(
        options: &RenderOptions,
        project: &ProjectConfiguration,
        resolution_base: XY<u32>,
        output_size: XY<u32>,
        zoom: &InterpolatedZoom,
    ) -> DisplayCoordinates {
        let output_size_f64 = XY::new(output_size.x as f64, output_size.y as f64);
        let crop = get_crop(options, project);

        let crop_start = Coord::<RawDisplaySpace>::new(XY::new(
            crop.position.x as f64,
            crop.position.y as f64,
        ));
        let crop_end = Coord::<RawDisplaySpace>::new(XY::new(
            (crop.position.x + crop.size.x) as f64,
            (crop.position.y + crop.size.y) as f64,
        ));

        let display_offset = display_offset(options, project, resolution_base);
        let display_size = display_size(options, project, resolution_base);

        let target_end = Coord::new(output_size_f64) - display_offset;

        let (zoom_start, zoom_end) = (
            Coord::new(zoom.bounds.top_left * display_size.coord),
            Coord::new((zoom.bounds.bottom_right - 1.0) * display_size.coord),
        );

        let target_start = display_offset + zoom_start;
        let target_end = target_end + zoom_end;
        let target_size = target_end - target_start;

        DisplayCoordinates {
            crop_start,
            crop_end,
            target_start,
            target_end,
            target_size,
            zoom_start,
            zoom_end,
        }
    }

    fn calculate_camera_coordinates(
        options: &RenderOptions,
        project: &ProjectConfiguration,
        output_size: XY<u32>,
        zoom: &InterpolatedZoom,
        layout: &InterpolatedLayout,
    ) -> CameraCoordinates {
        let camera_size = options.camera_size.unwrap();
        let output_size = [output_size.x as f32, output_size.y as f32];
        let frame_size = [camera_size.x as f32, camera_size.y as f32];
        let min_axis = output_size[0].min(output_size[1]);

        let base_size = project.camera.size / 100.0;
        let zoom_size = project
            .camera
            .zoom_size
            .unwrap_or(cap_project::Camera::default_zoom_size())
            / 100.0;

        let zoomed_size =
            (zoom.t as f32) * zoom_size * base_size + (1.0 - zoom.t as f32) * base_size;

        let zoomed_size = zoomed_size * layout.camera_scale as f32;

        let aspect = frame_size[0] / frame_size[1];
        let size = match project.camera.shape {
            CameraShape::Source => {
                if aspect >= 1.0 {
                    [
                        (min_axis * zoomed_size + CAMERA_PADDING) * aspect,
                        min_axis * zoomed_size + CAMERA_PADDING,
                    ]
                } else {
                    [
                        min_axis * zoomed_size + CAMERA_PADDING,
                        (min_axis * zoomed_size + CAMERA_PADDING) / aspect,
                    ]
                }
            }
            CameraShape::Square => [
                min_axis * zoomed_size + CAMERA_PADDING,
                min_axis * zoomed_size + CAMERA_PADDING,
            ],
        };

        let position = {
            let x = match &project.camera.position.x {
                CameraXPosition::Left => CAMERA_PADDING,
                CameraXPosition::Center => output_size[0] / 2.0 - (size[0]) / 2.0,
                CameraXPosition::Right => output_size[0] - CAMERA_PADDING - size[0],
            };
            let y = match &project.camera.position.y {
                CameraYPosition::Top => CAMERA_PADDING,
                CameraYPosition::Bottom => output_size[1] - size[1] - CAMERA_PADDING,
            };

            [x, y]
        };

        let target_start = Coord::new(XY::new(position[0] as f64, position[1] as f64));
        let target_end = Coord::new(XY::new(
            (position[0] + size[0]) as f64,
            (position[1] + size[1]) as f64,
        ));

        let crop_start;
        let crop_end;
        
        match project.camera.shape {
            CameraShape::Source => {
                crop_start = Coord::new(XY::new(0.0, 0.0));
                crop_end = Coord::new(XY::new(frame_size[0] as f64, frame_size[1] as f64));
            }
            CameraShape::Square => {
                crop_start = Coord::new(XY::new(
                    ((frame_size[0] - frame_size[1]) / 2.0) as f64,
                    0.0,
                ));
                crop_end = Coord::new(XY::new(
                    (frame_size[0] - (frame_size[0] - frame_size[1]) / 2.0) as f64,
                    frame_size[1] as f64,
                ));
            }
        }

        CameraCoordinates {
            position: target_start,
            size: Coord::new(XY::new(size[0] as f64, size[1] as f64)),
            target_start,
            target_end,
            crop_start,
            crop_end,
        }
    }

    fn calculate_camera_only_coordinates(
        options: &RenderOptions,
        project: &ProjectConfiguration,
        output_size: XY<u32>,
        layout: &InterpolatedLayout,
    ) -> CameraOnlyCoordinates {
        let camera_size = options.camera_size.unwrap();
        let output_size = [output_size.x as f32, output_size.y as f32];
        let frame_size = [camera_size.x as f32, camera_size.y as f32];

        let aspect = frame_size[0] / frame_size[1];
        let output_aspect = output_size[0] / output_size[1];

        let zoom_factor = layout.camera_only_zoom as f32;
        let size = [output_size[0] * zoom_factor, output_size[1] * zoom_factor];

        let position = [
            (output_size[0] - size[0]) / 2.0,
            (output_size[1] - size[1]) / 2.0,
        ];

        let target_start = Coord::new(XY::new(position[0] as f64, position[1] as f64));
        let target_end = Coord::new(XY::new(
            (position[0] + size[0]) as f64,
            (position[1] + size[1]) as f64,
        ));

        // In camera-only mode, we ignore the camera shape setting (Square/Source)
        // and just apply the minimum crop needed to fill the output aspect ratio.
        let crop_start;
        let crop_end;
        
        if aspect > output_aspect {
            // Camera is wider than output - crop left and right
            let visible_width = frame_size[1] * output_aspect;
            let crop_x = (frame_size[0] - visible_width) / 2.0;
            crop_start = Coord::new(XY::new(crop_x as f64, 0.0));
            crop_end = Coord::new(XY::new((frame_size[0] - crop_x) as f64, frame_size[1] as f64));
        } else {
            // Camera is taller than output - crop top and bottom
            let visible_height = frame_size[0] / output_aspect;
            let crop_y = (frame_size[1] - visible_height) / 2.0;
            crop_start = Coord::new(XY::new(0.0, crop_y as f64));
            crop_end = Coord::new(XY::new(frame_size[0] as f64, (frame_size[1] - crop_y) as f64));
        }

        CameraOnlyCoordinates {
            position: target_start,
            size: Coord::new(XY::new(size[0] as f64, size[1] as f64)),
            target_start,
            target_end,
            crop_start,
            crop_end,
        }
    }

    fn calculate_cursor_coordinates(
        options: &RenderOptions,
        project: &ProjectConfiguration,
        resolution_base: XY<u32>,
        zoom: &InterpolatedZoom,
        interpolated_cursor: &InterpolatedCursorPosition,
        cursor_size: f32,
        _display: &DisplayCoordinates,
    ) -> CursorCoordinates {
        // Calculate base cursor size (before zoom transformation)
        let base_size_px = crate::STANDARD_CURSOR_HEIGHT / options.screen_size.y as f32
            * (get_output_size(options, project, resolution_base).1 as f32);

        let cursor_size_factor = if cursor_size <= 0.0 {
            100.0
        } else {
            cursor_size / 100.0
        };

        let size = base_size_px * cursor_size_factor;

        // We'll assume square cursor for now - this will be adjusted for actual texture aspect ratio in the cursor layer
        let base_size = Coord::<FrameSpace>::new(XY::new(size as f64, size as f64));
        let hotspot = Coord::<FrameSpace>::new(base_size.coord * 0.5); // Assume center hotspot for now

        // Calculate position without hotspot first
        let base_position = interpolated_cursor.position.to_frame_space(
            options,
            project,
            resolution_base,
        ) - hotspot;

        // Transform to zoomed space
        let zoomed_position = base_position.to_zoomed_frame_space(
            options,
            project,
            resolution_base,
            zoom,
        );

        let zoomed_size = (base_position + base_size).to_zoomed_frame_space(
            options,
            project,
            resolution_base,
            zoom,
        ) - zoomed_position;

        CursorCoordinates {
            position: zoomed_position,
            size: zoomed_size,
            hotspot,
            base_position,
            base_size,
        }
    }
}

// Helper functions moved from ProjectUniforms
pub fn get_crop(options: &RenderOptions, project: &ProjectConfiguration) -> Crop {
    project.background.crop.as_ref().cloned().unwrap_or(Crop {
        position: XY { x: 0, y: 0 },
        size: XY {
            x: options.screen_size.x,
            y: options.screen_size.y,
        },
    })
}

pub fn get_output_size(
    options: &RenderOptions,
    project: &ProjectConfiguration,
    resolution_base: XY<u32>,
) -> (u32, u32) {
    let crop = get_crop(options, project);
    let crop_aspect = crop.aspect_ratio();

    let (base_width, base_height) = match &project.aspect_ratio {
        None => {
            let padding_basis = u32::max(crop.size.x, crop.size.y) as f64;
            let padding =
                padding_basis * project.background.padding / 100.0 * SCREEN_MAX_PADDING * 2.0;
            let width = ((crop.size.x as f64 + padding) as u32 + 1) & !1;
            let height = ((crop.size.y as f64 + padding) as u32 + 1) & !1;
            (width, height)
        }
        Some(cap_project::AspectRatio::Square) => {
            let size = if crop_aspect > 1.0 {
                crop.size.y
            } else {
                crop.size.x
            };
            (size, size)
        }
        Some(cap_project::AspectRatio::Wide) => {
            if crop_aspect > 16.0 / 9.0 {
                (((crop.size.y as f32 * 16.0 / 9.0) as u32), crop.size.y)
            } else {
                (crop.size.x, ((crop.size.x as f32 * 9.0 / 16.0) as u32))
            }
        }
        Some(cap_project::AspectRatio::Vertical) => {
            if crop_aspect > 9.0 / 16.0 {
                ((crop.size.y as f32 * 9.0 / 16.0) as u32, crop.size.y)
            } else {
                (crop.size.x, ((crop.size.x as f32 * 16.0 / 9.0) as u32))
            }
        }
        Some(cap_project::AspectRatio::Classic) => {
            if crop_aspect > 4.0 / 3.0 {
                ((crop.size.y as f32 * 4.0 / 3.0) as u32, crop.size.y)
            } else {
                (crop.size.x, ((crop.size.x as f32 * 3.0 / 4.0) as u32))
            }
        }
        Some(cap_project::AspectRatio::Tall) => {
            if crop_aspect > 3.0 / 4.0 {
                ((crop.size.y as f32 * 3.0 / 4.0) as u32, crop.size.y)
            } else {
                (crop.size.x, ((crop.size.x as f32 * 4.0 / 3.0) as u32))
            }
        }
    };

    let width_scale = resolution_base.x as f32 / base_width as f32;
    let height_scale = resolution_base.y as f32 / base_height as f32;
    let scale = width_scale.min(height_scale);

    let scaled_width = ((base_width as f32 * scale) as u32 + 1) & !1;
    let scaled_height = ((base_height as f32 * scale) as u32 + 1) & !1;
    (scaled_width, scaled_height)
}

pub fn display_offset(
    options: &RenderOptions,
    project: &ProjectConfiguration,
    resolution_base: XY<u32>,
) -> Coord<FrameSpace> {
    let output_size = get_output_size(options, project, resolution_base);
    let output_size = XY::new(output_size.0 as f64, output_size.1 as f64);

    let output_aspect = output_size.x / output_size.y;

    let crop = get_crop(options, project);

    let crop_start =
        Coord::<RawDisplaySpace>::new(XY::new(crop.position.x as f64, crop.position.y as f64));
    let crop_end = Coord::<RawDisplaySpace>::new(XY::new(
        (crop.position.x + crop.size.x) as f64,
        (crop.position.y + crop.size.y) as f64,
    ));

    let cropped_size = crop_end.coord - crop_start.coord;

    let cropped_aspect = cropped_size.x / cropped_size.y;

    let padding = {
        let padding_factor = project.background.padding / 100.0 * SCREEN_MAX_PADDING;

        f64::max(output_size.x, output_size.y) * padding_factor
    };

    let is_height_constrained = cropped_aspect <= output_aspect;

    let available_size = output_size - 2.0 * padding;

    let target_size = if is_height_constrained {
        XY::new(available_size.y * cropped_aspect, available_size.y)
    } else {
        XY::new(available_size.x, available_size.x / cropped_aspect)
    };

    let target_offset = (output_size - target_size) / 2.0;

    Coord::new(if is_height_constrained {
        XY::new(target_offset.x, padding)
    } else {
        XY::new(padding, target_offset.y)
    })
}

pub fn display_size(
    options: &RenderOptions,
    project: &ProjectConfiguration,
    resolution_base: XY<u32>,
) -> Coord<FrameSpace> {
    let output_size = get_output_size(options, project, resolution_base);
    let output_size = XY::new(output_size.0 as f64, output_size.1 as f64);

    let display_offset = display_offset(options, project, resolution_base);

    let end = Coord::new(output_size) - display_offset;

    end - display_offset
}

#[cfg(test)]
mod tests {
    use super::*;
    use cap_project::{AspectRatio};
    use crate::layout::InterpolatedLayout;
    use crate::zoom::InterpolatedZoom;

    fn create_minimal_project() -> ProjectConfiguration {
        // Use default values to avoid missing field errors
        let mut project = ProjectConfiguration::default();
        
        // Customize only what we need for testing
        project.background.padding = 20.0;
        project.camera.hide = false;
        project.camera.size = 25.0;
        project.cursor.hide = false;
        project.cursor.size = 100; // u32 type
        
        project
    }

    fn create_test_options() -> RenderOptions {
        RenderOptions {
            screen_size: XY::new(1920, 1080),
            camera_size: Some(XY::new(640, 480)),
        }
    }

    #[test]
    fn test_get_output_size_no_aspect_ratio() {
        let project = create_minimal_project();
        let options = create_test_options();
        let resolution_base = XY::new(1920, 1080);

        let (width, height) = get_output_size(&options, &project, resolution_base);
        
        // Should be even numbers and greater than 0
        assert!(width > 0 && width % 2 == 0);
        assert!(height > 0 && height % 2 == 0);
        
        // With padding, the output size is typically larger than screen size,
        // but with scaling it might be smaller, so just ensure it's reasonable
        assert!(width <= resolution_base.x * 2); // Not ridiculously large
        assert!(height <= resolution_base.y * 2);
    }

    #[test]
    fn test_get_output_size_square_aspect() {
        let mut project = create_minimal_project();
        project.aspect_ratio = Some(AspectRatio::Square);
        let options = create_test_options();
        let resolution_base = XY::new(1920, 1080);

        let (width, height) = get_output_size(&options, &project, resolution_base);
        
        // Square aspect ratio should produce equal width and height
        assert_eq!(width, height);
    }

    #[test]
    fn test_display_offset_calculation() {
        let project = create_minimal_project();
        let options = create_test_options();
        let resolution_base = XY::new(1920, 1080);

        let offset = display_offset(&options, &project, resolution_base);
        
        // Offset should be positive (padding applied)
        assert!(offset.x >= 0.0);
        assert!(offset.y >= 0.0);
    }

    #[test]
    fn test_layout_coordinates_calculation() {
        let project = create_minimal_project();
        let options = create_test_options();
        let resolution_base = XY::new(1920, 1080);

        // Create default zoom and layout for testing
        let zoom = InterpolatedZoom { 
            t: 0.0, 
            bounds: crate::zoom::SegmentBounds::default() 
        };
        let layout = InterpolatedLayout {
            camera_opacity: 1.0,
            screen_opacity: 1.0,
            camera_scale: 1.0,
            layout_mode: cap_project::LayoutMode::Default,
            transition_progress: 0.0,
            from_mode: cap_project::LayoutMode::Default,
            to_mode: cap_project::LayoutMode::Default,
            screen_blur: 0.0,
            camera_only_zoom: 1.0,
            camera_only_blur: 0.0,
        };

        let layout_coords = LayoutCoordinates::calculate(
            &options,
            &project,
            resolution_base,
            &zoom,
            &layout,
            None, // No cursor
            100.0, // cursor size
        );

        // Basic sanity checks
        assert!(layout_coords.output_size.x > 0);
        assert!(layout_coords.output_size.y > 0);
        assert_eq!(layout_coords.resolution_base, resolution_base);

        // Display coordinates should be valid
        assert!(layout_coords.display.crop_start.x >= 0.0);
        assert!(layout_coords.display.crop_start.y >= 0.0);
        assert!(layout_coords.display.target_size.x > 0.0);
        assert!(layout_coords.display.target_size.y > 0.0);

        // Camera should be present since hide = false and should_render_camera = true
        assert!(layout_coords.camera.is_some());
        let camera_coords = layout_coords.camera.unwrap();
        assert!(camera_coords.size.x > 0.0);
        assert!(camera_coords.size.y > 0.0);

        // Camera-only should be None since not transitioning
        assert!(layout_coords.camera_only.is_none());

        // Cursor should be None since no interpolated cursor provided
        assert!(layout_coords.cursor.is_none());
    }

    #[test]
    fn test_camera_coordinates_square_shape() {
        let mut project = create_minimal_project();
        project.camera.shape = cap_project::CameraShape::Square;
        let options = create_test_options();
        let output_size = XY::new(1920, 1080);

        let zoom = InterpolatedZoom { 
            t: 0.0, 
            bounds: crate::zoom::SegmentBounds::default() 
        };
        let layout = InterpolatedLayout {
            camera_opacity: 1.0,
            screen_opacity: 1.0,
            camera_scale: 1.0,
            layout_mode: cap_project::LayoutMode::Default,
            transition_progress: 0.0,
            from_mode: cap_project::LayoutMode::Default,
            to_mode: cap_project::LayoutMode::Default,
            screen_blur: 0.0,
            camera_only_zoom: 1.0,
            camera_only_blur: 0.0,
        };

        let camera_coords = LayoutCoordinates::calculate_camera_coordinates(
            &options,
            &project,
            output_size,
            &zoom,
            &layout,
        );

        // For square shape, the crop should center the camera feed
        let crop_width = camera_coords.crop_end.x - camera_coords.crop_start.x;
        let crop_height = camera_coords.crop_end.y - camera_coords.crop_start.y;
        
        // Square crop should have equal width and height
        assert!((crop_width - crop_height).abs() < 1.0); // Allow small floating point differences
    }
}