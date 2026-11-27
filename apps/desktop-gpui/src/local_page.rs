//! The pages Cap's own loopback servers show in the browser when a sign-in
//! or a calendar connection comes back to the app. They look like the web
//! app's sign-in card and carry everything inline: they are served from
//! 127.0.0.1, often offline, so nothing loads from anywhere else.

use crate::i18n::tr;

const LOGO: &str = include_str!("../assets/icons/logo-mark.svg");

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Tone {
    /// It worked: a check on the logo.
    Done,
    /// Nothing happened that needs the person.
    Neutral,
    /// It did not work: a mark on the logo.
    Problem,
}

/// The sign-in finished; the app takes it from here.
pub fn signed_in() -> String {
    render(
        tr::local_page::signed_in_title(),
        tr::local_page::signed_in_body(),
        Tone::Done,
    )
}

pub fn calendar_connected() -> String {
    render(
        tr::local_page::calendar_title(),
        tr::local_page::calendar_body(),
        Tone::Done,
    )
}

pub fn calendar_not_connected() -> String {
    render(
        tr::local_page::calendar_denied_title(),
        tr::local_page::calendar_denied_body(),
        Tone::Problem,
    )
}

pub fn drive_connected() -> String {
    render(
        tr::local_page::drive_title(),
        tr::local_page::drive_body(),
        Tone::Done,
    )
}

pub fn drive_not_connected() -> String {
    render(
        tr::local_page::drive_denied_title(),
        tr::local_page::drive_denied_body(),
        Tone::Problem,
    )
}

/// A request this server does not know: an old tab, a typo, a probe.
pub fn unknown() -> String {
    render(
        tr::local_page::unknown_title(),
        tr::local_page::unknown_body(),
        Tone::Neutral,
    )
}

fn badge(tone: Tone) -> &'static str {
    match tone {
        Tone::Done => {
            r#"<span class="badge done" aria-hidden="true"><svg viewBox="0 0 16 16" width="12" height="12"><path d="M3.5 8.4 6.6 11.3 12.5 4.9" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg></span>"#
        }
        Tone::Problem => {
            r#"<span class="badge problem" aria-hidden="true"><svg viewBox="0 0 16 16" width="12" height="12"><path d="M8 3.6v5.3" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/><circle cx="8" cy="12.2" r="1.3" fill="currentColor"/></svg></span>"#
        }
        Tone::Neutral => "",
    }
}

fn escape(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

const STYLE: &str = r#"
:root{color-scheme:light dark;--page:#f9f9f9;--card:#f0f0f0;--line:#e0e0e0;--text:#202020;--soft:#838383;--quiet:#8d8d8d;--done:#30a46c;--problem:#ffc53d;--on-problem:#4a3200;--shadow:0 1px 2px rgba(0,0,0,.04),0 12px 32px -12px rgba(0,0,0,.10)}
@media (prefers-color-scheme:dark){:root{--page:#191919;--card:#222222;--line:#313131;--text:#eeeeee;--soft:#7b7b7b;--quiet:#6e6e6e;--shadow:0 1px 2px rgba(0,0,0,.4),0 16px 40px -16px rgba(0,0,0,.6)}}
*{box-sizing:border-box}
html,body{height:100%;margin:0}
body{display:flex;align-items:center;justify-content:center;padding:24px;background:var(--page);color:var(--text);font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text","Segoe UI Variable Text","Segoe UI",Inter,"Helvetica Neue",Arial,sans-serif;-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility}
main{width:100%;max-width:432px;padding:36px 28px 22px;background:var(--card);border:1px solid var(--line);border-radius:16px;box-shadow:var(--shadow);text-align:center;animation:rise .45s cubic-bezier(.2,.8,.2,1) both}
.logo{position:relative;width:48px;height:48px;margin:0 auto 28px}
.logo svg.mark{display:block;width:48px;height:48px}
.badge{position:absolute;right:-7px;bottom:-7px;display:flex;align-items:center;justify-content:center;width:22px;height:22px;border-radius:50%;border:3px solid var(--card);animation:pop .35s .25s cubic-bezier(.2,1.4,.4,1) both}
.badge.done{background:var(--done);color:#fff}
.badge.problem{background:var(--problem);color:var(--on-problem)}
h1{margin:0 0 8px;font-size:24px;line-height:32px;font-weight:600;letter-spacing:-.02em;text-wrap:balance}
p{margin:0 auto;max-width:330px;font-size:16px;line-height:24px;color:var(--soft);text-wrap:balance}
footer{margin-top:28px;padding-top:16px;border-top:1px solid var(--line);font-size:13px;line-height:20px;color:var(--quiet)}
@keyframes rise{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
@keyframes pop{from{opacity:0;transform:scale(.6)}to{opacity:1;transform:none}}
@media (prefers-reduced-motion:reduce){main,.badge{animation:none}}
"#;

pub fn render(heading: &str, body: &str, tone: Tone) -> String {
    let heading = escape(heading);
    let body = escape(body);
    let logo = LOGO.replacen(
        "<svg ",
        "<svg class=\"mark\" aria-label=\"Cap\" role=\"img\" ",
        1,
    );
    format!(
        "<!DOCTYPE html>\n<html lang=\"{lang}\">\n<head>\n<meta charset=\"utf-8\">\n<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n<meta http-equiv=\"Cache-Control\" content=\"no-store, no-cache, must-revalidate\">\n<title>{heading} · Cap</title>\n<style>{STYLE}</style>\n</head>\n<body>\n<main>\n<div class=\"logo\">{logo}{badge}</div>\n<h1>{heading}</h1>\n<p>{body}</p>\n<footer>{close}</footer>\n</main>\n</body>\n</html>\n",
        lang = crate::i18n::current().code(),
        badge = badge(tone),
        close = escape(tr::local_page::close_tab()),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn every_page() -> Vec<(&'static str, String)> {
        vec![
            ("signed in", signed_in()),
            ("calendar", calendar_connected()),
            ("calendar not connected", calendar_not_connected()),
            ("drive", drive_connected()),
            ("drive not connected", drive_not_connected()),
            ("unknown", unknown()),
        ]
    }

    #[test]
    fn pages_load_nothing_from_anywhere_else() {
        for (name, page) in every_page() {
            let without_svg_namespace = page.replace("http://www.w3.org/2000/svg", "");
            for outside in [
                "http://", "https://", "//fonts", "@import", "src=\"", "<script", "<link",
            ] {
                assert!(
                    !without_svg_namespace.contains(outside),
                    "{name} page refers to {outside}"
                );
            }
            assert!(
                page.contains("<svg class=\"mark\""),
                "{name} page has the logo"
            );
            assert!(
                page.contains("prefers-color-scheme:dark"),
                "{name} page has a dark look"
            );
            assert!(!page.contains('\u{2014}'), "{name} page has an em dash");
        }
    }

    #[test]
    fn each_page_says_what_happened() {
        assert!(
            signed_in().contains("You’re signed in") || signed_in().contains("You're signed in")
        );
        assert!(signed_in().contains("badge done"));
        assert!(calendar_connected().contains("Calendar connected"));
        assert!(calendar_not_connected().contains("badge problem"));
        assert!(drive_connected().contains("Google Drive connected"));
        assert!(drive_connected().contains("badge done"));
        assert!(drive_not_connected().contains("access to your Google Drive"));
        assert!(drive_not_connected().contains("badge problem"));
        assert!(!unknown().contains("class=\"badge"));
        for (_, page) in every_page() {
            assert!(page.contains("You can close this tab."));
        }
    }

    #[test]
    fn text_is_escaped() {
        let page = render("<b>", "a & b", Tone::Neutral);
        assert!(page.contains("&lt;b&gt;") && page.contains("a &amp; b"));
    }
}
