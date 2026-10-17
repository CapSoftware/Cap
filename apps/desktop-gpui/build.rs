#[path = "../../scripts/diagnostic-build.rs"]
mod diagnostic_build;
mod token_compiler;

use std::{collections::BTreeSet, fmt::Write, path::PathBuf};

const COLORS: &str = "
surface surface-secondary surface-subtle surface-raised surface-overlay surface-inverse
border border-secondary border-subtle border-softer border-strong border-inverse
text-primary text-default text-secondary text-muted text-positive text-negative
text-danger text-warning text-interactive text-hover text-active
hover-bg active-bg disabled-bg icon icon-active
positive positive-subtle negative negative-subtle warning warning-subtle
indigo indigo-subtle purple purple-subtle
primary primary-hover primary-active primary-disabled primary-disabled-foreground
primary-subtle primary-foreground danger danger-hover danger-disabled
danger-disabled-foreground danger-ring danger-foreground
button-fill button-fill-hover button-fill-active button-fill-foreground button-fill-subtle
ring-primary bullish bearish";

const RADII: &[(&str, &str)] = &[
    ("Small", "radius-small"),
    ("Compact", "radius-compact"),
    ("Default", "radius-default"),
    ("Medium", "radius-medium"),
    ("Large", "radius-large"),
];
const SHADOWS: &[(&str, &str)] = &[
    ("One", "shadow-1"),
    ("Two", "shadow-2"),
    ("Three", "shadow-3"),
    ("Dialog", "shadow-dialog"),
];

fn rgba(value: [u8; 4]) -> String {
    format!(
        "gpui::Rgba {{ r: {}f32 / 255., g: {}f32 / 255., b: {}f32 / 255., a: {}f32 / 255. }}",
        value[0], value[1], value[2], value[3]
    )
}

fn compile_tokens() -> Result<(), String> {
    use token_compiler::{color, parse, pixels, resolve, shadow};

    println!("cargo:rerun-if-changed=platform.css");
    let css = std::fs::read_to_string("platform.css")
        .map_err(|error| format!("reading platform.css: {error}"))?;
    let (root, dark) = parse(&css)?;
    let color_names: BTreeSet<&str> = COLORS.split_whitespace().collect();
    let expected: BTreeSet<&str> = color_names
        .iter()
        .copied()
        .chain(RADII.iter().map(|(_, name)| *name))
        .chain(SHADOWS.iter().map(|(_, name)| *name))
        .collect();
    let actual: BTreeSet<&str> = root.keys().map(String::as_str).collect();
    if actual != expected {
        return Err(format!(
            "platform.css token mismatch: missing {:?}, unknown {:?}",
            expected.difference(&actual).collect::<Vec<_>>(),
            actual.difference(&expected).collect::<Vec<_>>()
        ));
    }
    let dark_names: BTreeSet<&str> = dark.keys().map(String::as_str).collect();
    if dark_names != color_names {
        return Err(format!(
            ".dark token mismatch: missing {:?}, unknown {:?}",
            color_names.difference(&dark_names).collect::<Vec<_>>(),
            dark_names.difference(&color_names).collect::<Vec<_>>()
        ));
    }
    let mut output = String::from("#[derive(Debug, Clone, Copy)]\npub struct PlatformColors {\n");
    for name in &color_names {
        writeln!(output, "pub {}: gpui::Rgba,", name.replace('-', "_"))
            .map_err(|error| error.to_string())?;
    }
    output.push_str("}\n");
    for (variant, values) in [("light", &root), ("dark", &dark)] {
        writeln!(
            output,
            "pub fn {variant}_colors() -> PlatformColors {{ PlatformColors {{"
        )
        .map_err(|error| error.to_string())?;
        for name in &color_names {
            let resolved = resolve(values, name)?;
            let parsed = color(&resolved).map_err(|error| format!("--{name}: {error}"))?;
            writeln!(output, "{}: {},", name.replace('-', "_"), rgba(parsed))
                .map_err(|error| error.to_string())?;
        }
        output.push_str("} }\n");
    }
    output.push_str(
        "#[derive(Debug, Clone, Copy, PartialEq, Eq)]\npub enum RadiusToken { Small, Compact, Default, Medium, Large }\n",
    );
    output.push_str("pub fn radius(token: RadiusToken) -> gpui::Pixels { gpui::px(match token {\n");
    for (variant, name) in RADII {
        let value = pixels(root.get(*name).ok_or(format!("missing --{name}"))?)?;
        writeln!(output, "RadiusToken::{variant} => {value:?},")
            .map_err(|error| error.to_string())?;
    }
    output.push_str("}) }\n");
    output.push_str(
        "#[derive(Debug, Clone, Copy, PartialEq, Eq)]\npub enum ShadowToken { One, Two, Three, Dialog }\n",
    );
    output.push_str("pub fn shadow(token: ShadowToken) -> Vec<gpui::BoxShadow> { match token {\n");
    for (variant, name) in SHADOWS {
        let layers = shadow(root.get(*name).ok_or(format!("missing --{name}"))?)
            .map_err(|error| format!("--{name}: {error}"))?;
        writeln!(output, "ShadowToken::{variant} => vec![").map_err(|error| error.to_string())?;
        for (dims, shade) in layers {
            writeln!(
                output,
                "gpui::BoxShadow {{ offset: gpui::point(gpui::px({:?}), gpui::px({:?})), blur_radius: gpui::px({:?}), spread_radius: gpui::px({:?}), color: {}.into(), inset: false }},",
                dims[0], dims[1], dims[2], dims[3], rgba(shade)
            )
            .map_err(|error| error.to_string())?;
        }
        output.push_str("],\n");
    }
    output.push_str("} }\n");
    let out = PathBuf::from(std::env::var_os("OUT_DIR").ok_or("missing OUT_DIR")?);
    std::fs::write(out.join("platform_tokens.rs"), output)
        .map_err(|error| format!("writing generated tokens: {error}"))
}

fn main() {
    diagnostic_build::emit();
    compile_tokens().expect("invalid platform.css design tokens");
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("windows") {
        return;
    }

    if std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc") {
        // Export dispatch constructs media futures on the UI thread before Tokio can poll them.
        println!("cargo:rustc-link-arg-bin=cap-gpui=/STACK:16777216");
    }

    let icon = "../desktop/src-tauri/icons/icon.ico";
    println!("cargo:rerun-if-changed={icon}");
    tauri_winres::WindowsResource::new()
        .set_icon_with_id(icon, "1")
        .set("ProductName", "Cap")
        .set("FileDescription", "Cap")
        .set("OriginalFilename", "Cap.exe")
        .compile()
        .expect("failed to compile the Cap Windows icon resource");
}
