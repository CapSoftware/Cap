//! The screenshot editor's crop dialog -- the `type: "crop"` arm of
//! `routes/screenshot-editor/Editor.tsx`'s `Dialogs()` (`:199-492`).
//!
//! It is the *simpler* of the two crop dialogs: one cropper over the original
//! PNG, no live preview pane beside it. The header carries the Size/Position
//! number boxes, the round ratio button, Full and Reset; the footer a single
//! Save that writes `background.crop` as one history entry. Escape and the
//! backdrop cancel without writing anything -- the dialog never touches the
//! project until Save, which is why nothing here publishes to the renderer.
//!
//! The engine is [`crate::editor_crop`]'s wholesale: the same `CropState`
//! (container/target space split, ratio locking, snap, the 240ms animation),
//! the same `hit_test`/`handle_rect` zones, the same painters for the
//! occluders, thirds grid and corner glyphs, and the same window-wide drag
//! layer. What differs is the box sizing -- `previewSize()`
//! (`Editor.tsx:278-289`): `min(vw * 0.8, 768) x vh * 0.65` fitted to the
//! *image's* aspect, not the video dialog's `min(vw * 0.4, 520)` pair -- and
//! the snap toggle's home, `store::PersistedState.screenshot_crop_snap_to_ratio`
//! (`editorCropSnapToRatio` in localStorage over there).

use std::cell::Cell;
use std::collections::HashMap;
use std::path::Path;
use std::rc::Rc;
use std::sync::Arc;
use std::time::{Duration, Instant};

use cap_project::{Crop, XY};
use gpui::{
    AnyElement, AppContext as _, Bounds, Context, CursorStyle, Entity, FontWeight, Hsla,
    InteractiveElement as _, IntoElement, MouseButton, MouseDownEvent, MouseMoveEvent,
    ParentElement as _, Pixels, Point, RenderImage, SharedString, StatefulInteractiveElement as _,
    Styled as _, Window, div, img, px, svg,
};

use crate::editor_crop::{
    self as engine, CropAnim, CropBounds, CropDrag, CropField, CropHit, CropMenuChoice, CropState,
    HANDLES, ResizeSession, SE_HANDLE, Vec2,
};
use crate::screenshot_editor::ScreenshotEditorWindow;
use crate::theme::Theme;
use crate::ui;

/// `Dialog.Header` -- `h-14 px-4` (`ui.tsx:224-226`).
const DIALOG_HEADER_HEIGHT: f32 = 56.;
/// `Dialog.Footer` -- `h-16 px-4` (`ui.tsx:204-222`).
const DIALOG_FOOTER_HEIGHT: f32 = 64.;
/// `w-13` on each of the four header boxes (`Editor.tsx:351-366`).
const BOUND_INPUT_WIDTH: f32 = 52.;

/// The header boxes, in `Editor.tsx`'s order: Size W x H, then Position X x Y.
const CROP_FIELDS: [CropField; 4] = [
    CropField::Width,
    CropField::Height,
    CropField::X,
    CropField::Y,
];

/// `previewSize()` (`Editor.tsx:278-289`): the source's aspect fitted into
/// `min(vw * 0.8, 768) x vh * 0.65`. Unlike the video dialog's box this can
/// upscale a small screenshot -- the source does not clamp the ratio at 1.
pub fn crop_box_size(viewport: (f32, f32), image: (u32, u32)) -> (f32, f32) {
    let source_width = image.0.max(1) as f32;
    let source_height = image.1.max(1) as f32;
    let max_width = (viewport.0 * 0.8).min(768.);
    let max_height = viewport.1 * 0.65;
    let ratio = (max_width / source_width).min(max_height / source_height);
    (source_width * ratio, source_height * ratio)
}

/// Everything the open dialog owns. `None` on the window means closed.
pub struct ScreenshotCropDialog {
    pub(crate) state: CropState,
    /// The cropper box's painted rect -- the `getBoundingClientRect` stand-in
    /// every pointer position is made container-local through.
    pub(crate) area: Rc<Cell<Option<Bounds<Pixels>>>>,
    /// `bundle/original.png`, decoded once on the background executor -- the
    /// `<img src={convertFileSrc(imagePath())}>` (`Editor.tsx:453-457`).
    image: Option<Arc<RenderImage>>,
    image_task: Option<gpui::Task<()>>,
    /// `editorCropSnapToRatio`, loaded from the store at open and written back
    /// on toggle.
    snap_to_ratio: bool,
    fields: HashMap<CropField, Entity<ui::TextInputState>>,
    /// Dropped with the dialog, which is what unsubscribes the field events.
    _field_subscriptions: Vec<gpui::Subscription>,
}

impl ScreenshotEditorWindow {
    /// The header's crop button (`Header.tsx:84-93`): open the dialog seeded
    /// with the crop in force, or the whole image. Gated on `image_size` the
    /// same way the button's `disabled` is.
    pub(crate) fn open_crop_dialog(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.crop.is_some() {
            return;
        }
        let Some(target) = self.image_size else {
            return;
        };

        let initial = match &self.project.background.crop {
            Some(crop) => CropBounds::new(
                f64::from(crop.position.x),
                f64::from(crop.position.y),
                f64::from(crop.size.x),
                f64::from(crop.size.y),
            ),
            None => CropBounds::new(0., 0., f64::from(target.0), f64::from(target.1)),
        };

        let viewport = window.viewport_size();
        let box_size = crop_box_size((viewport.width.into(), viewport.height.into()), target);
        let state = CropState::new(target, box_size, initial);

        let mut fields = HashMap::new();
        let mut subscriptions = Vec::new();
        for field in CROP_FIELDS {
            let input = cx.new(|cx| ui::TextInputState::single_line(window, cx));
            subscriptions.push(cx.subscribe_in(
                &input,
                window,
                move |this: &mut Self, _input, event: &ui::TextInputEvent, window, cx| {
                    this.on_crop_field_event(field, event, window, cx);
                },
            ));
            fields.insert(field, input);
        }

        let mut dialog = ScreenshotCropDialog {
            state,
            area: Rc::default(),
            image: None,
            image_task: None,
            snap_to_ratio: crate::store::load()
                .screenshot_crop_snap_to_ratio
                .unwrap_or(true),
            fields,
            _field_subscriptions: subscriptions,
        };

        let image_path = crate::screenshot_editor::bundle_image_path(&self.bundle);
        dialog.image_task = Some(cx.spawn_in(window, async move |this, cx| {
            let decoded = cx
                .background_executor()
                .spawn(async move { decode_crop_image(image_path.as_deref()) })
                .await;
            this.update(cx, |this, cx| {
                if let Some(dialog) = this.crop.as_mut() {
                    dialog.image = decoded;
                    cx.notify();
                }
            })
            .ok();
        }));

        self.crop = Some(dialog);
        // The five styling popovers and the chrome menus sit under the modal.
        self.dismiss_chrome_popups();
        window.focus(&self.focus, cx);
        cx.notify();
        window.refresh();
    }

    /// Close without writing -- Escape or the backdrop. The project was never
    /// touched, so there is nothing to roll back.
    pub(crate) fn cancel_crop_dialog(&mut self, reason: &'static str, cx: &mut Context<Self>) {
        if self.crop.take().is_none() {
            return;
        }
        tracing::info!(reason, "screenshot crop cancelled");
        cx.notify();
    }

    /// The footer's Save (`Editor.tsx:463-482`): one `setProject` write of
    /// `background.crop`, so one history entry, then close.
    fn save_crop_dialog(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(dialog) = self.crop.take() else {
            return;
        };
        let bounds = dialog.state.real();
        let crop = Crop {
            position: XY::new(bounds.x.max(0.) as u32, bounds.y.max(0.) as u32),
            size: XY::new(bounds.width.max(0.) as u32, bounds.height.max(0.) as u32),
        };
        tracing::info!(
            crop = format!(
                "{},{} {}x{}",
                crop.position.x, crop.position.y, crop.size.x, crop.size.y
            ),
            "screenshot crop saved"
        );
        self.edit_project(
            move |project| {
                project.background.crop = Some(crop);
                true
            },
            window,
            cx,
        );
        window.refresh();
    }

    /// The source's `ResizeObserver` + window-resize pair: the box is a
    /// fraction of the viewport, so every render re-derives it and the
    /// *target*-space rect survives. Runs from `render`.
    pub(crate) fn sync_crop_dialog_container(&mut self, window: &Window) {
        let Some((target, area)) = self
            .crop
            .as_ref()
            .map(|dialog| (dialog.state.target, dialog.area.get()))
        else {
            return;
        };
        let viewport = window.viewport_size();
        let box_size = crop_box_size((viewport.width.into(), viewport.height.into()), target);
        // Measured, not computed: the screenshot cropper has no hairline
        // border, so its content box is the box itself -- but the cell is
        // still the truth once it has been painted.
        let container = match area {
            Some(bounds) if bounds.size.width > px(1.) && bounds.size.height > px(1.) => {
                (f32::from(bounds.size.width), f32::from(bounds.size.height))
            }
            _ => box_size,
        };
        if let Some(dialog) = self.crop.as_mut() {
            dialog.state.set_container(box_size, container);
        }
    }

    // -- Pointer --------------------------------------------------------------

    /// One handler for the whole container -- `editor_crop::crop_mouse_down`'s
    /// shape, against this window's dialog.
    pub(crate) fn crop_dialog_mouse_down(
        &mut self,
        event: &MouseDownEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(dialog) = self.crop.as_mut() else {
            return;
        };
        let area = dialog.area.get();
        let state = &mut dialog.state;
        let point = engine::crop_local(area, event.position);

        if event.click_count == 2 {
            match engine::hit_test(point, state.raw) {
                CropHit::Handle(handle) => {
                    state.stop_animation();
                    let container = state.container_vec();
                    let bounds = engine::double_click_bounds(handle, state.raw, container);
                    state.set_raw_and_animate(bounds, handle.origin, CropAnim::DEFAULT);
                }
                CropHit::Move => {}
                CropHit::Draw => state.fill(),
            }
            state.drag = None;
            self.start_crop_dialog_ticker(window, cx);
            cx.notify();
            return;
        }

        state.stop_animation();
        match engine::hit_test(point, state.raw) {
            CropHit::Handle(handle) => {
                state.hovering = Some(handle);
                state.drag = Some(CropDrag::Handle(ResizeSession {
                    start_bounds: state.raw,
                    is_alt: event.modifiers.alt,
                    active_handle: handle,
                    original_handle: handle,
                }));
            }
            CropHit::Move => {
                let bounds = state.raw;
                state.drag = Some(CropDrag::Region {
                    start_offset: Vec2::new(point.x - bounds.x, point.y - bounds.y),
                    bounds,
                });
            }
            CropHit::Draw => {
                let restore = state.raw;
                let start = CropBounds::new(point.x, point.y, 1., 1.);
                state.drag = Some(CropDrag::Overlay {
                    restore,
                    session: ResizeSession {
                        start_bounds: start,
                        is_alt: event.modifiers.alt,
                        active_handle: SE_HANDLE,
                        original_handle: SE_HANDLE,
                    },
                });
                state.hovering = Some(SE_HANDLE);
            }
        }
        cx.notify();
    }

    pub(crate) fn crop_dialog_mouse_move(
        &mut self,
        event: &MouseMoveEvent,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(dialog) = self.crop.as_mut() else {
            return;
        };
        let snap = dialog.snap_to_ratio;
        let area = dialog.area.get();
        let state = &mut dialog.state;
        let point = engine::crop_local(area, event.position);
        let Some(drag) = state.drag else {
            let hovering = match engine::hit_test(point, state.raw) {
                CropHit::Handle(handle) => Some(handle),
                _ => None,
            };
            if hovering.map(|h| h.direction) != state.hovering.map(|h| h.direction) {
                state.hovering = hovering;
                cx.notify();
            }
            return;
        };

        match drag {
            CropDrag::Region {
                start_offset,
                bounds,
            } => {
                let container = state.container_vec();
                // The source's own `clamp`: max first, min last, so a region
                // wider than the container pins to the overflow rather than
                // panicking the way `f64::clamp` would.
                let new_x = (point.x - start_offset.x)
                    .max(0.)
                    .min(container.x - bounds.width);
                let new_y = (point.y - start_offset.y)
                    .max(0.)
                    .min(container.y - bounds.height);
                let moved = engine::move_bounds(bounds, Some(new_x), Some(new_y));
                state.set_raw(moved);
            }
            CropDrag::Handle(_) | CropDrag::Overlay { .. } => {
                state.resize_move(point, event.modifiers.alt, event.modifiers.shift, snap);
            }
        }
        cx.notify();
    }

    pub(crate) fn crop_dialog_mouse_up(&mut self, cx: &mut Context<Self>) {
        let Some(dialog) = self.crop.as_mut() else {
            return;
        };
        let state = &mut dialog.state;
        let Some(drag) = state.drag.take() else {
            return;
        };
        // A draw that never grew past 5px is a stray click; the previous
        // region comes back (`Cropper.tsx:934-941`).
        if let CropDrag::Overlay { restore, .. } = drag
            && (state.raw.width < 5. || state.raw.height < 5.)
        {
            state.set_raw(restore);
        }
        cx.notify();
    }

    // -- The options menu -----------------------------------------------------

    /// The ratio button (anchored under itself) and the right-click (anchored
    /// at the cursor) open the same menu (`showCropOptionsMenu`,
    /// `Editor.tsx:296-317`).
    fn open_crop_dialog_menu(
        &mut self,
        origin: Point<Pixels>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let focus = self.focus.clone();
        window.focus(&focus, cx);
        let Some(dialog) = self.crop.as_mut() else {
            return;
        };
        let items = engine::crop_menu_items(dialog.state.aspect, dialog.snap_to_ratio);
        dialog.state.menu = Some(ui::MenuState::new(origin, &items));
        cx.notify();
    }

    fn choose_crop_dialog_menu(
        &mut self,
        index: usize,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(choice) = engine::crop_menu_choice(index) else {
            return;
        };
        match choice {
            CropMenuChoice::Aspect(aspect) => {
                if let Some(dialog) = self.crop.as_mut() {
                    dialog.state.menu = None;
                    dialog.state.set_aspect(aspect);
                }
                self.start_crop_dialog_ticker(window, cx);
            }
            CropMenuChoice::ToggleSnap => {
                if let Some(dialog) = self.crop.as_mut() {
                    dialog.snap_to_ratio = !dialog.snap_to_ratio;
                    dialog.state.menu = None;
                    let snap = dialog.snap_to_ratio;
                    cx.background_executor()
                        .spawn(async move {
                            crate::store::update(|state| {
                                state.screenshot_crop_snap_to_ratio = Some(snap)
                            });
                        })
                        .detach();
                }
            }
        }
        cx.notify();
    }

    fn crop_dialog_menu_key(
        &mut self,
        key: &str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> bool {
        let Some(dialog) = self.crop.as_mut() else {
            return false;
        };
        let Some(menu) = dialog.state.menu.as_mut() else {
            return false;
        };
        match menu.on_key(key) {
            ui::MenuKey::Moved => {
                cx.notify();
                true
            }
            ui::MenuKey::Commit(index) => {
                self.choose_crop_dialog_menu(index, window, cx);
                true
            }
            ui::MenuKey::Dismiss => {
                dialog.state.menu = None;
                cx.notify();
                true
            }
            ui::MenuKey::Ignored => false,
        }
    }

    // -- Keyboard -------------------------------------------------------------

    /// Returns whether the key was consumed. The window's `on_key` calls this
    /// first while the dialog is up; the modal owns the keyboard, so the
    /// caller drops everything else on the floor either way.
    pub(crate) fn crop_dialog_key_down(
        &mut self,
        event: &gpui::KeyDownEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> bool {
        if self.crop.is_none() {
            return false;
        }
        let key = event.keystroke.key.as_str();
        if self.crop_dialog_menu_key(key, window, cx) {
            return true;
        }
        if key == "escape" {
            self.cancel_crop_dialog("escape", cx);
            return true;
        }
        let Some(nudge) = engine::is_nudge_key(key) else {
            return false;
        };
        let modifiers = event.keystroke.modifiers;
        let Some(dialog) = self.crop.as_mut() else {
            return false;
        };
        // A live pointer drag suppresses the keyboard entirely
        // (`Cropper.tsx:1007`).
        if dialog.state.drag.is_some() {
            return true;
        }
        dialog.state.keys.keys.insert(nudge);
        dialog.state.keys.shift = modifiers.shift;
        dialog.state.keys.alt = modifiers.alt;
        dialog.state.keys.meta = modifiers.platform || modifiers.control;
        dialog.state.stop_animation();
        self.crop_dialog_nudge_step(cx);
        self.start_crop_dialog_ticker(window, cx);
        true
    }

    pub(crate) fn crop_dialog_key_up(&mut self, event: &gpui::KeyUpEvent, cx: &mut Context<Self>) {
        let Some(dialog) = self.crop.as_mut() else {
            return;
        };
        let key = event.keystroke.key.as_str();
        let modifiers = event.keystroke.modifiers;
        if let Some(nudge) = engine::is_nudge_key(key) {
            dialog.state.keys.keys.remove(nudge);
        } else if !matches!(
            key,
            "shift" | "alt" | "cmd" | "ctrl" | "control" | "platform"
        ) {
            return;
        }
        dialog.state.keys.shift = modifiers.shift;
        dialog.state.keys.alt = modifiers.alt;
        dialog.state.keys.meta = modifiers.platform || modifiers.control;
        cx.notify();
    }

    fn crop_dialog_nudge_step(&mut self, cx: &mut Context<Self>) {
        let Some(dialog) = self.crop.as_mut() else {
            return;
        };
        if dialog.state.keys.keys.is_empty() {
            return;
        }
        let (bounds, origin) = dialog.state.keys.step(dialog.state.raw);
        dialog.state.set_raw_constraining(bounds, origin);
        cx.notify();
    }

    /// The rAF loop driving the 240ms animation and the held-arrow nudge --
    /// `editor_crop::start_crop_ticker` against this window's dialog.
    fn start_crop_dialog_ticker(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let wanted = self.crop.as_ref().is_some_and(|dialog| {
            dialog.state.anim.is_some() || !dialog.state.keys.keys.is_empty()
        });
        if !wanted {
            if let Some(dialog) = self.crop.as_mut() {
                dialog.state.ticker = None;
            }
            return;
        }
        if self
            .crop
            .as_ref()
            .is_some_and(|dialog| dialog.state.ticker.is_some())
        {
            return;
        }
        let task = cx.spawn_in(window, async move |this, cx| {
            loop {
                cx.background_executor()
                    .timer(Duration::from_millis(1000 / 60))
                    .await;
                let keep = this
                    .update(cx, |this: &mut Self, cx| {
                        let Some(dialog) = this.crop.as_mut() else {
                            return false;
                        };
                        let animating = dialog.state.tick_anim(Instant::now());
                        let nudging = !dialog.state.keys.keys.is_empty();
                        if nudging {
                            this.crop_dialog_nudge_step(cx);
                        } else {
                            cx.notify();
                        }
                        animating || nudging
                    })
                    .unwrap_or(false);
                if !keep {
                    break;
                }
            }
            this.update(cx, |this: &mut Self, _| {
                if let Some(dialog) = this.crop.as_mut() {
                    dialog.state.ticker = None;
                }
            })
            .ok();
        });
        if let Some(dialog) = self.crop.as_mut() {
            dialog.state.ticker = Some(task);
        }
    }

    // -- The header's number boxes --------------------------------------------

    /// `NumberField`'s commit: Enter and blur push the typed value through
    /// `setCropProperty`; anything unparseable snaps back.
    fn on_crop_field_event(
        &mut self,
        field: CropField,
        event: &ui::TextInputEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        match event {
            ui::TextInputEvent::Changed => {}
            ui::TextInputEvent::Confirmed | ui::TextInputEvent::Cancelled => {
                self.commit_crop_field(field, cx);
                let focus = self.focus.clone();
                window.focus(&focus, cx);
            }
            ui::TextInputEvent::Blurred => self.commit_crop_field(field, cx),
        }
    }

    fn commit_crop_field(&mut self, field: CropField, cx: &mut Context<Self>) {
        let Some(dialog) = self.crop.as_mut() else {
            return;
        };
        let Some(input) = dialog.fields.get(&field).cloned() else {
            return;
        };
        let text = input.read(cx).text().trim().to_string();
        if let Ok(value) = text.parse::<f64>()
            && value.is_finite()
            && field.read(dialog.state.real()) != value
        {
            dialog.state.set_property(field, value);
        }
        let resolved = field.read(dialog.state.real());
        input.update(cx, |input, cx| {
            input.set_text(format!("{}", resolved.round() as i64), cx)
        });
        cx.notify();
    }

    /// Re-derive every unfocused box from the crop rect -- the same
    /// no-fighting-the-keyboard rule the hex fields follow. Runs from `render`.
    pub(crate) fn sync_crop_field_inputs(&mut self, window: &Window, cx: &mut Context<Self>) {
        let Some(dialog) = self.crop.as_ref() else {
            return;
        };
        let real = dialog.state.real();
        for field in CROP_FIELDS {
            let Some(input) = dialog.fields.get(&field).cloned() else {
                continue;
            };
            if input.read(cx).focus_handle().is_focused(window) {
                continue;
            }
            let expected = format!("{}", field.read(real).round() as i64);
            if input.read(cx).text() != expected {
                input.update(cx, |input, cx| input.set_text(expected, cx));
            }
        }
    }

    // -- Rendering ------------------------------------------------------------

    /// The whole modal, painted over everything in the window root.
    pub(crate) fn render_crop_dialog_overlay(&self, cx: &mut Context<Self>) -> Option<AnyElement> {
        let dialog = self.crop.as_ref()?;
        let theme = self.theme;

        Some(
            div()
                .absolute()
                .inset_0()
                .flex()
                .items_center()
                .justify_center()
                // `KDialog.Overlay class="fixed inset-0 z-50 bg-black/80"`.
                .child(
                    div()
                        .id("screenshot-crop-backdrop")
                        .occlude()
                        .absolute()
                        .inset_0()
                        .bg(gpui::hsla(0., 0., 0., 0.8))
                        .on_click(cx.listener(|this, _, _window, cx| {
                            this.cancel_crop_dialog("backdrop", cx)
                        })),
                )
                .child(
                    // `rounded-[1.25rem] overflow-hidden border border-gray-3
                    // bg-gray-1` (`ui.tsx:179`), with the same `occlude()` hit
                    // shield the video dialog's card needs.
                    div()
                        .occlude()
                        .relative()
                        .flex()
                        .flex_col()
                        .rounded(px(20.))
                        .border_1()
                        .border_color(Hsla::from(theme.gray_3))
                        .bg(Hsla::from(theme.gray_1))
                        .overflow_hidden()
                        .child(self.render_crop_dialog_header(dialog, cx))
                        .child(self.render_crop_dialog_body(dialog, cx))
                        .child(self.render_crop_dialog_footer(cx)),
                )
                .children(self.render_crop_dialog_menu(cx))
                .into_any_element(),
        )
    }

    fn render_crop_dialog_header(
        &self,
        dialog: &ScreenshotCropDialog,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let theme = self.theme;
        let state = &dialog.state;
        let real = state.real();
        // `disabled={crop().width === originalSize.x && crop().height ===
        // originalSize.y}` (`Editor.tsx:405-408`).
        let full =
            real.width == f64::from(state.target.0) && real.height == f64::from(state.target.1);
        let untouched = real == state.initial;

        let group = |label: &'static str, a: CropField, b: CropField, this: &Self| {
            div()
                .flex()
                .flex_row()
                .items_center()
                .gap(px(12.))
                .text_color(Hsla::from(theme.gray_11))
                .child(label)
                .child(this.render_crop_dialog_field(dialog, a))
                .child("×")
                .child(this.render_crop_dialog_field(dialog, b))
        };

        div()
            .flex()
            .flex_row()
            .items_center()
            .gap(px(12.))
            .h(px(DIALOG_HEADER_HEIGHT))
            .px(px(16.))
            .flex_none()
            .text_size(px(14.))
            .child(
                // `flex flex-row space-x-8` (`Editor.tsx:348`).
                div()
                    .flex()
                    .flex_row()
                    .gap(px(32.))
                    .flex_none()
                    .child(group("Size", CropField::Width, CropField::Height, self))
                    .child(group("Position", CropField::X, CropField::Y, self)),
            )
            .child(
                div()
                    .flex()
                    .flex_row()
                    .flex_1()
                    .items_center()
                    .justify_end()
                    .gap(px(12.))
                    // The ratio button (`Editor.tsx:373-400`): a 32px circle
                    // showing the ratio glyph when free and `N:M` in blue-10
                    // when locked.
                    .child(
                        div()
                            .id("screenshot-crop-ratio")
                            .flex()
                            .items_center()
                            .justify_center()
                            .size(px(32.))
                            .rounded_full()
                            .border_1()
                            .border_color(Hsla::from(theme.gray_4))
                            .bg(Hsla::from(theme.gray_1))
                            .cursor_pointer()
                            .child(match state.aspect {
                                Some(ratio) => div()
                                    .text_size(px(12.))
                                    .font_weight(FontWeight::MEDIUM)
                                    .text_color(Hsla::from(theme.blue_10))
                                    .child(SharedString::from(format!("{}:{}", ratio.0, ratio.1)))
                                    .into_any_element(),
                                None => svg()
                                    .path("icons/ratio.svg")
                                    .size(px(16.))
                                    .text_color(Hsla::from(theme.gray_12))
                                    .into_any_element(),
                            })
                            .on_click(cx.listener(|this, event: &gpui::ClickEvent, window, cx| {
                                // `pos = new LogicalPosition(rect.x, rect.y + 40)`.
                                let position = event.position();
                                let origin =
                                    gpui::point(position.x - px(16.), position.y + px(24.));
                                this.open_crop_dialog_menu(origin, window, cx);
                            })),
                    )
                    .child(
                        ui::EditorButton::plain(&theme, "screenshot-crop-full")
                            .left_icon("icons/maximize.svg")
                            .label("Full")
                            .disabled(full)
                            .on_click(cx.listener(|this, _, window, cx| {
                                if let Some(dialog) = this.crop.as_mut() {
                                    dialog.state.fill();
                                }
                                this.start_crop_dialog_ticker(window, cx);
                                cx.notify();
                            })),
                    )
                    .child(
                        ui::EditorButton::plain(&theme, "screenshot-crop-reset")
                            .left_icon("icons/circle-x.svg")
                            .label("Reset")
                            .disabled(untouched)
                            .on_click(cx.listener(|this, _, window, cx| {
                                if let Some(dialog) = this.crop.as_mut() {
                                    // `cropperRef?.reset(); setAspect(null)` --
                                    // `reset` drops the aspect itself.
                                    dialog.state.reset();
                                }
                                this.start_crop_dialog_ticker(window, cx);
                                cx.notify();
                            })),
                    ),
            )
            .into_any_element()
    }

    /// One `NumberField.Input`: `w-13 h-8 rounded-lg bg-gray-2`
    /// (`Editor.tsx:336`).
    fn render_crop_dialog_field(
        &self,
        dialog: &ScreenshotCropDialog,
        field: CropField,
    ) -> AnyElement {
        let theme = self.theme;
        let Some(input) = dialog.fields.get(&field) else {
            return div().w(px(BOUND_INPUT_WIDTH)).into_any_element();
        };
        ui::TextInput::plain(
            &theme,
            SharedString::from(format!("screenshot-crop-{field:?}")),
            input,
        )
        .width(px(BOUND_INPUT_WIDTH))
        .padding_x(px(8.))
        .height(px(32.))
        .radius(px(8.))
        .text_size(px(14.))
        .bg(Hsla::from(theme.gray_2))
        .border(Hsla::from(theme.gray_2))
        .into_any_element()
    }

    /// `Dialog.Content` (`p-4 border-y border-gray-3`) holding the
    /// `rounded-[1.25rem] bg-gray-2/80 p-3` card the cropper sits in
    /// (`Editor.tsx:429-461`).
    fn render_crop_dialog_body(
        &self,
        dialog: &ScreenshotCropDialog,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let theme = self.theme;
        let mut card_bg = Hsla::from(theme.gray_2);
        card_bg.a = 0.8;

        div()
            .flex()
            .flex_col()
            .p(px(16.))
            .border_t_1()
            .border_b_1()
            .border_color(Hsla::from(theme.gray_3))
            .child(
                div()
                    .flex()
                    .flex_row()
                    .justify_center()
                    .items_center()
                    .child(
                        div()
                            .rounded(px(20.))
                            .p(px(12.))
                            .bg(card_bg)
                            // `ring-1 ring-black/5 shadow-xs`.
                            .border_1()
                            .border_color(gpui::hsla(0., 0., 0., 0.05))
                            .shadow(vec![gpui::BoxShadow {
                                color: Theme::with_alpha(gpui::rgb(0x000000), 0.05),
                                offset: gpui::point(px(0.), px(1.)),
                                blur_radius: px(2.),
                                spread_radius: px(0.),
                                inset: false,
                            }])
                            .child(self.render_crop_dialog_area(dialog, cx)),
                    ),
            )
            .into_any_element()
    }

    /// The cropper itself -- `editor_crop::render_crop_area`'s shape over the
    /// original PNG: the frame, the occluders, the region with its thirds
    /// grid, badge and corner glyphs, and the handle hit zones.
    fn render_crop_dialog_area(
        &self,
        dialog: &ScreenshotCropDialog,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let theme = self.theme;
        let state = &dialog.state;
        let (w, h) = state.container;
        let (box_w, box_h) = state.box_size;
        let bounds = state.display_raw;
        let too_small = state.bounds_too_small();
        let dragging = state.drag.is_some();
        let drag_cursor = state.drag.map(|drag| drag.cursor());
        let base_cursor = drag_cursor.unwrap_or(if state.aspect.is_some() {
            CursorStyle::Arrow
        } else {
            CursorStyle::Crosshair
        });

        let region = div()
            .absolute()
            .left(px(bounds.x as f32))
            .top(px(bounds.y as f32))
            .w(px(bounds.width as f32))
            .h(px(bounds.height as f32))
            .border_1()
            .border_color(gpui::hsla(0., 0., 1., 0.5))
            .cursor(drag_cursor.unwrap_or(CursorStyle::OpenHand))
            .children(dragging.then(|| engine::thirds_grid(bounds)))
            // The snapped-ratio badge, free mode only.
            .children(
                (state.aspect.is_none() && !too_small)
                    .then_some(state.snapped)
                    .flatten()
                    .map(|ratio| {
                        div()
                            .absolute()
                            .top_0()
                            .w(px(bounds.width as f32))
                            .h(px(32.))
                            .flex()
                            .items_center()
                            .justify_center()
                            .child(
                                div()
                                    .h(px(18.))
                                    .w(px(44.))
                                    .rounded_full()
                                    .flex()
                                    .items_center()
                                    .justify_center()
                                    .border_1()
                                    .border_color(gpui::hsla(0., 0., 1., 0.7))
                                    .bg(if theme.is_dark() {
                                        gpui::hsla(0., 0., 0., 0.5)
                                    } else {
                                        gpui::hsla(0., 0., 1., 0.5)
                                    })
                                    .text_size(px(12.))
                                    .text_color(Hsla::from(theme.gray_12))
                                    .child(SharedString::from(format!("{}:{}", ratio.0, ratio.1))),
                            )
                    }),
            )
            .children(
                HANDLES
                    .iter()
                    .filter(|handle| handle.is_corner)
                    .flat_map(|handle| engine::corner_glyph(*handle, bounds, too_small)),
            );

        // The hit zones, in paint order: edges, the move layer, the corners.
        let mut layers = div().absolute().inset_0();
        for handle in HANDLES.iter().filter(|handle| !handle.is_corner) {
            layers = layers.child(engine::handle_zone(*handle, bounds, drag_cursor));
        }
        layers = layers.child(
            div()
                .absolute()
                .left(px(bounds.x as f32))
                .top(px(bounds.y as f32))
                .w(px(bounds.width as f32))
                .h(px(bounds.height as f32))
                .cursor(drag_cursor.unwrap_or(CursorStyle::OpenHand)),
        );
        for handle in HANDLES.iter().filter(|handle| handle.is_corner) {
            let cursor = match (drag_cursor, state.hovering) {
                (Some(_), Some(hovering)) if hovering.is_corner => hovering.direction.cursor(),
                (Some(cursor), _) => cursor,
                (None, _) => handle.direction.cursor(),
            };
            layers = layers.child(engine::handle_zone_with_cursor(*handle, bounds, cursor));
        }

        div()
            .id("screenshot-crop-area")
            .relative()
            .w(px(box_w))
            .h(px(box_h))
            // `rounded-sm overflow-visible` -- unlike the video dialog's box
            // there is no hairline border and nothing clips the corner glyphs.
            .rounded(px(2.))
            .cursor(base_cursor)
            .child(
                gpui::canvas(
                    {
                        let cell = dialog.area.clone();
                        move |bounds, _window, _cx| {
                            cell.set(Some(bounds));
                        }
                    },
                    |_, _, _, _| {},
                )
                .absolute()
                .size_full(),
            )
            .children(match &dialog.image {
                Some(image) => Some(
                    img(image.clone())
                        .absolute()
                        .inset_0()
                        .size_full()
                        .into_any_element(),
                ),
                None => Some(
                    div()
                        .absolute()
                        .inset_0()
                        .flex()
                        .items_center()
                        .justify_center()
                        .bg(Hsla::from(theme.gray_3))
                        .text_size(px(12.))
                        .font_weight(FontWeight::MEDIUM)
                        .text_color(Hsla::from(theme.gray_10))
                        .child("Loading frame…")
                        .into_any_element(),
                ),
            })
            .children(engine::occluders(bounds, w, h))
            .child(region)
            .child(layers)
            .on_mouse_down(
                MouseButton::Left,
                cx.listener(|this, event: &MouseDownEvent, window, cx| {
                    this.crop_dialog_mouse_down(event, window, cx);
                }),
            )
            // `onContextMenu={(e) => showCropOptionsMenu(e, true)}` -- at the
            // cursor.
            .on_mouse_down(
                MouseButton::Right,
                cx.listener(|this, event: &MouseDownEvent, window, cx| {
                    this.open_crop_dialog_menu(event.position, window, cx);
                }),
            )
            .into_any_element()
    }

    /// `Dialog.Footer` with the single Save (`Editor.tsx:463-482`).
    fn render_crop_dialog_footer(&self, cx: &mut Context<Self>) -> AnyElement {
        let theme = self.theme;
        div()
            .flex()
            .flex_row()
            .items_center()
            .justify_center()
            .gap(px(12.))
            .h(px(DIALOG_FOOTER_HEIGHT))
            .px(px(16.))
            .flex_none()
            .child(
                ui::Button::plain(
                    &theme,
                    "screenshot-crop-save",
                    ui::ButtonVariant::Primary,
                    ui::ButtonSize::Md,
                )
                .label("Save")
                .on_click(cx.listener(|this, _, window, cx| this.save_crop_dialog(window, cx))),
            )
            .into_any_element()
    }

    fn render_crop_dialog_menu(&self, cx: &mut Context<Self>) -> Option<AnyElement> {
        let dialog = self.crop.as_ref()?;
        let menu = dialog.state.menu.as_ref()?;
        let items = engine::crop_menu_items(dialog.state.aspect, dialog.snap_to_ratio);
        Some(
            ui::Menu::plain(&self.theme, "screenshot-crop-menu", items, menu)
                .on_select(cx.listener(|this, index: &usize, window, cx| {
                    this.choose_crop_dialog_menu(*index, window, cx);
                }))
                .on_dismiss(cx.listener(|this, _, _window, cx| {
                    if let Some(dialog) = this.crop.as_mut() {
                        dialog.state.menu = None;
                    }
                    cx.notify();
                }))
                .into_any_element(),
        )
    }

    /// The window-wide pointer-capture layer while a crop drag is live.
    pub(crate) fn render_crop_dialog_drag_layer(
        &self,
        cx: &mut Context<Self>,
    ) -> Option<AnyElement> {
        self.crop
            .as_ref()
            .is_some_and(|dialog| dialog.state.drag.is_some())
            .then(|| {
                ui::Slider::drag_layer(
                    "screenshot-crop-drag",
                    cx.listener(|this, event: &MouseMoveEvent, window, cx| {
                        this.crop_dialog_mouse_move(event, window, cx);
                    }),
                    cx.listener(|this, _: &gpui::MouseUpEvent, _window, cx| {
                        this.crop_dialog_mouse_up(cx);
                    }),
                )
                .into_any_element()
            })
    }
}

/// Decode the original PNG for the cropper -- full resolution, since the box
/// can be up to 768 logical (1536 physical) pixels wide and the load path
/// already refused anything past `MAX_DIMENSION`.
fn decode_crop_image(path: Option<&Path>) -> Option<Arc<RenderImage>> {
    let decoded = image::open(path?).ok()?;
    Some(crate::library::rgba_to_render_image(decoded.into_rgba8()))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `previewSize()` at the editor's default 1240x800: a 3024x1964 original
    /// hits the 768 width cap, so the box is 768 wide at the image's aspect.
    #[test]
    fn the_box_fits_the_image_into_the_width_and_height_caps() {
        let (w, h) = crop_box_size((1240., 800.), (3024, 1964));
        assert!((w - 768.).abs() < 0.001, "{w}");
        let expected_height = 768. / (3024. / 1964.);
        assert!((h - expected_height).abs() < 0.01, "{h}");

        // A tall image is height-capped at vh * 0.65 instead.
        let (w, h) = crop_box_size((1240., 800.), (1000, 2000));
        assert!((h - 520.).abs() < 0.001, "{h}");
        assert!((w - 260.).abs() < 0.001, "{w}");
    }

    /// The source does not clamp the ratio at 1 -- a small screenshot scales
    /// up to fill the box.
    #[test]
    fn a_small_image_upscales_like_the_source() {
        let (w, h) = crop_box_size((1240., 800.), (100, 50));
        assert!(w > 100.);
        assert_eq!(w / h, 2.);
    }
}
