use super::*;

#[test]
fn every_intel_mac_is_slow_and_apple_silicon_never_is() {
    for cores in [None, Some(2), Some(4), Some(12)] {
        assert_eq!(
            class_for(Os::MacOS, true, cores),
            Class::IntelMac,
            "Intel {cores:?}"
        );
        assert_eq!(
            class_for(Os::MacOS, false, cores),
            Class::Capable,
            "Apple silicon {cores:?}"
        );
    }
    assert_eq!(
        class_for(Os::MacOS, false, Some(3)),
        Class::Capable,
        "the 3-core M1 keeps up"
    );
}

#[test]
fn windows_and_linux_are_slow_below_four_cores() {
    for os in [Os::Windows, Os::Linux] {
        for cores in [1, 2, 3] {
            assert_eq!(
                class_for(os, false, Some(cores)),
                Class::FewCores,
                "{os:?} {cores}"
            );
        }
        assert_eq!(class_for(os, false, Some(4)), Class::Capable, "{os:?}");
        assert_eq!(class_for(os, false, Some(16)), Class::Capable, "{os:?}");
        assert_eq!(
            class_for(os, false, None),
            Class::Capable,
            "an unknown count is capable"
        );
    }
}

#[test]
fn the_override_names_the_kind_of_slow_computer() {
    let native = Class::FewCores;
    assert_eq!(from_env(Some("1"), native), Some(Class::FewCores));
    assert_eq!(
        from_env(Some(" true "), Class::IntelMac),
        Some(Class::IntelMac)
    );
    assert_eq!(from_env(Some("intel"), native), Some(Class::IntelMac));
    assert_eq!(
        from_env(Some("cores"), Class::IntelMac),
        Some(Class::FewCores)
    );
    assert_eq!(from_env(Some("0"), native), Some(Class::Capable));
    assert_eq!(from_env(Some("false"), native), Some(Class::Capable));
    assert_eq!(from_env(Some("maybe"), native), None);
    assert_eq!(from_env(None, native), None);
}

#[test]
fn tests_see_a_capable_computer_unless_they_say_so() {
    assert_eq!(class(), Class::Capable);
    assert!(!slow());
    TEST_CLASS.with(|c| c.set(Class::IntelMac));
    assert!(slow());
    TEST_CLASS.with(|c| c.set(Class::Capable));
}

#[test]
fn a_slow_computer_gets_the_most_compatible_model_that_keeps_up() {
    use crate::meetings::{NOTES_FALLBACK_MODEL, NOTES_MODEL, SLOW_NOTES_MODEL, notes_model_for};
    // Capable computers: as before.
    assert_eq!(notes_model_for(Class::Capable, true, "auto"), NOTES_MODEL);
    assert_eq!(notes_model_for(Class::Capable, true, "de"), NOTES_MODEL);
    assert_eq!(
        notes_model_for(Class::Capable, true, "ja"),
        NOTES_FALLBACK_MODEL
    );
    assert_eq!(
        notes_model_for(Class::Capable, false, "en"),
        NOTES_FALLBACK_MODEL
    );
    // An Intel Mac: Whisper base for every language.
    for language in ["auto", "en", "ja"] {
        assert_eq!(
            notes_model_for(Class::IntelMac, false, language),
            SLOW_NOTES_MODEL
        );
    }
    // Windows and Linux below 4 cores keep Parakeet where it writes the
    // language, and Whisper base in place of small elsewhere.
    assert_eq!(notes_model_for(Class::FewCores, true, "auto"), NOTES_MODEL);
    assert_eq!(notes_model_for(Class::FewCores, true, "fr"), NOTES_MODEL);
    assert_eq!(
        notes_model_for(Class::FewCores, true, "ja"),
        SLOW_NOTES_MODEL
    );
}
