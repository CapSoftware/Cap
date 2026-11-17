//! The mode picker row: the current mode's heading on the left, a capsule of pills on the right.
//!
//! Layers (`CALayer`) draw the capsule and pills because only they have continuous
//! corners; icons are image views above them, and `drawRect:` draws just the text.
//! Nothing in here touches gpui: a pick only posts a tag through [`post`], the same
//! seam every other tray action uses.

use std::cell::{Cell, RefCell};
use std::ptr::NonNull;

use block2::RcBlock;
use objc2::rc::Retained;
use objc2::runtime::{AnyClass, AnyObject, Bool, Sel};
use objc2::{AnyThread, DefinedClass, MainThreadOnly, define_class, msg_send, sel};
use objc2_app_kit::{
    NSAccessibility, NSAccessibilityElement, NSAccessibilityRadioButtonRole,
    NSAccessibilityRadioGroupRole, NSAppearanceCustomization, NSAutoresizingMaskOptions,
    NSBitmapImageRep, NSColor, NSEvent, NSEventTrackingRunLoopMode, NSEventType, NSFont,
    NSFontAttributeName, NSFontManager, NSFontTraitMask, NSFontWeightMedium,
    NSForegroundColorAttributeName, NSImage, NSImageScaling, NSImageView, NSMenu, NSMenuItem,
    NSStringDrawing, NSTrackingArea, NSTrackingAreaOptions, NSView, NSWindow,
};
use objc2_foundation::{
    MainThreadMarker, NSArray, NSData, NSDictionary, NSPoint, NSRect, NSRunLoop, NSSize, NSString,
    NSTimer,
};
use objc2_quartz_core::{CALayer, CATransaction, kCACornerCurveContinuous};

use super::mac::{post, set_status_mode};
use super::{TrayItem, mode_heading, mode_name, mode_picker_icon};
use crate::i18n::tr;
use crate::main_window::Mode;

const PICKER_MODES: [(Mode, TrayItem); 3] = [
    (Mode::Instant, TrayItem::ModeInstant),
    (Mode::Studio, TrayItem::ModeStudio),
    (Mode::Screenshot, TrayItem::ModeScreenshot),
];

const FLASH_INTERVAL: f64 = 0.08;
const FLASH_ON_PICK: bool = true;

const PICKER_MIN_W: f64 = 300.0;
/// Clear space between the widest heading and the capsule.
const HEADING_GAP: f64 = 12.0;
const PICKER_H: f64 = 41.0;
const PILL_W: f64 = 42.0;
const PILL_H: f64 = 29.0;
const PILL_GAP: f64 = 4.0;
const CAPSULE_PAD: f64 = 3.0;
const RIGHT_INSET: f64 = 12.0;
const TITLE_INSET: f64 = 18.0;
const SYMBOL_SIZE: f64 = 17.0;
const PILL_RADIUS: f64 = 14.0;
const CAPSULE_RADIUS: f64 = 17.0;
/// Optical nudge for a pill's glyph, left of its centred position.
const STUDIO_ICON_NUDGE: f64 = -1.0;

thread_local! {
    /// The live picker and its menu item, read by the key hook. Set on every rebuild.
    static PICKER: RefCell<Option<(Retained<NSMenuItem>, Retained<ModePickerView>)>> =
        const { RefCell::new(None) };
    static FLASH_TIMER: RefCell<Option<Retained<NSTimer>>> = const { RefCell::new(None) };
}

struct PillA11yIvars {
    index: usize,
}

define_class!(
    // SAFETY: NSAccessibilityElement has no subclassing requirements; ivars hold a plain index.
    #[unsafe(super(NSAccessibilityElement))]
    #[name = "CapModePillAccessibilityElement"]
    #[ivars = PillA11yIvars]
    struct PillAccessibilityElement;

    impl PillAccessibilityElement {
        #[unsafe(method(accessibilityPerformPress))]
        fn accessibility_perform_press(&self) -> bool {
            let index = self.ivars().index;
            PICKER.with(|p| {
                if let Some((_, view)) = p.borrow().as_ref() {
                    view.choose(index);
                }
            });
            true
        }
    }
);

impl PillAccessibilityElement {
    fn new(index: usize, label: &str) -> Retained<Self> {
        let this = <Self as objc2::AnyThread>::alloc().set_ivars(PillA11yIvars { index });
        let this: Retained<Self> = unsafe { msg_send![super(this), init] };
        this.setAccessibilityRole(Some(unsafe { NSAccessibilityRadioButtonRole }));
        this.setAccessibilityLabel(Some(&NSString::from_str(label)));
        this.setAccessibilityEnabled(true);
        this
    }
}

struct PickerIvars {
    selected: Cell<usize>,
    focused: Cell<Option<usize>>,
    flash: Cell<bool>,
    pressed: Cell<bool>,
    /// `actions` index of the first pill; pill `i` posts `tag_base + i`.
    tag_base: isize,
    capsule: RefCell<Option<Retained<CALayer>>>,
    pills: RefCell<Vec<Retained<CALayer>>>,
    icons: RefCell<Vec<Retained<NSImageView>>>,
    tracking: RefCell<Option<Retained<NSTrackingArea>>>,
    accessibility_children: RefCell<Vec<Retained<PillAccessibilityElement>>>,
}

define_class!(
    // SAFETY: NSView has no extra subclassing requirements; the ivars only log on drop.
    #[unsafe(super(NSView))]
    #[name = "CapModePickerView"]
    #[thread_kind = MainThreadOnly]
    #[ivars = PickerIvars]
    struct ModePickerView;

    impl ModePickerView {
        #[unsafe(method(acceptsFirstMouse:))]
        fn accepts_first_mouse(&self, _event: Option<&NSEvent>) -> bool {
            true
        }

        #[unsafe(method(viewWillMoveToWindow:))]
        fn view_will_move_to_window(&self, new_window: Option<&NSWindow>) {
            unsafe {
                let _: () = msg_send![super(self), viewWillMoveToWindow: new_window];
            }
            if new_window.is_none()
                && let Some(area) = self.ivars().tracking.borrow_mut().take()
            {
                self.removeTrackingArea(&area);
            }
        }

        #[unsafe(method(viewDidMoveToWindow))]
        fn view_did_move_to_window(&self) {
            unsafe {
                let _: () = msg_send![super(self), viewDidMoveToWindow];
            }
            if let Some(window) = self.window() {
                window.setAcceptsMouseMovedEvents(true);
                self.install_tracking_area();
            }
            self.sync();
            self.hover_from_pointer();
        }

        #[unsafe(method(updateTrackingAreas))]
        fn update_tracking_areas(&self) {
            unsafe {
                let _: () = msg_send![super(self), updateTrackingAreas];
            }
            if let Some(area) = self.ivars().tracking.borrow_mut().take() {
                self.removeTrackingArea(&area);
            }
            self.install_tracking_area();
        }

        #[unsafe(method(viewDidChangeEffectiveAppearance))]
        fn view_did_change_effective_appearance(&self) {
            unsafe {
                let _: () = msg_send![super(self), viewDidChangeEffectiveAppearance];
            }
            self.sync();
        }

        #[unsafe(method(mouseMoved:))]
        fn mouse_moved(&self, event: &NSEvent) {
            self.update_focus(self.pill_at(event));
        }

        #[unsafe(method(mouseExited:))]
        fn mouse_exited(&self, _event: &NSEvent) {
            if self.ivars().pressed.get() {
                return;
            }
            self.ivars().focused.set(None);
            self.refresh();
        }

        #[unsafe(method(mouseDown:))]
        fn mouse_down(&self, event: &NSEvent) {
            self.ivars().pressed.set(true);
            self.update_focus(self.pill_at(event));
        }

        #[unsafe(method(mouseDragged:))]
        fn mouse_dragged(&self, event: &NSEvent) {
            self.update_focus(self.pill_at(event));
        }

        #[unsafe(method(mouseUp:))]
        fn mouse_up(&self, event: &NSEvent) {
            self.ivars().pressed.set(false);
            // The release point chooses the pill; a release outside the menu
            // changes nothing, so the shown and applied modes stay in sync.
            match self.pill_at(event) {
                Some(i) => self.choose(i),
                None => self.update_focus(None),
            }
        }

        #[unsafe(method(drawRect:))]
        fn draw_rect(&self, _dirty: NSRect) {
            self.draw_text();
        }
    }
);

impl ModePickerView {
    fn new(mtm: MainThreadMarker, selected: usize, tag_base: isize) -> Retained<Self> {
        let this = mtm.alloc::<Self>().set_ivars(PickerIvars {
            selected: Cell::new(selected),
            focused: Cell::new(None),
            flash: Cell::new(false),
            pressed: Cell::new(false),
            tag_base,
            capsule: RefCell::new(None),
            pills: RefCell::new(Vec::new()),
            icons: RefCell::new(Vec::new()),
            tracking: RefCell::new(None),
            accessibility_children: RefCell::new(Vec::new()),
        });
        let frame = NSRect::new(
            NSPoint::new(0.0, 0.0),
            NSSize::new(picker_width(), PICKER_H),
        );
        // Initialise first; everything below touches the live view.
        let this: Retained<Self> = unsafe { msg_send![super(this), initWithFrame: frame] };

        this.setAutoresizingMask(NSAutoresizingMaskOptions::ViewWidthSizable);
        this.setWantsLayer(true);
        let root = this.layer().expect("layer-backed view");
        let make_layer = |radius: f64| -> Retained<CALayer> {
            let layer = CALayer::layer();
            layer.setCornerCurve(unsafe { kCACornerCurveContinuous });
            layer.setCornerRadius(radius);
            root.addSublayer(&layer);
            layer
        };
        *this.ivars().capsule.borrow_mut() = Some(make_layer(CAPSULE_RADIUS));
        for _ in PICKER_MODES.iter() {
            this.ivars()
                .pills
                .borrow_mut()
                .push(make_layer(PILL_RADIUS));
        }

        for (mode, _) in PICKER_MODES.iter() {
            let view = NSImageView::new(mtm);
            if let Some(bytes) = mode_picker_icon(*mode)
                && let Some(rep) = NSBitmapImageRep::initWithData(
                    NSBitmapImageRep::alloc(),
                    &NSData::with_bytes(&bytes),
                )
            {
                let size = NSSize::new(SYMBOL_SIZE, SYMBOL_SIZE);
                rep.setSize(size);
                let image = NSImage::initWithSize(NSImage::alloc(), size);
                image.addRepresentation(&rep);
                image.setTemplate(true);
                view.setImage(Some(&image));
            }
            view.setImageScaling(NSImageScaling::ScaleNone);
            this.addSubview(&view);
            this.ivars().icons.borrow_mut().push(view);
        }

        this.setAccessibilityRole(Some(unsafe { NSAccessibilityRadioGroupRole }));
        this.setAccessibilityLabel(Some(&NSString::from_str(tr::tray::recording_mode())));
        let children: Vec<Retained<AnyObject>> = PICKER_MODES
            .iter()
            .enumerate()
            .map(|(index, (mode, _))| {
                let child = PillAccessibilityElement::new(index, mode_name(*mode));
                unsafe { Retained::cast_unchecked::<AnyObject>(child) }
            })
            .collect();
        let children_array = NSArray::from_retained_slice(&children);
        unsafe { this.setAccessibilityChildren(Some(&children_array)) };
        *this.ivars().accessibility_children.borrow_mut() = children
            .into_iter()
            .map(|child| unsafe { Retained::cast_unchecked::<PillAccessibilityElement>(child) })
            .collect();

        this.sync();
        this
    }

    fn install_tracking_area(&self) {
        let options = NSTrackingAreaOptions::MouseMoved
            | NSTrackingAreaOptions::MouseEnteredAndExited
            | NSTrackingAreaOptions::ActiveAlways
            | NSTrackingAreaOptions::InVisibleRect;
        let area = unsafe {
            NSTrackingArea::initWithRect_options_owner_userInfo(
                NSTrackingArea::alloc(),
                NSRect::ZERO,
                options,
                Some(self),
                None,
            )
        };
        self.addTrackingArea(&area);
        *self.ivars().tracking.borrow_mut() = Some(area);
    }

    fn update_focus(&self, hit: Option<usize>) {
        if self.ivars().focused.get() != hit {
            self.ivars().focused.set(hit);
            self.refresh();
        }
    }

    fn clear_focus(&self) {
        if self.ivars().pressed.get() {
            return;
        }
        self.update_focus(None);
    }

    // -- geometry ----------------------------------------------------------

    fn capsule_rect(&self) -> NSRect {
        let w = capsule_width();
        let h = PILL_H + 2.0 * CAPSULE_PAD;
        let bounds = self.bounds();
        NSRect::new(
            NSPoint::new(
                bounds.size.width - RIGHT_INSET - w,
                (bounds.size.height - h) / 2.0,
            ),
            NSSize::new(w, h),
        )
    }

    fn pill_rect(&self, i: usize) -> NSRect {
        let c = self.capsule_rect();
        NSRect::new(
            NSPoint::new(
                c.origin.x + CAPSULE_PAD + i as f64 * (PILL_W + PILL_GAP),
                c.origin.y + CAPSULE_PAD,
            ),
            NSSize::new(PILL_W, PILL_H),
        )
    }

    fn icon_rect(&self, i: usize) -> NSRect {
        let mut r = self.pill_rect(i);
        if PICKER_MODES[i].0 == Mode::Studio {
            r.origin.x += STUDIO_ICON_NUDGE;
        }
        r
    }

    fn pill_at(&self, event: &NSEvent) -> Option<usize> {
        self.pill_at_point(self.convertPoint_fromView(event.locationInWindow(), None))
    }

    fn pill_at_point(&self, p: NSPoint) -> Option<usize> {
        (0..PICKER_MODES.len()).find(|&i| {
            let r = self.pill_rect(i);
            p.x >= r.origin.x - PILL_GAP / 2.0
                && p.x <= r.origin.x + r.size.width + PILL_GAP / 2.0
                && p.y >= r.origin.y
                && p.y <= r.origin.y + r.size.height
        })
    }

    fn hover_from_pointer(&self) {
        let Some(window) = self.window() else {
            return;
        };
        let point = self.convertPoint_fromView(window.mouseLocationOutsideOfEventStream(), None);
        let hit = self.pill_at_point(point);
        if self.ivars().focused.get() != hit {
            self.ivars().focused.set(hit);
            self.refresh();
        }
    }

    // -- state -> visuals --------------------------------------------------

    /// Layers and icons for the current state, then the text.
    fn refresh(&self) {
        self.sync();
        self.setNeedsDisplay(true);
    }

    /// The only place state becomes layer properties.
    fn sync(&self) {
        let appearance = self.effectiveAppearance();
        let block = RcBlock::new(|| self.apply_visuals());
        appearance.performAsCurrentDrawingAppearance(&block);
    }

    fn apply_visuals(&self) {
        let selected = self.ivars().selected.get();
        let focused = self.ivars().focused.get();
        let label = NSColor::labelColor();
        CATransaction::begin();
        CATransaction::setDisableActions(true);

        if let Some(cap) = self.ivars().capsule.borrow().as_ref() {
            cap.setFrame(self.capsule_rect());
            let color = label.colorWithAlphaComponent(0.08).CGColor();
            cap.setBackgroundColor(Some(&color));
        }

        let accent = NSColor::controlAccentColor();
        let white = NSColor::whiteColor();
        let flash = self.ivars().flash.get();
        let icons = self.ivars().icons.borrow();
        for (i, child) in self
            .ivars()
            .accessibility_children
            .borrow()
            .iter()
            .enumerate()
        {
            child.setAccessibilitySelected(i == selected);
            if let Some(window) = self.window() {
                let rect = self.convertRect_toView(self.pill_rect(i), None);
                child.setAccessibilityFrame(window.convertRectToScreen(rect));
            }
        }
        for (i, pill) in self.ivars().pills.borrow().iter().enumerate() {
            let is_sel = i == selected;
            let is_hover = focused == Some(i) && !is_sel;
            let fill = if is_sel {
                if flash {
                    accent.clone()
                } else {
                    white.colorWithAlphaComponent(0.95)
                }
            } else if is_hover {
                label.colorWithAlphaComponent(0.14)
            } else {
                NSColor::clearColor()
            };
            let r = self.pill_rect(i);
            pill.setFrame(r);
            let color = fill.CGColor();
            pill.setBackgroundColor(Some(&color));

            if let Some(icon) = icons.get(i) {
                icon.setFrame(self.icon_rect(i));
                let tint = if is_sel {
                    if flash { white.clone() } else { accent.clone() }
                } else {
                    label.clone()
                };
                icon.setContentTintColor(Some(&tint));
            }
        }
        CATransaction::commit();
    }

    // -- drawing: text only ------------------------------------------------

    fn draw_text(&self) {
        let selected = self.ivars().selected.get();
        let focused = self.ivars().focused.get();
        let shown = focused.unwrap_or(selected);

        let mut font = heading_font();
        if shown != selected {
            font = italic(&font);
        }

        let secondary = NSColor::secondaryLabelColor();
        let subtitle = NSString::from_str(mode_heading(PICKER_MODES[shown].0));
        let attrs = NSDictionary::from_slices(
            &[unsafe { NSFontAttributeName }, unsafe {
                NSForegroundColorAttributeName
            }],
            &[&*font as &AnyObject, &*secondary as &AnyObject],
        );

        let size = unsafe { subtitle.sizeWithAttributes(Some(&attrs)) };
        let y = (self.bounds().size.height - size.height) / 2.0;
        unsafe {
            subtitle.drawAtPoint_withAttributes(NSPoint::new(TITLE_INSET, y), Some(&attrs));
        }
    }

    // -- actions -----------------------------------------------------------

    /// Selects pill `i`, gives it one AppKit-style highlight pulse, then closes
    /// the menu.
    fn choose(&self, i: usize) {
        if FLASH_TIMER.with(|timer| timer.borrow().is_some()) {
            return;
        }
        let mode = PICKER_MODES[i].0;
        self.ivars().selected.set(i);
        self.ivars().focused.set(Some(i));
        self.refresh();
        post(self.ivars().tag_base + i as isize);
        super::mac::apply(mode, super::mac::current_option());
        set_status_mode(mode);

        if !FLASH_ON_PICK {
            return;
        }
        self.ivars().flash.set(true);
        self.refresh();
        let block = RcBlock::new(|_timer: NonNull<NSTimer>| Self::finish_flash());
        let timer =
            unsafe { NSTimer::timerWithTimeInterval_repeats_block(FLASH_INTERVAL, false, &block) };
        unsafe { NSRunLoop::currentRunLoop().addTimer_forMode(&timer, NSEventTrackingRunLoopMode) };
        FLASH_TIMER.with(|slot| *slot.borrow_mut() = Some(timer));
    }

    fn finish_flash() {
        stop_flash();
        PICKER.with(|p| {
            if let Some((item, view)) = p.borrow().as_ref() {
                view.set_flash(false);
                if let Some(menu) = unsafe { item.menu() } {
                    menu.cancelTracking();
                }
            }
        });
    }

    fn set_flash(&self, flash: bool) {
        if self.ivars().flash.replace(flash) != flash {
            self.refresh();
        }
    }

    fn fit_to_width(&self, width: f64) {
        let frame = self.frame();
        let width = width.max(picker_width());
        if width > frame.size.width + 1.0 {
            self.setFrameSize(NSSize::new(width, frame.size.height));
            self.refresh();
        }
    }

    /// Moves keyboard focus one pill. Returns false at either end, so the key falls
    /// through to the menu and moves to the neighbouring tray menu.
    fn move_focus(&self, delta: isize) -> bool {
        let cur = self
            .ivars()
            .focused
            .get()
            .unwrap_or(self.ivars().selected.get()) as isize;
        let next = cur + delta;
        if next < 0 || next >= PICKER_MODES.len() as isize {
            return false;
        }
        self.ivars().focused.set(Some(next as usize));
        self.refresh();
        true
    }

    fn activate_focused(&self) {
        let i = self
            .ivars()
            .focused
            .get()
            .unwrap_or(self.ivars().selected.get());
        self.choose(i);
    }
}

pub(super) fn clear_hover_unless(item: Option<&NSMenuItem>) {
    PICKER.with(|p| {
        let p = p.borrow();
        let Some((picker, view)) = p.as_ref() else {
            return;
        };
        if !item.is_some_and(|item| std::ptr::eq(item, &**picker)) {
            view.clear_focus();
        }
    });
}

pub(super) fn clear_hover() {
    PICKER.with(|p| {
        if let Some((_, view)) = p.borrow().as_ref() {
            view.clear_focus();
        }
    });
}

pub(super) fn fit_to_menu_width(width: f64) {
    PICKER.with(|p| {
        if let Some((_, view)) = p.borrow().as_ref() {
            view.fit_to_width(width);
        }
    });
}

pub(super) fn hover_from_pointer() {
    PICKER.with(|p| {
        if let Some((_, view)) = p.borrow().as_ref() {
            view.hover_from_pointer();
        }
    });
}

pub(super) fn stop_flash() {
    FLASH_TIMER.with(|slot| {
        if let Some(timer) = slot.borrow_mut().take() {
            timer.invalidate();
        }
    });
    PICKER.with(|p| {
        if let Some((_, view)) = p.borrow().as_ref() {
            view.set_flash(false);
        }
    });
}

fn capsule_width() -> f64 {
    let n = PICKER_MODES.len() as f64;
    n * PILL_W + (n - 1.0) * PILL_GAP + 2.0 * CAPSULE_PAD
}

fn heading_font() -> Retained<NSFont> {
    let menu_size = NSFont::menuFontOfSize(0.0).pointSize();
    NSFont::systemFontOfSize_weight(menu_size, unsafe { NSFontWeightMedium })
}

fn italic(font: &NSFont) -> Retained<NSFont> {
    NSFontManager::sharedFontManager(MainThreadMarker::new().expect("main thread"))
        .convertFont_toHaveTrait(font, NSFontTraitMask::ItalicFontMask)
}

/// The picker is as wide as the widest heading needs, so a long translation
/// (German "Bildschirmfoto-Modus") cannot run past the capsule. Every mode is
/// measured both upright and italic, because hovering a pill draws the heading
/// italic and italic glyphs can be wider; sizing for upright alone let the
/// hovered heading overflow, and the width shift when the hover changed.
fn picker_width() -> f64 {
    let upright = heading_font();
    let slanted = italic(&upright);
    let widest = PICKER_MODES
        .iter()
        .flat_map(|(mode, _)| {
            let text = NSString::from_str(mode_heading(*mode));
            [&upright, &slanted].map(|font| {
                let attrs = NSDictionary::from_slices(
                    &[unsafe { NSFontAttributeName }],
                    &[&**font as &AnyObject],
                );
                unsafe { text.sizeWithAttributes(Some(&attrs)) }.width
            })
        })
        .fold(0.0_f64, f64::max);
    let needed = TITLE_INSET + widest + HEADING_GAP + capsule_width() + RIGHT_INSET;
    needed.max(PICKER_MIN_W)
}

/// Appends the mode picker row to `menu` and registers one action per pill, so a click
/// arrives through the usual tag channel as `ModeInstant` / `ModeStudio` / `ModeScreenshot`.
pub(super) fn append_mode_picker(
    menu: &NSMenu,
    selected: Mode,
    actions: &mut Vec<TrayItem>,
    mtm: MainThreadMarker,
) -> Retained<NSMenuItem> {
    let tag_base = actions.len() as isize;
    actions.extend(PICKER_MODES.iter().map(|(_, item)| item.clone()));

    let index = PICKER_MODES
        .iter()
        .position(|(m, _)| *m == selected)
        .unwrap_or(0);

    let view = ModePickerView::new(mtm, index, tag_base);

    let item = NSMenuItem::new(mtm);
    item.setTitle(&NSString::from_str(tr::tray::recording_mode())); // also its accessibility title
    item.setEnabled(true);
    item.setView(Some(&view));
    menu.addItem(&item);

    PICKER.with(|p| *p.borrow_mut() = Some((item.clone(), view)));
    item
}

// ---------------------------------------------------------------------------
// Private keyboard hook
// ---------------------------------------------------------------------------

/// ←/→/Return/Space while the picker row is highlighted. True means consumed.
fn handle_key(event: &NSEvent) -> bool {
    PICKER.with(|p| {
        let p = p.borrow();
        let Some((item, view)) = p.as_ref() else {
            return false;
        };
        // Up/down leave the row, so drop hover/focus whether or not the menu
        // considers the row highlighted (mouse hover may not highlight it).
        // Return false so the menu still moves the highlight.
        if matches!(event.keyCode(), 125 | 126) {
            view.clear_focus();
            return false;
        }
        if !item.isHighlighted() {
            return false;
        }
        match event.keyCode() {
            123 => view.move_focus(-1),
            124 => view.move_focus(1),
            36 | 76 | 49 => {
                view.activate_focused();
                true
            }
            _ => false,
        }
    })
}

/// Wraps `NSPopupMenuWindow -_handleKeyEvent:`. Private API: it does nothing if the
/// method is missing or has another shape, and it may break on any macOS update.
pub(super) fn install_key_hook() {
    static INSTALLED: std::sync::Once = std::sync::Once::new();
    INSTALLED.call_once(install_key_hook_once);
}

fn install_key_hook_once() {
    let sel = sel!(_handleKeyEvent:);
    let Some(cls) = AnyClass::get(c"NSPopupMenuWindow") else {
        return;
    };
    let Some(method) = cls.instance_method(sel) else {
        return;
    };
    let enc = unsafe {
        let p = objc2::ffi::method_getTypeEncoding(method as *const objc2::runtime::Method);
        if p.is_null() {
            return;
        }
        std::ffi::CStr::from_ptr(p)
    };
    if enc.to_bytes() != b"B24@0:8@16" {
        tracing::warn!(encoding = ?enc, "key hook: unexpected encoding, not installing");
        return;
    }
    let orig = method.implementation();

    let block = RcBlock::new(move |this: *mut AnyObject, event: *mut NSEvent| -> Bool {
        let ev = unsafe { &*event };
        let handled = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| handle_key(ev)))
            .unwrap_or(false);
        if ev.r#type() == NSEventType::KeyDown && handled {
            return Bool::YES;
        }
        let orig: unsafe extern "C-unwind" fn(*mut AnyObject, Sel, *mut NSEvent) -> Bool =
            unsafe { std::mem::transmute(orig) };
        unsafe { orig(this, sel, event) }
    });
    unsafe {
        let imp = objc2::ffi::imp_implementationWithBlock(&*block as *const _ as *mut AnyObject);
        method.set_implementation(imp);
    }
    std::mem::forget(block); // the replacement must outlive the process
    tracing::info!("key hook installed");
}
