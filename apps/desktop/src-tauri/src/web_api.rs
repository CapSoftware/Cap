use reqwest::StatusCode;
use tauri::{Emitter, Manager, Runtime};
use tauri_specta::Event;

use crate::auth::{AuthStore, AuthenticationInvalid};

pub fn make_url(pathname: impl AsRef<str>) -> String {
    let server_url_base = "http://localhost:3000"; //dotenvy_macro::dotenv!("NEXT_PUBLIC_URL");
    format!("{server_url_base}{}", pathname.as_ref())
}

pub async fn do_request(
    build: impl FnOnce(reqwest::Client) -> reqwest::RequestBuilder,
) -> Result<reqwest::Response, reqwest::Error> {
    let client = reqwest::Client::new();
    build(client).send().await
}

async fn do_authed_request(
    auth: &AuthStore,
    build: impl FnOnce(reqwest::Client) -> reqwest::RequestBuilder,
) -> Result<reqwest::Response, reqwest::Error> {
    let client = reqwest::Client::new();

    build(client)
        .header("Authorization", format!("Bearer {}", auth.token))
        .send()
        .await
}

pub trait ManagerExt<R: Runtime>: Manager<R> {
    async fn authed_api_request(
        &self,
        build: impl FnOnce(reqwest::Client) -> reqwest::RequestBuilder,
    ) -> Result<reqwest::Response, String>;
}

impl<T: Manager<R> + Emitter<R>, R: Runtime> ManagerExt<R> for T {
    async fn authed_api_request(
        &self,
        build: impl FnOnce(reqwest::Client) -> reqwest::RequestBuilder,
    ) -> Result<reqwest::Response, String> {
        let Some(auth) = AuthStore::get(self.app_handle())? else {
            println!("Not logged in");

            AuthenticationInvalid.emit(self);

            return Err("Unauthorized".to_string());
        };

        let response = do_authed_request(&auth, build)
            .await
            .map_err(|e| e.to_string())?;

        if response.status() == StatusCode::UNAUTHORIZED {
            println!("Authentication expired. Please log in again.");

            AuthenticationInvalid.emit(self);

            return Err("Unauthorized".to_string());
        }

        Ok(response)
    }
}
