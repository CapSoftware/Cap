use scap_targets::{
    DisplayId,
    bounds::{PhysicalBounds, PhysicalPosition, PhysicalSize},
};

#[derive(Debug, Clone, PartialEq)]
pub struct DesktopAreaRegion {
    pub display_id: DisplayId,
    pub source_left: u32,
    pub source_top: u32,
    pub source_width: u32,
    pub source_height: u32,
    pub dest_x: u32,
    pub dest_y: u32,
}

#[derive(Debug, Clone, PartialEq)]
pub struct DesktopAreaPlan {
    pub desktop_bounds: PhysicalBounds,
    pub canvas_width: u32,
    pub canvas_height: u32,
    pub regions: Vec<DesktopAreaRegion>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct IntRect {
    left: i64,
    top: i64,
    right: i64,
    bottom: i64,
}

impl IntRect {
    fn from_physical(bounds: PhysicalBounds) -> Option<Self> {
        let x = bounds.position().x();
        let y = bounds.position().y();
        let width = bounds.size().width();
        let height = bounds.size().height();
        if !x.is_finite()
            || !y.is_finite()
            || !width.is_finite()
            || !height.is_finite()
            || width <= 0.0
            || height <= 0.0
        {
            return None;
        }
        let left = x.round() as i64;
        let top = y.round() as i64;
        let right = (x + width).round() as i64;
        let bottom = (y + height).round() as i64;
        (right > left && bottom > top).then_some(Self {
            left,
            top,
            right,
            bottom,
        })
    }

    fn intersect(self, other: Self) -> Option<Self> {
        let left = self.left.max(other.left);
        let top = self.top.max(other.top);
        let right = self.right.min(other.right);
        let bottom = self.bottom.min(other.bottom);
        (right > left && bottom > top).then_some(Self {
            left,
            top,
            right,
            bottom,
        })
    }

    fn adjacent_to(self, other: Self) -> bool {
        let vertical_overlap = self.bottom.min(other.bottom) > self.top.max(other.top);
        let horizontal_overlap = self.right.min(other.right) > self.left.max(other.left);
        ((self.right == other.left || other.right == self.left) && vertical_overlap)
            || ((self.bottom == other.top || other.bottom == self.top) && horizontal_overlap)
    }
}

pub fn monitors_are_adjacent(a: PhysicalBounds, b: PhysicalBounds) -> bool {
    let (Some(a), Some(b)) = (IntRect::from_physical(a), IntRect::from_physical(b)) else {
        return false;
    };
    a.adjacent_to(b)
}

pub fn monitors_are_connected(monitors: &[PhysicalBounds]) -> bool {
    let rects: Vec<IntRect> = monitors
        .iter()
        .filter_map(|bounds| IntRect::from_physical(*bounds))
        .collect();
    if rects.len() != monitors.len() || rects.is_empty() {
        return false;
    }
    connected_int_rects(&rects)
}

fn connected_int_rects(rects: &[IntRect]) -> bool {
    if rects.len() <= 1 {
        return !rects.is_empty();
    }
    let mut visited = vec![false; rects.len()];
    let mut stack = vec![0usize];
    visited[0] = true;
    while let Some(current) = stack.pop() {
        for next in 0..rects.len() {
            if !visited[next] && rects[current].adjacent_to(rects[next]) {
                visited[next] = true;
                stack.push(next);
            }
        }
    }
    visited.into_iter().all(|seen| seen)
}

pub fn resolve_desktop_area_plan(
    selection: PhysicalBounds,
    monitors: &[(DisplayId, PhysicalBounds)],
) -> Option<DesktopAreaPlan> {
    let selection = IntRect::from_physical(selection)?;

    let mut pieces: Vec<(DisplayId, IntRect, IntRect)> = Vec::new();
    for (display_id, bounds) in monitors {
        let Some(monitor_rect) = IntRect::from_physical(*bounds) else {
            continue;
        };
        if let Some(overlap) = selection.intersect(monitor_rect) {
            pieces.push((display_id.clone(), monitor_rect, overlap));
        }
    }

    if pieces.is_empty() {
        return None;
    }

    let monitor_rects: Vec<IntRect> = pieces.iter().map(|(_, rect, _)| *rect).collect();
    if !connected_int_rects(&monitor_rects) {
        return None;
    }

    let min_x = pieces.iter().map(|(_, _, r)| r.left).min()?;
    let min_y = pieces.iter().map(|(_, _, r)| r.top).min()?;
    let max_x = pieces.iter().map(|(_, _, r)| r.right).max()?;
    let max_y = pieces.iter().map(|(_, _, r)| r.bottom).max()?;

    let raw_width = u32::try_from(max_x - min_x).ok()?;
    let raw_height = u32::try_from(max_y - min_y).ok()?;
    let canvas_width = raw_width & !1;
    let canvas_height = raw_height & !1;
    if canvas_width < 2 || canvas_height < 2 {
        return None;
    }

    let canvas_rect = IntRect {
        left: min_x,
        top: min_y,
        right: min_x + i64::from(canvas_width),
        bottom: min_y + i64::from(canvas_height),
    };

    let mut regions = Vec::with_capacity(pieces.len());
    for (display_id, monitor_rect, overlap) in pieces {
        let Some(clipped) = overlap.intersect(canvas_rect) else {
            continue;
        };
        let source_left = u32::try_from(clipped.left - monitor_rect.left).ok()?;
        let source_top = u32::try_from(clipped.top - monitor_rect.top).ok()?;
        let source_width = u32::try_from(clipped.right - clipped.left).ok()?;
        let source_height = u32::try_from(clipped.bottom - clipped.top).ok()?;
        let dest_x = u32::try_from(clipped.left - min_x).ok()?;
        let dest_y = u32::try_from(clipped.top - min_y).ok()?;
        regions.push(DesktopAreaRegion {
            display_id,
            source_left,
            source_top,
            source_width,
            source_height,
            dest_x,
            dest_y,
        });
    }

    if regions.is_empty() {
        return None;
    }

    Some(DesktopAreaPlan {
        desktop_bounds: PhysicalBounds::new(
            PhysicalPosition::new(min_x as f64, min_y as f64),
            PhysicalSize::new(f64::from(canvas_width), f64::from(canvas_height)),
        ),
        canvas_width,
        canvas_height,
        regions,
    })
}

pub fn desktop_area_cursor_crop(
    anchor_display_bounds: PhysicalBounds,
    plan: &DesktopAreaPlan,
) -> PhysicalBounds {
    PhysicalBounds::new(
        PhysicalPosition::new(
            plan.desktop_bounds.position().x() - anchor_display_bounds.position().x(),
            plan.desktop_bounds.position().y() - anchor_display_bounds.position().y(),
        ),
        PhysicalSize::new(f64::from(plan.canvas_width), f64::from(plan.canvas_height)),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn id(value: &str) -> DisplayId {
        value.parse().unwrap()
    }

    fn phys(x: f64, y: f64, width: f64, height: f64) -> PhysicalBounds {
        PhysicalBounds::new(
            PhysicalPosition::new(x, y),
            PhysicalSize::new(width, height),
        )
    }

    #[test]
    fn resolves_two_adjacent_same_dpi_monitors() {
        let monitors = vec![
            (id("1"), phys(0.0, 0.0, 1920.0, 1080.0)),
            (id("2"), phys(1920.0, 0.0, 1920.0, 1080.0)),
        ];
        let plan =
            resolve_desktop_area_plan(phys(1400.0, 100.0, 1000.0, 600.0), &monitors).unwrap();

        assert_eq!(plan.canvas_width, 1000);
        assert_eq!(plan.canvas_height, 600);
        assert_eq!(plan.desktop_bounds, phys(1400.0, 100.0, 1000.0, 600.0));
        assert_eq!(
            plan.regions,
            vec![
                DesktopAreaRegion {
                    display_id: id("1"),
                    source_left: 1400,
                    source_top: 100,
                    source_width: 520,
                    source_height: 600,
                    dest_x: 0,
                    dest_y: 0,
                },
                DesktopAreaRegion {
                    display_id: id("2"),
                    source_left: 0,
                    source_top: 100,
                    source_width: 480,
                    source_height: 600,
                    dest_x: 520,
                    dest_y: 0,
                },
            ]
        );
    }

    #[test]
    fn resolves_mixed_dpi_negative_origin_and_vertical_offset() {
        let left_150 = phys(-2560.0, -120.0, 2560.0, 1440.0);
        let right_100 = phys(0.0, 180.0, 1920.0, 1080.0);
        assert!(monitors_are_adjacent(left_150, right_100));

        let monitors = vec![(id("1"), left_150), (id("2"), right_100)];
        let plan = resolve_desktop_area_plan(phys(-640.0, 0.0, 1280.0, 800.0), &monitors).unwrap();

        assert_eq!(plan.canvas_width, 1280);
        assert_eq!(plan.canvas_height, 800);
        assert_eq!(plan.desktop_bounds, phys(-640.0, 0.0, 1280.0, 800.0));
        assert_eq!(
            plan.regions,
            vec![
                DesktopAreaRegion {
                    display_id: id("1"),
                    source_left: 1920,
                    source_top: 120,
                    source_width: 640,
                    source_height: 800,
                    dest_x: 0,
                    dest_y: 0,
                },
                DesktopAreaRegion {
                    display_id: id("2"),
                    source_left: 0,
                    source_top: 0,
                    source_width: 640,
                    source_height: 620,
                    dest_x: 640,
                    dest_y: 180,
                },
            ]
        );
    }

    #[test]
    fn resolves_vertically_stacked_offset_monitors() {
        let top = phys(-320.0, -1080.0, 1920.0, 1080.0);
        let bottom = phys(0.0, 0.0, 2560.0, 1440.0);
        assert!(monitors_are_adjacent(top, bottom));

        let monitors = vec![(id("1"), top), (id("2"), bottom)];
        let plan =
            resolve_desktop_area_plan(phys(-100.0, -400.0, 1000.0, 900.0), &monitors).unwrap();

        assert_eq!(plan.canvas_width, 1000);
        assert_eq!(plan.canvas_height, 900);
        assert_eq!(
            plan.regions,
            vec![
                DesktopAreaRegion {
                    display_id: id("1"),
                    source_left: 220,
                    source_top: 680,
                    source_width: 1000,
                    source_height: 400,
                    dest_x: 0,
                    dest_y: 0,
                },
                DesktopAreaRegion {
                    display_id: id("2"),
                    source_left: 0,
                    source_top: 0,
                    source_width: 900,
                    source_height: 500,
                    dest_x: 100,
                    dest_y: 400,
                },
            ]
        );
    }

    #[test]
    fn odd_canvas_dimensions_floor_to_even_and_keep_regions_in_bounds() {
        let monitors = vec![
            (id("1"), phys(0.0, 0.0, 1920.0, 1080.0)),
            (id("2"), phys(1920.0, 0.0, 1920.0, 1080.0)),
        ];
        let plan =
            resolve_desktop_area_plan(phys(1401.0, 101.0, 1001.0, 601.0), &monitors).unwrap();

        assert_eq!(plan.canvas_width, 1000);
        assert_eq!(plan.canvas_height, 600);
        assert_eq!(plan.regions[0].source_width, 519);
        assert_eq!(plan.regions[0].source_height, 600);
        assert_eq!(plan.regions[1].dest_x, 519);
        assert_eq!(plan.regions[1].source_width, 481);
        assert_eq!(plan.regions[1].source_height, 600);
        for region in &plan.regions {
            assert!(region.dest_x + region.source_width <= plan.canvas_width);
            assert!(region.dest_y + region.source_height <= plan.canvas_height);
        }

        let sliver =
            resolve_desktop_area_plan(phys(1400.0, 100.0, 521.0, 400.0), &monitors).unwrap();
        assert_eq!(sliver.canvas_width, 520);
        assert_eq!(sliver.regions.len(), 1);
        assert_eq!(sliver.regions[0].display_id, id("1"));
    }

    #[test]
    fn rejects_non_adjacent_or_diagonal_only_monitors() {
        let a = phys(0.0, 0.0, 1920.0, 1080.0);
        let diagonal = phys(1920.0, 1080.0, 1920.0, 1080.0);
        let gapped = phys(2000.0, 0.0, 1920.0, 1080.0);

        assert!(!monitors_are_adjacent(a, diagonal));
        assert!(!monitors_are_adjacent(a, gapped));

        let diag_monitors = vec![(id("1"), a), (id("2"), diagonal)];
        assert!(
            resolve_desktop_area_plan(phys(1500.0, 800.0, 800.0, 600.0), &diag_monitors).is_none()
        );

        let gap_monitors = vec![(id("1"), a), (id("2"), gapped)];
        assert!(
            resolve_desktop_area_plan(phys(1500.0, 100.0, 800.0, 600.0), &gap_monitors).is_none()
        );
    }

    #[test]
    fn cursor_crop_maps_mixed_dpi_and_negative_origin_across_both_monitors() {
        let left = phys(-2560.0, -120.0, 2560.0, 1440.0);
        let right = phys(0.0, 0.0, 1920.0, 1080.0);
        let monitors = vec![(id("1"), left), (id("2"), right)];
        let plan =
            resolve_desktop_area_plan(phys(-640.0, 100.0, 1280.0, 720.0), &monitors).unwrap();
        let crop = desktop_area_cursor_crop(left, &plan);

        let normalize = |raw_x: f64, raw_y: f64| -> (f64, f64) {
            let rel_x = raw_x - left.position().x();
            let rel_y = raw_y - left.position().y();
            let norm_x = rel_x / left.size().width();
            let norm_y = rel_y / left.size().height();
            let px_x = norm_x * left.size().width();
            let px_y = norm_y * left.size().height();
            (
                (px_x - crop.position().x()) / crop.size().width(),
                (px_y - crop.position().y()) / crop.size().height(),
            )
        };

        let (x0, y0) = normalize(-640.0, 100.0);
        assert!((x0 - 0.0).abs() < 1e-12 && (y0 - 0.0).abs() < 1e-12);

        let (xs, ys) = normalize(0.0, 460.0);
        assert!((xs - 0.5).abs() < 1e-12 && (ys - 0.5).abs() < 1e-12);

        let (x1, y1) = normalize(640.0, 820.0);
        assert!((x1 - 1.0).abs() < 1e-12 && (y1 - 1.0).abs() < 1e-12);
    }
}
