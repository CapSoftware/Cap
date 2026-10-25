use super::*;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum SafeZonePlatform {
    Reels,
    TikTok,
    Shorts,
}

impl SafeZonePlatform {
    fn label(self) -> &'static str {
        match self {
            Self::Reels => "Instagram Reels",
            Self::TikTok => "TikTok",
            Self::Shorts => "YouTube Shorts",
        }
    }

    fn short_label(self) -> &'static str {
        match self {
            Self::Reels => "Reels",
            Self::TikTok => "TikTok",
            Self::Shorts => "Shorts",
        }
    }

    /// Platform UI over a 1080x1920 portrait video (top, bottom, left, right):
    /// captions, buttons, the account row and the progress bar. Platforms
    /// move these often, so they are guidance rather than exact pixels.
    fn insets(self) -> [f32; 4] {
        match self {
            Self::Reels => [220., 420., 60., 120.],
            Self::TikTok => [160., 480., 60., 140.],
            Self::Shorts => [190., 380., 60., 120.],
        }
    }

    pub(crate) fn next(current: Option<Self>) -> Option<Self> {
        match current {
            None => Some(Self::Reels),
            Some(Self::Reels) => Some(Self::TikTok),
            Some(Self::TikTok) => Some(Self::Shorts),
            Some(Self::Shorts) => None,
        }
    }
}

/// Whether the output is portrait enough for the platform guides to mean
/// anything: 9:16-ish, not 4:5, square or landscape.
pub(crate) fn is_portrait_output(output: [u32; 2]) -> bool {
    let (width, height) = (output[0] as f32, output[1].max(1) as f32);
    width / height <= 0.7
}

pub(crate) fn safe_zone_rect(
    platform: SafeZonePlatform,
    output: [u32; 2],
) -> Option<(f32, f32, f32, f32)> {
    if !is_portrait_output(output) {
        return None;
    }
    let [top, bottom, left, right] = platform.insets();
    Some((
        left / 1080.,
        top / 1920.,
        1. - (left + right) / 1080.,
        1. - (top + bottom) / 1920.,
    ))
}

impl EditorWindow {
    pub(super) fn render_safe_zone_button(
        &self,
        narrow: bool,
        cx: &mut Context<Self>,
    ) -> Option<impl IntoElement> {
        let output = self.frame_layout?.output_size;
        if !is_portrait_output(output) {
            return None;
        }
        let theme = self.theme;
        let label = self
            .safe_zone
            .map_or("Safe zones", SafeZonePlatform::short_label);
        Some(
            ui::EditorButton::plain(&theme, "safe-zones")
                .text(&theme)
                .left_icon("icons/smartphone.svg")
                .when(!narrow, |button| button.label(label))
                .tooltip(&theme, "Safe zones: Off / Reels / TikTok / Shorts")
                .disabled(!self.project_ready())
                .pressed(self.safe_zone.is_some())
                .on_click(cx.listener(|this, _, window, cx| {
                    this.safe_zone = SafeZonePlatform::next(this.safe_zone);
                    cx.notify();
                    window.refresh();
                })),
        )
    }

    pub(super) fn render_safe_zone_overlay(&self) -> Option<gpui::AnyElement> {
        let platform = self.safe_zone?;
        let output = self.frame_layout?.output_size;
        let (x, y, w, h) = safe_zone_rect(platform, output)?;
        let frame_size = (output[0] as f32, output[1] as f32);
        let theme = self.theme;
        let shade = Hsla::from(theme.editor.playhead).opacity(0.22);
        let border = Hsla::from(theme.editor.accent);
        let label_bg = Hsla::from(theme.editor.card).opacity(0.85);
        let label_fg = Hsla::from(theme.editor.text_1);
        let label: SharedString = format!("{} safe zone", platform.label()).into();
        Some(
            gpui::canvas(
                |bounds, _window, _cx| bounds,
                move |_, bounds, window, cx| {
                    let frame = super::preview_frame_bounds(bounds, frame_size);
                    let (fx, fy) = (f32::from(frame.origin.x), f32::from(frame.origin.y));
                    let (fw, fh) = (f32::from(frame.size.width), f32::from(frame.size.height));
                    let (zx, zy, zw, zh) = (fx + x * fw, fy + y * fh, w * fw, h * fh);
                    let rect = |left: f32, top: f32, width: f32, height: f32| gpui::Bounds {
                        origin: gpui::point(px(left), px(top)),
                        size: gpui::size(px(width.max(0.)), px(height.max(0.))),
                    };
                    window.with_content_mask(Some(gpui::ContentMask { bounds: frame }), |window| {
                        for band in [
                            rect(fx, fy, fw, zy - fy),
                            rect(fx, zy + zh, fw, fy + fh - zy - zh),
                            rect(fx, zy, zx - fx, zh),
                            rect(zx + zw, zy, fx + fw - zx - zw, zh),
                        ] {
                            window.paint_quad(gpui::fill(band, shade));
                        }
                        window.paint_quad(gpui::outline(
                            rect(zx, zy, zw, zh),
                            border,
                            gpui::BorderStyle::Solid,
                        ));
                        let font_size = px(10.);
                        let run = gpui::TextRun {
                            len: label.len(),
                            font: window.text_style().font(),
                            color: label_fg,
                            background_color: None,
                            underline: None,
                            strikethrough: None,
                        };
                        let line =
                            window
                                .text_system()
                                .shape_line(label.clone(), font_size, &[run], None);
                        let line_height = line.ascent + line.descent;
                        let chip = rect(
                            zx + 6.,
                            zy + 4.,
                            f32::from(line.width) + 8.,
                            f32::from(line_height) + 2.,
                        );
                        window.paint_quad(gpui::fill(chip, label_bg).corner_radii(px(4.)));
                        let _ = line.paint(
                            gpui::point(chip.origin.x + px(4.), chip.origin.y + px(1.)),
                            line_height,
                            gpui::TextAlign::Left,
                            None,
                            window,
                            cx,
                        );
                    });
                },
            )
            .absolute()
            .inset_0()
            .into_any_element(),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn safe_zones_only_apply_to_portrait_output() {
        assert!(!is_portrait_output([1920, 1080]));
        assert!(!is_portrait_output([1080, 1080]));
        assert!(!is_portrait_output([1080, 1350]));
        assert!(is_portrait_output([1080, 1920]));
        assert!(safe_zone_rect(SafeZonePlatform::Reels, [1920, 1080]).is_none());
        let (x, y, w, h) = safe_zone_rect(SafeZonePlatform::Reels, [1080, 1920]).unwrap();
        assert!((x - 60. / 1080.).abs() < 1e-6);
        assert!((y - 220. / 1920.).abs() < 1e-6);
        assert!((w - (1. - 180. / 1080.)).abs() < 1e-6);
        assert!((h - (1. - 640. / 1920.)).abs() < 1e-6);
    }

    #[test]
    fn the_button_cycles_through_every_platform_and_back_to_off() {
        let mut current = None;
        let mut seen = Vec::new();
        for _ in 0..4 {
            current = SafeZonePlatform::next(current);
            seen.push(current);
        }
        assert_eq!(
            seen,
            vec![
                Some(SafeZonePlatform::Reels),
                Some(SafeZonePlatform::TikTok),
                Some(SafeZonePlatform::Shorts),
                None
            ]
        );
    }
}
