fn main() {
    if std::env::var("CARGO_CFG_TARGET_OS").is_ok_and(|target| target == "macos") {
        println!("cargo:rustc-link-lib=framework=VideoToolbox");
        println!("cargo:rustc-link-lib=framework=CoreVideo");
        println!("cargo:rustc-link-lib=framework=CoreFoundation");
    }
}
