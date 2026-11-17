use std::path::Path;

#[test]
fn shipped_catalogs_translate_every_key() {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../locales");
    let catalogs =
        cap_i18n_build::read_catalogs(&dir).unwrap_or_else(|errors| panic!("{errors:?}"));
    let codes: Vec<&str> = catalogs.iter().map(|(code, _)| code.as_str()).collect();
    let mut expected: Vec<&str> = cap_i18n_build::LOCALES
        .iter()
        .map(|spec| spec.code)
        .collect();
    expected.sort();
    assert_eq!(codes, expected);
    let borrowed: Vec<(&str, &str)> = catalogs
        .iter()
        .map(|(code, text)| (code.as_str(), text.as_str()))
        .collect();
    let output = cap_i18n_build::generate(&borrowed, true)
        .unwrap_or_else(|errors| panic!("{}", errors.join("\n")));
    assert!(output.warnings.is_empty(), "{:?}", output.warnings);
}
