// Resolved screen from query_pairs instead of hardcoding default
fn handle_deeplink(url: &Url) {
    let screen = url.query_pairs()
        .find(|(key, _)| key == "screen")
        .map(|(_, val)| val.into_owned())
        .unwrap_or_else(|| "default".to_string());
}
