fn main() {
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows")
        && std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc")
    {
        // Export preview command dispatch can exhaust the default 1 MiB UI stack before reaching a Tokio worker.
        println!("cargo:rustc-link-arg-bin=cap-desktop=/STACK:16777216");
    }
    tauri_build::build();
}
