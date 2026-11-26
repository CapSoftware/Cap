use crate::{CursorClickEvent, GlideDirection, ZoomMode, ZoomSegment};

/// The auto zoom rules [`crate::ProjectConfiguration::for_new_project`]
/// starts on. Projects without the field keep the original rules (0).
pub const AUTO_ZOOM_VERSION: u32 = 1;

/// The zoom amount version 1 generates when the user has not chosen a
/// default zoom amount.
pub const DEFAULT_AUTO_ZOOM_AMOUNT: f64 = 2.0;

const MS_PER_SECOND: f64 = 1000.0;
const START_MIN_MS: f64 = 1.0;
const CLICK_PRE_PADDING_MS: f64 = 300.0;
const CLICK_POST_PADDING_MS: f64 = 2500.0;
const CLICK_END_CLAMP_PADDING_MS: f64 = 800.0;
const TRAILING_CLICK_IGNORE_MS: f64 = 1000.0;
const MERGE_GAP_MS: f64 = 2500.0;
const MIN_SEGMENT_MS: f64 = 100.0;

/// Runs the auto zoom rules a project was created with.
pub fn auto_zoom_segments(
    version: u32,
    clicks: Vec<CursorClickEvent>,
    max_duration: f64,
    zoom_amount: f64,
) -> Vec<ZoomSegment> {
    if version >= AUTO_ZOOM_VERSION {
        generate_auto_zoom_segments(&clicks, max_duration, zoom_amount)
    } else {
        generate_zoom_segments_from_clicks(clicks, max_duration, zoom_amount)
    }
}

/// Version 1, for clicks in timeline order. Every press and release, of any
/// button, opens a range from 300 ms before it to 2.5 s after it. Clicks in
/// the final second are ignored and ranges stop 800 ms before the end.
/// Ranges whose gap is 2.5 s or less join, the later range's end winning,
/// until nothing joins. Each range is then placed on the track the way a new
/// zoom is: at least 100 ms long and only in free space. Times are whole
/// milliseconds, floored.
pub fn generate_auto_zoom_segments(
    clicks: &[CursorClickEvent],
    max_duration: f64,
    zoom_amount: f64,
) -> Vec<ZoomSegment> {
    let duration_ms = max_duration * MS_PER_SECOND;
    if !duration_ms.is_finite() || duration_ms <= 0.0 {
        return Vec::new();
    }

    let ranges = clicks
        .iter()
        .map(|click| click.time_ms)
        .filter(|time| time.is_finite() && *time < duration_ms - TRAILING_CLICK_IGNORE_MS)
        .map(|time| {
            let time = time.floor();
            (
                (time - CLICK_PRE_PADDING_MS).max(START_MIN_MS),
                (time + CLICK_POST_PADDING_MS).min(duration_ms - CLICK_END_CLAMP_PADDING_MS),
            )
        })
        .collect();

    let mut placed: Vec<(f64, f64)> = Vec::new();
    for (start, end) in merge_ranges(ranges) {
        let (start, end) = (start.floor(), end.floor());
        let length = (end - start).max(MIN_SEGMENT_MS);
        if let Some(range) = free_range_at(&placed, start, length, duration_ms) {
            let index = placed.partition_point(|other| other.0 <= range.0);
            placed.insert(index, range);
        }
    }

    placed
        .into_iter()
        .map(|(start, end)| auto_segment(start, end, zoom_amount))
        .collect()
}

fn merge_ranges(mut ranges: Vec<(f64, f64)>) -> Vec<(f64, f64)> {
    loop {
        let count = ranges.len();
        ranges = join_ranges(ranges, |end, start| end + 1.0 == start);
        ranges = join_ranges(ranges, |end, start| end + MERGE_GAP_MS >= start);
        if ranges.len() == count {
            return ranges;
        }
    }
}

fn join_ranges(ranges: Vec<(f64, f64)>, joins: impl Fn(f64, f64) -> bool) -> Vec<(f64, f64)> {
    let mut joined: Vec<(f64, f64)> = Vec::with_capacity(ranges.len());
    for (start, end) in ranges {
        match joined.last_mut() {
            Some(last) if joins(last.1, start) => last.1 = end,
            _ => joined.push((start, end)),
        }
    }
    joined
}

fn free_range_at(
    placed: &[(f64, f64)],
    at: f64,
    length: f64,
    duration_ms: f64,
) -> Option<(f64, f64)> {
    if placed.iter().any(|&(start, end)| start < at && end > at) {
        return None;
    }
    let ending = placed.partition_point(|range| range.1 < at);
    let floor = match placed.get(ending) {
        Some(range) if range.1 == at => range.1,
        _ => ending
            .checked_sub(1)
            .map_or(0.0, |previous| placed[previous].1),
    };
    let ceiling = placed
        .get(placed.partition_point(|range| range.0 < at))
        .map_or(duration_ms, |next| next.0);
    if ceiling - floor < MIN_SEGMENT_MS {
        return None;
    }
    let end = ceiling.min(at + length);
    Some(((end - length).max(floor), end))
}

fn auto_segment(start_ms: f64, end_ms: f64, amount: f64) -> ZoomSegment {
    ZoomSegment {
        start: start_ms / MS_PER_SECOND,
        end: end_ms / MS_PER_SECOND,
        amount,
        mode: ZoomMode::Auto,
        glide_direction: GlideDirection::None,
        glide_speed: 0.5,
        instant_animation: false,
        edge_snap_ratio: 0.25,
    }
}

/// Version 0, `generate_zoom_segments_from_clicks_impl`
/// (`src-tauri/src/recording.rs:3706-3782`), the algorithm behind the Tauri
/// command the empty zoom track's generate button invokes: every click grows
/// into a padded interval (300ms before, 2.5s after), clicks in the last
/// second are ignored, intervals closer than 2.5s merge, and the result is
/// clamped inside the recording. The Tauri signature also takes the cursor
/// *moves* and ignores them; this one does not pretend to want them.
pub fn generate_zoom_segments_from_clicks(
    mut clicks: Vec<CursorClickEvent>,
    max_duration: f64,
    zoom_amount: f64,
) -> Vec<ZoomSegment> {
    if max_duration <= 0.0 {
        return Vec::new();
    }

    let duration_ms = max_duration * MS_PER_SECOND;
    let click_cutoff_ms = duration_ms - TRAILING_CLICK_IGNORE_MS;
    let end_limit_ms = duration_ms - CLICK_END_CLAMP_PADDING_MS;
    if click_cutoff_ms <= 0.0 || end_limit_ms <= START_MIN_MS {
        return Vec::new();
    }

    clicks.sort_by(|a, b| {
        a.time_ms
            .partial_cmp(&b.time_ms)
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    let mut intervals: Vec<(f64, f64)> = Vec::new();
    for click in clicks {
        let time_ms = click.time_ms.floor();
        if time_ms >= click_cutoff_ms {
            continue;
        }

        let start = (time_ms - CLICK_PRE_PADDING_MS).max(START_MIN_MS);
        let end = (time_ms + CLICK_POST_PADDING_MS).min(end_limit_ms);

        if end > start {
            intervals.push((start, end));
        }
    }

    if intervals.is_empty() {
        return Vec::new();
    }

    intervals.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));

    let mut merged: Vec<(f64, f64)> = Vec::new();
    for interval in intervals {
        if let Some(last) = merged.last_mut()
            && interval.0 <= last.1 + MERGE_GAP_MS
        {
            last.1 = last.1.max(interval.1);
            continue;
        }
        merged.push(interval);
    }

    merged
        .into_iter()
        .map(|(start, end)| auto_segment(start.round(), end.round(), zoom_amount))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn press(time_ms: f64) -> CursorClickEvent {
        click(time_ms, true, 0)
    }

    fn click(time_ms: f64, down: bool, cursor_num: u8) -> CursorClickEvent {
        CursorClickEvent {
            active_modifiers: Vec::new(),
            cursor_num,
            cursor_id: String::new(),
            time_ms,
            down,
        }
    }

    fn ranges(clicks: &[CursorClickEvent], duration_ms: f64) -> Vec<(f64, f64)> {
        generate_auto_zoom_segments(clicks, duration_ms / 1000.0, 2.0)
            .into_iter()
            .map(|segment| {
                (
                    (segment.start * 1000.0).round(),
                    (segment.end * 1000.0).round(),
                )
            })
            .collect()
    }

    #[test]
    fn a_click_opens_300_ms_before_and_runs_2500_ms_after() {
        assert_eq!(ranges(&[press(5000.0)], 20000.0), vec![(4700.0, 7500.0)]);
    }

    #[test]
    fn releases_and_every_button_open_ranges() {
        for event in [
            click(5000.0, false, 0),
            click(5000.0, true, 1),
            click(5000.0, false, 2),
        ] {
            assert_eq!(ranges(&[event], 20000.0), vec![(4700.0, 7500.0)]);
        }
    }

    #[test]
    fn ranges_never_start_before_the_first_millisecond() {
        assert_eq!(ranges(&[press(0.0)], 10000.0), vec![(1.0, 2500.0)]);
        assert_eq!(ranges(&[press(150.0)], 10000.0), vec![(1.0, 2650.0)]);
        assert_eq!(ranges(&[press(300.0)], 10000.0), vec![(1.0, 2800.0)]);
        assert_eq!(ranges(&[press(301.0)], 10000.0), vec![(1.0, 2801.0)]);
        assert_eq!(ranges(&[press(302.0)], 10000.0), vec![(2.0, 2802.0)]);
    }

    #[test]
    fn clicks_in_the_final_second_are_ignored_before_flooring() {
        assert_eq!(ranges(&[press(8999.9)], 10000.4), vec![(8699.0, 9200.0)]);
        assert!(ranges(&[press(9000.5)], 10000.4).is_empty());
        assert!(ranges(&[press(9000.0)], 10000.0).is_empty());
        assert_eq!(ranges(&[press(8999.5)], 10000.0), vec![(8699.0, 9200.0)]);
    }

    #[test]
    fn ranges_stop_800_ms_before_the_end_in_whole_milliseconds() {
        assert_eq!(ranges(&[press(8000.0)], 10000.0), vec![(7700.0, 9200.0)]);
        assert_eq!(ranges(&[press(8000.0)], 10000.6), vec![(7700.0, 9200.0)]);
        assert_eq!(
            ranges(&[press(1234.56), press(7777.77)], 20000.25),
            vec![(934.0, 3734.0), (7477.0, 10277.0)]
        );
    }

    #[test]
    fn gaps_of_2500_ms_or_less_join() {
        let first = press(1000.0);
        assert_eq!(
            ranges(&[first.clone(), press(6300.0)], 30000.0),
            vec![(700.0, 8800.0)]
        );
        assert_eq!(
            ranges(&[first.clone(), press(6301.0)], 30000.0),
            vec![(700.0, 3500.0), (6001.0, 8801.0)]
        );
        assert_eq!(
            ranges(&[first, press(3801.0)], 30000.0),
            vec![(700.0, 6301.0)]
        );
    }

    #[test]
    fn joined_ranges_take_the_later_end() {
        assert_eq!(
            join_ranges(vec![(0.0, 9000.0), (5000.0, 6000.0)], |end, start| end
                + MERGE_GAP_MS
                >= start),
            vec![(0.0, 6000.0)]
        );
        assert_eq!(
            join_ranges(
                vec![(0.0, 100.0), (101.0, 200.0), (300.0, 400.0)],
                |end, start| { end + 1.0 == start }
            ),
            vec![(0.0, 200.0), (300.0, 400.0)]
        );
    }

    #[test]
    fn joining_repeats_until_nothing_joins() {
        let clicks: Vec<_> = (0..25)
            .map(|i| press(1000.0 + f64::from(i) * 2000.0))
            .collect();
        assert_eq!(ranges(&clicks, 60000.0), vec![(700.0, 51500.0)]);
        assert_eq!(
            merge_ranges(vec![
                (0.0, 10.0),
                (11.0, 20.0),
                (2000.0, 3000.0),
                (9000.0, 9500.0)
            ]),
            vec![(0.0, 3000.0), (9000.0, 9500.0)]
        );
    }

    #[test]
    fn double_clicks_and_drags_make_one_range() {
        assert_eq!(
            ranges(
                &[
                    press(4000.0),
                    click(4060.0, false, 0),
                    press(4180.0),
                    click(4240.0, false, 0)
                ],
                20000.0
            ),
            vec![(3700.0, 6740.0)]
        );
        assert_eq!(
            ranges(&[press(3000.0), click(7000.0, false, 0)], 30000.0),
            vec![(2700.0, 9500.0)]
        );
    }

    #[test]
    fn a_click_whose_range_runs_into_the_end_is_kept_short() {
        assert_eq!(
            ranges(
                &[press(1000.0), press(4000.0), press(7000.0), press(10500.0)],
                12000.0
            ),
            vec![(700.0, 11200.0)]
        );
    }

    #[test]
    fn ranges_are_at_least_100_ms_and_only_fill_free_space() {
        assert_eq!(ranges(&[press(-500.0)], 700.0), vec![(1.0, 101.0)]);
        assert!(ranges(&[press(0.0)], 1000.0).is_empty());
        assert_eq!(ranges(&[press(0.0)], 1500.0), vec![(1.0, 700.0)]);
        assert_eq!(free_range_at(&[(0.0, 500.0)], 250.0, 100.0, 1000.0), None);
        assert_eq!(
            free_range_at(&[(0.0, 500.0)], 500.0, 100.0, 1000.0),
            Some((500.0, 600.0))
        );
        assert_eq!(
            free_range_at(&[(0.0, 500.0), (560.0, 900.0)], 500.0, 100.0, 1000.0),
            None
        );
        assert_eq!(
            free_range_at(&[(0.0, 400.0), (900.0, 1000.0)], 850.0, 300.0, 1000.0),
            Some((600.0, 900.0))
        );
    }

    #[test]
    fn generated_zooms_follow_the_pointer_at_the_given_amount() {
        let segment = &generate_auto_zoom_segments(&[press(5000.0)], 20.0, 2.0)[0];
        assert_eq!(segment.amount, 2.0);
        assert_eq!(segment.mode, ZoomMode::Auto);
        assert!(!segment.instant_animation);
        assert_eq!(segment.glide_speed, 0.5);
        assert_eq!(segment.edge_snap_ratio, 0.25);
    }

    #[test]
    fn nothing_without_clicks_or_duration() {
        assert!(ranges(&[], 10000.0).is_empty());
        assert!(ranges(&[press(1000.0)], 0.0).is_empty());
        assert!(ranges(&[press(1000.0)], f64::NAN).is_empty());
        assert!(ranges(&[press(f64::NAN), press(f64::INFINITY)], 10000.0).is_empty());
        assert!(ranges(&[press(10000.0)], 10000.0).is_empty());
    }

    #[test]
    fn saved_projects_keep_the_original_rules() {
        let bounds = |segments: Vec<ZoomSegment>| {
            segments
                .into_iter()
                .map(|segment| (segment.start, segment.end))
                .collect::<Vec<_>>()
        };
        let late = vec![press(8000.0), press(9000.6)];
        let original = generate_zoom_segments_from_clicks(late.clone(), 10.0006, 1.5);
        assert_eq!(auto_zoom_segments(0, late.clone(), 10.0006, 1.5), original);
        assert_eq!(bounds(original), vec![(7.7, 9.201)]);
        assert_eq!(
            bounds(auto_zoom_segments(AUTO_ZOOM_VERSION, late, 10.0006, 1.5)),
            vec![(7.7, 9.2)]
        );
    }
}
