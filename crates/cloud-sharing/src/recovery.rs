use super::*;

pub const RECOVERY_OBJECT_LIMIT: usize = 8 * 1024 * 1024;

impl SharingClient {
    pub fn configured_recovery(expected_origin: &str, uploading: bool) -> Result<Self, String> {
        let settings = load()?;
        let current = endpoint(&settings.endpoint)?;
        let expected = endpoint(expected_origin)?;
        if current.origin() != expected.origin() {
            return Err("Recovery backup is paused because the configured server changed.".into());
        }
        if uploading && !settings.backup_enabled {
            return Err("Private walk backup is off. Evidence remains saved locally.".into());
        }
        let token = stored_token(&current)?;
        Self::with_credentials(settings, token)
    }

    pub async fn recovery_request(
        &self,
        method: &str,
        resource: &str,
        body: Option<Vec<u8>>,
    ) -> Result<(u16, Vec<u8>), String> {
        if !matches!(method, "GET" | "HEAD" | "PUT" | "DELETE") {
            return Err("Unsupported recovery operation.".into());
        }
        let url = self
            .base
            .join(resource)
            .map_err(|_| "Invalid recovery resource.")?;
        if url.origin() != self.base.origin()
            || !(url.path() == "/api/v1/recovery" || url.path().starts_with("/api/v1/recovery/"))
            || url.fragment().is_some()
            || url.query_pairs().any(|(key, _)| key != "cursor")
        {
            return Err("Recovery requests must stay on the configured recovery service.".into());
        }
        if body
            .as_ref()
            .is_some_and(|bytes| bytes.len() > RECOVERY_OBJECT_LIMIT)
        {
            return Err("Recovery object exceeds the eight MiB limit.".into());
        }
        let verb = reqwest::Method::from_bytes(method.as_bytes())
            .map_err(|_| "Invalid recovery method.")?;
        let mut request = self.http.request(verb, url).bearer_auth(&self.token);
        if let Some(bytes) = body {
            request = request.body(bytes);
        }
        let mut response = request.send().await.map_err(
            |_| "Recovery server did not acknowledge the request; its result may be ambiguous.",
        )?;
        let status = response.status().as_u16();
        if !response.status().is_success() {
            return Err(format!(
                "Recovery server returned HTTP {status}. Pending evidence remains local."
            ));
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|_| "Recovery download was interrupted.")?
        {
            if bytes.len() + chunk.len() > RECOVERY_OBJECT_LIMIT {
                return Err("Recovery response exceeds the eight MiB limit.".into());
            }
            bytes.extend_from_slice(&chunk);
        }
        Ok((status, bytes))
    }
}
