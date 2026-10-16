//! All geometry is AppKit screen space (bottom-left origin, y up), read
//! straight from `NSScreen` and `NSWindow`. gpui's own display rects mix a
//! display-local x with a global y, which places windows wrongly on displays
//! arranged above, below or beside-but-offset from the menu-bar display.

use crate::store::{EditorWindowMemory, RememberedEditorFrame};

const MAX_DEFAULT_WIDTH: f64 = 1920.;
const MAX_DEFAULT_HEIGHT: f64 = 1200.;
const REMEMBERED_DISPLAYS: usize = 8;

#[derive(Debug, Clone, Copy, PartialEq)]
pub(super) struct Rect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl Rect {
    fn right(self) -> f64 {
        self.x + self.width
    }

    fn top(self) -> f64 {
        self.y + self.height
    }

    fn center(self) -> (f64, f64) {
        (self.x + self.width / 2., self.y + self.height / 2.)
    }

    fn overlap_area(self, other: Rect) -> f64 {
        let width = (self.right().min(other.right()) - self.x.max(other.x)).max(0.);
        let height = (self.top().min(other.top()) - self.y.max(other.y)).max(0.);
        width * height
    }

    fn contains(self, other: Rect) -> bool {
        const SLACK: f64 = 0.5;
        other.x >= self.x - SLACK
            && other.y >= self.y - SLACK
            && other.right() <= self.right() + SLACK
            && other.top() <= self.top() + SLACK
    }

    fn is_usable(self) -> bool {
        [self.x, self.y, self.width, self.height]
            .iter()
            .all(|value| value.is_finite())
            && self.width >= 1.
            && self.height >= 1.
    }
}

#[derive(Debug, Clone, PartialEq)]
pub(super) struct Screen {
    pub id: u32,
    pub key: String,
    pub frame: Rect,
    pub visible: Rect,
}

pub(super) fn default_frame(visible: Rect) -> Rect {
    let width = visible.width.min(MAX_DEFAULT_WIDTH);
    let height = visible.height.min(MAX_DEFAULT_HEIGHT);
    fit(
        Rect {
            x: (visible.x + (visible.width - width) / 2.).round(),
            y: (visible.y + (visible.height - height) / 2.).round(),
            width,
            height,
        },
        visible,
    )
}

pub(super) fn fit(frame: Rect, visible: Rect) -> Rect {
    let width = frame.width.min(visible.width).max(1.);
    let height = frame.height.min(visible.height).max(1.);
    Rect {
        x: frame
            .x
            .clamp(visible.x, (visible.right() - width).max(visible.x)),
        y: frame
            .y
            .clamp(visible.y, (visible.top() - height).max(visible.y)),
        width,
        height,
    }
}

fn remembered_frame(screen: &Screen, memory: &EditorWindowMemory) -> Option<Rect> {
    let remembered = memory
        .displays
        .iter()
        .find(|remembered| remembered.display == screen.key)?;
    let frame = Rect {
        x: screen.frame.x + remembered.left,
        y: screen.frame.top() - remembered.top - remembered.height,
        width: remembered.width,
        height: remembered.height,
    };
    frame.is_usable().then_some(frame)
}

pub(super) fn opening_frame(
    screens: &[Screen],
    memory: Option<&EditorWindowMemory>,
    cursor_screen: Option<u32>,
) -> Option<Rect> {
    let screen = memory
        .and_then(|memory| memory.last_display.as_deref())
        .and_then(|key| screens.iter().find(|screen| screen.key == key))
        .or_else(|| cursor_screen.and_then(|id| screens.iter().find(|screen| screen.id == id)))
        .or_else(|| screens.first())?;
    if !screen.visible.is_usable() {
        return None;
    }
    let frame = memory
        .and_then(|memory| remembered_frame(screen, memory))
        .map(|frame| fit(frame, screen.visible))
        .unwrap_or_else(|| default_frame(screen.visible));
    Some(frame)
}

pub(super) fn screen_for_frame(screens: &[Screen], frame: Rect) -> Option<&Screen> {
    let best = screens
        .iter()
        .map(|screen| (screen, screen.frame.overlap_area(frame)))
        .max_by(|a, b| a.1.total_cmp(&b.1));
    if let Some((screen, area)) = best
        && area > 0.
    {
        return Some(screen);
    }
    let (cx, cy) = frame.center();
    screens.iter().min_by(|a, b| {
        let distance = |screen: &Screen| {
            let (sx, sy) = screen.visible.center();
            (sx - cx).powi(2) + (sy - cy).powi(2)
        };
        distance(a).total_cmp(&distance(b))
    })
}

/// When the display the editor was on is unplugged or changes resolution,
/// macOS moves the window but can leave it larger than, or hanging off, its
/// new display. Ordinary drags never trigger this: the previous display is
/// still connected with the same geometry.
pub(super) fn refit_after_display_change(
    previous: Option<&Screen>,
    screens: &[Screen],
    frame: Rect,
) -> Option<Rect> {
    let previous = previous?;
    if screens.contains(previous) {
        return None;
    }
    let screen = screen_for_frame(screens, frame)?;
    if !screen.visible.is_usable() || screen.visible.contains(frame) {
        return None;
    }
    Some(fit(frame, screen.visible))
}

pub(super) fn remembered_entry(screen: &Screen, frame: Rect) -> RememberedEditorFrame {
    RememberedEditorFrame {
        display: screen.key.clone(),
        left: frame.x - screen.frame.x,
        top: screen.frame.top() - frame.top(),
        width: frame.width,
        height: frame.height,
    }
}

pub(super) fn remember(memory: &mut EditorWindowMemory, entry: RememberedEditorFrame) {
    memory
        .displays
        .retain(|remembered| remembered.display != entry.display);
    memory.last_display = Some(entry.display.clone());
    memory.displays.insert(0, entry);
    memory.displays.truncate(REMEMBERED_DISPLAYS);
}

/// gpui opens a window with no display id at a top-left origin measured down
/// from the top of the menu-bar display (`MacWindow::open`).
pub(super) fn open_origin(frame: Rect, primary: Rect) -> (f64, f64) {
    (frame.x, primary.top() - frame.top())
}

#[cfg(target_os = "macos")]
mod live {
    use std::sync::Arc;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::Duration;

    use gpui::{App, Bounds, Context, Pixels, Window, point, px, size};

    use super::*;
    use crate::platform;
    use crate::store;

    fn rect((x, y, width, height): (f64, f64, f64, f64)) -> Rect {
        Rect {
            x,
            y,
            width,
            height,
        }
    }

    fn connected_screens(cx: &App) -> Vec<Screen> {
        platform::screen_geometries()
            .into_iter()
            .map(|geometry| {
                let key = cx
                    .find_display(gpui::DisplayId::new(u64::from(geometry.id)))
                    .and_then(|display| display.uuid().ok())
                    .map(|uuid| uuid.to_string())
                    .unwrap_or_else(|| format!("display-{}", geometry.id));
                Screen {
                    id: geometry.id,
                    key,
                    frame: rect(geometry.frame),
                    visible: rect(geometry.visible),
                }
            })
            .collect()
    }

    pub(in crate::app_windows) fn opening_bounds(cx: &App) -> Option<Bounds<Pixels>> {
        let screens = connected_screens(cx);
        let primary = screens.first()?.frame;
        let memory = store::load().editor_window;
        let cursor_screen = scap_targets::Display::get_containing_cursor()
            .and_then(|display| display.id().to_string().parse::<u32>().ok());
        let frame = opening_frame(&screens, memory.as_ref(), cursor_screen)?;
        let (x, y) = open_origin(frame, primary);
        Some(Bounds {
            origin: point(px(x as f32), px(y as f32)),
            size: size(px(frame.width as f32), px(frame.height as f32)),
        })
    }

    fn close_to(a: Rect, b: Rect) -> bool {
        (a.x - b.x).abs() < 0.5
            && (a.y - b.y).abs() < 0.5
            && (a.width - b.width).abs() < 0.5
            && (a.height - b.height).abs() < 0.5
    }

    struct Tracker {
        screen: Option<Screen>,
        saved: Option<Rect>,
        save_generation: Arc<AtomicU64>,
    }

    pub(in crate::app_windows) fn track<T: 'static>(window: &mut Window, cx: &mut Context<T>) {
        let frame =
            platform::native_window(window).map(|native| rect(platform::window_frame(&native)));
        let screens = connected_screens(cx);
        let mut tracker = Tracker {
            screen: frame.and_then(|frame| screen_for_frame(&screens, frame).cloned()),
            saved: frame,
            save_generation: Arc::new(AtomicU64::new(0)),
        };
        cx.observe_window_bounds(window, move |_, window, cx| {
            tracker.bounds_changed(window, cx);
        })
        .detach();
    }

    impl Tracker {
        fn bounds_changed<T: 'static>(&mut self, window: &mut Window, cx: &mut Context<T>) {
            if window.is_fullscreen() {
                return;
            }
            let Some(native) = platform::native_window(window) else {
                return;
            };
            let frame = rect(platform::window_frame(&native));
            let screens = connected_screens(cx);

            if let Some(fitted) = refit_after_display_change(self.screen.as_ref(), &screens, frame)
            {
                tracing::info!(
                    ?frame,
                    ?fitted,
                    "editor window refitted after a display change"
                );
                cx.spawn(async move |_, _| {
                    platform::set_window_frame(
                        &native,
                        fitted.x,
                        fitted.y,
                        fitted.width,
                        fitted.height,
                    );
                })
                .detach();
                return;
            }

            self.screen = screen_for_frame(&screens, frame).cloned();
            if self.saved.is_some_and(|saved| close_to(saved, frame)) {
                return;
            }
            self.saved = Some(frame);
            let Some(screen) = &self.screen else {
                return;
            };
            let entry = remembered_entry(screen, frame);
            let generation = self.save_generation.fetch_add(1, Ordering::AcqRel) + 1;
            let generations = self.save_generation.clone();
            let executor = cx.background_executor().clone();
            cx.background_executor()
                .spawn(async move {
                    executor.timer(Duration::from_millis(400)).await;
                    if generations.load(Ordering::Acquire) == generation {
                        store::update(|state| {
                            remember(state.editor_window.get_or_insert_default(), entry);
                        });
                    }
                })
                .detach();
        }
    }
}

#[cfg(target_os = "macos")]
pub(super) use live::{opening_bounds, track};

#[cfg(test)]
mod tests {
    use super::*;

    fn rect(x: f64, y: f64, width: f64, height: f64) -> Rect {
        Rect {
            x,
            y,
            width,
            height,
        }
    }

    fn screen(id: u32, frame: Rect, visible: Rect) -> Screen {
        Screen {
            id,
            key: format!("uuid-{id}"),
            frame,
            visible,
        }
    }

    fn macbook_14() -> Screen {
        screen(1, rect(0., 0., 1512., 982.), rect(0., 0., 1512., 949.))
    }

    fn studio_display_right_top_aligned() -> Screen {
        screen(
            2,
            rect(1512., -458., 2560., 1440.),
            rect(1512., -458., 2560., 1415.),
        )
    }

    #[test]
    fn laptop_displays_open_filling_the_work_area() {
        for visible in [
            rect(0., 0., 1512., 949.),
            rect(0., 0., 1470., 919.),
            rect(0., 70., 1728., 1009.),
            rect(0., 0., 1920., 1050.),
        ] {
            assert_eq!(default_frame(visible), visible);
        }
    }

    #[test]
    fn large_displays_open_capped_and_centred() {
        let visible = rect(1512., -458., 2560., 1415.);
        let frame = default_frame(visible);
        assert_eq!(frame.width, MAX_DEFAULT_WIDTH);
        assert_eq!(frame.height, MAX_DEFAULT_HEIGHT);
        assert!(visible.contains(frame));
        assert_eq!(frame.x - visible.x, visible.right() - frame.right());
        assert!((frame.y - visible.y - (visible.top() - frame.top())).abs() <= 1.);
    }

    #[test]
    fn opens_on_the_cursor_display_without_memory() {
        let screens = [macbook_14(), studio_display_right_top_aligned()];
        let frame = opening_frame(&screens, None, Some(2)).unwrap();
        assert!(screens[1].visible.contains(frame));
        let frame = opening_frame(&screens, None, Some(1)).unwrap();
        assert_eq!(frame, screens[0].visible);
        let frame = opening_frame(&screens, None, Some(99)).unwrap();
        assert_eq!(frame, screens[0].visible);
    }

    #[test]
    fn reopens_where_it_was_left_on_the_last_display() {
        let screens = [macbook_14(), studio_display_right_top_aligned()];
        let left_half = rect(1512., -458., 1280., 1415.);
        let mut memory = EditorWindowMemory::default();
        remember(&mut memory, remembered_entry(&screens[1], left_half));
        assert_eq!(
            opening_frame(&screens, Some(&memory), Some(1)),
            Some(left_half)
        );
    }

    #[test]
    fn remembered_frame_follows_the_display_when_the_arrangement_changes() {
        let mut memory = EditorWindowMemory::default();
        let external = studio_display_right_top_aligned();
        let frame = rect(1712., -300., 1600., 1000.);
        remember(&mut memory, remembered_entry(&external, frame));

        let moved_left = screen(
            2,
            rect(-2560., 200., 2560., 1440.),
            rect(-2560., 200., 2560., 1415.),
        );
        let screens = [macbook_14(), moved_left.clone()];
        let reopened = opening_frame(&screens, Some(&memory), Some(1)).unwrap();
        assert_eq!(reopened.x - moved_left.frame.x, 200.);
        assert_eq!(moved_left.frame.top() - reopened.top(), 282.);
        assert_eq!((reopened.width, reopened.height), (1600., 1000.));
    }

    #[test]
    fn disconnected_display_falls_back_to_the_cursor_display() {
        let mut memory = EditorWindowMemory::default();
        remember(
            &mut memory,
            remembered_entry(
                &studio_display_right_top_aligned(),
                rect(1512., -458., 1920., 1200.),
            ),
        );
        let screens = [macbook_14()];
        let frame = opening_frame(&screens, Some(&memory), Some(1)).unwrap();
        assert_eq!(frame, screens[0].visible);
    }

    #[test]
    fn each_display_keeps_its_own_frame() {
        let laptop = macbook_14();
        let external = studio_display_right_top_aligned();
        let mut memory = EditorWindowMemory::default();
        let laptop_frame = rect(100., 100., 1300., 820.);
        remember(&mut memory, remembered_entry(&laptop, laptop_frame));
        remember(
            &mut memory,
            remembered_entry(&external, rect(1600., -400., 2000., 1300.)),
        );
        assert_eq!(memory.last_display.as_deref(), Some("uuid-2"));
        let frame = opening_frame(&[laptop.clone()], Some(&memory), Some(1)).unwrap();
        assert_eq!(frame, laptop_frame);
    }

    #[test]
    fn remembered_frame_too_big_for_a_changed_display_is_fitted() {
        let mut memory = EditorWindowMemory::default();
        let big = screen(1, rect(0., 0., 1728., 1117.), rect(0., 0., 1728., 1079.));
        remember(
            &mut memory,
            remembered_entry(&big, rect(0., 0., 1728., 1079.)),
        );
        let scaled_down = screen(1, rect(0., 0., 1312., 848.), rect(0., 0., 1312., 815.));
        let frame = opening_frame(&[scaled_down.clone()], Some(&memory), Some(1)).unwrap();
        assert_eq!(frame, scaled_down.visible);
    }

    #[test]
    fn remembered_frame_off_the_work_area_is_pulled_back_on() {
        let laptop = macbook_14();
        let mut memory = EditorWindowMemory::default();
        remember(
            &mut memory,
            remembered_entry(&laptop, rect(900., -300., 1300., 820.)),
        );
        let frame = opening_frame(&[laptop.clone()], Some(&memory), Some(1)).unwrap();
        assert!(laptop.visible.contains(frame));
        assert_eq!((frame.width, frame.height), (1300., 820.));
    }

    #[test]
    fn corrupt_memory_falls_back_to_the_default() {
        let laptop = macbook_14();
        let memory = EditorWindowMemory {
            last_display: Some(laptop.key.clone()),
            displays: vec![RememberedEditorFrame {
                display: laptop.key.clone(),
                left: 0.,
                top: 0.,
                width: 0.,
                height: f64::NAN,
            }],
        };
        assert_eq!(
            opening_frame(&[laptop.clone()], Some(&memory), Some(1)),
            Some(laptop.visible)
        );
    }

    #[test]
    fn memory_is_bounded_and_most_recent_first() {
        let mut memory = EditorWindowMemory::default();
        for id in 0..(REMEMBERED_DISPLAYS as u32 + 3) {
            let display = screen(id, rect(0., 0., 1512., 982.), rect(0., 0., 1512., 949.));
            remember(
                &mut memory,
                remembered_entry(&display, rect(0., 0., 1300., 800.)),
            );
        }
        assert_eq!(memory.displays.len(), REMEMBERED_DISPLAYS);
        assert_eq!(
            memory.displays[0].display,
            format!("uuid-{}", REMEMBERED_DISPLAYS as u32 + 2)
        );
    }

    #[test]
    fn unplugging_the_display_refits_the_window_onto_the_remaining_one() {
        let laptop = macbook_14();
        let external = studio_display_right_top_aligned();
        let moved_by_macos = rect(200., -200., 1920., 1200.);
        let fitted =
            refit_after_display_change(Some(&external), &[laptop.clone()], moved_by_macos).unwrap();
        assert_eq!(fitted, laptop.visible);
    }

    #[test]
    fn dragging_between_connected_displays_never_refits() {
        let laptop = macbook_14();
        let external = studio_display_right_top_aligned();
        let screens = [laptop.clone(), external.clone()];
        let hanging_off = rect(1300., 300., 1300., 820.);
        assert_eq!(
            refit_after_display_change(Some(&laptop), &screens, hanging_off),
            None
        );
        assert_eq!(
            refit_after_display_change(None, &screens, hanging_off),
            None
        );
    }

    #[test]
    fn window_left_with_no_display_is_rescued_to_the_nearest() {
        let laptop = macbook_14();
        let external = studio_display_right_top_aligned();
        let stranded = rect(5000., 0., 1300., 820.);
        let fitted =
            refit_after_display_change(Some(&external), &[laptop.clone()], stranded).unwrap();
        assert!(laptop.visible.contains(fitted));
    }

    #[test]
    fn open_origin_is_measured_down_from_the_menu_bar_display() {
        let laptop = macbook_14();
        let external = studio_display_right_top_aligned();
        let frame = rect(1512., -458., 1920., 1200.);
        assert_eq!(
            open_origin(frame, laptop.frame),
            (1512., 982. - (-458. + 1200.))
        );
        let top_of_external = rect(1512., external.frame.top() - 100., 1920., 100.);
        assert_eq!(open_origin(top_of_external, laptop.frame).1, 0.);
        let laptop_fill = laptop.visible;
        assert_eq!(open_origin(laptop_fill, laptop.frame), (0., 33.));
    }
}
