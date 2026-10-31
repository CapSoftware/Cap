use naga::{
    front::wgsl,
    valid::{Capabilities, ValidationFlags, Validator},
};
use std::path::PathBuf;

fn shader_paths() -> Vec<PathBuf> {
    let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src/shaders");
    let mut paths: Vec<PathBuf> = std::fs::read_dir(&dir)
        .unwrap_or_else(|error| panic!("read {}: {error}", dir.display()))
        .map(|entry| entry.unwrap().path())
        .filter(|path| {
            path.extension()
                .is_some_and(|extension| extension == "wgsl")
        })
        .collect();
    paths.sort();
    paths
}

fn validate(source: &str) -> Result<(), String> {
    let module = wgsl::parse_str(source).map_err(|error| error.emit_to_string(source))?;
    Validator::new(ValidationFlags::all(), Capabilities::all())
        .validate(&module)
        .map(|_| ())
        .map_err(|error| error.emit_to_string(source))
}

#[test]
fn every_wgsl_shader_parses_and_validates() {
    let paths = shader_paths();
    assert!(!paths.is_empty(), "no shaders found");

    let failures: Vec<String> = paths
        .iter()
        .filter_map(|path| {
            let source = std::fs::read_to_string(path).unwrap();
            validate(&source)
                .err()
                .map(|error| format!("{}:\n{error}", path.file_name().unwrap().to_string_lossy()))
        })
        .collect();

    assert!(failures.is_empty(), "{}", failures.join("\n\n"));
}

#[test]
fn validation_rejects_an_undefined_identifier() {
    let source = "@fragment fn main() -> @location(0) vec4<f32> { return vec4(missing); }";
    assert!(validate(source).is_err());
}
