use chrono::TimeZone;

use super::*;
use crate::transcript::PromptTranscript;

#[test]
fn built_in_set_is_complete_and_well_formed() {
    let templates = built_in_templates();
    let names: Vec<&str> = templates.iter().map(|t| t.name.as_str()).collect();
    assert_eq!(
        names,
        vec![
            "General meeting",
            "One-on-one",
            "Stand-up",
            "Customer call",
            "Sales discovery",
            "Interview",
            "Project kickoff",
            "Retrospective",
            "Brainstorm",
            "Board or investor update",
        ]
    );
    for (i, t) in templates.iter().enumerate() {
        assert!(t.built_in);
        assert_eq!(t.applies_to, vec![DocKind::Meeting]);
        assert!((3..=6).contains(&t.sections.len()), "{}", t.id);
        assert!(!t.description.is_empty());
        assert!(templates[i + 1..].iter().all(|o| o.id != t.id));
        for s in &t.sections {
            assert!(!s.heading.is_empty());
            assert!(s.instruction.ends_with('.'), "{}: {}", t.id, s.instruction);
            assert_eq!(
                s.instruction.matches(". ").count(),
                0,
                "one sentence: {}",
                s.instruction
            );
            assert!(!s.instruction.contains('\u{2014}'));
        }
    }
    assert!(find_template(&templates, DEFAULT_TEMPLATE_ID).is_some());
}

#[test]
fn user_templates_round_trip_and_never_shadow_built_ins() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("templates.json");
    assert!(load_user_templates(&path).unwrap().is_empty());
    let mine = Template {
        id: "design-review".into(),
        name: "Design review".into(),
        description: "Critique a design.".into(),
        sections: vec![Section {
            heading: "Feedback".into(),
            instruction: "What reviewers said.".into(),
        }],
        built_in: true,
        applies_to: vec![DocKind::Meeting, DocKind::Other("whiteboard".into())],
    };
    let shadow = Template {
        id: "general".into(),
        name: "My general".into(),
        ..Template::default()
    };
    let mut all = built_in_templates();
    all.push(mine.clone());
    all.push(shadow.clone());
    let shadow_copy = shadow.clone();
    save_user_templates(&path, &[mine.clone(), shadow]).unwrap();
    let loaded = load_user_templates(&path).unwrap();
    assert_eq!(loaded.len(), 1);
    assert!(!loaded[0].built_in);
    assert_eq!(loaded[0].applies_to[1], DocKind::Other("whiteboard".into()));
    let merged = all_templates(&[loaded, vec![shadow_copy]].concat());
    assert_eq!(merged.len(), 11);
    assert_eq!(
        find_template(&merged, "general").unwrap().name,
        "General meeting"
    );
    assert!(!find_template(&merged, "design-review").unwrap().built_in);
    assert_eq!(templates_for(&merged, &DocKind::Note).len(), 0);
    assert_eq!(templates_for(&merged, &DocKind::Meeting).len(), 11);
    assert_eq!(
        templates_for(&merged, &DocKind::Other("whiteboard".into())).len(),
        1
    );
}

#[test]
fn loader_skips_bad_entries_and_accepts_wrapped_form() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("templates.json");
    std::fs::write(
        &path,
        r#"{"templates": [
            {"id": "ok", "name": "Ok", "sections": [{"heading": "A", "extra": 1}], "future": true},
            {"id": "", "name": "No id"},
            {"id": "bad", "sections": "not a list"},
            42
        ]}"#,
    )
    .unwrap();
    let loaded = load_user_templates(&path).unwrap();
    assert_eq!(loaded.len(), 1);
    assert_eq!(loaded[0].sections[0].heading, "A");
    assert!(loaded[0].applies_to.is_empty());
    std::fs::write(&path, "{ torn").unwrap();
    assert!(load_user_templates(&path).is_err());
}

#[test]
fn scaffold_markdown_lists_headings() {
    let t = find_template(&built_in_templates(), "stand-up")
        .cloned()
        .unwrap();
    assert_eq!(
        scaffold_markdown(&t),
        "## Updates by person\n\n## Blockers\n\n## Follow-ups"
    );
    assert_eq!(scaffold_markdown(&Template::default()), "");
}

#[test]
fn heading_count_scales_with_transcript() {
    assert_eq!(suggested_heading_count(0), 4);
    assert_eq!(suggested_heading_count(7_999), 4);
    assert_eq!(suggested_heading_count(8_000), 5);
    assert_eq!(suggested_heading_count(20_000), 6);
    assert_eq!(suggested_heading_count(30_000), 7);
    assert_eq!(suggested_heading_count(44_000), 8);
    assert_eq!(suggested_heading_count(usize::MAX), 8);
}

#[test]
fn notes_request_serialises_camel_case() {
    let template = find_template(&built_in_templates(), "general")
        .cloned()
        .unwrap();
    let request = NotesRequest::builder("  Weekly sync ", &template)
        .when(
            Utc.with_ymd_and_hms(2026, 11, 12, 10, 0, 0).unwrap(),
            Some(1_800_000),
        )
        .participants(["Richie", " ", "Dana"])
        .user_notes("- ship it")
        .transcript(PromptTranscript {
            text: "x".repeat(9_000),
            truncated: true,
        })
        .vocabulary(&["Cap".to_string(), "  ".to_string()])
        .summary_language(Some(" ".into()))
        .rewrite("Old summary", "Make it shorter")
        .build();
    assert_eq!(request.title, "Weekly sync");
    assert_eq!(request.participants, vec!["Richie", "Dana"]);
    assert_eq!(request.heading_count, 5);
    assert_eq!(request.summary_language, None);
    assert_eq!(request.vocabulary, vec!["Cap"]);
    let json = request.to_json();
    for key in [
        "\"userNotes\"",
        "\"transcriptTruncated\":true",
        "\"previousSummary\":\"Old summary\"",
        "\"rewriteInstruction\":\"Make it shorter\"",
        "\"headingCount\":5",
        "\"startedAt\"",
        "\"durationMs\":1800000",
    ] {
        assert!(json.contains(key), "{key}");
    }
    let back: NotesRequest = serde_json::from_str(&json).unwrap();
    assert_eq!(back, request);
    let minimal: NotesRequest = serde_json::from_str("{\"title\":\"t\",\"unknown\":1}").unwrap();
    assert_eq!(minimal.title, "t");
}
