use cap_upload::{AuthConfig, CapClient};
use clap::{Args, Subcommand};

#[derive(Args)]
pub struct OrgsArgs {
    #[command(subcommand)]
    command: OrgsCommands,
}

#[derive(Subcommand)]
enum OrgsCommands {
    List,
}

impl OrgsArgs {
    pub async fn run(self, json: bool) -> Result<(), String> {
        match self.command {
            OrgsCommands::List => list(json).await,
        }
    }
}

async fn list(json: bool) -> Result<(), String> {
    let auth = AuthConfig::resolve().map_err(|e| e.to_string())?;
    let client = CapClient::new(auth).map_err(|e| e.to_string())?;

    let orgs = client
        .list_organizations()
        .await
        .map_err(|e| e.to_string())?;

    if json {
        println!("{}", serde_json::to_string_pretty(&orgs).unwrap());
    } else {
        if orgs.is_empty() {
            eprintln!("No organizations found.");
            return Ok(());
        }
        for org in &orgs {
            println!("{}\t{}", org.id, org.name);
        }
    }

    Ok(())
}
