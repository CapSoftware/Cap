use std::path::{Path, PathBuf};

use toml::{Table, Value};

const OVERLAY: &str = "locales-fork/en.toml";
const UPSTREAM_TOKEN: &str = "%upstream%";
const RELEASES_TOKEN: &str = "%releases%";
const CLI_TOKEN: &str = "%cli%";
const SHIPPED: &str = "i18n_shipped.rs";
const UPSTREAM: &str = "i18n_upstream.rs";
const NAMED_BY_APP_NAME: &[&str] = &["menu.app.about", "menu.app.hide", "menu.app.quit"];

pub fn i18n(locales: &str) {
    let manifest_dir =
        PathBuf::from(std::env::var_os("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR"));
    let out_dir = PathBuf::from(std::env::var_os("OUT_DIR").expect("OUT_DIR"));
    let locales = manifest_dir.join(locales);
    let overlay_path = manifest_dir.join(OVERLAY);
    println!("cargo:rerun-if-changed={}", locales.display());
    println!("cargo:rerun-if-changed={}", overlay_path.display());
    println!("cargo:rerun-if-env-changed={}", cap_i18n_build::STRICT_ENV);
    let strict = std::env::var(cap_i18n_build::STRICT_ENV).is_ok_and(|value| value == "1");
    let pseudo = std::env::var_os("CARGO_CFG_DEBUG_ASSERTIONS").is_some();

    let upstream = cap_i18n_build::read_catalogs(&locales).unwrap_or_else(|errors| fail(&errors));
    if std::env::var_os("CARGO_FEATURE_UX_WALK").is_none() {
        write(
            &out_dir,
            "i18n.rs",
            &generate(&upstream, strict, pseudo, true),
        );
        return;
    }
    let overlay = std::fs::read_to_string(&overlay_path)
        .unwrap_or_else(|error| panic!("cannot read {}: {error}", overlay_path.display()))
        .parse::<Table>()
        .unwrap_or_else(|error| panic!("{}: {error}", overlay_path.display()));
    let shipped = rewrite(&upstream, |code, table| {
        apply_overlay(table, &overlay, code == "en", "");
        brand_table(table, "");
        refuse_upstream_services(table, code, "");
    });
    // Upstream's i18n tests pin the catalog to its English literals, so the
    // test build compiles the unbranded catalog and the fork's own tests
    // check the shipped one through `i18n_shipped`. The application menu
    // items are the exception: those tests spell them with `menus::APP_NAME`.
    let tested = rewrite(&upstream, |_, table| {
        for key in NAMED_BY_APP_NAME {
            brand_key(table, key);
        }
    });
    write(&out_dir, SHIPPED, &generate(&shipped, strict, pseudo, true));
    write(
        &out_dir,
        UPSTREAM,
        &generate(&tested, strict, pseudo, false),
    );
    write(
        &out_dir,
        "i18n.rs",
        &format!(
            "#[cfg(not(test))]\ninclude!(concat!(env!(\"OUT_DIR\"), \"/{SHIPPED}\"));\n\
         #[cfg(test)]\ninclude!(concat!(env!(\"OUT_DIR\"), \"/{UPSTREAM}\"));\n"
        ),
    );
}

fn rewrite(
    catalogs: &[(String, String)],
    edit: impl Fn(&str, &mut Table),
) -> Vec<(String, String)> {
    catalogs
        .iter()
        .map(|(code, text)| {
            let mut table = text
                .parse::<Table>()
                .unwrap_or_else(|error| panic!("{code}.toml: {error}"));
            edit(code, &mut table);
            let text = toml::to_string(&table)
                .unwrap_or_else(|error| panic!("{code}.toml: cannot rewrite: {error}"));
            (code.clone(), text)
        })
        .collect()
}

fn brand_key(table: &mut Table, key: &str) {
    let (group, name) = key.rsplit_once('.').unwrap_or(("", key));
    let mut table = table;
    for part in group.split('.').filter(|part| !part.is_empty()) {
        let Some(Value::Table(inner)) = table.get_mut(part) else {
            return;
        };
        table = inner;
    }
    match table.get_mut(name) {
        Some(Value::String(text)) => *text = fork_brand::text(text),
        Some(Value::Table(message)) => {
            if let Some(Value::String(text)) = message.get_mut("text") {
                *text = fork_brand::text(text);
            }
        }
        _ => {}
    }
}

fn generate(catalogs: &[(String, String)], strict: bool, pseudo: bool, report: bool) -> String {
    let borrowed: Vec<(&str, &str)> = catalogs
        .iter()
        .map(|(code, text)| (code.as_str(), text.as_str()))
        .collect();
    let output = cap_i18n_build::generate_with(&borrowed, strict, pseudo)
        .unwrap_or_else(|errors| fail(&errors));
    for warning in output.warnings.iter().filter(|_| report) {
        for line in warning.lines() {
            println!("cargo:warning={line}");
        }
    }
    output.code
}

fn write(out_dir: &Path, name: &str, code: &str) {
    let path = out_dir.join(name);
    if let Err(error) = std::fs::write(&path, code) {
        panic!("cannot write {}: {error}", path.display());
    }
}

fn fail(errors: &[String]) -> ! {
    panic!(
        "{} problem(s) in the locale catalogs:\n{}",
        errors.len(),
        errors.join("\n")
    )
}

fn join(prefix: &str, name: &str) -> String {
    if prefix.is_empty() {
        name.to_string()
    } else {
        format!("{prefix}.{name}")
    }
}

// Fork wording replaces every locale with the same English, which is what
// the old per-call-site override did; writing it into each catalog keeps
// CAP_I18N_STRICT from reporting the keys as untranslated.
fn apply_overlay(table: &mut Table, overlay: &Table, english: bool, prefix: &str) {
    for (name, value) in overlay {
        let key = join(prefix, name);
        match value {
            Value::Table(inner) => {
                let Some(Value::Table(target)) = table.get_mut(name) else {
                    panic!("{OVERLAY}: `{key}` is not a group in the catalogs");
                };
                apply_overlay(target, inner, english, &key);
            }
            Value::String(text) => match table.get_mut(name) {
                Some(Value::Table(message)) if english && message.contains_key("text") => {
                    message.insert("text".into(), Value::String(text.clone()));
                }
                Some(Value::Table(_)) if english => {
                    panic!("{OVERLAY}: `{key}` is a plural message")
                }
                None if english => panic!("{OVERLAY}: `{key}` is not in en.toml"),
                _ => {
                    table.insert(name.clone(), Value::String(text.clone()));
                }
            },
            _ => panic!("{OVERLAY}: `{key}` must be a string"),
        }
    }
}

fn kept(key: &str) -> bool {
    fork_brand::KEEP_UPSTREAM_NAME.iter().any(|kept| {
        key.strip_prefix(kept)
            .is_some_and(|rest| rest.is_empty() || rest.starts_with('.'))
    })
}

fn refuse_upstream_services(table: &Table, code: &str, prefix: &str) {
    for (name, value) in table {
        let key = join(prefix, name);
        match value {
            Value::String(text) => {
                if let Some(host) = fork_brand::upstream_service_host(text) {
                    panic!("{code}.toml: `{key}` sends people to {host}; override it in {OVERLAY}")
                }
            }
            Value::Table(inner) => refuse_upstream_services(inner, code, &key),
            _ => {}
        }
    }
}

fn brand_table(table: &mut Table, prefix: &str) {
    for (name, value) in table.iter_mut() {
        if name == "context" {
            continue;
        }
        let key = join(prefix, name);
        match value {
            Value::String(text) => {
                if !kept(&key) {
                    *text = fork_brand::text(text);
                }
                *text = text
                    .replace(UPSTREAM_TOKEN, fork_brand::UPSTREAM_NAME)
                    .replace(RELEASES_TOKEN, fork_brand::RELEASES_URL)
                    .replace(CLI_TOKEN, fork_brand::CLI_NAME);
            }
            Value::Table(inner) => brand_table(inner, &key),
            _ => {}
        }
    }
}
