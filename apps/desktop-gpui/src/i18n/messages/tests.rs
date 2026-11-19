use super::*;
use crate::i18n::{KEYS, LOCALE_ENV, Locale, init};

#[test]
fn english_messages_read_exactly_as_before() {
    for (english, translate) in EXACT {
        assert_eq!(translate(), *english);
        assert_eq!(localize(english), *english);
    }
    for wrapped in WRAPPED {
        let message = format!("{}disk full{}", wrapped.prefix, wrapped.suffix);
        assert_eq!((wrapped.translate)("disk full".into()), message);
        assert_eq!(localize(&message), message);
    }
    for permission in OSPermission::ALL {
        let message = permission.unavailable_message();
        assert_eq!(localize(&message), message);
    }
}

#[test]
fn every_message_is_still_written_by_the_app() {
    let src = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let i18n = src.join("i18n");
    let mut sources = String::new();
    let mut pending = vec![src];
    while let Some(dir) = pending.pop() {
        for entry in std::fs::read_dir(&dir).unwrap() {
            let path = entry.unwrap().path();
            if path.is_dir() {
                if path != i18n {
                    pending.push(path);
                }
            } else if path.extension().is_some_and(|extension| extension == "rs") {
                sources.push_str(&std::fs::read_to_string(&path).unwrap());
            }
        }
    }
    let cli_install = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../crates/cli-install/src/lib.rs");
    sources.push_str(&std::fs::read_to_string(cli_install).unwrap());
    let texts = EXACT.iter().map(|(english, _)| *english).chain(
        WRAPPED
            .iter()
            .flat_map(|wrapped| [wrapped.prefix, wrapped.suffix])
            .filter(|text| !text.is_empty()),
    );
    for text in texts {
        assert!(
            sources.contains(text),
            "no code writes {text:?} any more; update i18n::messages"
        );
    }
}

#[test]
fn unknown_and_hostile_text_passes_through() {
    for message in ["", "encoder died", "Stop task failed: ", ". Cleanup is unconfirmed; retry Stop."] {
        assert_eq!(localize(message), message);
    }
    let deep = format!(
        "{}x{}",
        "Stop task failed: ".repeat(64),
        ". Use Stop if recording cannot continue safely.".repeat(64)
    );
    assert_eq!(localize(&deep), deep);
}

#[test]
fn messages_follow_the_language() {
    const CHILD: &str = "CAP_GPUI_TEST_MESSAGES_LANGUAGE";
    if std::env::var_os(CHILD).is_none() {
        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "i18n::messages::tests::messages_follow_the_language",
                "--nocapture",
            ])
            .env(CHILD, "1")
            .env_remove(LOCALE_ENV)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        return;
    }

    init(Some(Locale::Ja.code()));
    assert_eq!(localize("Recording task failed."), "録画タスクが失敗しました。");
    assert_eq!(
        localize(
            "Stop task failed: Recording startup cancelled; local files preserved. Capture cleanup is unconfirmed. Use Ctrl+Shift+F9 to retry Stop."
        ),
        "停止タスクが失敗しました：録画の開始がキャンセルされました。ローカルファイルは保持されています。キャプチャの後処理を確認できません。Ctrl+Shift+F9で停止をやり直してください。"
    );
    assert_eq!(
        localize("Stop task failed: encoder died"),
        "停止タスクが失敗しました：encoder died"
    );
    assert_eq!(
        localize(&OSPermission::Camera.unavailable_message()),
        "カメラへのアクセスを利用できません。「システム設定」>「プライバシーとセキュリティ」>「カメラ」でCapを許可してから、デバイスをもう一度選択してください。"
    );
    assert_eq!(
        localize("Low storage. Your recording files are preserved at /Users/me/Cap/Stop task failed: x. Free up space, then recover the recording in Cap."),
        "ストレージの空き容量が不足しています。録画ファイルは/Users/me/Cap/Stop task failed: xに保持されています。空き容量を確保してから、Capで録画を復元してください。"
    );

    for (locale, shown) in [
        (Locale::En, "1.5"),
        (Locale::ZhCn, "1.5"),
        (Locale::Ja, "1.5"),
        (Locale::Fr, "1,5"),
        (Locale::Es, "1,5"),
        (Locale::De, "1,5"),
        (Locale::Hi, "1.5"),
    ] {
        init(Some(locale.code()));
        assert_eq!(crate::i18n::decimal(1.5), shown, "{}", locale.code());
        assert_eq!(crate::i18n::decimal(12.0), "12", "{}", locale.code());
    }

    for locale in Locale::ALL {
        init(Some(locale.code()));
        for (english, _) in EXACT {
            let shown = localize(english);
            assert!(!shown.is_empty(), "{} {english}", locale.code());
            if locale != Locale::En {
                assert_ne!(shown, *english, "{} {english}", locale.code());
            }
        }
    }
    init(Some(Locale::En.code()));
}

#[test]
fn every_message_key_has_one_english_source() {
    let keys = KEYS
        .iter()
        .filter(|key| key.starts_with(KEY_PREFIX))
        .count();
    assert_eq!(keys, EXACT.len() + WRAPPED.len() + 1);
}
