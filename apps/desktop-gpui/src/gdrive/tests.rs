use super::account::{self, ClientFileError, StoredFolder};
use super::*;
use crate::i18n::tr;

fn sharing(id: &str) -> cap_project::SharingMeta {
    cap_project::SharingMeta {
        id: id.into(),
        link: format!("https://example.com/{id}"),
        content_hash: None,
    }
}

fn share(visibility: LinkVisibility) -> DriveShare {
    DriveShare {
        file_id: "1AbC".into(),
        web_view_link: "https://drive.google.com/file/d/1AbC/view?usp=drivesdk&resourcekey=0-x"
            .into(),
        folder_id: "folder".into(),
        visibility,
        reused: false,
    }
}

#[test]
fn provider_round_trips_and_defaults_to_cap() {
    assert_eq!(ShareProvider::default(), ShareProvider::Cap);
    assert_eq!(ShareProvider::Cap.as_str(), "cap");
    assert_eq!(ShareProvider::GoogleDrive.as_str(), "googleDrive");
    for provider in [ShareProvider::Cap, ShareProvider::GoogleDrive] {
        assert_eq!(ShareProvider::parse(Some(provider.as_str())), provider);
    }
    assert_eq!(ShareProvider::parse(None), ShareProvider::Cap);
    assert_eq!(ShareProvider::parse(Some("")), ShareProvider::Cap);
    assert_eq!(
        ShareProvider::parse(Some("GoogleDrive")),
        ShareProvider::Cap
    );
    assert_eq!(ShareProvider::parse(Some("drive")), ShareProvider::Cap);
}

#[test]
fn link_route_follows_the_provider_table() {
    for drive_ready in [false, true] {
        assert_eq!(
            link_route(ShareProvider::Cap, drive_ready, true),
            LinkRoute::Cap
        );
        assert_eq!(
            link_route(ShareProvider::Cap, drive_ready, false),
            LinkRoute::SignInToCap
        );
    }
    for cap_signed_in in [false, true] {
        assert_eq!(
            link_route(ShareProvider::GoogleDrive, true, cap_signed_in),
            LinkRoute::Drive
        );
        assert_eq!(
            link_route(ShareProvider::GoogleDrive, false, cap_signed_in),
            LinkRoute::ConnectDrive
        );
    }
}

#[test]
fn drive_sharing_is_recognised_by_its_prefix() {
    assert!(is_drive_sharing(&sharing("gdrive:1AbC")));
    assert!(!is_drive_sharing(&sharing("v1abc")));
    assert!(!is_drive_sharing(&sharing("")));
}

#[test]
fn current_sharing_only_returns_the_providers_own_link() {
    let drive = sharing("gdrive:1AbC");
    let cap = sharing("v1abc");
    assert_eq!(
        current_sharing(Some(&drive), ShareProvider::GoogleDrive).map(|s| s.id.as_str()),
        Some("gdrive:1AbC")
    );
    assert!(current_sharing(Some(&drive), ShareProvider::Cap).is_none());
    assert_eq!(
        current_sharing(Some(&cap), ShareProvider::Cap).map(|s| s.id.as_str()),
        Some("v1abc")
    );
    assert!(current_sharing(Some(&cap), ShareProvider::GoogleDrive).is_none());
    assert!(current_sharing(None, ShareProvider::Cap).is_none());
    assert!(current_sharing(None, ShareProvider::GoogleDrive).is_none());
}

#[test]
fn sharing_meta_keeps_the_link_byte_for_byte() {
    let share = share(LinkVisibility::Public);
    let meta = sharing_meta(&share);
    assert_eq!(meta.id, "gdrive:1AbC");
    assert_eq!(meta.link, share.web_view_link);
    assert!(meta.content_hash.is_none());
}

#[test]
fn every_error_has_its_message() {
    let cases = [
        (DriveError::Offline, tr::gdrive::error_offline().to_string()),
        (
            DriveError::SignInAgain,
            tr::gdrive::error_reconnect().to_string(),
        ),
        (
            DriveError::AdminBlocked,
            tr::gdrive::error_admin().to_string(),
        ),
        (
            DriveError::StorageFull,
            tr::gdrive::error_full().to_string(),
        ),
        (
            DriveError::RateLimited,
            tr::gdrive::error_busy().to_string(),
        ),
        (
            DriveError::ApiDisabled,
            tr::gdrive::error_api_disabled().to_string(),
        ),
        (
            DriveError::LocalFile("gone".into()),
            tr::gdrive::error_missing_file().to_string(),
        ),
        (
            DriveError::NotConnected,
            tr::gdrive::error_not_connected().to_string(),
        ),
        (
            DriveError::NotConfigured,
            tr::gdrive::error_not_connected().to_string(),
        ),
        (DriveError::Denied, tr::gdrive::error_denied().to_string()),
        (DriveError::Cancelled, String::new()),
        (
            DriveError::Protocol("no Location header".into()),
            tr::gdrive::error_other("unexpected response from Google Drive: no Location header"),
        ),
        (
            DriveError::Server {
                status: 503,
                reason: "backendError".into(),
            },
            tr::gdrive::error_other("Google Drive answered 503: backendError"),
        ),
    ];
    for (error, expected) in cases {
        assert_eq!(error_message(&error), expected, "{error:?}");
    }
    assert!(error_message(&DriveError::ApiDisabled).contains("Google Drive API"));
}

#[test]
fn upload_errors_say_the_recording_is_kept() {
    assert_eq!(
        upload_error_message(&DriveError::Offline),
        format!(
            "{} {}",
            tr::gdrive::error_offline(),
            tr::gdrive::kept_locally()
        )
    );
    assert_eq!(upload_error_message(&DriveError::Cancelled), "");
    assert_eq!(
        upload_error_message(&DriveError::LocalFile("gone".into())),
        tr::gdrive::error_missing_file()
    );
}

#[test]
fn private_links_say_why() {
    assert_eq!(
        private_link_message(&PrivateReason::SharingRestricted),
        tr::gdrive::private_link()
    );
    assert_eq!(
        private_link_message(&PrivateReason::Other("domainPolicy".into())),
        tr::gdrive::private_link()
    );
    assert_eq!(
        private_link_message(&PrivateReason::RateLimited),
        tr::gdrive::private_link_busy()
    );
}

#[test]
fn client_file_errors_have_their_messages() {
    let cases = [
        (
            ClientFileError::Unreadable,
            tr::settings::integrations::drive_direct::import_unreadable(),
        ),
        (
            ClientFileError::NotJson,
            tr::settings::integrations::drive_direct::import_not_json(),
        ),
        (
            ClientFileError::NotDesktopClient,
            tr::settings::integrations::drive_direct::import_not_desktop(),
        ),
        (
            ClientFileError::MissingField,
            tr::settings::integrations::drive_direct::import_missing_field(),
        ),
    ];
    for (error, expected) in cases {
        assert_eq!(account::client_file_error_message(error), expected);
    }
}

#[test]
fn account_file_uses_the_documented_shape() {
    assert_eq!(
        StoredFolder::default(),
        StoredFolder {
            name: "Cap".into(),
            id: None,
        }
    );
    let parsed: account::AccountFile = serde_json::from_str(
        r#"{"version":1,"client":{"clientId":"id","clientSecret":"s"},"account":{"email":"me@example.com","refreshToken":"r","scope":"https://www.googleapis.com/auth/drive.file","connectedAtMs":5},"folder":{"name":"Cap","id":"f"}}"#,
    )
    .unwrap();
    assert_eq!(parsed.version, 1);
    assert_eq!(parsed.client.as_ref().unwrap().client_id, "id");
    assert_eq!(
        parsed.client.as_ref().unwrap().client_secret.as_deref(),
        Some("s")
    );
    let stored = parsed.account.as_ref().unwrap();
    assert_eq!(stored.refresh_token, "r");
    assert_eq!(stored.connected_at_ms, 5);
    assert_eq!(parsed.folder.id.as_deref(), Some("f"));
    let empty: account::AccountFile = serde_json::from_str("{}").unwrap();
    assert!(empty.client.is_none() && empty.account.is_none());
    assert_eq!(empty.folder, StoredFolder::default());
    assert_eq!(
        account::file_path(std::path::Path::new("/x")),
        std::path::Path::new("/x/account.json")
    );
}

#[test]
fn an_empty_folder_is_not_configured_and_talks_to_google() {
    let dir = tempfile::tempdir().unwrap();
    assert_eq!(
        account::status(dir.path()),
        account::DriveStatus::NotConfigured
    );
    assert!(account::client(dir.path()).is_none());
    assert_eq!(account::load(dir.path()), account::AccountFile::default());
    assert_eq!(account::endpoints(), cap_gdrive::Endpoints::google());
}

#[test]
fn every_drive_string_reads_as_text() {
    let texts = [
        tr::local_page::drive_title().to_string(),
        tr::local_page::drive_body().to_string(),
        tr::local_page::drive_denied_title().to_string(),
        tr::local_page::drive_denied_body().to_string(),
        tr::gdrive::uploading_title().to_string(),
        tr::gdrive::uploading_body().to_string(),
        tr::gdrive::link_copied_title().to_string(),
        tr::gdrive::link_copied_body().to_string(),
        tr::gdrive::share_to_drive().to_string(),
        tr::gdrive::connect_to_share().to_string(),
        tr::settings::integrations::drive_direct::name().to_string(),
        tr::settings::integrations::drive_direct::description().to_string(),
        tr::settings::integrations::drive_direct::client_id().to_string(),
        tr::settings::integrations::drive_direct::client_secret().to_string(),
        tr::settings::integrations::drive_direct::save_client().to_string(),
        tr::settings::integrations::drive_direct::import_client().to_string(),
        tr::settings::integrations::drive_direct::import_done().to_string(),
        tr::settings::integrations::drive_direct::setup_help().to_string(),
        tr::settings::integrations::drive_direct::connect().to_string(),
        tr::settings::integrations::drive_direct::connecting().to_string(),
        tr::settings::integrations::drive_direct::cancel().to_string(),
        tr::settings::integrations::drive_direct::disconnect().to_string(),
        tr::settings::integrations::drive_direct::connected_as("me@example.com"),
        tr::settings::integrations::drive_direct::connected_unknown().to_string(),
        tr::settings::integrations::drive_direct::folder().to_string(),
        tr::settings::integrations::drive_direct::share_links_with().to_string(),
        tr::settings::integrations::drive_direct::provider_cap().to_string(),
        tr::settings::integrations::drive_direct::provider_drive().to_string(),
        tr::settings::integrations::drive_direct::shared_client_warning().to_string(),
    ];
    for text in &texts {
        assert!(!text.trim().is_empty());
        assert!(!text.contains('{') && !text.contains('}'), "{text}");
        assert!(!text.contains('\u{2014}'), "{text}");
    }
    assert_eq!(
        tr::settings::integrations::drive_direct::connected_as("me@example.com"),
        "Connected as me@example.com"
    );
    assert!(
        tr::settings::integrations::drive_direct::setup_help()
            .contains("https://console.cloud.google.com/auth/overview/personal")
    );
}

const DRIVE: &str = "https://www.googleapis.com/auth/drive.file";

fn desktop_client_file(client_id: &str, secret: &str) -> String {
    serde_json::json!({
        "installed": {
            "client_id": client_id,
            "project_id": "cap-drive",
            "auth_uri": "https://accounts.google.com/o/oauth2/auth",
            "token_uri": "https://oauth2.googleapis.com/token",
            "client_secret": secret,
            "redirect_uris": ["http://localhost"]
        }
    })
    .to_string()
}

fn query_value(url: &str, key: &str) -> Option<String> {
    reqwest::Url::parse(url)
        .unwrap()
        .query_pairs()
        .find(|(k, _)| k == key)
        .map(|(_, v)| v.into_owned())
}

fn browser_get(port: u16, target: &str) -> String {
    use std::io::{Read, Write};
    let mut stream = std::net::TcpStream::connect((std::net::Ipv4Addr::LOCALHOST, port)).unwrap();
    write!(stream, "GET {target} HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n").unwrap();
    let mut response = String::new();
    stream.read_to_string(&mut response).unwrap();
    response
}

struct Browser {
    port: u16,
    state: String,
}

impl Browser {
    fn of(pending: &account::DriveConnect) -> Self {
        let redirect = query_value(&pending.authorize_url, "redirect_uri").unwrap();
        let port = reqwest::Url::parse(&redirect).unwrap().port().unwrap();
        Self {
            port,
            state: query_value(&pending.authorize_url, "state").unwrap(),
        }
    }

    async fn visit(&self, query: String) -> String {
        let port = self.port;
        tokio::task::spawn_blocking(move || browser_get(port, &format!("/?{query}")))
            .await
            .unwrap()
    }

    async fn return_code(&self, code: &str) -> String {
        self.visit(format!("code={code}&state={}", self.state))
            .await
    }
}

fn seed_client(dir: &std::path::Path, client_id: &str) {
    account::save_client(dir, client_id, Some("drive-secret")).unwrap();
}

fn seed_account(dir: &std::path::Path, fake: &cap_gdrive::fake::FakeGoogle, refresh: &str) {
    fake.issue_code(&format!("code-for-{refresh}"), refresh, DRIVE);
    account::save_account(
        dir,
        &account::StoredAccount {
            email: Some("me@example.com".into()),
            refresh_token: refresh.into(),
            scope: DRIVE.into(),
            connected_at_ms: 1,
        },
    )
    .unwrap();
}

async fn connect(
    dir: &std::path::Path,
    fake: &cap_gdrive::fake::FakeGoogle,
    code: &str,
) -> (String, Result<account::DriveStatus, DriveError>) {
    let pending = account::DriveConnect::new(dir.to_path_buf(), fake.endpoints()).unwrap();
    let browser = Browser::of(&pending);
    let finish = tokio::spawn(pending.finish());
    let page = browser.return_code(code).await;
    (page, finish.await.unwrap())
}

#[test]
fn drive_asks_for_the_same_scope_as_the_protocol_crate() {
    assert_eq!(
        cap_gdrive::DRIVE_FILE_SCOPE,
        cap_calendar::oauth::GOOGLE_DRIVE_FILE_SCOPE
    );
    assert_eq!(cap_gdrive::DRIVE_FILE_SCOPE, DRIVE);
}

#[test]
fn a_desktop_client_file_parses_and_everything_else_is_refused() {
    let parsed =
        account::parse_client_file(desktop_client_file(" id.apps ", "GOCSPX-1").as_bytes())
            .unwrap();
    assert_eq!(parsed.client_id, "id.apps");
    assert_eq!(parsed.client_secret.as_deref(), Some("GOCSPX-1"));
    let web = serde_json::json!({"web": {"client_id": "w", "client_secret": "s"}}).to_string();
    assert_eq!(
        account::parse_client_file(web.as_bytes()),
        Err(ClientFileError::NotDesktopClient)
    );
    let no_secret = serde_json::json!({"installed": {"client_id": "i"}}).to_string();
    assert_eq!(
        account::parse_client_file(no_secret.as_bytes()),
        Ok(account::StoredClient {
            client_id: "i".into(),
            client_secret: None,
        })
    );
    let blank_secret =
        serde_json::json!({"installed": {"client_id": "i", "client_secret": " "}}).to_string();
    assert_eq!(
        account::parse_client_file(blank_secret.as_bytes())
            .unwrap()
            .client_secret,
        None
    );
    let no_id = serde_json::json!({"installed": {"client_secret": "s"}}).to_string();
    assert_eq!(
        account::parse_client_file(no_id.as_bytes()),
        Err(ClientFileError::MissingField)
    );
    let web_without_secret = serde_json::json!({"web": {"client_id": "w"}}).to_string();
    assert_eq!(
        account::parse_client_file(web_without_secret.as_bytes()),
        Err(ClientFileError::NotDesktopClient)
    );
    let empty_id = desktop_client_file("  ", "s");
    assert_eq!(
        account::parse_client_file(empty_id.as_bytes()),
        Err(ClientFileError::MissingField)
    );
    let both = serde_json::json!({
        "web": {"client_id": "w", "client_secret": "s"},
        "installed": {"client_id": "i", "client_secret": "s"}
    })
    .to_string();
    assert_eq!(
        account::parse_client_file(both.as_bytes())
            .unwrap()
            .client_id,
        "i"
    );
    assert_eq!(
        account::parse_client_file(b"not json {"),
        Err(ClientFileError::NotJson)
    );
    assert_eq!(
        account::parse_client_file(b"[1, 2]"),
        Err(ClientFileError::MissingField)
    );
    let mut huge = desktop_client_file("i", "s").into_bytes();
    huge.resize(64 * 1024 + 1, b' ');
    assert_eq!(
        account::parse_client_file(&huge),
        Err(ClientFileError::Unreadable)
    );
}

#[test]
fn importing_a_client_file_saves_it_for_drive_only() {
    let root = tempfile::tempdir().unwrap();
    let dir = root.path().join(account::DIR);
    let file = root.path().join("client_secret_1.json");
    std::fs::write(&file, desktop_client_file("drive-id", "drive-secret")).unwrap();
    let imported = account::import_client_file(&dir, &file).unwrap();
    assert_eq!(imported.client_id, "drive-id");
    let client = account::client(&dir).unwrap();
    assert_eq!(client.client_id, "drive-id");
    assert_eq!(client.client_secret.as_deref(), Some("drive-secret"));
    assert_eq!(client.provider, cap_calendar::oauth::OAuthProvider::Google);
    assert_eq!(
        account::import_client_file(&dir, &root.path().join("missing.json")),
        Err(ClientFileError::Unreadable)
    );
    std::fs::write(&file, "{").unwrap();
    assert_eq!(
        account::import_client_file(&dir, &file),
        Err(ClientFileError::NotJson)
    );
    assert_eq!(account::client(&dir).unwrap().client_id, "drive-id");
    #[cfg(unix)]
    {
        assert_eq!(
            crate::meetings::persist::mode(&account::file_path(&dir)),
            0o600
        );
        assert_eq!(crate::meetings::persist::mode(&dir), 0o700);
    }
}

#[test]
fn a_client_file_without_a_secret_is_imported_without_one() {
    let root = tempfile::tempdir().unwrap();
    let dir = root.path().join(account::DIR);
    let file = root.path().join("client.json");
    std::fs::write(
        &file,
        serde_json::json!({"installed": {"client_id": "public-id"}}).to_string(),
    )
    .unwrap();
    account::import_client_file(&dir, &file).unwrap();
    let stored = account::load(&dir).client.unwrap();
    assert_eq!(stored.client_id, "public-id");
    assert_eq!(stored.client_secret, None);
    let client = account::client(&dir).unwrap();
    assert_eq!(client.client_secret, None);
    assert_eq!(account::status(&dir), account::DriveStatus::Disconnected);
}

#[test]
fn debug_output_never_shows_the_client_secret_or_the_refresh_token() {
    let file = account::AccountFile {
        version: 1,
        client: Some(account::StoredClient {
            client_id: "drive-id".into(),
            client_secret: Some("GOCSPX-SECRET-VALUE".into()),
        }),
        account: Some(account::StoredAccount {
            email: Some("me@example.com".into()),
            refresh_token: "1//REFRESH-SECRET-VALUE".into(),
            scope: DRIVE.into(),
            connected_at_ms: 1,
        }),
        folder: StoredFolder::default(),
    };
    for text in [
        format!("{file:?}"),
        format!("{file:#?}"),
        format!("{:?}", file.client),
        format!("{:?}", file.account),
    ] {
        assert!(!text.contains("SECRET-VALUE"), "{text}");
    }
    let shown = format!("{file:?}");
    assert!(shown.contains("drive-id"), "{shown}");
    assert!(shown.contains("me@example.com"), "{shown}");
    let without = format!("{:?}", account::StoredClient::default());
    assert!(without.contains("client_secret: None"), "{without}");
}

#[cfg(unix)]
#[test]
fn a_wider_account_file_is_tightened_when_read() {
    use std::os::unix::fs::PermissionsExt;
    let dir = tempfile::tempdir().unwrap();
    seed_client(dir.path(), "drive-id");
    let path = account::file_path(dir.path());
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
    assert_eq!(crate::meetings::persist::mode(&path), 0o644);
    assert_eq!(
        account::load(dir.path()).client.unwrap().client_id,
        "drive-id"
    );
    assert_eq!(crate::meetings::persist::mode(&path), 0o600);
}

#[test]
fn a_failed_refresh_clears_only_the_token_that_failed() {
    use account::RefreshFailure;
    let dir = tempfile::tempdir().unwrap();
    seed_client(dir.path(), "drive-id");
    let invalid_grant = || cap_calendar::oauth::AuthError::Provider {
        error: "invalid_grant".into(),
        description: String::new(),
    };
    let saved = |refresh: &str| account::StoredAccount {
        refresh_token: refresh.into(),
        ..Default::default()
    };

    account::save_account(dir.path(), &saved("rotated-by-the-other-refresh")).unwrap();
    account::cache_access(dir.path(), "access-from-the-other-refresh", Some(3600));
    assert_eq!(
        account::refresh_failed(dir.path(), "stale", 400, invalid_grant()),
        RefreshFailure::Superseded(DriveError::SignInAgain)
    );
    assert_eq!(
        account::load(dir.path()).account.unwrap().refresh_token,
        "rotated-by-the-other-refresh"
    );
    assert_eq!(
        account::cached_access(dir.path()).as_deref(),
        Some("access-from-the-other-refresh")
    );

    account::save_account(dir.path(), &saved("after-reconnect")).unwrap();
    assert_eq!(
        account::refresh_failed(dir.path(), "before-disconnect", 400, invalid_grant()),
        RefreshFailure::Superseded(DriveError::SignInAgain)
    );
    assert_eq!(
        account::load(dir.path()).account.unwrap().refresh_token,
        "after-reconnect"
    );

    assert_eq!(
        account::refresh_failed(dir.path(), "after-reconnect", 400, invalid_grant()),
        RefreshFailure::Error(DriveError::SignInAgain)
    );
    assert!(account::load(dir.path()).account.is_none());
    assert_eq!(
        account::refresh_failed(dir.path(), "after-reconnect", 400, invalid_grant()),
        RefreshFailure::Error(DriveError::NotConnected)
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_refresh_that_lost_to_a_rotation_uses_the_newer_token() {
    use cap_gdrive::TokenSource;
    let fake = cap_gdrive::fake::FakeGoogle::start();
    let dir = tempfile::tempdir().unwrap();
    seed_client(dir.path(), "drive-id");
    seed_account(dir.path(), &fake, "refresh-1");
    let tokens = account::AccountTokens::new(dir.path().to_path_buf(), fake.endpoints()).unwrap();
    tokens.access_token(true).await.unwrap();
    let after_rotation = tokens.access_token(true).await.unwrap();
    let rotated = account::load(dir.path()).account.unwrap().refresh_token;
    assert_ne!(rotated, "refresh-1");

    let fresh = tokens.refresh_with("refresh-1").await.unwrap();

    assert_ne!(fresh, after_rotation);
    assert_eq!(
        account::load(dir.path()).account.unwrap().refresh_token,
        rotated
    );
    assert_eq!(
        account::cached_access(dir.path()).as_deref(),
        Some(fresh.as_str())
    );
    assert!(matches!(
        account::status(dir.path()),
        account::DriveStatus::Connected { .. }
    ));
}

#[test]
fn the_client_comes_from_the_drive_file_alone() {
    assert!(account::pick_client(None).is_none());
    assert!(account::pick_client(Some(&account::StoredClient::default())).is_none());
    assert!(
        account::pick_client(Some(&account::StoredClient {
            client_id: "   ".into(),
            client_secret: Some("s".into()),
        }))
        .is_none()
    );
    let client = account::pick_client(Some(&account::StoredClient {
        client_id: "drive-id".into(),
        client_secret: Some(String::new()),
    }))
    .unwrap();
    assert_eq!(client.client_id, "drive-id");
    assert_eq!(client.client_secret, None);
}

#[test]
fn saving_and_clearing_follow_the_status() {
    let root = tempfile::tempdir().unwrap();
    let dir = root.path().join(account::DIR);
    let other = root.path().join("other");
    assert_eq!(account::status(&dir), account::DriveStatus::NotConfigured);
    seed_client(&dir, "drive-id");
    assert_eq!(account::status(&dir), account::DriveStatus::Disconnected);
    assert_eq!(account::status(&other), account::DriveStatus::NotConfigured);
    account::save_account(
        &dir,
        &account::StoredAccount {
            email: Some("me@example.com".into()),
            refresh_token: "r".into(),
            scope: DRIVE.into(),
            connected_at_ms: 1,
        },
    )
    .unwrap();
    assert_eq!(
        account::status(&dir),
        account::DriveStatus::Connected {
            email: Some("me@example.com".into())
        }
    );
    account::save_folder(
        &dir,
        &StoredFolder {
            name: "Recordings".into(),
            id: Some("f1".into()),
        },
    )
    .unwrap();
    let file = account::load(&dir);
    assert_eq!(file.version, 1);
    assert_eq!(file.folder.name, "Recordings");
    assert_eq!(file.folder.id.as_deref(), Some("f1"));
    seed_client(&dir, "drive-id");
    assert!(account::load(&dir).account.is_some());
    account::clear_client(&dir).unwrap();
    assert_eq!(account::status(&dir), account::DriveStatus::NotConfigured);
    let file = account::load(&dir);
    assert!(file.client.is_none() && file.account.is_none());
    assert_eq!(file.folder.name, "Recordings");
}

#[test]
fn a_new_client_id_forgets_the_old_sign_in() {
    let dir = tempfile::tempdir().unwrap();
    seed_client(dir.path(), "first");
    account::save_account(
        dir.path(),
        &account::StoredAccount {
            refresh_token: "r".into(),
            ..Default::default()
        },
    )
    .unwrap();
    seed_client(dir.path(), "second");
    assert!(account::load(dir.path()).account.is_none());
    assert_eq!(
        account::status(dir.path()),
        account::DriveStatus::Disconnected
    );
}

#[test]
fn status_is_answered_from_memory_per_token_file() {
    let a = tempfile::tempdir().unwrap();
    let b = tempfile::tempdir().unwrap();
    seed_client(a.path(), "a");
    assert_eq!(
        account::status(a.path()),
        account::DriveStatus::Disconnected
    );
    assert_eq!(
        account::status(b.path()),
        account::DriveStatus::NotConfigured
    );
    std::fs::write(account::file_path(a.path()), "{}").unwrap();
    assert_eq!(
        account::status(a.path()),
        account::DriveStatus::Disconnected
    );
    seed_client(b.path(), "b");
    assert_eq!(
        account::status(b.path()),
        account::DriveStatus::Disconnected
    );
}

#[test]
fn the_access_token_cache_is_per_token_file_and_expires_early() {
    let a = tempfile::tempdir().unwrap();
    let b = tempfile::tempdir().unwrap();
    account::cache_access(a.path(), "token-a", Some(3600));
    assert_eq!(account::cached_access(a.path()).as_deref(), Some("token-a"));
    assert_eq!(account::cached_access(b.path()), None);
    account::cache_access(b.path(), "token-b", Some(90));
    assert_eq!(account::cached_access(b.path()), None);
    assert_eq!(account::cached_access(a.path()).as_deref(), Some("token-a"));
    let now = std::time::Instant::now();
    assert_eq!(
        account::cache_deadline(now, Some(3600)),
        now + std::time::Duration::from_secs(3510)
    );
    assert_eq!(account::cache_deadline(now, Some(30)), now);
    assert_eq!(
        account::cache_deadline(now, None),
        now + std::time::Duration::from_secs(510)
    );
}

#[test]
fn the_revoke_guard_compares_client_ids() {
    assert!(account::revoke_allowed("drive", None));
    assert!(account::revoke_allowed("drive", Some("calendar")));
    assert!(!account::revoke_allowed("same", Some("same")));
    assert!(!account::revoke_allowed("same", Some(" same ")));
}

#[test]
fn connecting_needs_a_client() {
    let dir = tempfile::tempdir().unwrap();
    assert!(matches!(
        account::DriveConnect::new(
            dir.path().to_path_buf(),
            cap_gdrive::Endpoints::local("http://127.0.0.1:9")
        ),
        Err(DriveError::NotConfigured)
    ));
}

#[test]
fn the_consent_page_asks_for_drive_file_on_the_given_endpoint() {
    let dir = tempfile::tempdir().unwrap();
    seed_client(dir.path(), "drive-id");
    let endpoints = cap_gdrive::Endpoints::local("http://127.0.0.1:9");
    let pending = account::DriveConnect::new(dir.path().to_path_buf(), endpoints.clone()).unwrap();
    let url = &pending.authorize_url;
    assert!(
        url.starts_with(&format!("{}?", endpoints.authorize)),
        "{url}"
    );
    assert_eq!(query_value(url, "scope").as_deref(), Some(DRIVE));
    assert_eq!(query_value(url, "client_id").as_deref(), Some("drive-id"));
    assert_eq!(
        query_value(url, "code_challenge_method").as_deref(),
        Some("S256")
    );
    assert_eq!(query_value(url, "access_type").as_deref(), Some("offline"));
    assert_eq!(query_value(url, "prompt").as_deref(), Some("consent"));
    let redirect = query_value(url, "redirect_uri").unwrap();
    assert!(redirect.starts_with("http://127.0.0.1:"), "{redirect}");
    assert!(!url.contains("drive-secret"));
    let google =
        account::DriveConnect::new(dir.path().to_path_buf(), cap_gdrive::Endpoints::google())
            .unwrap();
    assert!(
        google
            .authorize_url
            .starts_with("https://accounts.google.com/o/oauth2/v2/auth?")
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_refused_consent_shows_the_not_connected_page() {
    let dir = tempfile::tempdir().unwrap();
    seed_client(dir.path(), "drive-id");
    let pending = account::DriveConnect::new(
        dir.path().to_path_buf(),
        cap_gdrive::Endpoints::local("http://127.0.0.1:9"),
    )
    .unwrap();
    let browser = Browser::of(&pending);
    let finish = tokio::spawn(pending.finish());
    let page = browser
        .visit(format!("error=access_denied&state={}", browser.state))
        .await;
    assert!(page.starts_with("HTTP/1.1 200"), "{page}");
    assert!(page.contains("access to your Google Drive"), "{page}");
    assert_eq!(finish.await.unwrap(), Err(DriveError::Denied));
    assert!(account::load(dir.path()).account.is_none());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_cancelled_wait_saves_nothing() {
    let dir = tempfile::tempdir().unwrap();
    seed_client(dir.path(), "drive-id");
    let pending = account::DriveConnect::new(
        dir.path().to_path_buf(),
        cap_gdrive::Endpoints::local("http://127.0.0.1:9"),
    )
    .unwrap();
    let browser = Browser::of(&pending);
    let cancel = pending.cancel.clone();
    let finish = tokio::spawn(pending.finish());
    let page = browser.visit("code=c&state=wrong".to_string()).await;
    assert!(page.starts_with("HTTP/1.1 400"), "{page}");
    cancel.cancel();
    assert_eq!(finish.await.unwrap(), Err(DriveError::Cancelled));
    assert!(account::load(dir.path()).account.is_none());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn connect_saves_the_account_and_the_folder_privately() {
    let fake = cap_gdrive::fake::FakeGoogle::start();
    let root = tempfile::tempdir().unwrap();
    let dir = root.path().join(account::DIR);
    seed_client(&dir, "drive-id");
    fake.issue_code("c", "refresh-1", DRIVE);
    let (page, status) = connect(&dir, &fake, "c").await;
    assert!(page.starts_with("HTTP/1.1 200"), "{page}");
    assert!(page.contains("Google Drive connected"), "{page}");
    let account::DriveStatus::Connected { email } = status.unwrap() else {
        panic!("not connected");
    };
    assert_eq!(
        account::status(&dir),
        account::DriveStatus::Connected { email }
    );
    let file = account::load(&dir);
    let stored = file.account.unwrap();
    assert_eq!(stored.refresh_token, "refresh-1");
    assert!(stored.connected_at_ms > 0);
    let folder_id = file.folder.id.unwrap();
    let folders: Vec<_> = fake
        .files()
        .into_iter()
        .filter(|f| f.mime_type == cap_gdrive::FOLDER_MIME)
        .collect();
    assert_eq!(folders.len(), 1);
    assert_eq!(folders[0].id, folder_id);
    assert_eq!(folders[0].name, "Cap");
    assert!(account::cached_access(&dir).is_some());
    #[cfg(unix)]
    {
        assert_eq!(
            crate::meetings::persist::mode(&account::file_path(&dir)),
            0o600
        );
        assert_eq!(crate::meetings::persist::mode(&dir), 0o700);
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_wrong_state_is_refused_and_the_wait_goes_on() {
    let fake = cap_gdrive::fake::FakeGoogle::start();
    let dir = tempfile::tempdir().unwrap();
    seed_client(dir.path(), "drive-id");
    fake.issue_code("c", "refresh-1", DRIVE);
    let pending = account::DriveConnect::new(dir.path().to_path_buf(), fake.endpoints()).unwrap();
    let browser = Browser::of(&pending);
    let finish = tokio::spawn(pending.finish());
    let refused = browser.visit("code=c&state=forged".to_string()).await;
    assert!(refused.starts_with("HTTP/1.1 400"), "{refused}");
    let page = browser.return_code("c").await;
    assert!(page.contains("Google Drive connected"), "{page}");
    assert!(matches!(
        finish.await.unwrap(),
        Ok(account::DriveStatus::Connected { .. })
    ));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_token_without_drive_file_is_denied_and_saves_nothing() {
    let fake = cap_gdrive::fake::FakeGoogle::start();
    let dir = tempfile::tempdir().unwrap();
    seed_client(dir.path(), "drive-id");
    fake.issue_code(
        "c",
        "refresh-1",
        "https://www.googleapis.com/auth/calendar.readonly",
    );
    let (_, status) = connect(dir.path(), &fake, "c").await;
    assert_eq!(status, Err(DriveError::Denied));
    let file = account::load(dir.path());
    assert!(file.account.is_none());
    assert!(file.folder.id.is_none());
    assert_eq!(account::cached_access(dir.path()), None);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn api_disabled_at_connect_keeps_the_consent() {
    let fake = cap_gdrive::fake::FakeGoogle::start();
    let dir = tempfile::tempdir().unwrap();
    seed_client(dir.path(), "drive-id");
    fake.issue_code("c", "refresh-1", DRIVE);
    for _ in 0..2 {
        fake.push_fault(cap_gdrive::fake::Fault::ApiStatus {
            status: 403,
            reason: "accessNotConfigured",
        });
    }
    let (_, status) = connect(dir.path(), &fake, "c").await;
    assert_eq!(status, Err(DriveError::ApiDisabled));
    let file = account::load(dir.path());
    assert_eq!(file.account.unwrap().refresh_token, "refresh-1");
    assert!(file.folder.id.is_none());
    assert!(matches!(
        account::status(dir.path()),
        account::DriveStatus::Connected { .. }
    ));
    let http = cap_gdrive::api::DriveHttp::new().unwrap();
    let tokens = account::AccountTokens::new(dir.path().to_path_buf(), fake.endpoints()).unwrap();
    let folder = cap_gdrive::api::ensure_folder(&http, &fake.endpoints(), &tokens, "Cap", None)
        .await
        .unwrap();
    assert!(!folder.is_empty());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn refresh_rotates_caches_and_maps_token_errors() {
    use cap_gdrive::TokenSource;
    use cap_gdrive::fake::Fault;
    let fake = cap_gdrive::fake::FakeGoogle::start();
    let dir = tempfile::tempdir().unwrap();
    seed_client(dir.path(), "drive-id");
    seed_account(dir.path(), &fake, "refresh-1");
    let tokens = account::AccountTokens::new(dir.path().to_path_buf(), fake.endpoints()).unwrap();
    tokens.access_token(true).await.unwrap();
    let latest = tokens.access_token(true).await.unwrap();
    assert_ne!(
        account::load(dir.path()).account.unwrap().refresh_token,
        "refresh-1"
    );
    fake.push_fault(Fault::TokenError {
        error: "invalid_grant",
    });
    assert_eq!(tokens.access_token(false).await.unwrap(), latest);
    assert_eq!(
        tokens.access_token(true).await,
        Err(DriveError::SignInAgain)
    );
    let file = account::load(dir.path());
    assert!(file.account.is_none());
    assert_eq!(file.client.unwrap().client_id, "drive-id");
    assert_eq!(account::cached_access(dir.path()), None);
    assert_eq!(
        account::status(dir.path()),
        account::DriveStatus::Disconnected
    );

    seed_account(dir.path(), &fake, "refresh-2");
    fake.push_fault(Fault::TokenError {
        error: "admin_policy_enforced",
    });
    assert_eq!(
        tokens.access_token(true).await,
        Err(DriveError::AdminBlocked)
    );
    assert!(account::load(dir.path()).account.is_some());

    fake.push_fault(Fault::TokenError {
        error: "deleted_client",
    });
    assert_eq!(
        tokens.access_token(true).await,
        Err(DriveError::NotConfigured)
    );
    assert!(account::load(dir.path()).account.is_none());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn refresh_while_offline_is_offline() {
    use cap_gdrive::TokenSource;
    let closed = std::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).unwrap();
    let base = format!("http://{}", closed.local_addr().unwrap());
    drop(closed);
    let dir = tempfile::tempdir().unwrap();
    seed_client(dir.path(), "drive-id");
    account::save_account(
        dir.path(),
        &account::StoredAccount {
            refresh_token: "r".into(),
            ..Default::default()
        },
    )
    .unwrap();
    let tokens = account::AccountTokens::new(
        dir.path().to_path_buf(),
        cap_gdrive::Endpoints::local(&base),
    )
    .unwrap();
    assert_eq!(tokens.access_token(false).await, Err(DriveError::Offline));
    assert!(account::load(dir.path()).account.is_some());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn tokens_need_a_client_and_an_account() {
    use cap_gdrive::TokenSource;
    let dir = tempfile::tempdir().unwrap();
    let endpoints = cap_gdrive::Endpoints::local("http://127.0.0.1:9");
    assert!(matches!(
        account::AccountTokens::new(dir.path().to_path_buf(), endpoints.clone()),
        Err(DriveError::NotConfigured)
    ));
    seed_client(dir.path(), "drive-id");
    let tokens = account::AccountTokens::new(dir.path().to_path_buf(), endpoints).unwrap();
    assert_eq!(
        tokens.access_token(false).await,
        Err(DriveError::NotConnected)
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn disconnect_revokes_once_unless_the_client_is_calendars() {
    let fake = cap_gdrive::fake::FakeGoogle::start();
    let dir = tempfile::tempdir().unwrap();
    seed_client(dir.path(), "drive-id");
    seed_account(dir.path(), &fake, "refresh-1");
    account::save_folder(
        dir.path(),
        &StoredFolder {
            name: "Cap".into(),
            id: Some("f1".into()),
        },
    )
    .unwrap();
    account::cache_access(dir.path(), "access", Some(3600));
    account::disconnect_with(dir.path(), &fake.endpoints(), Some("calendar-id"))
        .await
        .unwrap();
    assert_eq!(fake.revoked(), vec!["refresh-1".to_string()]);
    let file = account::load(dir.path());
    assert!(file.account.is_none());
    assert!(file.folder.id.is_none());
    assert_eq!(file.client.unwrap().client_id, "drive-id");
    assert_eq!(account::cached_access(dir.path()), None);
    assert_eq!(
        account::status(dir.path()),
        account::DriveStatus::Disconnected
    );

    seed_account(dir.path(), &fake, "refresh-2");
    account::disconnect_with(dir.path(), &fake.endpoints(), Some("drive-id"))
        .await
        .unwrap();
    assert_eq!(fake.revoked(), vec!["refresh-1".to_string()]);
    assert!(account::load(dir.path()).account.is_none());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn drive_never_touches_calendar_files() {
    use crate::meetings::accounts;
    use cap_gdrive::TokenSource;
    let fake = cap_gdrive::fake::FakeGoogle::start();
    let root = tempfile::tempdir().unwrap();
    let meetings = root.path().join("meetings");
    let calendar_id = "google:drive-isolation@example.com";
    accounts::store_refresh_token(&meetings, calendar_id, "calendar-refresh").unwrap();
    accounts::cache_calendar_access(calendar_id, "calendar-access");
    let calendar_file = meetings.join("calendar-accounts.json");
    let calendar_bytes = std::fs::read(&calendar_file).unwrap();
    let calendar_mode = crate::meetings::persist::mode(&calendar_file);
    let dir = root.path().join(account::DIR);
    seed_client(&dir, "shared-client");

    let mut revocable = Vec::new();
    for (code, refresh, calendar_client) in [
        ("c1", "refresh-1", Some("shared-client")),
        ("c2", "refresh-2", None),
    ] {
        fake.issue_code(code, refresh, DRIVE);
        let (_, status) = connect(&dir, &fake, code).await;
        assert!(matches!(status, Ok(account::DriveStatus::Connected { .. })));
        let tokens = account::AccountTokens::new(dir.clone(), fake.endpoints()).unwrap();
        tokens.access_token(true).await.unwrap();
        tokens.access_token(true).await.unwrap();
        if calendar_client.is_none() {
            revocable.push(account::load(&dir).account.unwrap().refresh_token);
        }
        account::disconnect_with(&dir, &fake.endpoints(), calendar_client)
            .await
            .unwrap();
    }
    fake.issue_code("c3", "refresh-3", DRIVE);
    let (_, status) = connect(&dir, &fake, "c3").await;
    assert!(status.is_ok());
    fake.push_fault(cap_gdrive::fake::Fault::TokenError {
        error: "invalid_grant",
    });
    let tokens = account::AccountTokens::new(dir.clone(), fake.endpoints()).unwrap();
    assert_eq!(
        tokens.access_token(true).await,
        Err(DriveError::SignInAgain)
    );
    assert!(account::load(&dir).account.is_none());

    assert_eq!(std::fs::read(&calendar_file).unwrap(), calendar_bytes);
    assert_eq!(
        crate::meetings::persist::mode(&calendar_file),
        calendar_mode
    );
    let in_meetings: Vec<_> = std::fs::read_dir(&meetings)
        .unwrap()
        .map(|entry| entry.unwrap().file_name())
        .collect();
    assert_eq!(
        in_meetings,
        vec![std::ffi::OsString::from("calendar-accounts.json")]
    );
    assert_eq!(
        accounts::cached_calendar_access(calendar_id).as_deref(),
        Some("calendar-access")
    );
    assert_eq!(fake.revoked(), revocable);
    assert!(
        fake.requests()
            .iter()
            .all(|r| !String::from_utf8_lossy(&r.body).contains("calendar-")
                && !r.target.contains("calendar-")),
        "a Calendar token reached Google through Drive"
    );
    assert_eq!(account::client(&dir).unwrap().client_id, "shared-client");
}

fn recording_meta(project: &std::path::Path) -> cap_project::RecordingMeta {
    cap_project::RecordingMeta {
        platform: None,
        project_path: project.to_path_buf(),
        pretty_name: "Demo".into(),
        sharing: None,
        inner: cap_project::RecordingMetaInner::Instant(
            cap_project::InstantRecordingMeta::Complete {
                fps: 30,
                sample_rate: None,
            },
        ),
        upload: None,
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn share_recording_writes_the_drive_link_and_keeps_the_file() {
    let fake = cap_gdrive::fake::FakeGoogle::start();
    let root = tempfile::tempdir().unwrap();
    let dir = root.path().join(account::DIR);
    seed_client(&dir, "drive-id");
    seed_account(&dir, &fake, "refresh-1");
    let project = root.path().join("Demo.cap");
    std::fs::create_dir_all(project.join("content")).unwrap();
    recording_meta(&project).save_for_project().unwrap();
    let source = project.join("content/output.mp4");
    let bytes: Vec<u8> = (0..300_000u32).map(|i| (i % 251) as u8).collect();
    std::fs::write(&source, &bytes).unwrap();
    let before = cap_project::RecordingMeta::load_for_project(&project).unwrap();
    let fractions = Arc::new(std::sync::Mutex::new(Vec::new()));
    let share = share_recording_in(
        &dir,
        &fake.endpoints(),
        ShareRequest {
            project_dir: project.clone(),
            file: source.clone(),
            title: "Demo".into(),
            progress: Arc::new({
                let fractions = fractions.clone();
                move |f| fractions.lock().unwrap().push(f)
            }),
            cancel: Arc::new(AtomicBool::new(false)),
        },
    )
    .await
    .unwrap();
    let meta = cap_project::RecordingMeta::load_for_project(&project).unwrap();
    let sharing = meta.sharing.as_ref().unwrap();
    assert_eq!(sharing.id, format!("gdrive:{}", share.file_id));
    assert_eq!(sharing.link, share.web_view_link);
    assert!(sharing.link.contains("resourcekey="), "{}", sharing.link);
    assert!(sharing.content_hash.is_none());
    assert_eq!(
        serde_json::to_value(&meta.inner).unwrap(),
        serde_json::to_value(&before.inner).unwrap()
    );
    assert!(meta.upload.is_none());
    assert_eq!(std::fs::read(&source).unwrap(), bytes);
    let uploaded = fake
        .files()
        .into_iter()
        .find(|f| f.id == share.file_id)
        .unwrap();
    assert_eq!(uploaded.name, "Demo.mp4");
    assert_eq!(uploaded.bytes, bytes);
    assert_eq!(
        account::load(&dir).folder.id.as_deref(),
        Some(share.folder_id.as_str())
    );
    assert!(!fractions.lock().unwrap().is_empty());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn share_recording_needs_a_connected_account() {
    let root = tempfile::tempdir().unwrap();
    let dir = root.path().join(account::DIR);
    let project = root.path().join("Demo.cap");
    let request = || ShareRequest {
        project_dir: project.clone(),
        file: project.join("content/output.mp4"),
        title: "Demo".into(),
        progress: Arc::new(|_| {}),
        cancel: Arc::new(AtomicBool::new(false)),
    };
    let endpoints = cap_gdrive::Endpoints::local("http://127.0.0.1:9");
    assert_eq!(
        share_recording_in(&dir, &endpoints, request()).await,
        Err(DriveError::NotConfigured)
    );
    seed_client(&dir, "drive-id");
    assert_eq!(
        share_recording_in(&dir, &endpoints, request()).await,
        Err(DriveError::NotConnected)
    );
}
