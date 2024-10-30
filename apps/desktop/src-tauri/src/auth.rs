use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::{AppHandle, Manager, Runtime, Wry};
use tauri_plugin_store::{with_store, StoreCollection};

use web_api::ManagerExt;

use crate::web_api;

#[derive(Serialize, Deserialize, Type)]
pub struct AuthStore {
    pub token: String,
    pub expires: i32,
    pub plan: Option<Plan>,
}

#[derive(Serialize, Deserialize, Type)]
pub struct Plan {
    pub upgraded: bool,
    pub last_checked: i32,
}

impl AuthStore {
    pub fn get<R: Runtime>(app: &AppHandle<R>) -> Result<Option<Self>, String> {
        let stores = app
            .try_state::<StoreCollection<R>>()
            .ok_or("Store not found")?;
        with_store(app.clone(), stores, "store", |store| {
            let Some(store) = store.get("auth").cloned() else {
                return Ok(None);
            };

            Ok(serde_json::from_value(store)?)
        })
        .map_err(|e| e.to_string())
    }

    pub async fn handle_auth_error(app: &AppHandle, error: &str) -> Result<(), String> {
        if error.contains("Authentication expired") || error.contains("Unauthorized") {
            // Clear auth and redirect to sign in
            Self::set(app, None)?;
            crate::delete_auth_open_signin(app.clone()).await?;
        }
        Ok(())
    }

    pub async fn fetch_and_update_plan(app: &AppHandle) -> Result<(), String> {
        let auth = Self::get(app)?;
        let Some(mut auth) = auth else {
            return Err("User not authenticated".to_string());
        };

        let response = app
            .authed_api_request(|client| client.get(web_api::make_url("/api/desktop/plan")))
            .await
            .map_err(|e| e.to_string())?;

        if response.status() == reqwest::StatusCode::UNAUTHORIZED {
            Self::handle_auth_error(app, "Authentication expired").await?;
            return Err("Authentication expired. Please log in again.".to_string());
        }

        if !response.status().is_success() {
            let error_msg = format!("Failed to fetch plan: {}", response.status());
            return Err(error_msg);
        }

        #[derive(Deserialize)]
        struct Response {
            upgraded: bool,
        }

        let plan_response: Response = response.json().await.map_err(|e| e.to_string())?;

        auth.plan = Some(Plan {
            upgraded: plan_response.upgraded,
            last_checked: chrono::Utc::now().timestamp() as i32,
        });

        let _ = Self::set(app, Some(auth))?;

        Ok(())
    }

    pub fn is_upgraded(&self) -> bool {
        self.plan.as_ref().map_or(false, |plan| plan.upgraded)
    }

    pub fn set(app: &AppHandle, value: Option<Self>) -> Result<(), String> {
        let stores = app
            .try_state::<StoreCollection<Wry>>()
            .ok_or("Store not found")?;
        with_store(app.clone(), stores, "store", |store| {
            let _ = store.insert("auth".to_string(), serde_json::to_value(value)?);
            store.save()
        })
        .map_err(|e| e.to_string())
    }
}

#[derive(specta::Type, serde::Serialize, tauri_specta::Event, Debug, Clone)]
pub struct AuthenticationInvalid;
