use std::time::Duration;

use cap_notes::{Document, Origin};
use cap_notes_ui::{
    NotesEditor, NotesEvent, NotesLabels, NotesTheme, SlashItem, bind_keys, script,
};
use gpui::{
    App, AppContext, Bounds, Context, Entity, Focusable, IntoElement, KeyBinding, Render, Window,
    WindowBounds, WindowOptions, actions, div, prelude::*, px, size,
};
use gpui_platform::application;

actions!(notes_example, [Quit]);

const SAMPLE: &str = r#"# Weekly product review

Notes from Thursday's session. Everything here is **editable**, *styled* and <u>quietly</u> fast, with ~~old ideas~~ struck out, ==highlights== where they matter, `inline code` for names, and a [link to the spec](https://cap.so/docs/notes). Thanks [@Ana](mention:ana) for running it.

## Decisions

1. Ship the notes editor in the documents window
2. Keep the engine pure and fully tested
   1. Undo groups by idle time
   2. Markdown round trips without loss
3. Measure every frame before merging

### Follow ups

- Typography pass on headings and lists
- Selection shapes
  - Rounded joins between lines of different widths
    - Even three levels deep
- Find bar polish

- [x] Draft the spec
- [ ] Review the keyboard map
- [ ] Record the demo

> Good tools disappear. You only notice the work they let you do.
>
> They stay out of the way.

```rust
fn main() {
    let note = Note::open("weekly-review.md");
    println!("{} blocks", note.blocks().len());
}
```

---

A longer paragraph to show how wrapping behaves at the column width: the measure is kept near seventy characters so lines stay comfortable to read, and the caret keeps its preferred column when moving up and down through wrapped lines and across blocks of different kinds.

Summaries written by the assistant arrive in secondary ink until someone edits them."#;

struct Args {
    path: Option<String>,
    dark: bool,
    width: f32,
    height: f32,
    script: Option<String>,
    snapshot_after: Option<u64>,
    exit_after: Option<u64>,
    read_only: bool,
    activate: bool,
}

fn parse_args() -> Args {
    let mut args = Args {
        path: None,
        dark: false,
        width: 920.,
        height: 760.,
        script: None,
        snapshot_after: None,
        exit_after: None,
        read_only: false,
        activate: false,
    };
    let mut iter = std::env::args().skip(1);
    while let Some(arg) = iter.next() {
        match arg.as_str() {
            "--dark" => args.dark = true,
            "--light" => args.dark = false,
            "--read-only" => args.read_only = true,
            "--activate" => args.activate = true,
            "--width" => args.width = iter.next().and_then(|v| v.parse().ok()).unwrap_or(920.),
            "--height" => args.height = iter.next().and_then(|v| v.parse().ok()).unwrap_or(760.),
            "--script" => args.script = iter.next(),
            "--snapshot-after" => args.snapshot_after = iter.next().and_then(|v| v.parse().ok()),
            "--exit-after" => args.exit_after = iter.next().and_then(|v| v.parse().ok()),
            other if !other.starts_with("--") => args.path = Some(other.to_string()),
            other => eprintln!("unknown flag {other}"),
        }
    }
    args
}

struct Root {
    editor: Entity<NotesEditor>,
}

impl Render for Root {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        div().size_full().child(self.editor.clone())
    }
}

fn document(path: Option<&str>) -> Document {
    match path {
        Some(path) => match std::fs::read_to_string(path) {
            Ok(markdown) => Document::from_markdown(&markdown),
            Err(error) => {
                eprintln!("could not read {path}: {error}");
                Document::new()
            }
        },
        None => {
            let mut doc = Document::from_markdown(SAMPLE);
            if let Some(last) = doc.blocks.last_mut() {
                last.origin = Origin::Generated;
            }
            doc
        }
    }
}

fn main() {
    let args = parse_args();
    application().run(move |cx: &mut App| {
        bind_keys(cx);
        cx.bind_keys([
            KeyBinding::new("cmd-q", Quit, None),
            KeyBinding::new("ctrl-q", Quit, None),
        ]);
        cx.on_action(|_: &Quit, cx: &mut App| cx.quit());
        let doc = document(args.path.as_deref());
        let theme = if args.dark {
            NotesTheme::dark()
        } else {
            NotesTheme::light()
        };
        let bounds = Bounds::centered(None, size(px(args.width), px(args.height)), cx);
        let read_only = args.read_only;
        let window = cx
            .open_window(
                WindowOptions {
                    window_bounds: Some(WindowBounds::Windowed(bounds)),
                    ..Default::default()
                },
                |window, cx| {
                    let editor = cx.new(|cx| {
                        let mut editor =
                            NotesEditor::new(doc, theme, NotesLabels::default(), window, cx);
                        editor.set_read_only(read_only, cx);
                        editor.extra_slash_items(vec![
                            SlashItem::new("standup", "Standup template"),
                            SlashItem::new("retro", "Retro template"),
                        ]);
                        editor
                    });
                    cx.new(|_| Root { editor })
                },
            )
            .expect("open window");
        let editor = window
            .update(cx, |root, _, _| root.editor.clone())
            .expect("root view");
        let activate = args.activate;
        window
            .update(cx, |root, window, cx| {
                let handle = root.editor.read(cx).focus_handle(cx);
                window.focus(&handle, cx);
                if activate {
                    cx.activate(true);
                }
            })
            .ok();
        cx.subscribe(&editor, |_, event: &NotesEvent, _| match event {
            NotesEvent::OpenLink(url) => println!("open link {url}"),
            NotesEvent::SlashCommand(id) => println!("slash command {id}"),
            NotesEvent::RequestMention { query } => println!("mention query {query:?}"),
            _ => {}
        })
        .detach();
        if let Some(path) = args.script.as_deref() {
            match std::fs::read_to_string(path)
                .map_err(|e| e.to_string())
                .and_then(|source| script::parse(&source))
            {
                Ok(steps) => script::run(steps, editor.clone(), window.into(), cx).detach(),
                Err(error) => eprintln!("script error: {error}"),
            }
        }
        if let Some(ms) = args.snapshot_after {
            cx.spawn(async move |cx| {
                cx.background_executor()
                    .timer(Duration::from_millis(ms))
                    .await;
                println!("SNAP snapshot");
            })
            .detach();
        }
        if let Some(ms) = args.exit_after {
            cx.spawn(async move |cx| {
                cx.background_executor()
                    .timer(Duration::from_millis(ms))
                    .await;
                cx.update(|cx| cx.quit());
            })
            .detach();
        }
    });
}
