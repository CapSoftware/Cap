use super::*;

fn urls(list: &[&str]) -> BrowserEvidence {
    BrowserEvidence {
        urls: list.iter().map(|s| s.to_string()).collect(),
        titles: Vec::new(),
        complete: true,
    }
}

fn titles(list: &[&str], complete: bool) -> BrowserEvidence {
    BrowserEvidence {
        urls: Vec::new(),
        titles: list.iter().map(|s| s.to_string()).collect(),
        complete,
    }
}

fn provider(verdict: &BrowserVerdict) -> Option<WebProvider> {
    match verdict {
        BrowserVerdict::Meeting { provider, .. } => Some(*provider),
        _ => None,
    }
}

#[test]
fn recognises_every_provider_by_url() {
    let cases: &[(&str, WebProvider, Option<&str>)] = &[
        (
            "https://meet.google.com/abc-defg-hij",
            WebProvider::GoogleMeet,
            Some("abc-defg-hij"),
        ),
        (
            "https://meet.google.com/ABC-DEFG-HIJ?authuser=1",
            WebProvider::GoogleMeet,
            Some("abc-defg-hij"),
        ),
        (
            "https://app.zoom.us/wc/81234567890/join?fromPWA=1",
            WebProvider::Zoom,
            Some("81234567890"),
        ),
        (
            "https://acme.zoom.us/j/81234567890?pwd=x",
            WebProvider::Zoom,
            Some("81234567890"),
        ),
        (
            "https://zoom.us/wc/join/81234567890",
            WebProvider::Zoom,
            Some("81234567890"),
        ),
        (
            "https://teams.microsoft.com/l/meetup-join/19%3ameeting_x/0",
            WebProvider::Teams,
            None,
        ),
        (
            "https://teams.microsoft.com/_#/pre-join-calling/19:meeting",
            WebProvider::Teams,
            None,
        ),
        (
            "https://teams.live.com/meet/9876543210",
            WebProvider::Teams,
            Some("9876543210"),
        ),
        (
            "https://teams.cloud.microsoft/light-meetings/launch?x=1",
            WebProvider::Teams,
            None,
        ),
        (
            "https://acme.webex.com/meet/jane",
            WebProvider::Webex,
            Some("jane"),
        ),
        (
            "https://acme.webex.com/wbxmjs/joinservice/sites/acme",
            WebProvider::Webex,
            None,
        ),
        (
            "https://acme.webex.com/webappng/sites/acme/meeting/info",
            WebProvider::Webex,
            None,
        ),
        (
            "https://whereby.com/acme-standup",
            WebProvider::Whereby,
            Some("acme-standup"),
        ),
        (
            "https://meet.jit.si/OurRoom",
            WebProvider::Jitsi,
            Some("OurRoom"),
        ),
        (
            "https://8x8.vc/vpaas-magic/room-1",
            WebProvider::Jitsi,
            Some("room-1"),
        ),
        (
            "https://app.slack.com/huddle/T123/C456",
            WebProvider::SlackHuddle,
            None,
        ),
        (
            "https://discord.com/channels/123/456",
            WebProvider::Discord,
            None,
        ),
        (
            "https://app.gather.town/app/abc/office",
            WebProvider::Gather,
            None,
        ),
        (
            "https://meet.around.co/r/acme",
            WebProvider::Around,
            Some("acme"),
        ),
        (
            "https://riverside.fm/studio/acme-pod",
            WebProvider::Riverside,
            Some("acme-pod"),
        ),
        (
            "https://streamyard.com/broadcasts/abc/studio",
            WebProvider::StreamYard,
            None,
        ),
        (
            "https://acme.daily.co/standup",
            WebProvider::Daily,
            Some("standup"),
        ),
        (
            "https://app.cal.com/video/uid123",
            WebProvider::CalVideo,
            Some("uid123"),
        ),
        (
            "https://chat.google.com/room/AAA/call",
            WebProvider::GoogleChat,
            None,
        ),
        ("https://web.whatsapp.com/", WebProvider::WhatsApp, None),
        (
            "https://www.messenger.com/groupcall/ROOM:123",
            WebProvider::Messenger,
            None,
        ),
        ("https://web.skype.com/", WebProvider::Skype, None),
        (
            "https://app.livestorm.co/p/abc/live",
            WebProvider::Livestorm,
            None,
        ),
        (
            "https://vc.larksuite.com/j/123456789",
            WebProvider::Lark,
            Some("123456789"),
        ),
        (
            "https://acme.feishu.cn/j/987654321",
            WebProvider::Lark,
            Some("987654321"),
        ),
        (
            "https://meeting.zoho.com/meeting/abc",
            WebProvider::ZohoMeeting,
            None,
        ),
        (
            "https://bluejeans.com/123456789",
            WebProvider::BlueJeans,
            Some("123456789"),
        ),
        (
            "https://app.goto.com/meeting/123456789",
            WebProvider::GoTo,
            Some("123456789"),
        ),
        (
            "https://v.ringcentral.com/join/123456789",
            WebProvider::RingCentral,
            Some("123456789"),
        ),
        (
            "https://app.chime.aws/meetings/1234567890",
            WebProvider::Chime,
            Some("1234567890"),
        ),
        (
            "https://pop.com/j/123-456-789",
            WebProvider::Pop,
            Some("123-456-789"),
        ),
        (
            "https://app.tandem.chat/room/abc",
            WebProvider::Tandem,
            None,
        ),
        (
            "https://app.butter.us/session/abc",
            WebProvider::Butter,
            None,
        ),
        ("https://event.demio.com/ref/abc", WebProvider::Demio, None),
    ];
    for (url, expected, id) in cases {
        let verdict = judge_browser(&urls(&[url]));
        match verdict {
            BrowserVerdict::Meeting {
                provider,
                meeting_id,
                ..
            } => {
                assert_eq!(provider, *expected, "{url}");
                assert_eq!(meeting_id.as_deref(), *id, "{url}");
            }
            other => panic!("{url} gave {other:?}"),
        }
    }
}

#[test]
fn non_meeting_urls() {
    for url in [
        "https://meet.google.com/",
        "https://meet.google.com/landing",
        "https://zoom.us/pricing",
        "https://app.zoom.us/wc/home",
        "https://teams.microsoft.com/v2/",
        "https://www.google.com/search?q=meet.google.com/abc-defg-hij",
        "https://whereby.com/user",
        "https://app.slack.com/client/T123/C456",
        "https://discord.com/app",
        "https://chatgpt.com/",
        "https://docs.google.com/document/d/1",
        "https://evil.com/meet.google.com/abc-defg-hij",
        "https://notzoom.us/j/123",
        "file:///Users/me/zoom.us/j/1",
        "not a url at all",
        "",
    ] {
        assert_eq!(
            judge_browser(&urls(&[url])),
            BrowserVerdict::NotMeeting,
            "{url:?}"
        );
    }
}

#[test]
fn incomplete_evidence_without_match_is_unknown() {
    let evidence = BrowserEvidence {
        urls: vec!["https://chatgpt.com/".into()],
        titles: vec!["ChatGPT".into()],
        complete: false,
    };
    assert_eq!(judge_browser(&evidence), BrowserVerdict::Unknown);
    assert_eq!(
        judge_browser(&BrowserEvidence::default()),
        BrowserVerdict::Unknown
    );
    assert_eq!(
        judge_browser(&BrowserEvidence {
            complete: true,
            ..BrowserEvidence::default()
        }),
        BrowserVerdict::NotMeeting
    );
}

#[test]
fn any_matching_tab_wins() {
    let evidence = urls(&[
        "https://mail.google.com/mail/u/0/#inbox",
        "https://meet.google.com/abc-defg-hij",
    ]);
    assert_eq!(
        provider(&judge_browser(&evidence)),
        Some(WebProvider::GoogleMeet)
    );
}

#[test]
fn titles_identify_meetings_conservatively() {
    let cases: &[(&str, Option<WebProvider>, Option<&str>)] = &[
        ("Meet - abc-defg-hij", Some(WebProvider::GoogleMeet), None),
        (
            "Meet \u{2013} Weekly sync - Google Chrome",
            Some(WebProvider::GoogleMeet),
            Some("Weekly sync"),
        ),
        (
            "(2) Meet - Planning - Camera and microphone recording - Google Chrome",
            Some(WebProvider::GoogleMeet),
            Some("Planning"),
        ),
        ("Zoom Meeting", Some(WebProvider::Zoom), None),
        (
            "Zoom Webinar - Microsoft\u{200b} Edge",
            Some(WebProvider::Zoom),
            None,
        ),
        (
            "Meeting with Bob | Microsoft Teams",
            Some(WebProvider::Teams),
            Some("Meeting with Bob"),
        ),
        (
            "Roadmap review | Meeting | Microsoft Teams",
            Some(WebProvider::Teams),
            Some("Roadmap review"),
        ),
        (
            "Call with Alice | Microsoft Teams",
            Some(WebProvider::Teams),
            Some("Call with Alice"),
        ),
        (
            "Huddle: #design - Acme - Slack",
            Some(WebProvider::SlackHuddle),
            None,
        ),
        ("Webex Meeting", Some(WebProvider::Webex), None),
        (
            "OurRoom | Jitsi Meet",
            Some(WebProvider::Jitsi),
            Some("OurRoom"),
        ),
        ("Chat | Bob | Microsoft Teams", None, None),
        ("Calls | Microsoft Teams", None, None),
        ("Calendar | Microsoft Teams", None, None),
        ("Google Meet", None, None),
        ("Meet", None, None),
        ("Meeting notes - Google Docs", None, None),
        ("How to run a Zoom meeting - YouTube", None, None),
        ("Slack", None, None),
        ("Jitsi Meet", None, None),
        ("Meet - ", None, None),
    ];
    for (title, expected, expected_title) in cases {
        let verdict = judge_browser(&titles(&[title], true));
        assert_eq!(provider(&verdict), *expected, "{title}");
        if let BrowserVerdict::Meeting { title: got, .. } = verdict {
            assert_eq!(got.as_deref(), *expected_title, "{title}");
        }
    }
}

#[test]
fn url_match_takes_title_from_aligned_tab() {
    let evidence = BrowserEvidence {
        urls: vec![
            "https://example.com".into(),
            "https://teams.microsoft.com/l/meetup-join/abc".into(),
        ],
        titles: vec![
            "Example".into(),
            "Quarterly planning | Microsoft Teams".into(),
        ],
        complete: true,
    };
    match judge_browser(&evidence) {
        BrowserVerdict::Meeting {
            provider, title, ..
        } => {
            assert_eq!(provider, WebProvider::Teams);
            assert_eq!(title.as_deref(), Some("Quarterly planning"));
        }
        other => panic!("{other:?}"),
    }

    let meet = BrowserEvidence {
        urls: vec!["https://meet.google.com/abc-defg-hij".into()],
        titles: vec!["Meet - abc-defg-hij".into()],
        complete: true,
    };
    match judge_browser(&meet) {
        BrowserVerdict::Meeting {
            meeting_id, title, ..
        } => {
            assert_eq!(meeting_id.as_deref(), Some("abc-defg-hij"));
            assert_eq!(title, None);
        }
        other => panic!("{other:?}"),
    }

    let zoom = BrowserEvidence {
        urls: vec!["https://app.zoom.us/wc/123456/join".into()],
        titles: vec!["Design crit - Zoom - Google Chrome".into()],
        complete: true,
    };
    match judge_browser(&zoom) {
        BrowserVerdict::Meeting { title, .. } => assert_eq!(title.as_deref(), Some("Design crit")),
        other => panic!("{other:?}"),
    }
}

#[test]
fn unaligned_titles_still_enrich_from_matching_title() {
    let evidence = BrowserEvidence {
        urls: vec!["https://meet.google.com/abc-defg-hij".into()],
        titles: vec!["Inbox".into(), "Meet - Board prep".into()],
        complete: false,
    };
    match judge_browser(&evidence) {
        BrowserVerdict::Meeting { title, .. } => assert_eq!(title.as_deref(), Some("Board prep")),
        other => panic!("{other:?}"),
    }
}

#[test]
fn verdict_round_trips_json() {
    let verdict = BrowserVerdict::Meeting {
        provider: WebProvider::GoogleMeet,
        meeting_id: Some("abc-defg-hij".into()),
        title: None,
    };
    let json = serde_json::to_string(&verdict).unwrap();
    assert!(json.contains("\"meetingId\""));
    assert_eq!(
        serde_json::from_str::<BrowserVerdict>(&json).unwrap(),
        verdict
    );
}

#[test]
fn hostile_inputs_never_panic() {
    let weird = [
        "https://",
        "https://@",
        "https://:80/",
        "http://[::1]:80/meet",
        "https://meet.google.com/\u{1F600}-\u{1F600}-\u{1F600}",
        "(",
        "(99",
        "(\u{1F600}) Meet - x",
        " - - - ",
        "|||",
        "\u{2014}\u{2014}",
        "Meet \u{2014} ",
        "https://zoom.us/j/",
        "https://8x8.vc/",
    ];
    for w in weird {
        let _ = judge_browser(&urls(&[w]));
        let _ = judge_browser(&titles(&[w], false));
    }
}
