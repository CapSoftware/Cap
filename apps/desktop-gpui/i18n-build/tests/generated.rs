mod i18n {
    use std::cell::Cell;

    use cap_i18n_build::{Category, LOCALES};

    thread_local! {
        static INDEX: Cell<usize> = const { Cell::new(0) };
    }

    fn index() -> usize {
        INDEX.with(Cell::get)
    }

    fn set(locale: Locale) {
        INDEX.with(|index| index.set(locale as usize));
    }

    include!(concat!(env!("OUT_DIR"), "/fixture.rs"));

    fn build_rule(code: &str) -> cap_i18n_build::PluralRule {
        LOCALES
            .iter()
            .find(|spec| spec.code == code)
            .map(|spec| spec.plural)
            .unwrap()
    }

    fn same(generated: Plural, expected: Category) -> bool {
        matches!(
            (generated, expected),
            (Plural::One, Category::One)
                | (Plural::Many, Category::Many)
                | (Plural::Other, Category::Other)
        )
    }

    #[test]
    fn locales_are_generated_from_the_catalog_files() {
        assert_eq!(Locale::ALL, [Locale::En, Locale::Ja, Locale::Fr]);
        assert_eq!(Locale::Fr.code(), "fr");
        assert_eq!(Locale::Ja.endonym(), "日本語");
        assert_eq!(Locale::from_code("ja"), Some(Locale::Ja));
        assert_eq!(Locale::from_code("de"), None);
        assert_eq!(KEYS.len(), 7);
        assert!(KEYS.windows(2).all(|pair| pair[0] < pair[1]));
    }

    #[test]
    fn english_is_the_default() {
        assert_eq!(tr::common::save(), "Save");
        assert_eq!(tr::common::braces(), "Use {name} in templates");
        assert_eq!(tr::common::greeting("Ana"), "Hello, Ana!");
        assert_eq!(tr::common::meta::title(), "Title");
        assert_eq!(tr::editor::selection::clips(1), "One clip");
        assert_eq!(tr::editor::selection::clips(0), "0 clips");
        assert_eq!(tr::editor::selection::clips(3), "3 clips");
        assert_eq!(
            tr::editor::selection::segments(1, "zoom"),
            "1 zoom segment selected"
        );
        assert_eq!(
            tr::editor::selection::segments(2, "zoom"),
            "2 zoom segments selected"
        );
    }

    #[test]
    fn switching_locale_switches_text_and_falls_back_to_english() {
        set(Locale::Fr);
        assert_eq!(tr::common::save(), "Enregistrer");
        assert_eq!(tr::common::braces(), "Utilisez {name} dans les modèles");
        assert_eq!(tr::common::greeting("Ana"), "Bonjour, Ana !");
        assert_eq!(tr::common::meta::title(), "Titre");
        assert_eq!(tr::common::untranslated(), "Only in English");

        set(Locale::Ja);
        assert_eq!(tr::common::save(), "保存");
        assert_eq!(tr::common::greeting("Ana"), "こんにちは、Anaさん");
        assert_eq!(tr::common::braces(), "Use {name} in templates");
        assert_eq!(tr::common::meta::title(), "Title");

        set(Locale::En);
        assert_eq!(tr::common::save(), "Save");
    }

    #[test]
    fn plurals_follow_each_locale_rule() {
        use self::tr::editor::selection::segments;

        set(Locale::Fr);
        assert_eq!(segments(0, "zoom"), "0 segment zoom sélectionné");
        assert_eq!(segments(1, "zoom"), "1 segment zoom sélectionné");
        assert_eq!(segments(2, "zoom"), "2 segments zoom sélectionnés");
        assert_eq!(
            segments(1_000_000, "zoom"),
            "1000000 de segments zoom sélectionnés"
        );
        assert_eq!(tr::editor::selection::clips(0), "Un clip");
        assert_eq!(tr::editor::selection::clips(2_000_000), "2000000 clips");

        set(Locale::Ja);
        assert_eq!(segments(1, "ズーム"), "ズームセグメントを1件選択");
        assert_eq!(tr::editor::selection::clips(1), "1件のクリップ");
        set(Locale::En);
    }

    #[test]
    fn width_budgets_carry_the_text_of_every_locale() {
        assert_eq!(FITS.len(), 1);
        let fit = &FITS[0];
        assert_eq!(fit.key, "common.meta.title");
        assert_eq!((fit.max_px, fit.size), (120.0, 13.0));
        assert_eq!(fit.text, ["Title", "Title", "Titre"]);
    }

    #[test]
    fn generated_rules_match_the_build_rules() {
        let samples = (0..2_100).chain([999_999, 1_000_000, 1_000_001, 2_000_000, 7_000_000]);
        for n in samples {
            assert!(same(plural_en(n), build_rule("en").category(n)), "en {n}");
            assert!(same(plural_fr(n), build_rule("fr").category(n)), "fr {n}");
        }
    }
}
