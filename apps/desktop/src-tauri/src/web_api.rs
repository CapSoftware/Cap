use reqwest::StatusCode;
use tauri::{Emitter, Manager, Runtime};
use tauri_specta::Event;
use tracing::error;

use crate::{
    ArcLock,
    auth::{AuthSecret, AuthStore, AuthenticationInvalid},
};

async fn do_authed_request(
    auth: &AuthStore,
    build: impl FnOnce(reqwest::Client, String) -> reqwest::RequestBuilder,
    url: String,
) -> Result<reqwest::Response, reqwest::Error> {
    let client = reqwest::Client::new();

    let mut req = build(client, url)
        .header(
            "Authorization",
            format!(
                "Bearer {}",
                match &auth.secret {
                    AuthSecret::ApiKey { api_key } => api_key,
                    AuthSecret::Session { token, .. } => token,
                }
            ),
        )
        .header("X-Desktop-Version", env!("CARGO_PKG_VERSION"));

    if let Some(s) = std::option_env!("VITE_VERCEL_AUTOMATION_BYPASS_SECRET") {
        req = req.header("x-vercel-protection-bypass", s);
    }

    req.send().await
}

pub trait ManagerExt<R: Runtime>: Manager<R> {
    async fn authed_api_request(
        &self,
        path: impl Into<String>,
        build: impl FnOnce(reqwest::Client, String) -> reqwest::RequestBuilder,
    ) -> Result<reqwest::Response, String>;

    async fn make_app_url(&self, pathname: impl AsRef<str>) -> String;
}

impl<T: Manager<R> + Emitter<R>, R: Runtime> ManagerExt<R> for T {
    async fn authed_api_request(
        &self,
        path: impl Into<String>,
        build: impl FnOnce(reqwest::Client, String) -> reqwest::RequestBuilder,
    ) -> Result<reqwest::Response, String> {
        let Some(auth) = AuthStore::get(self.app_handle())? else {
            println!("Not logged in");

            AuthenticationInvalid.emit(self).ok();

            return Err("Unauthorized".to_string());
        };

        let url = self.make_app_url(path.into()).await;
        let response = do_authed_request(&auth, build, url)
            .await
            .map_err(|e| e.to_string())?;

        if response.status() == StatusCode::UNAUTHORIZED {
            error!("Authentication expired. Please log in again.");

            AuthenticationInvalid.emit(self).ok();

            return Err("Unauthorized".to_string());
        }

        Ok(response)
    }

    async fn make_app_url(&self, pathname: impl AsRef<str>) -> String {
        let app_state = self.state::<ArcLock<crate::App>>();
        let server_url = &app_state.read().await.server_url;
        format!("{}{}", server_url, pathname.as_ref())
    }
}
