use base64::Engine;
use base64::engine::general_purpose::{URL_SAFE, URL_SAFE_NO_PAD};
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::http::HttpRequestSpec;
use crate::text::non_empty;

pub const GOOGLE_AUTHORIZE_URL: &str = "https://accounts.google.com/o/oauth2/v2/auth";
pub const GOOGLE_TOKEN_URL: &str = "https://oauth2.googleapis.com/token";
pub const GOOGLE_CALENDAR_SCOPE: &str = "https://www.googleapis.com/auth/calendar.readonly";
pub const GOOGLE_SCOPES: &str = "openid email https://www.googleapis.com/auth/calendar.readonly";
pub const MICROSOFT_SCOPES: &str = "openid email offline_access Calendars.Read User.Read";

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum OAuthProvider {
    Google,
    Microsoft,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OAuthClient {
    pub provider: OAuthProvider,
    pub client_id: String,
    pub client_secret: Option<String>,
    pub tenant: Option<String>,
}

impl OAuthClient {
    pub fn google(client_id: impl Into<String>, client_secret: Option<String>) -> Self {
        Self {
            provider: OAuthProvider::Google,
            client_id: client_id.into(),
            client_secret,
            tenant: None,
        }
    }

    pub fn microsoft(client_id: impl Into<String>) -> Self {
        Self {
            provider: OAuthProvider::Microsoft,
            client_id: client_id.into(),
            client_secret: None,
            tenant: None,
        }
    }

    fn microsoft_base(&self) -> String {
        let tenant = self
            .tenant
            .as_deref()
            .map(str::trim)
            .filter(|t| {
                !t.is_empty()
                    && t.chars()
                        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '.')
            })
            .unwrap_or("common");
        format!("https://login.microsoftonline.com/{tenant}/oauth2/v2.0")
    }

    pub fn authorize_endpoint(&self) -> String {
        match self.provider {
            OAuthProvider::Google => GOOGLE_AUTHORIZE_URL.to_string(),
            OAuthProvider::Microsoft => format!("{}/authorize", self.microsoft_base()),
        }
    }

    pub fn token_endpoint(&self) -> String {
        match self.provider {
            OAuthProvider::Google => GOOGLE_TOKEN_URL.to_string(),
            OAuthProvider::Microsoft => format!("{}/token", self.microsoft_base()),
        }
    }

    pub fn scopes(&self) -> &'static str {
        match self.provider {
            OAuthProvider::Google => GOOGLE_SCOPES,
            OAuthProvider::Microsoft => MICROSOFT_SCOPES,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
pub enum AuthError {
    #[error("need at least 32 random bytes, got {0}")]
    NotEnoughRandomness(usize),
    #[error("the user denied access")]
    AccessDenied,
    #[error("authorization failed: {error} {description}")]
    Provider { error: String, description: String },
    #[error("state did not match")]
    StateMismatch,
    #[error("no authorization code in the redirect")]
    MissingCode,
    #[error("invalid token response: {0}")]
    InvalidResponse(String),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Pkce {
    pub verifier: String,
    pub challenge: String,
}

impl Pkce {
    pub fn from_random(bytes: &[u8]) -> Result<Self, AuthError> {
        if bytes.len() < 32 {
            return Err(AuthError::NotEnoughRandomness(bytes.len()));
        }
        let verifier = URL_SAFE_NO_PAD.encode(&bytes[..bytes.len().min(96)]);
        let challenge = s256_challenge(&verifier);
        Ok(Self {
            verifier,
            challenge,
        })
    }
}

pub fn s256_challenge(verifier: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
}

pub fn state_from_random(bytes: &[u8]) -> Result<String, AuthError> {
    if bytes.len() < 16 {
        return Err(AuthError::NotEnoughRandomness(bytes.len()));
    }
    Ok(URL_SAFE_NO_PAD.encode(bytes))
}

pub fn authorize_url(
    client: &OAuthClient,
    redirect_uri: &str,
    state: &str,
    challenge: &str,
    login_hint: Option<&str>,
) -> String {
    let mut pairs: Vec<(&str, &str)> = vec![
        ("client_id", client.client_id.as_str()),
        ("redirect_uri", redirect_uri),
        ("response_type", "code"),
        ("scope", client.scopes()),
        ("state", state),
        ("code_challenge", challenge),
        ("code_challenge_method", "S256"),
    ];
    match client.provider {
        OAuthProvider::Google => {
            pairs.push(("access_type", "offline"));
            pairs.push(("prompt", "consent"));
            pairs.push(("include_granted_scopes", "true"));
        }
        OAuthProvider::Microsoft => {
            pairs.push(("response_mode", "query"));
        }
    }
    if let Some(hint) = login_hint.map(str::trim).filter(|h| !h.is_empty()) {
        pairs.push(("login_hint", hint));
    }
    let query = url::form_urlencoded::Serializer::new(String::new())
        .extend_pairs(pairs)
        .finish();
    format!("{}?{query}", client.authorize_endpoint())
}

fn client_pairs(client: &OAuthClient, form: &mut Vec<(String, String)>) {
    form.push(("client_id".to_string(), client.client_id.clone()));
    if let Some(secret) = client.client_secret.as_deref().filter(|s| !s.is_empty()) {
        form.push(("client_secret".to_string(), secret.to_string()));
    }
    if client.provider == OAuthProvider::Microsoft {
        form.push(("scope".to_string(), client.scopes().to_string()));
    }
}

pub fn token_request(
    client: &OAuthClient,
    code: &str,
    verifier: &str,
    redirect_uri: &str,
) -> HttpRequestSpec {
    let mut form = vec![
        ("grant_type".to_string(), "authorization_code".to_string()),
        ("code".to_string(), code.to_string()),
        ("redirect_uri".to_string(), redirect_uri.to_string()),
        ("code_verifier".to_string(), verifier.to_string()),
    ];
    client_pairs(client, &mut form);
    HttpRequestSpec::post_form(client.token_endpoint(), form)
}

pub fn refresh_request(client: &OAuthClient, refresh_token: &str) -> HttpRequestSpec {
    let mut form = vec![
        ("grant_type".to_string(), "refresh_token".to_string()),
        ("refresh_token".to_string(), refresh_token.to_string()),
    ];
    client_pairs(client, &mut form);
    HttpRequestSpec::post_form(client.token_endpoint(), form)
}

/// Whether the sign-in granted calendar access. Google lets the person
/// untick it on the consent screen and still returns tokens; its token
/// response always lists what was granted. Microsoft grants every scope or
/// none.
pub fn grants_calendar(client: &OAuthClient, scope: Option<&str>) -> bool {
    match (client.provider, scope) {
        (OAuthProvider::Google, Some(scope)) => scope
            .split_whitespace()
            .any(|granted| granted == GOOGLE_CALENDAR_SCOPE),
        _ => true,
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Tokens {
    pub access_token: String,
    pub refresh_token: Option<String>,
    pub expires_in: Option<u64>,
    pub id_token_email: Option<String>,
    pub scope: Option<String>,
}

fn provider_error(value: &Value) -> Option<AuthError> {
    let error = value.get("error")?;
    let code = error
        .as_str()
        .or_else(|| error.get("code").and_then(Value::as_str))
        .unwrap_or("error")
        .to_string();
    let description = value
        .get("error_description")
        .and_then(Value::as_str)
        .or_else(|| error.get("message").and_then(Value::as_str))
        .unwrap_or_default()
        .to_string();
    if code == "access_denied" {
        return Some(AuthError::AccessDenied);
    }
    Some(AuthError::Provider {
        error: code,
        description,
    })
}

pub fn parse_token_response(json: &str) -> Result<Tokens, AuthError> {
    let value: Value =
        serde_json::from_str(json).map_err(|e| AuthError::InvalidResponse(e.to_string()))?;
    if let Some(err) = provider_error(&value) {
        return Err(err);
    }
    let access_token = non_empty(value.get("access_token").and_then(Value::as_str))
        .ok_or_else(|| AuthError::InvalidResponse("missing access_token".to_string()))?;
    let expires_in = match value.get("expires_in") {
        Some(Value::Number(n)) => n.as_u64(),
        Some(Value::String(s)) => s.trim().parse().ok(),
        _ => None,
    };
    Ok(Tokens {
        access_token,
        refresh_token: non_empty(value.get("refresh_token").and_then(Value::as_str)),
        expires_in,
        id_token_email: value
            .get("id_token")
            .and_then(Value::as_str)
            .and_then(id_token_email),
        scope: non_empty(value.get("scope").and_then(Value::as_str)),
    })
}

pub fn id_token_email(id_token: &str) -> Option<String> {
    let payload = id_token.split('.').nth(1)?;
    let bytes = URL_SAFE_NO_PAD
        .decode(payload.trim_end_matches('='))
        .or_else(|_| URL_SAFE.decode(payload))
        .ok()?;
    let claims: Value = serde_json::from_slice(&bytes).ok()?;
    ["email", "preferred_username", "upn"]
        .iter()
        .filter_map(|k| claims.get(*k).and_then(Value::as_str))
        .map(str::trim)
        .find(|v| v.contains('@'))
        .map(str::to_string)
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AuthCode {
    pub code: String,
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

pub fn parse_redirect(query: &str, expected_state: &str) -> Result<AuthCode, AuthError> {
    let raw = query.trim();
    let query = match url::Url::parse(raw) {
        Ok(url) if raw.contains("://") => url.query().unwrap_or_default().to_string(),
        _ => raw.trim_start_matches('?').to_string(),
    };
    let pairs: Vec<(String, String)> = url::form_urlencoded::parse(query.as_bytes())
        .map(|(k, v)| (k.into_owned(), v.into_owned()))
        .collect();
    let get = |name: &str| {
        pairs
            .iter()
            .find(|(k, _)| k == name)
            .map(|(_, v)| v.as_str())
    };
    let state_ok = get("state").is_some_and(|s| {
        !expected_state.is_empty() && constant_time_eq(s.as_bytes(), expected_state.as_bytes())
    });
    if !state_ok {
        return Err(AuthError::StateMismatch);
    }
    if let Some(error) = get("error") {
        if error == "access_denied" {
            return Err(AuthError::AccessDenied);
        }
        return Err(AuthError::Provider {
            error: error.to_string(),
            description: get("error_description").unwrap_or_default().to_string(),
        });
    }
    let code = get("code")
        .map(str::trim)
        .filter(|c| !c.is_empty())
        .ok_or(AuthError::MissingCode)?;
    Ok(AuthCode {
        code: code.to_string(),
    })
}
