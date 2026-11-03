use super::*;

pub(super) fn is_repair_surface_key(key: &str) -> bool {
    key.starts_with("repair.")
}

const FORMATTED: &[&str] = &[
    "repair.status.worked_for",
    "repair.status.duration_seconds",
    "repair.status.duration_minutes",
    "repair.status.timer_seconds",
    "repair.status.timer_minutes",
    "repair.status.earlier_thoughts",
    "repair.help.size_line",
    "repair.sending.progress",
    "repair.bytes.gigabytes",
    "repair.bytes.megabytes",
    "repair.bytes.kilobytes",
];

#[test]
fn repair_surfaces_read_in_english() {
    let pairs: &[(&str, &str)] = &[
        (tr::repair::fix(), "Fix"),
        (tr::repair::fix_recording(), "Fix recording"),
        (tr::repair::window::title(), "Fix recording"),
        (tr::repair::window::recover_failed(), "Recovery failed"),
        (
            tr::repair::window::open_failed(),
            "Couldn't open this recording",
        ),
        (
            tr::repair::window::privacy(),
            "Cap looks at this recording's files to repair it. Nothing else on your computer is read.",
        ),
        (tr::repair::window::cancel(), "Cancel"),
        (tr::repair::window::close(), "Close"),
        (
            tr::repair::status::connecting(),
            "Starting a secure workspace",
        ),
        (tr::repair::status::working(), "Looking at your recording"),
        (tr::repair::status::verifying(), "Testing the fix"),
        (tr::repair::status::sending(), "Sending to Cap"),
        (tr::repair::status::fewer_thoughts(), "Show fewer notes"),
        (tr::repair::tool::describe(), "Overview"),
        (tr::repair::tool::list(), "List"),
        (tr::repair::tool::read(), "Read"),
        (tr::repair::tool::inspect(), "Inspect"),
        (tr::repair::tool::pull(), "Copy"),
        (tr::repair::tool::edit(), "Edit"),
        (tr::repair::tool::truncate(), "Trim"),
        (tr::repair::tool::remove(), "Set aside"),
        (tr::repair::tool::replace(), "Replace"),
        (tr::repair::tool::verify(), "Test"),
        (tr::repair::tool::source_read(), "Read source"),
        (tr::repair::tool::search(), "Search"),
        (tr::repair::tool::run(), "Run"),
        (tr::repair::tool::write(), "Write"),
        (tr::repair::fixed::title(), "Your recording is fixed"),
        (tr::repair::fixed::open(), "Open recording"),
        (
            tr::repair::help::cant_fix_title(),
            "This recording needs a closer look",
        ),
        (tr::repair::help::failed_title(), "Fix couldn't finish"),
        (
            tr::repair::help::send_failed_title(),
            "Sending didn't finish",
        ),
        (
            tr::repair::help::explanation(),
            "Send this recording to the Cap team and we'll repair it by hand and email you.",
        ),
        (tr::repair::help::send(), "Send to Cap"),
        (
            tr::repair::sent::title(),
            "Sent. We'll email you when it's repaired.",
        ),
        (tr::repair::sign_in::title(), "Sign in to fix recordings"),
        (tr::repair::sign_in::body(), "Fix runs on your Cap account."),
        (tr::repair::sign_in::button(), "Sign In"),
        (tr::repair::sign_in::waiting(), "Waiting for your browser"),
    ];
    for (translated, literal) in pairs {
        assert_eq!(translated, literal);
    }
    let plain_keys = KEYS.iter().filter(|key| is_repair_surface_key(key)).count() - FORMATTED.len();
    assert_eq!(
        pairs.len(),
        plain_keys,
        "every plain key has a literal above"
    );
    for key in FORMATTED {
        assert!(KEYS.contains(key), "{key}");
    }
}

#[test]
fn repair_messages_format_in_english() {
    assert_eq!(
        tr::repair::status::worked_for("1m 12s"),
        "Worked for 1m 12s"
    );
    assert_eq!(tr::repair::status::duration_seconds(42), "42s");
    assert_eq!(tr::repair::status::duration_minutes(1, 12), "1m 12s");
    assert_eq!(tr::repair::status::timer_seconds("4.2"), "4.2s");
    assert_eq!(tr::repair::status::timer_minutes(1, "3.4"), "1m 3.4s");
    assert_eq!(
        tr::repair::status::earlier_thoughts(1),
        "Show 1 earlier note"
    );
    assert_eq!(
        tr::repair::status::earlier_thoughts(4),
        "Show 4 earlier notes"
    );
    assert_eq!(tr::repair::help::size_line("1.2 GB"), "Size: 1.2 GB");
    assert_eq!(
        tr::repair::sending::progress("120 MB", "1.2 GB"),
        "120 MB of 1.2 GB"
    );
    assert_eq!(tr::repair::bytes::gigabytes("1.2"), "1.2 GB");
    assert_eq!(tr::repair::bytes::megabytes("120"), "120 MB");
    assert_eq!(tr::repair::bytes::kilobytes("18"), "18 KB");
}
