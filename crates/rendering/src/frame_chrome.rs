//! Decorative frame ("chrome") rendering for the display layer.
//!
//! A frame wraps the screen recording in synthetic window chrome — a macOS
//! title bar, a browser toolbar or a MacBook body. The chrome is rasterized
//! on the CPU from a parameterized SVG (same technique as SVG cursors) into
//! an RGBA texture that the frame layer composites with the shared
//! composite-video-frame pipeline, so it inherits rounded corners, shadows,
//! borders and motion blur from the exact same shader as the video itself.
//!
//! Geometry model: the *outer card* (video + chrome) is what padding,
//! `display_position` and zoom apply to; the video sits inside it offset by
//! [`ChromeInsets`]. Insets are expressed as fractions of the video content
//! height so the chrome keeps its proportions at any recording size.

use crate::composite_frame::CompositeVideoFrameUniforms;
use cap_project::{FrameStyle, FrameTheme, XY};
use std::sync::{Arc, OnceLock};

/// Everything the frame layer needs to draw the chrome for one frame:
/// composite uniforms for the shared pipeline (bounds/rounding/shadow/motion
/// blur; `frame_size`/`crop_bounds` are filled in by the layer once the
/// texture size is known) plus the parameters that drive rasterization.
#[derive(Clone, Debug)]
pub struct FrameChromeUniforms {
    pub composite: CompositeVideoFrameUniforms,
    pub style: FrameStyle,
    pub theme: FrameTheme,
    pub url: String,
    pub title: String,
    /// Unzoomed outer card size in output px — the rasterization base size.
    pub raster_size: XY<f64>,
    /// Unzoomed video content height in output px (chrome proportions basis).
    pub content_height: f64,
}

/// Content insets of a frame style, as fractions of the video content height.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct ChromeInsets {
    pub top: f64,
    pub right: f64,
    pub bottom: f64,
    pub left: f64,
}

/// macOS window title bar height.
const MACOS_BAR_FRAC: f64 = 0.055;
/// Windows 11 window title bar height.
const WINDOWS_BAR_FRAC: f64 = 0.05;
/// Browser toolbar height.
const BROWSER_BAR_FRAC: f64 = 0.075;
/// MacBook screen bezel thickness (all four sides of the panel).
const MACBOOK_BEZEL_FRAC: f64 = 0.028;
/// MacBook deck (keyboard base) height below the panel.
const MACBOOK_DECK_FRAC: f64 = 0.045;
/// How far the deck overhangs the panel on each side.
const MACBOOK_OVERHANG_FRAC: f64 = 0.10;
/// Room reserved under the deck for its baked soft shadow.
const MACBOOK_SHADOW_ROOM_FRAC: f64 = 0.035;

/// Supersampling factor for the rasterized chrome texture, so it stays crisp
/// when zoom segments scale the card up.
const CHROME_SUPERSAMPLE: f64 = 2.0;
/// Hard cap on either texture dimension.
const CHROME_MAX_TEXTURE_DIM: f64 = 4096.0;

pub fn chrome_insets(style: FrameStyle) -> ChromeInsets {
    match style {
        FrameStyle::None => ChromeInsets::default(),
        FrameStyle::MacOS => ChromeInsets {
            top: MACOS_BAR_FRAC,
            ..Default::default()
        },
        FrameStyle::Windows => ChromeInsets {
            top: WINDOWS_BAR_FRAC,
            ..Default::default()
        },
        FrameStyle::Browser => ChromeInsets {
            top: BROWSER_BAR_FRAC,
            ..Default::default()
        },
        FrameStyle::Macbook => ChromeInsets {
            top: MACBOOK_BEZEL_FRAC,
            right: MACBOOK_BEZEL_FRAC + MACBOOK_OVERHANG_FRAC,
            bottom: MACBOOK_BEZEL_FRAC + MACBOOK_DECK_FRAC + MACBOOK_SHADOW_ROOM_FRAC,
            left: MACBOOK_BEZEL_FRAC + MACBOOK_OVERHANG_FRAC,
        },
    }
}

/// Whether the shader-side shadow/border decoration applies to this style.
/// The MacBook silhouette is not a rectangle, so it bakes its own shadow into
/// the SVG instead of using the rect-SDF shadow.
pub fn style_uses_card_decoration(style: FrameStyle) -> bool {
    matches!(
        style,
        FrameStyle::MacOS | FrameStyle::Windows | FrameStyle::Browser
    )
}

/// Texture size for a chrome card whose unzoomed on-screen size is `w`×`h`
/// output pixels.
pub fn chrome_texture_size(w: f64, h: f64) -> (u32, u32) {
    let scale = (CHROME_MAX_TEXTURE_DIM / w.max(1.0))
        .min(CHROME_MAX_TEXTURE_DIM / h.max(1.0))
        .min(CHROME_SUPERSAMPLE);
    let tw = ((w * scale).round() as u32).clamp(16, CHROME_MAX_TEXTURE_DIM as u32);
    let th = ((h * scale).round() as u32).clamp(16, CHROME_MAX_TEXTURE_DIM as u32);
    (tw, th)
}

fn escape_xml(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

struct Palette {
    bar: &'static str,
    bar_top_highlight: &'static str,
    hairline: &'static str,
    title_text: &'static str,
    icon: &'static str,
    pill_fill: &'static str,
    pill_stroke: &'static str,
    pill_text: &'static str,
}

fn palette(theme: FrameTheme) -> Palette {
    match theme {
        FrameTheme::Light => Palette {
            bar: "#ECEBEA",
            bar_top_highlight: "rgba(255,255,255,0.55)",
            hairline: "rgba(0,0,0,0.12)",
            title_text: "#4B4B4E",
            icon: "#87868B",
            pill_fill: "#FFFFFF",
            pill_stroke: "rgba(0,0,0,0.07)",
            pill_text: "#414145",
        },
        FrameTheme::Dark => Palette {
            bar: "#2E2E31",
            bar_top_highlight: "rgba(255,255,255,0.07)",
            hairline: "rgba(0,0,0,0.55)",
            title_text: "#C9C9CE",
            icon: "#9A9AA1",
            pill_fill: "#3C3C41",
            pill_stroke: "rgba(255,255,255,0.06)",
            pill_text: "#C9C9CE",
        },
    }
}

/// The three traffic-light buttons, positioned in a bar of height `bar_h`
/// whose vertical center is `cy`.
fn traffic_lights(bar_h: f64, cy: f64) -> String {
    let r = bar_h * 0.135;
    let first_cx = bar_h * 0.45;
    let gap = r * 3.0;
    format!(
        concat!(
            r##"<circle cx="{x0}" cy="{cy}" r="{r}" fill="#FF5F57"/>"##,
            r##"<circle cx="{x1}" cy="{cy}" r="{r}" fill="#FEBC2E"/>"##,
            r##"<circle cx="{x2}" cy="{cy}" r="{r}" fill="#28C840"/>"##,
        ),
        x0 = first_cx,
        x1 = first_cx + gap,
        x2 = first_cx + gap * 2.0,
        cy = cy,
        r = r,
    )
}

/// Font stack used for chrome text. Resolved against the system font
/// database; if nothing matches, resvg simply skips the text node and the
/// chrome renders without labels.
const CHROME_FONTS: &str = "Helvetica Neue, Helvetica, Segoe UI, Arial, sans-serif";

/// The bar fill extends slightly below the bar so no background seam can show
/// between the chrome and the video's (square) top edge.
fn bar_fill_height(bar_h: f64) -> f64 {
    bar_h + (bar_h * 0.04).max(1.5)
}

fn macos_svg(w: f64, h: f64, bar_h: f64, theme: FrameTheme, title: &str) -> String {
    let p = palette(theme);
    let title_el = if title.trim().is_empty() {
        String::new()
    } else {
        format!(
            r##"<text x="{x}" y="{y}" font-family="{fonts}" font-size="{size}" font-weight="600" fill="{fill}" text-anchor="middle">{title}</text>"##,
            x = w * 0.5,
            y = bar_h * 0.5 + bar_h * 0.155,
            fonts = CHROME_FONTS,
            size = bar_h * 0.42,
            fill = p.title_text,
            title = escape_xml(title),
        )
    };

    format!(
        concat!(
            r##"<svg width="{w}" height="{h}" viewBox="0 0 {w} {h}" xmlns="http://www.w3.org/2000/svg">"##,
            r##"<rect width="{w}" height="{bar_fill}" fill="{bar}"/>"##,
            r##"<rect width="{w}" height="{hl_h}" fill="{highlight}"/>"##,
            r##"<rect y="{hair_y}" width="{w}" height="{hair_h}" fill="{hairline}"/>"##,
            "{lights}",
            "{title_el}",
            "</svg>"
        ),
        w = w,
        h = h,
        bar_fill = bar_fill_height(bar_h),
        bar = p.bar,
        hl_h = (bar_h * 0.045).max(1.0),
        highlight = p.bar_top_highlight,
        hair_y = bar_h - (bar_h * 0.03).max(1.0),
        hair_h = (bar_h * 0.03).max(1.0),
        hairline = p.hairline,
        lights = traffic_lights(bar_h, bar_h * 0.5),
        title_el = title_el,
    )
}

/// Windows 11 title bar: left-aligned title, right-aligned minimize /
/// maximize / close caption controls.
fn windows_svg(w: f64, h: f64, bar_h: f64, theme: FrameTheme, title: &str) -> String {
    let p = palette(theme);
    let cy = bar_h * 0.5;
    let g = bar_h * 0.145;
    let stroke = format!(
        r##"stroke="{icon}" stroke-width="{sw}" stroke-linecap="round" fill="none""##,
        icon = p.icon,
        sw = (bar_h * 0.038).max(1.2),
    );
    // Caption controls, right to left: close, maximize, minimize.
    let zone = bar_h * 1.30;
    let close_cx = w - zone * 0.5;
    let max_cx = w - zone * 1.5;
    let min_cx = w - zone * 2.5;
    let controls = format!(
        concat!(
            r##"<path d="M {min0} {cy} H {min1}" {stroke}/>"##,
            r##"<rect x="{mx}" y="{my}" width="{ms}" height="{ms}" rx="{mr}" {stroke}/>"##,
            r##"<path d="M {cx0} {cy0} L {cx1} {cy1} M {cx0} {cy1} L {cx1} {cy0}" {stroke}/>"##,
        ),
        min0 = min_cx - g,
        min1 = min_cx + g,
        cy = cy,
        mx = max_cx - g,
        my = cy - g,
        ms = g * 2.0,
        mr = g * 0.30,
        cx0 = close_cx - g,
        cx1 = close_cx + g,
        cy0 = cy - g,
        cy1 = cy + g,
        stroke = stroke,
    );

    let title_el = if title.trim().is_empty() {
        String::new()
    } else {
        format!(
            r##"<text x="{x}" y="{y}" font-family="{fonts}" font-size="{size}" fill="{fill}" text-anchor="start">{title}</text>"##,
            x = bar_h * 0.55,
            y = cy + bar_h * 0.14,
            fonts = CHROME_FONTS,
            size = bar_h * 0.38,
            fill = p.title_text,
            title = escape_xml(title),
        )
    };

    format!(
        concat!(
            r##"<svg width="{w}" height="{h}" viewBox="0 0 {w} {h}" xmlns="http://www.w3.org/2000/svg">"##,
            r##"<rect width="{w}" height="{bar_fill}" fill="{bar}"/>"##,
            r##"<rect y="{hair_y}" width="{w}" height="{hair_h}" fill="{hairline}"/>"##,
            "{title_el}",
            "{controls}",
            "</svg>"
        ),
        w = w,
        h = h,
        bar_fill = bar_fill_height(bar_h),
        bar = p.bar,
        hair_y = bar_h - (bar_h * 0.028).max(1.0),
        hair_h = (bar_h * 0.028).max(1.0),
        hairline = p.hairline,
        title_el = title_el,
        controls = controls,
    )
}

fn browser_svg(w: f64, h: f64, bar_h: f64, theme: FrameTheme, url: &str) -> String {
    let p = palette(theme);
    let cy = bar_h * 0.5;

    // Navigation glyphs (back / forward chevrons, reload arc) to the right of
    // the traffic lights.
    let lights_end = bar_h * 0.45 + bar_h * 0.135 * 3.0 * 2.0 + bar_h * 0.135;
    let glyph = bar_h * 0.14;
    let nav_stroke = format!(
        r##"stroke="{icon}" stroke-width="{sw}" stroke-linecap="round" stroke-linejoin="round" fill="none""##,
        icon = p.icon,
        sw = (bar_h * 0.032).max(1.2),
    );
    let back_x = lights_end + bar_h * 0.42;
    let fwd_x = back_x + bar_h * 0.62;
    let reload_x = fwd_x + bar_h * 0.62;
    // Reload: clockwise arc with the gap at the top-right and a solid arrow
    // head at the arc's end pointing clockwise into the gap, like the
    // standard material/Chrome refresh glyph. Angles are in y-down screen
    // space, where increasing angle travels clockwise.
    let reload = {
        let r = glyph * 1.05;
        let point = |deg: f64| {
            let rad = deg.to_radians();
            (reload_x + r * rad.cos(), cy + r * rad.sin())
        };
        let start_deg = -15.0; // just below the gap, ~2 o'clock
        let end_deg = 300.0; // upper end of the gap, ~1 o'clock
        let (sx, sy) = point(start_deg);
        let (ex, ey) = point(end_deg);
        // Tangent of clockwise travel at the arc end; the arrow head points
        // along it.
        let trad = end_deg.to_radians();
        let (tx, ty) = (-trad.sin(), trad.cos());
        let (nx, ny) = (-ty, tx);
        let head = glyph * 0.85;
        format!(
            concat!(
                r##"<path d="M {sx} {sy} A {r} {r} 0 1 1 {ex} {ey}" {stroke}/>"##,
                r##"<path d="M {tipx} {tipy} L {b0x} {b0y} L {b1x} {b1y} Z" fill="{icon}"/>"##,
            ),
            sx = sx,
            sy = sy,
            r = r,
            ex = ex,
            ey = ey,
            stroke = nav_stroke,
            tipx = ex + tx * head,
            tipy = ey + ty * head,
            b0x = ex - tx * head * 0.25 + nx * head * 0.75,
            b0y = ey - ty * head * 0.25 + ny * head * 0.75,
            b1x = ex - tx * head * 0.25 - nx * head * 0.75,
            b1y = ey - ty * head * 0.25 - ny * head * 0.75,
            icon = p.icon,
        )
    };
    let nav = format!(
        concat!(
            r##"<path d="M {bx1} {ty} L {bx0} {cy} L {bx1} {by}" {stroke}/>"##,
            r##"<path d="M {fx0} {ty} L {fx1} {cy} L {fx0} {by}" {stroke}/>"##,
            "{reload}",
        ),
        bx0 = back_x - glyph * 0.55,
        bx1 = back_x + glyph * 0.55,
        fx0 = fwd_x - glyph * 0.55,
        fx1 = fwd_x + glyph * 0.55,
        ty = cy - glyph,
        by = cy + glyph,
        cy = cy,
        stroke = nav_stroke,
        reload = reload,
    );

    // Centered URL pill; the padlock and address text are left-aligned inside
    // it at fixed positions (like Chrome/Arc), so they stay perfectly aligned
    // to each other no matter how the text renders.
    let pill_h = bar_h * 0.60;
    let pill_w = (w * 0.42).max(pill_h * 4.0).min(w * 0.8);
    let pill_x = (w - pill_w) * 0.5;
    let pill_y = cy - pill_h * 0.5;
    let text = escape_xml(url.trim());
    let font_size = bar_h * 0.30;
    // Padlock: shackle arc over a rounded body, vertically centered on the
    // text's optical middle.
    let lock_x = pill_x + pill_h * 0.60;
    let body_w = font_size * 0.74;
    let body_h = font_size * 0.56;
    let body_y = cy - font_size * 0.05;
    let shackle_r = body_w * 0.30;
    let lock = format!(
        concat!(
            r##"<path d="M {shx0} {shy} v {leg} a {sr} {sr} 0 0 1 {sdia} 0 v {leg_down}" stroke="{icon}" stroke-width="{ssw}" fill="none"/>"##,
            r##"<rect x="{bx}" y="{by}" width="{bw}" height="{bh}" rx="{brx}" fill="{icon}"/>"##,
        ),
        shx0 = lock_x + body_w * 0.5 - shackle_r,
        shy = body_y,
        leg = -font_size * 0.14,
        sr = shackle_r,
        sdia = shackle_r * 2.0,
        leg_down = font_size * 0.14,
        ssw = (font_size * 0.16).max(1.0),
        bx = lock_x,
        by = body_y,
        bw = body_w,
        bh = body_h,
        brx = body_w * 0.18,
        icon = p.icon,
    );
    let url_el = if text.is_empty() {
        String::new()
    } else {
        format!(
            concat!(
                "{lock}",
                r##"<text x="{tx}" y="{ty}" font-family="{fonts}" font-size="{size}" fill="{fill}" text-anchor="start">{text}</text>"##,
            ),
            lock = lock,
            tx = lock_x + body_w + font_size * 0.42,
            ty = cy + font_size * 0.36,
            fonts = CHROME_FONTS,
            size = font_size,
            fill = p.pill_text,
            text = text,
        )
    };

    format!(
        concat!(
            r##"<svg width="{w}" height="{h}" viewBox="0 0 {w} {h}" xmlns="http://www.w3.org/2000/svg">"##,
            r##"<rect width="{w}" height="{bar_fill}" fill="{bar}"/>"##,
            r##"<rect width="{w}" height="{hl_h}" fill="{highlight}"/>"##,
            r##"<rect y="{hair_y}" width="{w}" height="{hair_h}" fill="{hairline}"/>"##,
            "{lights}",
            "{nav}",
            r##"<rect x="{px}" y="{py}" width="{pw}" height="{ph}" rx="{pr}" fill="{pill}" stroke="{pill_stroke}" stroke-width="1"/>"##,
            "{url_el}",
            "</svg>"
        ),
        w = w,
        h = h,
        bar_fill = bar_fill_height(bar_h),
        bar = p.bar,
        hl_h = (bar_h * 0.03).max(1.0),
        highlight = p.bar_top_highlight,
        hair_y = bar_h - (bar_h * 0.022).max(1.0),
        hair_h = (bar_h * 0.022).max(1.0),
        hairline = p.hairline,
        lights = traffic_lights(bar_h, cy),
        nav = nav,
        px = pill_x,
        py = pill_y,
        pw = pill_w,
        ph = pill_h,
        pr = pill_h * 0.5,
        pill = p.pill_fill,
        pill_stroke = p.pill_stroke,
        url_el = url_el,
    )
}

/// MacBook mockup: black panel bezel around the screen, aluminum deck with a
/// thumb scoop, camera dot, and a baked soft shadow (its silhouette is not a
/// rectangle, so the shader's rect shadow stays off for this style).
fn macbook_svg(w: f64, h: f64, content_h: f64, theme: FrameTheme) -> String {
    let bezel = content_h * MACBOOK_BEZEL_FRAC;
    let deck_h = content_h * MACBOOK_DECK_FRAC;
    let overhang = content_h * MACBOOK_OVERHANG_FRAC;
    let shadow_room = content_h * MACBOOK_SHADOW_ROOM_FRAC;

    // Panel (screen + bezel) block.
    let panel_x = overhang;
    let panel_w = w - overhang * 2.0;
    let panel_h = h - deck_h - shadow_room;
    let panel_radius = bezel * 1.35;

    let deck_y = panel_h;
    let deck_radius = deck_h * 0.42;
    let scoop_w = w * 0.14;
    let scoop_h = deck_h * 0.52;

    let (alu_top, alu_bottom, alu_edge, panel_fill, scoop_top, scoop_bottom) = match theme {
        FrameTheme::Light => (
            "#E6E7E9", "#ADAFB4", "#8E9094", "#0E0E11", "#C4C6CA", "#9EA0A5",
        ),
        FrameTheme::Dark => (
            "#3E3F43", "#232427", "#151619", "#0E0E11", "#2A2B2F", "#1B1C1F",
        ),
    };

    format!(
        concat!(
            r##"<svg width="{w}" height="{h}" viewBox="0 0 {w} {h}" xmlns="http://www.w3.org/2000/svg">"##,
            "<defs>",
            r##"<linearGradient id="alu" x1="0" y1="0" x2="0" y2="1">"##,
            r##"<stop offset="0" stop-color="{alu_top}"/><stop offset="1" stop-color="{alu_bottom}"/>"##,
            "</linearGradient>",
            r##"<linearGradient id="scoop" x1="0" y1="0" x2="0" y2="1">"##,
            r##"<stop offset="0" stop-color="{scoop_top}"/><stop offset="1" stop-color="{scoop_bottom}"/>"##,
            "</linearGradient>",
            r##"<filter id="soft" x="-30%" y="-30%" width="160%" height="160%">"##,
            r##"<feGaussianBlur stdDeviation="{shadow_blur}"/>"##,
            "</filter>",
            "</defs>",
            // Baked ground shadow under the deck.
            r##"<ellipse cx="{sh_cx}" cy="{sh_cy}" rx="{sh_rx}" ry="{sh_ry}" fill="rgba(0,0,0,0.42)" filter="url(#soft)"/>"##,
            // Panel with bezel; the video sits inset by the bezel.
            r##"<rect x="{panel_x}" y="0" width="{panel_w}" height="{panel_h}" rx="{panel_radius}" fill="{panel_fill}"/>"##,
            // Camera dot centered in the top bezel.
            r##"<circle cx="{cam_cx}" cy="{cam_cy}" r="{cam_r}" fill="#17181C"/>"##,
            r##"<circle cx="{cam_cx}" cy="{cam_cy}" r="{cam_r_inner}" fill="#2A3138"/>"##,
            // Deck with rounded bottom corners and the thumb scoop.
            r##"<path d="M 0 {deck_y} H {w} V {deck_bot_edge} Q {w} {deck_bot} {deck_right_in} {deck_bot} H {deck_left_in} Q 0 {deck_bot} 0 {deck_bot_edge} Z" fill="url(#alu)"/>"##,
            r##"<rect x="0" y="{deck_y}" width="{w}" height="{edge_h}" fill="{alu_edge}" fill-opacity="0.35"/>"##,
            r##"<path d="M {scoop_left} {deck_y} h {scoop_w} v {scoop_body} a {scoop_r} {scoop_r} 0 0 1 -{scoop_r} {scoop_r} h -{scoop_flat} a {scoop_r} {scoop_r} 0 0 1 -{scoop_r} -{scoop_r} Z" fill="url(#scoop)"/>"##,
            // Bottom edge line of the deck for definition.
            r##"<rect x="{deck_left_in}" y="{deck_edge_y}" width="{deck_edge_w}" height="{deck_edge_h}" fill="{alu_edge}" fill-opacity="0.6"/>"##,
            "</svg>"
        ),
        w = w,
        h = h,
        alu_top = alu_top,
        alu_bottom = alu_bottom,
        scoop_top = scoop_top,
        scoop_bottom = scoop_bottom,
        shadow_blur = deck_h * 0.55,
        sh_cx = w * 0.5,
        sh_cy = deck_y + deck_h * 0.9,
        sh_rx = w * 0.46,
        sh_ry = deck_h * 0.55,
        panel_x = panel_x,
        panel_w = panel_w,
        panel_h = panel_h,
        panel_radius = panel_radius,
        panel_fill = panel_fill,
        cam_cx = w * 0.5,
        cam_cy = bezel * 0.5,
        cam_r = (bezel * 0.16).max(1.5),
        cam_r_inner = (bezel * 0.07).max(0.8),
        deck_y = deck_y,
        deck_bot = deck_y + deck_h,
        deck_bot_edge = deck_y + deck_h - deck_radius,
        deck_right_in = w - deck_radius,
        deck_left_in = deck_radius,
        edge_h = (deck_h * 0.06).max(1.0),
        scoop_left = (w - scoop_w) * 0.5,
        scoop_w = scoop_w,
        scoop_body = scoop_h - scoop_h * 0.5,
        scoop_r = scoop_h * 0.5,
        scoop_flat = scoop_w - scoop_h,
        deck_edge_y = deck_y + deck_h - (deck_h * 0.08).max(1.0),
        deck_edge_w = w - deck_radius * 2.0,
        deck_edge_h = (deck_h * 0.08).max(1.0),
        alu_edge = alu_edge,
    )
}

/// Build the SVG for a chrome card of `w`×`h` texture pixels wrapping a video
/// content area of height `content_h` texture pixels.
pub fn chrome_svg(
    style: FrameStyle,
    theme: FrameTheme,
    url: &str,
    title: &str,
    w: f64,
    h: f64,
    content_h: f64,
) -> Option<String> {
    match style {
        FrameStyle::None => None,
        FrameStyle::MacOS => Some(macos_svg(w, h, content_h * MACOS_BAR_FRAC, theme, title)),
        FrameStyle::Windows => Some(windows_svg(
            w,
            h,
            content_h * WINDOWS_BAR_FRAC,
            theme,
            title,
        )),
        FrameStyle::Browser => Some(browser_svg(w, h, content_h * BROWSER_BAR_FRAC, theme, url)),
        FrameStyle::Macbook => Some(macbook_svg(w, h, content_h, theme)),
    }
}

fn chrome_fontdb() -> Arc<resvg::usvg::fontdb::Database> {
    static FONTDB: OnceLock<Arc<resvg::usvg::fontdb::Database>> = OnceLock::new();
    FONTDB
        .get_or_init(|| {
            let mut db = resvg::usvg::fontdb::Database::new();
            db.load_system_fonts();
            Arc::new(db)
        })
        .clone()
}

/// Rasterize a chrome card to RGBA8 (non-premultiplied). Returns `None` for
/// [`FrameStyle::None`] or if rasterization fails (the frame layer then skips
/// drawing rather than erroring the whole frame).
pub fn rasterize_chrome(
    style: FrameStyle,
    theme: FrameTheme,
    url: &str,
    title: &str,
    tex_w: u32,
    tex_h: u32,
    content_h_px: f64,
) -> Option<Vec<u8>> {
    let svg = chrome_svg(
        style,
        theme,
        url,
        title,
        tex_w as f64,
        tex_h as f64,
        content_h_px,
    )?;

    let options = resvg::usvg::Options {
        fontdb: chrome_fontdb(),
        ..Default::default()
    };

    let tree = match resvg::usvg::Tree::from_str(&svg, &options) {
        Ok(tree) => tree,
        Err(error) => {
            tracing::warn!("Failed to parse frame chrome SVG: {error}");
            return None;
        }
    };

    let mut pixmap = tiny_skia::Pixmap::new(tex_w, tex_h)?;
    resvg::render(
        &tree,
        tiny_skia::Transform::identity(),
        &mut pixmap.as_mut(),
    );

    Some(
        pixmap
            .pixels()
            .iter()
            .flat_map(|p| {
                let c = p.demultiply();
                [c.red(), c.green(), c.blue(), c.alpha()]
            })
            .collect(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn no_frame_has_no_insets() {
        assert_eq!(chrome_insets(FrameStyle::None), ChromeInsets::default());
    }

    #[test]
    fn texture_size_respects_max_dim() {
        let (w, h) = chrome_texture_size(8000.0, 200.0);
        assert!(w <= 4096 && h <= 4096);
        let (w, h) = chrome_texture_size(1600.0, 1000.0);
        assert_eq!((w, h), (3200, 2000));
    }

    /// Visual iteration helper: dumps every style/theme chrome to PNGs.
    /// `CAP_CHROME_DUMP_DIR=/tmp/x cargo test -p cap-rendering dump_chrome -- --ignored`
    #[test]
    #[ignore]
    fn dump_chrome_pngs() {
        let Ok(dir) = std::env::var("CAP_CHROME_DUMP_DIR") else {
            return;
        };
        std::fs::create_dir_all(&dir).unwrap();
        for style in [
            FrameStyle::MacOS,
            FrameStyle::Windows,
            FrameStyle::Browser,
            FrameStyle::Macbook,
        ] {
            for theme in [FrameTheme::Light, FrameTheme::Dark] {
                let insets = chrome_insets(style);
                let content_h = 900.0_f64;
                let content_w = content_h * 16.0 / 10.0;
                let w = (content_w + (insets.left + insets.right) * content_h).round() as u32;
                let h = (content_h * (1.0 + insets.top + insets.bottom)).round() as u32;
                let rgba =
                    rasterize_chrome(style, theme, "cap.so", "Cap Recording", w, h, content_h)
                        .unwrap();
                image::RgbaImage::from_raw(w, h, rgba)
                    .unwrap()
                    .save(format!("{dir}/{style:?}-{theme:?}.png"))
                    .unwrap();
            }
        }
    }

    #[test]
    fn all_styles_rasterize() {
        for style in [
            FrameStyle::MacOS,
            FrameStyle::Windows,
            FrameStyle::Browser,
            FrameStyle::Macbook,
        ] {
            for theme in [FrameTheme::Light, FrameTheme::Dark] {
                let rgba = rasterize_chrome(style, theme, "cap.so", "Recording", 640, 420, 360.0);
                let rgba = rgba.expect("chrome should rasterize");
                assert_eq!(rgba.len(), 640 * 420 * 4);
                // Something visible must have been drawn.
                assert!(rgba.chunks_exact(4).any(|px| px[3] > 0));
            }
        }
    }
}
