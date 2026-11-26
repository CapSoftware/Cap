#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HttpMethod {
    Get,
    Post,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HttpRequestSpec {
    pub method: HttpMethod,
    pub url: String,
    pub query: Vec<(String, String)>,
    pub headers: Vec<(String, String)>,
    pub form: Vec<(String, String)>,
}

impl HttpRequestSpec {
    pub(crate) fn get(url: impl Into<String>) -> Self {
        Self {
            method: HttpMethod::Get,
            url: url.into(),
            query: Vec::new(),
            headers: Vec::new(),
            form: Vec::new(),
        }
    }

    pub(crate) fn post_form(url: impl Into<String>, form: Vec<(String, String)>) -> Self {
        Self {
            method: HttpMethod::Post,
            url: url.into(),
            query: Vec::new(),
            headers: vec![(
                "Content-Type".to_string(),
                "application/x-www-form-urlencoded".to_string(),
            )],
            form,
        }
    }

    pub(crate) fn with_query(mut self, key: &str, value: impl Into<String>) -> Self {
        self.query.push((key.to_string(), value.into()));
        self
    }

    pub(crate) fn with_header(mut self, key: &str, value: impl Into<String>) -> Self {
        self.headers.push((key.to_string(), value.into()));
        self
    }

    pub fn url_with_query(&self) -> String {
        if self.query.is_empty() {
            return self.url.clone();
        }
        match url::Url::parse(&self.url) {
            Ok(mut parsed) => {
                parsed
                    .query_pairs_mut()
                    .extend_pairs(self.query.iter().map(|(k, v)| (k.as_str(), v.as_str())));
                parsed.to_string()
            }
            Err(_) => {
                let encoded = encode_pairs(&self.query);
                let sep = if self.url.contains('?') { '&' } else { '?' };
                format!("{}{sep}{encoded}", self.url)
            }
        }
    }

    pub fn form_body(&self) -> Option<String> {
        if self.method != HttpMethod::Post {
            return None;
        }
        Some(encode_pairs(&self.form))
    }

    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case(name))
            .map(|(_, v)| v.as_str())
    }
}

pub(crate) fn encode_pairs(pairs: &[(String, String)]) -> String {
    url::form_urlencoded::Serializer::new(String::new())
        .extend_pairs(pairs.iter().map(|(k, v)| (k.as_str(), v.as_str())))
        .finish()
}

pub(crate) fn api_url(base: &str, segments: &[&str]) -> String {
    match url::Url::parse(base) {
        Ok(mut url) => {
            if let Ok(mut path) = url.path_segments_mut() {
                path.pop_if_empty().extend(segments);
            }
            url.to_string()
        }
        Err(_) => base.to_string(),
    }
}
