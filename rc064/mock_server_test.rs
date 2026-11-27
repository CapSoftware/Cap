
#[ignore]
#[tokio::test(flavor = "multi_thread")]
async fn rc064_mock_server() {
    let out = PathBuf::from(std::env::var("RC064_MOCK_DIR").expect("set RC064_MOCK_DIR"));
    std::fs::create_dir_all(&out).unwrap();
    let mock = MockCap::start(Vec::new()).await;
    std::fs::write(
        out.join("server.json"),
        serde_json::to_vec(&json!({ "url": mock.url, "api_key": API_KEY, "owner": OWNER }))
            .unwrap(),
    )
    .unwrap();
    let stop = out.join("stop");
    let deadline = Instant::now() + Duration::from_secs(1800);
    while !stop.exists() && Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    let objects = out.join("objects");
    let mut keys = Vec::new();
    for (key, bytes) in mock.rc064_objects() {
        let safe: String = key
            .chars()
            .map(|c| if c.is_ascii_alphanumeric() || "._/-".contains(c) { c } else { '_' })
            .collect();
        let path = objects.join(safe.trim_start_matches('/'));
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, &bytes).unwrap();
        keys.push(json!({ "key": key, "bytes": bytes.len() }));
    }
    std::fs::write(
        out.join("summary.json"),
        serde_json::to_vec_pretty(&json!({
            "created": mock.created(),
            "confirmations": mock.confirmations(),
            "deleted": mock.deleted(),
            "objects": keys,
        }))
        .unwrap(),
    )
    .unwrap();
    std::fs::write(out.join("done"), b"1").unwrap();
}
