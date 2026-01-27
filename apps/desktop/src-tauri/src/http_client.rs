//! We reuse clients so we get connection pooling and also so the retry policy can handle backing off across requests.

use std::ops::Deref;

use reqwest::StatusCode;

fn user_agent() -> &'static str {
    #[cfg(target_os = "macos")]
    {
        concat!("InFlightRecorder/", env!("CARGO_PKG_VERSION"), " (macOS)")
    }
    #[cfg(target_os = "windows")]
    {
        concat!("InFlightRecorder/", env!("CARGO_PKG_VERSION"), " (Windows)")
    }
    #[cfg(target_os = "linux")]
    {
        concat!("InFlightRecorder/", env!("CARGO_PKG_VERSION"), " (Linux)")
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    {
        concat!("InFlightRecorder/", env!("CARGO_PKG_VERSION"), " (Unknown)")
    }
}

pub struct HttpClient(reqwest::Client);

impl Default for HttpClient {
    fn default() -> Self {
        Self(
            reqwest::Client::builder()
                .user_agent(user_agent())
                .build()
                .expect("Failed to build HTTP client"),
        )
    }
}

impl Deref for HttpClient {
    type Target = reqwest::Client;

    fn deref(&self) -> &Self::Target {
        &self.0
    }
}

pub struct RetryableHttpClient(reqwest::Result<reqwest::Client>);

impl Default for RetryableHttpClient {
    fn default() -> Self {
        Self(
            reqwest::Client::builder()
                .user_agent(user_agent())
                .retry(
                    reqwest::retry::always()
                        .classify_fn(|req_rep| {
                            match req_rep.status() {
                                // Server errors
                                Some(s)
                                    if s.is_server_error()
                                        || s == StatusCode::TOO_MANY_REQUESTS =>
                                {
                                    req_rep.retryable()
                                }
                                // Network errors
                                None => req_rep.retryable(),
                                _ => req_rep.success(),
                            }
                        })
                        .max_retries_per_request(5)
                        .max_extra_load(5.0),
                )
                .build(),
        )
    }
}

impl Deref for RetryableHttpClient {
    type Target = reqwest::Result<reqwest::Client>;

    fn deref(&self) -> &Self::Target {
        &self.0
    }
}
