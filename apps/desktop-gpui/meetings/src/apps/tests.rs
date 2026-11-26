use super::*;

fn id_of(app: Option<&'static AppInfo>) -> Option<&'static str> {
    app.map(|a| a.id)
}

#[test]
fn every_table_entry_classifies_to_itself_on_each_platform() {
    for app in all_apps() {
        for id in app.macos_ids {
            assert_eq!(id_of(classify_macos(id)), Some(app.id), "macos {id}");
            assert_eq!(
                id_of(classify_macos(&id.to_ascii_uppercase())),
                Some(app.id),
                "macos upper {id}"
            );
        }
        for exe in app.windows_exes {
            assert_eq!(id_of(classify_windows(exe)), Some(app.id), "windows {exe}");
            assert_eq!(
                id_of(classify_windows(&format!("{exe}.exe"))),
                Some(app.id),
                "windows {exe}.exe"
            );
            assert_eq!(
                id_of(classify_windows(&format!(
                    "C:\\Program Files\\Vendor\\{}.EXE",
                    exe.to_ascii_uppercase()
                ))),
                Some(app.id),
                "windows path {exe}"
            );
        }
        for name in app.linux_names {
            assert_eq!(id_of(classify_linux(name)), Some(app.id), "linux {name}");
            assert_eq!(
                id_of(classify_linux(&format!("/usr/bin/{name}"))),
                Some(app.id),
                "linux path {name}"
            );
        }
    }
}

#[test]
fn ids_are_unique_and_never_shared_between_apps() {
    let apps = all_apps();
    for (i, a) in apps.iter().enumerate() {
        for b in &apps[i + 1..] {
            assert_ne!(a.id, b.id);
            for platform in [Platform::MacOS, Platform::Windows, Platform::Linux] {
                for x in a.platform_ids(platform) {
                    assert!(
                        !b.platform_ids(platform)
                            .iter()
                            .any(|y| y.eq_ignore_ascii_case(x)),
                        "{x} in {} and {}",
                        a.id,
                        b.id
                    );
                }
            }
        }
    }
}

#[test]
fn brief_examples_resolve() {
    let mac = [
        ("com.google.Chrome.canary", "chrome"),
        ("org.mozilla.firefoxdeveloperedition", "firefox"),
        ("com.apple.WebKit.GPU", "safari"),
        ("company.thebrowser.Browser", "arc"),
        ("company.thebrowser.dia", "dia"),
        ("com.operasoftware.OperaGX", "opera"),
        ("com.openai.atlas.web.helper", "chatgpt-atlas"),
        ("us.zoom.caphost", "zoom"),
        ("com.microsoft.teams2.modulehost", "teams"),
        ("Cisco-Systems.Spark", "webex"),
        ("com.tinyspeck.slackmacgap", "slack"),
        ("com.apple.avconferenced", "facetime"),
        ("com.electron.uberconference", "dialpad"),
        ("com.electron.8x8---virtual-office", "8x8-work"),
        ("io.aircall.workspace", "aircall"),
        ("com.logmein.GoToMeeting", "goto"),
        ("inc.wonder.roam", "roam"),
        ("com.amazon.Amazon-Chime", "chime"),
    ];
    for (bundle, app) in mac {
        assert_eq!(id_of(classify_macos(bundle)), Some(app), "{bundle}");
    }
    let windows = [
        ("zoomhybridconf.exe", "zoom"),
        ("ms-teams.exe", "teams"),
        ("msteamsvdi.exe", "teams"),
        ("atmgr.exe", "webex"),
        ("WhatsApp.exe", "whatsapp"),
        ("whatsapp.root.exe", "whatsapp"),
        ("voovmeetingapp.exe", "tencent-meeting"),
        ("8x8 work.exe", "8x8-work"),
        ("msedge.exe", "edge"),
        ("dia.exe", "dia"),
    ];
    for (exe, app) in windows {
        assert_eq!(id_of(classify_windows(exe)), Some(app), "{exe}");
    }
    let linux = [
        ("teams-for-linux", "teams"),
        ("ZOOM VoiceEngine", "zoom"),
        ("microsoft-edge", "edge"),
        ("Google Chrome", "chrome"),
    ];
    for (name, app) in linux {
        assert_eq!(id_of(classify_linux(name)), Some(app), "{name}");
    }
}

#[test]
fn helpers_resolve_to_parent_app() {
    let cases = [
        ("com.google.Chrome.helper", "chrome"),
        ("com.google.Chrome.helper.Renderer", "chrome"),
        ("com.google.Chrome.helper.plugin", "chrome"),
        ("com.microsoft.edgemac.helper", "edge"),
        ("COMPANY.THEBROWSER.BROWSER.HELPER", "arc"),
        ("com.hnc.Discord.helper.Renderer", "discord"),
        ("com.hnc.DiscordPTB.helper", "discord"),
        ("com.tinyspeck.slackmacgap.helper", "slack"),
        ("com.microsoft.teams2.helper", "teams"),
        ("com.brave.Browser.helper.renderer", "brave"),
    ];
    for (bundle, app) in cases {
        assert_eq!(id_of(classify_macos(bundle)), Some(app), "{bundle}");
    }
}

#[test]
fn google_meet_pwa_from_any_browser() {
    for browser in [
        "com.google.Chrome",
        "com.google.Chrome.beta",
        "com.microsoft.edgemac",
        "com.brave.Browser",
        "company.thebrowser.Browser",
    ] {
        let bundle = format!("{browser}.app.kjgfgldnnfoeklkmfkjfagphfepbbdan");
        assert_eq!(
            id_of(classify_macos(&bundle)),
            Some(GOOGLE_MEET_APP_ID),
            "{bundle}"
        );
    }
    assert_eq!(
        id_of(classify_macos("com.google.Chrome.app.someotherpwaid")),
        Some("chrome")
    );
    assert_eq!(
        classify_macos("us.zoom.xos.app.kjgfgldnnfoeklkmfkjfagphfepbbdan"),
        None
    );
}

#[test]
fn near_misses_do_not_match() {
    for bundle in [
        "",
        "   ",
        "com.google",
        "com.google.Chrome2",
        "com.google.ChromeHelper",
        "com.google.Chrome.helpers",
        "com.google.Chrome.helperx.renderer",
        "us.zoom",
        "us.zoom.xos2",
        "com.microsoft.teams3",
        "com.tinyspeck",
        "com.apple.WebKit.WebContent",
        "com.apple.Music",
        "com.apple.VoiceMemos",
        "so.cap.desktop",
        "so.cap.desktop.helper",
        "com.example.zoom",
    ] {
        assert_eq!(classify_macos(bundle), None, "{bundle:?}");
    }
    for exe in [
        "",
        "zoomer.exe",
        "chrome_proxy.exe",
        "teamsx.exe",
        "slack.exe.bak",
        "obs64.exe",
    ] {
        assert_eq!(classify_windows(exe), None, "{exe:?}");
    }
    for name in ["", "pulseaudio", "zoomit", "firefox-sandbox", "spotify"] {
        assert_eq!(classify_linux(name), None, "{name:?}");
    }
}

#[test]
fn call_nouns_and_kinds() {
    let slack = classify_macos("com.tinyspeck.slackmacgap").unwrap();
    assert_eq!(slack.call_noun, CallNoun::Huddle);
    assert_eq!(CallNoun::Huddle.word(), "Huddle");
    let facetime = classify_macos("com.apple.FaceTime").unwrap();
    assert_eq!(facetime.call_noun, CallNoun::Call);
    let whatsapp = classify_windows("WhatsApp.exe").unwrap();
    assert_eq!(whatsapp.call_noun, CallNoun::Call);
    assert_eq!(
        classify_macos("com.apple.Safari").unwrap().kind,
        AppKind::Browser
    );
    assert_eq!(
        classify_macos("us.zoom.xos").unwrap().kind,
        AppKind::Meeting
    );
}

#[test]
fn own_process_and_denylist() {
    assert!(is_own_process("so.cap.desktop"));
    assert!(is_own_process("SO.CAP.desktop.dev"));
    assert!(!is_own_process("so.capable"));
    for id in [
        "com.apple.VoiceMemos",
        "com.apple.QuickTimePlayerX",
        "com.obsproject.obs-studio",
        "obs64.exe",
        "C:\\obs\\bin\\obs64.exe",
        "com.apple.SpeechRecognitionCore.speechrecognitiond",
        "com.apple.corespeechd",
        "com.apple.assistantd",
        "so.cap.desktop",
    ] {
        assert!(is_known_non_meeting(id), "{id}");
    }
    for id in ["us.zoom.xos", "com.google.Chrome", "", "obsidian"] {
        assert!(!is_known_non_meeting(id), "{id}");
    }
}

#[test]
fn classify_dispatches_by_platform() {
    assert_eq!(
        id_of(classify(Platform::MacOS, "us.zoom.xos")),
        Some("zoom")
    );
    assert_eq!(id_of(classify(Platform::Windows, "Zoom.exe")), Some("zoom"));
    assert_eq!(id_of(classify(Platform::Linux, "zoom")), Some("zoom"));
    assert_eq!(classify(Platform::Windows, "us.zoom.xos"), None);
    assert_eq!(app_by_id("teams").map(|a| a.name), Some("Microsoft Teams"));
}
