use super::*;

#[test]
fn a_profile_from_before_the_one_voice_check_is_learnt_again() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("voice-profile.json");
    let mut old = VoiceProfile::new("scripted", &[1.0, 0.0], 40_000);
    old.version = 1;
    old.save(&path).unwrap();
    assert!(VoiceProfile::load(&path).is_err());
    VoiceProfile::new("scripted", &[1.0, 0.0], 40_000)
        .save(&path)
        .unwrap();
    assert!(VoiceProfile::load(&path).is_ok());
}

#[test]
fn only_a_readable_profile_this_version_cannot_use_counts_as_unusable() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("voice-profile.json");
    assert!(
        !VoiceProfile::unusable(&path),
        "a missing file is not unusable"
    );
    let mut old = VoiceProfile::new("scripted", &[1.0, 0.0], 40_000);
    old.version = 1;
    old.save(&path).unwrap();
    assert!(VoiceProfile::unusable(&path));
    std::fs::write(&path, b"{not json").unwrap();
    assert!(VoiceProfile::unusable(&path));
    VoiceProfile::new("scripted", &[1.0, 0.0], 40_000)
        .save(&path)
        .unwrap();
    assert!(!VoiceProfile::unusable(&path));
}
