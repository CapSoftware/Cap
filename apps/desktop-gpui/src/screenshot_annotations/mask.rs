use cap_gpui_kernels::mask_style::{MaskEffect, MaskStyle};
use cap_project::{MaskOptions, MaskShape};
use gpui::{linear_color_stop, linear_gradient};

use super::*;

const BRAND_BLUE: &str = "#4785FF";
const ROUNDED_DEFAULT_RADIUS: f64 = 12.;
const TINT_ON_COLOR_PICK: f64 = 0.4;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub(crate) enum MaskPanel {
    Presets,
    Adjust,
}

impl MaskPanel {
    fn id(self) -> &'static str {
        match self {
            Self::Presets => "screenshot-mask-presets",
            Self::Adjust => "screenshot-mask-adjust",
        }
    }

    fn width(self) -> f32 {
        match self {
            Self::Presets => 300.,
            Self::Adjust => 260.,
        }
    }
}

/// What the Style pills choose between. `Solid` is stored as a flag next to
/// `maskType` so older builds still hide the region with a blur.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum MaskStyleChoice {
    Blur,
    Pixelate,
    Solid,
}

impl MaskStyleChoice {
    const ALL: [MaskStyleChoice; 3] = [Self::Blur, Self::Pixelate, Self::Solid];

    fn of(annotation: &Annotation) -> Self {
        if annotation
            .mask_options
            .as_ref()
            .is_some_and(|options| options.solid)
        {
            return Self::Solid;
        }
        match annotation.mask_type {
            Some(MaskType::Pixelate) => Self::Pixelate,
            _ => Self::Blur,
        }
    }

    fn id(self) -> &'static str {
        match self {
            Self::Blur => "blur",
            Self::Pixelate => "pixelate",
            Self::Solid => "solid",
        }
    }

    fn label(self) -> &'static str {
        match self {
            Self::Blur => tr::screenshot_editor::style::blur(),
            Self::Pixelate => tr::screenshot_editor::annotation::pixelate(),
            Self::Solid => tr::screenshot_editor::mask::solid(),
        }
    }

    fn apply(self, annotation: &mut Annotation) -> bool {
        if Self::of(annotation) == self {
            return false;
        }
        let options = annotation.mask_options.get_or_insert_with(Default::default);
        options.solid = self == Self::Solid;
        match self {
            Self::Blur => annotation.mask_type = Some(MaskType::Blur),
            Self::Pixelate => annotation.mask_type = Some(MaskType::Pixelate),
            Self::Solid => {}
        }
        true
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum MaskShapeChoice {
    Square,
    Rounded,
    Ellipse,
}

impl MaskShapeChoice {
    const ALL: [MaskShapeChoice; 3] = [Self::Square, Self::Rounded, Self::Ellipse];

    fn of(options: &MaskOptions) -> Self {
        match options.shape {
            MaskShape::Ellipse => Self::Ellipse,
            MaskShape::Rectangle if options.corner_radius > 0. => Self::Rounded,
            MaskShape::Rectangle => Self::Square,
        }
    }

    fn id(self) -> &'static str {
        match self {
            Self::Square => "square",
            Self::Rounded => "rounded",
            Self::Ellipse => "ellipse",
        }
    }

    fn icon(self) -> &'static str {
        match self {
            Self::Square => "icons/square.svg",
            Self::Rounded => "icons/corners.svg",
            Self::Ellipse => "icons/circle.svg",
        }
    }

    fn label(self) -> &'static str {
        match self {
            Self::Square => tr::screenshot_editor::mask::shape_rectangle(),
            Self::Rounded => tr::screenshot_editor::mask::shape_rounded(),
            Self::Ellipse => tr::screenshot_editor::mask::shape_ellipse(),
        }
    }

    fn apply(self, options: &mut MaskOptions) -> bool {
        if Self::of(options) == self {
            return false;
        }
        match self {
            Self::Square => {
                options.shape = MaskShape::Rectangle;
                options.corner_radius = 0.;
            }
            Self::Rounded => {
                options.shape = MaskShape::Rectangle;
                if options.corner_radius <= 0. {
                    options.corner_radius = ROUNDED_DEFAULT_RADIUS;
                }
            }
            Self::Ellipse => options.shape = MaskShape::Ellipse,
        }
        true
    }
}

/// One-click looks. Each preset writes every mask field, so applying one is
/// a complete restyle rather than a merge with whatever was there.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum MaskPreset {
    SoftBlur,
    Mosaic,
    Redact,
    Frosted,
    Spotlight,
    Focus,
    CapBlue,
}

struct PresetLook {
    mask_type: MaskType,
    level: f64,
    opacity: f64,
    options: MaskOptions,
}

impl MaskPreset {
    const ALL: [MaskPreset; 7] = [
        Self::SoftBlur,
        Self::Mosaic,
        Self::Redact,
        Self::Frosted,
        Self::Spotlight,
        Self::Focus,
        Self::CapBlue,
    ];

    fn id(self) -> &'static str {
        match self {
            Self::SoftBlur => "soft-blur",
            Self::Mosaic => "mosaic",
            Self::Redact => "redact",
            Self::Frosted => "frosted",
            Self::Spotlight => "spotlight",
            Self::Focus => "focus",
            Self::CapBlue => "cap-blue",
        }
    }

    fn label(self) -> &'static str {
        match self {
            Self::SoftBlur => tr::screenshot_editor::mask::preset::soft_blur(),
            Self::Mosaic => tr::screenshot_editor::mask::preset::mosaic(),
            Self::Redact => tr::screenshot_editor::mask::preset::redact(),
            Self::Frosted => tr::screenshot_editor::mask::preset::frosted(),
            Self::Spotlight => tr::screenshot_editor::mask::preset::spotlight(),
            Self::Focus => tr::screenshot_editor::mask::preset::focus(),
            Self::CapBlue => tr::screenshot_editor::mask::preset::cap_blue(),
        }
    }

    fn hint(self) -> &'static str {
        match self {
            Self::SoftBlur => tr::screenshot_editor::mask::preset::soft_blur_hint(),
            Self::Mosaic => tr::screenshot_editor::mask::preset::mosaic_hint(),
            Self::Redact => tr::screenshot_editor::mask::preset::redact_hint(),
            Self::Frosted => tr::screenshot_editor::mask::preset::frosted_hint(),
            Self::Spotlight => tr::screenshot_editor::mask::preset::spotlight_hint(),
            Self::Focus => tr::screenshot_editor::mask::preset::focus_hint(),
            Self::CapBlue => tr::screenshot_editor::mask::preset::cap_blue_hint(),
        }
    }

    fn look(self) -> PresetLook {
        let base = MaskOptions::default();
        match self {
            Self::SoftBlur => PresetLook {
                mask_type: MaskType::Blur,
                level: 24.,
                opacity: 1.,
                options: MaskOptions {
                    corner_radius: 10.,
                    feather: 6.,
                    ..base
                },
            },
            Self::Mosaic => PresetLook {
                mask_type: MaskType::Pixelate,
                level: 14.,
                opacity: 1.,
                options: base,
            },
            Self::Redact => PresetLook {
                mask_type: MaskType::Blur,
                level: 40.,
                opacity: 1.,
                options: MaskOptions {
                    solid: true,
                    corner_radius: 4.,
                    ..base
                },
            },
            Self::Frosted => PresetLook {
                mask_type: MaskType::Blur,
                level: 48.,
                opacity: 1.,
                options: MaskOptions {
                    corner_radius: 16.,
                    color: "#FFFFFF".to_string(),
                    tint: 0.45,
                    ..base
                },
            },
            Self::Spotlight => PresetLook {
                mask_type: MaskType::Blur,
                level: 8.,
                opacity: 0.65,
                options: MaskOptions {
                    shape: MaskShape::Ellipse,
                    feather: 32.,
                    invert: true,
                    solid: true,
                    ..base
                },
            },
            Self::Focus => PresetLook {
                mask_type: MaskType::Blur,
                level: 36.,
                opacity: 1.,
                options: MaskOptions {
                    corner_radius: 16.,
                    feather: 20.,
                    invert: true,
                    ..base
                },
            },
            Self::CapBlue => PresetLook {
                mask_type: MaskType::Pixelate,
                level: 10.,
                opacity: 1.,
                options: MaskOptions {
                    corner_radius: 12.,
                    color: BRAND_BLUE.to_string(),
                    tint: 0.55,
                    ..base
                },
            },
        }
    }

    fn apply(self, annotation: &mut Annotation) -> bool {
        if self.matches(annotation) {
            return false;
        }
        let look = self.look();
        annotation.mask_type = Some(look.mask_type);
        annotation.mask_level = Some(look.level);
        annotation.opacity = look.opacity;
        annotation.mask_options = Some(look.options);
        true
    }

    fn matches(self, annotation: &Annotation) -> bool {
        let look = self.look();
        let options = annotation.mask_options.clone().unwrap_or_default();
        let solid = look.options.solid;
        annotation.mask_type.unwrap_or(MaskType::Blur) == look.mask_type
            && (solid || annotation.mask_level.unwrap_or(MASK_FALLBACK_LEVEL) == look.level)
            && annotation.opacity == look.opacity
            && options.shape == look.options.shape
            && options.corner_radius == look.options.corner_radius
            && options.feather == look.options.feather
            && options.invert == look.options.invert
            && options.solid == solid
            && options.tint == look.options.tint
            && (look.options.tint <= 0. && !solid
                || options.color.eq_ignore_ascii_case(&look.options.color))
    }

    fn of(annotation: &Annotation) -> Option<Self> {
        Self::ALL
            .into_iter()
            .find(|preset| preset.matches(annotation))
    }

    fn swatch(self, theme: &Theme) -> AnyElement {
        let scene = |inner: gpui::Div| {
            div()
                .relative()
                .w(px(52.))
                .h(px(36.))
                .flex_shrink_0()
                .rounded(px(8.))
                .overflow_hidden()
                .bg(linear_gradient(
                    135.,
                    linear_color_stop(gpui::rgb(0xF8B26A), 0.),
                    linear_color_stop(gpui::rgb(0x6C8CFF), 1.),
                ))
                .child(inner)
        };
        let blob = |x: f32, y: f32, size: f32, color: u32, blur: f32| {
            div()
                .absolute()
                .left(px(x))
                .top(px(y))
                .size(px(size))
                .rounded_full()
                .bg(gpui::rgb(color))
                .shadow(vec![gpui::BoxShadow {
                    color: Theme::with_alpha(gpui::rgb(color), 0.9),
                    offset: gpui::point(px(0.), px(0.)),
                    blur_radius: px(blur),
                    spread_radius: px(blur / 2.),
                    inset: false,
                }])
        };
        let tiles = |palette: [u32; 6], tint: Option<(u32, f32)>| {
            let mut grid = div()
                .absolute()
                .top_0()
                .left_0()
                .size_full()
                .flex()
                .flex_row()
                .flex_wrap();
            for color in palette {
                grid = grid.child(div().w(px(52. / 3.)).h(px(18.)).bg(gpui::rgb(match tint {
                    Some((tint, amount)) => mix_rgb(color, tint, amount),
                    None => color,
                })));
            }
            grid
        };
        let theme = *theme;
        match self {
            Self::SoftBlur => scene(
                div()
                    .absolute()
                    .size_full()
                    .child(blob(8., 8., 12., 0xFFE0B0, 10.))
                    .child(blob(28., 14., 14., 0x8FA8FF, 10.)),
            ),
            Self::Mosaic => scene(tiles(
                [0xF8B26A, 0xE58FA0, 0x9C8CF0, 0xD99A7C, 0xA88FD8, 0x6C8CFF],
                None,
            )),
            Self::Redact => scene(
                div().absolute().size_full().child(
                    div()
                        .absolute()
                        .left(px(6.))
                        .top(px(13.))
                        .w(px(40.))
                        .h(px(10.))
                        .rounded(px(2.))
                        .bg(gpui::rgb(0x111111)),
                ),
            ),
            Self::Frosted => scene(
                div()
                    .absolute()
                    .size_full()
                    .child(blob(6., 6., 14., 0xFFD08A, 8.))
                    .child(
                        div()
                            .absolute()
                            .left(px(6.))
                            .top(px(6.))
                            .w(px(40.))
                            .h(px(24.))
                            .rounded(px(6.))
                            .bg(Theme::with_alpha(gpui::rgb(0xFFFFFF), 0.55))
                            .border_1()
                            .border_color(Theme::with_alpha(gpui::rgb(0xFFFFFF), 0.8)),
                    ),
            ),
            Self::Spotlight => scene(
                div()
                    .absolute()
                    .size_full()
                    .bg(Theme::with_alpha(gpui::rgb(0x000000), 0.6))
                    .child(
                        div()
                            .absolute()
                            .left(px(16.))
                            .top(px(8.))
                            .w(px(20.))
                            .h(px(20.))
                            .rounded_full()
                            .bg(linear_gradient(
                                135.,
                                linear_color_stop(gpui::rgb(0xF8B26A), 0.),
                                linear_color_stop(gpui::rgb(0x9C8CF0), 1.),
                            ))
                            .shadow(vec![gpui::BoxShadow {
                                color: Theme::with_alpha(gpui::rgb(0xFFFFFF), 0.35),
                                offset: gpui::point(px(0.), px(0.)),
                                blur_radius: px(8.),
                                spread_radius: px(2.),
                                inset: false,
                            }]),
                    ),
            ),
            Self::Focus => scene(
                div()
                    .absolute()
                    .size_full()
                    .child(blob(2., 2., 10., 0xFFE0B0, 8.))
                    .child(blob(40., 22., 10., 0x8FA8FF, 8.))
                    .child(
                        div()
                            .absolute()
                            .left(px(14.))
                            .top(px(9.))
                            .w(px(24.))
                            .h(px(18.))
                            .rounded(px(4.))
                            .border_1()
                            .border_color(gpui::white())
                            .bg(linear_gradient(
                                90.,
                                linear_color_stop(gpui::rgb(0xF29B78), 0.),
                                linear_color_stop(gpui::rgb(0x8C8CF6), 1.),
                            )),
                    ),
            ),
            Self::CapBlue => scene(tiles(
                [0xF8B26A, 0xE58FA0, 0x9C8CF0, 0xD99A7C, 0xA88FD8, 0x6C8CFF],
                Some((0x4785FF, 0.6)),
            )),
        }
        .border_1()
        .border_color(theme.gray_4)
        .into_any_element()
    }
}

/// The kernel's view of one mask. The preview filters the atlas's BGRA, so
/// `bgra` swaps the colour's channels to match the bytes it will be mixed
/// into.
pub(super) fn mask_style(mask: &Annotation, bgra: bool) -> MaskStyle {
    let options = mask.mask_options.clone().unwrap_or_default();
    let [r, g, b, _] = hex_to_rgb(&options.color).unwrap_or([0, 0, 0, 255]);
    MaskStyle {
        effect: if options.solid {
            MaskEffect::Solid
        } else if mask.mask_type == Some(MaskType::Pixelate) {
            MaskEffect::Pixelate
        } else {
            MaskEffect::Blur
        },
        level: mask
            .mask_level
            .unwrap_or(MASK_FALLBACK_LEVEL)
            .max(1.)
            .to_bits(),
        ellipse: options.shape == MaskShape::Ellipse,
        corner_radius: options.corner_radius.to_bits(),
        feather: options.feather.to_bits(),
        invert: options.invert,
        color: if bgra { [b, g, r] } else { [r, g, b] },
        tint: options.tint.to_bits(),
        opacity: mask.opacity.to_bits(),
    }
}

/// The pixels one mask resamples and the rect its shape occupies, both in
/// whole frame pixels. A normal mask works inside its own rect; an inverted
/// one covers the screenshot's whole content rect with its own rect as the
/// hole. Everything is clipped to `clip` first.
pub(super) fn mask_regions(
    mask: &Annotation,
    clip: [f64; 4],
    content: [f64; 4],
    frame: (u32, u32),
) -> Option<((u32, u32, u32, u32), (u32, u32, u32, u32))> {
    let shape = cap_gpui_kernels::mask_cache::mask_region(
        [mask.x, mask.y, mask.width, mask.height],
        clip,
        frame,
    )?;
    let inverted = mask
        .mask_options
        .as_ref()
        .is_some_and(|options| options.invert);
    if !inverted {
        return Some((shape, shape));
    }
    let region = cap_gpui_kernels::mask_cache::mask_region(content, clip, frame)?;
    Some((region, shape))
}

impl ScreenshotEditorWindow {
    /// A new mask copies the look of the selected mask, or else the last one
    /// drawn, so a run of redactions does not need restyling one by one.
    pub(super) fn mask_style_source(&self) -> Option<Annotation> {
        self.selected()
            .filter(|annotation| annotation.annotation_type == AnnotationType::Mask)
            .or_else(|| {
                self.project
                    .annotations
                    .iter()
                    .rev()
                    .find(|annotation| annotation.annotation_type == AnnotationType::Mask)
            })
            .cloned()
    }

    fn edit_selected_mask(
        &mut self,
        change: impl FnOnce(&mut Annotation) -> bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(id) = self.selected_annotation.clone() else {
            return;
        };
        self.edit_project(
            move |project| {
                project
                    .annotations
                    .iter_mut()
                    .find(|annotation| {
                        annotation.id == id && annotation.annotation_type == AnnotationType::Mask
                    })
                    .is_some_and(change)
            },
            window,
            cx,
        );
    }

    /// Picking a colour on a blur or pixelate mask with no tint would change
    /// nothing visible, so the first pick also turns the tint up.
    pub(super) fn ensure_mask_tint_visible(options: &mut MaskOptions) {
        if !options.solid && options.tint <= 0. {
            options.tint = TINT_ON_COLOR_PICK;
        }
    }

    fn toggle_mask_panel(&mut self, panel: MaskPanel, cx: &mut Context<Self>) {
        let Some(id) = self.selected_annotation.clone() else {
            return;
        };
        let open = self
            .annotation_state
            .mask_panel
            .as_ref()
            .is_some_and(|(open, open_id)| *open == panel && open_id == &id);
        self.annotation_state.color_popover = None;
        self.annotation_state.mask_panel = (!open).then_some((panel, id));
        cx.notify();
    }

    fn mask_anchor(&self, panel: MaskPanel) -> BoundsCell {
        self.annotation_state
            .mask_anchors
            .get(&panel)
            .cloned()
            .unwrap_or_default()
    }

    pub(super) fn render_mask_controls(
        &self,
        annotation: &Annotation,
        cx: &mut Context<Self>,
    ) -> Vec<AnyElement> {
        let theme = self.theme;
        let style = MaskStyleChoice::of(annotation);
        let options = annotation.mask_options.clone().unwrap_or_default();
        let shape = MaskShapeChoice::of(&options);
        let preset = MaskPreset::of(annotation);
        let open = self
            .annotation_state
            .mask_panel
            .as_ref()
            .map(|(panel, _)| *panel);

        let mut items = vec![self.render_mask_panel_button(
            MaskPanel::Presets,
            "icons/sparkles.svg",
            preset.map_or(tr::screenshot_editor::mask::presets(), MaskPreset::label),
            open == Some(MaskPanel::Presets),
            preset.is_some(),
            cx,
        )];

        let mut pills = div().flex().flex_row().gap(px(4.));
        for choice in MaskStyleChoice::ALL {
            pills = pills.child(mask_pill(
                &theme,
                format!("screenshot-mask-style-{}", choice.id()),
                Some(choice.label().into()),
                None,
                choice == style,
                cx.listener(move |this, _, window, cx| {
                    cx.stop_propagation();
                    this.edit_selected_mask(|annotation| choice.apply(annotation), window, cx);
                }),
            ));
        }
        items.push(config_item(
            &theme,
            tr::screenshot_editor::annotation::mask_style(),
            None,
            pills.into_any_element(),
        ));

        if style != MaskStyleChoice::Solid {
            items.push(config_item(
                &theme,
                tr::screenshot_editor::annotation::intensity(),
                Some(format!(
                    "{}",
                    annotation.mask_level.unwrap_or(MASK_FALLBACK_LEVEL).round() as i64
                )),
                self.annotation_slider(AnnotationSlider::MaskLevel, px(88.), cx)
                    .into_any_element(),
            ));
        }

        let mut shapes = div().flex().flex_row().gap(px(4.));
        for choice in MaskShapeChoice::ALL {
            let label = choice.label();
            shapes = shapes.child(
                div()
                    .id(gpui::SharedString::from(format!(
                        "screenshot-mask-shape-tip-{}",
                        choice.id()
                    )))
                    .child(mask_pill(
                        &theme,
                        format!("screenshot-mask-shape-{}", choice.id()),
                        None,
                        Some(choice.icon()),
                        choice == shape,
                        cx.listener(move |this, _, window, cx| {
                            cx.stop_propagation();
                            this.edit_selected_mask(
                                |annotation| {
                                    choice.apply(
                                        annotation
                                            .mask_options
                                            .get_or_insert_with(Default::default),
                                    )
                                },
                                window,
                                cx,
                            );
                        }),
                    ))
                    .tooltip_show_delay(ui::TOOLTIP_SHOW_DELAY)
                    .tooltip(move |_window, cx| ui::Tooltip::new(&theme, label).view(cx)),
            );
        }
        items.push(config_item(
            &theme,
            tr::screenshot_editor::mask::shape(),
            None,
            shapes.into_any_element(),
        ));

        items.push(config_item(
            &theme,
            tr::screenshot_editor::style::color(),
            None,
            self.render_color_button(ColorTarget::Mask, cx),
        ));

        let inverted = options.invert;
        items.push(
            div()
                .id("screenshot-mask-invert-tip")
                .child(mask_pill(
                    &theme,
                    "screenshot-mask-invert".to_string(),
                    Some(tr::screenshot_editor::mask::invert().into()),
                    Some("icons/box-select.svg"),
                    inverted,
                    cx.listener(move |this, _, window, cx| {
                        cx.stop_propagation();
                        this.edit_selected_mask(
                            |annotation| {
                                let options =
                                    annotation.mask_options.get_or_insert_with(Default::default);
                                options.invert = !options.invert;
                                true
                            },
                            window,
                            cx,
                        );
                    }),
                ))
                .tooltip_show_delay(ui::TOOLTIP_SHOW_DELAY)
                .tooltip(move |_window, cx| {
                    ui::Tooltip::new(&theme, tr::screenshot_editor::mask::invert_hint()).view(cx)
                })
                .into_any_element(),
        );

        items.push(self.render_mask_panel_button(
            MaskPanel::Adjust,
            "icons/sliders-horizontal.svg",
            tr::screenshot_editor::mask::adjust(),
            open == Some(MaskPanel::Adjust),
            false,
            cx,
        ));

        items
    }

    fn render_mask_panel_button(
        &self,
        panel: MaskPanel,
        icon: &'static str,
        label: &'static str,
        open: bool,
        highlighted: bool,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let theme = self.theme;
        let cell = self.mask_anchor(panel);
        let accent = open || highlighted;
        div()
            .relative()
            .flex_shrink_0()
            .child(
                canvas(
                    move |bounds, _window, _cx| cell.set(Some(bounds)),
                    |_, _, _, _| {},
                )
                .absolute()
                .size_full(),
            )
            .child(
                div()
                    .id(panel.id())
                    .flex()
                    .flex_row()
                    .items_center()
                    .gap(px(6.))
                    .h(px(26.))
                    .pl(px(8.))
                    .pr(px(6.))
                    .rounded(px(7.))
                    .cursor_pointer()
                    .text_size(px(12.))
                    .font_weight(FontWeight::MEDIUM)
                    .border_1()
                    .when(accent, |this| {
                        this.bg(theme.blue_3)
                            .border_color(theme.blue_6)
                            .text_color(theme.blue_11)
                    })
                    .when(!accent, |this| {
                        this.bg(theme.gray_3)
                            .border_color(theme.gray_4)
                            .text_color(theme.gray_11)
                            .hover(|style| style.bg(theme.gray_4))
                    })
                    .child(svg().path(icon).size(px(14.)).text_color(if accent {
                        theme.blue_11
                    } else {
                        theme.gray_11
                    }))
                    .child(label)
                    .child(
                        svg()
                            .path("icons/chevron-down.svg")
                            .size(px(12.))
                            .text_color(theme.gray_10),
                    )
                    .on_click(cx.listener(move |this, _, _window, cx| {
                        cx.stop_propagation();
                        this.toggle_mask_panel(panel, cx);
                    })),
            )
            .into_any_element()
    }

    pub(super) fn render_mask_panel(
        &self,
        window: &Window,
        cx: &mut Context<Self>,
    ) -> Option<AnyElement> {
        let (panel, id) = self.annotation_state.mask_panel.clone()?;
        if self.selected_annotation.as_deref() != Some(id.as_str()) {
            return None;
        }
        let annotation = self
            .annotation(&id)
            .filter(|annotation| annotation.annotation_type == AnnotationType::Mask)?
            .clone();
        let theme = self.theme;
        let width = panel.width();
        let viewport = window.viewport_size();
        let anchor = self.mask_anchor(panel).get();
        let left = anchor
            .map(|bounds| f32::from(bounds.origin.x))
            .unwrap_or(16.)
            .clamp(8., (f32::from(viewport.width) - width - 8.).max(8.));
        let top = anchor
            .map(|bounds| f32::from(bounds.origin.y + bounds.size.height) + 8.)
            .unwrap_or(120.);

        let body = match panel {
            MaskPanel::Presets => self.render_mask_presets(&annotation, cx),
            MaskPanel::Adjust => self.render_mask_adjust(&annotation, cx),
        };

        Some(
            div()
                .absolute()
                .top_0()
                .left_0()
                .size_full()
                .child(
                    div()
                        .id("screenshot-mask-panel-backdrop")
                        .occlude()
                        .absolute()
                        .top_0()
                        .left_0()
                        .size_full()
                        .on_click(cx.listener(|this, _, _window, cx| {
                            this.annotation_state.mask_panel = None;
                            cx.notify();
                        })),
                )
                .child(
                    div()
                        .id("screenshot-mask-panel")
                        .occlude()
                        .absolute()
                        .left(px(left))
                        .top(px(top))
                        .w(px(width))
                        .p(px(10.))
                        .flex()
                        .flex_col()
                        .gap(px(10.))
                        .rounded(px(10.))
                        .border_1()
                        .border_color(theme.gray_4)
                        .bg(if theme.is_dark() {
                            theme.gray_2
                        } else {
                            theme.gray_1
                        })
                        .shadow(vec![gpui::BoxShadow {
                            color: Theme::with_alpha(gpui::rgb(0x000000), 0.18),
                            offset: gpui::point(px(0.), px(8.)),
                            blur_radius: px(24.),
                            spread_radius: px(0.),
                            inset: false,
                        }])
                        .on_click(|_, _window, cx| cx.stop_propagation())
                        .child(
                            div()
                                .text_size(px(11.))
                                .font_weight(FontWeight::SEMIBOLD)
                                .text_color(theme.gray_10)
                                .child(match panel {
                                    MaskPanel::Presets => {
                                        tr::screenshot_editor::mask::presets_title()
                                    }
                                    MaskPanel::Adjust => tr::screenshot_editor::mask::adjust(),
                                }),
                        )
                        .child(body),
                )
                .into_any_element(),
        )
    }

    fn render_mask_presets(&self, annotation: &Annotation, cx: &mut Context<Self>) -> AnyElement {
        let theme = self.theme;
        let current = MaskPreset::of(annotation);
        let mut list = div().flex().flex_col().gap(px(4.));
        for preset in MaskPreset::ALL {
            let active = current == Some(preset);
            list = list.child(
                div()
                    .id(gpui::SharedString::from(format!(
                        "screenshot-mask-preset-{}",
                        preset.id()
                    )))
                    .flex()
                    .flex_row()
                    .items_center()
                    .gap(px(10.))
                    .p(px(6.))
                    .rounded(px(8.))
                    .cursor_pointer()
                    .border_1()
                    .when(active, |this| {
                        this.bg(theme.blue_3).border_color(theme.blue_6)
                    })
                    .when(!active, |this| {
                        this.border_color(gpui::transparent_black())
                            .hover(|style| style.bg(theme.gray_3))
                    })
                    .child(preset.swatch(&theme))
                    .child(
                        div()
                            .flex()
                            .flex_col()
                            .flex_1()
                            .min_w_0()
                            .gap(px(2.))
                            .child(
                                div()
                                    .text_size(px(12.))
                                    .font_weight(FontWeight::MEDIUM)
                                    .text_color(if active { theme.blue_11 } else { theme.gray_12 })
                                    .child(preset.label()),
                            )
                            .child(
                                div()
                                    .text_size(px(11.))
                                    .text_color(theme.gray_10)
                                    .child(preset.hint()),
                            ),
                    )
                    .when(active, |this| {
                        this.child(
                            svg()
                                .path("icons/check.svg")
                                .size(px(14.))
                                .text_color(theme.blue_11),
                        )
                    })
                    .on_click(cx.listener(move |this, _, window, cx| {
                        cx.stop_propagation();
                        this.edit_selected_mask(|annotation| preset.apply(annotation), window, cx);
                    })),
            );
        }
        div()
            .flex()
            .flex_col()
            .gap(px(8.))
            .child(list)
            .child(
                div()
                    .flex()
                    .flex_row()
                    .items_start()
                    .gap(px(6.))
                    .pt(px(8.))
                    .border_t_1()
                    .border_color(theme.gray_3)
                    .child(
                        svg()
                            .path("icons/shield.svg")
                            .size(px(12.))
                            .mt(px(1.))
                            .flex_shrink_0()
                            .text_color(theme.gray_9),
                    )
                    .child(
                        div()
                            .text_size(px(10.))
                            .text_color(theme.gray_9)
                            .child(tr::screenshot_editor::mask::privacy_note()),
                    ),
            )
            .into_any_element()
    }

    fn render_mask_adjust(&self, annotation: &Annotation, cx: &mut Context<Self>) -> AnyElement {
        let theme = self.theme;
        let options = annotation.mask_options.clone().unwrap_or_default();
        let row = |label: &'static str, value: String, slider: AnyElement| {
            div()
                .flex()
                .flex_col()
                .gap(px(6.))
                .child(
                    div()
                        .flex()
                        .flex_row()
                        .justify_between()
                        .text_size(px(11.))
                        .font_weight(FontWeight::MEDIUM)
                        .child(div().text_color(theme.gray_10).child(label))
                        .child(div().text_color(theme.gray_12).child(value)),
                )
                .child(slider)
        };
        let slider_width = px(MaskPanel::Adjust.width() - 20.);
        let mut body = div().flex().flex_col().gap(px(12.)).child(row(
            tr::screenshot_editor::mask::feather(),
            format!("{}px", options.feather.round() as i64),
            self.annotation_slider(AnnotationSlider::MaskFeather, slider_width, cx)
                .into_any_element(),
        ));
        if options.shape == MaskShape::Rectangle {
            body = body.child(row(
                tr::screenshot_editor::mask::corner_radius(),
                format!("{}px", options.corner_radius.round() as i64),
                self.annotation_slider(AnnotationSlider::MaskRadius, slider_width, cx)
                    .into_any_element(),
            ));
        }
        if !options.solid {
            body = body.child(row(
                tr::screenshot_editor::mask::tint(),
                format!("{}%", (options.tint * 100.).round() as i64),
                self.annotation_slider(AnnotationSlider::MaskTint, slider_width, cx)
                    .into_any_element(),
            ));
        }
        body.child(row(
            tr::screenshot_editor::style::opacity(),
            format!("{}%", (annotation.opacity * 100.).round() as i64),
            self.annotation_slider(AnnotationSlider::Opacity, slider_width, cx)
                .into_any_element(),
        ))
        .child(
            div()
                .flex()
                .flex_row()
                .items_center()
                .justify_between()
                .pt(px(10.))
                .border_t_1()
                .border_color(theme.gray_3)
                .child(
                    div()
                        .flex()
                        .flex_col()
                        .gap(px(2.))
                        .child(
                            div()
                                .text_size(px(12.))
                                .font_weight(FontWeight::MEDIUM)
                                .text_color(theme.gray_12)
                                .child(tr::screenshot_editor::mask::invert()),
                        )
                        .child(
                            div()
                                .text_size(px(10.))
                                .text_color(theme.gray_9)
                                .child(tr::screenshot_editor::mask::invert_hint()),
                        ),
                )
                .child(
                    ui::Toggle::plain(&theme, "screenshot-mask-invert-toggle", options.invert)
                        .on_click(cx.listener(|this, _, window, cx| {
                            cx.stop_propagation();
                            this.edit_selected_mask(
                                |annotation| {
                                    let options = annotation
                                        .mask_options
                                        .get_or_insert_with(Default::default);
                                    options.invert = !options.invert;
                                    true
                                },
                                window,
                                cx,
                            );
                        })),
                ),
        )
        .into_any_element()
    }
}

fn mix_rgb(base: u32, tint: u32, amount: f32) -> u32 {
    let channel = |shift: u32| {
        let from = ((base >> shift) & 0xFF) as f32;
        let to = ((tint >> shift) & 0xFF) as f32;
        ((from + (to - from) * amount).round() as u32) << shift
    };
    channel(16) | channel(8) | channel(0)
}

fn mask_pill(
    theme: &Theme,
    id: String,
    label: Option<gpui::SharedString>,
    icon: Option<&'static str>,
    active: bool,
    on_click: impl Fn(&gpui::ClickEvent, &mut Window, &mut App) + 'static,
) -> AnyElement {
    let theme = *theme;
    let text = if active {
        gpui::white()
    } else {
        theme.gray_11.into()
    };
    div()
        .id(gpui::SharedString::from(id))
        .flex()
        .flex_row()
        .items_center()
        .justify_center()
        .gap(px(5.))
        .h(px(24.))
        .min_w(px(24.))
        .px(px(if label.is_some() { 10. } else { 5. }))
        .rounded(px(6.))
        .cursor_pointer()
        .text_size(px(12.))
        .font_weight(FontWeight::MEDIUM)
        .text_color(text)
        .when(active, |this| this.bg(theme.blue_9))
        .when(!active, |this| {
            this.bg(theme.gray_3).hover(|style| style.bg(theme.gray_4))
        })
        .when_some(icon, |this, icon| {
            this.child(svg().path(icon).size(px(14.)).text_color(text))
        })
        .when_some(label, |this, label| this.child(label))
        .on_click(on_click)
        .into_any_element()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mask() -> Annotation {
        Annotation {
            id: "m".to_string(),
            annotation_type: AnnotationType::Mask,
            x: 10.,
            y: 10.,
            width: 40.,
            height: 20.,
            stroke_color: TRANSPARENT.to_string(),
            stroke_width: 0.,
            fill_color: TRANSPARENT.to_string(),
            opacity: 1.,
            rotation: 0.,
            text: None,
            mask_type: Some(MaskType::Pixelate),
            mask_level: Some(MASK_DEFAULT_LEVEL),
            mask_options: None,
            points: None,
        }
    }

    #[test]
    fn every_preset_round_trips_through_its_own_matcher() {
        for preset in MaskPreset::ALL {
            let mut annotation = mask();
            assert!(preset.apply(&mut annotation));
            assert_eq!(MaskPreset::of(&annotation), Some(preset), "{preset:?}");
            assert!(!preset.apply(&mut annotation));
        }
    }

    #[test]
    fn presets_are_distinct() {
        for (index, preset) in MaskPreset::ALL.into_iter().enumerate() {
            let mut annotation = mask();
            preset.apply(&mut annotation);
            for other in &MaskPreset::ALL[index + 1..] {
                assert!(!other.matches(&annotation), "{preset:?} vs {other:?}");
            }
        }
    }

    #[test]
    fn solid_keeps_a_hiding_mask_type_for_older_builds() {
        let mut annotation = mask();
        assert!(MaskStyleChoice::Solid.apply(&mut annotation));
        assert_eq!(MaskStyleChoice::of(&annotation), MaskStyleChoice::Solid);
        assert!(annotation.mask_type.is_some());
        assert!(MaskStyleChoice::Blur.apply(&mut annotation));
        assert_eq!(annotation.mask_type, Some(MaskType::Blur));
        assert!(!annotation.mask_options.unwrap().solid);
    }

    #[test]
    fn shape_choices_set_radius_and_ellipse() {
        let mut options = MaskOptions::default();
        assert_eq!(MaskShapeChoice::of(&options), MaskShapeChoice::Square);
        assert!(MaskShapeChoice::Rounded.apply(&mut options));
        assert_eq!(options.corner_radius, ROUNDED_DEFAULT_RADIUS);
        assert!(MaskShapeChoice::Ellipse.apply(&mut options));
        assert_eq!(MaskShapeChoice::of(&options), MaskShapeChoice::Ellipse);
        assert!(MaskShapeChoice::Square.apply(&mut options));
        assert_eq!(options.corner_radius, 0.);
        assert_eq!(options.shape, MaskShape::Rectangle);
    }

    #[test]
    fn style_maps_options_and_swaps_colour_for_bgra() {
        let mut annotation = mask();
        annotation.opacity = 0.5;
        annotation.mask_options = Some(MaskOptions {
            shape: MaskShape::Ellipse,
            invert: true,
            color: "#102030".to_string(),
            tint: 0.25,
            ..MaskOptions::default()
        });
        let rgba = mask_style(&annotation, false);
        let bgra = mask_style(&annotation, true);
        assert_eq!(rgba.effect, MaskEffect::Pixelate);
        assert!(rgba.ellipse && rgba.invert);
        assert_eq!(rgba.color, [0x10, 0x20, 0x30]);
        assert_eq!(bgra.color, [0x30, 0x20, 0x10]);
        assert_eq!(rgba.tint(), 0.25);
        assert_eq!(rgba.opacity(), 0.5);
    }

    #[test]
    fn a_legacy_mask_maps_to_the_plain_kernel_style() {
        let annotation = mask();
        assert_eq!(
            mask_style(&annotation, true),
            MaskStyle::plain(true, MASK_DEFAULT_LEVEL)
        );
    }

    #[test]
    fn an_inverted_mask_covers_the_content_with_itself_as_the_hole() {
        let mut annotation = mask();
        let content = [0., 0., 100., 80.];
        assert_eq!(
            mask_regions(&annotation, content, content, (100, 80)),
            Some(((10, 10, 40, 20), (10, 10, 40, 20)))
        );
        annotation.mask_options = Some(MaskOptions {
            invert: true,
            ..MaskOptions::default()
        });
        assert_eq!(
            mask_regions(&annotation, content, content, (100, 80)),
            Some(((0, 0, 100, 80), (10, 10, 40, 20)))
        );
        let clip = [0., 0., 120., 90.];
        let inset = [5., 5., 90., 70.];
        assert_eq!(
            mask_regions(&annotation, clip, inset, (120, 90)),
            Some(((5, 5, 90, 70), (10, 10, 40, 20)))
        );
    }
}
