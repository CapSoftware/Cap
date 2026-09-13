const COMPACT: (f64, f64) = (330.0, 395.0);
const EXPANDED: (f64, f64) = (600.0, 660.0);
const PADDING: f64 = 12.0;

pub(crate) fn restored_size(
    expanded: bool,
    frame: (f64, f64),
    work_area: Option<(f64, f64)>,
) -> (f64, f64) {
    let preferred = if expanded { EXPANDED } else { COMPACT };
    let available = work_area
        .map(|area| {
            (
                area.0 - frame.0 - PADDING * 2.0,
                area.1 - frame.1 - PADDING * 2.0,
            )
        })
        .unwrap_or(preferred);
    (
        available.0.clamp(COMPACT.0, preferred.0),
        available.1.clamp(COMPACT.1, preferred.1),
    )
}

pub(crate) fn restored_position(
    before: (f64, f64),
    window_size: (f64, f64),
    work_origin: (f64, f64),
    work_size: (f64, f64),
    scale: f64,
) -> (f64, f64) {
    let padding = PADDING * scale;
    let minimum = (work_origin.0 + padding, work_origin.1 + padding);
    let maximum = (
        (work_origin.0 + work_size.0 - window_size.0 - padding).max(minimum.0),
        (work_origin.1 + work_size.1 - window_size.1 - padding).max(minimum.1),
    );
    (
        before.0.clamp(minimum.0, maximum.0),
        before.1.clamp(minimum.1, maximum.1),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preserves_compact_expanded_and_small_screen_dimensions() {
        assert_eq!(
            restored_size(false, (0.0, 0.0), Some((1440.0, 900.0))),
            COMPACT
        );
        assert_eq!(
            restored_size(true, (0.0, 0.0), Some((1440.0, 900.0))),
            EXPANDED
        );
        assert_eq!(
            restored_size(true, (16.0, 40.0), Some((500.0, 650.0))),
            (460.0, 586.0)
        );
        assert_eq!(
            restored_size(true, (0.0, 0.0), Some((200.0, 200.0))),
            COMPACT
        );
        assert_eq!(restored_size(true, (0.0, 0.0), None), EXPANDED);
    }

    #[test]
    fn preserves_top_left_and_clamps_on_scaled_negative_coordinate_screens() {
        assert_eq!(
            restored_position(
                (-1800.0, 80.0),
                (1200.0, 1320.0),
                (-2880.0, 0.0),
                (2880.0, 1800.0),
                2.0
            ),
            (-1800.0, 80.0)
        );
        assert_eq!(
            restored_position(
                (-400.0, 1700.0),
                (1200.0, 1320.0),
                (-2880.0, 0.0),
                (2880.0, 1800.0),
                2.0
            ),
            (-1224.0, 456.0)
        );
        assert_eq!(
            restored_position((0.0, 0.0), (600.0, 660.0), (0.0, 0.0), (500.0, 500.0), 1.0),
            (12.0, 12.0)
        );
    }
}
