use std::path::Path;

use base64::{Engine, engine::general_purpose::STANDARD};
use clap::ValueEnum;
use reqwest::Method;
use serde_json::{Value, json};

use crate::{OutputFormat, caps::AgentClient, resolve_format, write_json};

pub fn print_value(value: &Value, format: OutputFormat) -> Result<(), String> {
    match format {
        OutputFormat::Json => write_json(value),
        OutputFormat::Text => {
            println!(
                "{}",
                serde_json::to_string_pretty(value).map_err(|error| error.to_string())?
            );
            Ok(())
        }
    }
}

pub async fn read(path: &str, global_json: bool, format: OutputFormat) -> Result<(), String> {
    let client = AgentClient::from_credentials().map_err(|error| error.to_string())?;
    let value = client
        .get_json(path)
        .await
        .map_err(|error| error.to_string())?;
    print_value(&value, resolve_format(global_json, format))
}

pub async fn mutate(
    method: Method,
    path: &str,
    body: &Value,
    global_json: bool,
    format: OutputFormat,
) -> Result<(), String> {
    let client = AgentClient::from_credentials().map_err(|error| error.to_string())?;
    let value = client
        .mutate_json(method, path, body)
        .await
        .map_err(|error| error.to_string())?;
    print_value(&value, resolve_format(global_json, format))
}

pub async fn mutate_confirmed(
    method: Method,
    path: &str,
    body: &Value,
    global_json: bool,
    format: OutputFormat,
) -> Result<(), String> {
    let client = AgentClient::from_credentials().map_err(|error| error.to_string())?;
    let value = client
        .mutate_json_confirmed(method, path, body)
        .await
        .map_err(|error| error.to_string())?;
    print_value(&value, resolve_format(global_json, format))
}

pub fn query(parameters: &[(&str, Option<String>)]) -> String {
    let mut serializer = url::form_urlencoded::Serializer::new(String::new());
    for (key, value) in parameters {
        if let Some(value) = value {
            serializer.append_pair(key, value);
        }
    }
    serializer.finish()
}

pub fn image_payload(path: &Path) -> Result<Value, String> {
    let metadata = std::fs::metadata(path).map_err(|error| error.to_string())?;
    if metadata.len() == 0 || metadata.len() > 1024 * 1024 {
        return Err("Image must be between 1 byte and 1 MB".to_string());
    }
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .map(str::to_ascii_lowercase)
        .ok_or_else(|| "Image must be a PNG or JPEG".to_string())?;
    let content_type = match extension.as_str() {
        "jpg" | "jpeg" => "image/jpeg",
        "png" => "image/png",
        _ => return Err("Image must be a PNG or JPEG".to_string()),
    };
    let file_name = path
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "Image file name is invalid".to_string())?;
    let data = std::fs::read(path).map_err(|error| error.to_string())?;
    Ok(json!({
        "data": STANDARD.encode(data),
        "contentType": content_type,
        "fileName": file_name,
    }))
}

pub fn open_browser_action(value: &Value, no_open: bool) {
    if no_open {
        return;
    }
    let Some(url) = value.get("url").and_then(Value::as_str) else {
        return;
    };
    if let Err(error) = open::that(url) {
        eprintln!("Could not open the browser: {error}");
    }
}

#[derive(Clone, Copy, ValueEnum)]
pub enum SpaceRole {
    Admin,
    Member,
}

impl SpaceRole {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Admin => "admin",
            Self::Member => "member",
        }
    }
}
