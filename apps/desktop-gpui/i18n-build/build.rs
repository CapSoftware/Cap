#[allow(dead_code)]
#[path = "src/lib.rs"]
mod codegen;

use std::path::PathBuf;

fn main() {
    println!("cargo:rerun-if-changed=src/lib.rs");
    println!("cargo:rerun-if-changed=tests/fixtures");
    let manifest_dir =
        PathBuf::from(std::env::var_os("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR"));
    let out_dir = PathBuf::from(std::env::var_os("OUT_DIR").expect("OUT_DIR"));
    let catalogs = codegen::read_catalogs(&manifest_dir.join("tests/fixtures"))
        .unwrap_or_else(|errors| panic!("{}", errors.join("\n")));
    let borrowed: Vec<(&str, &str)> = catalogs
        .iter()
        .map(|(code, text)| (code.as_str(), text.as_str()))
        .collect();
    let output = codegen::generate(&borrowed, false)
        .unwrap_or_else(|errors| panic!("{}", errors.join("\n")));
    std::fs::write(out_dir.join("fixture.rs"), output.code).expect("write the fixture tables");
}
