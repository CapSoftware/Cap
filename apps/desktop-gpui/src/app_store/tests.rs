use super::*;

const GOLDEN: &str =
    include_str!("../../../../packages/app-store/test/fixtures/catalog.golden.json");

fn golden() -> Catalog {
    Catalog::parse(&serde_json::from_str(GOLDEN).expect("golden catalog is JSON"))
        .expect("golden catalog parses")
}

#[test]
fn parses_the_catalog_the_web_app_builds() {
    let catalog = golden();
    assert_eq!(catalog.apps.len(), 2);

    let content = catalog.app("fixture-content").expect("content app");
    assert!(content.has_content());
    assert!(content.runs_on_desktop());
    assert!(!content.needs_web_setup());
    assert_eq!(content.backgrounds.len(), 3);
    assert!(matches!(
        content.backgrounds[0],
        CatalogBackground::Image { ref image, .. } if image.is_valid_hash() && image.extension() == "jpg"
    ));
    assert!(matches!(
        content.backgrounds[1],
        CatalogBackground::Gradient { angle: 135, .. }
    ));
    assert!(matches!(
        content.backgrounds[2],
        CatalogBackground::Color { .. }
    ));
    assert_eq!(content.caption_styles[0].highlight_style, "pill");
    assert_eq!(content.color_looks[0].values.temperature, Some(0.3));
    assert_eq!(content.color_looks[0].values.split_tone, Some(-0.1));
    assert_eq!(content.color_looks[0].values.exposure, None);

    let connection = catalog.app("fixture-connection").expect("connection app");
    assert!(connection.needs_web_setup());
    let details = connection.connection.as_ref().expect("connection");
    assert_eq!(details.actions[0].id, "send");
    assert_eq!(details.settings.len(), 3);
    assert!(details.settings[0].required);
}

#[test]
fn skips_apps_it_cannot_read_and_blocked_apps() {
    let mut value: Value = serde_json::from_str(GOLDEN).unwrap();
    let apps = value["apps"].as_array_mut().unwrap();
    let mut future = apps[0].clone();
    future["id"] = json!("from-the-future");
    future["apiVersion"] = json!(99);
    apps.push(future);
    let mut broken = apps[0].clone();
    broken["id"] = json!("broken");
    broken["icon"] = json!("not an asset");
    apps.push(broken);
    value["blocked"] = json!([{ "id": "fixture-connection", "reason": "test" }]);

    let catalog = Catalog::parse(&value).unwrap();
    let ids: Vec<&str> = catalog.apps.iter().map(|app| app.id.as_str()).collect();
    assert_eq!(ids, ["fixture-content"]);
    assert_eq!(catalog.blocked, ["fixture-connection"]);
}

#[test]
fn rejects_unknown_catalog_versions() {
    assert!(Catalog::parse(&json!({ "catalogVersion": 2, "revision": "x", "apps": [] })).is_none());
    assert!(Catalog::parse(&json!([])).is_none());
}

#[test]
fn reads_cap_ids_from_share_links() {
    assert_eq!(
        cap_id_from_share_url("https://cap.so/s/abc123def456ghi").as_deref(),
        Some("abc123def456ghi")
    );
    assert_eq!(
        cap_id_from_share_url("https://team.example.com/s/abc123?t=10").as_deref(),
        Some("abc123")
    );
    assert_eq!(cap_id_from_share_url("https://cap.so/dashboard"), None);
    assert_eq!(cap_id_from_share_url("https://cap.so/s/"), None);
    assert_eq!(cap_id_from_share_url("https://cap.so/s/..%2f"), None);
}

#[test]
fn only_stores_assets_that_match_their_hash() {
    let dir = std::env::temp_dir().join(format!("cap-app-store-test-{}", std::process::id()));
    let target = dir.join("asset.png");
    let bytes = b"hello world";
    let expected = sha256_hex(bytes);
    assert_eq!(
        expected,
        "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9"
    );
    assert!(store_verified_asset(&target, b"tampered", &expected).is_err());
    assert!(!target.exists());
    store_verified_asset(&target, bytes, &expected).unwrap();
    assert_eq!(std::fs::read(&target).unwrap(), bytes);
    assert!(!target.with_extension("partial").exists());
    std::fs::remove_dir_all(dir).ok();
}

#[test]
fn asset_paths_only_come_from_valid_hashes() {
    let mut asset = CatalogAsset {
        url: "/app-store/x/abc.jpg".into(),
        sha256: "f".repeat(64),
        bytes: 1,
        width: 1,
        height: 1,
    };
    let path = asset_path(&asset).unwrap();
    assert!(path.ends_with(format!("{}.jpg", "f".repeat(64))));
    asset.sha256 = "../../etc/passwd".into();
    assert!(asset_path(&asset).is_none());
    asset.sha256 = "f".repeat(64);
    asset.url = "/app-store/x/abc.exe".into();
    assert!(
        asset_path(&asset)
            .unwrap()
            .to_string_lossy()
            .ends_with(".bin")
    );
}

#[test]
fn action_results_only_open_https() {
    let open: ActionResult =
        serde_json::from_value(json!({ "type": "open", "url": "https://example.com/x" })).unwrap();
    assert_eq!(open.open_url(), Some("https://example.com/x"));
    let unsafe_open: ActionResult =
        serde_json::from_value(json!({ "type": "open", "url": "file:///etc/passwd" })).unwrap();
    assert_eq!(unsafe_open.open_url(), None);
    let toast: ActionResult =
        serde_json::from_value(json!({ "type": "toast", "message": "Posted" })).unwrap();
    assert_eq!(toast.message(), Some("Posted"));
    assert!(serde_json::from_value::<ActionResult>(json!({ "type": "html" })).is_err());
}

#[test]
fn contributions_come_only_from_installed_apps() {
    let catalog = golden();
    let mut store = AppStore {
        catalog: Some(Arc::new(catalog)),
        ..Default::default()
    };
    assert!(store.backgrounds().is_empty());
    assert!(store.caption_styles().is_empty());
    assert!(!store.has_cap_actions_in(&[]));

    store.local_installs.insert("fixture-content".into());
    let backgrounds = store.backgrounds();
    assert_eq!(
        backgrounds
            .iter()
            .map(|(_, background)| background.id())
            .collect::<Vec<_>>(),
        ["sunset", "ink"],
        "the image waits until its file is downloaded and verified"
    );
    assert_eq!(store.caption_styles().len(), 1);
    assert_eq!(store.color_looks().len(), 1);

    store.installations.push(Installation {
        id: "inst_1".into(),
        app_id: "fixture-connection".into(),
        scope: "user".into(),
        organization_name: None,
        status: "active".into(),
        needs_review: false,
        can_manage: true,
    });
    assert!(store.installations_for(Some("account-a")).is_empty());
    store.account = Some("account-a".into());
    assert_eq!(store.installations_for(Some("account-a")).len(), 1);
    assert!(
        store.installations_for(Some("account-b")).is_empty(),
        "installs never leak to another account"
    );
    assert!(store.installations_for(None).is_empty());
    assert!(store.has_cap_actions_in(store.installations_for(Some("account-a"))));

    store.installations[0].status = "disabled".into();
    assert!(!store.has_cap_actions_in(store.installations_for(Some("account-a"))));
}

#[test]
fn installation_cache_round_trips_for_its_account() {
    let installation = Installation {
        id: "inst_1".into(),
        app_id: "fixture-content".into(),
        scope: "organization".into(),
        organization_name: Some("Acme".into()),
        status: "active".into(),
        needs_review: false,
        can_manage: false,
    };
    let cached = CachedInstallations {
        account: "account-a".into(),
        installations: vec![installation.clone()],
    };
    let parsed: CachedInstallations =
        serde_json::from_slice(&serde_json::to_vec(&cached).unwrap()).unwrap();
    assert_eq!(parsed.installations, vec![installation]);
    assert_eq!(parsed.account, "account-a");
}
