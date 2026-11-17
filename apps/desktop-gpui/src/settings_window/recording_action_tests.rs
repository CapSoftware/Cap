use super::*;
use gpui::{Modifiers, MouseButton, TestAppContext, VisualTestContext, point, size};

struct RecordingActions {
    settings: Entity<SettingsWindow>,
}

impl Render for RecordingActions {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        self.settings.update(cx, |settings, cx| {
            settings.render_recordings_list(cx).into_any_element()
        })
    }
}

fn settings_fixture(window: &mut Window, cx: &mut Context<SettingsWindow>) -> SettingsWindow {
    let input = cx.new(|cx| ui::TextInputState::single_line(window, cx));
    let scroll = ScrollHandle::new();
    SettingsWindow {
        theme: Theme::light(),
        page: Page::Recordings,
        settings: GeneralSettings::default(),
        menu: None,
        page_scroll: scroll.clone(),
        instant_quality_anchor: ScrollAnchor::for_handle(scroll.clone()),
        studio_quality_anchor: ScrollAnchor::for_handle(scroll),
        quality_scroll_request: None,
        has_cap_pro: false,
        plan_refresh_pending: false,
        plan_refresh_failed: false,
        instant_quality_notice: None,
        studio_quality_save_failed: false,
        pages: crate::settings_pages::PagesState::new(window, cx),
        project_name: String::new(),
        server_url: String::new(),
        project_name_input: input.clone(),
        server_url_input: input.clone(),
        _field_events: std::array::from_fn(|_| gpui::Subscription::new(|| {})),
        recordings: Recordings::new(input.clone()),
        screenshots: Screenshots::new(input),
        placeholders: ui::CollapsibleState::new(false),
        placeholders_task: None,
        slider_track: Rc::new(Cell::new(None)),
        slider_dragging: false,
        windows: Vec::new(),
        focus: cx.focus_handle(),
        _sign_in_subscriptions: std::array::from_fn(|_| gpui::Subscription::new(|| {})),
        user_profile: None,
        profile_image: None,
        keyboard_nav: false,
        _keyboard_nav: gpui::Subscription::new(|| {}),
    }
}

fn row(root: &str) -> RecordingRow {
    RecordingRow {
        item: RecordingItem {
            path: PathBuf::from(root).join("same-name.cap"),
            pretty_name: "Same name".into(),
            mode: RecordingMode::Studio,
            status: library::RecordingStatus::Complete,
            upload: None,
            clip_count: 1,
            sharing: Some(format!("https://cap.test/{root}")),
            sort_time_millis: 0.,
            thumbnail: None,
            thumbnail_version: None,
        },
        thumbnail: None,
        thumbnail_stale: false,
    }
}

fn draw(cx: &mut VisualTestContext) {
    cx.update(|window, cx| {
        window.refresh();
        window.draw(cx).clear();
    });
}

fn open_two_recordings(cx: &mut TestAppContext) -> (Entity<SettingsWindow>, VisualTestContext) {
    let window = cx.open_window(size(px(600.), px(300.)), |window, cx| RecordingActions {
        settings: cx.new(|cx| {
            let mut settings = settings_fixture(window, cx);
            settings.recordings.items = Some(vec![row("first"), row("second")]);
            settings
        }),
    });
    let settings = window
        .read_with(cx, |view, _| view.settings.clone())
        .unwrap();
    let mut visual = VisualTestContext::from_window(window.into(), cx);
    draw(&mut visual);
    (settings, visual)
}

#[gpui::test]
fn held_recording_action_does_not_move_to_a_different_recording(cx: &mut TestAppContext) {
    let (settings, mut visual) = open_two_recordings(cx);
    let link = point(px(432.), px(40.));
    visual.simulate_mouse_move(link, None, Modifiers::none());
    visual.simulate_mouse_down(link, MouseButton::Left, Modifiers::none());
    settings.update(&mut visual, |settings, _| {
        settings.recordings.items.as_mut().unwrap().remove(0);
    });
    draw(&mut visual);
    visual.simulate_mouse_up(link, MouseButton::Left, Modifiers::none());
    assert_eq!(visual.opened_url(), None);
    visual.simulate_click(link, Modifiers::none());
    assert_eq!(
        visual.opened_url().as_deref(),
        Some("https://cap.test/second")
    );
}

#[gpui::test]
fn held_recording_action_survives_an_unchanged_refresh(cx: &mut TestAppContext) {
    let (settings, mut visual) = open_two_recordings(cx);
    let link = point(px(432.), px(40.));
    visual.simulate_mouse_move(link, None, Modifiers::none());
    visual.simulate_mouse_down(link, MouseButton::Left, Modifiers::none());
    settings.update(&mut visual, |settings, _| {
        settings.recordings.items = Some(vec![row("first"), row("second")]);
    });
    draw(&mut visual);
    visual.simulate_mouse_up(link, MouseButton::Left, Modifiers::none());
    assert_eq!(
        visual.opened_url().as_deref(),
        Some("https://cap.test/first")
    );
}

#[gpui::test]
fn held_recording_action_follows_the_same_recording_after_reordering(cx: &mut TestAppContext) {
    let (settings, mut visual) = open_two_recordings(cx);
    let old_link = point(px(432.), px(116.));
    let new_link = point(px(432.), px(40.));
    visual.simulate_mouse_move(old_link, None, Modifiers::none());
    visual.simulate_mouse_down(old_link, MouseButton::Left, Modifiers::none());
    settings.update(&mut visual, |settings, _| {
        settings.recordings.items.as_mut().unwrap().remove(0);
    });
    draw(&mut visual);
    visual.simulate_mouse_move(new_link, Some(MouseButton::Left), Modifiers::none());
    visual.simulate_mouse_up(new_link, MouseButton::Left, Modifiers::none());
    assert_eq!(
        visual.opened_url().as_deref(),
        Some("https://cap.test/second")
    );
}
