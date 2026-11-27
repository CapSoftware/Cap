use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use cap_calendar::HttpMethod;
use cap_calendar::oauth::{
    AuthError, GOOGLE_CALENDAR_SCOPE, GOOGLE_DRIVE_FILE_SCOPE, GOOGLE_SCOPES, MICROSOFT_SCOPES,
    OAuthClient, OAuthProvider, Pkce, authorize_url, authorize_url_with_scopes, grants_calendar,
    grants_scope, id_token_email, parse_redirect, parse_token_response, refresh_request,
    state_from_random, token_request,
};

fn query_of(url: &str) -> Vec<(String, String)> {
    url::Url::parse(url)
        .unwrap()
        .query_pairs()
        .map(|(k, v)| (k.into_owned(), v.into_owned()))
        .collect()
}

fn get<'a>(pairs: &'a [(String, String)], key: &str) -> Option<&'a str> {
    pairs
        .iter()
        .find(|(k, _)| k == key)
        .map(|(_, v)| v.as_str())
}

#[test]
fn pkce_matches_rfc_7636_vector() {
    let bytes = [
        116, 24, 223, 180, 151, 153, 224, 37, 79, 250, 96, 125, 216, 173, 187, 186, 22, 212, 37,
        77, 105, 214, 191, 240, 91, 88, 5, 88, 83, 132, 141, 121,
    ];
    let pkce = Pkce::from_random(&bytes).unwrap();
    assert_eq!(pkce.verifier, "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk");
    assert_eq!(
        pkce.challenge,
        "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
    );
    assert_eq!(
        Pkce::from_random(&[0; 31]),
        Err(AuthError::NotEnoughRandomness(31))
    );
    assert_eq!(Pkce::from_random(&[7; 500]).unwrap().verifier.len(), 128);
    assert!(state_from_random(&[1; 8]).is_err());
    assert_eq!(
        state_from_random(&[0xff; 16]).unwrap(),
        "_____________________w"
    );
}

#[test]
fn google_authorize_and_token_requests() {
    let client = OAuthClient::google(
        "123.apps.googleusercontent.com",
        Some("desktop-secret".to_string()),
    );
    let url = authorize_url(
        &client,
        "http://127.0.0.1:53682/callback",
        "st4te",
        "chal",
        Some("me@acme.example"),
    );
    assert!(url.starts_with("https://accounts.google.com/o/oauth2/v2/auth?"));
    let q = query_of(&url);
    assert_eq!(get(&q, "client_id"), Some("123.apps.googleusercontent.com"));
    assert_eq!(
        get(&q, "redirect_uri"),
        Some("http://127.0.0.1:53682/callback")
    );
    assert_eq!(get(&q, "response_type"), Some("code"));
    assert_eq!(
        get(&q, "scope"),
        Some("openid email https://www.googleapis.com/auth/calendar.readonly")
    );
    assert_eq!(get(&q, "access_type"), Some("offline"));
    assert_eq!(get(&q, "prompt"), Some("consent"));
    assert_eq!(get(&q, "code_challenge"), Some("chal"));
    assert_eq!(get(&q, "code_challenge_method"), Some("S256"));
    assert_eq!(get(&q, "state"), Some("st4te"));
    assert_eq!(get(&q, "login_hint"), Some("me@acme.example"));

    let spec = token_request(
        &client,
        "4/0Ab_code",
        "verifier",
        "http://127.0.0.1:53682/callback",
    );
    assert_eq!(spec.method, HttpMethod::Post);
    assert_eq!(spec.url, "https://oauth2.googleapis.com/token");
    assert_eq!(
        spec.header("content-type"),
        Some("application/x-www-form-urlencoded")
    );
    let body = spec.form_body().unwrap();
    let form: Vec<(String, String)> = url::form_urlencoded::parse(body.as_bytes())
        .map(|(k, v)| (k.into_owned(), v.into_owned()))
        .collect();
    assert_eq!(get(&form, "grant_type"), Some("authorization_code"));
    assert_eq!(get(&form, "code"), Some("4/0Ab_code"));
    assert_eq!(get(&form, "code_verifier"), Some("verifier"));
    assert_eq!(get(&form, "client_secret"), Some("desktop-secret"));
    assert_eq!(get(&form, "scope"), None);

    let refresh = refresh_request(&client, "1//refresh");
    assert_eq!(get(&refresh.form, "grant_type"), Some("refresh_token"));
    assert_eq!(get(&refresh.form, "refresh_token"), Some("1//refresh"));
}

#[test]
fn microsoft_authorize_and_token_requests() {
    let client = OAuthClient::microsoft("00000000-1111-2222-3333-444444444444");
    let url = authorize_url(&client, "http://localhost:53682/callback", "s", "c", None);
    assert!(url.starts_with("https://login.microsoftonline.com/common/oauth2/v2.0/authorize?"));
    let q = query_of(&url);
    let scope = get(&q, "scope").unwrap();
    for needed in ["offline_access", "Calendars.Read", "User.Read"] {
        assert!(scope.split(' ').any(|s| s == needed), "{needed}");
    }
    assert_eq!(get(&q, "login_hint"), None);
    assert_eq!(get(&q, "access_type"), None);

    let spec = token_request(&client, "code", "v", "http://localhost:53682/callback");
    assert_eq!(
        spec.url,
        "https://login.microsoftonline.com/common/oauth2/v2.0/token"
    );
    assert!(get(&spec.form, "scope").is_some());
    assert_eq!(get(&spec.form, "client_secret"), None);

    let tenant = OAuthClient {
        tenant: Some("contoso.onmicrosoft.com".to_string()),
        ..client.clone()
    };
    assert!(
        authorize_url(&tenant, "x", "s", "c", None)
            .starts_with("https://login.microsoftonline.com/contoso.onmicrosoft.com/")
    );
    let hostile = OAuthClient {
        tenant: Some("evil.example/../x?".to_string()),
        ..client
    };
    assert!(
        authorize_url(&hostile, "x", "s", "c", None)
            .starts_with("https://login.microsoftonline.com/common/")
    );
}

fn jwt(payload: &str) -> String {
    format!(
        "{}.{}.sig",
        URL_SAFE_NO_PAD.encode(br#"{"alg":"RS256"}"#),
        URL_SAFE_NO_PAD.encode(payload.as_bytes())
    )
}

#[test]
fn token_responses() {
    let google = format!(
        r#"{{"access_token":"ya29.a0","expires_in":3599,"refresh_token":"1//0g","scope":"openid https://www.googleapis.com/auth/calendar.readonly email","token_type":"Bearer","id_token":"{}"}}"#,
        jwt(
            r#"{"iss":"https://accounts.google.com","email":"me@acme.example","email_verified":true}"#
        )
    );
    let tokens = parse_token_response(&google).unwrap();
    assert_eq!(tokens.access_token, "ya29.a0");
    assert_eq!(tokens.refresh_token.as_deref(), Some("1//0g"));
    assert_eq!(tokens.expires_in, Some(3599));
    assert_eq!(tokens.id_token_email.as_deref(), Some("me@acme.example"));

    let microsoft = format!(
        r#"{{"token_type":"Bearer","scope":"Calendars.Read User.Read","expires_in":"4371","ext_expires_in":4371,"access_token":"eyJ0","refresh_token":"0.AAA","id_token":"{}"}}"#,
        jwt(r#"{"preferred_username":"me@contoso.example","name":"Me"}"#)
    );
    let tokens = parse_token_response(&microsoft).unwrap();
    assert_eq!(tokens.expires_in, Some(4371));
    assert_eq!(tokens.id_token_email.as_deref(), Some("me@contoso.example"));

    let refreshed = parse_token_response(r#"{"access_token":"new","expires_in":3600}"#).unwrap();
    assert_eq!(refreshed.refresh_token, None);
    assert_eq!(refreshed.id_token_email, None);

    assert_eq!(
        parse_token_response(
            r#"{"error":"invalid_grant","error_description":"Token has been expired or revoked."}"#
        ),
        Err(AuthError::Provider {
            error: "invalid_grant".to_string(),
            description: "Token has been expired or revoked.".to_string(),
        })
    );
    assert_eq!(
        parse_token_response(r#"{"error":"access_denied"}"#),
        Err(AuthError::AccessDenied)
    );
    assert!(matches!(
        parse_token_response("<html>"),
        Err(AuthError::InvalidResponse(_))
    ));
    assert!(matches!(
        parse_token_response("{}"),
        Err(AuthError::InvalidResponse(_))
    ));
    assert_eq!(id_token_email("only.two"), None);
    assert_eq!(id_token_email("a.!!!.c"), None);
    assert_eq!(id_token_email(&jwt(r#"{"sub":"123"}"#)), None);
}

#[test]
fn redirects() {
    assert_eq!(
        parse_redirect("code=4%2F0Ab&state=xyz&scope=email", "xyz")
            .unwrap()
            .code,
        "4/0Ab"
    );
    assert_eq!(
        parse_redirect("?state=xyz&code=abc", "xyz").unwrap().code,
        "abc"
    );
    assert_eq!(
        parse_redirect("http://127.0.0.1:53682/callback?code=abc&state=xyz", "xyz")
            .unwrap()
            .code,
        "abc"
    );
    assert_eq!(
        parse_redirect("code=abc&state=nope", "xyz"),
        Err(AuthError::StateMismatch)
    );
    assert_eq!(
        parse_redirect("code=abc", "xyz"),
        Err(AuthError::StateMismatch)
    );
    assert_eq!(
        parse_redirect("code=abc&state=", ""),
        Err(AuthError::StateMismatch)
    );
    assert_eq!(
        parse_redirect("error=access_denied&state=xyz", "xyz"),
        Err(AuthError::AccessDenied)
    );
    assert_eq!(
        parse_redirect(
            "error=consent_required&error_description=Need+admin&state=xyz",
            "xyz"
        ),
        Err(AuthError::Provider {
            error: "consent_required".to_string(),
            description: "Need admin".to_string(),
        })
    );
    assert_eq!(
        parse_redirect("state=xyz", "xyz"),
        Err(AuthError::MissingCode)
    );
    assert_eq!(
        parse_redirect("state=xyz&code=", "xyz"),
        Err(AuthError::MissingCode)
    );
}

#[test]
fn google_sign_in_without_the_calendar_box_ticked_is_not_calendar_access() {
    let google = OAuthClient::google("id", None);
    assert!(grants_calendar(
        &google,
        Some(
            "openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/calendar.readonly"
        )
    ));
    assert!(!grants_calendar(
        &google,
        Some("openid https://www.googleapis.com/auth/userinfo.email")
    ));
    assert!(!grants_calendar(
        &google,
        Some("https://www.googleapis.com/auth/calendar.readonly.extra")
    ));
    assert!(grants_calendar(&google, None));
    let microsoft = OAuthClient::microsoft("id");
    assert!(grants_calendar(&microsoft, Some("User.Read")));
}

#[test]
fn drive_authorize_url_asks_for_drive_file_only() {
    let client = OAuthClient::google("drive.apps.googleusercontent.com", None);
    let url = authorize_url_with_scopes(
        &client,
        GOOGLE_DRIVE_FILE_SCOPE,
        "http://127.0.0.1:53682",
        "st4te",
        "chal",
        None,
    );
    let pairs = query_of(&url);
    assert_eq!(
        get(&pairs, "scope"),
        Some("https://www.googleapis.com/auth/drive.file")
    );
    assert_eq!(
        GOOGLE_DRIVE_FILE_SCOPE,
        "https://www.googleapis.com/auth/drive.file"
    );
    assert_eq!(get(&pairs, "code_challenge"), Some("chal"));
    assert_eq!(get(&pairs, "code_challenge_method"), Some("S256"));
    assert_eq!(get(&pairs, "access_type"), Some("offline"));
    assert_eq!(get(&pairs, "prompt"), Some("consent"));
    assert_eq!(get(&pairs, "redirect_uri"), Some("http://127.0.0.1:53682"));
    assert_eq!(get(&pairs, "login_hint"), None);
    assert!(url.starts_with("https://accounts.google.com/o/oauth2/v2/auth?"));
}

#[test]
fn calendar_authorize_url_is_unchanged_by_the_scope_parameter() {
    let google = OAuthClient::google("123.apps.googleusercontent.com", Some("s".to_string()));
    assert_eq!(
        authorize_url(
            &google,
            "http://127.0.0.1:1/cb",
            "st",
            "ch",
            Some("me@x.example")
        ),
        authorize_url_with_scopes(
            &google,
            GOOGLE_SCOPES,
            "http://127.0.0.1:1/cb",
            "st",
            "ch",
            Some("me@x.example"),
        )
    );
    let microsoft = OAuthClient::microsoft("ms-id");
    assert_eq!(
        authorize_url(&microsoft, "http://localhost:2", "st", "ch", None),
        authorize_url_with_scopes(
            &microsoft,
            MICROSOFT_SCOPES,
            "http://localhost:2",
            "st",
            "ch",
            None,
        )
    );
}

#[test]
fn grants_scope_checks_the_wanted_scope_for_google_only() {
    let drive = "https://www.googleapis.com/auth/drive.file";
    assert!(grants_scope(
        OAuthProvider::Google,
        Some("openid https://www.googleapis.com/auth/drive.file"),
        drive
    ));
    assert!(!grants_scope(
        OAuthProvider::Google,
        Some("https://www.googleapis.com/auth/calendar.readonly"),
        drive
    ));
    assert!(!grants_scope(
        OAuthProvider::Google,
        Some("https://www.googleapis.com/auth/drive.file.extra"),
        drive
    ));
    assert!(!grants_scope(
        OAuthProvider::Google,
        Some("https://www.googleapis.com/auth/drive.file"),
        GOOGLE_CALENDAR_SCOPE
    ));
    assert!(grants_scope(OAuthProvider::Google, None, drive));
    assert!(grants_scope(
        OAuthProvider::Microsoft,
        Some("User.Read"),
        drive
    ));
    assert!(grants_scope(OAuthProvider::Microsoft, None, drive));
}
