use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

use toml::{Table, Value};

pub const STRICT_ENV: &str = "CAP_I18N_STRICT";

pub static PSEUDO: LocaleSpec = LocaleSpec {
    code: "pseudo",
    ident: "Pseudo",
    endonym: "Pseudo",
    plural: ONE_IS_ONE,
};

const PSEUDO_PADDING: &str = "ļöŕéṁ îþšûṁ ðöļöŕ šîţ åṁéţ ";

const MESSAGE_FIELDS: [&str; 8] = [
    "text", "one", "few", "many", "other", "context", "max_px", "size",
];

const KEYWORDS: &[&str] = &[
    "abstract", "as", "async", "await", "become", "box", "break", "const", "continue", "crate",
    "do", "dyn", "else", "enum", "extern", "false", "final", "fn", "for", "gen", "if", "impl",
    "in", "let", "loop", "macro", "match", "mod", "move", "mut", "override", "priv", "pub", "ref",
    "return", "self", "static", "struct", "super", "trait", "true", "try", "type", "typeof",
    "union", "unsafe", "unsized", "use", "virtual", "where", "while", "yield",
];

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Category {
    One,
    Few,
    Many,
    Other,
}

impl Category {
    pub const ALL: [Category; 4] = [
        Category::One,
        Category::Few,
        Category::Many,
        Category::Other,
    ];

    pub fn name(self) -> &'static str {
        match self {
            Category::One => "one",
            Category::Few => "few",
            Category::Many => "many",
            Category::Other => "other",
        }
    }

    fn from_name(name: &str) -> Option<Self> {
        Self::ALL
            .into_iter()
            .find(|category| category.name() == name)
    }

    fn variant(self) -> &'static str {
        match self {
            Category::One => "One",
            Category::Few => "Few",
            Category::Many => "Many",
            Category::Other => "Other",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OneRule {
    Never,
    ExactlyOne,
    ZeroOrOne,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PluralRule {
    pub one: OneRule,
    pub many_millions: bool,
}

impl PluralRule {
    pub fn category(self, n: usize) -> Category {
        let one = match self.one {
            OneRule::Never => false,
            OneRule::ExactlyOne => n == 1,
            OneRule::ZeroOrOne => n <= 1,
        };
        if one {
            Category::One
        } else if self.many_millions && n != 0 && n.is_multiple_of(1_000_000) {
            Category::Many
        } else {
            Category::Other
        }
    }

    pub fn categories(self) -> Vec<Category> {
        let mut categories = Vec::new();
        if self.one != OneRule::Never {
            categories.push(Category::One);
        }
        if self.many_millions {
            categories.push(Category::Many);
        }
        categories.push(Category::Other);
        categories
    }

    fn required(self) -> impl Iterator<Item = Category> {
        self.categories()
            .into_iter()
            .filter(|category| *category != Category::Many)
    }
}

#[derive(Debug)]
pub struct LocaleSpec {
    pub code: &'static str,
    pub ident: &'static str,
    pub endonym: &'static str,
    pub plural: PluralRule,
}

const ONE_IS_ONE: PluralRule = PluralRule {
    one: OneRule::ExactlyOne,
    many_millions: false,
};

const ZERO_AND_ONE_ARE_ONE: PluralRule = PluralRule {
    one: OneRule::ZeroOrOne,
    many_millions: false,
};

const NO_PLURALS: PluralRule = PluralRule {
    one: OneRule::Never,
    many_millions: false,
};

pub const LOCALES: &[LocaleSpec] = &[
    LocaleSpec {
        code: "en",
        ident: "En",
        endonym: "English",
        plural: ONE_IS_ONE,
    },
    LocaleSpec {
        code: "zh-CN",
        ident: "ZhCn",
        endonym: "简体中文",
        plural: NO_PLURALS,
    },
    LocaleSpec {
        code: "ja",
        ident: "Ja",
        endonym: "日本語",
        plural: NO_PLURALS,
    },
    LocaleSpec {
        code: "fr",
        ident: "Fr",
        endonym: "Français",
        plural: PluralRule {
            one: OneRule::ZeroOrOne,
            many_millions: true,
        },
    },
    LocaleSpec {
        code: "es",
        ident: "Es",
        endonym: "Español",
        plural: PluralRule {
            one: OneRule::ExactlyOne,
            many_millions: true,
        },
    },
    LocaleSpec {
        code: "de",
        ident: "De",
        endonym: "Deutsch",
        plural: ONE_IS_ONE,
    },
    LocaleSpec {
        code: "hi",
        ident: "Hi",
        endonym: "हिन्दी",
        plural: ZERO_AND_ONE_ARE_ONE,
    },
];

#[derive(Debug)]
pub struct Output {
    pub code: String,
    pub warnings: Vec<String>,
    pub keys: usize,
}

pub fn build(locales: impl AsRef<Path>) {
    let manifest_dir = env_path("CARGO_MANIFEST_DIR");
    let out_dir = env_path("OUT_DIR");
    let locales = manifest_dir.join(locales);
    println!("cargo:rerun-if-changed={}", locales.display());
    println!("cargo:rerun-if-env-changed={STRICT_ENV}");
    let strict = std::env::var(STRICT_ENV).is_ok_and(|value| value == "1");
    let pseudo = std::env::var_os("CARGO_CFG_DEBUG_ASSERTIONS").is_some();

    let catalogs = read_catalogs(&locales).unwrap_or_else(|errors| fail(&errors));
    let borrowed: Vec<(&str, &str)> = catalogs
        .iter()
        .map(|(code, text)| (code.as_str(), text.as_str()))
        .collect();
    let output = generate_with(&borrowed, strict, pseudo).unwrap_or_else(|errors| fail(&errors));
    for warning in &output.warnings {
        for line in warning.lines() {
            println!("cargo:warning={line}");
        }
    }
    let path = out_dir.join("i18n.rs");
    if let Err(error) = std::fs::write(&path, output.code) {
        panic!("cap-i18n-build: cannot write {}: {error}", path.display());
    }
}

fn env_path(name: &str) -> PathBuf {
    std::env::var_os(name)
        .map(PathBuf::from)
        .unwrap_or_else(|| panic!("cap-i18n-build: {name} is unset; call build() from build.rs"))
}

fn fail(errors: &[String]) -> ! {
    panic!(
        "cap-i18n-build found {} problem(s) in the locale catalogs:\n{}",
        errors.len(),
        errors.join("\n")
    )
}

pub fn read_catalogs(dir: &Path) -> Result<Vec<(String, String)>, Vec<String>> {
    let entries = std::fs::read_dir(dir)
        .map_err(|error| vec![format!("cannot read {}: {error}", dir.display())])?;
    let mut catalogs = Vec::new();
    let mut errors = Vec::new();
    for entry in entries {
        let path = match entry {
            Ok(entry) => entry.path(),
            Err(error) => {
                errors.push(format!("cannot read {}: {error}", dir.display()));
                continue;
            }
        };
        if path.extension().and_then(|extension| extension.to_str()) != Some("toml") {
            continue;
        }
        let Some(code) = path.file_stem().and_then(|stem| stem.to_str()) else {
            errors.push(format!("{} has a non UTF-8 name", path.display()));
            continue;
        };
        match std::fs::read_to_string(&path) {
            Ok(text) => catalogs.push((code.to_string(), text)),
            Err(error) => errors.push(format!("cannot read {}: {error}", path.display())),
        }
    }
    catalogs.sort();
    if errors.is_empty() {
        Ok(catalogs)
    } else {
        Err(errors)
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum Piece {
    Text(String),
    Arg(String),
}

#[derive(Clone, Debug)]
struct Template {
    source: String,
    pieces: Vec<Piece>,
}

impl Template {
    fn parse(source: &str) -> Result<Self, String> {
        let mut pieces = Vec::new();
        let mut text = String::new();
        let mut chars = source.chars().peekable();
        while let Some(c) = chars.next() {
            match c {
                '{' if chars.peek() == Some(&'{') => {
                    chars.next();
                    text.push('{');
                }
                '}' if chars.peek() == Some(&'}') => {
                    chars.next();
                    text.push('}');
                }
                '{' => {
                    let mut name = String::new();
                    loop {
                        match chars.next() {
                            Some('}') => break,
                            Some(c) => name.push(c),
                            None => {
                                return Err(format!(
                                    "unclosed `{{` in {source:?}; write `{{{{` for a literal brace"
                                ));
                            }
                        }
                    }
                    if !is_identifier(&name) {
                        return Err(format!(
                            "`{{{name}}}` in {source:?} is not a placeholder; placeholders are \
                             lowercase snake_case names and literal braces are written `{{{{` and `}}}}`"
                        ));
                    }
                    if !text.is_empty() {
                        pieces.push(Piece::Text(std::mem::take(&mut text)));
                    }
                    pieces.push(Piece::Arg(name));
                }
                '}' => {
                    return Err(format!(
                        "unmatched `}}` in {source:?}; write `}}}}` for a literal brace"
                    ));
                }
                c => text.push(c),
            }
        }
        if !text.is_empty() {
            pieces.push(Piece::Text(text));
        }
        Ok(Self {
            source: source.to_string(),
            pieces,
        })
    }

    fn args(&self) -> Vec<&str> {
        let mut args: Vec<&str> = Vec::new();
        for piece in &self.pieces {
            if let Piece::Arg(name) = piece
                && !args.contains(&name.as_str())
            {
                args.push(name);
            }
        }
        args
    }

    fn arg_set(&self) -> BTreeSet<&str> {
        self.args().into_iter().collect()
    }

    fn non_count_args(&self) -> BTreeSet<&str> {
        self.args()
            .into_iter()
            .filter(|arg| *arg != "count")
            .collect()
    }

    fn plain(&self) -> String {
        self.pieces
            .iter()
            .map(|piece| match piece {
                Piece::Text(text) => text.as_str(),
                Piece::Arg(_) => "",
            })
            .collect()
    }

    fn expression(&self) -> String {
        if self.args().is_empty() {
            return format!("String::from({:?})", self.plain());
        }
        let mut format = String::new();
        for piece in &self.pieces {
            match piece {
                Piece::Text(text) => format.push_str(&text.replace('{', "{{").replace('}', "}}")),
                Piece::Arg(name) => {
                    format.push('{');
                    format.push_str(name);
                    format.push('}');
                }
            }
        }
        format!("format!({format:?})")
    }
}

fn accent(c: char) -> char {
    const UPPER: [char; 26] = [
        'Å', 'Ɓ', 'Ç', 'Ð', 'É', 'Ƒ', 'Ĝ', 'Ĥ', 'Î', 'Ĵ', 'Ķ', 'Ļ', 'Ṁ', 'Ñ', 'Ö', 'Þ', 'Ǫ', 'Ŕ',
        'Š', 'Ţ', 'Û', 'Ṽ', 'Ŵ', 'Ẋ', 'Ý', 'Ž',
    ];
    const LOWER: [char; 26] = [
        'å', 'ƀ', 'ç', 'ð', 'é', 'ƒ', 'ĝ', 'ĥ', 'î', 'ĵ', 'ķ', 'ļ', 'ṁ', 'ñ', 'ö', 'þ', 'ǫ', 'ŕ',
        'š', 'ţ', 'û', 'ṽ', 'ŵ', 'ẋ', 'ý', 'ž',
    ];
    match c {
        'A'..='Z' => UPPER[c as usize - 'A' as usize],
        'a'..='z' => LOWER[c as usize - 'a' as usize],
        c => c,
    }
}

fn pseudo_template(template: &Template) -> Template {
    let mut text = String::from("⟦");
    let mut pieces = Vec::new();
    let mut letters = 0;
    for piece in &template.pieces {
        match piece {
            Piece::Text(value) => {
                letters += value.chars().filter(|c| c.is_alphanumeric()).count();
                text.extend(value.chars().map(accent));
            }
            Piece::Arg(name) => {
                pieces.push(Piece::Text(std::mem::take(&mut text)));
                pieces.push(Piece::Arg(name.clone()));
            }
        }
    }
    text.extend(
        PSEUDO_PADDING
            .chars()
            .cycle()
            .take((letters * 2).div_ceil(5)),
    );
    text.push('⟧');
    pieces.push(Piece::Text(text));
    pieces.retain(|piece| !matches!(piece, Piece::Text(value) if value.is_empty()));
    let source = pieces
        .iter()
        .map(|piece| match piece {
            Piece::Text(value) => value.replace('{', "{{").replace('}', "}}"),
            Piece::Arg(name) => format!("{{{name}}}"),
        })
        .collect();
    Template { source, pieces }
}

fn pseudo_forms(forms: &Forms) -> Forms {
    match forms {
        Forms::Text(template) => Forms::Text(pseudo_template(template)),
        Forms::Plural(forms) => Forms::Plural(
            forms
                .iter()
                .map(|(category, template)| (*category, pseudo_template(template)))
                .collect(),
        ),
    }
}

fn is_identifier(name: &str) -> bool {
    let mut chars = name.chars();
    chars.next().is_some_and(|first| first.is_ascii_lowercase())
        && chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_')
        && !KEYWORDS.contains(&name)
}

fn check_segment(name: &str) -> Result<(), String> {
    if MESSAGE_FIELDS.contains(&name) {
        return Err(format!(
            "`{name}` is reserved for message fields and cannot name a key"
        ));
    }
    if !is_identifier(name) {
        return Err(format!(
            "`{name}` is not a valid key segment; use lowercase snake_case that is not a Rust keyword"
        ));
    }
    Ok(())
}

#[derive(Clone, Debug)]
enum Raw {
    Text(String),
    Plural(BTreeMap<Category, String>),
}

#[derive(Clone, Copy, Debug, PartialEq)]
struct Fit {
    max_px: f64,
    size: f64,
}

#[derive(Clone, Debug)]
struct Entry {
    raw: Raw,
    context: Option<String>,
    fit: Option<Fit>,
}

#[derive(Clone, Debug)]
enum Forms {
    Text(Template),
    Plural(BTreeMap<Category, Template>),
}

struct Message {
    context: Option<String>,
    fit: Option<Fit>,
    english: Forms,
    translations: Vec<Option<Forms>>,
}

fn parse_catalog(
    code: &str,
    text: &str,
    source: bool,
    errors: &mut Vec<String>,
) -> BTreeMap<String, Entry> {
    let file = format!("{code}.toml");
    let mut entries = BTreeMap::new();
    match text.parse::<Table>() {
        Ok(table) => flatten(&file, &table, "", source, &mut entries, errors),
        Err(error) => errors.push(format!("{file}: {error}")),
    }
    entries
}

fn flatten(
    file: &str,
    table: &Table,
    prefix: &str,
    source: bool,
    entries: &mut BTreeMap<String, Entry>,
    errors: &mut Vec<String>,
) {
    for (name, value) in table.iter() {
        let key = if prefix.is_empty() {
            name.clone()
        } else {
            format!("{prefix}.{name}")
        };
        if let Err(error) = check_segment(name) {
            errors.push(format!("{file}: `{key}`: {error}"));
            continue;
        }
        match value {
            Value::String(text) => {
                entries.insert(
                    key,
                    Entry {
                        raw: Raw::Text(text.clone()),
                        context: None,
                        fit: None,
                    },
                );
            }
            Value::Table(inner)
                if inner
                    .keys()
                    .any(|field| MESSAGE_FIELDS.contains(&field.as_str())) =>
            {
                match parse_message_table(inner, source) {
                    Ok(entry) => {
                        entries.insert(key, entry);
                    }
                    Err(error) => errors.push(format!("{file}: `{key}`: {error}")),
                }
            }
            Value::Table(inner) => flatten(file, inner, &key, source, entries, errors),
            _ => errors.push(format!("{file}: `{key}`: expected a string or a table")),
        }
    }
}

fn parse_message_table(table: &Table, source: bool) -> Result<Entry, String> {
    let mut text = None;
    let mut context = None;
    let mut max_px = None;
    let mut size = None;
    let mut forms = BTreeMap::new();
    for (field, value) in table.iter() {
        match field.as_str() {
            "text" if source => text = Some(expect_string(field, value)?),
            "context" if source => context = Some(expect_string(field, value)?),
            "max_px" if source => max_px = Some(expect_positive_number(field, value)?),
            "size" if source => size = Some(expect_positive_number(field, value)?),
            name => match Category::from_name(name) {
                Some(category) => {
                    forms.insert(category, expect_string(field, value)?);
                }
                None if MESSAGE_FIELDS.contains(&name) => {
                    return Err(format!(
                        "`{name}` belongs in en.toml only; translations hold a string or plural forms"
                    ));
                }
                None => {
                    return Err(format!(
                        "`{name}` sits beside message fields; a table is either a message \
                         (text, one, few, many, other, context, max_px, size) or a group of keys"
                    ));
                }
            },
        }
    }
    let raw = match (text, forms.is_empty()) {
        (Some(text), true) => Raw::Text(text),
        (None, false) => Raw::Plural(forms),
        (Some(_), false) => return Err("has both `text` and plural forms".to_string()),
        (None, true) => return Err("has neither `text` nor plural forms".to_string()),
    };
    let fit = match (max_px, size) {
        (Some(max_px), Some(size)) => Some(Fit { max_px, size }),
        (None, None) => None,
        _ => {
            return Err(
                "`max_px` and `size` go together: the width budget and the font size it is \
                 measured at"
                    .to_string(),
            );
        }
    };
    if fit.is_some() && !matches!(raw, Raw::Text(_)) {
        return Err("`max_px` is only measured on plain strings".to_string());
    }
    Ok(Entry { raw, context, fit })
}

fn expect_string(field: &str, value: &Value) -> Result<String, String> {
    match value {
        Value::String(text) => Ok(text.clone()),
        _ => Err(format!("`{field}` must be a string")),
    }
}

fn expect_positive_number(field: &str, value: &Value) -> Result<f64, String> {
    match value {
        Value::Integer(number) if *number > 0 => Ok(*number as f64),
        Value::Float(number) if *number > 0.0 => Ok(*number),
        _ => Err(format!("`{field}` must be a positive number")),
    }
}

fn leading_whitespace(text: &str) -> &str {
    &text[..text.len() - text.trim_start().len()]
}

fn trailing_whitespace(text: &str) -> &str {
    &text[text.trim_end().len()..]
}

fn check_value(value: &str, english: Option<&str>) -> Result<Template, String> {
    if value.trim().is_empty() {
        return Err("value is empty".to_string());
    }
    if let Some(english) = english
        && (leading_whitespace(value) != leading_whitespace(english)
            || trailing_whitespace(value) != trailing_whitespace(english))
    {
        return Err(format!(
            "leading or trailing whitespace differs from English {english:?}"
        ));
    }
    Template::parse(value)
}

fn placeholder_list(args: &BTreeSet<&str>) -> String {
    if args.is_empty() {
        return "(none)".to_string();
    }
    args.iter()
        .map(|arg| format!("{{{arg}}}"))
        .collect::<Vec<_>>()
        .join(", ")
}

fn same_placeholders(english: &BTreeSet<&str>, translated: &BTreeSet<&str>) -> Result<(), String> {
    if english == translated {
        return Ok(());
    }
    Err(format!(
        "placeholders {} do not match English {}",
        placeholder_list(translated),
        placeholder_list(english)
    ))
}

fn plural_forms(
    spec: &LocaleSpec,
    values: &BTreeMap<Category, String>,
    english_other: Option<&str>,
) -> Result<BTreeMap<Category, Template>, String> {
    let allowed = spec.plural.categories();
    for category in values.keys() {
        if !allowed.contains(category) {
            return Err(format!(
                "`{}` is not a plural form in {}, which uses {}",
                category.name(),
                spec.code,
                allowed
                    .iter()
                    .map(|category| category.name())
                    .collect::<Vec<_>>()
                    .join(", ")
            ));
        }
    }
    for category in spec.plural.required() {
        if !values.contains_key(&category) {
            return Err(format!("missing the `{}` plural form", category.name()));
        }
    }
    values
        .iter()
        .map(|(category, value)| {
            check_value(value, english_other)
                .map(|template| (*category, template))
                .map_err(|error| format!("`{}` form: {error}", category.name()))
        })
        .collect()
}

fn english_forms(raw: &Raw) -> Result<Forms, String> {
    match raw {
        Raw::Text(value) => Ok(Forms::Text(check_value(value, None)?)),
        Raw::Plural(values) => {
            let forms = plural_forms(&LOCALES[0], values, None)?;
            let expected = forms[&Category::Other].non_count_args();
            for (category, template) in &forms {
                same_placeholders(&expected, &template.non_count_args()).map_err(|error| {
                    format!("`{}` form against `other`: {error}", category.name())
                })?;
            }
            Ok(Forms::Plural(forms))
        }
    }
}

fn translated_forms(spec: &LocaleSpec, english: &Forms, raw: &Raw) -> Result<Forms, String> {
    match (english, raw) {
        (Forms::Text(english), Raw::Text(value)) => {
            let template = check_value(value, Some(english.source.as_str()))?;
            same_placeholders(&english.arg_set(), &template.arg_set())?;
            Ok(Forms::Text(template))
        }
        (Forms::Plural(english), Raw::Plural(values)) => {
            let english_other = &english[&Category::Other];
            let forms = plural_forms(spec, values, Some(english_other.source.as_str()))?;
            let expected = english_other.non_count_args();
            for (category, template) in &forms {
                same_placeholders(&expected, &template.non_count_args())
                    .map_err(|error| format!("`{}` form: {error}", category.name()))?;
            }
            Ok(Forms::Plural(forms))
        }
        (Forms::Text(_), Raw::Plural(_)) => {
            Err("English is a single string, so the translation must be one too".to_string())
        }
        (Forms::Plural(_), Raw::Text(_)) => Err(
            "English has plural forms, so the translation needs them too, for example \
             `{ other = \"...\" }`"
                .to_string(),
        ),
    }
}

pub fn generate(catalogs: &[(&str, &str)], strict: bool) -> Result<Output, Vec<String>> {
    generate_with(catalogs, strict, false)
}

/// `pseudo` appends a generated [`PSEUDO`] locale, which debug builds offer in
/// the language picker to show untranslated and overflowing text.
pub fn generate_with(
    catalogs: &[(&str, &str)],
    strict: bool,
    pseudo: bool,
) -> Result<Output, Vec<String>> {
    let mut errors = Vec::new();
    let mut warnings = Vec::new();

    let mut found: Vec<(&'static LocaleSpec, &str)> = Vec::new();
    for &(code, text) in catalogs {
        match LOCALES.iter().find(|spec| spec.code == code) {
            Some(_) if found.iter().any(|(spec, _)| spec.code == code) => {
                errors.push(format!("{code}.toml is listed twice"));
            }
            Some(spec) => found.push((spec, text)),
            None => errors.push(format!(
                "{code}.toml: unknown locale; expected one of {}",
                LOCALES
                    .iter()
                    .map(|spec| spec.code)
                    .collect::<Vec<_>>()
                    .join(", ")
            )),
        }
    }
    found.sort_by_key(|(spec, _)| LOCALES.iter().position(|known| known.code == spec.code));
    if found.first().is_none_or(|(spec, _)| spec.code != "en") {
        errors.push("en.toml is missing; English is the source catalog".to_string());
        return Err(errors);
    }

    let mut locales: Vec<&LocaleSpec> = found.iter().map(|(spec, _)| *spec).collect();
    let catalogs: Vec<BTreeMap<String, Entry>> = found
        .iter()
        .enumerate()
        .map(|(position, (spec, text))| parse_catalog(spec.code, text, position == 0, &mut errors))
        .collect();

    let mut messages = BTreeMap::new();
    for (key, entry) in &catalogs[0] {
        match english_forms(&entry.raw) {
            Ok(english) => {
                messages.insert(
                    key.clone(),
                    Message {
                        context: entry.context.clone(),
                        fit: entry.fit,
                        english,
                        translations: vec![None; locales.len()],
                    },
                );
            }
            Err(error) => errors.push(format!("en.toml: `{key}`: {error}")),
        }
    }

    let total = messages.len();
    for (position, spec) in locales.iter().enumerate().skip(1) {
        let catalog = &catalogs[position];
        for key in catalog.keys().filter(|key| !messages.contains_key(*key)) {
            warnings.push(format!(
                "{}.toml: `{key}` is not in en.toml and is ignored",
                spec.code
            ));
        }
        let mut missing = Vec::new();
        for (key, message) in &mut messages {
            match catalog.get(key) {
                Some(entry) => match translated_forms(spec, &message.english, &entry.raw) {
                    Ok(forms) => message.translations[position] = Some(forms),
                    Err(error) => errors.push(format!("{}.toml: `{key}`: {error}", spec.code)),
                },
                None => missing.push(key.clone()),
            }
        }
        if !missing.is_empty() {
            let mut preview = missing
                .iter()
                .take(8)
                .map(|key| format!("`{key}`"))
                .collect::<Vec<_>>()
                .join(", ");
            if missing.len() > 8 {
                preview.push_str(", ...");
            }
            let note = format!(
                "{}.toml: {} of {total} keys fall back to English: {preview}",
                spec.code,
                missing.len()
            );
            if strict {
                errors.push(note);
            } else {
                warnings.push(note);
            }
        }
    }

    if !errors.is_empty() {
        return Err(errors);
    }
    if pseudo {
        locales.push(&PSEUDO);
        for message in messages.values_mut() {
            let forms = pseudo_forms(&message.english);
            message.translations.push(Some(forms));
        }
    }
    Ok(Output {
        code: emit(&locales, &messages),
        warnings,
        keys: total,
    })
}

#[derive(Default)]
struct Code {
    out: String,
    depth: usize,
}

impl Code {
    fn line(&mut self, text: impl AsRef<str>) {
        let text = text.as_ref();
        if !text.is_empty() {
            for _ in 0..self.depth {
                self.out.push_str("    ");
            }
            self.out.push_str(text);
        }
        self.out.push('\n');
    }

    fn open(&mut self, text: impl AsRef<str>) {
        self.line(text);
        self.depth += 1;
    }

    fn close(&mut self, text: impl AsRef<str>) {
        self.depth -= 1;
        self.line(text);
    }

    fn reopen(&mut self, text: impl AsRef<str>) {
        self.depth -= 1;
        self.line(text);
        self.depth += 1;
    }

    fn arm(&mut self, pattern: &str, lines: &[String]) {
        let last = lines.len() - 1;
        for (index, line) in lines.iter().enumerate() {
            let prefix = if index == 0 {
                format!("{pattern} => ")
            } else {
                String::new()
            };
            let suffix = if index == last { "," } else { "" };
            self.line(format!("{prefix}{line}{suffix}"));
        }
    }
}

#[derive(Default)]
struct Node<'a> {
    children: BTreeMap<&'a str, Node<'a>>,
    leaves: Vec<(&'a str, &'a str)>,
}

struct Context<'a> {
    locales: &'a [&'a LocaleSpec],
    messages: &'a BTreeMap<String, Message>,
    text_ids: BTreeMap<&'a str, usize>,
}

fn plain_text(forms: &Forms) -> Option<&Template> {
    match forms {
        Forms::Text(template) if template.args().is_empty() => Some(template),
        _ => None,
    }
}

fn plural_fn(spec: &LocaleSpec) -> String {
    format!("plural_{}", spec.ident.to_ascii_lowercase())
}

fn emit(locales: &[&LocaleSpec], messages: &BTreeMap<String, Message>) -> String {
    let mut code = Code::default();
    code.line(
        "// @generated by cap-i18n-build from the locale catalogs. Edit those, not this file.",
    );
    code.line("");
    emit_locales(&mut code, locales);

    let texts: Vec<(&str, &Message)> = messages
        .iter()
        .filter(|(_, message)| plain_text(&message.english).is_some())
        .map(|(key, message)| (key.as_str(), message))
        .collect();
    if !texts.is_empty() {
        code.line("");
        code.line(format!("const LOCALE_COUNT: usize = {};", locales.len()));
        code.line(format!("const TEXT_COUNT: usize = {};", texts.len()));
        code.line("");
        code.open("static TEXT: [[&str; TEXT_COUNT]; LOCALE_COUNT] = [");
        for position in 0..locales.len() {
            code.open("[");
            for (_, message) in &texts {
                let template = message.translations[position]
                    .as_ref()
                    .and_then(plain_text)
                    .or_else(|| plain_text(&message.english));
                if let Some(template) = template {
                    code.line(format!("{:?},", template.plain()));
                }
            }
            code.close("],");
        }
        code.close("];");
        code.line("");
        code.open("fn text(id: usize) -> &'static str {");
        code.line("TEXT[index()][id]");
        code.close("}");
        emit_fits(&mut code, locales, &texts);
    }

    let mut plural_users = BTreeSet::new();
    for message in messages.values() {
        if !matches!(message.english, Forms::Plural(_)) {
            continue;
        }
        for (position, spec) in locales.iter().enumerate() {
            let has_forms = position == 0 || message.translations[position].is_some();
            if has_forms && spec.plural.categories().len() > 1 {
                plural_users.insert(position);
            }
        }
    }
    if !plural_users.is_empty() {
        let variants: BTreeSet<Category> = plural_users
            .iter()
            .flat_map(|position| locales[*position].plural.categories())
            .collect();
        code.line("");
        code.line("#[derive(Clone, Copy, Debug, PartialEq, Eq)]");
        code.open("enum Plural {");
        for variant in &variants {
            code.line(format!("{},", variant.variant()));
        }
        code.close("}");
        for position in &plural_users {
            code.line("");
            emit_rule(&mut code, locales[*position]);
        }
    }

    code.line("");
    code.line("#[cfg(test)]");
    code.open(format!("pub const KEYS: [&str; {}] = [", messages.len()));
    for key in messages.keys() {
        code.line(format!("{key:?},"));
    }
    code.close("];");

    let mut root = Node::default();
    for key in messages.keys() {
        let segments: Vec<&str> = key.split('.').collect();
        let Some((name, path)) = segments.split_last() else {
            continue;
        };
        let mut node = &mut root;
        for segment in path {
            node = node.children.entry(*segment).or_default();
        }
        node.leaves.push((*name, key.as_str()));
    }
    let context = Context {
        locales,
        messages,
        text_ids: texts
            .iter()
            .enumerate()
            .map(|(id, (key, _))| (*key, id))
            .collect(),
    };
    code.line("");
    code.open("pub mod tr {");
    emit_node(&mut code, &root, 1, &context);
    code.close("}");
    code.out
}

fn emit_fits(code: &mut Code, locales: &[&LocaleSpec], texts: &[(&str, &Message)]) {
    let fits: Vec<(&str, Fit, Vec<String>)> = texts
        .iter()
        .filter_map(|(key, message)| {
            let fit = message.fit?;
            let text = (0..locales.len())
                .map(|position| {
                    message.translations[position]
                        .as_ref()
                        .and_then(plain_text)
                        .or_else(|| plain_text(&message.english))
                        .map(Template::plain)
                        .unwrap_or_default()
                })
                .collect();
            Some((*key, fit, text))
        })
        .collect();
    if fits.is_empty() {
        return;
    }
    code.line("");
    code.line("#[cfg(test)]");
    code.open("pub struct Fit {");
    code.line("pub key: &'static str,");
    code.line("pub max_px: f32,");
    code.line("pub size: f32,");
    code.line("pub text: [&'static str; LOCALE_COUNT],");
    code.close("}");
    code.line("");
    code.line("#[cfg(test)]");
    code.open(format!("pub const FITS: [Fit; {}] = [", fits.len()));
    for (key, fit, text) in &fits {
        code.open("Fit {");
        code.line(format!("key: {key:?},"));
        code.line(format!("max_px: {:?},", fit.max_px as f32));
        code.line(format!("size: {:?},", fit.size as f32));
        code.open("text: [");
        for value in text {
            code.line(format!("{value:?},"));
        }
        code.close("],");
        code.close("},");
    }
    code.close("];");
}

fn emit_locales(code: &mut Code, locales: &[&LocaleSpec]) {
    code.line("#[allow(dead_code)]");
    code.line("#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]");
    code.line("#[repr(u8)]");
    code.open("pub enum Locale {");
    for (index, spec) in locales.iter().enumerate() {
        code.line(format!("{} = {index},", spec.ident));
    }
    code.close("}");
    code.line("");
    code.line("#[allow(dead_code)]");
    code.open("impl Locale {");
    code.line(format!(
        "pub const ALL: [Locale; {}] = [{}];",
        locales.len(),
        locales
            .iter()
            .map(|spec| format!("Locale::{}", spec.ident))
            .collect::<Vec<_>>()
            .join(", ")
    ));
    emit_locale_field(code, locales, "code", |spec| spec.code);
    emit_locale_field(code, locales, "endonym", |spec| spec.endonym);
    code.line("");
    code.open("pub fn from_code(code: &str) -> Option<Self> {");
    code.open("match code {");
    for spec in locales {
        code.line(format!("{:?} => Some(Locale::{}),", spec.code, spec.ident));
    }
    code.line("_ => None,");
    code.close("}");
    code.close("}");
    code.close("}");
}

fn emit_locale_field(
    code: &mut Code,
    locales: &[&LocaleSpec],
    name: &str,
    field: fn(&LocaleSpec) -> &'static str,
) {
    code.line("");
    code.open(format!("pub const fn {name}(self) -> &'static str {{"));
    code.open("match self {");
    for spec in locales {
        code.line(format!("Locale::{} => {:?},", spec.ident, field(spec)));
    }
    code.close("}");
    code.close("}");
}

fn emit_rule(code: &mut Code, spec: &LocaleSpec) {
    code.open(format!("fn {}(n: usize) -> Plural {{", plural_fn(spec)));
    let mut branches = Vec::new();
    match spec.plural.one {
        OneRule::Never => {}
        OneRule::ExactlyOne => branches.push(("n == 1", Category::One)),
        OneRule::ZeroOrOne => branches.push(("n <= 1", Category::One)),
    }
    if spec.plural.many_millions {
        branches.push(("n != 0 && n.is_multiple_of(1_000_000)", Category::Many));
    }
    if branches.is_empty() {
        code.line("let _ = n;");
        code.line("Plural::Other");
    } else {
        for (index, (condition, category)) in branches.iter().enumerate() {
            if index == 0 {
                code.open(format!("if {condition} {{"));
            } else {
                code.reopen(format!("}} else if {condition} {{"));
            }
            code.line(format!("Plural::{}", category.variant()));
        }
        code.reopen("} else {");
        code.line("Plural::Other");
        code.close("}");
    }
    code.close("}");
}

fn emit_node(code: &mut Code, node: &Node, depth: usize, context: &Context) {
    let mut first = true;
    for (name, key) in &node.leaves {
        if !first {
            code.line("");
        }
        first = false;
        emit_accessor(code, name, key, depth, context);
    }
    for (name, child) in &node.children {
        if !first {
            code.line("");
        }
        first = false;
        code.open(format!("pub mod {name} {{"));
        emit_node(code, child, depth + 1, context);
        code.close("}");
    }
}

fn signature_args(forms: &Forms) -> Vec<&str> {
    match forms {
        Forms::Text(template) => template.args(),
        Forms::Plural(forms) => {
            let mut args = vec!["count"];
            let ordered = forms
                .get(&Category::Other)
                .into_iter()
                .chain(forms.values());
            for template in ordered {
                for arg in template.args() {
                    if !args.contains(&arg) {
                        args.push(arg);
                    }
                }
            }
            args
        }
    }
}

fn expression_lines(forms: &Forms, spec: &LocaleSpec, root: &str) -> Vec<String> {
    match forms {
        Forms::Text(template) => vec![template.expression()],
        Forms::Plural(forms) => {
            let other = forms[&Category::Other].expression();
            if spec.plural.categories().len() == 1 {
                return vec![other];
            }
            let mut lines = vec![format!("match {root}{}(count) {{", plural_fn(spec))];
            for (category, template) in forms {
                if *category != Category::Other {
                    lines.push(format!(
                        "    {root}Plural::{} => {},",
                        category.variant(),
                        template.expression()
                    ));
                }
            }
            lines.push(format!("    _ => {other},"));
            lines.push("}".to_string());
            lines
        }
    }
}

fn emit_accessor(code: &mut Code, name: &str, key: &str, depth: usize, context: &Context) {
    let message = &context.messages[key];
    let root = "super::".repeat(depth);
    let mut doc = match &message.english {
        Forms::Text(template) => format!("`{key}`: {}", template.source),
        Forms::Plural(forms) => format!(
            "`{key}`: {}",
            forms
                .iter()
                .map(|(category, template)| format!("{} = {}", category.name(), template.source))
                .collect::<Vec<_>>()
                .join("; ")
        ),
    };
    if let Some(note) = &message.context {
        doc.push_str("\n\n");
        doc.push_str(note);
    }
    code.line(format!("#[doc = {doc:?}]"));

    if let Some(id) = context.text_ids.get(key) {
        code.open(format!("pub fn {name}() -> &'static str {{"));
        code.line(format!("{root}text({id})"));
        code.close("}");
        return;
    }

    let params = signature_args(&message.english)
        .into_iter()
        .map(|arg| {
            if arg == "count" {
                "count: usize".to_string()
            } else {
                format!("{arg}: impl ::std::fmt::Display")
            }
        })
        .collect::<Vec<_>>()
        .join(", ");
    code.open(format!("pub fn {name}({params}) -> String {{"));
    let english = expression_lines(&message.english, context.locales[0], &root);
    let translated: Vec<(usize, Vec<String>)> = message
        .translations
        .iter()
        .enumerate()
        .filter_map(|(position, forms)| {
            forms.as_ref().map(|forms| {
                (
                    position,
                    expression_lines(forms, context.locales[position], &root),
                )
            })
        })
        .collect();
    if translated.is_empty() {
        for line in &english {
            code.line(line);
        }
    } else {
        code.open(format!("match {root}index() {{"));
        for (position, lines) in &translated {
            code.arm(&position.to_string(), lines);
        }
        code.arm("_", &english);
        code.close("}");
    }
    code.close("}");
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(catalogs: &[(&str, &str)]) -> Result<Output, Vec<String>> {
        generate(catalogs, false)
    }

    fn errors(catalogs: &[(&str, &str)]) -> String {
        match run(catalogs) {
            Ok(_) => panic!("expected the catalogs to be rejected"),
            Err(errors) => errors.join("\n"),
        }
    }

    fn rule(code: &str) -> PluralRule {
        LOCALES
            .iter()
            .find(|spec| spec.code == code)
            .map(|spec| spec.plural)
            .unwrap()
    }

    #[test]
    fn plain_strings_become_static_table_entries() {
        let output = run(&[("en", "[tray]\nopen = \"Open Main Window\"\n")]).unwrap();
        assert_eq!(output.keys, 1);
        assert!(output.code.contains("\"Open Main Window\","));
        assert!(output.code.contains("pub fn open() -> &'static str {"));
        assert!(output.code.contains("super::super::text(0)"));
        assert!(output.code.contains("\"tray.open\","));
    }

    #[test]
    fn placeholders_become_typed_parameters() {
        let output = run(&[(
            "en",
            "[a]\nversion = \"Cap v{version}\"\nitems = \"{count} items in {place}\"\n",
        )])
        .unwrap();
        assert!(
            output
                .code
                .contains("pub fn version(version: impl ::std::fmt::Display) -> String {")
        );
        assert!(output.code.contains("format!(\"Cap v{version}\")"));
        assert!(
            output.code.contains(
                "pub fn items(count: usize, place: impl ::std::fmt::Display) -> String {"
            )
        );
    }

    #[test]
    fn placeholder_mismatch_is_rejected() {
        let en = "[a]\ngreeting = \"Hello, {name}!\"\n";
        let message = errors(&[("en", en), ("fr", "[a]\ngreeting = \"Bonjour, {nom} !\"\n")]);
        assert!(message.contains("fr.toml: `a.greeting`"), "{message}");
        assert!(message.contains("{nom}"), "{message}");
        assert!(message.contains("{name}"), "{message}");

        let message = errors(&[("en", en), ("fr", "[a]\ngreeting = \"Bonjour !\"\n")]);
        assert!(message.contains("(none)"), "{message}");
    }

    #[test]
    fn malformed_braces_are_rejected() {
        for value in [
            "Hello {name",
            "Hello } there",
            "{0}",
            "{Name}",
            "{name:?}",
            "{}",
            "{type}",
            "{a{{b}",
        ] {
            let catalog = format!("[a]\nb = {value:?}\n");
            let message = errors(&[("en", &catalog)]);
            assert!(message.contains("en.toml: `a.b`"), "{value}: {message}");
        }
    }

    #[test]
    fn doubled_braces_are_literal_braces() {
        let output = run(&[(
            "en",
            "[a]\nplain = \"Use {{name}} here\"\nformatted = \"{{{value}}} and }}\"\n",
        )])
        .unwrap();
        assert!(
            output.code.contains("\"Use {name} here\","),
            "{}",
            output.code
        );
        assert!(
            output.code.contains("format!(\"{{{value}}} and }}\")"),
            "{}",
            output.code
        );
    }

    #[test]
    fn plural_rules_select_the_documented_forms() {
        for code in ["en", "de"] {
            assert_eq!(rule(code).category(0), Category::Other);
            assert_eq!(rule(code).category(1), Category::One);
            assert_eq!(rule(code).category(2), Category::Other);
            assert_eq!(rule(code).category(1_000_000), Category::Other);
        }
        let fr = rule("fr");
        assert_eq!(fr.category(0), Category::One);
        assert_eq!(fr.category(1), Category::One);
        assert_eq!(fr.category(2), Category::Other);
        assert_eq!(fr.category(1_000_000), Category::Many);
        assert_eq!(fr.category(3_000_000), Category::Many);
        assert_eq!(fr.category(1_000_001), Category::Other);
        let es = rule("es");
        assert_eq!(es.category(0), Category::Other);
        assert_eq!(es.category(1), Category::One);
        assert_eq!(es.category(2_000_000), Category::Many);
        let hi = rule("hi");
        assert_eq!(hi.category(0), Category::One);
        assert_eq!(hi.category(1), Category::One);
        assert_eq!(hi.category(2), Category::Other);
        for code in ["zh-CN", "ja"] {
            for n in [0, 1, 2, 1_000_000] {
                assert_eq!(rule(code).category(n), Category::Other);
            }
        }
    }

    #[test]
    fn plural_messages_dispatch_on_count() {
        let en = "[a]\nclips = { one = \"One clip\", other = \"{count} clips\" }\n";
        let fr = "[a]\nclips = { one = \"{count} clip\", many = \"{count} de clips\", other = \"{count} clips\" }\n";
        let ja = "[a]\nclips = { other = \"{count}件のクリップ\" }\n";
        let output = run(&[("en", en), ("fr", fr), ("ja", ja)]).unwrap();
        assert!(
            output
                .code
                .contains("pub fn clips(count: usize) -> String {")
        );
        assert!(output.code.contains("fn plural_en(n: usize) -> Plural {"));
        assert!(output.code.contains("fn plural_fr(n: usize) -> Plural {"));
        assert!(!output.code.contains("fn plural_ja"));
        assert!(
            output
                .code
                .contains("super::super::Plural::Many => format!(\"{count} de clips\"),")
        );
        assert!(
            output
                .code
                .contains("1 => format!(\"{count}件のクリップ\"),")
        );
    }

    #[test]
    fn plural_forms_are_checked_per_locale() {
        let en = "[a]\nclips = { one = \"One clip\", other = \"{count} clips\" }\n";
        let message = errors(&[("en", "[a]\nclips = { one = \"One clip\" }\n")]);
        assert!(
            message.contains("missing the `other` plural form"),
            "{message}"
        );

        let message = errors(&[
            ("en", en),
            ("ja", "[a]\nclips = { one = \"1\", other = \"{count}\" }\n"),
        ]);
        assert!(
            message.contains("`one` is not a plural form in ja"),
            "{message}"
        );

        let message = errors(&[
            ("en", en),
            ("fr", "[a]\nclips = { other = \"{count} clips\" }\n"),
        ]);
        assert!(
            message.contains("missing the `one` plural form"),
            "{message}"
        );

        let fr_without_many = "[a]\nclips = { one = \"Un clip\", other = \"{count} clips\" }\n";
        assert!(run(&[("en", en), ("fr", fr_without_many)]).is_ok());

        let message = errors(&[("en", "[a]\nx = { one = \"{name}\", other = \"{count}\" }\n")]);
        assert!(message.contains("against `other`"), "{message}");
    }

    #[test]
    fn translation_shape_must_match_english() {
        let message = errors(&[
            (
                "en",
                "[a]\nclips = { one = \"One clip\", other = \"{count} clips\" }\n",
            ),
            ("fr", "[a]\nclips = \"{count} clips\"\n"),
        ]);
        assert!(message.contains("needs them too"), "{message}");

        let message = errors(&[
            ("en", "[a]\nsave = \"Save\"\n"),
            ("fr", "[a]\nsave = { one = \"a\", other = \"b\" }\n"),
        ]);
        assert!(message.contains("must be one too"), "{message}");

        let message = errors(&[
            ("en", "[a]\nsave = \"Save\"\n"),
            ("fr", "[a]\nsave = { text = \"Enregistrer\" }\n"),
        ]);
        assert!(message.contains("belongs in en.toml only"), "{message}");
    }

    #[test]
    fn missing_translations_warn_and_fall_back_unless_strict() {
        let en = "[a]\nsave = \"Save\"\nopen = \"Open\"\n";
        let fr = "[a]\nsave = \"Enregistrer\"\nstale = \"Vieux\"\n";
        let output = run(&[("en", en), ("fr", fr)]).unwrap();
        assert!(
            output
                .warnings
                .iter()
                .any(|warning| warning.contains("1 of 2 keys fall back to English: `a.open`"))
        );
        assert!(
            output
                .warnings
                .iter()
                .any(|warning| warning.contains("`a.stale` is not in en.toml"))
        );
        assert!(output.code.contains("\"Enregistrer\","));
        assert_eq!(output.code.matches("\"Open\",").count(), 2);

        let strict = generate(&[("en", en), ("fr", fr)], true).unwrap_err();
        assert!(
            strict
                .iter()
                .any(|error| error.contains("fall back to English"))
        );
    }

    #[test]
    fn keys_and_tables_are_validated() {
        for (catalog, expected) in [
            ("[a]\ntype = \"x\"\n", "not a valid key segment"),
            ("[a]\nOpen = \"x\"\n", "not a valid key segment"),
            ("other = \"x\"\n", "reserved for message fields"),
            (
                "[a]\nb = { text = \"x\", one = \"y\" }\n",
                "both `text` and plural forms",
            ),
            (
                "[a]\nb = { context = \"x\" }\n",
                "neither `text` nor plural forms",
            ),
            (
                "[a.b]\ntext = \"x\"\nlabel = \"y\"\n",
                "sits beside message fields",
            ),
            (
                "[a]\nb = { text = \"x\", max_px = 0, size = 13 }\n",
                "positive number",
            ),
            ("[a]\nb = 3\n", "expected a string or a table"),
            ("[a]\nb = \"   \"\n", "value is empty"),
            ("[a\n", "en.toml"),
        ] {
            let message = errors(&[("en", catalog)]);
            assert!(message.contains(expected), "{catalog:?}: {message}");
        }
    }

    #[test]
    fn message_tables_carry_metadata() {
        let output = run(&[(
            "en",
            "[a]\ntitle = { text = \"Title\", context = \"Window heading\", max_px = 120, size = 13.5 }\n",
        )])
        .unwrap();
        assert!(output.code.contains("\"Title\","));
        assert!(output.code.contains("Window heading"));
    }

    #[test]
    fn surrounding_whitespace_must_match_english() {
        let message = errors(&[
            ("en", "[a]\nb = \"Studio\"\n"),
            ("fr", "[a]\nb = \" Studio\"\n"),
        ]);
        assert!(message.contains("whitespace differs"), "{message}");
    }

    #[test]
    fn locale_files_are_checked() {
        let message = errors(&[("en", "a = \"x\"\n"), ("xx", "a = \"y\"\n")]);
        assert!(message.contains("xx.toml: unknown locale"), "{message}");

        let message = errors(&[("fr", "a = \"x\"\n")]);
        assert!(message.contains("en.toml is missing"), "{message}");
    }

    #[test]
    fn locale_enum_lists_present_locales_in_registry_order() {
        let output = run(&[("fr", "a = \"y\"\n"), ("en", "a = \"x\"\n")]).unwrap();
        assert!(output.code.contains("En = 0,"));
        assert!(output.code.contains("Fr = 1,"));
        assert!(output.code.contains("\"fr\" => Some(Locale::Fr),"));
        assert!(output.code.contains("Locale::Fr => \"Français\","));
        assert!(!output.code.contains("Ja ="));
    }

    #[test]
    fn pseudo_locale_accents_pads_and_keeps_placeholders() {
        let en = "[a]\nsave = \"Save\"\nversion = \"Cap v{version}\"\nclips = { one = \"One clip\", other = \"{count} clips\" }\n";
        let output = generate_with(&[("en", en)], false, true).unwrap();
        assert!(output.code.contains("Pseudo = 1,"), "{}", output.code);
        assert!(
            output.code.contains("\"pseudo\" => Some(Locale::Pseudo),"),
            "{}",
            output.code
        );
        assert!(output.code.contains("\"⟦Šåṽéļö⟧\","), "{}", output.code);
        assert!(
            output
                .code
                .contains("1 => format!(\"⟦Çåþ ṽ{version}ļö⟧\"),"),
            "{}",
            output.code
        );
        assert!(
            output
                .code
                .contains("super::super::Plural::One => String::from(\"⟦Öñé çļîþļöŕ⟧\"),"),
            "{}",
            output.code
        );
        assert!(
            output
                .code
                .contains("fn plural_pseudo(n: usize) -> Plural {")
        );

        let without = generate(&[("en", en)], false).unwrap();
        assert!(!without.code.contains("Pseudo"));
    }

    #[test]
    fn pseudo_text_keeps_literal_braces() {
        let output = generate_with(&[("en", "[a]\nb = \"Use {{x}}\"\n")], false, true).unwrap();
        assert!(output.code.contains("\"⟦Ûšé {ẋ}ļö⟧\","), "{}", output.code);
    }

    #[test]
    fn width_budgets_list_every_locale() {
        let en = "[a]\ntitle = { text = \"Title\", max_px = 120, size = 13 }\nplain = \"Plain\"\n";
        let fr = "[a]\ntitle = \"Titre\"\n";
        let output = run(&[("en", en), ("fr", fr)]).unwrap();
        assert!(
            output.code.contains("pub const FITS: [Fit; 1] = ["),
            "{}",
            output.code
        );
        assert!(output.code.contains("key: \"a.title\","));
        assert!(output.code.contains("max_px: 120.0,"));
        assert!(output.code.contains("size: 13.0,"));
        assert!(
            output.code.contains("\"Title\",\n            \"Titre\","),
            "{}",
            output.code
        );

        let output = run(&[("en", "[a]\nplain = \"Plain\"\n")]).unwrap();
        assert!(!output.code.contains("FITS"));

        for (catalog, expected) in [
            ("[a]\nb = { text = \"x\", max_px = 10 }\n", "go together"),
            ("[a]\nb = { text = \"x\", size = 13 }\n", "go together"),
            (
                "[a]\nb = { one = \"x\", other = \"{count}\", max_px = 10, size = 13 }\n",
                "only measured on plain strings",
            ),
        ] {
            let message = errors(&[("en", catalog)]);
            assert!(message.contains(expected), "{catalog:?}: {message}");
        }
    }

    #[test]
    fn output_is_deterministic() {
        let catalogs = [
            ("en", "[b]\nz = \"Z\"\n[a]\ny = \"Y {n}\"\nx = \"X\"\n"),
            ("de", "[a]\nx = \"X\"\n"),
        ];
        assert_eq!(run(&catalogs).unwrap().code, run(&catalogs).unwrap().code);
    }
}
