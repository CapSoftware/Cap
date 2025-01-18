use serde::{Deserialize, Serialize};
use serde_json::json;
use specta::Type;
use tauri::{AppHandle, Runtime};
use tauri_plugin_store::StoreExt;

use web_api::ManagerExt;

use crate::web_api;

#[derive(Serialize, Deserialize, Type, Debug)]
pub struct AuthStore {
    pub token: String,
    pub user_id: Option<String>,
    pub expires: i32,
    pub plan: Option<Plan>,
    #[serde(default)]
    pub auth_state: Option<String>,
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
        let Some(Some(store)) = app.get_store("store").map(|s| s.get("auth")) else {
            return Ok(None);
        };

        serde_json::from_value(store).map_err(|e| e.to_string())
    }

    pub async fn fetch_and_update_plan(app: &AppHandle) -> Result<(), String> {
        let auth = Self::get(app)?;
        let Some(auth) = auth else {
            return Err("User not authenticated".to_string());
        };

        if let Some(plan) = &auth.plan {
            if plan.manual {
                return Ok(());
            }
        }

        let mut auth = auth;
        println!(
            "Fetching plan for user {}",
            auth.user_id.as_deref().unwrap_or("unknown")
        );
        let response = app
            .authed_api_request(|client| client.get(web_api::make_url("/api/desktop/plan")))
            .await
            .map_err(|e| {
                println!("Failed to fetch plan: {}", e);
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
            manual: auth.plan.as_ref().map_or(false, |p| p.manual),
        });

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
        let Some(store) = app.get_store("store") else {
            return Err("Store not found".to_string());
        };

        let value = value.map(|mut auth| {
            // Set expiration to 100 years in the future
            auth.expires = (chrono::Utc::now() + chrono::Duration::days(36500)).timestamp() as i32;
            auth
        });

        store.set("auth", json!(value));
        store.save().map_err(|e| e.to_string())
    }

    pub fn generate_auth_state() -> String {
        use rand::{thread_rng, Rng};
        const CHARSET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZ\
                                abcdefghijklmnopqrstuvwxyz\
                                0123456789";
        const STATE_LEN: usize = 32;
        
        let mut rng = thread_rng();
        let state: String = (0..STATE_LEN)
            .map(|_| {
                let idx = rng.gen_range(0..CHARSET.len());
                CHARSET[idx] as char
            })
            .collect();
        state
    }

    pub fn validate_token(token: &str) -> Result<(), String> {
        if token.is_empty() {
            return Err("Token cannot be empty".to_string());
        }
        if token.len() < 32 {
            return Err("Token is too short".to_string());
        }
        Ok(())
    }

    pub fn is_token_near_expiry(&self) -> bool {
        let current_time = chrono::Utc::now().timestamp() as i32;
        let expiry_threshold = 300; // 5 minutes
        self.expires - current_time < expiry_threshold
    }

    pub async fn refresh_token(&self, app: &AppHandle) -> Result<(), String> {
        let response = app
            .authed_api_request(|client| {
                client.post(web_api::make_url("/api/auth/refresh"))
                    .header("Authorization", format!("Bearer {}", self.token))
            })
            .await?;

        if !response.status().is_success() {
            return Err("Failed to refresh token".to_string());
        }

        #[derive(Deserialize)]
        struct RefreshResponse {
            token: String,
            expires: i32,
        }

        let refresh_data: RefreshResponse = response.json().await
            .map_err(|e| format!("Failed to parse refresh response: {}", e))?;

        let mut updated_auth = self.clone();
        updated_auth.token = refresh_data.token;
        updated_auth.expires = refresh_data.expires;

        Self::set(app, Some(updated_auth))?;
        Ok(())
    }
}

#[derive(specta::Type, serde::Serialize, tauri_specta::Event, Debug, Clone, serde::Deserialize)]
pub struct AuthenticationInvalid;
