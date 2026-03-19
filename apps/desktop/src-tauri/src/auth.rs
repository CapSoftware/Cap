use serde::{Deserialize, Serialize};
use serde_json::json;
use specta::Type;
use tauri::{AppHandle, Runtime};
use tauri_plugin_store::StoreExt;

use web_api::ManagerExt;

use crate::{
    api::{self, Organization},
    web_api,
};

#[derive(Serialize, Deserialize, Type, Debug)]
pub struct AuthStore {
    pub secret: AuthSecret,
    pub user_id: Option<String>,
    pub plan: Option<Plan>,
    #[serde(default)]
    pub organizations: Vec<Organization>,
}

#[derive(Serialize, Deserialize, Type, Debug)]
#[serde(untagged)]
pub enum AuthSecret {
    ApiKey { api_key: String },
    Session { token: String, expires: i32 },
}

#[derive(Serialize, Deserialize, Type, Debug)]
pub struct Plan {
    pub upgraded: bool,
    pub manual: bool,
    pub last_checked: i32,
}

impl AuthStore {
    pub fn load<R: Runtime>(app: &AppHandle<R>) -> Result<Option<Self>, String> {
        let Some(store) = app
            .store("store")
            .map(|s| s.get("auth"))
            .map_err(|e| e.to_string())?
        else {
            return Ok(None);
        };

        serde_json::from_value(store).map_err(|e| e.to_string())
    }

    pub fn get<R: Runtime>(app: &AppHandle<R>) -> Result<Option<Self>, String> {
        let Ok(Some(store)) = app.store("store").map(|s| s.get("auth")) else {
            return Ok(None);
        };

        serde_json::from_value(store).map_err(|e| e.to_string())
    }

    pub async fn update_auth_plan(app: &AppHandle) -> Result<(), String> {
        let auth = Self::get(app)?;
        let Some(auth) = auth else {
            return Err("User not authenticated".to_string());
        };

        if let Some(plan) = &auth.plan
            && plan.manual
        {
            return Ok(());
        }

        let mut auth = auth;
        println!(
            "Fetching plan for user {}",
            auth.user_id.as_deref().unwrap_or("unknown")
        );
        let response = app
            .authed_api_request("/api/desktop/plan", |client, url| client.get(url))
            .await
            .map_err(|e| {
                println!("Failed to fetch plan: {e}");
                e.to_string()
            })?;
        println!("Plan fetch response status: {}", response.status());

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
            manual: auth.plan.as_ref().is_some_and(|p| p.manual),
        });
        auth.organizations = api::fetch_organizations(app)
            .await
            .map_err(|e| e.to_string())?;

        Self::set(app, Some(auth))?;

        Ok(())
    }

    pub fn is_upgraded(&self) -> bool {
        match &self.plan {
            Some(plan) => plan.upgraded || plan.manual,
            None => false,
        }
    }

    pub fn set(app: &AppHandle, value: Option<Self>) -> Result<(), String> {
        let Ok(store) = app.store("store") else {
            return Err("Store not found".to_string());
        };

        store.set("auth", json!(value));
        store.save().map_err(|e| e.to_string())
    }
}
