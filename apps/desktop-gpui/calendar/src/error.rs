#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum Error {
    #[error("invalid JSON: {0}")]
    Json(String),
    #[error("unexpected response shape: {0}")]
    InvalidResponse(String),
    #[error("provider error {code}: {message}")]
    Api {
        status: Option<u16>,
        code: String,
        message: String,
    },
    #[error("refusing to follow a link outside the provider API: {0}")]
    UntrustedUrl(String),
    #[error("invalid input: {0}")]
    InvalidInput(String),
}

impl Error {
    pub fn is_unauthorized(&self) -> bool {
        match self {
            Error::Api { status, code, .. } => {
                *status == Some(401)
                    || code.eq_ignore_ascii_case("InvalidAuthenticationToken")
                    || code.eq_ignore_ascii_case("UNAUTHENTICATED")
            }
            _ => false,
        }
    }
}

pub(crate) fn api_error_from(value: &serde_json::Value) -> Option<Error> {
    let error = value.get("error")?;
    if let Some(code) = error.as_str() {
        return Some(Error::Api {
            status: None,
            code: code.to_string(),
            message: value
                .get("error_description")
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .to_string(),
        });
    }
    let status = error
        .get("code")
        .and_then(|c| c.as_u64())
        .and_then(|c| u16::try_from(c).ok());
    let code = error
        .get("status")
        .and_then(|s| s.as_str())
        .or_else(|| error.get("code").and_then(|c| c.as_str()))
        .map(str::to_string)
        .or_else(|| status.map(|s| s.to_string()))
        .unwrap_or_else(|| "unknown".to_string());
    let message = error
        .get("message")
        .and_then(|m| m.as_str())
        .unwrap_or_default()
        .to_string();
    Some(Error::Api {
        status,
        code,
        message,
    })
}

pub(crate) fn parse_json(json: &str) -> Result<serde_json::Value, Error> {
    let value: serde_json::Value =
        serde_json::from_str(json).map_err(|e| Error::Json(e.to_string()))?;
    if let Some(err) = api_error_from(&value) {
        return Err(err);
    }
    Ok(value)
}
