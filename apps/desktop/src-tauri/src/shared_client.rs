use reqwest::Client;
use std::sync::OnceLock;

/// Global shared HTTP client instance
static SHARED_CLIENT: OnceLock<Client> = OnceLock::new();

/// Get the shared HTTP client instance
/// 
/// This client is configured with retry policies and is shared across the entire application.
/// This allows for global tracking of requests to each domain for DOS protection.
pub fn get_shared_client() -> &'static Client {
    SHARED_CLIENT.get_or_init(|| {
        Client::builder()
            .timeout(std::time::Duration::from_secs(30))
            .build()
            .expect("Failed to create shared HTTP client")
    })
}

/// Get a retryable client builder for specific hosts
/// 
/// This function creates a client builder with retry policies configured for the given host.
/// The retry policies are designed to handle server errors and network issues while providing
/// DOS protection through global request tracking.
pub fn get_retryable_client_builder(host: String) -> reqwest::ClientBuilder {
    reqwest::Client::builder()
        .retry(
            reqwest::retry::for_host(host)
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
}

/// Get a retryable client for specific hosts
/// 
/// This function creates a client with retry policies configured for the given host.
/// It's a convenience function that builds the client immediately.
pub fn get_retryable_client(host: String) -> Result<Client, reqwest::Error> {
    get_retryable_client_builder(host).build()
}
