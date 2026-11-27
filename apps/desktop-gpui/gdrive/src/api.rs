use std::{future::Future, time::Duration};

use reqwest::header::{CONTENT_LENGTH, CONTENT_TYPE};
use serde_json::{Map, Value, json};

use crate::types::{
    DriveError, Endpoints, FOLDER_MARKER, FOLDER_MIME, LinkVisibility, PrivateReason, TokenSource,
};

const USER_AGENT: &str = concat!("Cap/", env!("CARGO_PKG_VERSION"));
const JSON: &str = "application/json; charset=UTF-8";
const PUBLIC_PERMISSION: &str = r#"{"role":"reader","type":"anyone","allowFileDiscovery":false}"#;

pub struct DriveHttp {
    pub api: reqwest::Client,
    pub upload: reqwest::Client,
}

impl DriveHttp {
    pub fn new() -> Result<Self, DriveError> {
        let api = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(45))
            .redirect(reqwest::redirect::Policy::none())
            .user_agent(USER_AGENT)
            .build()
            .map_err(|e| DriveError::Protocol(e.to_string()))?;
        let upload = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(15))
            .redirect(reqwest::redirect::Policy::none())
            .user_agent(USER_AGENT)
            .build()
            .map_err(|e| DriveError::Protocol(e.to_string()))?;
        Ok(Self { api, upload })
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AboutUser {
    pub email: Option<String>,
    pub display_name: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FileInfo {
    pub id: String,
    pub web_view_link: Option<String>,
    pub trashed: bool,
    pub size: Option<u64>,
}

pub(crate) fn network_error(error: reqwest::Error) -> DriveError {
    if error.is_decode() || error.is_builder() {
        DriveError::Protocol(error.without_url().to_string())
    } else {
        DriveError::Offline
    }
}

pub(crate) fn url(base: &str, segments: &[&str]) -> Result<reqwest::Url, DriveError> {
    let mut url = reqwest::Url::parse(base).map_err(|e| DriveError::Protocol(e.to_string()))?;
    url.path_segments_mut()
        .map_err(|()| DriveError::Protocol(format!("{base} cannot take a path")))?
        .pop_if_empty()
        .extend(segments);
    Ok(url)
}

pub(crate) async fn read(response: reqwest::Response) -> Result<(u16, String), DriveError> {
    let status = response.status().as_u16();
    let body = response.text().await.map_err(network_error)?;
    Ok((status, body))
}

pub(crate) fn is_success(status: u16) -> bool {
    (200..300).contains(&status)
}

fn parse_json(body: &str) -> Result<Value, DriveError> {
    serde_json::from_str(body).map_err(|e| DriveError::Protocol(e.to_string()))
}

fn text(value: &Value) -> Option<String> {
    value.as_str().filter(|s| !s.is_empty()).map(str::to_string)
}

pub(crate) fn parse_file(body: &str) -> Result<FileInfo, DriveError> {
    let value = parse_json(body)?;
    let id = text(&value["id"])
        .ok_or_else(|| DriveError::Protocol("Google Drive sent a file without an id".into()))?;
    let size = match &value["size"] {
        Value::String(s) => s.parse().ok(),
        Value::Number(n) => n.as_u64(),
        _ => None,
    };
    Ok(FileInfo {
        id,
        web_view_link: text(&value["webViewLink"]),
        trashed: value["trashed"].as_bool().unwrap_or(false),
        size,
    })
}

pub(crate) async fn with_token<T, R, F, Fut>(tokens: &T, call: F) -> Result<R, DriveError>
where
    T: TokenSource,
    F: Fn(String) -> Fut,
    Fut: Future<Output = Result<R, DriveError>>,
{
    let token = tokens.access_token(false).await?;
    match call(token).await {
        Err(DriveError::SignInAgain) => call(tokens.access_token(true).await?).await,
        other => other,
    }
}

pub async fn about(
    http: &DriveHttp,
    endpoints: &Endpoints,
    token: &str,
) -> Result<AboutUser, DriveError> {
    let response = http
        .api
        .get(url(&endpoints.api, &["about"])?)
        .bearer_auth(token)
        .query(&[("fields", "user(emailAddress,displayName)")])
        .send()
        .await
        .map_err(network_error)?;
    let (status, body) = read(response).await?;
    if !is_success(status) {
        return Err(classify(status, &body));
    }
    let value = parse_json(&body)?;
    let user = &value["user"];
    Ok(AboutUser {
        email: text(&user["emailAddress"]),
        display_name: text(&user["displayName"]),
    })
}

pub async fn get_file(
    http: &DriveHttp,
    endpoints: &Endpoints,
    token: &str,
    file_id: &str,
) -> Result<Option<FileInfo>, DriveError> {
    let response = http
        .api
        .get(url(&endpoints.api, &["files", file_id])?)
        .bearer_auth(token)
        .query(&[("fields", "id,webViewLink,trashed,size")])
        .send()
        .await
        .map_err(network_error)?;
    let (status, body) = read(response).await?;
    match status {
        404 => Ok(None),
        s if is_success(s) => parse_file(&body).map(Some),
        s => Err(classify(s, &body)),
    }
}

pub async fn find_folder(
    http: &DriveHttp,
    endpoints: &Endpoints,
    token: &str,
) -> Result<Option<String>, DriveError> {
    let (key, value) = FOLDER_MARKER;
    let query = format!(
        "mimeType='{FOLDER_MIME}' and appProperties has {{ key='{key}' and value='{value}' }} and trashed=false"
    );
    let response = http
        .api
        .get(url(&endpoints.api, &["files"])?)
        .bearer_auth(token)
        .query(&[
            ("q", query.as_str()),
            ("fields", "files(id,name)"),
            ("pageSize", "10"),
        ])
        .send()
        .await
        .map_err(network_error)?;
    let (status, body) = read(response).await?;
    if !is_success(status) {
        return Err(classify(status, &body));
    }
    let value = parse_json(&body)?;
    Ok(value["files"]
        .as_array()
        .into_iter()
        .flatten()
        .find_map(|file| text(&file["id"])))
}

pub async fn create_folder(
    http: &DriveHttp,
    endpoints: &Endpoints,
    token: &str,
    name: &str,
) -> Result<String, DriveError> {
    let mut properties = Map::new();
    properties.insert(FOLDER_MARKER.0.into(), FOLDER_MARKER.1.into());
    let metadata = json!({
        "name": name,
        "mimeType": FOLDER_MIME,
        "appProperties": properties,
    });
    let response = http
        .api
        .post(url(&endpoints.api, &["files"])?)
        .bearer_auth(token)
        .query(&[("fields", "id")])
        .header(CONTENT_TYPE, JSON)
        .body(metadata.to_string())
        .send()
        .await
        .map_err(network_error)?;
    let (status, body) = read(response).await?;
    if !is_success(status) {
        return Err(classify(status, &body));
    }
    text(&parse_json(&body)?["id"])
        .ok_or_else(|| DriveError::Protocol("Google Drive created a folder without an id".into()))
}

pub async fn ensure_folder<T: TokenSource>(
    http: &DriveHttp,
    endpoints: &Endpoints,
    tokens: &T,
    name: &str,
    known_id: Option<&str>,
) -> Result<String, DriveError> {
    if let Some(id) = known_id.filter(|id| !id.is_empty()) {
        let known = with_token(tokens, |token| async move {
            get_file(http, endpoints, &token, id).await
        })
        .await?;
        if known.is_some_and(|folder| !folder.trashed) {
            return Ok(id.to_string());
        }
    }
    let found = with_token(tokens, |token| async move {
        find_folder(http, endpoints, &token).await
    })
    .await?;
    if let Some(id) = found {
        return Ok(id);
    }
    with_token(tokens, |token| async move {
        create_folder(http, endpoints, &token, name).await
    })
    .await
}

pub async fn make_public(
    http: &DriveHttp,
    endpoints: &Endpoints,
    token: &str,
    file_id: &str,
) -> Result<LinkVisibility, DriveError> {
    let response = http
        .api
        .post(url(&endpoints.api, &["files", file_id, "permissions"])?)
        .bearer_auth(token)
        .query(&[("fields", "id")])
        .header(CONTENT_TYPE, JSON)
        .body(PUBLIC_PERMISSION)
        .send()
        .await
        .map_err(network_error)?;
    let (status, body) = read(response).await?;
    if is_success(status) {
        return Ok(LinkVisibility::Public);
    }
    let reasons = reasons(&body);
    let has = |wanted: &str| reasons.iter().any(|reason| reason == wanted);
    if has("sharingRateLimitExceeded") {
        return Ok(LinkVisibility::Private(PrivateReason::RateLimited));
    }
    if has("invalidSharingRequest")
        || has("domainPolicy")
        || has("cannotShareTeamDriveWithNonGoogleAccounts")
    {
        return Ok(LinkVisibility::Private(PrivateReason::SharingRestricted));
    }
    Err(classify(status, &body))
}

pub async fn revoke(
    http: &DriveHttp,
    endpoints: &Endpoints,
    token: &str,
) -> Result<(), DriveError> {
    let response = http
        .api
        .post(&endpoints.revoke)
        .query(&[("token", token)])
        .header(CONTENT_TYPE, "application/x-www-form-urlencoded")
        .header(CONTENT_LENGTH, 0)
        .send()
        .await
        .map_err(network_error)?;
    let (status, body) = read(response).await?;
    if is_success(status) {
        return Ok(());
    }
    let value: Value = serde_json::from_str(&body).unwrap_or_default();
    if status == 400 && value["error"].as_str() == Some("invalid_token") {
        return Ok(());
    }
    Err(classify(status, &body))
}

fn reasons(body: &str) -> Vec<String> {
    let value: Value = serde_json::from_str(body).unwrap_or_default();
    let error = &value["error"];
    let listed = error["errors"]
        .as_array()
        .into_iter()
        .flatten()
        .chain(error["details"].as_array().into_iter().flatten())
        .filter_map(|item| item["reason"].as_str());
    listed
        .chain(error["status"].as_str())
        .map(str::to_string)
        .collect()
}

pub fn classify(status: u16, body: &str) -> DriveError {
    let reasons = reasons(body);
    let has = |wanted: &[&str]| {
        reasons
            .iter()
            .any(|reason| wanted.contains(&reason.as_str()))
    };
    if has(&["accessNotConfigured", "SERVICE_DISABLED"]) {
        DriveError::ApiDisabled
    } else if status == 401 || has(&["authError"]) {
        DriveError::SignInAgain
    } else if has(&["storageQuotaExceeded"]) {
        DriveError::StorageFull
    } else if has(&["domainPolicy", "appNotAuthorizedToFile"]) {
        DriveError::AdminBlocked
    } else if status == 429
        || has(&[
            "rateLimitExceeded",
            "userRateLimitExceeded",
            "sharingRateLimitExceeded",
        ])
    {
        DriveError::RateLimited
    } else if has(&["insufficientPermissions", "ACCESS_TOKEN_SCOPE_INSUFFICIENT"]) {
        DriveError::SignInAgain
    } else {
        DriveError::Server {
            status,
            reason: reasons.into_iter().next().unwrap_or_default(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::network_error;

    #[tokio::test]
    async fn a_request_error_never_carries_the_upload_session_address() {
        let error = reqwest::Client::new()
            .put("ftp://drive.invalid/upload?upload_id=SESSION-SECRET")
            .send()
            .await
            .expect_err("a non-http address is refused before any connection");
        assert!(error.is_builder());
        let message = network_error(error).to_string();
        assert!(!message.contains("SESSION-SECRET"), "{message}");
    }
}
