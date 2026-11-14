use gpui::{ListOffset, Modifiers, TestAppContext, WindowHandle, point, px};

use super::super::{
    AppTheme, CONTENT_PADDING_X, Page, RecordingsTab, SETTINGS_HEIGHT, SETTINGS_WIDTH,
    SettingsWindow, SignIn, render_bench::rows,
};

fn open(cx: &mut TestAppContext, count: usize) -> WindowHandle<SettingsWindow> {
    cx.update(|cx| {
        SignIn::init(cx);
        crate::ui::bind_text_input_keys(cx);
        crate::theme::init(AppTheme::Light, cx);
    });
    let handle = cx.open_window(
        gpui::size(px(SETTINGS_WIDTH), px(SETTINGS_HEIGHT)),
        |window, cx| SettingsWindow::new(Page::Recordings, window, cx),
    );
    handle
        .update(cx, |view, _, cx| {
            view.recordings.items = Some(rows(count));
            cx.notify();
        })
        .unwrap();
    handle
}

fn draw(handle: WindowHandle<SettingsWindow>, cx: &mut TestAppContext) {
    cx.update(|cx| {
        handle.update(cx, |_, window, _| window.refresh()).unwrap();
        crate::draw_bench::timed_draw(handle.into(), cx).unwrap();
    });
}

#[gpui::test]
fn filtered_rows_keep_their_actions_after_scrolling(cx: &mut TestAppContext) {
    let handle = open(cx, 1000);
    handle
        .update(cx, |view, _, cx| {
            view.recordings.tab = RecordingsTab::Studio;
            view.recordings.search = "Recording".into();
            cx.notify();
        })
        .unwrap();
    draw(handle, cx);
    let list = handle
        .update(cx, |view, _, _| view.recordings.list.clone())
        .unwrap();
    assert_eq!(list.item_count(), 667);
    assert!(list.bounds_for_item(100).is_none());
    list.scroll_to(ListOffset {
        item_ix: 101,
        offset_in_item: px(0.),
    });
    draw(handle, cx);
    let row = list.bounds_for_item(101).unwrap();
    let mut visual = gpui::VisualTestContext::from_window(handle.into(), cx);
    visual.simulate_click(
        point(row.right() - px(CONTENT_PADDING_X + 163.), row.center().y),
        Modifiers::default(),
    );
    assert_eq!(
        cx.opened_url().as_deref(),
        Some("https://cap.so/s/recording-151")
    );

    handle
        .update(cx, |view, _, cx| {
            view.recordings.search = "not present".into();
            cx.notify();
        })
        .unwrap();
    draw(handle, cx);
    assert_eq!(list.item_count(), 2);
    assert!(list.bounds_for_item(1).is_some());
    assert!(list.bounds_for_item(2).is_none());
}

#[gpui::test]
fn load_more_keeps_the_footer_and_last_row_in_order(cx: &mut TestAppContext) {
    let handle = open(cx, 53);
    draw(handle, cx);
    let list = handle
        .update(cx, |view, _, _| view.recordings.list.clone())
        .unwrap();
    for (before, after) in [(22, 42), (42, 54)] {
        assert_eq!(list.item_count(), before);
        list.scroll_to_end();
        draw(handle, cx);
        let footer = list.bounds_for_item(before - 1).unwrap();
        let mut visual = gpui::VisualTestContext::from_window(handle.into(), cx);
        visual.simulate_click(
            footer.center() - point(px(0.), px(14.)),
            Modifiers::default(),
        );
        draw(handle, cx);
        assert_eq!(list.item_count(), after);
    }
    handle
        .update(cx, |view, _, cx| {
            view.recordings.items = Some(Vec::new());
            cx.notify();
        })
        .unwrap();
    draw(handle, cx);
    assert_eq!(list.item_count(), 1);
    assert!(list.bounds_for_item(0).is_some());
}

#[gpui::test]
fn search_keeps_accepting_keys_when_the_header_is_offscreen(cx: &mut TestAppContext) {
    let handle = open(cx, 500);
    handle
        .update(cx, |view, window, cx| {
            view.recordings.search = "Recording".into();
            view.recordings.search_input.update(cx, |input, cx| {
                input.set_text("Recording", cx);
            });
            window.focus(&view.recordings.search_input.read(cx).focus_handle(), cx);
            cx.notify();
        })
        .unwrap();
    draw(handle, cx);
    let list = handle
        .update(cx, |view, _, _| view.recordings.list.clone())
        .unwrap();
    list.scroll_to(ListOffset {
        item_ix: 150,
        offset_in_item: px(0.),
    });
    draw(handle, cx);
    assert!(list.bounds_for_item(150).is_some());
    cx.simulate_keystrokes(handle.into(), "backspace");
    handle
        .update(cx, |view, _, _| {
            assert_eq!(view.recordings.search, "Recordin");
        })
        .unwrap();
}

#[gpui::test]
fn header_buttons_keep_their_focus_when_scrolled_offscreen(cx: &mut TestAppContext) {
    let handle = open(cx, 500);
    handle
        .update(cx, |view, _, cx| {
            view.recordings.search = "Recording".into();
            cx.notify();
        })
        .unwrap();
    draw(handle, cx);
    let (list, focused) = handle
        .update(cx, |view, window, cx| {
            window.focus(&view.recordings.header_focus, cx);
            window.focus_next(cx);
            assert!(view.recordings.header_focus.contains_focused(window, cx));
            assert!(!view.recordings.search_input.read(cx).is_focused(window));
            (view.recordings.list.clone(), window.focused(cx).unwrap())
        })
        .unwrap();
    list.scroll_to(ListOffset {
        item_ix: 150,
        offset_in_item: px(0.),
    });
    draw(handle, cx);
    handle
        .update(cx, |view, window, cx| {
            assert!(focused.is_focused(window));
            window.focus_next(cx);
            assert!(!focused.is_focused(window));
            assert!(view.recordings.header_focus.contains_focused(window, cx));
        })
        .unwrap();
}

#[gpui::test]
fn load_more_keeps_keyboard_activation_after_appending_a_page(cx: &mut TestAppContext) {
    let handle = open(cx, 53);
    draw(handle, cx);
    let list = handle
        .update(cx, |view, _, _| view.recordings.list.clone())
        .unwrap();
    list.scroll_to_end();
    draw(handle, cx);
    handle
        .update(cx, |view, window, cx| {
            window.focus(&view.recordings.footer_focus, cx);
            window.focus_next(cx);
            assert!(view.recordings.footer_focus.contains_focused(window, cx));
        })
        .unwrap();
    draw(handle, cx);
    for expected in [42, 54] {
        let mut visual = gpui::VisualTestContext::from_window(handle.into(), cx);
        let keystroke = gpui::Keystroke::parse("space").unwrap();
        visual.simulate_event(gpui::KeyDownEvent {
            keystroke: keystroke.clone(),
            is_held: false,
            prefer_character_input: false,
        });
        visual.simulate_event(gpui::KeyUpEvent { keystroke });
        draw(handle, cx);
        assert_eq!(list.item_count(), expected);
    }
}
