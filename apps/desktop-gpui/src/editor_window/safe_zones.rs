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

/// The safe area as fractions of the frame `(x, y, w, h)`, or `None` when the
/// output isn't portrait.
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
    /// The button only exists for portrait output; on any other aspect there
    /// is nothing for it to draw.
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
        Some(ui::EditorButton::plain(&theme, "safe-zones")
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
            })))
    }

    pub(super) fn render_safe_zone_overlay(&self) -> Option<gpui::AnyElement> {
        let platform = self.safe_zone?;
        let output = self.frame_layout?.output_size;
        let (x, y, w, h) = safe_zone_rect(platform, output)?;
        let player = self.player_frame_rect.get()?;
        let (fw, fh) = (
            f32::from(player.frame.size.width),
            f32::from(player.frame.size.height),
        );
        let origin_x = player.frame.origin.x - player.container.origin.x;
        let origin_y = player.frame.origin.y - player.container.origin.y;
        let theme = self.theme;
        // Outside the safe area: the playhead's red, faint enough to keep
        // the frame readable underneath.
        let shade = Hsla::from(theme.editor.playhead).opacity(0.22);
        let band = |left: f32, top: f32, width: f32, height: f32| {
            div()
                .absolute()
                .left(px(left))
                .top(px(top))
                .w(px(width.max(0.)))
                .h(px(height.max(0.)))
                .bg(shade)
        };
        let (zx, zy, zw, zh) = (x * fw, y * fh, w * fw, h * fh);
        Some(
            div()
                .absolute()
                .left(origin_x)
                .top(origin_y)
                .w(player.frame.size.width)
                .h(player.frame.size.height)
                .overflow_hidden()
                .child(band(0., 0., fw, zy))
                .child(band(0., zy + zh, fw, fh - zy - zh))
                .child(band(0., zy, zx, zh))
                .child(band(zx + zw, zy, fw - zx - zw, zh))
                .child(
                    div()
                        .absolute()
                        .left(px(zx))
                        .top(px(zy))
                        .w(px(zw))
                        .h(px(zh))
                        .border_1()
                        .border_color(Hsla::from(theme.editor.accent))
                        .child(
                            div()
                                .absolute()
                                .left(px(6.))
                                .top(px(4.))
                                .px(px(4.))
                                .rounded(px(4.))
                                .bg(Hsla::from(theme.editor.card).opacity(0.85))
                                .text_size(px(10.))
                                .text_color(Hsla::from(theme.editor.text_1))
                                .child(format!("{} safe zone", platform.label())),
                        ),
                )
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
