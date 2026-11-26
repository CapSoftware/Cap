use std::collections::HashSet;

use cap_calendar::link::find_all_meeting_links;
use cap_calendar::{
    ConferenceEntry, ConferenceKind, MeetingLink, Provider, classify_url, event_meeting_link,
    find_meeting_link,
};

fn check(url: &str, provider: Provider, id: Option<&str>) {
    let link = classify_url(url).unwrap_or_else(|| panic!("expected {provider:?} for {url}"));
    assert_eq!(link.provider, provider, "{url}");
    assert_eq!(link.meeting_id.as_deref(), id, "{url}");
    assert!(link.url.starts_with("https://"), "{url} -> {}", link.url);
}

fn reject(url: &str) {
    assert_eq!(classify_url(url), None, "{url} must not match");
}

const POSITIVE: &[(&str, Provider, Option<&str>)] = &[
    (
        "https://zoom.us/j/1234567890",
        Provider::Zoom,
        Some("1234567890"),
    ),
    (
        "https://us02web.zoom.us/j/81234567890?pwd=abc123",
        Provider::Zoom,
        Some("81234567890"),
    ),
    ("https://acme.zoom.us/my/jane.doe", Provider::Zoom, None),
    (
        "https://zoom.us/w/98765432101?tk=x",
        Provider::Zoom,
        Some("98765432101"),
    ),
    (
        "https://zoomgov.com/j/1612345678",
        Provider::Zoom,
        Some("1612345678"),
    ),
    (
        "https://acme.zoomgov.com/j/1612345678?pwd=q",
        Provider::Zoom,
        Some("1612345678"),
    ),
    (
        "https://zoom.com/j/1234567890",
        Provider::Zoom,
        Some("1234567890"),
    ),
    (
        "https://app.zoom.us/wc/join/1234567890",
        Provider::Zoom,
        Some("1234567890"),
    ),
    (
        "https://us05web.zoom.us/wc/1234567890/join?pwd=x",
        Provider::Zoom,
        Some("1234567890"),
    ),
    (
        "https://acme.zoom.us/s/1234567890",
        Provider::Zoom,
        Some("1234567890"),
    ),
    (
        "https://zoom.us/meeting/register/tJ0kcuqrrzMsHtE",
        Provider::Zoom,
        None,
    ),
    (
        "https://zoom.us/join?confno=1234567890",
        Provider::Zoom,
        Some("1234567890"),
    ),
    (
        "https://meet.google.com/abc-defg-hij",
        Provider::GoogleMeet,
        Some("abc-defg-hij"),
    ),
    (
        "https://meet.google.com/ABC-DEFG-HIJ?authuser=1",
        Provider::GoogleMeet,
        Some("abc-defg-hij"),
    ),
    (
        "meet.google.com/abc-defg-hij",
        Provider::GoogleMeet,
        Some("abc-defg-hij"),
    ),
    (
        "https://meet.google.com/lookup/acme-standup",
        Provider::GoogleMeet,
        None,
    ),
    (
        "https://hangouts.google.com/hangouts/_/acme.example/weekly",
        Provider::GoogleMeet,
        None,
    ),
    (
        "https://teams.microsoft.com/l/meetup-join/19%3ameeting_NjE2ODk3%40thread.v2/0?context=%7b%22Tid%22%3a%22t%22%7d",
        Provider::Teams,
        Some("19:meeting_NjE2ODk3@thread.v2"),
    ),
    (
        "https://teams.live.com/meet/9876543210123?p=AbCd",
        Provider::Teams,
        Some("9876543210123"),
    ),
    (
        "https://teams.microsoft.com/meet/2345678901234?p=XyZ",
        Provider::Teams,
        Some("2345678901234"),
    ),
    (
        "https://teams.cloud.microsoft/l/meetup-join/19%3ameeting_abc%40thread.v2/0",
        Provider::Teams,
        Some("19:meeting_abc@thread.v2"),
    ),
    (
        "https://gov.teams.microsoft.us/l/meetup-join/19%3ameeting_gcc%40thread.v2/0?context=x",
        Provider::Teams,
        Some("19:meeting_gcc@thread.v2"),
    ),
    (
        "https://dod.teams.microsoft.us/l/meetup-join/19%3ameeting_dod%40thread.v2/0",
        Provider::Teams,
        Some("19:meeting_dod@thread.v2"),
    ),
    (
        "https://teams.microsoft.com/v2/?meetingjoin=true#/l/meetup-join/19:meeting_v2frag@thread.v2/0?context=x",
        Provider::Teams,
        Some("19:meeting_v2frag@thread.v2"),
    ),
    (
        "https://teams.microsoft.com/dl/launcher/launcher.html?url=%2F_%23%2Fl%2Fmeetup-join%2F19%3Ameeting_launch%40thread.v2%2F0%3Fcontext%3Dx&type=meetup-join",
        Provider::Teams,
        Some("19:meeting_launch@thread.v2"),
    ),
    (
        "msteams:/l/meetup-join/19%3ameeting_app%40thread.v2/0",
        Provider::Teams,
        Some("19:meeting_app@thread.v2"),
    ),
    (
        "https://acme.webex.com/acme/j.php?MTID=m1234abcd",
        Provider::Webex,
        Some("m1234abcd"),
    ),
    (
        "https://acme.webex.com/acme/e.php?MTID=e5678",
        Provider::Webex,
        Some("e5678"),
    ),
    (
        "https://acme.webex.com/meet/jane.doe",
        Provider::Webex,
        None,
    ),
    ("https://web.webex.com/meet/jdoe", Provider::Webex, None),
    ("https://acme.webexgov.us/meet/jdoe", Provider::Webex, None),
    (
        "https://acme.webex.com/wbxmjs/joinservice/sites/acme/meeting/download/abc123def?siteurl=acme",
        Provider::Webex,
        Some("abc123def"),
    ),
    (
        "https://app.slack.com/huddle/T01ABCDEF/C02GHIJKL",
        Provider::Slack,
        Some("C02GHIJKL"),
    ),
    (
        "https://acme.slack.com/huddle/T01ABCDEF/C02GHIJKL",
        Provider::Slack,
        Some("C02GHIJKL"),
    ),
    ("https://whereby.com/acme-standup", Provider::Whereby, None),
    (
        "https://acme.whereby.com/design-room",
        Provider::Whereby,
        None,
    ),
    ("https://appear.in/old-room", Provider::Whereby, None),
    (
        "https://meet.around.co/r/acme-team",
        Provider::Around,
        Some("acme-team"),
    ),
    (
        "https://around.co/r/standup",
        Provider::Around,
        Some("standup"),
    ),
    (
        "https://global.gotomeeting.com/join/123456789",
        Provider::GoToMeeting,
        Some("123456789"),
    ),
    (
        "https://meet.goto.com/123456789",
        Provider::GoToMeeting,
        Some("123456789"),
    ),
    (
        "https://meet.goto.com/acme-weekly",
        Provider::GoToMeeting,
        None,
    ),
    ("https://gotomeet.me/janedoe", Provider::GoToMeeting, None),
    (
        "https://app.goto.com/meeting/987654321",
        Provider::GoToMeeting,
        Some("987654321"),
    ),
    (
        "https://attendee.gotowebinar.com/register/1234567890123456789",
        Provider::GoToWebinar,
        Some("1234567890123456789"),
    ),
    (
        "https://global.gotowebinar.com/join/1234567890123456789/987654321",
        Provider::GoToWebinar,
        Some("1234567890123456789"),
    ),
    (
        "https://bluejeans.com/123456789",
        Provider::BlueJeans,
        Some("123456789"),
    ),
    (
        "https://bluejeans.com/123456789/4321/webrtc",
        Provider::BlueJeans,
        Some("123456789"),
    ),
    (
        "https://acme.bluejeans.com/5551234567",
        Provider::BlueJeans,
        Some("5551234567"),
    ),
    (
        "https://meet.jit.si/AcmeWeeklySync",
        Provider::Jitsi,
        Some("AcmeWeeklySync"),
    ),
    (
        "https://8x8.vc/acme-tenant/weekly",
        Provider::Jitsi,
        Some("weekly"),
    ),
    ("https://8x8.vc/RoomName", Provider::Jitsi, Some("RoomName")),
    (
        "https://discord.com/channels/123456789012345678/876543210987654321",
        Provider::Discord,
        Some("876543210987654321"),
    ),
    (
        "https://discordapp.com/channels/123456789012345678/876543210987654321",
        Provider::Discord,
        Some("876543210987654321"),
    ),
    (
        "https://discord.com/events/123456789012345678/112233445566778899",
        Provider::Discord,
        Some("112233445566778899"),
    ),
    (
        "https://join.skype.com/AbCdEfGhIjKl",
        Provider::Skype,
        Some("AbCdEfGhIjKl"),
    ),
    (
        "https://meet.lync.com/contoso/jdoe/AB12CD34",
        Provider::Skype,
        Some("AB12CD34"),
    ),
    (
        "https://chime.aws/1234567890",
        Provider::Chime,
        Some("1234567890"),
    ),
    (
        "https://app.chime.aws/meetings/?pin=1234567890",
        Provider::Chime,
        Some("1234567890"),
    ),
    (
        "https://meetings.ringcentral.com/j/1234567890",
        Provider::RingCentral,
        Some("1234567890"),
    ),
    (
        "https://v.ringcentral.com/join/123456789",
        Provider::RingCentral,
        Some("123456789"),
    ),
    (
        "https://video.ringcentral.com/join/123456789",
        Provider::RingCentral,
        Some("123456789"),
    ),
    (
        "https://meetings.dialpad.com/acme-weekly",
        Provider::Dialpad,
        None,
    ),
    (
        "https://dialpad.com/meetings/janedoe",
        Provider::Dialpad,
        None,
    ),
    (
        "https://meeting.zoho.com/meeting/login/join.jsp?key=1234567890",
        Provider::ZohoMeeting,
        Some("1234567890"),
    ),
    (
        "https://meeting.zoho.eu/join?key=987654321",
        Provider::ZohoMeeting,
        Some("987654321"),
    ),
    (
        "https://meeting.zoho.com.au/meeting/login/join.jsp?key=555",
        Provider::ZohoMeeting,
        Some("555"),
    ),
    (
        "https://vc.larksuite.com/j/123456789",
        Provider::Lark,
        Some("123456789"),
    ),
    (
        "https://vc.feishu.cn/j/987654321",
        Provider::Lark,
        Some("987654321"),
    ),
    (
        "https://tuple.app/c/AbCdEf123",
        Provider::Tuple,
        Some("AbCdEf123"),
    ),
    ("https://www.tuple.app/c/xyz", Provider::Tuple, Some("xyz")),
    (
        "https://app.gather.town/app/AbCdEfGh12345678/acme-office",
        Provider::Gather,
        Some("AbCdEfGh12345678"),
    ),
    (
        "https://gather.town/invite?token=abc",
        Provider::Gather,
        None,
    ),
    (
        "https://riverside.fm/studio/acme-podcast?t=abc",
        Provider::Riverside,
        None,
    ),
    (
        "https://riverside.com/studio/weekly-show",
        Provider::Riverside,
        None,
    ),
    (
        "https://streamyard.com/n8yuqz6ttd",
        Provider::StreamYard,
        Some("n8yuqz6ttd"),
    ),
    (
        "https://streamyard.com/a1b2c3d4e5",
        Provider::StreamYard,
        Some("a1b2c3d4e5"),
    ),
    (
        "https://call.whatsapp.com/video/AbCdEfGhIjKlMn",
        Provider::WhatsApp,
        Some("AbCdEfGhIjKlMn"),
    ),
    (
        "https://call.whatsapp.com/voice/ZyXwVuTs",
        Provider::WhatsApp,
        Some("ZyXwVuTs"),
    ),
    (
        "https://facetime.apple.com/join#v=1&p=AbCdEf&k=XyZ",
        Provider::FaceTime,
        None,
    ),
    (
        "http://facetime.apple.com/join?src=msg#v=1&p=Q1w2E3&k=r4T5",
        Provider::FaceTime,
        None,
    ),
    (
        "https://app.cal.com/video/abc123XYZ",
        Provider::CalVideo,
        Some("abc123XYZ"),
    ),
    (
        "https://cal.com/video/9f8e7d6c",
        Provider::CalVideo,
        Some("9f8e7d6c"),
    ),
    ("https://acme.daily.co/standup", Provider::Daily, None),
    ("https://team-x.daily.co/AbC123", Provider::Daily, None),
    (
        "https://app.livestorm.co/p/0b1c2d3e-aaaa-bbbb-cccc-111122223333/live?s=abc",
        Provider::Livestorm,
        Some("0b1c2d3e-aaaa-bbbb-cccc-111122223333"),
    ),
    (
        "https://app.livestorm.co/acme/product-launch",
        Provider::Livestorm,
        None,
    ),
    (
        "https://pop.com/j/123-456-789",
        Provider::Pop,
        Some("123-456-789"),
    ),
    ("https://pop.com/j/abcDEF", Provider::Pop, Some("abcDEF")),
    (
        "https://tandem.chat/join/acme-team",
        Provider::Tandem,
        Some("acme-team"),
    ),
    (
        "https://tandem.chat/room/abc123",
        Provider::Tandem,
        Some("abc123"),
    ),
    (
        "https://app.vowel.com/#/g/AbCdEf123",
        Provider::Vowel,
        Some("AbCdEf123"),
    ),
    (
        "https://acme.vowel.com/room/weekly",
        Provider::Vowel,
        Some("weekly"),
    ),
    (
        "https://my.demio.com/ref/AbCdEfGh",
        Provider::Demio,
        Some("AbCdEfGh"),
    ),
    (
        "https://event.demio.com/room/XyZ123",
        Provider::Demio,
        Some("XyZ123"),
    ),
    (
        "https://app.butter.us/acme/weekly-workshop",
        Provider::Butter,
        None,
    ),
    ("https://app.butter.us/jane/retro", Provider::Butter, None),
];

const NEGATIVE: &[&str] = &[
    "https://zoom.us/pricing",
    "https://zoom.us/",
    "https://zoom.us/j/",
    "https://zoom.us/j/abc",
    "https://zoom.us/j/12345",
    "https://acme.zoom.us/u/abcdEfGh",
    "https://zoom.us/rec/share/xyz",
    "https://zoom.us/download",
    "https://notzoom.us/j/1234567890",
    "https://zoom.us.evil.example/j/1234567890",
    "https://meet.google.com",
    "https://meet.google.com/",
    "https://meet.google.com/new",
    "https://meet.google.com/landing",
    "https://meet.google.com/abc-defg",
    "https://meet.google.com/abc-defg-hi1",
    "https://tel.meet/abc-defg-hij?pin=1",
    "https://support.google.com/a/users/answer/9282720",
    "https://teams.microsoft.com/l/channel/19%3aabc%40thread.skype/General",
    "https://teams.microsoft.com/meetingOptions/?organizerId=abc",
    "https://www.microsoft.com/microsoft-teams/join-a-meeting",
    "https://teams.microsoft.com/",
    "https://teams.microsoft.com/l/meetup-join/",
    "https://www.webex.com/pricing/index.html",
    "https://acme.webex.com/acme/j.php",
    "https://help.webex.com/en-us/article/abc",
    "https://app.slack.com/client/T01ABCDEF/C02GHIJKL",
    "https://slack.com/huddles",
    "https://whereby.com/information/pricing",
    "https://whereby.com/pricing",
    "https://whereby.com/",
    "https://around.co/pricing",
    "https://www.goto.com/meeting",
    "https://www.gotomeeting.com/pricing",
    "https://meet.goto.com/",
    "https://www.gotowebinar.com/pricing",
    "https://attendee.gotowebinar.com/rt/123",
    "https://www.bluejeans.com/pricing",
    "https://meet.jit.si/",
    "https://meet.jit.si/static/close.html",
    "https://jitsi.org/meet",
    "https://discord.com/download",
    "https://discord.gg/abc",
    "https://discord.com/channels/@me",
    "https://join.skype.com/invite/AbC",
    "https://www.skype.com/en/",
    "https://aws.amazon.com/chime/",
    "https://chime.aws/download",
    "https://www.ringcentral.com/video.html",
    "https://ringcentral.com/join",
    "https://www.dialpad.com/meetings/",
    "https://meetings.dialpad.com/login",
    "https://www.zoho.com/meeting/pricing.html",
    "https://meeting.zoho.com/",
    "https://meeting.zoho.example.com/join?key=1234567890",
    "https://meeting.zoho.co.example/join?key=1234567890",
    "https://meet.zoho.example.com/abc123",
    "https://www.larksuite.com/en_us/product/video-conferencing",
    "https://vc.larksuite.com/",
    "https://tuple.app/pricing",
    "https://www.gather.town/pricing",
    "https://gather.town/",
    "https://riverside.fm/pricing",
    "https://riverside.fm/studio",
    "https://streamyard.com/pricing",
    "https://streamyard.com/watch/abc123def4",
    "https://streamyard.com/resources",
    "https://www.whatsapp.com/download",
    "https://call.whatsapp.com/",
    "https://facetime.apple.com/join",
    "https://www.apple.com/facetime/",
    "https://cal.com/pricing",
    "https://cal.com/jane/30min",
    "https://www.daily.co/pricing",
    "https://docs.daily.co/reference",
    "https://daily.co/standup",
    "https://livestorm.co/pricing",
    "https://app.livestorm.co/login",
    "https://pop.com/pricing",
    "https://tandem.chat/pricing",
    "https://www.vowel.com/pricing",
    "https://vowel.com/",
    "https://www.demio.com/pricing",
    "https://demio.com/",
    "https://www.butter.us/pricing",
    "https://app.butter.us/login/x",
    "https://example.com/j/1234567890",
    "ftp://zoom.us/j/1234567890",
    "javascript:alert(1)",
    "",
    "not a url",
];

#[test]
fn recognises_every_provider_shape() {
    for (url, provider, id) in POSITIVE {
        check(url, *provider, *id);
    }
    let covered: HashSet<Provider> = POSITIVE.iter().map(|(_, p, _)| *p).collect();
    for provider in Provider::ALL {
        if provider == Provider::Other {
            continue;
        }
        let count = POSITIVE.iter().filter(|(_, p, _)| *p == provider).count();
        assert!(count >= 2, "{provider:?} needs two shapes, has {count}");
        assert!(covered.contains(&provider));
    }
}

#[test]
fn rejects_marketing_pages_and_lookalikes() {
    for url in NEGATIVE {
        reject(url);
    }
}

#[test]
fn normalises_urls() {
    let link =
        classify_url("http://ZOOM.us/j/1234567890?pwd=x&utm_source=email&utm_medium=x").unwrap();
    assert_eq!(link.url, "https://zoom.us/j/1234567890?pwd=x");
    let link = classify_url("https://meet.google.com/abc-defg-hij#section").unwrap();
    assert_eq!(link.url, "https://meet.google.com/abc-defg-hij");
    let link = classify_url("https://facetime.apple.com/join#v=1&p=AbCdEf&k=XyZ").unwrap();
    assert_eq!(
        link.url,
        "https://facetime.apple.com/join#v=1&p=AbCdEf&k=XyZ"
    );
    let link =
        classify_url("zoommtg://zoom.us/join?action=join&confno=1234567890&pwd=xyz").unwrap();
    assert_eq!(link.url, "https://zoom.us/j/1234567890?pwd=xyz");
    assert_eq!(link.meeting_id.as_deref(), Some("1234567890"));
    let link = classify_url("https://zoom.us/j/1234567890).").unwrap();
    assert_eq!(link.url, "https://zoom.us/j/1234567890");
}

#[test]
fn unwraps_safelinks_and_redirects() {
    let cases = [
        "https://nam12.safelinks.protection.outlook.com/?url=https%3A%2F%2Fus06web.zoom.us%2Fj%2F87654321098%3Fpwd%3DQwErTy&data=05%7C02%7C&sdata=abc%3D&reserved=0",
        "https://eur02.safelinks.protection.outlook.com/?url=https%3A%2F%2Fus06web.zoom.us%2Fj%2F87654321098%3Fpwd%3DQwErTy",
        "https://statics.teams.cdn.office.net/evergreen-assets/safelinks/1/atp-safelinks.html?url=https%3A%2F%2Fus06web.zoom.us%2Fj%2F87654321098%3Fpwd%3DQwErTy",
        "https://www.google.com/url?q=https://us06web.zoom.us/j/87654321098?pwd%3DQwErTy&sa=D&source=calendar&usg=AOvVaw",
        "https://urldefense.com/v3/__https://us06web.zoom.us/j/87654321098?pwd=QwErTy__;!!abc$",
        "https://urldefense.proofpoint.com/v2/url?u=https-3A__us06web.zoom.us_j_87654321098-3Fpwd-3DQwErTy&d=DwMF&c=x",
    ];
    for case in cases {
        let link = classify_url(case).unwrap_or_else(|| panic!("{case}"));
        assert_eq!(link.provider, Provider::Zoom, "{case}");
        assert_eq!(link.meeting_id.as_deref(), Some("87654321098"), "{case}");
        assert_eq!(
            link.url, "https://us06web.zoom.us/j/87654321098?pwd=QwErTy",
            "{case}"
        );
    }
    assert_eq!(
        classify_url(
            "https://nam12.safelinks.protection.outlook.com/?url=https%3A%2F%2Fexample.com%2F"
        ),
        None
    );
}

#[test]
fn finds_links_in_text() {
    let cases: &[(&str, &str)] = &[
        (
            "Join at https://zoom.us/j/1234567890.",
            "https://zoom.us/j/1234567890",
        ),
        (
            "(https://meet.google.com/abc-defg-hij)",
            "https://meet.google.com/abc-defg-hij",
        ),
        (
            "[Join](https://meet.google.com/abc-defg-hij)",
            "https://meet.google.com/abc-defg-hij",
        ),
        (
            "Dial in or go to meet.google.com/abc-defg-hij, thanks",
            "https://meet.google.com/abc-defg-hij",
        ),
        (
            "<a href=\"https://zoom.us/j/1234567890?pwd=a&amp;from=addon\">Join</a>",
            "https://zoom.us/j/1234567890?pwd=a&from=addon",
        ),
        (
            "<a href='https://acme.webex.com/acme/j.php?MTID=m42'>Join</a>",
            "https://acme.webex.com/acme/j.php?MTID=m42",
        ),
        (
            "Join:https://whereby.com/acme-standup!",
            "https://whereby.com/acme-standup",
        ),
        (
            "Room: \"https://meet.jit.si/Acme\"",
            "https://meet.jit.si/Acme",
        ),
    ];
    for (text, expected) in cases {
        let link = find_meeting_link(text).unwrap_or_else(|| panic!("{text}"));
        assert_eq!(link.url, *expected, "{text}");
    }
}

#[test]
fn picks_the_join_link_out_of_teams_boilerplate() {
    let text = "________________\nMicrosoft Teams meeting\nJoin on your computer, mobile app or room device\nDownload Teams<https://www.microsoft.com/en-us/microsoft-teams/download-app> | Join on the web<https://www.microsoft.com/microsoft-teams/join-a-meeting>\nClick here to join the meeting<https://teams.microsoft.com/l/meetup-join/19%3ameeting_NjE2ODk3%40thread.v2/0?context=%7b%7d>\nLearn More<https://aka.ms/JoinTeamsMeeting> | Meeting options<https://teams.microsoft.com/meetingOptions/?organizerId=abc>";
    let link = find_meeting_link(text).unwrap();
    assert_eq!(link.provider, Provider::Teams);
    assert_eq!(
        link.meeting_id.as_deref(),
        Some("19:meeting_NjE2ODk3@thread.v2")
    );
    let zoom = "Join Zoom Meeting\nhttps://acme.zoom.us/j/84512345678?pwd=aBcDeF\n\nMeeting ID: 845 1234 5678\nFind your local number: https://acme.zoom.us/u/abcdEfGh";
    assert_eq!(
        find_meeting_link(zoom).unwrap().meeting_id.as_deref(),
        Some("84512345678")
    );
    assert_eq!(find_all_meeting_links(zoom).len(), 1);
}

#[test]
fn text_without_meeting_links() {
    for text in [
        "Meeting ID: 845 1234 5678 Passcode: 123",
        "See https://zoom.us/pricing and https://www.microsoft.com/microsoft-teams",
        "Lunch at the usual place",
        "https://",
        "&amp;&#xZZ;&#99999999;<a href=\"",
        "",
    ] {
        assert_eq!(find_meeting_link(text), None, "{text}");
    }
}

#[test]
fn event_link_priority() {
    let meet = ConferenceEntry::video("https://meet.google.com/abc-defg-hij");
    let zoom_location = Some("https://zoom.us/j/1234567890");
    let webex_description = Some("Join https://acme.webex.com/meet/jdoe");
    let whereby_url = Some("https://whereby.com/acme");

    let link = event_meeting_link(
        std::slice::from_ref(&meet),
        zoom_location,
        webex_description,
        whereby_url,
    )
    .unwrap();
    assert_eq!(link.provider, Provider::GoogleMeet);
    let link = event_meeting_link(&[], zoom_location, webex_description, whereby_url).unwrap();
    assert_eq!(link.provider, Provider::Zoom);
    let link = event_meeting_link(&[], Some("Room 4"), webex_description, whereby_url).unwrap();
    assert_eq!(link.provider, Provider::Webex);
    let link = event_meeting_link(&[], None, Some("no links"), whereby_url).unwrap();
    assert_eq!(link.provider, Provider::Whereby);
    assert_eq!(
        event_meeting_link(&[], None, None, Some("https://example.com/event/42")),
        None
    );
}

#[test]
fn structured_entries_allow_other_but_never_phone() {
    let custom = ConferenceEntry {
        kind: ConferenceKind::Video,
        uri: "https://video.example-conf.com/room/42".to_string(),
        meeting_code: Some("42".to_string()),
    };
    let phone = ConferenceEntry {
        kind: ConferenceKind::Phone,
        uri: "tel:+1-555-0100".to_string(),
        meeting_code: None,
    };
    let link = event_meeting_link(&[phone.clone(), custom], None, None, None).unwrap();
    assert_eq!(
        link,
        MeetingLink {
            provider: Provider::Other,
            url: "https://video.example-conf.com/room/42".to_string(),
            meeting_id: Some("42".to_string()),
        }
    );
    assert_eq!(event_meeting_link(&[phone], None, None, None), None);
    let not_http = ConferenceEntry::video("sip:conf@example.com");
    assert_eq!(event_meeting_link(&[not_http], None, None, None), None);
    let with_code = ConferenceEntry {
        kind: ConferenceKind::Video,
        uri: "https://acme.zoom.us/my/room".to_string(),
        meeting_code: Some("84512345678".to_string()),
    };
    let link = event_meeting_link(&[with_code], None, None, None).unwrap();
    assert_eq!(link.provider, Provider::Zoom);
    assert_eq!(link.meeting_id.as_deref(), Some("84512345678"));
}

#[test]
fn provider_slugs_are_stable_and_serde_compatible() {
    let mut seen = HashSet::new();
    for provider in Provider::ALL {
        assert!(
            seen.insert(provider.slug()),
            "duplicate slug {}",
            provider.slug()
        );
        assert_eq!(Provider::from_slug(provider.slug()), Some(provider));
        assert!(!provider.display_name().is_empty());
        let json = serde_json::to_string(&provider).unwrap();
        assert_eq!(json, format!("\"{}\"", provider.slug()));
        let back: Provider = serde_json::from_str(&json).unwrap();
        assert_eq!(back, provider);
    }
    let unknown: Provider = serde_json::from_str("\"some-future-provider\"").unwrap();
    assert_eq!(unknown, Provider::Other);
}
