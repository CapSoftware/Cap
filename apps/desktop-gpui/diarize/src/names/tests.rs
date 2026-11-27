use super::*;

fn info(id: u32, track: Track, first_ms: u64, speech_ms: u64, is_user: bool) -> SpeakerInfo {
    SpeakerInfo {
        id: SpeakerId(id),
        track,
        first_ms,
        speech_ms,
        is_user,
    }
}

fn pass(speakers: Vec<SpeakerInfo>, merged: Vec<(u32, u32)>) -> FinalPass {
    FinalPass {
        user: speakers.iter().find(|s| s.is_user).map(|s| s.id),
        speakers,
        merged: merged
            .into_iter()
            .map(|(a, b)| (SpeakerId(a), SpeakerId(b)))
            .collect(),
        ..FinalPass::default()
    }
}

#[test]
fn people_are_numbered_in_order_of_first_speech_and_numbers_never_move_live() {
    let mut names = SpeakerNames::new(None);
    names.observe(&[
        info(1, Track::Mic, 0, 1, true),
        info(2, Track::System, 900, 1, false),
    ]);
    names.observe(&[
        info(1, Track::Mic, 0, 1, true),
        info(2, Track::System, 900, 1, false),
        info(4, Track::System, 2_000, 1, false),
        info(3, Track::Mic, 1_500, 1, false),
    ]);
    assert_eq!(names.label(SpeakerId(1)), Some(Label::User));
    assert_eq!(names.label(SpeakerId(2)), Some(Label::Person(1)));
    assert_eq!(names.label(SpeakerId(3)), Some(Label::Person(2)));
    assert_eq!(names.label(SpeakerId(4)), Some(Label::Person(3)));
    names.rename(SpeakerId(2), "  Alex ");
    names.observe(&[info(5, Track::System, 9_000, 1, false)]);
    assert_eq!(names.label(SpeakerId(2)), Some(Label::Named("Alex".into())));
    assert_eq!(names.label(SpeakerId(5)), Some(Label::Person(4)));
    names.rename(SpeakerId(2), " ");
    assert_eq!(names.label(SpeakerId(2)), Some(Label::Person(1)));
    assert_eq!(names.label(SpeakerId(9)), None);
}

#[test]
fn a_single_other_attendee_names_the_only_remote_voice() {
    let mut names = SpeakerNames::new(Some(" Sam Lee ".into()));
    names.observe(&[
        info(1, Track::Mic, 0, 1, true),
        info(2, Track::System, 500, 1, false),
    ]);
    assert_eq!(
        names.label(SpeakerId(2)),
        Some(Label::Named("Sam Lee".into()))
    );
    names.observe(&[info(3, Track::System, 8_000, 1, false)]);
    assert_eq!(
        names.label(SpeakerId(2)),
        Some(Label::Named("Sam Lee".into()))
    );
    assert_eq!(names.label(SpeakerId(3)), Some(Label::Person(1)));

    let mut balanced = names.clone();
    balanced.apply_final(&pass(
        vec![
            info(1, Track::Mic, 0, 60_000, true),
            info(2, Track::System, 500, 50_000, false),
            info(3, Track::System, 8_000, 40_000, false),
        ],
        vec![],
    ));
    assert_eq!(
        balanced.label(SpeakerId(3)),
        Some(Label::Person(1)),
        "keeps the number it had live"
    );
    assert_eq!(balanced.label(SpeakerId(2)), Some(Label::Person(2)));

    let mut dominant = names.clone();
    dominant.apply_final(&pass(
        vec![
            info(1, Track::Mic, 0, 60_000, true),
            info(2, Track::System, 500, 95_000, false),
            info(3, Track::System, 8_000, 3_000, false),
        ],
        vec![],
    ));
    assert_eq!(
        dominant.label(SpeakerId(2)),
        Some(Label::Named("Sam Lee".into()))
    );
    assert_eq!(dominant.label(SpeakerId(3)), Some(Label::Person(1)));

    let mut merged = names;
    merged.apply_final(&pass(
        vec![
            info(1, Track::Mic, 0, 60_000, true),
            info(2, Track::System, 500, 95_000, false),
        ],
        vec![(3, 2)],
    ));
    assert_eq!(
        merged.label(SpeakerId(2)),
        Some(Label::Named("Sam Lee".into()))
    );
    assert_eq!(merged.label(SpeakerId(3)), None);
}

#[test]
fn no_attendee_name_without_a_calendar_match() {
    let mut names = SpeakerNames::new(Some("   ".into()));
    names.observe(&[info(2, Track::System, 500, 1, false)]);
    assert_eq!(names.label(SpeakerId(2)), Some(Label::Person(1)));
}

#[test]
fn renames_survive_merges_and_the_target_keeps_its_own_name() {
    let mut names = SpeakerNames::new(None);
    names.observe(&[
        info(1, Track::Mic, 0, 1, true),
        info(2, Track::System, 100, 1, false),
        info(3, Track::System, 200, 1, false),
        info(4, Track::System, 300, 1, false),
        info(5, Track::System, 400, 1, false),
    ]);
    names.rename(SpeakerId(2), "Ana");
    names.rename(SpeakerId(3), "Bo");
    names.rename(SpeakerId(5), "Cy");
    let changes = names.apply_final(&pass(
        vec![
            info(1, Track::Mic, 0, 9, true),
            info(2, Track::System, 100, 9, false),
            info(4, Track::System, 300, 9, false),
        ],
        vec![(3, 2), (5, 4)],
    ));
    assert_eq!(names.label(SpeakerId(2)), Some(Label::Named("Ana".into())));
    assert_eq!(names.label(SpeakerId(4)), Some(Label::Named("Cy".into())));
    assert_eq!(names.label(SpeakerId(3)), None);
    assert_eq!(names.renames().len(), 2);
    let changed: Vec<u32> = changes.iter().map(|c| c.id.0).collect();
    assert_eq!(changed, vec![3, 4, 5]);
}

#[test]
fn the_final_pass_can_move_the_user_and_renumber_everyone_else() {
    let mut names = SpeakerNames::new(None);
    names.observe(&[
        info(1, Track::Mic, 0, 1, true),
        info(2, Track::Mic, 50, 1, false),
    ]);
    assert_eq!(names.label(SpeakerId(2)), Some(Label::Person(1)));
    names.apply_final(&pass(
        vec![
            info(1, Track::Mic, 0, 5_000, false),
            info(2, Track::Mic, 50, 90_000, true),
        ],
        vec![],
    ));
    assert_eq!(names.label(SpeakerId(2)), Some(Label::User));
    assert_eq!(names.label(SpeakerId(1)), Some(Label::Person(1)));
}

#[test]
fn names_round_trip_through_json() {
    let mut names = SpeakerNames::new(Some("Sam".into()));
    names.observe(&[
        info(1, Track::Mic, 0, 1, true),
        info(2, Track::System, 5, 1, false),
    ]);
    names.rename(SpeakerId(1), "Richie");
    let json = serde_json::to_string(&names).unwrap();
    let back: SpeakerNames = serde_json::from_str(&json).unwrap();
    assert_eq!(back, names);
    assert_eq!(
        serde_json::to_string(&Label::Person(3)).unwrap(),
        r#"{"kind":"person","value":3}"#
    );
}

#[test]
fn the_final_pass_keeps_live_numbers_and_only_closes_gaps() {
    let mut names = SpeakerNames::new(None);
    names.observe(&[
        info(1, Track::Mic, 0, 1, true),
        info(2, Track::System, 100, 1, false),
    ]);
    names.observe(&[info(3, Track::System, 900, 1, false)]);
    names.observe(&[info(4, Track::System, 1_500, 1, false)]);
    assert_eq!(names.label(SpeakerId(4)), Some(Label::Person(3)));
    let changes = names.apply_final(&pass(
        vec![
            info(1, Track::Mic, 0, 9, true),
            info(2, Track::System, 100, 9, false),
            info(4, Track::System, 40, 9, false),
            info(7, Track::System, 20, 9, false),
        ],
        vec![(3, 2)],
    ));
    assert_eq!(names.label(SpeakerId(2)), Some(Label::Person(1)));
    assert_eq!(names.label(SpeakerId(4)), Some(Label::Person(2)));
    assert_eq!(names.label(SpeakerId(7)), Some(Label::Person(3)));
    let changed: Vec<u32> = changes.iter().map(|c| c.id.0).collect();
    assert_eq!(changed, vec![3, 4, 7]);
}

#[test]
fn when_the_user_moves_to_a_louder_voice_the_old_one_gets_a_number() {
    let mut names = SpeakerNames::new(None);
    names.observe(&[info(1, Track::Mic, 0, 1, true)]);
    names.observe(&[
        info(1, Track::Mic, 0, 1, false),
        info(2, Track::Mic, 900, 1, true),
    ]);
    assert_eq!(names.label(SpeakerId(2)), Some(Label::User));
    assert_eq!(names.label(SpeakerId(1)), Some(Label::Person(1)));
}

#[test]
fn a_late_correction_never_renumbers_anyone() {
    let mut names = SpeakerNames::new(None);
    names.observe(&[
        info(1, Track::Mic, 0, 1, true),
        info(2, Track::System, 900, 1, false),
        info(3, Track::System, 1_500, 1, false),
        info(4, Track::Mic, 2_000, 1, false),
    ]);
    names.rename(SpeakerId(3), "Kristen");
    let first = names.clone();
    assert_eq!(names.label(SpeakerId(4)), Some(Label::Person(3)));
    // after Stop: 2 was a fragment of 4, and 4 held a second person (new id 9)
    let changes = names.apply_late(&pass(
        vec![
            info(1, Track::Mic, 0, 1, true),
            info(3, Track::System, 1_500, 1, false),
            info(4, Track::Mic, 2_000, 1, false),
            info(9, Track::Mic, 5_000, 1, false),
        ],
        vec![(2, 4)],
    ));
    assert_eq!(names.label(SpeakerId(1)), Some(Label::User));
    assert_eq!(names.label(SpeakerId(3)), Some(Label::Named("Kristen".into())));
    // Person 3 stays Person 3 (a summary may already say so); Person 1 is gone, not reused
    assert_eq!(names.label(SpeakerId(4)), Some(Label::Person(3)));
    assert_eq!(names.label(SpeakerId(9)), Some(Label::Person(4)));
    assert_eq!(names.label(SpeakerId(2)), None);
    assert_eq!(changes.len(), 2, "{changes:?}");
    // the same pass applied as a final pass would have closed the gap
    let mut closed = first;
    closed.apply_final(&pass(
        vec![
            info(1, Track::Mic, 0, 1, true),
            info(3, Track::System, 1_500, 1, false),
            info(4, Track::Mic, 2_000, 1, false),
            info(9, Track::Mic, 5_000, 1, false),
        ],
        vec![(2, 4)],
    ));
    assert_eq!(closed.label(SpeakerId(4)), Some(Label::Person(2)));
}

#[test]
fn a_late_correction_moves_a_rename_and_the_user_with_a_merge() {
    let mut names = SpeakerNames::new(None);
    names.observe(&[info(1, Track::Mic, 0, 1, true), info(5, Track::System, 900, 1, false), info(6, Track::System, 1_900, 1, false)]);
    names.rename(SpeakerId(6), "Ana");
    names.apply_late(&pass(
        vec![info(1, Track::Mic, 0, 1, true), info(5, Track::System, 900, 1, false)],
        vec![(6, 5)],
    ));
    assert_eq!(names.label(SpeakerId(5)), Some(Label::Named("Ana".into())));
    assert_eq!(names.user(), Some(SpeakerId(1)));
    // a pass without a user keeps the one the meeting had
    names.apply_late(&FinalPass { speakers: vec![info(1, Track::Mic, 0, 1, false), info(5, Track::System, 900, 1, false)], ..FinalPass::default() });
    assert_eq!(names.label(SpeakerId(1)), Some(Label::User));
}

#[test]
fn a_voice_that_is_not_the_user_stays_someone_else_live_and_after_the_meeting() {
    let mut names = SpeakerNames::new(None);
    names.observe(&[
        info(1, Track::Mic, 0, 1, true),
        info(2, Track::System, 500, 1, false),
    ]);
    assert_eq!(names.label(SpeakerId(1)), Some(Label::User));
    names.not_user(SpeakerId(1));
    assert_eq!(names.label(SpeakerId(1)), Some(Label::Person(2)));
    assert_eq!(names.user(), None);
    // The live pass still thinks it is the user: it stays someone else.
    names.observe(&[
        info(1, Track::Mic, 0, 1, true),
        info(2, Track::System, 500, 1, false),
    ]);
    assert_eq!(names.label(SpeakerId(1)), Some(Label::Person(2)));
    // The real user speaks: they are the user, and nobody else moves.
    names.observe(&[info(3, Track::Mic, 4_000, 1, true)]);
    assert_eq!(names.label(SpeakerId(3)), Some(Label::User));
    assert_eq!(names.label(SpeakerId(1)), Some(Label::Person(2)));
    assert_eq!(names.label(SpeakerId(2)), Some(Label::Person(1)));

    // "That's me" takes it back, and back again.
    let mut undone = names.clone();
    undone.claim_user(SpeakerId(1));
    assert_eq!(undone.label(SpeakerId(1)), Some(Label::User));
    assert!(!undone.is_not_user(SpeakerId(1)));
    assert!(matches!(undone.label(SpeakerId(3)), Some(Label::Person(_))));

    // The end-of-meeting pass merges the disowned voice into 4 and picks 4
    // as the user: 4 is still someone else, and is the voice disowned.
    let mut late = names.clone();
    let end = pass(
        vec![
            info(2, Track::System, 500, 1, false),
            info(3, Track::Mic, 4_000, 1, false),
            info(4, Track::Mic, 0, 1, true),
        ],
        vec![(1, 4)],
    );
    assert!(names.disowns(SpeakerId(4), &end.merged));
    assert!(!names.disowns(SpeakerId(3), &end.merged));
    names.apply_final(&end);
    assert_eq!(names.user(), None);
    assert!(matches!(names.label(SpeakerId(4)), Some(Label::Person(_))));
    late.apply_late(&end);
    assert_eq!(late.user(), None);
    assert!(matches!(late.label(SpeakerId(4)), Some(Label::Person(_))));
}

#[test]
fn a_voice_left_out_of_the_notes_follows_merges_and_round_trips() {
    let mut names = SpeakerNames::new(None);
    names.observe(&[
        info(1, Track::Mic, 0, 1, true),
        info(2, Track::System, 500, 1, false),
        info(3, Track::System, 900, 1, false),
    ]);
    names.set_left_out(SpeakerId(3), true);
    names.not_user(SpeakerId(1));
    assert!(names.is_left_out(SpeakerId(3)) && !names.is_left_out(SpeakerId(2)));
    let json = serde_json::to_string(&names).unwrap();
    let back: SpeakerNames = serde_json::from_str(&json).unwrap();
    assert_eq!(back, names);
    // Names saved before these choices existed still load.
    let mut plain = SpeakerNames::new(None);
    plain.observe(&[info(1, Track::Mic, 0, 1, true)]);
    let old = serde_json::to_string(&plain).unwrap();
    assert!(!old.contains("leftOut") && !old.contains("notUser"));
    assert_eq!(serde_json::from_str::<SpeakerNames>(&old).unwrap(), plain);

    names.apply_late(&pass(
        vec![
            info(1, Track::Mic, 0, 1, false),
            info(2, Track::System, 500, 1, false),
        ],
        vec![(3, 2)],
    ));
    assert!(
        names.is_left_out(SpeakerId(2)),
        "the merged voice keeps the choice"
    );
    names.set_left_out(SpeakerId(2), false);
    assert!(!names.is_left_out(SpeakerId(2)));
}

/// A voice put back in the notes is a choice of its own, kept through a
/// reload and merges (left out wins when merged voices disagree), and
/// forgetting it leaves no choice.
#[test]
fn a_voice_put_back_in_is_a_choice_of_its_own() {
    let mut names = SpeakerNames::new(None);
    names.observe(&[
        info(2, Track::System, 500, 1, false),
        info(3, Track::System, 900, 1, false),
        info(4, Track::System, 1_200, 1, false),
    ]);
    assert_eq!(names.left_out(SpeakerId(2)), None);
    names.set_left_out(SpeakerId(2), false);
    names.set_left_out(SpeakerId(3), true);
    assert_eq!(names.left_out(SpeakerId(2)), Some(false));
    assert_eq!(names.left_out(SpeakerId(3)), Some(true));
    let back: SpeakerNames = serde_json::from_str(&serde_json::to_string(&names).unwrap()).unwrap();
    assert_eq!(back, names);
    names.apply_late(&pass(
        vec![
            info(2, Track::System, 500, 1, false),
            info(4, Track::System, 1_200, 1, false),
        ],
        vec![(3, 2)],
    ));
    assert_eq!(names.left_out(SpeakerId(2)), Some(true));
    names.choose_left_out(SpeakerId(2), None);
    assert_eq!(names.left_out(SpeakerId(2)), None);
}

/// `revert` takes back one change and keeps the rest: names still at
/// `after` become `before` exactly, and a choice made since on another
/// voice stays.
#[test]
fn reverting_one_choice_keeps_the_others() {
    let mut start = SpeakerNames::new(None);
    start.observe(&[
        info(1, Track::Mic, 0, 1, true),
        info(2, Track::System, 500, 1, false),
        info(3, Track::System, 900, 1, false),
    ]);
    let mut not_me = start.clone();
    not_me.not_user(SpeakerId(1));
    let mut undone = not_me.clone();
    undone.revert(&start, &not_me);
    assert_eq!(undone, start);

    let mut first = start.clone();
    first.set_left_out(SpeakerId(2), true);
    let mut both = first.clone();
    both.set_left_out(SpeakerId(3), true);
    both.revert(&start, &first);
    assert_eq!(both.left_out(SpeakerId(2)), None);
    assert_eq!(both.left_out(SpeakerId(3)), Some(true));
}

/// A real Zoom call: a partial line was first heard as voice 1, its final
/// words went to voice 3, and voice 1 never had a line again. The people
/// shown live are Person 1 and Person 2, and the notes keep them.
#[test]
fn a_voice_left_with_no_line_gives_its_number_to_the_next_person() {
    let mut names = SpeakerNames::new(None);
    let user = info(2, Track::Mic, 0, 1, true);
    names.observe_speaking(&[user.clone()]);
    names.observe_speaking(&[user.clone(), info(1, Track::System, 3_700, 1, false)]);
    assert_eq!(names.label(SpeakerId(1)), Some(Label::Person(1)));
    names.observe_speaking(&[user.clone(), info(3, Track::System, 3_700, 1, false)]);
    names.observe_speaking(&[
        user.clone(),
        info(3, Track::System, 3_700, 1, false),
        info(4, Track::System, 18_600, 1, false),
    ]);
    assert_eq!(names.label(SpeakerId(1)), None);
    assert_eq!(names.label(SpeakerId(3)), Some(Label::Person(1)));
    assert_eq!(names.label(SpeakerId(4)), Some(Label::Person(2)));
    let changes = names.apply_final(&pass(
        vec![
            user,
            info(3, Track::System, 3_700, 1, false),
            info(4, Track::System, 18_600, 1, false),
        ],
        vec![],
    ));
    assert!(
        changes
            .iter()
            .all(|c| c.id != SpeakerId(3) && c.id != SpeakerId(4)),
        "{changes:?}"
    );
}

/// A voice numbered before it was known as the user leaves no gap.
#[test]
fn the_user_found_after_a_number_leaves_no_gap() {
    let mut names = SpeakerNames::new(None);
    names.observe_speaking(&[info(2, Track::Mic, 0, 1, false)]);
    assert_eq!(names.label(SpeakerId(2)), Some(Label::Person(1)));
    names.observe_speaking(&[
        info(2, Track::Mic, 0, 1, true),
        info(3, Track::System, 900, 1, false),
    ]);
    assert_eq!(names.label(SpeakerId(2)), Some(Label::User));
    assert_eq!(names.label(SpeakerId(3)), Some(Label::Person(1)));
}

/// Only a voice with no line and no choice of the person's gives its number
/// back; everyone still shown keeps theirs, and a voice that comes back
/// takes the lowest free number.
#[test]
fn named_or_chosen_voices_keep_their_numbers_and_shown_ones_never_move() {
    let mut names = SpeakerNames::new(None);
    let user = info(1, Track::Mic, 0, 1, true);
    names.observe_speaking(&[
        user.clone(),
        info(2, Track::System, 900, 1, false),
        info(3, Track::System, 1_800, 1, false),
        info(4, Track::System, 2_700, 1, false),
        info(5, Track::System, 3_600, 1, false),
    ]);
    names.rename(SpeakerId(2), "Dana");
    names.set_left_out(SpeakerId(3), true);
    names.observe_speaking(&[user.clone(), info(5, Track::System, 3_600, 1, false)]);
    assert_eq!(names.label(SpeakerId(2)), Some(Label::Named("Dana".into())));
    assert_eq!(names.label(SpeakerId(3)), Some(Label::Person(2)));
    assert_eq!(names.label(SpeakerId(4)), None);
    assert_eq!(names.label(SpeakerId(5)), Some(Label::Person(4)));
    names.observe_speaking(&[
        user,
        info(4, Track::System, 2_700, 1, false),
        info(5, Track::System, 3_600, 1, false),
    ]);
    assert_eq!(names.label(SpeakerId(4)), Some(Label::Person(3)));
    assert_eq!(names.label(SpeakerId(5)), Some(Label::Person(4)));
}

#[test]
fn a_resumed_meeting_keeps_the_numbers_of_voices_with_lines() {
    // Persons 1 and 2 speak before a sleep; after Resume the new capture
    // knows only its own voices (4 and 6). The earlier voices keep their
    // numbers while their lines are in the note, and the new ones go on from 3.
    let mut names = SpeakerNames::new(None);
    names.observe_speaking(&[info(1, Track::System, 0, 1, false)]);
    names.observe_speaking(&[
        info(1, Track::System, 0, 1, false),
        info(3, Track::System, 2_000, 1, false),
    ]);
    names.observe_speaking_keeping(&[info(4, Track::System, 60_000, 1, false)], &[1, 3, 4]);
    names.observe_speaking_keeping(
        &[
            info(4, Track::System, 60_000, 1, false),
            info(6, Track::System, 62_000, 1, false),
        ],
        &[1, 3, 4, 6],
    );
    assert_eq!(names.label(SpeakerId(1)), Some(Label::Person(1)));
    assert_eq!(names.label(SpeakerId(3)), Some(Label::Person(2)));
    assert_eq!(names.label(SpeakerId(4)), Some(Label::Person(3)));
    assert_eq!(names.label(SpeakerId(6)), Some(Label::Person(4)));
    // A voice with no lines left still gives its number back.
    names.observe_speaking_keeping(&[info(6, Track::System, 62_000, 1, false)], &[1, 3, 6]);
    assert_eq!(names.label(SpeakerId(4)), None);
}
