use reqwest::Client;
use std::sync::OnceLock;

/// Global shared HTTP client instance with retry policies
static SHARED_CLIENT: OnceLock<Client> = OnceLock::new();

/// Get the shared HTTP client instance
/// 
/// This client is configured with retry policies and is shared across the entire application.
/// This allows for global tracking of requests to each domain for DOS protection.
pub fn get_shared_client() -> &'static Client {
    SHARED_CLIENT.get_or_init(|| {
        Client::builder()
            .retry(
                reqwest::retry::for_all_hosts()
                    .classify_fn(|req_rep| {
                        match req_rep.status() {
                            // Server errors and rate limiting
                            Some(s) if s.is_server_error() || s == reqwest::StatusCode::TOO_MANY_REQUESTS => {
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
            .timeout(std::time::Duration::from_secs(30))
            .build()
            .expect("Failed to create shared HTTP client")
    })
}

/// Get a retryable client for specific hosts
/// 
/// This function returns the shared client which has global retry tracking.
/// All requests use the same client instance for consistent DOS protection.
pub fn get_retryable_client(_host: String) -> Result<&'static Client, reqwest::Error> {
    Ok(get_shared_client())
}
