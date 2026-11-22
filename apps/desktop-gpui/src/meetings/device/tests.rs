use super::*;

#[test]
fn every_intel_mac_is_slow_and_apple_silicon_never_is() {
    for cores in [None, Some(2), Some(4), Some(12)] {
        assert!(too_slow(Os::MacOS, true, cores), "Intel {cores:?}");
        assert!(
            !too_slow(Os::MacOS, false, cores),
            "Apple silicon {cores:?}"
        );
    }
    assert!(
        !too_slow(Os::MacOS, false, Some(3)),
        "the 3-core M1 keeps up"
    );
}

#[test]
fn windows_and_linux_are_slow_below_four_cores() {
    for os in [Os::Windows, Os::Linux] {
        assert!(too_slow(os, false, Some(1)), "{os:?}");
        assert!(too_slow(os, false, Some(2)), "{os:?}");
        assert!(too_slow(os, false, Some(3)), "{os:?}");
        assert!(!too_slow(os, false, Some(4)), "{os:?}");
        assert!(!too_slow(os, false, Some(16)), "{os:?}");
        assert!(!too_slow(os, false, None), "an unknown count is capable");
    }
}

#[test]
fn the_override_reads_one_and_zero() {
    assert_eq!(from_env(Some("1")), Some(true));
    assert_eq!(from_env(Some(" true ")), Some(true));
    assert_eq!(from_env(Some("0")), Some(false));
    assert_eq!(from_env(Some("false")), Some(false));
    assert_eq!(from_env(Some("maybe")), None);
    assert_eq!(from_env(None), None);
}
