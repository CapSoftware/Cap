#[path = "../../scripts/diagnostic-build.rs"]
mod diagnostic_build;

fn main() {
    diagnostic_build::emit();
    cap_i18n_build::build("locales");
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        println!("cargo:rerun-if-changed=native/exception_guard.m");
        cc::Build::new()
            .file("native/exception_guard.m")
            .flag("-fobjc-exceptions")
            .flag("-fno-objc-arc")
            .compile("cap_exception_guard");
        println!("cargo:rustc-link-lib=framework=Foundation");
    }
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
