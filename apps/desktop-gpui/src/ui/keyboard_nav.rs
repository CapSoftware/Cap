//! Tab / Shift-Tab focus navigation for the windows that opt in.
//!
//! Nothing in a window has focus until the user presses Tab, and the main
//! window has no root focus handle, so a key binding would never match there:
//! with no focused node only the root receives keys. An owner-scoped
//! keystroke interceptor runs before bindings and element listeners instead.
//!
//! Tab stops that are not already focusable are only added while a window is
//! in keyboard mode, which starts on Tab and ends on the next mouse press. A
//! focusable element takes focus on click and fires its click handler on
//! Enter/Space key-up, so adding them unconditionally would change what mouse
//! users get.

use std::collections::HashSet;

use gpui::{
    App, BoxShadow, Context, DispatchPhase, Global, InteractiveElement, IntoElement, Keystroke,
    MouseDownEvent, Styled, Subscription, Window, WindowId, canvas, point, px, rgb,
};

use crate::{theme::Theme, ui::text_input::text_input_is_composing};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Direction {
    Next,
    Previous,
}

pub fn direction(keystroke: &Keystroke) -> Option<Direction> {
    let modifiers = keystroke.modifiers;
    if keystroke.key != "tab"
        || modifiers.control
        || modifiers.alt
        || modifiers.platform
        || modifiers.function
    {
        return None;
    }
    Some(if modifiers.shift {
        Direction::Previous
    } else {
        Direction::Next
    })
}

fn takes_tab(blocked: bool, prompt_active: bool, composing: bool) -> bool {
    !(blocked || prompt_active || composing)
}

#[derive(Default)]
struct KeyboardWindows(HashSet<WindowId>);

impl Global for KeyboardWindows {}

pub fn active(window: &Window, cx: &App) -> bool {
    cx.try_global::<KeyboardWindows>()
        .is_some_and(|windows| windows.0.contains(&window.window_handle().window_id()))
}

pub fn leave(window: &mut Window, cx: &mut App) {
    let id = window.window_handle().window_id();
    if cx.has_global::<KeyboardWindows>() && cx.global_mut::<KeyboardWindows>().0.remove(&id) {
        window.refresh();
    }
}

/// Leaves keyboard mode on any mouse press in the window. A window-level
/// listener, because `.occlude()` hitboxes (menus, modals, the Windows header)
/// hide the root from element mouse listeners.
pub fn pointer_watcher() -> impl IntoElement {
    canvas(
        |_, _, _| (),
        |_, (), window, _| {
            window.on_mouse_event(|_: &MouseDownEvent, phase, window, cx| {
                if phase == DispatchPhase::Capture {
                    leave(window, cx);
                }
            });
        },
    )
    .absolute()
    .inset_0()
}

/// Route Tab in `window` to focus navigation. `blocked` lets the owner keep
/// Tab for itself, e.g. while a shortcut recorder or a modal is up.
pub fn install<V: 'static>(
    window: &Window,
    cx: &mut Context<V>,
    blocked: impl Fn(&V, &App) -> bool + 'static,
) -> Subscription {
    let owner = window.window_handle().window_id();
    let view = cx.weak_entity();
    cx.intercept_keystrokes(move |event, window, cx| {
        if window.window_handle().window_id() != owner {
            return;
        }
        let Some(direction) = direction(&event.keystroke) else {
            return;
        };
        let Some(view) = view.upgrade() else {
            return;
        };
        if !takes_tab(
            blocked(view.read(cx), cx),
            window.has_active_prompt(),
            text_input_is_composing(window, cx),
        ) {
            return;
        }
        navigate(direction, window, cx);
        window.prevent_default();
        cx.stop_propagation();
    })
}

fn navigate(direction: Direction, window: &mut Window, cx: &mut App) {
    let entered = cx
        .default_global::<KeyboardWindows>()
        .0
        .insert(window.window_handle().window_id());
    if !entered {
        move_focus(direction, window, cx);
        return;
    }
    // The stops gated on keyboard mode only exist from the next draw on, and
    // `focus_next` walks the last rendered frame. Next-frame callbacks run
    // before that frame draws, so the move waits one frame more.
    window.refresh();
    window.on_next_frame(move |window, _| {
        window.on_next_frame(move |window, cx| {
            if active(window, cx) {
                move_focus(direction, window, cx);
            }
        });
    });
}

fn move_focus(direction: Direction, window: &mut Window, cx: &mut App) {
    match direction {
        Direction::Next => window.focus_next(cx),
        Direction::Previous => window.focus_prev(cx),
    }
}

pub fn ring<E: InteractiveElement>(element: E) -> E {
    element.focus_visible(|style| {
        style.shadow(vec![BoxShadow {
            color: rgb(Theme::SETTINGS_ACCENT).into(),
            offset: point(px(0.), px(0.)),
            blur_radius: px(0.),
            spread_radius: px(2.),
            inset: true,
        }])
    })
}

pub fn stop<E: InteractiveElement>(element: E) -> E {
    ring(element.tab_index(0))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parsed(source: &str) -> Option<Direction> {
        direction(&Keystroke::parse(source).unwrap())
    }

    #[test]
    fn only_bare_tab_and_shift_tab_navigate() {
        assert_eq!(parsed("tab"), Some(Direction::Next));
        assert_eq!(parsed("shift-tab"), Some(Direction::Previous));
        for source in [
            "ctrl-tab",
            "ctrl-shift-tab",
            "alt-tab",
            "cmd-tab",
            "fn-tab",
            "secondary-tab",
            "enter",
            "space",
            "escape",
            "t",
        ] {
            assert_eq!(parsed(source), None, "{source}");
        }
    }

    #[test]
    fn tab_is_left_alone_while_anything_else_owns_it() {
        assert!(takes_tab(false, false, false));
        for (blocked, prompt_active, composing) in [
            (true, false, false),
            (false, true, false),
            (false, false, true),
            (true, true, true),
        ] {
            assert!(!takes_tab(blocked, prompt_active, composing));
        }
    }
}
