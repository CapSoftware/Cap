use chrono::{NaiveDate, TimeZone, Utc};

use super::*;
use crate::library_window::items::{ItemFacts, ItemKey};

fn today() -> NaiveDate {
    NaiveDate::from_ymd_opt(2026, 11, 20).unwrap()
}

fn meeting(title: &str, people: &[&str], day: u32, minutes: u64) -> Item {
    Item::new(
        ItemKey::Doc(format!("{title}-{day}")),
        ItemKind::Meeting,
        title,
        Utc.with_ymd_and_hms(2026, 11, day, 12, 0, 0).unwrap(),
        ItemFacts {
            duration_ms: Some(minutes * 60_000),
            people: people.iter().map(|p| p.to_string()).collect(),
            app: Some("Zoom".into()),
            has_transcript: true,
            ..Default::default()
        },
    )
}

fn folder(matching: Matching, rules: Vec<Rule>) -> SmartFolder {
    SmartFolder {
        id: "f".into(),
        name: "F".into(),
        matching,
        rules,
        extra: Default::default(),
    }
}

fn no_folders(_: &str, _: &Item) -> bool {
    false
}

fn utc_day(at: chrono::DateTime<Utc>) -> NaiveDate {
    at.date_naive()
}

fn plus_one_hour_day(at: chrono::DateTime<Utc>) -> NaiveDate {
    (at + chrono::Duration::minutes(60)).date_naive()
}

fn cx() -> EvalContext<'static> {
    EvalContext {
        today: today(),
        local_day: &utc_day,
        in_folder: &no_folders,
    }
}

fn title(op: TextOp, value: &str) -> Rule {
    Rule::Title {
        op,
        value: value.into(),
    }
}

fn person(op: TextOp, value: &str) -> Rule {
    Rule::Person {
        op,
        value: value.into(),
    }
}

#[test]
fn title_rules_ignore_case_and_accents() {
    let f = folder(Matching::All, vec![title(TextOp::Contains, "CAFÉ")]).compile(today());
    assert!(f.matches(&meeting("Weekly cafe sync", &[], 20, 30), &cx()));
    assert!(!f.matches(&meeting("Weekly sync", &[], 20, 30), &cx()));
}

#[test]
fn speaker_rules_cover_every_person_and_negation_means_nobody() {
    let item = meeting("Planning", &["Ana Pérez", "Bo Chen"], 20, 30);
    let is_bo = folder(Matching::All, vec![person(TextOp::Is, "bo chen")]).compile(today());
    let starts = folder(Matching::All, vec![person(TextOp::StartsWith, "pere")]).compile(today());
    let not_ana =
        folder(Matching::All, vec![person(TextOp::DoesNotContain, "ana")]).compile(today());
    let not_zed =
        folder(Matching::All, vec![person(TextOp::DoesNotContain, "zed")]).compile(today());
    assert!(is_bo.matches(&item, &cx()));
    assert!(
        starts.matches(&item, &cx()),
        "a later word of a name counts"
    );
    assert!(!not_ana.matches(&item, &cx()));
    assert!(not_zed.matches(&item, &cx()));
}

#[test]
fn a_renamed_speaker_matches_by_the_new_name_once_the_item_is_rebuilt() {
    let f = folder(Matching::All, vec![person(TextOp::Is, "Ana")]).compile(today());
    let before = meeting("1:1", &["Speaker 2"], 20, 30);
    assert!(!f.matches(&before, &cx()));
    let after = meeting("1:1", &["Ana"], 20, 30);
    assert!(f.matches(&after, &cx()));
}

#[test]
fn all_and_any() {
    let rules = vec![
        title(TextOp::Contains, "standup"),
        Rule::Length {
            op: LengthOp::LongerThan,
            minutes: 30,
        },
    ];
    let short_standup = meeting("Standup", &[], 20, 15);
    let all = folder(Matching::All, rules.clone()).compile(today());
    let any = folder(Matching::Any, rules).compile(today());
    assert!(!all.matches(&short_standup, &cx()));
    assert!(any.matches(&short_standup, &cx()));
}

#[test]
fn empty_and_unfinished_rules_match_nothing_instead_of_everything() {
    let item = meeting("Anything", &["Ana"], 20, 30);
    assert!(
        !folder(Matching::All, vec![])
            .compile(today())
            .matches(&item, &cx())
    );
    let unfinished = folder(
        Matching::All,
        vec![
            title(TextOp::Contains, "   "),
            person(TextOp::DoesNotContain, ""),
        ],
    )
    .compile(today());
    assert!(unfinished.is_empty());
    assert!(!unfinished.matches(&item, &cx()));
    // An unfinished rule beside a finished one is simply skipped.
    let mixed = folder(
        Matching::All,
        vec![title(TextOp::Contains, ""), person(TextOp::Is, "ana")],
    )
    .compile(today());
    assert!(mixed.matches(&item, &cx()));
}

#[test]
fn a_rule_matching_everything_is_allowed_but_never_the_trash() {
    let everything = folder(
        Matching::All,
        vec![Rule::Date {
            range: DateRange::After {
                date: NaiveDate::from_ymd_opt(1970, 1, 1).unwrap(),
            },
        }],
    )
    .compile(today());
    let mut item = meeting("x", &[], 20, 1);
    assert!(everything.matches(&item, &cx()));
    item.trashed = true;
    assert!(!everything.matches(&item, &cx()));
}

#[test]
fn dates_use_the_local_day() {
    let today_rule = folder(
        Matching::All,
        vec![Rule::Date {
            range: DateRange::Today,
        }],
    )
    .compile(today());
    // 23:30 UTC on the 19th is the 20th in UTC+1.
    let late = Item::new(
        ItemKey::Doc("late".into()),
        ItemKind::Note,
        "late",
        Utc.with_ymd_and_hms(2026, 11, 19, 23, 30, 0).unwrap(),
        ItemFacts::default(),
    );
    assert!(!today_rule.matches(&late, &cx()));
    let plus_one = EvalContext {
        local_day: &plus_one_hour_day,
        ..cx()
    };
    assert!(today_rule.matches(&late, &plus_one));

    let last7 = folder(
        Matching::All,
        vec![Rule::Date {
            range: DateRange::LastDays { days: 7 },
        }],
    )
    .compile(today());
    assert!(last7.matches(&meeting("a", &[], 14, 1), &cx()));
    assert!(!last7.matches(&meeting("a", &[], 13, 1), &cx()));
}

#[test]
fn a_backwards_date_range_is_unfinished() {
    let backwards = folder(
        Matching::All,
        vec![Rule::Date {
            range: DateRange::Between {
                from: today(),
                to: NaiveDate::from_ymd_opt(2026, 1, 1).unwrap(),
            },
        }],
    )
    .compile(today());
    assert!(backwards.is_empty());
}

#[test]
fn length_never_guesses_for_items_without_one() {
    let shorter = folder(
        Matching::All,
        vec![Rule::Length {
            op: LengthOp::ShorterThan,
            minutes: 60,
        }],
    )
    .compile(today());
    let screenshot = Item::new(
        ItemKey::Path("/s.png".into()),
        ItemKind::Screenshot,
        "s",
        Utc::now(),
        ItemFacts::default(),
    );
    assert!(!shorter.matches(&screenshot, &cx()));
}

#[test]
fn folder_rules_follow_membership_and_a_deleted_folder_holds_nothing() {
    let holds = |id: &str, item: &Item| id == "work" && item.title == "in work";
    let ctx = EvalContext {
        in_folder: &holds,
        ..cx()
    };
    let in_work = folder(
        Matching::All,
        vec![Rule::Folder {
            op: IsOp::Is,
            id: "work".into(),
        }],
    )
    .compile(today());
    let in_gone = folder(
        Matching::All,
        vec![Rule::Folder {
            op: IsOp::Is,
            id: "deleted".into(),
        }],
    )
    .compile(today());
    assert!(in_work.matches(&meeting("in work", &[], 20, 1), &ctx));
    assert!(!in_work.matches(&meeting("elsewhere", &[], 20, 1), &ctx));
    assert!(!in_gone.matches(&meeting("in work", &[], 20, 1), &ctx));
}

#[test]
fn unknown_rules_never_match_and_round_trip() {
    let json = r#"{"id":"x","name":"X","matching":"any","rules":[
        {"field":"sentiment","is":"happy"},
        {"field":"title","op":"contains","value":"sync"}]}"#;
    let parsed: SmartFolder = serde_json::from_str(json).unwrap();
    assert!(matches!(parsed.rules[0], Rule::Unknown(_)));
    let compiled = parsed.compile(today());
    assert!(compiled.matches(&meeting("Sync", &[], 20, 1), &cx()));
    assert!(!compiled.matches(&meeting("Other", &[], 20, 1), &cx()));
    let again: serde_json::Value = serde_json::to_value(&parsed).unwrap();
    assert_eq!(again["rules"][0]["is"], "happy");
    assert_eq!(again["rules"][1]["value"], "sync");
}

#[test]
fn ten_thousand_items_and_twenty_folders_evaluate_in_a_few_milliseconds() {
    let items: Vec<Item> = (0..10_000)
        .map(|i| {
            meeting(
                &format!("Meeting {i} about roadmap {}", i % 37),
                &["Ana Pérez", "Bo Chen", "Speaker 3"],
                1 + (i % 28) as u32,
                (i % 90) as u64,
            )
        })
        .collect();
    let folders: Vec<SmartFolder> = (0..20)
        .map(|i| SmartFolder {
            id: format!("f{i}"),
            name: format!("F{i}"),
            matching: if i % 2 == 0 {
                Matching::All
            } else {
                Matching::Any
            },
            rules: vec![
                title(TextOp::Contains, &format!("roadmap {i}")),
                person(TextOp::Is, "bo chen"),
                Rule::Length {
                    op: LengthOp::LongerThan,
                    minutes: 30,
                },
            ],
            extra: Default::default(),
        })
        .collect();
    // Warm up, then take the best of five so a busy machine does not flake.
    let _ = evaluate_all(&folders, &items, &cx());
    let best = (0..5)
        .map(|_| {
            let start = std::time::Instant::now();
            let out = evaluate_all(&folders, &items, &cx());
            assert_eq!(out.len(), 20);
            start.elapsed()
        })
        .min()
        .unwrap();
    eprintln!("evaluate_all 10k x 20: {best:?}");
    assert!(
        best < std::time::Duration::from_millis(if cfg!(debug_assertions) { 400 } else { 40 }),
        "{best:?}"
    );
}

#[test]
fn cycling_fields_comes_back_to_a_text_field_that_keeps_its_text() {
    let mut rule = title(TextOp::Contains, "standup");
    let mut seen_text_fields = 0;
    for _ in 0..7 {
        let text = match &rule {
            Rule::Title { value, .. } | Rule::Person { value, .. } | Rule::App { value, .. } => {
                value.clone()
            }
            _ => String::new(),
        };
        rule = rule.next_field(text);
        if rule.takes_text() {
            seen_text_fields += 1;
        }
    }
    // Title -> Person -> App -> Kind -> Date -> Length -> Has -> Title.
    assert_eq!(seen_text_fields, 3);
    assert!(matches!(rule, Rule::Title { .. }));
    assert!(rule.takes_text());
    // Person and App carried the text; after the non-text fields it starts
    // empty and is finished by typing, as any new rule is.
    let person = title(TextOp::Is, "Ana").next_field("Ana".into());
    assert_eq!(
        person,
        Rule::Person {
            op: TextOp::Is,
            value: "Ana".into()
        }
    );
    let typed = match rule {
        Rule::Title { op, .. } => Rule::Title {
            op,
            value: "retro".into(),
        },
        other => other,
    };
    let saved: SmartFolder =
        serde_json::from_value(serde_json::to_value(folder(Matching::All, vec![typed])).unwrap())
            .unwrap();
    assert_eq!(saved.rules, vec![title(TextOp::Contains, "retro")]);
}

#[test]
fn a_date_rule_puts_a_summer_meeting_on_its_own_local_day() {
    // London: 23:30 UTC on 9 July is 00:30 on 10 July (BST), even when the
    // rule runs in November (GMT, offset zero).
    let london = |at: chrono::DateTime<Utc>| {
        at.with_timezone(&cap_calendar::Tz::Europe__London)
            .date_naive()
    };
    let july_10 = NaiveDate::from_ymd_opt(2026, 7, 10).unwrap();
    let rule = folder(
        Matching::All,
        vec![Rule::Date {
            range: DateRange::Between {
                from: july_10,
                to: july_10,
            },
        }],
    )
    .compile(today());
    let item = Item::new(
        ItemKey::Doc("july".into()),
        ItemKind::Meeting,
        "july",
        Utc.with_ymd_and_hms(2026, 7, 9, 23, 30, 0).unwrap(),
        ItemFacts::default(),
    );
    let in_london = EvalContext {
        local_day: &london,
        ..cx()
    };
    assert!(rule.matches(&item, &in_london));
}
