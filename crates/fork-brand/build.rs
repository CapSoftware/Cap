use serde_json::Value;
use std::path::Path;

const STRINGS: [(&str, &str); 18] = [
    ("display_name", "FORK_BRAND_APP_NAME"),
    ("upstream_name", "FORK_BRAND_UPSTREAM_NAME"),
    ("slug", "FORK_BRAND_SLUG"),
    ("cli_name", "FORK_BRAND_CLI_NAME"),
    ("skill_name", "FORK_BRAND_SKILL_NAME"),
    ("bundle_id", "FORK_BRAND_BUNDLE_ID"),
    ("url_scheme", "FORK_BRAND_URL_SCHEME"),
    ("repo_url", "FORK_BRAND_REPO_URL"),
    ("releases_url", "FORK_BRAND_RELEASES_URL"),
    ("issues_url", "FORK_BRAND_ISSUES_URL"),
    ("changes_url", "FORK_BRAND_CHANGES_URL"),
    ("help_url", "FORK_BRAND_HELP_URL"),
    ("docs_url", "FORK_BRAND_DOCS_URL"),
    ("feedback_url", "FORK_BRAND_FEEDBACK_URL"),
    ("status_url", "FORK_BRAND_STATUS_URL"),
    ("community_url", "FORK_BRAND_COMMUNITY_URL"),
    ("default_server_url", "FORK_BRAND_DEFAULT_SERVER_URL"),
    ("long_description", "FORK_BRAND_LONG_DESCRIPTION"),
];

const FORMER_NAMES_SEPARATOR: char = '|';
const TEMPLATES: [&str; 2] = ["SKILL.md", "cli-help.txt"];

fn text<'a>(brand: &'a Value, field: &str) -> &'a str {
    brand
        .get(field)
        .and_then(Value::as_str)
        .unwrap_or_else(|| panic!("fork-brand: brand.json needs a string `{field}`"))
}

fn expand(template: &str, brand: &Value) -> String {
    template
        .replace("%app%", text(brand, "display_name"))
        .replace("%cli%", text(brand, "cli_name"))
        .replace("%skill%", text(brand, "skill_name"))
        .replace("%upstream%", text(brand, "upstream_name"))
        .replace("%repo%", text(brand, "repo_url"))
}

fn main() {
    println!("cargo:rerun-if-changed=brand.json");
    let source = std::fs::read_to_string("brand.json").expect("fork-brand: cannot read brand.json");
    let brand: Value = serde_json::from_str(&source).expect("fork-brand: brand.json is not JSON");
    for (field, env) in STRINGS {
        let value = expand(text(&brand, field), &brand);
        assert!(
            !value.contains(['\n', '\r']),
            "fork-brand: `{field}` must be one line"
        );
        println!("cargo:rustc-env={env}={value}");
    }
    let former: Vec<&str> = brand
        .get("former_names")
        .and_then(Value::as_array)
        .expect("fork-brand: brand.json needs an array `former_names`")
        .iter()
        .map(|name| name.as_str().expect("fork-brand: former names are strings"))
        .collect();
    assert!(
        former
            .iter()
            .all(|name| !name.contains(FORMER_NAMES_SEPARATOR)),
        "fork-brand: a former name holds the separator"
    );
    println!(
        "cargo:rustc-env=FORK_BRAND_FORMER_NAMES={}",
        former.join(&FORMER_NAMES_SEPARATOR.to_string())
    );

    let out_dir = std::env::var("OUT_DIR").expect("fork-brand: OUT_DIR");
    for name in TEMPLATES {
        let path = format!("templates/{name}");
        println!("cargo:rerun-if-changed={path}");
        let template = std::fs::read_to_string(&path)
            .unwrap_or_else(|error| panic!("fork-brand: cannot read {path}: {error}"));
        std::fs::write(Path::new(&out_dir).join(name), expand(&template, &brand))
            .unwrap_or_else(|error| panic!("fork-brand: cannot write {name}: {error}"));
    }
}
