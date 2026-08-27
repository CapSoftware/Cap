//! `Button` (`packages/ui-solid/src/Button.tsx`) and the icon-only button the
//! Solid app copy-pastes into three route files instead of sharing
//! (`TooltipIconButton`, digest section 2.3).

use gpui::{
    App, ClickEvent, ElementId, FontWeight, Hsla, InteractiveElement, IntoElement, ParentElement,
    Pixels, RenderOnce, SharedString, StatefulInteractiveElement, Styled, Window, div,
    prelude::FluentBuilder, px, svg,
};

use crate::theme::Theme;

/// The click handler every component takes. `cx.listener(..)` produces exactly
/// this shape for any window type, so components stay window-agnostic without
/// a generic parameter.
pub type ClickHandler = Box<dyn Fn(&ClickEvent, &mut Window, &mut App) + 'static>;

/// The nine `cva` variants. `darkgradient` and `radialblue` are the two the
/// app only uses for marketing CTAs (upgrade, onboarding) and are not built
/// until a window needs them.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ButtonVariant {
    /// `bg-gray-12 text-gray-1`, `disabled:bg-gray-6 disabled:text-gray-9`.
    Primary,
    /// `bg-blue-600 text-white border border-blue-800`.
    Blue,
    /// `bg-red-500 text-white hover:bg-red-600`.
    Destructive,
    /// `border border-gray-4 text-gray-12`, inverting to filled on hover.
    Outline,
    /// `bg-gray-1 border border-gray-6 text-gray-12 hover:bg-gray-3`.
    White,
    /// Transparent until `hover:bg-white/20` -- only legible on a dark backdrop.
    Ghost,
    /// `bg-gray-5 hover:bg-gray-7 text-gray-12`, with the `data-selected="true"`
    /// sub-state at `bg-gray-8` (`dark:bg-gray-9`).
    Gray,
    /// `bg-gray-12 hover:bg-gray-11 text-gray-1`.
    Dark,
}

/// `size: { xs, sm, md, lg }`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ButtonSize {
    /// `text-[0.75rem] px-2 h-5`.
    Xs,
    /// `text-xs px-3 h-7`.
    Sm,
    /// `text-[13px] px-3 py-2` -- the default, and the only height-less size.
    Md,
    /// `text-[0.875rem] px-4 h-9`.
    Lg,
}

impl ButtonSize {
    fn text_size(self) -> Pixels {
        match self {
            ButtonSize::Xs => px(12.),
            ButtonSize::Sm => px(12.),
            ButtonSize::Md => px(13.),
            ButtonSize::Lg => px(14.),
        }
    }

    fn padding_x(self) -> Pixels {
        match self {
            ButtonSize::Xs => px(8.),
            ButtonSize::Sm | ButtonSize::Md => px(12.),
            ButtonSize::Lg => px(16.),
        }
    }

    /// `md` is `py-2` rather than a fixed height, which is why this is optional.
    fn height(self) -> Option<Pixels> {
        match self {
            ButtonSize::Xs => Some(px(20.)),
            ButtonSize::Sm => Some(px(28.)),
            ButtonSize::Md => None,
            ButtonSize::Lg => Some(px(36.)),
        }
    }

    fn padding_y(self) -> Option<Pixels> {
        match self {
            ButtonSize::Md => Some(px(8.)),
            _ => None,
        }
    }

    fn icon_size(self) -> Pixels {
        match self {
            ButtonSize::Xs => px(12.),
            ButtonSize::Sm => px(14.),
            ButtonSize::Md => px(16.),
            ButtonSize::Lg => px(16.),
        }
    }
}

/// The resolved fills for one variant on one surface, so the render body has
/// no per-variant branching left in it.
#[derive(Debug, Clone, Copy)]
struct ButtonPaint {
    bg: Option<Hsla>,
    hover_bg: Option<Hsla>,
    text: Hsla,
    hover_text: Option<Hsla>,
    border: Option<Hsla>,
    hover_border: Option<Hsla>,
}

#[derive(IntoElement)]
pub struct Button {
    id: ElementId,
    label: Option<SharedString>,
    icon: Option<SharedString>,
    right_icon: Option<SharedString>,
    size: ButtonSize,
    paint: ButtonPaint,
    /// `rounded-full` unless a surface overrides it -- the settings material
    /// takes every `button[data-variant]` down to `border-radius: 8px`.
    radius: Option<Pixels>,
    disabled: bool,
    gap: Pixels,
    font_weight: Option<FontWeight>,
    width: Option<Pixels>,
    full_width: bool,
    height: Option<Pixels>,
    /// Whether the disabled look is the plain surface's `opacity-50` rather
    /// than the settings surface's repaint.
    dim_disabled: bool,
    on_click: Option<ClickHandler>,
}

impl Button {
    /// The plain Radix palette: the editor, mode select, and anything else with
    /// no native material behind it.
    pub fn plain(
        theme: &Theme,
        id: impl Into<ElementId>,
        variant: ButtonVariant,
        size: ButtonSize,
    ) -> Self {
        Self {
            id: id.into(),
            label: None,
            icon: None,
            right_icon: None,
            size,
            paint: radix_paint(theme, variant),
            radius: None,
            disabled: false,
            gap: px(6.),
            font_weight: None,
            width: None,
            full_width: false,
            height: None,
            dim_disabled: false,
            on_click: None,
        }
    }

    /// The main window: `Theme::body_*` already folds the panel material's
    /// `.cap-window-body` remaps into the Radix steps, so this is `plain` with
    /// the fills read back through those helpers.
    pub fn body(
        theme: &Theme,
        id: impl Into<ElementId>,
        variant: ButtonVariant,
        size: ButtonSize,
    ) -> Self {
        let mut button = Self::plain(theme, id, variant, size);
        if variant == ButtonVariant::Gray {
            // `bg-gray-5 hover:bg-gray-7` under the panel material's
            // `--macos-settings-control-active` / `--macos-settings-selection`.
            button.paint.bg = Some(theme.body_fill(5));
            button.paint.hover_bg = Some(theme.body_hover_fill(7));
            button.paint.text = theme.body_text();
        }
        button
    }

    /// The settings window. `theme.css`'s settings block rewrites every
    /// `button[data-variant]`: `border-radius: 8px`, the grey family onto
    /// `--macos-settings-control-fill` with a `--macos-settings-border`
    /// hairline, the filled family onto `--macos-settings-accent`, and
    /// `:disabled` onto `--macos-settings-fill` / `--macos-settings-muted`.
    pub fn settings(
        theme: &Theme,
        id: impl Into<ElementId>,
        variant: ButtonVariant,
        size: ButtonSize,
    ) -> Self {
        let control_fill = theme
            .material
            .map(|material| Hsla::from(material.control_fill))
            .unwrap_or_else(|| Hsla::from(theme.gray_5));

        // No `:hover` arm: the settings block's hover rules land on the nav and
        // profile rows, not on `button[data-variant]`, and the window has never
        // drawn one.
        let paint = match variant {
            ButtonVariant::Gray | ButtonVariant::White | ButtonVariant::Outline => ButtonPaint {
                bg: Some(control_fill),
                hover_bg: None,
                text: theme.settings_text(),
                hover_text: None,
                border: Some(theme.settings_border()),
                hover_border: None,
            },
            _ => ButtonPaint {
                bg: Some(gpui::rgb(Theme::SETTINGS_ACCENT).into()),
                hover_bg: None,
                text: gpui::white(),
                hover_text: None,
                border: None,
                hover_border: None,
            },
        };

        Self {
            radius: Some(px(8.)),
            ..Self::plain(theme, id, variant, size)
        }
        .paint(paint)
    }

    fn paint(mut self, paint: ButtonPaint) -> Self {
        self.paint = paint;
        self
    }

    pub fn label(mut self, label: impl Into<SharedString>) -> Self {
        self.label = Some(label.into());
        self
    }

    pub fn icon(mut self, icon: impl Into<SharedString>) -> Self {
        self.icon = Some(icon.into());
        self
    }

    pub fn right_icon(mut self, icon: impl Into<SharedString>) -> Self {
        self.right_icon = Some(icon.into());
        self
    }

    /// The plain surface's `:disabled`. `@cap/ui-solid`'s `Button` carries
    /// `disabled:opacity-50 disabled:cursor-not-allowed` on every variant, so
    /// this dims rather than repainting.
    pub fn disabled(mut self, disabled: bool) -> Self {
        self.disabled = disabled;
        self.dim_disabled = disabled;
        self
    }

    /// `disabled:` per variant. On the settings surface that is one rule for
    /// every variant, so the fills are replaced wholesale rather than dimmed.
    pub fn disabled_settings(mut self, theme: &Theme, disabled: bool) -> Self {
        self.disabled = disabled;
        if disabled {
            self.paint = ButtonPaint {
                bg: Some(theme.settings_fill()),
                hover_bg: None,
                text: theme.settings_muted(),
                hover_text: None,
                border: None,
                hover_border: None,
            };
        }
        self
    }

    pub fn radius(mut self, radius: Pixels) -> Self {
        self.radius = Some(radius);
        self
    }

    pub fn gap(mut self, gap: Pixels) -> Self {
        self.gap = gap;
        self
    }

    pub fn font_weight(mut self, weight: FontWeight) -> Self {
        self.font_weight = Some(weight);
        self
    }

    pub fn width(mut self, width: Pixels) -> Self {
        self.width = Some(width);
        self
    }

    pub fn full_width(mut self) -> Self {
        self.full_width = true;
        self
    }

    pub fn height(mut self, height: Pixels) -> Self {
        self.height = Some(height);
        self
    }

    pub fn bg(mut self, bg: Hsla) -> Self {
        self.paint.bg = Some(bg);
        self
    }

    pub fn text_color(mut self, color: Hsla) -> Self {
        self.paint.text = color;
        self
    }

    pub fn on_click(
        mut self,
        handler: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
    ) -> Self {
        self.on_click = Some(Box::new(handler));
        self
    }
}

/// The Radix fills for one variant, before any material remap.
///
/// `gray`'s `data-selected="true"` sub-state (`bg-gray-8`, `dark:bg-gray-9`) is
/// not built: no window here uses it -- the main window's mode pill marks its
/// selection with a ring instead.
fn radix_paint(theme: &Theme, variant: ButtonVariant) -> ButtonPaint {
    match variant {
        ButtonVariant::Primary => ButtonPaint {
            bg: Some(theme.gray(12)),
            hover_bg: None,
            text: theme.gray(1),
            hover_text: None,
            border: None,
            hover_border: None,
        },
        // `bg-blue-600 ... hover:bg-blue-700`: Tailwind's blue, not Radix's --
        // the two scales differ and the class is `blue-600`, not `blue-9`.
        ButtonVariant::Blue => ButtonPaint {
            bg: Some(gpui::rgb(0x2563eb).into()),
            hover_bg: Some(gpui::rgb(0x1d4ed8).into()),
            text: gpui::white(),
            hover_text: None,
            border: Some(gpui::rgb(0x1e40af).into()),
            hover_border: None,
        },
        ButtonVariant::Destructive => ButtonPaint {
            bg: Some(gpui::rgb(0xef4444).into()),
            hover_bg: Some(gpui::rgb(0xdc2626).into()),
            text: gpui::white(),
            hover_text: None,
            border: None,
            hover_border: None,
        },
        ButtonVariant::Outline => ButtonPaint {
            bg: None,
            hover_bg: Some(theme.gray(12)),
            text: theme.gray(12),
            hover_text: Some(theme.gray(1)),
            border: Some(theme.gray(4)),
            hover_border: Some(theme.gray(12)),
        },
        ButtonVariant::White => ButtonPaint {
            bg: Some(theme.gray(1)),
            hover_bg: Some(theme.gray(3)),
            text: theme.gray(12),
            hover_text: None,
            border: Some(theme.gray(6)),
            hover_border: None,
        },
        ButtonVariant::Ghost => ButtonPaint {
            bg: None,
            hover_bg: Some(gpui::hsla(0., 0., 1., 0.2)),
            text: theme.gray(12),
            hover_text: Some(gpui::white()),
            border: None,
            hover_border: None,
        },
        ButtonVariant::Gray => ButtonPaint {
            bg: Some(theme.gray(5)),
            hover_bg: Some(theme.gray(7)),
            text: theme.gray(12),
            hover_text: None,
            border: None,
            hover_border: None,
        },
        ButtonVariant::Dark => ButtonPaint {
            bg: Some(theme.gray(12)),
            hover_bg: Some(theme.gray(11)),
            text: theme.gray(1),
            hover_text: None,
            border: None,
            hover_border: None,
        },
    }
}

impl RenderOnce for Button {
    fn render(self, _window: &mut Window, _cx: &mut App) -> impl IntoElement {
        let Button {
            id,
            label,
            icon,
            right_icon,
            size,
            paint,
            radius,
            disabled,
            dim_disabled,
            gap,
            font_weight,
            width,
            full_width,
            height,
            on_click,
        } = self;

        let icon_color = paint.text;

        div()
            .id(id)
            .tab_index(0)
            .flex()
            .flex_row()
            .items_center()
            .justify_center()
            .gap(gap)
            .flex_shrink_0()
            .px(size.padding_x())
            .when_some(size.padding_y(), |this, py| this.py(py))
            .when_some(height.or(size.height()), |this, h| this.h(h))
            .when_some(width, |this, w| this.w(w))
            .when(full_width, |this| this.w_full())
            .map(|this| match radius {
                Some(radius) => this.rounded(radius),
                None => this.rounded_full(),
            })
            .text_size(size.text_size())
            .when_some(font_weight, |this, weight| this.font_weight(weight))
            .text_color(paint.text)
            .when_some(paint.bg, |this, bg| this.bg(bg))
            .when_some(paint.border, |this, border| {
                this.border_1().border_color(border)
            })
            .when(dim_disabled, |this| this.opacity(0.5))
            .when(!disabled, |this| {
                this.hover(move |style| {
                    let style = match paint.hover_bg {
                        Some(bg) => style.bg(bg),
                        None => style,
                    };
                    let style = match paint.hover_text {
                        Some(color) => style.text_color(color),
                        None => style,
                    };
                    match paint.hover_border {
                        Some(color) => style.border_color(color),
                        None => style,
                    }
                })
            })
            .children(icon.map(|icon| {
                svg()
                    .path(icon)
                    .size(size.icon_size())
                    .flex_shrink_0()
                    .text_color(icon_color)
            }))
            .children(label)
            .children(right_icon.map(|icon| {
                svg()
                    .path(icon)
                    .size(px(14.))
                    .flex_shrink_0()
                    .text_color(icon_color)
            }))
            .when_some(on_click.filter(|_| !disabled), |this, handler| {
                this.on_click(move |event, window, cx| handler(event, window, cx))
            })
    }
}

/// The icon-only button: a square hit area, a circular hover fill and no label.
///
/// `TooltipIconButton` in the Solid app is `p-2.5 opacity-70 hover:opacity-100
/// rounded-full hover:bg-gray-3 dark:hover:bg-gray-5 disabled:opacity-45`,
/// copy-pasted verbatim into `settings/recordings.tsx`, `settings/screenshots.tsx`
/// and `recordings-overlay.tsx`; the teleprompter's `ToolButton` is the same
/// shape at `size-7` with `gray-12`-alpha washes.
#[derive(IntoElement)]
pub struct IconButton {
    id: ElementId,
    icon: SharedString,
    size: Pixels,
    icon_size: Pixels,
    idle: Hsla,
    active_color: Hsla,
    hover_color: Option<Hsla>,
    hover_bg: Option<Hsla>,
    active_bg: Option<Hsla>,
    bg: Option<Hsla>,
    border: Option<Hsla>,
    active: bool,
    disabled: bool,
    occlude: bool,
    rounded: Option<Pixels>,
    on_click: Option<ClickHandler>,
}

impl IconButton {
    pub fn new(id: impl Into<ElementId>, icon: impl Into<SharedString>) -> Self {
        Self {
            id: id.into(),
            icon: icon.into(),
            size: px(28.),
            icon_size: px(14.),
            idle: gpui::white(),
            active_color: gpui::white(),
            hover_color: None,
            hover_bg: None,
            active_bg: None,
            bg: None,
            border: None,
            active: false,
            disabled: false,
            occlude: false,
            rounded: None,
            on_click: None,
        }
    }

    /// The main window header's action row: a 20px hit box with no fill at
    /// all, `text-gray-11` going to `text-gray-12` on hover.
    pub fn header(theme: &Theme, id: impl Into<ElementId>, icon: impl Into<SharedString>) -> Self {
        Self {
            occlude: cfg!(target_os = "windows"),
            size: px(20.),
            icon_size: px(16.),
            idle: theme.gray(11),
            active_color: theme.gray(12),
            hover_color: Some(theme.gray(12)),
            ..Self::new(id, icon)
        }
    }

    /// The teleprompter's `ToolButton`: `size-7 rounded-full text-gray-9
    /// hover:bg-gray-12/7 hover:text-gray-12`, active `bg-gray-12/8 text-gray-12`.
    pub fn glass(theme: &Theme, id: impl Into<ElementId>, icon: impl Into<SharedString>) -> Self {
        Self {
            idle: Hsla::from(theme.gray_9),
            active_color: Hsla::from(theme.gray_12),
            hover_bg: Some(Theme::with_alpha(theme.gray_12, 0.07)),
            active_bg: Some(Theme::with_alpha(theme.gray_12, 0.08)),
            ..Self::new(id, icon)
        }
    }

    /// A main-window body button: the panel material's `hover:bg-gray-4` /
    /// `bg-gray-5` remaps rather than the raw Radix steps.
    pub fn body(theme: &Theme, id: impl Into<ElementId>, icon: impl Into<SharedString>) -> Self {
        Self {
            idle: theme.gray(11),
            active_color: theme.body_text(),
            hover_bg: Some(theme.body_hover_fill(4)),
            active_bg: Some(theme.body_fill(5)),
            ..Self::new(id, icon)
        }
    }

    pub fn size(mut self, size: Pixels) -> Self {
        self.size = size;
        self
    }

    pub fn icon_size(mut self, size: Pixels) -> Self {
        self.icon_size = size;
        self
    }

    pub fn rounded(mut self, radius: Pixels) -> Self {
        self.rounded = Some(radius);
        self
    }

    pub fn active(mut self, active: bool) -> Self {
        self.active = active;
        self
    }

    /// A resting fill and hairline, for the buttons that have one even when
    /// idle -- the editor's transport play button is `rounded-full border
    /// border-gray-300 bg-gray-3 size-9`.
    pub fn filled(mut self, bg: Hsla, border: Option<Hsla>) -> Self {
        self.bg = Some(bg);
        self.border = border;
        self
    }

    pub fn hover_bg(mut self, bg: Hsla) -> Self {
        self.hover_bg = Some(bg);
        self
    }

    pub fn disabled(mut self, disabled: bool) -> Self {
        self.disabled = disabled;
        self
    }

    pub fn color(mut self, color: Hsla) -> Self {
        self.idle = color;
        self
    }

    pub fn on_click(
        mut self,
        handler: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
    ) -> Self {
        self.on_click = Some(Box::new(handler));
        self
    }
}

impl RenderOnce for IconButton {
    fn render(self, _window: &mut Window, _cx: &mut App) -> impl IntoElement {
        let IconButton {
            id,
            icon,
            size,
            icon_size,
            idle,
            active_color,
            hover_color,
            hover_bg,
            active_bg,
            bg,
            border,
            active,
            disabled,
            occlude,
            rounded,
            on_click,
        } = self;

        div()
            .id(id)
            .when(occlude, |this| this.occlude())
            .tab_index(0)
            .flex()
            .items_center()
            .justify_center()
            .size(size)
            .flex_shrink_0()
            .map(|this| match rounded {
                Some(radius) => this.rounded(radius),
                None => this.rounded_full(),
            })
            .when_some(bg, |this, bg| this.bg(bg))
            .when_some(border, |this, border| this.border_1().border_color(border))
            .when(active, |this| {
                this.when_some(active_bg, |this, bg| this.bg(bg))
            })
            .when(disabled, |this| this.opacity(0.45))
            .child(svg().path(icon).size(icon_size).text_color(if active {
                active_color
            } else {
                idle
            }))
            .when(
                !disabled && (hover_bg.is_some() || hover_color.is_some()),
                |this| {
                    this.hover(move |style| {
                        let style = match hover_bg {
                            Some(bg) => style.bg(bg),
                            None => style,
                        };
                        match hover_color {
                            Some(color) => style.text_color(color),
                            None => style,
                        }
                    })
                },
            )
            .when_some(on_click.filter(|_| !disabled), |this, handler| {
                this.on_click(move |event, window, cx| handler(event, window, cx))
            })
    }
}
