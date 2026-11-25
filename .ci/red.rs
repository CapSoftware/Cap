
#[test]
fn red_a_voice_left_with_no_line_keeps_its_number_on_the_base() {
    let mut names = SpeakerNames::new(None);
    let user = info(2, Track::Mic, 0, 1, true);
    names.observe(&[user.clone()]);
    names.observe(&[user.clone(), info(1, Track::System, 3_700, 1, false)]);
    names.observe(&[user.clone(), info(3, Track::System, 3_700, 1, false)]);
    names.observe(&[user.clone(), info(3, Track::System, 3_700, 1, false), info(4, Track::System, 18_600, 1, false)]);
    assert_eq!(names.label(SpeakerId(3)), Some(Label::Person(1)));
    assert_eq!(names.label(SpeakerId(4)), Some(Label::Person(2)));
}

#[test]
fn red_the_user_found_after_a_number_leaves_a_gap_on_the_base() {
    let mut names = SpeakerNames::new(None);
    names.observe(&[info(2, Track::Mic, 0, 1, false)]);
    names.observe(&[info(2, Track::Mic, 0, 1, true), info(3, Track::System, 900, 1, false)]);
    assert_eq!(names.label(SpeakerId(3)), Some(Label::Person(1)));
}
