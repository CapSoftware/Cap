//! We reuse clients so we get connection pooling and also so the retry policy can handle backing off across requests.

use std::ops::Deref;

use reqwest::StatusCode;

pub struct HttpClient(reqwest::Client);

impl Default for HttpClient {
    fn default() -> Self {
        Self(reqwest::Client::new())
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
