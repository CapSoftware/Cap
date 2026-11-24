use serde::{Deserialize, Serialize};

use crate::apps::{starts_with_ci, strip_suffix_ci};

#[cfg(test)]
mod tests;

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct BrowserEvidence {
    pub urls: Vec<String>,
    pub titles: Vec<String>,
    pub complete: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum WebProvider {
    GoogleMeet,
    Zoom,
    Teams,
    Webex,
    Whereby,
    Jitsi,
    SlackHuddle,
    Discord,
    Gather,
    Around,
    Riverside,
    StreamYard,
    Daily,
    CalVideo,
    GoogleChat,
    WhatsApp,
    Messenger,
    Skype,
    Livestorm,
    Lark,
    ZohoMeeting,
    BlueJeans,
    GoTo,
    RingCentral,
    Chime,
    Pop,
    Tandem,
    Butter,
    Demio,
}

impl WebProvider {
    pub fn name(self) -> &'static str {
        match self {
            WebProvider::GoogleMeet => "Google Meet",
            WebProvider::Zoom => "Zoom",
            WebProvider::Teams => "Microsoft Teams",
            WebProvider::Webex => "Webex",
            WebProvider::Whereby => "Whereby",
            WebProvider::Jitsi => "Jitsi Meet",
            WebProvider::SlackHuddle => "Slack",
            WebProvider::Discord => "Discord",
            WebProvider::Gather => "Gather",
            WebProvider::Around => "Around",
            WebProvider::Riverside => "Riverside",
            WebProvider::StreamYard => "StreamYard",
            WebProvider::Daily => "Daily",
            WebProvider::CalVideo => "Cal Video",
            WebProvider::GoogleChat => "Google Chat",
            WebProvider::WhatsApp => "WhatsApp",
            WebProvider::Messenger => "Messenger",
            WebProvider::Skype => "Skype",
            WebProvider::Livestorm => "Livestorm",
            WebProvider::Lark => "Lark",
            WebProvider::ZohoMeeting => "Zoho Meeting",
            WebProvider::BlueJeans => "BlueJeans",
            WebProvider::GoTo => "GoTo",
            WebProvider::RingCentral => "RingCentral",
            WebProvider::Chime => "Amazon Chime",
            WebProvider::Pop => "Pop",
            WebProvider::Tandem => "Tandem",
            WebProvider::Butter => "Butter",
            WebProvider::Demio => "Demio",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "verdict", rename_all = "camelCase")]
pub enum BrowserVerdict {
    #[serde(rename_all = "camelCase")]
    Meeting {
        provider: WebProvider,
        meeting_id: Option<String>,
        title: Option<String>,
    },
    NotMeeting,
    Unknown,
}

pub fn judge_browser(evidence: &BrowserEvidence) -> BrowserVerdict {
    let aligned = evidence.titles.len() == evidence.urls.len();
    for (index, url) in evidence.urls.iter().enumerate() {
        let Some((provider, meeting_id)) = match_url(url) else {
            continue;
        };
        let title = if aligned {
            evidence
                .titles
                .get(index)
                .and_then(|t| title_for(provider, t))
        } else {
            None
        }
        .or_else(|| {
            evidence
                .titles
                .iter()
                .filter_map(|t| match_title(t))
                .find(|m| m.provider == provider)
                .and_then(|m| m.title)
        });
        return BrowserVerdict::Meeting {
            provider,
            meeting_id,
            title,
        };
    }
    for title in &evidence.titles {
        if let Some(m) = match_title(title) {
            return BrowserVerdict::Meeting {
                provider: m.provider,
                meeting_id: m.meeting_id,
                title: m.title,
            };
        }
    }
    if evidence.complete {
        BrowserVerdict::NotMeeting
    } else {
        BrowserVerdict::Unknown
    }
}

struct Url<'a> {
    host: String,
    path: &'a str,
    fragment: &'a str,
}

impl Url<'_> {
    fn segments(&self) -> Vec<&str> {
        self.path.split('/').filter(|s| !s.is_empty()).collect()
    }

    fn host_is(&self, domain: &str) -> bool {
        self.host == domain
            || (self.host.len() > domain.len()
                && self.host.ends_with(domain)
                && self.host.as_bytes()[self.host.len() - domain.len() - 1] == b'.')
    }
}

fn parse_url(raw: &str) -> Option<Url<'_>> {
    let s = raw.trim();
    let rest = match s.find("://") {
        Some(i) => {
            let scheme = &s[..i];
            if !scheme.eq_ignore_ascii_case("https") && !scheme.eq_ignore_ascii_case("http") {
                return None;
            }
            &s[i + 3..]
        }
        None => s,
    };
    let host_end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let authority = &rest[..host_end];
    let host = authority.rsplit('@').next().unwrap_or(authority);
    let host = host.split(':').next().unwrap_or(host);
    let host = host.trim_end_matches('.').to_ascii_lowercase();
    if host.is_empty() || host.contains(char::is_whitespace) {
        return None;
    }
    let after = &rest[host_end..];
    let (before_fragment, fragment) = after.split_once('#').unwrap_or((after, ""));
    let path = before_fragment.split('?').next().unwrap_or("");
    Some(Url {
        host,
        path,
        fragment,
    })
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

fn digits(s: &str) -> bool {
    !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit())
}

fn segment_after(segs: &[&str], key: &str) -> Option<String> {
    segs.iter()
        .position(|s| s.eq_ignore_ascii_case(key))
        .and_then(|i| segs.get(i + 1))
        .map(|s| s.to_string())
}

const WHEREBY_RESERVED: &[&str] = &[
    "user",
    "login",
    "signup",
    "information",
    "pricing",
    "org",
    "embed",
    "blog",
    "about",
    "careers",
    "features",
    "download",
    "support",
    "legal",
    "privacy",
    "terms",
    "contact",
    "product",
    "enterprise",
];

const JITSI_RESERVED: &[&str] = &["static", "libs", "sounds", "images", "css", "fonts"];

type Match = (WebProvider, Option<String>);

fn match_url(raw: &str) -> Option<Match> {
    let url = parse_url(raw)?;
    let segs = url.segments();
    let first = segs.first().copied().unwrap_or("");
    let host = url.host.as_str();

    if host == "meet.google.com" {
        return is_meet_code(first)
            .then(|| (WebProvider::GoogleMeet, Some(first.to_ascii_lowercase())));
    }
    if url.host_is("zoom.us") || url.host_is("zoom.com") || url.host_is("zoomgov.com") {
        let id = segs
            .iter()
            .skip(1)
            .find(|s| digits(s))
            .map(|s| s.to_string());
        return match first {
            "wc" if id.is_some() => Some((WebProvider::Zoom, id)),
            "j" | "s" | "w" if segs.len() >= 2 => Some((WebProvider::Zoom, id)),
            "my" if segs.len() >= 2 => Some((WebProvider::Zoom, Some(segs[1].to_string()))),
            _ => None,
        };
    }
    if host == "teams.microsoft.com"
        || host == "teams.live.com"
        || host == "teams.cloud.microsoft"
        || url.host_is("gov.teams.microsoft.us")
    {
        let route = format!("{}#{}", url.path, url.fragment).to_ascii_lowercase();
        let meeting = [
            "meetup-join",
            "pre-join-calling",
            "/meet/",
            "light-meetings",
            "modern-calling",
            "/calling",
        ]
        .iter()
        .any(|k| route.contains(k));
        return meeting.then(|| (WebProvider::Teams, segment_after(&segs, "meet")));
    }
    if url.host_is("webex.com") {
        return match first {
            "meet" => Some((WebProvider::Webex, segs.get(1).map(|s| s.to_string()))),
            "wbxmjs" | "webappng" => Some((WebProvider::Webex, None)),
            _ => None,
        };
    }
    if url.host_is("whereby.com") {
        return (!first.is_empty()
            && !WHEREBY_RESERVED
                .iter()
                .any(|r| first.eq_ignore_ascii_case(r)))
        .then(|| (WebProvider::Whereby, Some(first.to_string())));
    }
    if host == "meet.jit.si" {
        return (!first.is_empty()
            && !first.contains('.')
            && !JITSI_RESERVED.iter().any(|r| first.eq_ignore_ascii_case(r)))
        .then(|| (WebProvider::Jitsi, Some(first.to_string())));
    }
    if url.host_is("8x8.vc") {
        return segs
            .last()
            .filter(|s| !s.contains('.'))
            .map(|s| (WebProvider::Jitsi, Some(s.to_string())));
    }
    if host == "app.slack.com" {
        return segs
            .iter()
            .any(|s| s.eq_ignore_ascii_case("huddle"))
            .then_some((WebProvider::SlackHuddle, None));
    }
    if url.host_is("discord.com") || url.host_is("discordapp.com") {
        return (first == "channels" && segs.len() >= 3).then_some((WebProvider::Discord, None));
    }
    if url.host_is("gather.town") && host.starts_with("app.") {
        return Some((WebProvider::Gather, None));
    }
    if url.host_is("around.co") {
        return (first == "r" || host.starts_with("meet."))
            .then(|| (WebProvider::Around, segment_after(&segs, "r")));
    }
    if url.host_is("riverside.fm") || url.host_is("riverside.com") {
        return segs
            .contains(&"studio")
            .then(|| (WebProvider::Riverside, segment_after(&segs, "studio")));
    }
    if url.host_is("streamyard.com") {
        return segs
            .iter()
            .any(|s| s.eq_ignore_ascii_case("studio"))
            .then_some((WebProvider::StreamYard, None));
    }
    if url.host_is("daily.co") && host != "daily.co" {
        let sub = host.split('.').next().unwrap_or("");
        return (!first.is_empty() && !["www", "docs", "dashboard", "help"].contains(&sub))
            .then(|| (WebProvider::Daily, Some(first.to_string())));
    }
    if url.host_is("cal.com") {
        return (first == "video" && segs.len() >= 2)
            .then(|| (WebProvider::CalVideo, Some(segs[1].to_string())));
    }
    if host == "chat.google.com" || host == "mail.google.com" {
        let route = format!("{}#{}", url.path, url.fragment).to_ascii_lowercase();
        let chat = host == "chat.google.com" || route.contains("chat");
        return (chat && (route.contains("call") || route.contains("huddle")))
            .then_some((WebProvider::GoogleChat, None));
    }
    if host == "web.whatsapp.com" {
        return Some((WebProvider::WhatsApp, None));
    }
    if url.host_is("messenger.com") || url.host_is("facebook.com") {
        return ["groupcall", "videocall", "call"]
            .contains(&first)
            .then_some((WebProvider::Messenger, None));
    }
    if host == "web.skype.com" {
        return Some((WebProvider::Skype, None));
    }
    if host == "join.skype.com" {
        return Some((WebProvider::Skype, segs.first().map(|s| s.to_string())));
    }
    if host == "app.livestorm.co" {
        return Some((WebProvider::Livestorm, None));
    }
    if url.host_is("larksuite.com") || url.host_is("feishu.cn") || url.host_is("larkoffice.com") {
        return (host.starts_with("vc.") || first == "j")
            .then(|| (WebProvider::Lark, segment_after(&segs, "j")));
    }
    if starts_with_ci(host, "meeting.zoho.") || starts_with_ci(host, "meet.zoho.") {
        return (!first.is_empty()).then_some((WebProvider::ZohoMeeting, None));
    }
    if url.host_is("bluejeans.com") {
        return segs
            .iter()
            .find(|s| digits(s))
            .map(|s| (WebProvider::BlueJeans, Some(s.to_string())));
    }
    if host == "app.goto.com" {
        return (first == "meeting").then(|| (WebProvider::GoTo, segment_after(&segs, "meeting")));
    }
    if url.host_is("gotomeeting.com") {
        return segs
            .contains(&"join")
            .then(|| (WebProvider::GoTo, segment_after(&segs, "join")));
    }
    if host == "meet.goto.com" {
        return (!first.is_empty()).then(|| (WebProvider::GoTo, Some(first.to_string())));
    }
    if host == "v.ringcentral.com" {
        return (!first.is_empty()).then(|| {
            (
                WebProvider::RingCentral,
                segment_after(&segs, "join").or_else(|| segment_after(&segs, "conf")),
            )
        });
    }
    if host == "app.chime.aws" {
        return (first == "meetings")
            .then(|| (WebProvider::Chime, segment_after(&segs, "meetings")));
    }
    if url.host_is("pop.com") {
        return (first == "j").then(|| (WebProvider::Pop, segment_after(&segs, "j")));
    }
    if host == "app.tandem.chat" {
        return Some((WebProvider::Tandem, None));
    }
    if host == "app.butter.us" {
        return Some((WebProvider::Butter, None));
    }
    if host == "event.demio.com" {
        return Some((WebProvider::Demio, None));
    }
    None
}

struct TitleMatch {
    provider: WebProvider,
    meeting_id: Option<String>,
    title: Option<String>,
}

const BROWSER_SUFFIXES: &[&str] = &[
    "Google Chrome",
    "Chromium",
    "Microsoft Edge",
    "Microsoft\u{200b} Edge",
    "Mozilla Firefox",
    "Firefox",
    "Brave",
    "Vivaldi",
    "Opera",
    "Arc",
    "Safari",
    "Camera and microphone recording",
    "Camera or microphone recording",
    "Microphone recording",
    "Camera recording",
    "Audio playing",
    "Playing audio",
];

const DASHES: &[&str] = &[" - ", " \u{2013} ", " \u{2014} "];

fn clean_title(raw: &str) -> &str {
    let mut t = raw.trim();
    if t.starts_with('(')
        && let Some(close) = t.find(')')
        && t[1..close].bytes().all(|b| b.is_ascii_digit() || b == b'+')
    {
        t = t[close + 1..].trim_start();
    }
    loop {
        let before = t;
        for suffix in BROWSER_SUFFIXES {
            for dash in DASHES {
                t = strip_tail(t, dash, suffix);
            }
        }
        if t == before {
            return t;
        }
    }
}

fn strip_tail<'a>(t: &'a str, separator: &str, word: &str) -> &'a str {
    strip_suffix_ci(t, word)
        .and_then(|rest| rest.strip_suffix(separator))
        .map(str::trim_end)
        .unwrap_or(t)
}

fn split_dash(t: &str) -> Option<(&str, &str)> {
    DASHES
        .iter()
        .filter_map(|d| t.find(d).map(|i| (&t[..i], &t[i + d.len()..])))
        .min_by_key(|(head, _)| head.len())
}

fn first_word_lower(s: &str) -> String {
    s.split(|c: char| c.is_whitespace() || c == ':')
        .find(|w| !w.is_empty())
        .unwrap_or("")
        .to_lowercase()
}

fn has_word(s: &str, word: &str) -> bool {
    s.split(|c: char| !c.is_alphanumeric())
        .any(|w| w.eq_ignore_ascii_case(word))
}

fn non_empty(s: &str) -> Option<String> {
    let s = s.trim();
    (!s.is_empty()).then(|| s.to_string())
}

fn match_title(raw: &str) -> Option<TitleMatch> {
    let t = clean_title(raw);
    if let Some((head, rest)) = split_dash(t)
        && head == "Meet"
    {
        let rest = rest.trim();
        if rest.is_empty() {
            return None;
        }
        let (meeting_id, title) = if is_meet_code(rest) {
            (Some(rest.to_ascii_lowercase()), None)
        } else {
            (None, Some(rest.to_string()))
        };
        return Some(TitleMatch {
            provider: WebProvider::GoogleMeet,
            meeting_id,
            title,
        });
    }
    if starts_with_ci(t, "Zoom Meeting") || starts_with_ci(t, "Zoom Webinar") {
        return Some(TitleMatch {
            provider: WebProvider::Zoom,
            meeting_id: None,
            title: None,
        });
    }
    let parts: Vec<&str> = t.split('|').map(str::trim).collect();
    if parts.len() >= 2
        && parts
            .last()
            .is_some_and(|p| p.eq_ignore_ascii_case("Microsoft Teams"))
    {
        let head = &parts[..parts.len() - 1];
        let is_keyword = |p: &&str| {
            let w = first_word_lower(p);
            w == "meeting" || w == "call"
        };
        if head.iter().any(is_keyword) {
            let bare = |p: &&str| {
                ["meeting", "call", "meeting compact view"]
                    .iter()
                    .any(|k| p.eq_ignore_ascii_case(k))
            };
            let title = head
                .iter()
                .find(|p| !bare(p) && !p.is_empty())
                .map(|p| p.to_string());
            return Some(TitleMatch {
                provider: WebProvider::Teams,
                meeting_id: None,
                title,
            });
        }
        return None;
    }
    if has_word(t, "huddle") && has_word(t, "slack") {
        return Some(TitleMatch {
            provider: WebProvider::SlackHuddle,
            meeting_id: None,
            title: None,
        });
    }
    if has_word(t, "webex") && has_word(t, "meeting") {
        return Some(TitleMatch {
            provider: WebProvider::Webex,
            meeting_id: None,
            title: None,
        });
    }
    if parts.len() >= 2
        && parts
            .last()
            .is_some_and(|p| p.eq_ignore_ascii_case("Jitsi Meet"))
    {
        let title = non_empty(&parts[..parts.len() - 1].join(" | "));
        return title.map(|title| TitleMatch {
            provider: WebProvider::Jitsi,
            meeting_id: None,
            title: Some(title),
        });
    }
    None
}

fn title_for(provider: WebProvider, raw: &str) -> Option<String> {
    if let Some(m) = match_title(raw)
        && m.provider == provider
    {
        return m.title;
    }
    let mut t = clean_title(raw);
    let name = provider.name();
    for dash in DASHES.iter().copied().chain([" | "]) {
        t = strip_tail(t, dash, name);
        let prefix = format!("{name}{dash}");
        if starts_with_ci(t, &prefix) {
            t = t[prefix.len()..].trim_start();
        }
    }
    let t = t.trim();
    if t.is_empty()
        || t.eq_ignore_ascii_case(name)
        || is_meet_code(t)
        || t.contains("://")
        || t.starts_with("meet.")
        || ["meeting", "zoom meeting", "meet", "call"]
            .iter()
            .any(|g| t.eq_ignore_ascii_case(g))
    {
        return None;
    }
    Some(t.to_string())
}
