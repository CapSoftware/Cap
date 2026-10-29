use cap_gpui_kernels::mask_style::{MaskEffect, MaskStyle};
use cap_project::{MaskOptions, MaskShape};

use super::*;

const TINT_ON_COLOR_PICK: f64 = 0.4;
const HIGHLIGHT_DARKNESS: f64 = 0.6;
const HIGHLIGHT_FEATHER: f64 = 24.;
const HIGHLIGHT_COLOR: &str = "#000000";
const SETTINGS_WIDTH: f32 = 240.;
const MODE_SLOT_WIDTH: f32 = 390.;
const VALUE_WIDTH: f32 = 30.;

/// The video editor's two mask kinds (`editor_panels::render_mask_panel`):
/// Sensitive hides what is inside the mask, Highlight dims everything
/// outside it. A highlight is stored as an inverted mask so older builds,
/// which ignore `maskOptions`, still read a valid blur.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum MaskKindChoice {
    Sensitive,
    Highlight,
}

impl MaskKindChoice {
    fn of(annotation: &Annotation) -> Self {
        if annotation
            .mask_options
            .as_ref()
            .is_some_and(|options| options.invert)
        {
            Self::Highlight
        } else {
            Self::Sensitive
        }
    }

    fn label(self) -> &'static str {
        match self {
            Self::Sensitive => tr::editor::panel::mask::sensitive(),
            Self::Highlight => tr::editor::panel::mask::highlight(),
        }
    }

    /// Each kind seeds its own defaults on the switch, the way the video
    /// editor's kind radio does.
    fn apply(self, annotation: &mut Annotation) -> bool {
        if Self::of(annotation) == self {
            return false;
        }
        let options = annotation.mask_options.get_or_insert_with(Default::default);
        match self {
            Self::Sensitive => {
                options.invert = false;
                options.solid = false;
                options.tint = 0.;
                options.feather = 0.;
                annotation.opacity = 1.;
                if annotation.mask_type.is_none() {
                    annotation.mask_type = Some(MaskType::Blur);
                }
            }
            Self::Highlight => {
                options.invert = true;
                options.solid = true;
                options.tint = 0.;
                options.color = HIGHLIGHT_COLOR.to_string();
                if options.feather <= 0. {
                    options.feather = HIGHLIGHT_FEATHER;
                }
                annotation.opacity = HIGHLIGHT_DARKNESS;
                annotation.mask_type = Some(MaskType::Blur);
            }
        }
        true
    }
}

/// `Solid` is stored as a flag next to `maskType` so older builds still hide
/// the region with a blur.
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
    Rectangle,
    Ellipse,
}

impl MaskShapeChoice {
    const ALL: [MaskShapeChoice; 2] = [Self::Rectangle, Self::Ellipse];

    fn of(options: &MaskOptions) -> Self {
        match options.shape {
            MaskShape::Ellipse => Self::Ellipse,
            MaskShape::Rectangle => Self::Rectangle,
        }
    }

    fn id(self) -> &'static str {
        match self {
            Self::Rectangle => "rectangle",
            Self::Ellipse => "ellipse",
        }
    }

    fn icon(self) -> &'static str {
        match self {
            Self::Rectangle => "icons/square.svg",
            Self::Ellipse => "icons/circle.svg",
        }
    }

    fn label(self) -> &'static str {
        match self {
            Self::Rectangle => tr::screenshot_editor::mask::shape_rectangle(),
            Self::Ellipse => tr::screenshot_editor::mask::shape_ellipse(),
        }
    }

    fn apply(self, options: &mut MaskOptions) -> bool {
        let shape = match self {
            Self::Rectangle => MaskShape::Rectangle,
            Self::Ellipse => MaskShape::Ellipse,
        };
        if options.shape == shape {
            return false;
        }
        options.shape = shape;
        true
    }
}

/// A highlight dims the outside with flat black when its blur is off, and
/// with a black tint over the blur when it is on: the kernel has no
/// "no effect" mode, so darkness lives in opacity or tint depending on which.
pub(super) fn highlight_darkness(annotation: &Annotation) -> f64 {
    let options = annotation.mask_options.clone().unwrap_or_default();
    if options.solid {
        annotation.opacity
    } else {
        options.tint
    }
}

pub(super) fn highlight_blur(annotation: &Annotation) -> f64 {
    let options = annotation.mask_options.clone().unwrap_or_default();
    if options.solid {
        0.
    } else {
        annotation.mask_level.unwrap_or(MASK_FALLBACK_LEVEL)
    }
}

pub(super) fn set_highlight_darkness(annotation: &mut Annotation, darkness: f64) -> bool {
    if highlight_darkness(annotation) == darkness {
        return false;
    }
    let options = annotation.mask_options.get_or_insert_with(Default::default);
    if options.solid {
        annotation.opacity = darkness;
    } else {
        options.tint = darkness;
    }
    true
}

pub(super) fn set_highlight_blur(annotation: &mut Annotation, blur: f64) -> bool {
    if highlight_blur(annotation) == blur {
        return false;
    }
    let darkness = highlight_darkness(annotation);
    let options = annotation.mask_options.get_or_insert_with(Default::default);
    options.color = HIGHLIGHT_COLOR.to_string();
    if blur < 1. {
        options.solid = true;
        options.tint = 0.;
        annotation.opacity = darkness;
    } else {
        options.solid = false;
        options.tint = darkness;
        annotation.opacity = 1.;
        annotation.mask_type = Some(MaskType::Blur);
        annotation.mask_level = Some(blur);
    }
    true
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

    pub(super) fn ensure_mask_tint_visible(options: &mut MaskOptions) -> bool {
        if options.solid || options.invert || options.tint > 0. {
            return false;
        }
        options.tint = TINT_ON_COLOR_PICK;
        true
    }

    fn toggle_mask_settings(&mut self, cx: &mut Context<Self>) {
        let Some(id) = self.selected_annotation.clone() else {
            return;
        };
        let open = self.annotation_state.mask_settings.as_deref() == Some(id.as_str());
        self.annotation_state.color_popover = None;
        self.annotation_state.mask_settings = (!open).then_some(id);
        cx.notify();
    }

    pub(super) fn render_mask_controls(
        &self,
        annotation: &Annotation,
        cx: &mut Context<Self>,
    ) -> Vec<AnyElement> {
        let theme = self.theme;
        let kind = MaskKindChoice::of(annotation);
        let options = annotation.mask_options.clone().unwrap_or_default();

        let mut kinds = div().flex().flex_row().gap(px(4.));
        for choice in [MaskKindChoice::Sensitive, MaskKindChoice::Highlight] {
            kinds = kinds.child(mask_pill(
                &theme,
                format!(
                    "screenshot-mask-kind-{}",
                    if choice == MaskKindChoice::Sensitive {
                        "sensitive"
                    } else {
                        "highlight"
                    }
                ),
                Some(choice.label().into()),
                None,
                choice == kind,
                cx.listener(move |this, _, window, cx| {
                    cx.stop_propagation();
                    this.edit_selected_mask(|annotation| choice.apply(annotation), window, cx);
                }),
            ));
        }
        let mut items = vec![kinds.into_any_element(), bar_divider(&theme)];
        let mut mode: Vec<AnyElement> = Vec::new();

        match kind {
            MaskKindChoice::Sensitive => {
                let style = MaskStyleChoice::of(annotation);
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
                            this.edit_selected_mask(
                                |annotation| choice.apply(annotation),
                                window,
                                cx,
                            );
                        }),
                    ));
                }
                mode.push(pills.into_any_element());
                if style == MaskStyleChoice::Solid {
                    mode.push(mask_item(
                        &theme,
                        tr::screenshot_editor::style::color(),
                        None,
                        self.render_color_button(ColorTarget::Mask, cx),
                    ));
                } else {
                    mode.push(mask_item(
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
            }
            MaskKindChoice::Highlight => {
                mode.push(mask_item(
                    &theme,
                    tr::screenshot_editor::mask::darkness(),
                    Some(format!(
                        "{}%",
                        (highlight_darkness(annotation) * 100.).round() as i64
                    )),
                    self.annotation_slider(AnnotationSlider::HighlightDarkness, px(80.), cx)
                        .into_any_element(),
                ));
                mode.push(mask_item(
                    &theme,
                    tr::screenshot_editor::style::blur(),
                    Some(format!("{}", highlight_blur(annotation).round() as i64)),
                    self.annotation_slider(AnnotationSlider::HighlightBlur, px(80.), cx)
                        .into_any_element(),
                ));
            }
        }

        items.push(
            div()
                .min_w(px(MODE_SLOT_WIDTH))
                .flex()
                .flex_row()
                .items_center()
                .gap(px(12.))
                .children(mode)
                .into_any_element(),
        );

        items.push(bar_divider(&theme));
        let shape = MaskShapeChoice::of(&options);
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
        items.push(shapes.into_any_element());

        let cell = self.annotation_state.mask_settings_anchor.clone();
        let open = self.annotation_state.mask_settings.is_some();
        items.push(
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
                    ui::EditorButton::plain(&theme, "screenshot-mask-settings")
                        .left_icon("icons/sliders-horizontal.svg")
                        .icon_size(px(16.))
                        .pressed(open)
                        .tooltip(&theme, tr::screenshot_editor::mask::settings())
                        .on_click(cx.listener(|this, _, _window, cx| {
                            cx.stop_propagation();
                            this.toggle_mask_settings(cx);
                        })),
                )
                .into_any_element(),
        );

        vec![
            div()
                .flex()
                .flex_row()
                .items_center()
                .gap(px(12.))
                .flex_shrink_0()
                .children(items)
                .into_any_element(),
        ]
    }

    /// The header popovers' chrome (`render_popover`): same surface, same
    /// slider rows, anchored under the bar's settings button.
    pub(super) fn render_mask_settings(
        &self,
        window: &Window,
        cx: &mut Context<Self>,
    ) -> Option<AnyElement> {
        let id = self.annotation_state.mask_settings.clone()?;
        if self.selected_annotation.as_deref() != Some(id.as_str()) {
            return None;
        }
        let annotation = self
            .annotation(&id)
            .filter(|annotation| annotation.annotation_type == AnnotationType::Mask)?;
        let theme = self.theme;
        let options = annotation.mask_options.clone().unwrap_or_default();
        let viewport = window.viewport_size();
        let anchor = self.annotation_state.mask_settings_anchor.get();
        let left = anchor
            .map(|bounds| f32::from(bounds.origin.x + bounds.size.width) - SETTINGS_WIDTH)
            .unwrap_or(16.)
            .clamp(
                8.,
                (f32::from(viewport.width) - SETTINGS_WIDTH - 8.).max(8.),
            );
        let top = anchor
            .map(|bounds| f32::from(bounds.origin.y + bounds.size.height) + 8.)
            .unwrap_or(120.);

        let mut body = div()
            .p(px(16.))
            .flex()
            .flex_col()
            .gap(px(16.))
            .child(self.mask_slider_row(
                tr::screenshot_editor::mask::feather(),
                format!("{}px", options.feather.round() as i64),
                AnnotationSlider::MaskFeather,
                None,
                cx,
            ));
        if options.shape == MaskShape::Rectangle {
            body = body.child(self.mask_slider_row(
                tr::screenshot_editor::mask::corner_radius(),
                format!("{}px", options.corner_radius.round() as i64),
                AnnotationSlider::MaskRadius,
                None,
                cx,
            ));
        }
        if !options.invert && !options.solid {
            body = body.child(self.mask_slider_row(
                tr::screenshot_editor::mask::tint(),
                format!("{}%", (options.tint * 100.).round() as i64),
                AnnotationSlider::MaskTint,
                Some(self.render_color_button(ColorTarget::Mask, cx)),
                cx,
            ));
        }

        Some(
            div()
                .absolute()
                .top_0()
                .left_0()
                .size_full()
                .child(
                    div()
                        .id("screenshot-mask-settings-backdrop")
                        .occlude()
                        .absolute()
                        .top_0()
                        .left_0()
                        .size_full()
                        .on_click(cx.listener(|this, _, _window, cx| {
                            this.annotation_state.mask_settings = None;
                            cx.notify();
                        })),
                )
                .child(
                    div()
                        .id("screenshot-mask-settings-popover")
                        .occlude()
                        .absolute()
                        .left(px(left))
                        .top(px(top))
                        .w(px(SETTINGS_WIDTH))
                        .overflow_hidden()
                        .rounded(px(12.))
                        .border_1()
                        .border_color(theme.gray_3)
                        .bg(theme.gray_1)
                        .shadow(vec![gpui::BoxShadow {
                            color: Theme::with_alpha(gpui::rgb(0x000000), 0.18),
                            offset: gpui::point(px(0.), px(10.)),
                            blur_radius: px(30.),
                            spread_radius: px(0.),
                            inset: false,
                        }])
                        .on_click(|_, _window, cx| cx.stop_propagation())
                        .child(body),
                )
                .into_any_element(),
        )
    }

    /// `slider_row` from the header popovers, over an annotation slider.
    fn mask_slider_row(
        &self,
        label: &'static str,
        value: String,
        slider: AnnotationSlider,
        accessory: Option<AnyElement>,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let theme = self.theme;
        div()
            .flex()
            .flex_col()
            .gap(px(8.))
            .child(
                div()
                    .flex()
                    .flex_row()
                    .items_center()
                    .justify_between()
                    .text_size(px(12.))
                    .font_weight(FontWeight::MEDIUM)
                    .text_color(theme.gray_11)
                    .child(label)
                    .child(
                        div()
                            .flex()
                            .flex_row()
                            .items_center()
                            .gap(px(8.))
                            .children(accessory)
                            .child(value),
                    ),
            )
            .child(
                self.annotation_slider(slider, px(SETTINGS_WIDTH - 32.), cx)
                    .into_any_element(),
            )
            .into_any_element()
    }
}

/// `config_item` with a fixed-width readout, so the slider beside it does
/// not slide as the number grows a digit.
fn mask_item(
    theme: &Theme,
    label: &'static str,
    value: Option<String>,
    control: AnyElement,
) -> AnyElement {
    let theme = *theme;
    div()
        .flex()
        .flex_row()
        .items_center()
        .gap(px(8.))
        .flex_shrink_0()
        .child(
            div()
                .flex()
                .flex_row()
                .items_center()
                .gap(px(4.))
                .flex_shrink_0()
                .text_size(px(11.))
                .font_weight(FontWeight::MEDIUM)
                .text_color(theme.gray_10)
                .child(label)
                .children(value.map(|value| {
                    div()
                        .min_w(px(VALUE_WIDTH))
                        .text_color(theme.gray_11)
                        .child(value)
                })),
        )
        .child(control)
        .into_any_element()
}

fn bar_divider(theme: &Theme) -> AnyElement {
    div()
        .w(px(1.))
        .h(px(20.))
        .flex_shrink_0()
        .bg(theme.gray_4)
        .into_any_element()
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
    fn highlight_seeds_a_dim_feathered_inverted_mask_and_sensitive_undoes_it() {
        let mut annotation = mask();
        assert_eq!(MaskKindChoice::of(&annotation), MaskKindChoice::Sensitive);
        assert!(MaskKindChoice::Highlight.apply(&mut annotation));
        let options = annotation.mask_options.clone().unwrap();
        assert!(options.invert && options.solid);
        assert_eq!(options.feather, HIGHLIGHT_FEATHER);
        assert_eq!(highlight_darkness(&annotation), HIGHLIGHT_DARKNESS);
        assert_eq!(highlight_blur(&annotation), 0.);
        assert!(!MaskKindChoice::Highlight.apply(&mut annotation));

        assert!(MaskKindChoice::Sensitive.apply(&mut annotation));
        let options = annotation.mask_options.clone().unwrap();
        assert!(!options.invert && !options.solid);
        assert_eq!(options.feather, 0.);
        assert_eq!(annotation.opacity, 1.);
    }

    #[test]
    fn highlight_blur_moves_darkness_between_opacity_and_tint() {
        let mut annotation = mask();
        MaskKindChoice::Highlight.apply(&mut annotation);
        assert!(set_highlight_darkness(&mut annotation, 0.8));
        assert_eq!(annotation.opacity, 0.8);

        assert!(set_highlight_blur(&mut annotation, 12.));
        let options = annotation.mask_options.clone().unwrap();
        assert!(!options.solid);
        assert_eq!(options.tint, 0.8);
        assert_eq!(annotation.opacity, 1.);
        assert_eq!(annotation.mask_level, Some(12.));
        assert_eq!(highlight_darkness(&annotation), 0.8);
        assert_eq!(highlight_blur(&annotation), 12.);

        assert!(set_highlight_darkness(&mut annotation, 0.3));
        assert_eq!(annotation.mask_options.as_ref().unwrap().tint, 0.3);

        assert!(set_highlight_blur(&mut annotation, 0.));
        assert!(annotation.mask_options.as_ref().unwrap().solid);
        assert_eq!(annotation.opacity, 0.3);
        assert!(!set_highlight_blur(&mut annotation, 0.));
    }

    #[test]
    fn a_colour_pick_reports_the_tint_it_turns_on() {
        let mut options = MaskOptions::default();
        assert!(ScreenshotEditorWindow::ensure_mask_tint_visible(
            &mut options
        ));
        assert_eq!(options.tint, TINT_ON_COLOR_PICK);
        assert!(!ScreenshotEditorWindow::ensure_mask_tint_visible(
            &mut options
        ));
        let mut solid = MaskOptions {
            solid: true,
            ..MaskOptions::default()
        };
        assert!(!ScreenshotEditorWindow::ensure_mask_tint_visible(
            &mut solid
        ));
        assert_eq!(solid.tint, 0.);
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
    fn shape_choices_switch_between_rectangle_and_ellipse() {
        let mut options = MaskOptions::default();
        assert_eq!(MaskShapeChoice::of(&options), MaskShapeChoice::Rectangle);
        assert!(MaskShapeChoice::Ellipse.apply(&mut options));
        assert_eq!(options.shape, MaskShape::Ellipse);
        assert!(!MaskShapeChoice::Ellipse.apply(&mut options));
        assert!(MaskShapeChoice::Rectangle.apply(&mut options));
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
