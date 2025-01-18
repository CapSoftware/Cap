use reqwest::StatusCode;
use tauri::{Emitter, Manager, Runtime};
use tauri_specta::Event;

use crate::auth::{AuthStore, AuthenticationInvalid};

pub fn make_url(pathname: impl AsRef<str>) -> String {
    let server_url_base = dotenvy_macro::dotenv!("NEXT_PUBLIC_URL");
    format!("{server_url_base}{}", pathname.as_ref())
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
            println!("No authentication token found - initiating deep link authentication");

            AuthenticationInvalid.emit(self).ok();

            return Err("Authentication required - please complete the authentication process".to_string());
        };

        let response = do_authed_request(&auth, build)
            .await
            .map_err(|e| e.to_string())?;

        if response.status() == StatusCode::UNAUTHORIZED {
            println!("Authentication token expired - initiating deep link re-authentication");

            AuthenticationInvalid.emit(self).ok();

            // Clear the invalid auth token
            AuthStore::set(self.app_handle(), None)?;
            
            return Err("Authentication expired - please re-authenticate".to_string());
        }

        Ok(response)
    }
}