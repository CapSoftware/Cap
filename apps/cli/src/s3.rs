use cap_upload::{AuthConfig, CapClient, S3ConfigInput};
use clap::{Args, Subcommand};

#[derive(Args)]
pub struct S3Args {
    #[command(subcommand)]
    command: S3Commands,
}

#[derive(Subcommand)]
enum S3Commands {
    Config(S3BucketArgs),
    Test(S3BucketArgs),
    Get,
    Delete,
}

#[derive(Args)]
struct S3BucketArgs {
    #[arg(long)]
    provider: String,
    #[arg(long)]
    bucket: String,
    #[arg(long)]
    region: String,
    #[arg(long)]
    endpoint: String,
    #[arg(long)]
    access_key_id: String,
    #[arg(long)]
    secret_access_key: String,
}

impl S3BucketArgs {
    fn build_s3_input(&self) -> S3ConfigInput {
        S3ConfigInput {
            provider: self.provider.clone(),
            access_key_id: self.access_key_id.clone(),
            secret_access_key: self.secret_access_key.clone(),
            endpoint: self.endpoint.clone(),
            bucket_name: self.bucket.clone(),
            region: self.region.clone(),
        }
    }
}

impl S3Args {
    pub async fn run(self, json: bool) -> Result<(), String> {
        match self.command {
            S3Commands::Config(args) => set_config(args, json).await,
            S3Commands::Test(args) => test_config(args, json).await,
            S3Commands::Get => get_config(json).await,
            S3Commands::Delete => delete_config(json).await,
        }
    }
}

async fn set_config(args: S3BucketArgs, json: bool) -> Result<(), String> {
    let auth = AuthConfig::resolve().map_err(|e| e.to_string())?;
    let client = CapClient::new(auth).map_err(|e| e.to_string())?;

    let input = args.build_s3_input();
    client
        .set_s3_config(&input)
        .await
        .map_err(|e| e.to_string())?;

    if json {
        println!("{}", serde_json::json!({"status": "saved"}));
    } else {
        eprintln!("S3 configuration saved.");
    }
    Ok(())
}

async fn test_config(args: S3BucketArgs, json: bool) -> Result<(), String> {
    let auth = AuthConfig::resolve().map_err(|e| e.to_string())?;
    let client = CapClient::new(auth).map_err(|e| e.to_string())?;

    let input = args.build_s3_input();
    client
        .test_s3_config(&input)
        .await
        .map_err(|e| e.to_string())?;

    if json {
        println!("{}", serde_json::json!({"status": "ok"}));
    } else {
        eprintln!("S3 connectivity test passed.");
    }
    Ok(())
}

async fn get_config(json: bool) -> Result<(), String> {
    let auth = AuthConfig::resolve().map_err(|e| e.to_string())?;
    let client = CapClient::new(auth).map_err(|e| e.to_string())?;

    let config = client.get_s3_config().await.map_err(|e| e.to_string())?;

    if json {
        println!(
            "{}",
            serde_json::json!({
                "provider": config.provider,
                "bucket_name": config.bucket_name,
                "region": config.region,
                "endpoint": config.endpoint,
                "access_key_id": config.access_key_id,
            })
        );
    } else {
        println!("Provider:   {}", config.provider);
        println!("Bucket:     {}", config.bucket_name);
        println!("Region:     {}", config.region);
        println!("Endpoint:   {}", config.endpoint);
        println!("Access Key: {}", config.access_key_id);
    }
    Ok(())
}

async fn delete_config(json: bool) -> Result<(), String> {
    let auth = AuthConfig::resolve().map_err(|e| e.to_string())?;
    let client = CapClient::new(auth).map_err(|e| e.to_string())?;

    client.delete_s3_config().await.map_err(|e| e.to_string())?;

    if json {
        println!("{}", serde_json::json!({"status": "deleted"}));
    } else {
        eprintln!("S3 configuration deleted.");
    }
    Ok(())
}
