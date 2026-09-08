use std::path::Path;

// The cap-demo skill directory is embedded wholesale into the `cap` binary via
// `include_dir!` in src/agents.rs. That macro has no exclusion filter and does
// not respect .gitignore, so anything on disk under skill/cap-demo at build
// time gets baked into every binary built from this checkout. The skill's own
// docs instruct running `npm install` inside that directory (it uses
// Playwright), which would silently embed the entire node_modules tree —
// including playwright-core — bloating the shipped CLI and making builds
// non-reproducible. Guard against that here, loudly, at build time.
fn main() {
    let manifest_dir = std::env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR is set");
    let node_modules = Path::new(&manifest_dir)
        .join("skill")
        .join("cap-demo")
        .join("node_modules");

    // Re-run this check whenever the embedded skill tree changes (including
    // when node_modules appears or disappears).
    println!("cargo:rerun-if-changed=skill/cap-demo");

    if node_modules.exists() {
        println!(
            "cargo:warning=skill/cap-demo/node_modules exists and would be embedded into the cap binary by include_dir!"
        );
        panic!(
            "\n\nskill/cap-demo/node_modules exists at build time.\n\
             The entire skill/cap-demo directory is embedded into the `cap` binary via \
             include_dir! (src/agents.rs), which does not respect .gitignore, so building \
             now would bake the whole node_modules tree (including playwright-core) into \
             every binary built from this checkout.\n\n\
             Fix: rm -rf apps/cli/skill/cap-demo/node_modules\n\
             (npm dependencies there are only needed at cap-demo runtime, never at build time.)\n\n"
        );
    }
}
