use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::{AppHandle, Manager, Wry};
use tauri_plugin_store::{with_store, StoreCollection};

#[derive(Serialize, Deserialize, Type)]
pub struct AuthStore {
    pub token: String,
    pub expires: i32,
    pub plan: Plan,
}

#[derive(Serialize, Deserialize, Type)]
pub struct Plan {
    pub upgraded: bool,
    pub last_checked: i32,
}

impl AuthStore {
    pub fn get(app: &AppHandle) -> Result<Option<Self>, String> {
        let stores = app
            .try_state::<StoreCollection<Wry>>()
            .ok_or("Store not found")?;
        with_store(app.clone(), stores, "store", |store| {
            let Some(store_value) = store.get("auth").cloned() else {
                return Ok(None);
            };

            // Try to deserialize into the new structure
            match serde_json::from_value::<Self>(store_value.clone()) {
                Ok(auth_store) => Ok(Some(auth_store)),
                Err(_) => {
                    // If deserialization fails, it might be due to the old structure
                    // Try to deserialize into a temporary struct without the plan field
                    #[derive(Deserialize)]
                    struct OldAuthStore {
                        token: String,
                        expires: i32,
                    }

                    let old_auth: OldAuthStore = serde_json::from_value(store_value)?;

                    // Create a new AuthStore with default Plan values
                    Ok(Some(Self {
                        token: old_auth.token,
                        expires: old_auth.expires,
                        plan: Plan {
                            upgraded: false,
                            last_checked: 0,
                        },
                    }))
                }
            }
        })
        .map_err(|e| e.to_string())
    }

    pub async fn fetch_and_update_plan(app: &AppHandle) -> Result<(), String> {
        let auth = Self::get(app)?;
        let Some(mut auth) = auth else {
            return Err("User not authenticated".to_string());
        };

        let client = reqwest::Client::new();
        let server_url_base: &'static str = dotenvy_macro::dotenv!("NEXT_PUBLIC_URL");
        let url = format!("{}/api/desktop/plan", server_url_base);

        let response = client
            .get(&url)
            .header("Authorization", format!("Bearer {}", auth.token))
            .send()
            .await
            .map_err(|e| e.to_string())?;

        if !response.status().is_success() {
            let error_msg = format!("Failed to fetch plan: {}", response.status());
            return Err(error_msg);
        }

        let plan_response: serde_json::Value = response.json().await.map_err(|e| e.to_string())?;

        auth.plan.upgraded = plan_response["upgraded"].as_bool().unwrap_or(false);
        auth.plan.last_checked = chrono::Utc::now().timestamp() as i32;

        let _ = Self::set(app, Some(auth))?;

        Ok(())
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
