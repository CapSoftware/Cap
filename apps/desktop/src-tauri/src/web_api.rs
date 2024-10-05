use crate::auth::AuthStore;

pub fn make_url(pathname: impl AsRef<str>) -> String {
    let server_url_base = dotenvy_macro::dotenv!("NEXT_PUBLIC_URL");
    format!("{server_url_base}{}", pathname.as_ref())
}

pub async fn do_request(
    build: impl FnOnce(reqwest::Client) -> reqwest::RequestBuilder,
) -> Result<reqwest::Response, reqwest::Error> {
    let client = reqwest::Client::new();
    build(client).send().await
}

pub async fn do_authed_request(
    auth: &AuthStore,
    build: impl FnOnce(reqwest::Client) -> reqwest::RequestBuilder,
) -> Result<reqwest::Response, reqwest::Error> {
    let client = reqwest::Client::new();

    build(client)
        .header("Authorization", format!("Bearer {}", auth.token))
        .send()
        .await
}
