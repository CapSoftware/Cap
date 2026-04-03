use cap_upload::{AuthConfig, CapClient};

fn skip_unless_integration() -> Option<AuthConfig> {
    let api_key = std::env::var("CAP_API_KEY").ok()?;
    let server_url =
        std::env::var("CAP_SERVER_URL").unwrap_or_else(|_| "https://cap.so".to_string());
    Some(AuthConfig {
        server_url,
        api_key,
    })
}

#[tokio::test]
async fn create_and_delete_video() {
    let Some(auth) = skip_unless_integration() else {
        eprintln!("Skipping integration test: CAP_API_KEY not set");
        return;
    };

    let client = CapClient::new(auth).unwrap();

    let video = client.create_video(None).await.unwrap();
    assert!(!video.id.is_empty());

    client.delete_video(&video.id).await.unwrap();
}

#[tokio::test]
async fn list_organizations() {
    let Some(auth) = skip_unless_integration() else {
        eprintln!("Skipping integration test: CAP_API_KEY not set");
        return;
    };

    let client = CapClient::new(auth).unwrap();
    let orgs = client.list_organizations().await.unwrap();
    assert!(!orgs.is_empty(), "Expected at least one organization");
}

#[tokio::test]
async fn get_s3_config() {
    let Some(auth) = skip_unless_integration() else {
        eprintln!("Skipping integration test: CAP_API_KEY not set");
        return;
    };

    let client = CapClient::new(auth).unwrap();
    let config = client.get_s3_config().await.unwrap();
    assert!(!config.provider.is_empty());
}

#[tokio::test]
async fn list_videos() {
    let Some(auth) = skip_unless_integration() else {
        eprintln!("Skipping integration test: CAP_API_KEY not set");
        return;
    };

    let client = CapClient::new(auth).unwrap();
    let resp = client.list_videos(None, 5, 0).await.unwrap();
    assert!(resp.total >= 0);
}

#[tokio::test]
async fn get_video_info() {
    let Some(auth) = skip_unless_integration() else {
        eprintln!("Skipping integration test: CAP_API_KEY not set");
        return;
    };

    let client = CapClient::new(auth).unwrap();
    let video = client.create_video(None).await.unwrap();

    let info = client.get_video_info(&video.id).await.unwrap();
    assert_eq!(info.id, video.id);
    assert!(!info.has_password);

    client.delete_video(&video.id).await.unwrap();
}

#[tokio::test]
async fn set_and_remove_password() {
    let Some(auth) = skip_unless_integration() else {
        eprintln!("Skipping integration test: CAP_API_KEY not set");
        return;
    };

    let client = CapClient::new(auth).unwrap();
    let video = client.create_video(None).await.unwrap();

    client
        .set_video_password(&video.id, Some("secret123"))
        .await
        .unwrap();

    let info = client.get_video_info(&video.id).await.unwrap();
    assert!(info.has_password);

    client.set_video_password(&video.id, None).await.unwrap();

    let info = client.get_video_info(&video.id).await.unwrap();
    assert!(!info.has_password);

    client.delete_video(&video.id).await.unwrap();
}

#[tokio::test]
async fn get_transcript_not_ready() {
    let Some(auth) = skip_unless_integration() else {
        eprintln!("Skipping integration test: CAP_API_KEY not set");
        return;
    };

    let client = CapClient::new(auth).unwrap();
    let video = client.create_video(None).await.unwrap();

    let result = client.get_transcript(&video.id).await;
    assert!(result.is_err());

    client.delete_video(&video.id).await.unwrap();
}
