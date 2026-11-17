use gpui::App;

use super::*;
use crate::app_store::{CatalogBackground, try_get};

pub(super) const APPS_THEME: usize = BACKGROUND_THEMES.len();

pub(super) struct AppBackgroundTile {
    key: String,
    background: CatalogBackground,
    path: Option<PathBuf>,
    thumbnail: Option<Arc<RenderImage>>,
}

fn rgb(hex: &str) -> Option<Color> {
    hex_to_rgb(hex).map(|[r, g, b, _]| [u16::from(r), u16::from(g), u16::from(b)])
}

fn hsla(hex: &str) -> Hsla {
    hex_to_rgb(hex)
        .map(|rgba| Hsla::from(gpui::rgba(u32::from_be_bytes(rgba))))
        .unwrap_or_else(gpui::transparent_black)
}

pub(super) fn app_background_tiles(cx: &App) -> Vec<AppBackgroundTile> {
    let Some(store) = try_get(cx) else {
        return Vec::new();
    };
    store
        .backgrounds()
        .into_iter()
        .map(|(app_id, background)| {
            let (path, thumbnail) = match &background {
                CatalogBackground::Image { image, .. } => (
                    store.asset_file(image).cloned(),
                    store.thumbnail(&image.sha256),
                ),
                _ => (None, None),
            };
            AppBackgroundTile {
                key: format!("{app_id}-{}", background.id()),
                background,
                path,
                thumbnail,
            }
        })
        .collect()
}

fn is_selected(source: &BackgroundSource, tile: &AppBackgroundTile) -> bool {
    match (&tile.background, source) {
        (CatalogBackground::Image { .. }, BackgroundSource::Wallpaper { path: Some(path) }) => tile
            .path
            .as_ref()
            .is_some_and(|tile_path| tile_path.to_string_lossy() == path.as_str()),
        (
            CatalogBackground::Gradient {
                from, to, angle, ..
            },
            BackgroundSource::Gradient {
                from: current_from,
                to: current_to,
                angle: current_angle,
                ..
            },
        ) => {
            rgb(from).as_ref() == Some(current_from)
                && rgb(to).as_ref() == Some(current_to)
                && angle == current_angle
        }
        (CatalogBackground::Color { color, .. }, BackgroundSource::Color { value, .. }) => {
            rgb(color).as_ref() == Some(value)
        }
        _ => false,
    }
}

impl EditorWindow {
    pub(super) fn render_app_backgrounds(
        &self,
        tiles: Vec<AppBackgroundTile>,
        cell: f32,
        cx: &mut Context<Self>,
    ) -> gpui::Div {
        let theme = self.theme;
        let source = self.project.background.source.clone();
        div()
            .flex()
            .flex_row()
            .flex_wrap()
            .gap(px(WALLPAPER_GAP))
            .children(tiles.into_iter().map(|tile| {
                let selected = is_selected(&source, &tile);
                let name = SharedString::from(tile.background.name().to_string());
                let fill = match &tile.background {
                    CatalogBackground::Image { .. } => div()
                        .size_full()
                        .rounded(px(6.))
                        .overflow_hidden()
                        .bg(Hsla::from(theme.editor.ctl_hover))
                        .children(tile.thumbnail.clone().map(|image| {
                            img(image)
                                .size_full()
                                .object_fit(gpui::ObjectFit::Cover)
                                .rounded(px(6.))
                        })),
                    CatalogBackground::Gradient {
                        from, to, angle, ..
                    } => div().size_full().rounded(px(6.)).bg(linear_gradient(
                        f32::from(*angle),
                        linear_color_stop(hsla(from), 0.),
                        linear_color_stop(hsla(to), 1.),
                    )),
                    CatalogBackground::Color { color, .. } => {
                        div().size_full().rounded(px(6.)).bg(hsla(color))
                    }
                };
                let background = tile.background.clone();
                let path = tile.path.clone();
                div()
                    .id(SharedString::from(format!("app-background-{}", tile.key)))
                    .w(px(cell))
                    .h(px(WALLPAPER_TILE_HEIGHT + 2. * (RING_WIDTH + RING_GAP)))
                    .rounded(px(8.))
                    .cursor_pointer()
                    .selection_ring(self.panel_bg(), theme.editor.accent, selected)
                    .child(fill)
                    .tooltip(move |_window, cx| ui::Tooltip::new(&theme, name.clone()).view(cx))
                    .on_click(cx.listener(move |this, _, window, cx| {
                        this.apply_app_background(&background, path.clone(), window, cx);
                    }))
            }))
    }

    fn apply_app_background(
        &mut self,
        background: &CatalogBackground,
        path: Option<PathBuf>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        match background {
            CatalogBackground::Image { .. } => {
                let Some(path) = path.filter(|path| path.is_file()) else {
                    tracing::warn!("App background is not downloaded yet");
                    return;
                };
                self.set_wallpaper_source(path.to_string_lossy().into_owned(), window, cx);
            }
            CatalogBackground::Gradient {
                from, to, angle, ..
            } => {
                let (Some(from), Some(to)) = (rgb(from), rgb(to)) else {
                    return;
                };
                let angle = *angle;
                self.edit_background(
                    "app-gradient",
                    move |project| {
                        project.background.source = BackgroundSource::Gradient {
                            from,
                            to,
                            angle,
                            noise_intensity: None,
                            noise_scale: None,
                            animated: None,
                            animation_speed: None,
                        };
                        true
                    },
                    window,
                    cx,
                );
                self.ensure_preview(window, cx);
            }
            CatalogBackground::Color { color, .. } => {
                let Some(value) = rgb(color) else {
                    return;
                };
                self.edit_background(
                    "app-color",
                    move |project| {
                        project.background.source = BackgroundSource::Color { value, alpha: 255 };
                        true
                    },
                    window,
                    cx,
                );
                self.ensure_preview(window, cx);
            }
        }
        if self.ensure_background_presentation(false) {
            self.project_changed(window, cx);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tile(background: CatalogBackground, path: Option<&str>) -> AppBackgroundTile {
        AppBackgroundTile {
            key: "app-x".into(),
            background,
            path: path.map(PathBuf::from),
            thumbnail: None,
        }
    }

    #[test]
    fn app_backgrounds_are_selected_by_what_they_apply() {
        let gradient = tile(
            CatalogBackground::Gradient {
                id: "g".into(),
                name: "G".into(),
                from: "#FF7E5F".into(),
                to: "#6A3093".into(),
                angle: 135,
            },
            None,
        );
        let applied = BackgroundSource::Gradient {
            from: [255, 126, 95],
            to: [106, 48, 147],
            angle: 135,
            noise_intensity: None,
            noise_scale: None,
            animated: None,
            animation_speed: None,
        };
        assert!(is_selected(&applied, &gradient));
        let other_angle = BackgroundSource::Gradient {
            from: [255, 126, 95],
            to: [106, 48, 147],
            angle: 90,
            noise_intensity: None,
            noise_scale: None,
            animated: None,
            animation_speed: None,
        };
        assert!(!is_selected(&other_angle, &gradient));

        let image = tile(
            CatalogBackground::Image {
                id: "i".into(),
                name: "I".into(),
                image: crate::app_store::CatalogAsset {
                    url: "/app-store/x/a.jpg".into(),
                    sha256: "a".repeat(64),
                    bytes: 1,
                    width: 1,
                    height: 1,
                },
            },
            Some("/tmp/a.jpg"),
        );
        assert!(is_selected(
            &BackgroundSource::Wallpaper {
                path: Some("/tmp/a.jpg".into())
            },
            &image
        ));
        assert!(!is_selected(
            &BackgroundSource::Wallpaper {
                path: Some("/tmp/b.jpg".into())
            },
            &image
        ));

        let color = tile(
            CatalogBackground::Color {
                id: "c".into(),
                name: "C".into(),
                color: "#111827".into(),
            },
            None,
        );
        assert!(is_selected(
            &BackgroundSource::Color {
                value: [17, 24, 39],
                alpha: 255
            },
            &color
        ));
    }
}
