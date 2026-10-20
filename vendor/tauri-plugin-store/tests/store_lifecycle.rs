use std::sync::Arc;
use tauri::test::{mock_builder, mock_context, noop_assets};
use tauri_plugin_store::StoreExt;

#[test]
fn cached_store_returns_an_error_after_resource_cleanup() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("store");
    let app = mock_builder()
        .plugin(tauri_plugin_store::Builder::new().build())
        .build(mock_context(noop_assets()))
        .unwrap();
    let store = app
        .store_builder(&path)
        .disable_auto_save()
        .build()
        .unwrap();
    store.set(
        "general_settings",
        serde_json::json!({ "recordingsPath": "example" }),
    );
    store.save().unwrap();
    let saved = std::fs::read(&path).unwrap();
    assert!(Arc::ptr_eq(&store, &app.store(&path).unwrap()));

    app.cleanup_before_exit();

    for _ in 0..2 {
        assert!(matches!(
            app.store(&path),
            Err(tauri_plugin_store::Error::Tauri(
                tauri::Error::BadResourceId(_)
            ))
        ));
    }
    assert_eq!(std::fs::read(&path).unwrap(), saved);
}

#[test]
fn closing_a_store_normally_allows_it_to_be_loaded_again() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("store");
    let app = mock_builder()
        .plugin(tauri_plugin_store::Builder::new().build())
        .build(mock_context(noop_assets()))
        .unwrap();
    let store = app
        .store_builder(&path)
        .disable_auto_save()
        .build()
        .unwrap();
    store.set(
        "general_settings",
        serde_json::json!({ "enableTelemetry": false }),
    );
    store.save().unwrap();
    store.close_resource();
    let reopened = app.store(&path).unwrap();
    assert!(!Arc::ptr_eq(&store, &reopened));
    assert_eq!(
        store.get("general_settings"),
        reopened.get("general_settings")
    );
}
