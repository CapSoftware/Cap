use serde::{Deserialize, Serialize};

#[cfg(test)]
mod tests;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Platform {
    MacOS,
    Windows,
    Linux,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AppKind {
    Meeting,
    Chat,
    Phone,
    Browser,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CallNoun {
    Meeting,
    Call,
    Huddle,
}

impl CallNoun {
    pub fn word(self) -> &'static str {
        match self {
            CallNoun::Meeting => "Meeting",
            CallNoun::Call => "Call",
            CallNoun::Huddle => "Huddle",
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
pub struct AppInfo {
    pub id: &'static str,
    pub name: &'static str,
    pub kind: AppKind,
    pub call_noun: CallNoun,
    pub macos_ids: &'static [&'static str],
    pub windows_exes: &'static [&'static str],
    pub linux_names: &'static [&'static str],
}

impl AppInfo {
    pub fn platform_ids(&self, platform: Platform) -> &'static [&'static str] {
        match platform {
            Platform::MacOS => self.macos_ids,
            Platform::Windows => self.windows_exes,
            Platform::Linux => self.linux_names,
        }
    }
}

pub const GOOGLE_MEET_APP_ID: &str = "google-meet";
const MEET_PWA_SUFFIX: &str = ".app.kjgfgldnnfoeklkmfkjfagphfepbbdan";

type Ids = &'static [&'static str];

const fn browser(
    id: &'static str,
    name: &'static str,
    macos: Ids,
    windows: Ids,
    linux: Ids,
) -> AppInfo {
    AppInfo {
        id,
        name,
        kind: AppKind::Browser,
        call_noun: CallNoun::Meeting,
        macos_ids: macos,
        windows_exes: windows,
        linux_names: linux,
    }
}

const fn app(
    id: &'static str,
    name: &'static str,
    kind: AppKind,
    call_noun: CallNoun,
    macos: Ids,
    windows: Ids,
    linux: Ids,
) -> AppInfo {
    AppInfo {
        id,
        name,
        kind,
        call_noun,
        macos_ids: macos,
        windows_exes: windows,
        linux_names: linux,
    }
}

use AppKind::{Chat, Meeting, Phone};
use CallNoun::{Call, Huddle};

static APPS: &[AppInfo] = &[
    browser(
        "chrome",
        "Google Chrome",
        &[
            "com.google.Chrome",
            "com.google.Chrome.beta",
            "com.google.Chrome.dev",
            "com.google.Chrome.canary",
        ],
        &["chrome"],
        &[
            "google-chrome",
            "google-chrome-stable",
            "google-chrome-beta",
            "google-chrome-unstable",
            "chrome",
            "Google Chrome",
            "com.google.Chrome",
        ],
    ),
    browser(
        "chromium",
        "Chromium",
        &["org.chromium.Chromium"],
        &["chromium"],
        &["chromium", "chromium-browser", "org.chromium.Chromium"],
    ),
    browser(
        "firefox",
        "Firefox",
        &[
            "org.mozilla.firefox",
            "org.mozilla.firefoxdeveloperedition",
            "org.mozilla.nightly",
            "org.mozilla.plugincontainer",
        ],
        &["firefox"],
        &[
            "firefox",
            "firefox-bin",
            "firefox-esr",
            "org.mozilla.firefox",
        ],
    ),
    browser(
        "safari",
        "Safari",
        &[
            "com.apple.Safari",
            "com.apple.SafariTechnologyPreview",
            "com.apple.WebKit.GPU",
        ],
        &[],
        &[],
    ),
    browser(
        "edge",
        "Microsoft Edge",
        &[
            "com.microsoft.edgemac",
            "com.microsoft.edgemac.Beta",
            "com.microsoft.edgemac.Dev",
            "com.microsoft.edgemac.Canary",
        ],
        &["msedge"],
        &[
            "microsoft-edge",
            "microsoft-edge-stable",
            "microsoft-edge-beta",
            "microsoft-edge-dev",
            "msedge",
            "Microsoft Edge",
            "com.microsoft.Edge",
        ],
    ),
    browser("arc", "Arc", &["company.thebrowser.Browser"], &["arc"], &[]),
    browser("dia", "Dia", &["company.thebrowser.dia"], &["dia"], &[]),
    browser(
        "brave",
        "Brave",
        &[
            "com.brave.Browser",
            "com.brave.Browser.beta",
            "com.brave.Browser.nightly",
        ],
        &["brave"],
        &[
            "brave",
            "brave-browser",
            "brave-browser-stable",
            "com.brave.Browser",
        ],
    ),
    browser(
        "vivaldi",
        "Vivaldi",
        &["com.vivaldi.Vivaldi"],
        &["vivaldi"],
        &["vivaldi", "vivaldi-bin", "vivaldi-stable"],
    ),
    browser(
        "opera",
        "Opera",
        &["com.operasoftware.Opera", "com.operasoftware.OperaGX"],
        &["opera"],
        &["opera"],
    ),
    browser(
        "zen",
        "Zen",
        &["app.zen-browser.zen"],
        &["zen"],
        &["zen", "zen-bin", "app.zen_browser.zen"],
    ),
    browser("orion", "Orion", &["com.kagi.kagimacOS"], &[], &[]),
    browser("helium", "Helium", &["net.imput.helium"], &[], &[]),
    browser("comet", "Comet", &["ai.perplexity.comet"], &["comet"], &[]),
    browser(
        "chatgpt-atlas",
        "ChatGPT Atlas",
        &["com.openai.atlas", "com.openai.atlas.web.helper"],
        &[],
        &[],
    ),
    browser(
        "duckduckgo",
        "DuckDuckGo",
        &["com.duckduckgo.macos.browser"],
        &["duckduckgo"],
        &[],
    ),
    app(
        "zoom",
        "Zoom",
        Meeting,
        CallNoun::Meeting,
        &[
            "us.zoom.xos",
            "us.zoom.ZoomHybridConf",
            "us.zoom.ZoomPhone",
            "us.zoom.caphost",
        ],
        &["zoom", "zoomhybridconf"],
        &["zoom", "ZOOM VoiceEngine", "us.zoom.Zoom"],
    ),
    app(
        "teams",
        "Microsoft Teams",
        Meeting,
        CallNoun::Meeting,
        &[
            "com.microsoft.teams2",
            "com.microsoft.teams2.modulehost",
            "com.microsoft.teams",
        ],
        &["ms-teams", "msteams", "msteamsvdi", "teams"],
        &[
            "teams",
            "teams-for-linux",
            "com.github.IsmaelMartinez.teams_for_linux",
        ],
    ),
    app(
        "webex",
        "Webex",
        Meeting,
        CallNoun::Meeting,
        &[
            "com.cisco.webexmeetingsapp",
            "Cisco-Systems.Spark",
            "com.webex.meetingmanager",
        ],
        &["webex", "ciscocollabhost", "atmgr"],
        &[],
    ),
    app(
        GOOGLE_MEET_APP_ID,
        "Google Meet",
        Meeting,
        CallNoun::Meeting,
        &["com.google.Chrome.app.kjgfgldnnfoeklkmfkjfagphfepbbdan"],
        &[],
        &[],
    ),
    app(
        "slack",
        "Slack",
        Chat,
        Huddle,
        &["com.tinyspeck.slackmacgap"],
        &["slack"],
        &["slack", "com.slack.Slack"],
    ),
    app(
        "discord",
        "Discord",
        Chat,
        Call,
        &[
            "com.hnc.Discord",
            "com.hnc.DiscordPTB",
            "com.hnc.DiscordCanary",
        ],
        &["discord", "discordptb", "discordcanary"],
        &[
            "discord",
            "discord-ptb",
            "discord-canary",
            "com.discordapp.Discord",
        ],
    ),
    app(
        "facetime",
        "FaceTime",
        Phone,
        Call,
        &["com.apple.FaceTime", "com.apple.avconferenced"],
        &[],
        &[],
    ),
    app(
        "whatsapp",
        "WhatsApp",
        Chat,
        Call,
        &["net.whatsapp.WhatsApp", "desktop.WhatsApp"],
        &["whatsapp", "whatsapp.root"],
        &[],
    ),
    app(
        "telegram",
        "Telegram",
        Chat,
        Call,
        &["ru.keepcoder.Telegram", "org.telegram.desktop"],
        &["telegram"],
        &["telegram-desktop", "org.telegram.desktop"],
    ),
    app(
        "signal",
        "Signal",
        Chat,
        Call,
        &["org.whispersystems.signal-desktop"],
        &["signal"],
        &["signal-desktop", "org.signal.Signal"],
    ),
    app(
        "skype",
        "Skype",
        Meeting,
        Call,
        &["com.skype.skype"],
        &["skype"],
        &["skypeforlinux", "com.skype.Client"],
    ),
    app(
        "tuple",
        "Tuple",
        Meeting,
        Call,
        &["app.tuple.app"],
        &["tuple"],
        &["tuple"],
    ),
    app(
        "around",
        "Around",
        Meeting,
        CallNoun::Meeting,
        &["co.teamport.around"],
        &["around"],
        &[],
    ),
    app(
        "gather",
        "Gather",
        Meeting,
        CallNoun::Meeting,
        &["com.gather.Gather", "com.gather.GatherV2"],
        &["gather"],
        &[],
    ),
    app(
        "lark",
        "Lark",
        Meeting,
        CallNoun::Meeting,
        &["com.larksuite.larkApp", "com.bytedance.lark"],
        &["lark", "feishu"],
        &["bytedance-feishu", "bytedance-lark"],
    ),
    app(
        "tencent-meeting",
        "Tencent Meeting",
        Meeting,
        CallNoun::Meeting,
        &["com.tencent.tencentmeeting"],
        &["wemeetapp", "voovmeetingapp"],
        &[],
    ),
    app(
        "dingtalk",
        "DingTalk",
        Chat,
        CallNoun::Meeting,
        &["com.alibaba.DingTalkMac"],
        &["dingtalk"],
        &[],
    ),
    app(
        "dialpad",
        "Dialpad",
        Phone,
        Call,
        &["com.electron.dialpad", "com.electron.uberconference"],
        &["dialpad"],
        &[],
    ),
    app(
        "ringcentral",
        "RingCentral",
        Phone,
        Call,
        &["com.ringcentral.glip"],
        &["ringcentral"],
        &[],
    ),
    app(
        "8x8-work",
        "8x8 Work",
        Phone,
        Call,
        &["com.electron.8x8---virtual-office"],
        &["8x8 work"],
        &[],
    ),
    app(
        "aircall",
        "Aircall",
        Phone,
        Call,
        &["io.aircall.phone", "io.aircall.workspace"],
        &["aircall"],
        &[],
    ),
    app(
        "goto",
        "GoTo",
        Meeting,
        CallNoun::Meeting,
        &["com.logmein.goto", "com.logmein.GoToMeeting"],
        &["goto", "gotomeeting", "g2mcomm"],
        &[],
    ),
    app(
        "bluejeans",
        "BlueJeans",
        Meeting,
        CallNoun::Meeting,
        &["com.bluejeansnet.Blue"],
        &["bluejeans"],
        &["bluejeans"],
    ),
    app(
        "jitsi",
        "Jitsi Meet",
        Meeting,
        CallNoun::Meeting,
        &["org.jitsi.jitsi-meet"],
        &["jitsi meet"],
        &["jitsi-meet", "jitsi-meet-electron"],
    ),
    app(
        "whereby",
        "Whereby",
        Meeting,
        CallNoun::Meeting,
        &["com.whereby.app"],
        &["whereby"],
        &[],
    ),
    app(
        "roam",
        "Roam",
        Meeting,
        CallNoun::Meeting,
        &["inc.wonder.roam"],
        &["roam"],
        &[],
    ),
    app(
        "clickup",
        "ClickUp",
        Chat,
        Call,
        &["com.clickup.desktop-app"],
        &["clickup"],
        &[],
    ),
    app(
        "telemost",
        "Yandex Telemost",
        Meeting,
        CallNoun::Meeting,
        &["ru.yandex.desktop.telemost"],
        &["telemost"],
        &[],
    ),
    app(
        "chime",
        "Amazon Chime",
        Meeting,
        CallNoun::Meeting,
        &["com.amazon.Amazon-Chime"],
        &["chime"],
        &[],
    ),
    app(
        "pop",
        "Pop",
        Meeting,
        Call,
        &["com.pop.pop.app"],
        &["pop"],
        &[],
    ),
    app(
        "riverside",
        "Riverside",
        Meeting,
        CallNoun::Meeting,
        &["fm.riverside.app"],
        &["riverside"],
        &[],
    ),
];

pub fn all_apps() -> &'static [AppInfo] {
    APPS
}

pub fn app_by_id(id: &str) -> Option<&'static AppInfo> {
    APPS.iter().find(|a| a.id == id)
}

pub fn classify(platform: Platform, platform_id: &str) -> Option<&'static AppInfo> {
    match platform {
        Platform::MacOS => classify_macos(platform_id),
        Platform::Windows => classify_windows(platform_id),
        Platform::Linux => classify_linux(platform_id),
    }
}

pub fn is_own_process(platform_id: &str) -> bool {
    let id = basename(platform_id.trim());
    starts_with_ci(id, "so.cap.") || id.eq_ignore_ascii_case("so.cap")
}

pub fn classify_macos(bundle_id: &str) -> Option<&'static AppInfo> {
    let id = bundle_id.trim();
    if id.is_empty() || is_own_process(id) {
        return None;
    }
    if let Some(app) = exact_macos(id) {
        return Some(app);
    }
    let lower = id.to_ascii_lowercase();
    if let Some(base) = lower.strip_suffix(MEET_PWA_SUFFIX)
        && exact_macos(base).is_some_and(|a| a.kind == AppKind::Browser)
    {
        return app_by_id(GOOGLE_MEET_APP_ID);
    }
    if let Some(pos) = lower.find(".app.")
        && let Some(app) = exact_macos(&lower[..pos])
        && app.kind == AppKind::Browser
    {
        return Some(app);
    }
    let mut from = 0;
    while let Some(rel) = lower[from..].find(".helper") {
        let pos = from + rel;
        let end = pos + ".helper".len();
        if (end == lower.len() || lower.as_bytes()[end] == b'.')
            && let Some(app) = exact_macos(&lower[..pos])
        {
            return Some(app);
        }
        from = end;
    }
    None
}

pub fn classify_windows(exe_name: &str) -> Option<&'static AppInfo> {
    let base = windows_base(exe_name);
    if base.is_empty() || is_own_process(base) {
        return None;
    }
    APPS.iter()
        .find(|a| a.windows_exes.iter().any(|e| e.eq_ignore_ascii_case(base)))
}

pub fn classify_linux(binary_or_app_name: &str) -> Option<&'static AppInfo> {
    let base = basename(binary_or_app_name.trim()).trim();
    if base.is_empty() || is_own_process(base) {
        return None;
    }
    APPS.iter()
        .find(|a| a.linux_names.iter().any(|e| e.eq_ignore_ascii_case(base)))
}

const NON_MEETING: &[&str] = &[
    "com.apple.VoiceMemos",
    "com.apple.QuickTimePlayerX",
    "com.apple.assistantd",
    "com.apple.Siri*",
    "com.apple.siri.*",
    "com.apple.corespeechd",
    "com.apple.SpeechRecognitionCore*",
    "com.apple.speech.*",
    "com.apple.DictationIM",
    "com.apple.localspeechrecognition",
    "com.obsproject.obs-studio",
    "com.obsproject.Studio",
    "obs",
    "obs64",
    "obs32",
    "speechruntime",
    "voiceaccess",
    "so.cap.*",
];

pub fn is_known_non_meeting(platform_id: &str) -> bool {
    let id = windows_base(platform_id);
    if id.is_empty() {
        return false;
    }
    NON_MEETING
        .iter()
        .any(|pattern| match pattern.strip_suffix('*') {
            Some(prefix) => starts_with_ci(id, prefix),
            None => id.eq_ignore_ascii_case(pattern),
        })
}

fn exact_macos(id: &str) -> Option<&'static AppInfo> {
    APPS.iter()
        .find(|a| a.macos_ids.iter().any(|m| m.eq_ignore_ascii_case(id)))
}

fn basename(path: &str) -> &str {
    path.rsplit('/').next().unwrap_or(path)
}

fn windows_base(exe: &str) -> &str {
    let base = exe.trim().rsplit(['\\', '/']).next().unwrap_or("").trim();
    strip_suffix_ci(base, ".exe").unwrap_or(base)
}

pub(crate) fn strip_suffix_ci<'a>(s: &'a str, suffix: &str) -> Option<&'a str> {
    let cut = s.len().checked_sub(suffix.len())?;
    if s.is_char_boundary(cut) && s[cut..].eq_ignore_ascii_case(suffix) {
        Some(&s[..cut])
    } else {
        None
    }
}

pub(crate) fn starts_with_ci(s: &str, prefix: &str) -> bool {
    s.len() >= prefix.len()
        && s.is_char_boundary(prefix.len())
        && s[..prefix.len()].eq_ignore_ascii_case(prefix)
}
