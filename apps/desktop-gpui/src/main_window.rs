//! The main recording window.
//!
//! Every metric here is transcribed from the Tauri implementation
//! (`apps/desktop/src/routes/(window-chrome)/new-main/index.tsx` and its
//! siblings) so the two windows are pixel-comparable. Tailwind classes are
//! quoted next to the values they turn into, because `pl-3` and `gap-2.5` are
//! considerably easier to check against the original than `12.` and `10.`.

use gpui::{
    Context, FontWeight, Hsla, InteractiveElement, IntoElement, ParentElement, Render,
    SharedString, StatefulInteractiveElement, Styled, Window, div, prelude::FluentBuilder, px, rgb,
    svg,
};

use crate::{
    MAIN_WINDOW_HEIGHT, MAIN_WINDOW_WIDTH,
    devices::{CameraOption, DeviceSnapshot, MicrophoneOption},
    theme::{Appearance, Theme},
};

/// `MAIN_WINDOW_SIZE.expanded` in index.tsx.
const EXPANDED_WIDTH: f32 = 600.;
const EXPANDED_HEIGHT: f32 = 660.;

/// `h-9` on `.cap-window-header`.
const HEADER_HEIGHT: f32 = 36.;
/// `h-[42px]` in deviceRowStyles.ts.
const DEVICE_ROW_HEIGHT: f32 = 42.;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    Instant,
    Studio,
    Screenshot,
}

impl Mode {
    fn icon(self) -> &'static str {
        match self {
            Self::Instant => "icons/instant.svg",
            Self::Studio => "icons/film-cut.svg",
            Self::Screenshot => "icons/screenshot.svg",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TargetType {
    Display,
    Window,
    Area,
    CameraOnly,
}

impl TargetType {
    fn label(self) -> &'static str {
        match self {
            Self::Display => "Display",
            Self::Window => "Window",
            Self::Area => "Area",
            Self::CameraOnly => "Camera Only",
        }
    }

    /// Shown only when expanded.
    fn description(self) -> &'static str {
        match self {
            Self::Display => "Entire screen",
            Self::Window => "One app",
            Self::Area => "Custom region",
            Self::CameraOnly => "No screen",
        }
    }

    fn icon(self) -> &'static str {
        match self {
            Self::Display => "icons/screen.svg",
            Self::Window => "icons/window.svg",
            Self::Area => "icons/area.svg",
            Self::CameraOnly => "icons/camera.svg",
        }
    }
}

/// Which device picker has taken over the window body, if any.
///
/// Clicking a device row does not open a popup in the Tauri app either: it
/// swaps the whole body for a full-height panel and offers a Back button.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DeviceMenu {
    Camera,
    Microphone,
}

impl DeviceMenu {
    fn title(self) -> &'static str {
        match self {
            Self::Camera => "Camera",
            Self::Microphone => "Microphone",
        }
    }

    fn none_label(self) -> &'static str {
        match self {
            Self::Camera => "No Camera",
            Self::Microphone => "No Microphone",
        }
    }

    fn icon(self) -> &'static str {
        match self {
            Self::Camera => "icons/camera.svg",
            Self::Microphone => "icons/microphone.svg",
        }
    }
}

pub struct MainWindow {
    theme: Theme,
    expanded: bool,
    mode: Mode,
    target: Option<TargetType>,
    devices: DeviceSnapshot,
    camera: Option<CameraOption>,
    microphone: Option<MicrophoneOption>,
    system_audio: bool,
    active_menu: Option<DeviceMenu>,
    /// True until the background enumeration has reported back, so the panel can
    /// say "Loading..." rather than "No cameras found".
    enumerating: bool,
}

impl MainWindow {
    pub fn new(window: &mut Window, cx: &mut Context<Self>) -> Self {
        let theme = Theme::new(Appearance::from_window(window.appearance()));

        // Enumeration hits AVFoundation and the window server, so it must not
        // run on the main thread -- doing it inline here costs ~180ms of a
        // blank window on this machine, and more on a machine with more
        // capture devices.
        cx.spawn(async move |this, cx| {
            let snapshot = cx
                .background_executor()
                .spawn(async { DeviceSnapshot::enumerate() })
                .await;

            this.update(cx, |this, cx| {
                tracing::info!(
                    cameras = snapshot.cameras.len(),
                    microphones = snapshot.microphones.len(),
                    displays = snapshot.displays.len(),
                    windows = snapshot.windows.len(),
                    "enumerated capture devices"
                );
                this.devices = snapshot;
                this.enumerating = false;
                cx.notify();
            })
            .ok();
        })
        .detach();

        let this = Self {
            theme,
            expanded: false,
            mode: Mode::Instant,
            target: None,
            devices: DeviceSnapshot::default(),
            camera: None,
            microphone: None,
            system_audio: false,
            active_menu: None,
            enumerating: true,
        };

        // The Tauri app restores the persisted expanded state on mount and
        // resizes without animating. There is nothing persisted yet, but the
        // window size still has to agree with the state the view starts in.
        this.apply_window_size(window);

        this
    }

    fn toggle_expanded(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.expanded = !self.expanded;
        tracing::info!(expanded = self.expanded, "toggling main window size");
        self.apply_window_size(window);
        cx.notify();
    }

    /// Resize the window to match `expanded`.
    ///
    /// The Tauri version animates this over 180ms with an ease-out cubic and
    /// re-clamps the window into the monitor work area with 12px of padding.
    /// This is the un-animated version of the same size change; the animation
    /// is deliberately left for a later pass rather than faked with a timer
    /// that would fight gpui's own frame pacing.
    fn apply_window_size(&self, window: &mut Window) {
        window.resize(if self.expanded {
            gpui::size(px(EXPANDED_WIDTH), px(EXPANDED_HEIGHT))
        } else {
            gpui::size(px(MAIN_WINDOW_WIDTH), px(MAIN_WINDOW_HEIGHT))
        });
    }

    fn sync_appearance(&mut self, window: &Window) {
        let appearance = Appearance::from_window(window.appearance());
        if appearance != self.theme.appearance {
            self.theme = Theme::new(appearance);
        }
    }
}

impl Render for MainWindow {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        self.sync_appearance(window);
        let theme = self.theme;

        div()
            .size_full()
            .flex()
            .flex_col()
            .overflow_hidden()
            // `rounded-[16px]` on `.cap-window-shell`, matched natively by
            // `apply_squircle_corners(&window, 16.0)` in the Tauri app.
            .rounded(px(16.))
            .bg(theme.gray_1)
            .font_family("Geist")
            .text_color(theme.text_primary)
            .child(self.render_header(window, cx))
            .child(self.render_body(cx))
    }
}

impl MainWindow {
    fn render_header(&self, window: &Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = self.theme;
        let focused = window.is_window_active();

        div()
            .flex()
            .flex_row()
            .items_center()
            .w_full()
            .h(px(HEADER_HEIGHT))
            .flex_shrink_0()
            .bg(theme.gray_2)
            // `divide-y divide-gray-5` between header and body.
            .border_b_1()
            .border_color(theme.gray_5)
            .child(self.render_traffic_lights(focused, cx))
            .child(self.render_header_actions(cx))
    }

    /// `CaptionControlsMacOS`: 14px circles (`size-3.5`), 10px apart
    /// (`gap-2.5`), 12px from the left edge (`ml-3`). Minimize is not drawn --
    /// the main window passes `showMinimize={false}` -- and zoom is bound to
    /// expand/collapse rather than a real window zoom.
    fn render_traffic_lights(&self, focused: bool, cx: &mut Context<Self>) -> impl IntoElement {
        let light = |color: u32, id: &'static str| {
            div()
                .id(id)
                .size(px(14.))
                .rounded_full()
                .bg(if focused {
                    rgb(color)
                } else {
                    rgb(Theme::TRAFFIC_INACTIVE)
                })
                .cursor_default()
        };

        div()
            .flex()
            .flex_row()
            .items_center()
            .gap(px(10.))
            .h_full()
            .ml(px(12.))
            .flex_shrink_0()
            .child(
                light(Theme::TRAFFIC_CLOSE, "traffic-close").on_click(cx.listener(
                    |_, _, _window, cx| {
                        cx.quit();
                    },
                )),
            )
            .child(
                light(Theme::TRAFFIC_ZOOM, "traffic-zoom").on_click(cx.listener(
                    |this, _, window, cx| {
                        this.toggle_expanded(window, cx);
                    },
                )),
            )
    }

    /// The teleported header content: a help button, a drag spacer, then the
    /// right-hand cluster. 20px hit targets (`size-5`) 4px apart (`gap-1`),
    /// 8px from the window edges (`mx-2`).
    fn render_header_actions(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = self.theme;
        let expanded = self.expanded;

        let icon_button = |id: &'static str, path: &'static str, size: f32| {
            div()
                .id(SharedString::from(id))
                .flex()
                .items_center()
                .justify_center()
                .size(px(20.))
                .flex_shrink_0()
                .child(svg().path(path).size(px(size)).text_color(theme.gray_11))
                .hover(|style| style.text_color(theme.gray_12))
        };

        div()
            .flex()
            .flex_1()
            .items_center()
            .gap(px(4.))
            .mx(px(8.))
            .min_w_0()
            .child(icon_button("help", "icons/support.svg", 16.))
            // The drag handle, and *only* this. The Tauri header puts
            // `data-tauri-drag-region` on the header and this spacer but not on
            // the buttons; putting the handler on the header root instead makes
            // every mouse-down in the header start a window drag, which eats
            // the button clicks before they are delivered.
            .child(
                div()
                    .id("drag-region")
                    .flex_1()
                    .min_w_0()
                    .h_full()
                    .on_mouse_down(gpui::MouseButton::Left, |_, window, _| {
                        window.start_window_move();
                    }),
            )
            .child(
                div()
                    .flex()
                    .flex_row()
                    .items_center()
                    .gap(px(4.))
                    .flex_shrink_0()
                    .child(
                        icon_button(
                            "expand",
                            if expanded {
                                "icons/minimize.svg"
                            } else {
                                "icons/enlarge.svg"
                            },
                            14.,
                        )
                        .on_click(cx.listener(|this, _, window, cx| {
                            this.toggle_expanded(window, cx);
                        })),
                    )
                    .child(icon_button("settings", "icons/settings.svg", 16.))
                    .child(icon_button("screenshots", "icons/image.svg", 16.))
                    .child(icon_button("recordings", "icons/play-circle.svg", 16.))
                    .child(icon_button("teleprompter", "icons/scan-text.svg", 16.))
                    .child(icon_button("changelog", "icons/bell.svg", 16.)),
            )
    }

    /// Page root: `px-[13px] gap-2 pb-[8px]`.
    fn render_body(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let root = div()
            .flex()
            .flex_col()
            .flex_1()
            .min_h_0()
            .px(px(13.))
            .pb(px(8.))
            .gap(px(8.));

        // The logo/mode row is hidden while a picker is open -- the panel takes
        // the full body, exactly as `!activeMenu() && ...` does in index.tsx.
        match self.active_menu {
            Some(menu) => root.child(self.render_device_panel(menu, cx)),
            None => root.child(self.render_logo_row(cx)).child(
                div()
                    .flex()
                    .flex_col()
                    .flex_1()
                    .min_h_0()
                    .gap(px(8.))
                    .child(self.render_targets(cx))
                    .child(self.render_base_controls(cx)),
            ),
        }
    }

    /// `TargetMenuPanel`: a Back button above a scrolling device list.
    ///
    /// The search field the Tauri panel puts next to Back is not here yet --
    /// it needs real text input, which is its own piece of gpui plumbing.
    fn render_device_panel(&self, menu: DeviceMenu, cx: &mut Context<Self>) -> gpui::Div {
        let theme = self.theme;

        div()
            .flex()
            .flex_col()
            .flex_1()
            .min_h_0()
            .child(
                div()
                    .flex()
                    .flex_row()
                    .items_center()
                    .gap(px(12.))
                    .mt(px(12.))
                    .h(px(36.))
                    .flex_shrink_0()
                    .child(
                        div()
                            .id("device-panel-back")
                            .flex()
                            .flex_row()
                            .items_center()
                            .gap(px(4.))
                            .h(px(36.))
                            .px(px(8.))
                            .flex_shrink_0()
                            .rounded(px(6.))
                            .text_size(px(12.))
                            .text_color(theme.gray_11)
                            .child(
                                svg()
                                    .path("icons/move-left.svg")
                                    .size(px(12.))
                                    .text_color(theme.gray_11),
                            )
                            .child(
                                div()
                                    .font_weight(FontWeight::MEDIUM)
                                    .text_color(theme.gray_12)
                                    .child("Back"),
                            )
                            .hover(|style| style.bg(theme.gray_4))
                            .on_click(cx.listener(|this, _, _window, cx| {
                                this.active_menu = None;
                                cx.notify();
                            })),
                    )
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .text_size(px(12.))
                            .font_weight(FontWeight::SEMIBOLD)
                            .text_color(theme.gray_12)
                            .child(menu.title()),
                    ),
            )
            .child(
                div()
                    .id("device-panel-list")
                    .flex()
                    .flex_col()
                    .flex_1()
                    .min_h_0()
                    .pt(px(16.))
                    .px(px(8.))
                    .gap(px(4.))
                    .overflow_y_scroll()
                    .children(self.render_device_list(menu, cx)),
            )
    }

    fn render_device_list(
        &self,
        menu: DeviceMenu,
        cx: &mut Context<Self>,
    ) -> Vec<gpui::AnyElement> {
        let theme = self.theme;

        if self.enumerating {
            return vec![
                div()
                    .py(px(24.))
                    .w_full()
                    .text_size(px(14.))
                    .text_color(theme.gray_11)
                    .child("Loading...")
                    .into_any_element(),
            ];
        }

        // Index 0 is always the "none" row, matching `DeviceListPanel`.
        let mut rows = vec![
            self.render_device_list_row(
                SharedString::from(format!("{}-none", menu.title())),
                "icons/circle-x.svg",
                menu.none_label().to_string(),
                None,
                match menu {
                    DeviceMenu::Camera => self.camera.is_none(),
                    DeviceMenu::Microphone => self.microphone.is_none(),
                },
                cx.listener(move |this, _, _window, cx| {
                    match menu {
                        DeviceMenu::Camera => this.camera = None,
                        DeviceMenu::Microphone => this.microphone = None,
                    }
                    this.active_menu = None;
                    cx.notify();
                }),
            )
            .into_any_element(),
        ];

        match menu {
            DeviceMenu::Camera => {
                for camera in &self.devices.cameras {
                    let selected = self
                        .camera
                        .as_ref()
                        .is_some_and(|selected| selected.device_id == camera.device_id);
                    let chosen = camera.clone();

                    rows.push(
                        self.render_device_list_row(
                            SharedString::from(format!("camera-{}", camera.device_id)),
                            menu.icon(),
                            camera.label.clone(),
                            camera.best_format.map(|format| format.describe()),
                            selected,
                            cx.listener(move |this, _, _window, cx| {
                                this.camera = Some(chosen.clone());
                                this.active_menu = None;
                                cx.notify();
                            }),
                        )
                        .into_any_element(),
                    );
                }
            }
            DeviceMenu::Microphone => {
                for mic in &self.devices.microphones {
                    let selected = self
                        .microphone
                        .as_ref()
                        .is_some_and(|selected| selected.name == mic.name);
                    let chosen = mic.clone();

                    rows.push(
                        self.render_device_list_row(
                            SharedString::from(format!("mic-{}", mic.name)),
                            menu.icon(),
                            mic.name.clone(),
                            mic.describe(),
                            selected,
                            cx.listener(move |this, _, _window, cx| {
                                this.microphone = Some(chosen.clone());
                                this.active_menu = None;
                                cx.notify();
                            }),
                        )
                        .into_any_element(),
                    );
                }
            }
        }

        if rows.len() == 1 {
            rows.push(
                div()
                    .py(px(16.))
                    .w_full()
                    .text_size(px(14.))
                    .text_color(theme.gray_11)
                    .child(match menu {
                        DeviceMenu::Camera => "No cameras found",
                        DeviceMenu::Microphone => "No microphones found",
                    })
                    .into_any_element(),
            );
        }

        rows
    }

    /// `CameraListItem` / `MicrophoneListItem`: `px-3 py-2.5`, `rounded-lg`,
    /// 14px label over an optional 11px detail line indented `pl-7`.
    ///
    /// Selection is `bg-blue-500` with white text -- note that is the custom
    /// `--blue-500`, not `blue-9`; the two are different colours.
    fn render_device_list_row(
        &self,
        id: SharedString,
        icon: &'static str,
        label: String,
        detail: Option<String>,
        selected: bool,
        on_click: impl Fn(&gpui::ClickEvent, &mut Window, &mut gpui::App) + 'static,
    ) -> gpui::Stateful<gpui::Div> {
        let theme = self.theme;

        let foreground = if selected {
            gpui::white()
        } else {
            Hsla::from(theme.gray_12)
        };
        let detail_color = if selected {
            let mut color = gpui::white();
            color.a = 0.7;
            color
        } else {
            Hsla::from(theme.gray_10)
        };

        div()
            .id(id)
            .flex()
            .flex_col()
            .gap(px(2.))
            .px(px(12.))
            .py(px(10.))
            .w_full()
            .rounded(px(8.))
            .text_size(px(14.))
            .text_color(foreground)
            .when(selected, |this| this.bg(theme.blue_500))
            .when(!selected, |this| this.hover(|style| style.bg(theme.gray_4)))
            .child(
                div()
                    .flex()
                    .flex_row()
                    .items_center()
                    .gap(px(12.))
                    .w_full()
                    .child(
                        svg()
                            .path(icon)
                            .size(px(16.))
                            .flex_shrink_0()
                            .text_color(foreground),
                    )
                    .child(div().flex_1().min_w_0().truncate().child(label))
                    .when(selected, |this| {
                        this.child(
                            svg()
                                .path("icons/check.svg")
                                .size(px(16.))
                                .flex_shrink_0()
                                .text_color(foreground),
                        )
                    }),
            )
            .children(detail.map(|detail| {
                div()
                    // `pl-7` = 16px icon + 12px gap.
                    .pl(px(28.))
                    .text_size(px(11.))
                    .text_color(detail_color)
                    .truncate()
                    .child(detail)
            }))
            .on_click(on_click)
    }

    /// `mt-[16px] mb-[6px]`, logo `w-[92px]`, Mode pill on the right.
    fn render_logo_row(&self, cx: &mut Context<Self>) -> impl IntoElement {
        div()
            .flex()
            .flex_row()
            .items_center()
            .justify_between()
            .mt(px(16.))
            .mb(px(6.))
            .flex_shrink_0()
            .child(self.render_logo())
            .child(self.render_mode_pill(cx))
    }

    /// `*:w-[92px]` on the logo link, against a 103x40 viewBox, so the whole
    /// lockup is 92x35.7 and everything below is that scale factor applied to
    /// the SVG's own coordinates.
    ///
    /// The mark is rebuilt out of divs rather than drawn from `logo-full.svg`,
    /// because gpui keeps only an SVG's alpha and tints it with one colour --
    /// the mark's three concentric circles would collapse into a solid block.
    /// Only the wordmark, which really is single-colour, goes through `svg()`,
    /// which also means it picks up `gray_12` and so swaps between the app's
    /// light and dark logo variants for free.
    fn render_logo(&self) -> impl IntoElement {
        const SCALE: f32 = 92. / 103.;

        let theme = self.theme;
        let ring = |diameter: f32, color: u32| {
            div()
                .absolute()
                .size(px(diameter * SCALE))
                .rounded_full()
                .bg(rgb(color))
        };

        div()
            .flex()
            .flex_row()
            .items_center()
            // The mark ends at x=40 and the wordmark starts at x=49; re-framing
            // the wordmark's viewBox to start at 49 dropped that gap, so it is
            // put back here.
            .gap(px(9. * SCALE))
            .child(
                div()
                    .relative()
                    .flex()
                    .items_center()
                    .justify_center()
                    .size(px(40. * SCALE))
                    .flex_shrink_0()
                    .rounded(px(7.75 * SCALE))
                    .bg(gpui::white())
                    // Without this the white tile is invisible against gray-1
                    // in light mode.
                    .border_1()
                    .border_color(rgb(0xe7eaf0))
                    .child(ring(32., 0x4785ff))
                    .child(ring(26., 0xadc9ff))
                    .child(ring(20., 0xffffff)),
            )
            .child(
                svg()
                    .path("icons/logo-wordmark.svg")
                    // 54x40 of the original viewBox.
                    .w(px(54. * SCALE))
                    .h(px(40. * SCALE))
                    .text_color(theme.gray_12),
            )
    }

    /// `Mode.tsx`: `p-1.5 gap-2 rounded-full border border-gray-5 bg-gray-3`,
    /// 28px round buttons (`size-7`). Selected gets `bg-gray-7` plus a 2px
    /// `blue-500` ring offset 1px against `gray-1`.
    fn render_mode_pill(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = self.theme;
        let selected_mode = self.mode;

        let button = |mode: Mode, id: &'static str| {
            let selected = mode == selected_mode;
            div()
                .id(SharedString::from(id))
                .flex()
                .items_center()
                .justify_center()
                .size(px(28.))
                .rounded_full()
                .bg(if selected { theme.gray_7 } else { theme.gray_3 })
                .when(selected, |this| {
                    // `ring-2 ring-blue-500 ring-offset-1 ring-offset-gray-1`.
                    this.border_2()
                        .border_color(theme.blue_500)
                        .shadow(vec![gpui::BoxShadow {
                            color: Hsla::from(theme.gray_1),
                            offset: gpui::point(px(0.), px(0.)),
                            blur_radius: px(0.),
                            spread_radius: px(1.),
                            inset: false,
                        }])
                })
                .child(
                    svg()
                        .path(mode.icon())
                        .size(px(if matches!(mode, Mode::Instant) {
                            16.
                        } else {
                            14.4
                        }))
                        .text_color(theme.gray_12),
                )
                .hover(|style| style.bg(theme.gray_7))
                .on_click(cx.listener(move |this, _, _window, cx| {
                    this.mode = mode;
                    cx.notify();
                }))
        };

        div()
            .flex()
            .flex_row()
            .items_center()
            .gap(px(8.))
            .p(px(6.))
            .rounded_full()
            .border_1()
            .border_color(theme.gray_5)
            .bg(theme.gray_3)
            .child(button(Mode::Instant, "mode-instant"))
            .child(button(Mode::Studio, "mode-studio"))
            .child(button(Mode::Screenshot, "mode-screenshot"))
    }

    fn render_targets(&self, cx: &mut Context<Self>) -> impl IntoElement {
        div()
            .flex()
            .flex_col()
            .gap(px(8.))
            .w_full()
            .flex_shrink_0()
            .when(self.expanded, |this| {
                this.child(
                    // `px-1 pb-0.5` + `text-xs font-semibold text-gray-12`.
                    div().px(px(4.)).pb(px(2.)).child(
                        div()
                            .text_size(px(12.))
                            .font_weight(FontWeight::SEMIBOLD)
                            .text_color(self.theme.gray_12)
                            .child("Capture"),
                    ),
                )
            })
            .child(
                div()
                    .flex()
                    .flex_row()
                    .gap(px(8.))
                    .items_stretch()
                    .w_full()
                    .child(self.render_split_target(TargetType::Display, cx))
                    .child(self.render_split_target(TargetType::Window, cx)),
            )
            .child(
                div()
                    .flex()
                    .flex_row()
                    .gap(px(8.))
                    .items_stretch()
                    .w_full()
                    .child(self.render_target_tile(TargetType::Area, cx))
                    .child(self.render_target_tile(TargetType::CameraOnly, cx)),
            )
    }

    /// Display and Window are split controls: the tile plus a 28px
    /// (`w-7`) chevron button, sharing one rounded border.
    fn render_split_target(&self, target: TargetType, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = self.theme;
        let selected = self.target == Some(target);

        div()
            .flex()
            .flex_1()
            .overflow_hidden()
            .rounded(px(8.))
            .border_1()
            .border_color(if selected { theme.blue_8 } else { theme.gray_6 })
            .bg(if selected {
                theme.tile_selected_bg()
            } else {
                Hsla::from(theme.gray_2)
            })
            .child(self.target_button_inner(target, true, cx))
            .child(
                div()
                    .id(SharedString::from(format!("{}-dropdown", target.label())))
                    .flex()
                    .w(px(28.))
                    .flex_shrink_0()
                    .items_center()
                    .justify_center()
                    .border_l_1()
                    .border_color(theme.gray_6)
                    .bg(theme.gray_4)
                    .child(
                        svg()
                            .path("icons/chevron-down.svg")
                            .size(px(16.))
                            .text_color(theme.gray_11),
                    )
                    .hover(|style| style.bg(theme.gray_6)),
            )
    }

    /// Area and Camera Only are plain tiles with their own border.
    fn render_target_tile(&self, target: TargetType, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = self.theme;
        let selected = self.target == Some(target);

        div()
            .flex()
            .flex_1()
            .overflow_hidden()
            .rounded(px(8.))
            .border_1()
            .border_color(if selected { theme.blue_8 } else { theme.gray_6 })
            .bg(if selected {
                theme.tile_selected_bg()
            } else {
                Hsla::from(theme.gray_2)
            })
            .child(self.target_button_inner(target, false, cx))
    }

    /// `TargetTypeButton`. Compact stacks the icon over the label
    /// (`flex-col items-center gap-1 py-2 justify-end`); expanded lays them out
    /// horizontally with a description (`min-h-14 flex-row gap-2.5 px-3`).
    fn target_button_inner(
        &self,
        target: TargetType,
        split: bool,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let theme = self.theme;
        let selected = self.target == Some(target);
        let expanded = self.expanded;

        let icon_color = if selected {
            theme.blue_10
        } else {
            theme.gray_10
        };
        let label_color = if selected {
            theme.blue_11
        } else {
            theme.gray_12
        };
        let description_color = icon_color;

        let icon = svg()
            .path(target.icon())
            .size(px(20.))
            .flex_shrink_0()
            .text_color(icon_color);

        let base = div()
            .id(SharedString::from(target.label()))
            .flex()
            .flex_1()
            .py(px(8.))
            // `hover:bg-blue-4` / `dark:hover:bg-blue-4/40` when selected,
            // `hover:bg-gray-4` otherwise.
            .hover(move |style| {
                style.bg(if selected {
                    theme.tile_selected_hover_bg()
                } else {
                    Hsla::from(theme.gray_4)
                })
            })
            .on_click(cx.listener(move |this, _, _window, cx| {
                this.target = if this.target == Some(target) {
                    None
                } else {
                    Some(target)
                };
                cx.notify();
            }));

        if expanded {
            base.flex_row()
                .items_center()
                .justify_start()
                .gap(px(10.))
                .min_h(px(56.))
                // `pl-3` when expanded for the split controls, `px-3` otherwise.
                .px(px(12.))
                .child(icon)
                .child(
                    div()
                        .flex()
                        .flex_col()
                        .min_w_0()
                        .child(
                            div()
                                .text_size(px(12.))
                                .font_weight(FontWeight::MEDIUM)
                                .text_color(label_color)
                                .child(target.label()),
                        )
                        .child(
                            div()
                                .text_size(px(10.))
                                .text_color(description_color)
                                .child(target.description()),
                        ),
                )
        } else {
            base.flex_col()
                .items_center()
                .justify_end()
                .gap(px(4.))
                // `pl-5` on the split controls when compact, to keep the icon
                // optically centred against the chevron on the right.
                .when(split, |this| this.pl(px(20.)))
                .child(icon)
                .child(
                    div()
                        .text_size(px(12.))
                        .text_color(label_color)
                        .child(target.label()),
                )
        }
    }

    /// `BaseControls`: camera, microphone, system audio.
    fn render_base_controls(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let gap = if self.expanded { 10. } else { 8. };

        div()
            .flex()
            .flex_col()
            .gap(px(gap))
            .w_full()
            .child(
                self.labelled(
                    "Camera",
                    self.render_device_row(
                        "camera-row",
                        "icons/camera.svg",
                        self.camera
                            .as_ref()
                            .map(|camera| camera.label.clone())
                            .unwrap_or_else(|| "No Camera".into()),
                        if self.camera.is_some() {
                            PillState::On
                        } else {
                            PillState::Off
                        },
                    )
                    .on_click(cx.listener(|this, _, _window, cx| {
                        this.active_menu = Some(DeviceMenu::Camera);
                        cx.notify();
                    })),
                ),
            )
            .child(
                self.labelled(
                    "Microphone",
                    self.render_device_row(
                        "microphone-row",
                        "icons/microphone.svg",
                        self.microphone
                            .as_ref()
                            .map(|mic| mic.name.clone())
                            .unwrap_or_else(|| "No Microphone".into()),
                        if self.microphone.is_some() {
                            PillState::On
                        } else {
                            PillState::Off
                        },
                    )
                    .on_click(cx.listener(|this, _, _window, cx| {
                        this.active_menu = Some(DeviceMenu::Microphone);
                        cx.notify();
                    })),
                ),
            )
            .child(
                self.labelled(
                    "System audio",
                    self.render_device_row(
                        "system-audio-row",
                        "icons/screen.svg",
                        if self.system_audio {
                            "Record System Audio".into()
                        } else {
                            "No System Audio".into()
                        },
                        if self.system_audio {
                            PillState::On
                        } else {
                            PillState::Off
                        },
                    )
                    // System audio has no device to choose, so the row is a
                    // plain toggle rather than a picker.
                    .on_click(cx.listener(|this, _, _window, cx| {
                        this.system_audio = !this.system_audio;
                        cx.notify();
                    })),
                ),
            )
    }

    /// `ExpandedControlLabel`: `mb-1 px-1`, `text-xs font-semibold text-gray-12`.
    /// Only rendered when expanded.
    fn labelled(&self, title: &'static str, row: impl IntoElement) -> impl IntoElement {
        let theme = self.theme;
        let expanded = self.expanded;

        div()
            .flex()
            .flex_col()
            .when(expanded, |this| {
                this.child(
                    div().mb(px(4.)).px(px(4.)).child(
                        div()
                            .text_size(px(12.))
                            .font_weight(FontWeight::SEMIBOLD)
                            .text_color(theme.gray_12)
                            .child(title),
                    ),
                )
            })
            .child(row)
    }

    /// `DEVICE_ROW_CLASS`: 42px tall, `rounded-lg`, `border-gray-6`, `bg-gray-2`,
    /// `pl-3 pr-1.5 gap-2.5`.
    fn render_device_row(
        &self,
        id: &'static str,
        icon: &'static str,
        label: String,
        pill: PillState,
    ) -> gpui::Stateful<gpui::Div> {
        let theme = self.theme;

        div()
            .id(SharedString::from(id))
            .flex()
            .flex_row()
            .items_center()
            .gap(px(10.))
            .pl(px(12.))
            .pr(px(6.))
            .w_full()
            .h(px(DEVICE_ROW_HEIGHT))
            .rounded(px(8.))
            .border_1()
            .border_color(theme.gray_6)
            .bg(theme.gray_2)
            .cursor_default()
            .overflow_hidden()
            .child(
                svg()
                    .path(icon)
                    .size(px(16.))
                    .flex_shrink_0()
                    .text_color(theme.gray_11),
            )
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .text_size(px(14.))
                    .font_weight(FontWeight::MEDIUM)
                    .text_color(theme.gray_12)
                    .truncate()
                    .child(label),
            )
            .child(pill.render(theme))
            .hover(|style| style.bg(theme.gray_4).border_color(theme.gray_8))
    }
}

/// `InfoPill` + `TargetSelectInfoPill`: 24px tall, min 40px wide, `px-2.5`,
/// `rounded-full`, 11px medium text.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PillState {
    On,
    Off,
}

impl PillState {
    fn render(self, theme: Theme) -> impl IntoElement {
        let (bg, fg, text) = match self {
            Self::On => (Hsla::from(theme.blue_9), gpui::white(), "On"),
            Self::Off => (Hsla::from(theme.gray_5), Hsla::from(theme.gray_11), "Off"),
        };

        div()
            .flex()
            .items_center()
            .justify_center()
            .h(px(24.))
            .min_w(px(40.))
            .px(px(10.))
            .flex_shrink_0()
            .rounded_full()
            .bg(bg)
            .text_size(px(11.))
            .font_weight(FontWeight::MEDIUM)
            .text_color(fg)
            .child(text)
    }
}
