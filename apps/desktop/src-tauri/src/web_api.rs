use reqwest::StatusCode;
use tauri::{Emitter, Manager, Runtime};
use tauri_specta::Event;
use thiserror::Error;
use tracing::{error, warn};

use crate::{
    ArcLock,
    auth::{AuthSecret, AuthStore, AuthenticationInvalid},
};

#[derive(Error, Debug)]
pub enum AuthedApiError {
    #[error("User is not authenticated or credentials have expired!")]
    InvalidAuthentication,
    #[error("User needs to upgrade their account to use this feature!")]
    UpgradeRequired,
    #[error("AuthedApiError/AuthStore: {0}")]
    AuthStore(String),
    #[error("AuthedApiError/Request: {0}")]
    Request(#[from] reqwest::Error),
    #[error("AuthedApiError/Deserialization: {0}")]
    Deserialization(#[from] serde_json::Error),
    #[error("AuthedApiError/Other: {0}")]
    Other(String),
}

impl From<&'static str> for AuthedApiError {
    fn from(value: &'static str) -> Self {
        AuthedApiError::Other(value.into())
    }
}

impl From<String> for AuthedApiError {
    fn from(value: String) -> Self {
        AuthedApiError::Other(value)
    }
}

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
        .header("X-Cap-Desktop-Version", env!("CARGO_PKG_VERSION"));

    if let Ok(s) = std::env::var("VITE_VERCEL_AUTOMATION_BYPASS_SECRET") {
        req = req.header("x-vercel-protection-bypass", s);
    }

    req.send().await
}

pub trait ManagerExt<R: Runtime>: Manager<R> {
    async fn authed_api_request(
        &self,
        path: impl Into<String>,
        build: impl FnOnce(reqwest::Client, String) -> reqwest::RequestBuilder,
    ) -> Result<reqwest::Response, AuthedApiError>;

    async fn make_app_url(&self, pathname: impl AsRef<str>) -> String;
}

impl<T: Manager<R> + Emitter<R>, R: Runtime> ManagerExt<R> for T {
    async fn authed_api_request(
        &self,
        path: impl Into<String>,
        build: impl FnOnce(reqwest::Client, String) -> reqwest::RequestBuilder,
    ) -> Result<reqwest::Response, AuthedApiError> {
        let Some(auth) = AuthStore::get(self.app_handle()).map_err(AuthedApiError::AuthStore)?
        else {
            warn!("Not logged in");
            AuthenticationInvalid.emit(self).ok();
            return Err(AuthedApiError::InvalidAuthentication);
        };

        let url = self.make_app_url(path.into()).await;
        let response = do_authed_request(&auth, build, url).await?;

        if response.status() == StatusCode::UNAUTHORIZED {
            error!("Authentication expired. Please log in again.");
            AuthenticationInvalid.emit(self).ok();
            return Err(AuthedApiError::InvalidAuthentication);
        }

        Ok(response)
    }

    async fn make_app_url(&self, pathname: impl AsRef<str>) -> String {
        let app_state = self.state::<ArcLock<crate::App>>();
        let server_url = &app_state.read().await.server_url;
        format!("{}{}", server_url, pathname.as_ref())
    }
}
