use serde::{Deserialize, Serialize};
use serde_json::json;
use specta::Type;
use tauri::{AppHandle, Manager, Runtime, Wry};
use tauri_plugin_store::StoreExt;

use web_api::ManagerExt;

use crate::web_api;

#[derive(Serialize, Deserialize, Type, Debug)]
pub struct AuthStore {
    pub token: String,
    pub expires: i32,
    pub plan: Option<Plan>,
}

#[derive(Serialize, Deserialize, Type, Debug)]
pub struct Plan {
    pub upgraded: bool,
    pub last_checked: i32,
}

impl AuthStore {
    pub fn get<R: Runtime>(app: &AppHandle<R>) -> Result<Option<Self>, String> {
        let Some(Some(store)) = app.get_store("store").map(|s| s.get("auth")) else {
            return Ok(None);
        };

        Ok(serde_json::from_value(store).map_err(|e| e.to_string())?)
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
        let Some(store) = app.get_store("store") else {
            return Err("Store not found".to_string());
        };

        store.set("auth", json!(value));
        store.save().map_err(|e| e.to_string())
    }
}

#[derive(specta::Type, serde::Serialize, tauri_specta::Event, Debug, Clone, serde::Deserialize)]
pub struct AuthenticationInvalid;
