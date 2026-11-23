use std::time::Duration;

use cap_notes::{Origin, Pos, Selection};
use gpui::{
    AnyWindowHandle, App, AppContext, Entity, EntityInputHandler, Keystroke, Modifiers,
    MouseButton, MouseDownEvent, MouseMoveEvent, MouseUpEvent, Pixels, PlatformInput, Point, Task,
    Window, point, px, size,
};

use crate::editor::NotesEditor;
use crate::menu::SlashItem;
use crate::theme::NotesTheme;

#[derive(Clone, Debug, PartialEq)]
pub enum Step {
    Type(String),
    Key(Vec<String>),
    Caret(Pos),
    Select(Pos, Pos),
    Click {
        pos: Pos,
        count: usize,
        shift: bool,
        secondary: bool,
        right: bool,
    },
    Drag(Pos, Pos),
    Hover(Pos),
    Checkbox(usize),
    Mark(String),
    Commit(String),
    Unmark,
    Wait(u64),
    Theme(bool),
    Resize(f32, f32),
    Scroll(usize),
    ScrollBy(f32),
    Find(String),
    Link(String),
    Stream(String),
    ReadOnly(bool),
    SlashItems(Vec<String>),
    Focus,
    Clear,
    Snap(String, u64),
    Print(String),
}

fn unescape(text: &str) -> String {
    text.replace("\\n", "\n").replace("\\t", "\t")
}

fn pos(parts: &[&str], at: usize) -> Result<Pos, String> {
    let block = parts
        .get(at)
        .and_then(|s| s.parse().ok())
        .ok_or("missing block")?;
    let offset = parts
        .get(at + 1)
        .and_then(|s| s.parse().ok())
        .ok_or("missing offset")?;
    Ok(Pos::new(block, offset))
}

pub fn parse(source: &str) -> Result<Vec<Step>, String> {
    let mut steps = Vec::new();
    for (number, raw) in source.lines().enumerate() {
        let line = raw.trim_start();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let (command, rest) = line.split_once(' ').unwrap_or((line, ""));
        let parts: Vec<&str> = rest.split_whitespace().collect();
        let fail = |message: &str| format!("line {}: {message}: {raw}", number + 1);
        let step = match command {
            "type" => Step::Type(unescape(rest)),
            "key" => Step::Key(parts.iter().map(|s| s.to_string()).collect()),
            "caret" => Step::Caret(pos(&parts, 0).map_err(|e| fail(&e))?),
            "select" => Step::Select(
                pos(&parts, 0).map_err(|e| fail(&e))?,
                pos(&parts, 2).map_err(|e| fail(&e))?,
            ),
            "click" | "rightclick" => Step::Click {
                pos: pos(&parts, 0).map_err(|e| fail(&e))?,
                count: parts.get(2).and_then(|s| s.parse().ok()).unwrap_or(1),
                shift: parts.contains(&"shift"),
                secondary: parts.contains(&"secondary"),
                right: command == "rightclick",
            },
            "drag" => Step::Drag(
                pos(&parts, 0).map_err(|e| fail(&e))?,
                pos(&parts, 2).map_err(|e| fail(&e))?,
            ),
            "hover" => Step::Hover(pos(&parts, 0).map_err(|e| fail(&e))?),
            "checkbox" => Step::Checkbox(rest.trim().parse().map_err(|_| fail("bad block"))?),
            "mark" => Step::Mark(unescape(rest)),
            "commit" => Step::Commit(unescape(rest)),
            "unmark" => Step::Unmark,
            "wait" => Step::Wait(rest.trim().parse().map_err(|_| fail("bad wait"))?),
            "theme" => Step::Theme(rest.trim() == "dark"),
            "resize" => Step::Resize(
                parts
                    .first()
                    .and_then(|s| s.parse().ok())
                    .ok_or_else(|| fail("width"))?,
                parts
                    .get(1)
                    .and_then(|s| s.parse().ok())
                    .ok_or_else(|| fail("height"))?,
            ),
            "scroll" => Step::Scroll(rest.trim().parse().map_err(|_| fail("bad block"))?),
            "scrollby" => Step::ScrollBy(rest.trim().parse().map_err(|_| fail("bad delta"))?),
            "find" => Step::Find(unescape(rest)),
            "link" => Step::Link(unescape(rest)),
            "stream" => Step::Stream(unescape(rest)),
            "readonly" => Step::ReadOnly(rest.trim() == "on"),
            "slashitems" => Step::SlashItems(
                rest.split(',')
                    .map(|s| s.trim().to_string())
                    .filter(|s| !s.is_empty())
                    .collect(),
            ),
            "focus" => Step::Focus,
            "clear" => Step::Clear,
            "snap" => Step::Snap(
                parts.first().ok_or_else(|| fail("name"))?.to_string(),
                parts.get(1).and_then(|s| s.parse().ok()).unwrap_or(600),
            ),
            "print" => Step::Print(rest.to_string()),
            other => return Err(fail(&format!("unknown command {other}"))),
        };
        steps.push(step);
    }
    Ok(steps)
}

pub fn checkbox_point(editor: &NotesEditor, block: usize) -> Option<Point<Pixels>> {
    let store = editor.store.borrow();
    let painted = store.painted(block)?;
    let layout = store.slots.get(block)?.layout.as_ref()?;
    let size = f32::from(editor.theme.checkbox_size);
    Some(point(
        px(painted.text_left - f32::from(editor.theme.list_indent) + size / 2.),
        px(painted.text_top + layout.baseline(0) - layout.cap_height / 2.),
    ))
}

pub fn point_for(editor: &NotesEditor, pos: Pos) -> Option<Point<Pixels>> {
    let store = editor.store.borrow();
    let painted = store.painted(pos.block)?;
    let layout = store.slots.get(pos.block)?.layout.as_ref()?;
    let caret = layout.caret(layout.to_virtual(pos.offset), false);
    Some(point(
        px(painted.text_left + caret.x),
        px(painted.text_top + caret.top + caret.height / 2.),
    ))
}

fn modifiers(shift: bool, secondary: bool) -> Modifiers {
    let mut modifiers = Modifiers {
        shift,
        ..Modifiers::default()
    };
    if secondary {
        if cfg!(target_os = "macos") {
            modifiers.platform = true;
        } else {
            modifiers.control = true;
        }
    }
    modifiers
}

fn mouse_down(
    position: Point<Pixels>,
    button: MouseButton,
    count: usize,
    mods: Modifiers,
) -> PlatformInput {
    PlatformInput::MouseDown(MouseDownEvent {
        button,
        position,
        modifiers: mods,
        click_count: count,
        first_mouse: false,
    })
}

fn mouse_up(
    position: Point<Pixels>,
    button: MouseButton,
    count: usize,
    mods: Modifiers,
) -> PlatformInput {
    PlatformInput::MouseUp(MouseUpEvent {
        button,
        position,
        modifiers: mods,
        click_count: count,
    })
}

fn mouse_move(position: Point<Pixels>, pressed: Option<MouseButton>) -> PlatformInput {
    PlatformInput::MouseMove(MouseMoveEvent {
        position,
        pressed_button: pressed,
        modifiers: Modifiers::default(),
    })
}

fn type_into<V: EntityInputHandler>(
    entity: &Entity<V>,
    text: &str,
    window: &mut Window,
    cx: &mut App,
) {
    entity.update(cx, |input, cx| {
        input.replace_text_in_range(None, text, window, cx);
    });
}

pub fn run(
    steps: Vec<Step>,
    editor: Entity<NotesEditor>,
    window: AnyWindowHandle,
    cx: &mut App,
) -> Task<()> {
    cx.spawn(async move |cx| {
        let frame = Duration::from_millis(34);
        for step in steps {
            let mut extra = 0;
            let mut steps_for_drag: Option<(Point<Pixels>, Point<Pixels>)> = None;
            let resolve = |pos: Pos, cx: &mut gpui::AsyncApp| -> Option<Point<Pixels>> {
                cx.read_entity(&editor, |editor, _| point_for(editor, pos))
            };
            let needs_point = match &step {
                Step::Click { pos, .. } | Step::Hover(pos) => Some(vec![*pos]),
                Step::Drag(a, b) => Some(vec![*a, *b]),
                _ => None,
            };
            if let Some(positions) = needs_point {
                for pos in &positions {
                    if resolve(*pos, cx).is_none() {
                        editor.update(cx, |editor, cx| editor.scroll_to_block(pos.block, cx));
                        cx.background_executor().timer(frame * 2).await;
                    }
                }
            }
            let result = window.update(cx, |_, window, cx| match &step {
                Step::Type(text) => {
                    let focused_field = editor.read(cx).focused_field(window, cx);
                    for ch in text.chars() {
                        if ch == '\n' {
                            if let Ok(keystroke) = Keystroke::parse("enter") {
                                window.dispatch_keystroke(keystroke, cx);
                            }
                            continue;
                        }
                        let s = ch.to_string();
                        match &focused_field {
                            Some(field) => type_into(field, &s, window, cx),
                            None => type_into(&editor, &s, window, cx),
                        }
                    }
                }
                Step::Key(chords) => {
                    for chord in chords {
                        if let Ok(keystroke) = Keystroke::parse(chord) {
                            window.dispatch_keystroke(keystroke, cx);
                        } else {
                            eprintln!("bad keystroke {chord}");
                        }
                    }
                }
                Step::Caret(pos) => editor.update(cx, |editor, cx| {
                    editor.apply(
                        |e| {
                            e.set_selection(Selection::caret(*pos));
                            cap_notes::Change::default()
                        },
                        cx,
                    )
                }),
                Step::Select(a, b) => editor.update(cx, |editor, cx| {
                    editor.apply(
                        |e| {
                            e.set_selection(Selection::new(*a, *b));
                            cap_notes::Change::default()
                        },
                        cx,
                    );
                    editor.show_toolbar(cx);
                }),
                Step::Click {
                    pos,
                    count,
                    shift,
                    secondary,
                    right,
                } => {
                    let Some(p) = point_for(editor.read(cx), *pos) else {
                        eprintln!("click target {pos:?} is not on screen");
                        return;
                    };
                    let button = if *right {
                        MouseButton::Right
                    } else {
                        MouseButton::Left
                    };
                    let mods = modifiers(*shift, *secondary);
                    window.dispatch_event(mouse_move(p, None), cx);
                    for n in 1..=*count {
                        window.dispatch_event(mouse_down(p, button, n, mods), cx);
                        window.dispatch_event(mouse_up(p, button, n, mods), cx);
                    }
                }
                Step::Drag(a, b) => {
                    let (Some(pa), Some(pb)) = (
                        point_for(editor.read(cx), *a),
                        point_for(editor.read(cx), *b),
                    ) else {
                        eprintln!("drag target is not on screen");
                        return;
                    };
                    window.dispatch_event(mouse_move(pa, None), cx);
                    window.dispatch_event(
                        mouse_down(pa, MouseButton::Left, 1, Modifiers::default()),
                        cx,
                    );
                    steps_for_drag = Some((pa, pb));
                }
                Step::Checkbox(block) => {
                    if let Some(p) = checkbox_point(editor.read(cx), *block) {
                        window.dispatch_event(mouse_move(p, None), cx);
                        let mods = Modifiers::default();
                        window.dispatch_event(mouse_down(p, MouseButton::Left, 1, mods), cx);
                        window.dispatch_event(mouse_up(p, MouseButton::Left, 1, mods), cx);
                    }
                }
                Step::Hover(pos) => {
                    if let Some(p) = point_for(editor.read(cx), *pos) {
                        window.dispatch_event(mouse_move(p, None), cx);
                    }
                }
                Step::Mark(text) => editor.update(cx, |editor, cx| {
                    let caret = text.encode_utf16().count();
                    editor.replace_and_mark_text_in_range(
                        None,
                        text,
                        Some(caret..caret),
                        window,
                        cx,
                    );
                }),
                Step::Commit(text) => editor.update(cx, |editor, cx| {
                    editor.replace_text_in_range(None, text, window, cx);
                }),
                Step::Unmark => editor.update(cx, |editor, cx| editor.unmark_text(window, cx)),
                Step::Wait(ms) => extra = *ms,
                Step::Theme(dark) => editor.update(cx, |editor, cx| {
                    editor.set_theme(
                        if *dark {
                            NotesTheme::dark()
                        } else {
                            NotesTheme::light()
                        },
                        cx,
                    )
                }),
                Step::Resize(w, h) => window.resize(size(px(*w), px(*h))),
                Step::Scroll(block) => {
                    editor.update(cx, |editor, cx| editor.scroll_to_block(*block, cx))
                }
                Step::ScrollBy(delta) => editor.update(cx, |editor, cx| {
                    let mut store = editor.store.borrow_mut();
                    let y = store.scroll_y() + delta;
                    store.set_scroll_y(y);
                    store.autoscroll = None;
                    drop(store);
                    editor.note_scroll(cx);
                }),
                Step::Find(query) => {
                    editor.update(cx, |editor, cx| editor.show_find(window, cx));
                    if let Some(field) = editor.read(cx).find.as_ref().map(|f| f.field.clone()) {
                        type_into(&field, query, window, cx);
                    }
                }
                Step::Link(url) => {
                    editor.update(cx, |editor, cx| editor.open_link_editor(window, cx));
                    if let Some(field) = editor.read(cx).link_edit.as_ref().map(|f| f.field.clone())
                    {
                        type_into(&field, url, window, cx);
                    }
                }
                Step::Stream(text) => editor.update(cx, |editor, cx| {
                    editor.append_markdown_streaming(text, Origin::Generated, cx)
                }),
                Step::ReadOnly(on) => editor.update(cx, |editor, cx| editor.set_read_only(*on, cx)),
                Step::SlashItems(items) => editor.update(cx, |editor, cx| {
                    editor.extra_slash_items(
                        items
                            .iter()
                            .map(|label| SlashItem::new(label.to_lowercase(), label.clone()))
                            .collect(),
                    );
                    cx.notify();
                }),
                Step::Focus => editor.update(cx, |editor, cx| editor.focus(window, cx)),
                Step::Clear => editor.update(cx, |editor, cx| {
                    editor.set_document(cap_notes::Document::new(), cx)
                }),
                Step::Snap(name, ms) => {
                    println!("SNAP {name}");
                    extra = *ms;
                }
                Step::Print(text) => println!("{text}"),
            });
            if result.is_err() {
                return;
            }
            if let Some((a, b)) = steps_for_drag {
                for i in 1..=8 {
                    let t = i as f32 / 8.;
                    let p = point(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t);
                    window
                        .update(cx, |_, window, cx| {
                            window.dispatch_event(mouse_move(p, Some(MouseButton::Left)), cx);
                        })
                        .ok();
                    cx.background_executor()
                        .timer(Duration::from_millis(16))
                        .await;
                }
                window
                    .update(cx, |_, window, cx| {
                        window.dispatch_event(
                            mouse_up(b, MouseButton::Left, 1, Modifiers::default()),
                            cx,
                        );
                    })
                    .ok();
            }
            cx.background_executor()
                .timer(frame + Duration::from_millis(extra))
                .await;
        }
    })
}

impl NotesEditor {
    pub(crate) fn focused_field(
        &self,
        window: &Window,
        cx: &App,
    ) -> Option<Entity<crate::field::LineField>> {
        let candidates: Vec<_> = self
            .find
            .as_ref()
            .map(|f| f.field.clone())
            .into_iter()
            .chain(self.link_edit.as_ref().map(|l| l.field.clone()))
            .collect();
        candidates
            .into_iter()
            .find(|field| gpui::Focusable::focus_handle(field.read(cx), cx).is_focused(window))
    }
}
