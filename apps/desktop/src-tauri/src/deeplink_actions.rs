use url::Url;

pub fn handle_deeplink_recording_action(url_str: &str) {
    if let Ok(parsed_url) = Url::parse(url_str) {
        match parsed_url.host_str() {
            Some("start-recording") => {
                let target_screen = parsed_url
                    .query_pairs()
                    .find(|(key, _)| key == "screen" || key == "display")
                    .map(|(_, val)| val.into_owned())
                    .unwrap_or_else(|| "primary".to_string());

                log::info!("Initiating capture sequence on resolved display: {}", target_screen);
            }
            Some("stop-recording") => {
                log::info!("Terminating active desktop recording sequence.");
            }
            _ => {
                log::warn!("Unrecognized deep-link action dispatched to desktop runtime.");
            }
        }
    }
}
