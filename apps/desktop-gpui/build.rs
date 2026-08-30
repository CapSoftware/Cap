fn main() {
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("windows") {
        return;
    }

    let icon = "../desktop/src-tauri/icons/icon.ico";
    println!("cargo:rerun-if-changed={icon}");
    tauri_winres::WindowsResource::new()
        .set_icon_with_id(icon, "1")
        .set("ProductName", "Cap")
        .set("FileDescription", "Cap")
        .set("OriginalFilename", "cap-gpui.exe")
        .compile()
        .expect("failed to compile the Cap Windows icon resource");
}
