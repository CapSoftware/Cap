use serde::{Deserialize, Serialize};
use url::Url;

use crate::text::decode_entities;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum Provider {
    #[serde(rename = "zoom")]
    Zoom,
    #[serde(rename = "google-meet")]
    GoogleMeet,
    #[serde(rename = "teams")]
    Teams,
    #[serde(rename = "webex")]
    Webex,
    #[serde(rename = "slack")]
    Slack,
    #[serde(rename = "whereby")]
    Whereby,
    #[serde(rename = "around")]
    Around,
    #[serde(rename = "goto-meeting")]
    GoToMeeting,
    #[serde(rename = "goto-webinar")]
    GoToWebinar,
    #[serde(rename = "bluejeans")]
    BlueJeans,
    #[serde(rename = "jitsi")]
    Jitsi,
    #[serde(rename = "discord")]
    Discord,
    #[serde(rename = "skype")]
    Skype,
    #[serde(rename = "chime")]
    Chime,
    #[serde(rename = "ringcentral")]
    RingCentral,
    #[serde(rename = "dialpad")]
    Dialpad,
    #[serde(rename = "zoho-meeting")]
    ZohoMeeting,
    #[serde(rename = "lark")]
    Lark,
    #[serde(rename = "tuple")]
    Tuple,
    #[serde(rename = "gather")]
    Gather,
    #[serde(rename = "riverside")]
    Riverside,
    #[serde(rename = "streamyard")]
    StreamYard,
    #[serde(rename = "whatsapp")]
    WhatsApp,
    #[serde(rename = "facetime")]
    FaceTime,
    #[serde(rename = "cal-video")]
    CalVideo,
    #[serde(rename = "daily")]
    Daily,
    #[serde(rename = "livestorm")]
    Livestorm,
    #[serde(rename = "pop")]
    Pop,
    #[serde(rename = "tandem")]
    Tandem,
    #[serde(rename = "vowel")]
    Vowel,
    #[serde(rename = "demio")]
    Demio,
    #[serde(rename = "butter")]
    Butter,
    #[serde(rename = "other", other)]
    Other,
}

impl Provider {
    pub const ALL: [Provider; 33] = [
        Provider::Zoom,
        Provider::GoogleMeet,
        Provider::Teams,
        Provider::Webex,
        Provider::Slack,
        Provider::Whereby,
        Provider::Around,
        Provider::GoToMeeting,
        Provider::GoToWebinar,
        Provider::BlueJeans,
        Provider::Jitsi,
        Provider::Discord,
        Provider::Skype,
        Provider::Chime,
        Provider::RingCentral,
        Provider::Dialpad,
        Provider::ZohoMeeting,
        Provider::Lark,
        Provider::Tuple,
        Provider::Gather,
        Provider::Riverside,
        Provider::StreamYard,
        Provider::WhatsApp,
        Provider::FaceTime,
        Provider::CalVideo,
        Provider::Daily,
        Provider::Livestorm,
        Provider::Pop,
        Provider::Tandem,
        Provider::Vowel,
        Provider::Demio,
        Provider::Butter,
        Provider::Other,
    ];

    pub fn display_name(self) -> &'static str {
        match self {
            Provider::Zoom => "Zoom",
            Provider::GoogleMeet => "Google Meet",
            Provider::Teams => "Microsoft Teams",
            Provider::Webex => "Webex",
            Provider::Slack => "Slack Huddle",
            Provider::Whereby => "Whereby",
            Provider::Around => "Around",
            Provider::GoToMeeting => "GoTo Meeting",
            Provider::GoToWebinar => "GoTo Webinar",
            Provider::BlueJeans => "BlueJeans",
            Provider::Jitsi => "Jitsi Meet",
            Provider::Discord => "Discord",
            Provider::Skype => "Skype",
            Provider::Chime => "Amazon Chime",
            Provider::RingCentral => "RingCentral",
            Provider::Dialpad => "Dialpad Meetings",
            Provider::ZohoMeeting => "Zoho Meeting",
            Provider::Lark => "Lark",
            Provider::Tuple => "Tuple",
            Provider::Gather => "Gather",
            Provider::Riverside => "Riverside",
            Provider::StreamYard => "StreamYard",
            Provider::WhatsApp => "WhatsApp",
            Provider::FaceTime => "FaceTime",
            Provider::CalVideo => "Cal Video",
            Provider::Daily => "Daily",
            Provider::Livestorm => "Livestorm",
            Provider::Pop => "Pop",
            Provider::Tandem => "Tandem",
            Provider::Vowel => "Vowel",
            Provider::Demio => "Demio",
            Provider::Butter => "Butter",
            Provider::Other => "Video call",
        }
    }

    pub fn slug(self) -> &'static str {
        match self {
            Provider::Zoom => "zoom",
            Provider::GoogleMeet => "google-meet",
            Provider::Teams => "teams",
            Provider::Webex => "webex",
            Provider::Slack => "slack",
            Provider::Whereby => "whereby",
            Provider::Around => "around",
            Provider::GoToMeeting => "goto-meeting",
            Provider::GoToWebinar => "goto-webinar",
            Provider::BlueJeans => "bluejeans",
            Provider::Jitsi => "jitsi",
            Provider::Discord => "discord",
            Provider::Skype => "skype",
            Provider::Chime => "chime",
            Provider::RingCentral => "ringcentral",
            Provider::Dialpad => "dialpad",
            Provider::ZohoMeeting => "zoho-meeting",
            Provider::Lark => "lark",
            Provider::Tuple => "tuple",
            Provider::Gather => "gather",
            Provider::Riverside => "riverside",
            Provider::StreamYard => "streamyard",
            Provider::WhatsApp => "whatsapp",
            Provider::FaceTime => "facetime",
            Provider::CalVideo => "cal-video",
            Provider::Daily => "daily",
            Provider::Livestorm => "livestorm",
            Provider::Pop => "pop",
            Provider::Tandem => "tandem",
            Provider::Vowel => "vowel",
            Provider::Demio => "demio",
            Provider::Butter => "butter",
            Provider::Other => "other",
        }
    }

    pub fn from_slug(slug: &str) -> Option<Provider> {
        Provider::ALL.into_iter().find(|p| p.slug() == slug)
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MeetingLink {
    pub provider: Provider,
    pub url: String,
    #[serde(default)]
    pub meeting_id: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ConferenceKind {
    Video,
    Phone,
    Sip,
    More,
    Other,
}

impl ConferenceKind {
    pub fn from_entry_point_type(value: &str) -> ConferenceKind {
        match value.trim().to_ascii_lowercase().as_str() {
            "video" => ConferenceKind::Video,
            "phone" => ConferenceKind::Phone,
            "sip" => ConferenceKind::Sip,
            "more" => ConferenceKind::More,
            _ => ConferenceKind::Other,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ConferenceEntry {
    pub kind: ConferenceKind,
    pub uri: String,
    pub meeting_code: Option<String>,
}

impl ConferenceEntry {
    pub fn video(uri: impl Into<String>) -> Self {
        Self {
            kind: ConferenceKind::Video,
            uri: uri.into(),
            meeting_code: None,
        }
    }
}

pub fn event_meeting_link(
    conference: &[ConferenceEntry],
    location: Option<&str>,
    description: Option<&str>,
    url: Option<&str>,
) -> Option<MeetingLink> {
    conference
        .iter()
        .filter(|e| e.kind == ConferenceKind::Video)
        .find_map(structured_link)
        .or_else(|| location.and_then(find_meeting_link))
        .or_else(|| description.and_then(find_meeting_link))
        .or_else(|| url.and_then(classify_url))
}

fn structured_link(entry: &ConferenceEntry) -> Option<MeetingLink> {
    let code = entry
        .meeting_code
        .as_deref()
        .map(str::trim)
        .filter(|c| !c.is_empty())
        .map(str::to_string);
    if let Some(mut link) = classify_url(&entry.uri) {
        if link.meeting_id.is_none() {
            link.meeting_id = code;
        }
        return Some(link);
    }
    let parsed = Url::parse(entry.uri.trim()).ok()?;
    if !matches!(parsed.scheme(), "http" | "https") || parsed.host_str().is_none() {
        return None;
    }
    Some(MeetingLink {
        provider: Provider::Other,
        url: parsed.to_string(),
        meeting_id: code,
    })
}

pub fn find_meeting_link(text: &str) -> Option<MeetingLink> {
    let decoded = decode_entities(text);
    candidates(&decoded).find_map(|c| classify_url(&c))
}

pub fn find_all_meeting_links(text: &str) -> Vec<MeetingLink> {
    let decoded = decode_entities(text);
    let mut out: Vec<MeetingLink> = Vec::new();
    for link in candidates(&decoded).filter_map(|c| classify_url(&c)) {
        if !out.iter().any(|l| l.url == link.url) {
            out.push(link);
        }
    }
    out
}

pub fn classify_url(url: &str) -> Option<MeetingLink> {
    classify_depth(url, 0)
}

const SCHEMES: [&str; 5] = ["https://", "http://", "zoommtg://", "zoomus://", "msteams:"];

fn is_delimiter(c: char) -> bool {
    c.is_whitespace()
        || matches!(
            c,
            '<' | '>' | '"' | '\'' | '`' | '|' | '{' | '}' | '\\' | '^'
        )
}

fn candidates(text: &str) -> impl Iterator<Item = String> + '_ {
    text.split(is_delimiter)
        .filter(|t| !t.is_empty())
        .filter_map(token_candidate)
}

fn token_candidate(token: &str) -> Option<String> {
    let lower = token.to_ascii_lowercase();
    if let Some(idx) = SCHEMES.iter().filter_map(|s| lower.find(s)).min() {
        return Some(token[idx..].to_string());
    }
    let start = token
        .find(|c: char| c.is_ascii_alphanumeric())
        .unwrap_or(token.len());
    let bare = &token[start..];
    let slash = bare.find('/')?;
    let host = &bare[..slash];
    let host_ok = host.contains('.')
        && host.len() >= 4
        && host
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-')
        && host
            .rsplit('.')
            .next()
            .is_some_and(|tld| tld.len() >= 2 && tld.chars().all(|c| c.is_ascii_alphabetic()));
    if !host_ok {
        return None;
    }
    Some(format!("https://{bare}"))
}

fn strip_trailing(s: &str) -> &str {
    let mut out = s.trim();
    loop {
        let Some(last) = out.chars().last() else {
            return out;
        };
        let strip = match last {
            '.' | ',' | ';' | ':' | '!' | '?' | '*' | ']' | '}' | '\'' | '"' => true,
            ')' => out.matches(')').count() > out.matches('(').count(),
            _ => false,
        };
        if !strip {
            return out;
        }
        out = &out[..out.len() - last.len_utf8()];
    }
}

fn classify_depth(raw: &str, depth: u8) -> Option<MeetingLink> {
    if depth > 4 || raw.len() > 8192 {
        return None;
    }
    let trimmed = strip_trailing(raw.trim().trim_start_matches(['<', '(', '[']));
    if trimmed.is_empty() {
        return None;
    }
    let with_scheme = if trimmed.contains(':') {
        trimmed.to_string()
    } else {
        format!("https://{trimmed}")
    };
    let mut url = Url::parse(&with_scheme).ok()?;
    match url.scheme() {
        "http" | "https" => {}
        "zoommtg" | "zoomus" => return zoom_app_link(&url),
        "msteams" => {
            let rest = with_scheme.split_once(':')?.1.trim_start_matches('/');
            return classify_depth(&format!("https://teams.microsoft.com/{rest}"), depth + 1);
        }
        _ => return None,
    }
    if let Some(inner) = unwrap_redirect(&url, &with_scheme) {
        return classify_depth(&inner, depth + 1);
    }
    let host = url.host_str()?.trim_end_matches('.').to_ascii_lowercase();
    let segs: Vec<String> = url
        .path_segments()
        .map(|s| s.filter(|p| !p.is_empty()).map(percent_decode).collect())
        .unwrap_or_default();
    let ctx = Ctx {
        url: &url,
        host: &host,
        segs: &segs,
    };
    let (provider, hit) = RULES
        .iter()
        .find_map(|(provider, rule)| rule(&ctx).map(|hit| (*provider, hit)))?;
    if url.scheme() == "http" {
        url.set_scheme("https").ok()?;
    }
    if !hit.keep_fragment {
        url.set_fragment(None);
    }
    strip_tracking(&mut url);
    Some(MeetingLink {
        provider,
        url: url.to_string(),
        meeting_id: hit.id.filter(|id| !id.is_empty()),
    })
}

fn strip_tracking(url: &mut Url) {
    if url.query().is_none() {
        return;
    }
    let kept: Vec<(String, String)> = url
        .query_pairs()
        .filter(|(k, _)| !k.to_ascii_lowercase().starts_with("utm_"))
        .map(|(k, v)| (k.into_owned(), v.into_owned()))
        .collect();
    if kept.is_empty() {
        url.set_query(None);
        return;
    }
    let original = url.query_pairs().count();
    if kept.len() != original {
        url.query_pairs_mut().clear().extend_pairs(kept);
    }
}

fn percent_decode(s: &str) -> String {
    url::form_urlencoded::parse(format!("x={}", s.replace('+', "%2B")).as_bytes())
        .next()
        .map(|(_, v)| v.into_owned())
        .unwrap_or_else(|| s.to_string())
}

fn query_param(url: &Url, name: &str) -> Option<String> {
    url.query_pairs()
        .find(|(k, _)| k.eq_ignore_ascii_case(name))
        .map(|(_, v)| v.into_owned())
        .filter(|v| !v.is_empty())
}

fn unwrap_redirect(url: &Url, raw: &str) -> Option<String> {
    let host = url.host_str()?.to_ascii_lowercase();
    let path = url.path();
    if host.ends_with("safelinks.protection.outlook.com") || path.ends_with("safelinks.html") {
        return query_param(url, "url");
    }
    if (host == "google.com" || host.starts_with("www.google.") || host == "google.co.uk")
        && path == "/url"
    {
        return query_param(url, "q").or_else(|| query_param(url, "url"));
    }
    if host == "slack-redir.net" && path == "/link" {
        return query_param(url, "url");
    }
    if host == "urldefense.com" && path.starts_with("/v3/__") {
        let start = raw.find("/v3/__")? + "/v3/__".len();
        let rest = &raw[start..];
        let end = rest.find("__;").unwrap_or(rest.len());
        return Some(rest[..end].to_string());
    }
    if host == "urldefense.proofpoint.com" && path.starts_with("/v2/url") {
        return query_param(url, "u").map(|u| proofpoint_v2_decode(&u));
    }
    None
}

fn proofpoint_v2_decode(value: &str) -> String {
    let replaced = value.replace('_', "/");
    let bytes = replaced.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'-'
            && i + 2 < bytes.len()
            && let Some(byte) = std::str::from_utf8(&bytes[i + 1..i + 3])
                .ok()
                .and_then(|h| u8::from_str_radix(h, 16).ok())
        {
            out.push(byte);
            i += 3;
            continue;
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn zoom_app_link(url: &Url) -> Option<MeetingLink> {
    let id = query_param(url, "confno").filter(|c| is_digits(c, 9, 12))?;
    let mut out = format!("https://zoom.us/j/{id}");
    if let Some(pwd) = query_param(url, "pwd") {
        out.push_str("?pwd=");
        out.push_str(&url::form_urlencoded::byte_serialize(pwd.as_bytes()).collect::<String>());
    }
    Some(MeetingLink {
        provider: Provider::Zoom,
        url: out,
        meeting_id: Some(id),
    })
}

struct Ctx<'a> {
    url: &'a Url,
    host: &'a str,
    segs: &'a [String],
}

impl Ctx<'_> {
    fn seg(&self, i: usize) -> Option<&str> {
        self.segs.get(i).map(String::as_str)
    }

    fn seg_lower(&self, i: usize) -> Option<String> {
        self.seg(i).map(str::to_ascii_lowercase)
    }

    fn host_is(&self, domain: &str) -> bool {
        self.host == domain
    }

    fn host_under(&self, domain: &str) -> bool {
        self.host == domain
            || (self.host.len() > domain.len()
                && self.host.ends_with(domain)
                && self.host.as_bytes()[self.host.len() - domain.len() - 1] == b'.')
    }

    fn is_root_or_www(&self, domain: &str) -> bool {
        self.host == domain || self.host.strip_prefix("www.") == Some(domain)
    }

    fn param(&self, name: &str) -> Option<String> {
        query_param(self.url, name)
    }
}

struct Hit {
    id: Option<String>,
    keep_fragment: bool,
}

fn hit(id: Option<String>) -> Option<Hit> {
    Some(Hit {
        id,
        keep_fragment: false,
    })
}

fn hit_with_fragment(id: Option<String>) -> Option<Hit> {
    Some(Hit {
        id,
        keep_fragment: true,
    })
}

fn is_digits(s: &str, min: usize, max: usize) -> bool {
    (min..=max).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_digit())
}

fn digits_of(s: &str) -> String {
    s.chars().filter(char::is_ascii_digit).collect()
}

fn is_slug(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 128
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

type Rule = fn(&Ctx) -> Option<Hit>;

const RULES: [(Provider, Rule); 32] = [
    (Provider::Zoom, zoom),
    (Provider::GoogleMeet, google_meet),
    (Provider::Teams, teams),
    (Provider::Webex, webex),
    (Provider::Slack, slack),
    (Provider::Whereby, whereby),
    (Provider::Around, around),
    (Provider::GoToMeeting, goto_meeting),
    (Provider::GoToWebinar, goto_webinar),
    (Provider::BlueJeans, bluejeans),
    (Provider::Jitsi, jitsi),
    (Provider::Discord, discord),
    (Provider::Skype, skype),
    (Provider::Chime, chime),
    (Provider::RingCentral, ringcentral),
    (Provider::Dialpad, dialpad),
    (Provider::ZohoMeeting, zoho),
    (Provider::Lark, lark),
    (Provider::Tuple, tuple),
    (Provider::Gather, gather),
    (Provider::Riverside, riverside),
    (Provider::StreamYard, streamyard),
    (Provider::WhatsApp, whatsapp),
    (Provider::FaceTime, facetime),
    (Provider::CalVideo, cal_video),
    (Provider::Daily, daily),
    (Provider::Livestorm, livestorm),
    (Provider::Pop, pop),
    (Provider::Tandem, tandem),
    (Provider::Vowel, vowel),
    (Provider::Demio, demio),
    (Provider::Butter, butter),
];

fn zoom(c: &Ctx) -> Option<Hit> {
    if !(c.host_under("zoom.us") || c.host_under("zoom.com") || c.host_under("zoomgov.com")) {
        return None;
    }
    let numeric = |s: Option<&str>| s.filter(|s| is_digits(s, 9, 12)).map(str::to_string);
    match c.seg_lower(0)?.as_str() {
        "j" | "w" | "s" => numeric(c.seg(1)).and_then(|id| hit(Some(id))),
        "my" => c
            .seg(1)
            .filter(|s| is_slug(&s.replace('.', "")))
            .and_then(|_| hit(None)),
        "wc" => {
            let id = match (c.seg(1), c.seg(2)) {
                (Some("join"), id) => numeric(id),
                (id, Some("join" | "start")) => numeric(id),
                _ => None,
            }?;
            hit(Some(id))
        }
        "meeting" | "webinar" if c.seg(1) == Some("register") && c.seg(2).is_some() => hit(None),
        "join" => {
            let id = c.param("confno").filter(|s| is_digits(s, 9, 12))?;
            hit(Some(id))
        }
        _ => None,
    }
}

fn is_meet_code(s: &str) -> bool {
    let parts: Vec<&str> = s.split('-').collect();
    parts.len() == 3
        && parts[0].len() == 3
        && parts[1].len() == 4
        && parts[2].len() == 3
        && parts
            .iter()
            .all(|p| p.bytes().all(|b| b.is_ascii_alphabetic()))
}

fn google_meet(c: &Ctx) -> Option<Hit> {
    if c.host_is("meet.google.com") {
        let first = c.seg_lower(0)?;
        if is_meet_code(&first) {
            return hit(Some(first));
        }
        if first == "lookup" {
            return c.seg(1).filter(|s| is_slug(s)).and_then(|_| hit(None));
        }
        return None;
    }
    if (c.host_is("hangouts.google.com") || c.host_is("plus.google.com"))
        && c.seg(0) == Some("hangouts")
        && c.seg(1) == Some("_")
        && c.segs.len() >= 3
    {
        return hit(None);
    }
    if c.host_is("hangouts.google.com") && c.seg(0) == Some("call") && c.seg(1).is_some() {
        return hit(c.seg(1).map(str::to_string));
    }
    None
}

const TEAMS_HOSTS: [&str; 6] = [
    "teams.microsoft.com",
    "teams.live.com",
    "teams.cloud.microsoft",
    "teams.microsoft.us",
    "gov.teams.microsoft.us",
    "dod.teams.microsoft.us",
];

fn teams_path(segs: &[&str]) -> Option<Option<String>> {
    let lower: Vec<String> = segs.iter().map(|s| s.to_ascii_lowercase()).collect();
    match lower.first().map(String::as_str) {
        Some("l") if lower.get(1).map(String::as_str) == Some("meetup-join") => {
            let thread = segs.get(2).filter(|s| !s.is_empty())?;
            Some(Some(percent_decode(thread)))
        }
        Some("meet") => {
            let id = segs.get(1).filter(|s| !s.is_empty())?;
            Some(Some(digits_of(id)).filter(|d| !d.is_empty()))
        }
        _ => None,
    }
}

fn teams(c: &Ctx) -> Option<Hit> {
    if !TEAMS_HOSTS.iter().any(|h| c.host_is(h)) {
        return None;
    }
    let segs: Vec<&str> = c.segs.iter().map(String::as_str).collect();
    if let Some(id) = teams_path(&segs) {
        return hit(id);
    }
    if let Some(fragment) = c.url.fragment() {
        let fragment = percent_decode(fragment);
        let frag_segs: Vec<&str> = fragment
            .split(['/', '?'])
            .filter(|s| !s.is_empty())
            .collect();
        if let Some(id) = teams_path(&frag_segs) {
            return hit_with_fragment(id);
        }
    }
    if c.url.path().contains("launcher")
        && let Some(target) = c.param("url")
    {
        let target_segs: Vec<&str> = target
            .split(['/', '#', '?'])
            .filter(|s| !s.is_empty() && *s != "_")
            .collect();
        if let Some(id) = teams_path(&target_segs) {
            return hit(id);
        }
    }
    None
}

fn webex(c: &Ctx) -> Option<Hit> {
    if !(c.host_under("webex.com") || c.host_under("webexgov.us")) {
        return None;
    }
    let lower: Vec<String> = c.segs.iter().map(|s| s.to_ascii_lowercase()).collect();
    if lower.last().is_some_and(|l| l == "j.php" || l == "e.php") {
        let id = c.param("MTID")?;
        return hit(Some(id));
    }
    match lower.first().map(String::as_str) {
        Some("meet" | "join") => {
            c.seg(1).filter(|s| is_slug(s) || s.contains('.'))?;
            hit(None)
        }
        Some("weblink") if lower.get(1).map(String::as_str) == Some("register") => {
            c.seg(2)?;
            hit(None)
        }
        _ => {
            let download = lower.iter().position(|s| s == "download")?;
            if download == 0 || lower[download - 1] != "meeting" {
                return None;
            }
            let id = c.seg(download + 1)?;
            hit(Some(id.to_string()))
        }
    }
}

fn slack(c: &Ctx) -> Option<Hit> {
    if !c.host_under("slack.com") || c.seg_lower(0)? != "huddle" {
        return None;
    }
    c.seg(1)?;
    let channel = c.seg(2)?;
    hit(Some(channel.to_string()))
}

const WHEREBY_RESERVED: [&str; 38] = [
    "information",
    "pricing",
    "user",
    "login",
    "signup",
    "sign-up",
    "org",
    "blog",
    "terms",
    "privacy",
    "cookies",
    "developers",
    "support",
    "about",
    "careers",
    "contact",
    "embed",
    "api",
    "help",
    "download",
    "product",
    "products",
    "features",
    "integrations",
    "security",
    "legal",
    "resources",
    "customers",
    "solutions",
    "enterprise",
    "partners",
    "press",
    "jobs",
    "status",
    "app",
    "dashboard",
    "assets",
    "static",
];

fn whereby(c: &Ctx) -> Option<Hit> {
    let room = c.seg_lower(0)?;
    if !is_slug(&room) || WHEREBY_RESERVED.contains(&room.as_str()) {
        return None;
    }
    if c.is_root_or_www("whereby.com") || c.is_root_or_www("appear.in") {
        return (c.segs.len() == 1).then_some(()).and_then(|_| hit(None));
    }
    if c.host_under("whereby.com") {
        return hit(None);
    }
    None
}

fn around(c: &Ctx) -> Option<Hit> {
    if !c.host_under("around.co") || c.seg_lower(0)? != "r" {
        return None;
    }
    let room = c.seg(1).filter(|s| is_slug(s))?;
    hit(Some(room.to_string()))
}

fn goto_meeting(c: &Ctx) -> Option<Hit> {
    if c.host_under("gotomeeting.com") {
        let first = c.seg_lower(0)?;
        if first == "join" || first == "install" {
            let id = digits_of(c.seg(1)?);
            if (9..=12).contains(&id.len()) {
                return hit(Some(id));
            }
        }
        return None;
    }
    if c.is_root_or_www("gotomeet.me") {
        c.seg(0).filter(|s| is_slug(s))?;
        if c.segs.len() != 1 {
            return None;
        }
        return hit(None);
    }
    if c.host_is("meet.goto.com") {
        let first = c.seg(0).filter(|s| is_slug(s))?;
        if matches!(first, "login" | "settings" | "signup" | "install") {
            return None;
        }
        let id = digits_of(first);
        let id = (id.len() >= 9 && id.len() == first.len()).then_some(id);
        return hit(id);
    }
    if c.host_is("app.goto.com") && c.seg(0) == Some("meeting") {
        let id = c.seg(1).filter(|s| is_digits(s, 9, 12))?;
        return hit(Some(id.to_string()));
    }
    None
}

fn goto_webinar(c: &Ctx) -> Option<Hit> {
    if !c.host_under("gotowebinar.com") || c.is_root_or_www("gotowebinar.com") {
        return None;
    }
    match c.seg_lower(0)?.as_str() {
        "register" | "join" => {
            let key = c.seg(1).filter(|s| !s.is_empty())?;
            hit(Some(key.to_string()))
        }
        _ => None,
    }
}

fn bluejeans(c: &Ctx) -> Option<Hit> {
    if !c.host_under("bluejeans.com") {
        return None;
    }
    let first = c.seg(0)?;
    if is_digits(first, 6, 14) {
        return hit(Some(first.to_string()));
    }
    None
}

const JITSI_RESERVED: [&str; 8] = [
    "static",
    "libs",
    "images",
    "sounds",
    "fonts",
    "lang",
    "css",
    "favicon.ico",
];

fn jitsi_room(s: &str) -> bool {
    !s.is_empty() && !s.contains('.') && !JITSI_RESERVED.contains(&s.to_ascii_lowercase().as_str())
}

fn jitsi(c: &Ctx) -> Option<Hit> {
    if c.host_is("meet.jit.si") {
        let room = c.seg(0).filter(|s| jitsi_room(s))?;
        return (c.segs.len() == 1)
            .then_some(())
            .and_then(|_| hit(Some(room.to_string())));
    }
    if c.host_is("8x8.vc") {
        if !(1..=2).contains(&c.segs.len()) || !c.segs.iter().all(|s| jitsi_room(s)) {
            return None;
        }
        return hit(c.segs.last().cloned());
    }
    None
}

fn discord(c: &Ctx) -> Option<Hit> {
    if !(c.host_under("discord.com") || c.host_under("discordapp.com")) {
        return None;
    }
    let kind = c.seg_lower(0)?;
    if kind != "channels" && kind != "events" {
        return None;
    }
    let guild = c.seg(1)?;
    if guild != "@me" && !is_digits(guild, 5, 25) {
        return None;
    }
    let channel = c.seg(2).filter(|s| is_digits(s, 5, 25))?;
    hit(Some(channel.to_string()))
}

fn skype(c: &Ctx) -> Option<Hit> {
    if c.host_is("join.skype.com") {
        let code = c.seg(0).filter(|s| is_slug(s))?;
        if code.eq_ignore_ascii_case("invite") {
            return None;
        }
        return hit(Some(code.to_string()));
    }
    if c.host_is("meet.lync.com") && c.segs.len() >= 2 {
        return hit(c.segs.last().cloned());
    }
    None
}

fn chime(c: &Ctx) -> Option<Hit> {
    if c.host_is("chime.aws") {
        let id = c.seg(0).filter(|s| is_digits(s, 10, 13))?;
        return hit(Some(id.to_string()));
    }
    if c.host_is("app.chime.aws") && c.seg(0) == Some("meetings") {
        let id = c
            .param("pin")
            .or_else(|| c.seg(1).map(str::to_string))
            .filter(|s| is_digits(s, 10, 13))?;
        return hit(Some(id));
    }
    None
}

fn ringcentral(c: &Ctx) -> Option<Hit> {
    if !c.host_under("ringcentral.com") || c.is_root_or_www("ringcentral.com") {
        return None;
    }
    match c.seg_lower(0)?.as_str() {
        "j" | "join" => {
            let id = c.seg(1).filter(|s| is_slug(s))?;
            let digits = digits_of(id);
            hit(Some(if digits.len() == id.len() {
                digits
            } else {
                id.to_string()
            }))
        }
        "my" => c.seg(1).filter(|s| is_slug(s)).and_then(|_| hit(None)),
        _ => None,
    }
}

fn dialpad(c: &Ctx) -> Option<Hit> {
    if c.host_is("meetings.dialpad.com") {
        let room = c.seg(0).filter(|s| is_slug(s))?;
        if matches!(room, "login" | "signup" | "settings" | "app") || c.segs.len() != 1 {
            return None;
        }
        return hit(None);
    }
    if c.is_root_or_www("dialpad.com") && c.seg(0) == Some("meetings") {
        c.seg(1).filter(|s| is_slug(s))?;
        return hit(None);
    }
    None
}

/// Zoho's regional data centres. Only these count, so a lookalike such as
/// `meeting.zoho.example.com` is never taken for a Zoho meeting.
const ZOHO_DOMAINS: &[&str] = &[
    "zoho.com",
    "zoho.eu",
    "zoho.in",
    "zoho.com.au",
    "zoho.com.cn",
    "zoho.jp",
    "zoho.uk",
    "zoho.sa",
    "zohocloud.ca",
];

fn zoho_host(host: &str, prefix: &str) -> bool {
    host.strip_prefix(prefix)
        .is_some_and(|rest| ZOHO_DOMAINS.contains(&rest))
}

fn zoho(c: &Ctx) -> Option<Hit> {
    if zoho_host(c.host, "meeting.") {
        let path = c.url.path().to_ascii_lowercase();
        if path.contains("join") {
            let key = c.param("key")?;
            return hit(Some(key));
        }
        if path.contains("/register") && c.segs.len() >= 2 {
            return hit(None);
        }
        return None;
    }
    if zoho_host(c.host, "meet.") {
        let code = c.seg(0).filter(|s| is_slug(s))?;
        return (c.segs.len() == 1)
            .then_some(())
            .and_then(|_| hit(Some(code.to_string())));
    }
    None
}

fn lark(c: &Ctx) -> Option<Hit> {
    let known = ["larksuite.com", "feishu.cn", "larkoffice.com"]
        .iter()
        .any(|d| c.host_under(d) && c.host.starts_with("vc."));
    if !known || c.seg_lower(0)? != "j" {
        return None;
    }
    let id = c.seg(1).filter(|s| is_digits(s, 6, 12))?;
    hit(Some(id.to_string()))
}

fn tuple(c: &Ctx) -> Option<Hit> {
    if !c.is_root_or_www("tuple.app") || c.seg_lower(0)? != "c" {
        return None;
    }
    let code = c.seg(1).filter(|s| is_slug(s))?;
    hit(Some(code.to_string()))
}

fn gather(c: &Ctx) -> Option<Hit> {
    if !c.host_under("gather.town") {
        return None;
    }
    match c.seg_lower(0)?.as_str() {
        "app" => {
            let space = c.seg(1).filter(|s| is_slug(s))?;
            hit(Some(space.to_string()))
        }
        "invite" => {
            c.param("token")?;
            hit(None)
        }
        _ => None,
    }
}

fn riverside(c: &Ctx) -> Option<Hit> {
    if !(c.host_under("riverside.fm") || c.host_under("riverside.com"))
        || c.seg_lower(0)? != "studio"
    {
        return None;
    }
    c.seg(1).filter(|s| is_slug(s))?;
    hit(None)
}

fn streamyard(c: &Ctx) -> Option<Hit> {
    if !c.is_root_or_www("streamyard.com") || c.segs.len() != 1 {
        return None;
    }
    let code = c.seg(0)?;
    let ok = (8..=16).contains(&code.len())
        && code.bytes().all(|b| b.is_ascii_alphanumeric())
        && code.bytes().any(|b| b.is_ascii_digit())
        && code.bytes().any(|b| b.is_ascii_alphabetic());
    if !ok {
        return None;
    }
    hit(Some(code.to_string()))
}

fn whatsapp(c: &Ctx) -> Option<Hit> {
    if !c.host_is("call.whatsapp.com") {
        return None;
    }
    match c.seg_lower(0)?.as_str() {
        "voice" | "video" => {
            let token = c.seg(1).filter(|s| is_slug(s))?;
            hit(Some(token.to_string()))
        }
        _ => None,
    }
}

fn facetime(c: &Ctx) -> Option<Hit> {
    if !c.host_is("facetime.apple.com") || c.seg_lower(0)? != "join" {
        return None;
    }
    c.url.fragment().filter(|f| !f.is_empty())?;
    hit_with_fragment(None)
}

fn cal_video(c: &Ctx) -> Option<Hit> {
    if !c.host_under("cal.com") || c.seg_lower(0)? != "video" {
        return None;
    }
    let uid = c.seg(1).filter(|s| is_slug(s))?;
    hit(Some(uid.to_string()))
}

const DAILY_RESERVED_HOSTS: [&str; 8] = [
    "www",
    "docs",
    "dashboard",
    "blog",
    "help",
    "status",
    "api",
    "go",
];

fn daily(c: &Ctx) -> Option<Hit> {
    let sub = c.host.strip_suffix(".daily.co")?;
    if sub.contains('.') || DAILY_RESERVED_HOSTS.contains(&sub) || c.segs.len() != 1 {
        return None;
    }
    c.seg(0).filter(|s| is_slug(s))?;
    hit(None)
}

fn livestorm(c: &Ctx) -> Option<Hit> {
    if !c.host_is("app.livestorm.co") || c.segs.len() < 2 {
        return None;
    }
    let first = c.seg_lower(0)?;
    if first == "p" {
        return hit(c.seg(1).map(str::to_string));
    }
    if matches!(
        first.as_str(),
        "login" | "signup" | "settings" | "auth" | "api" | "i" | "dashboard"
    ) {
        return None;
    }
    hit(None)
}

fn pop(c: &Ctx) -> Option<Hit> {
    if !c.is_root_or_www("pop.com") || c.seg_lower(0)? != "j" {
        return None;
    }
    let id = c.seg(1).filter(|s| is_slug(s))?;
    hit(Some(id.to_string()))
}

fn tandem(c: &Ctx) -> Option<Hit> {
    if !c.host_under("tandem.chat") {
        return None;
    }
    match c.seg_lower(0)?.as_str() {
        "join" | "room" | "r" => {
            let room = c.seg(1).filter(|s| is_slug(s))?;
            hit(Some(room.to_string()))
        }
        _ => None,
    }
}

fn vowel(c: &Ctx) -> Option<Hit> {
    if !c.host_under("vowel.com") || c.is_root_or_www("vowel.com") {
        return None;
    }
    let fragment = c.url.fragment().map(percent_decode).unwrap_or_default();
    let all: Vec<&str> = c
        .segs
        .iter()
        .map(String::as_str)
        .chain(fragment.split('/'))
        .filter(|s| !s.is_empty())
        .collect();
    let idx = all.iter().position(|s| matches!(*s, "room" | "g"))?;
    let id = all.get(idx + 1).filter(|s| is_slug(s))?;
    hit_with_fragment(Some(id.to_string()))
}

fn demio(c: &Ctx) -> Option<Hit> {
    if !c.host_under("demio.com") || c.is_root_or_www("demio.com") {
        return None;
    }
    match c.seg_lower(0)?.as_str() {
        "ref" | "room" | "join" => {
            let id = c.seg(1).filter(|s| is_slug(s))?;
            hit(Some(id.to_string()))
        }
        _ => None,
    }
}

fn butter(c: &Ctx) -> Option<Hit> {
    if !c.host_is("app.butter.us") || c.segs.len() < 2 {
        return None;
    }
    let first = c.seg_lower(0)?;
    if matches!(
        first.as_str(),
        "login" | "signup" | "settings" | "dashboard" | "api" | "auth" | "templates"
    ) || !is_slug(&first)
    {
        return None;
    }
    hit(None)
}
