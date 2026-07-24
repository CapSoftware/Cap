use std::path::PathBuf;

use clap::{ArgGroup, Args, Subcommand};
use reqwest::Method;
use serde_json::{Map, Value, json};

use crate::{
    OutputFormat, agent_client, caps::AgentClient, confirmation, credentials, resolve_format,
};

#[derive(Args)]
pub struct AccountArgs {
    #[command(subcommand)]
    command: AccountCommands,
}

#[derive(Subcommand)]
enum AccountCommands {
    Get(FormatArgs),
    Update(AccountUpdateArgs),
    Image(AccountImageArgs),
    Referrals(AccountReferralsArgs),
    SignOutAll(AccountSignOutAllArgs),
}

#[derive(Args)]
struct FormatArgs {
    #[arg(long, value_enum, default_value_t = OutputFormat::Text)]
    format: OutputFormat,
}

#[derive(Args)]
#[command(group(ArgGroup::new("name_action").args(["name", "clear_name"])))]
#[command(group(ArgGroup::new("last_name_action").args(["last_name", "clear_last_name"])))]
#[command(group(ArgGroup::new("organization_action").args(["default_organization", "clear_default_organization"])))]
struct AccountUpdateArgs {
    #[arg(long)]
    name: Option<String>,
    #[arg(long)]
    clear_name: bool,
    #[arg(long)]
    last_name: Option<String>,
    #[arg(long)]
    clear_last_name: bool,
    #[arg(long)]
    default_organization: Option<String>,
    #[arg(long)]
    clear_default_organization: bool,
    #[arg(long)]
    yes: bool,
    #[arg(long, value_enum, default_value_t = OutputFormat::Text)]
    format: OutputFormat,
}

#[derive(Args)]
struct AccountImageArgs {
    #[command(subcommand)]
    command: AccountImageCommands,
}

#[derive(Subcommand)]
enum AccountImageCommands {
    Set(AccountImageSetArgs),
    Remove(AccountImageRemoveArgs),
}

#[derive(Args)]
struct AccountImageSetArgs {
    image: PathBuf,
    #[arg(long)]
    yes: bool,
    #[arg(long, value_enum, default_value_t = OutputFormat::Text)]
    format: OutputFormat,
}

#[derive(Args)]
struct AccountImageRemoveArgs {
    #[arg(long)]
    yes: bool,
    #[arg(long, value_enum, default_value_t = OutputFormat::Text)]
    format: OutputFormat,
}

#[derive(Args)]
struct AccountSignOutAllArgs {
    #[arg(long)]
    yes: bool,
    #[arg(long, value_enum, default_value_t = OutputFormat::Text)]
    format: OutputFormat,
}

#[derive(Args)]
struct AccountReferralsArgs {
    #[arg(long)]
    no_open: bool,
    #[arg(long)]
    yes: bool,
    #[arg(long, value_enum, default_value_t = OutputFormat::Text)]
    format: OutputFormat,
}

impl AccountArgs {
    pub async fn run(self, global_json: bool) -> Result<(), String> {
        match self.command {
            AccountCommands::Get(args) => agent_client::read("/me", global_json, args.format).await,
            AccountCommands::Update(args) => {
                let mut body = Map::new();
                if let Some(name) = args.name {
                    body.insert("name".to_string(), Value::String(name));
                } else if args.clear_name {
                    body.insert("name".to_string(), Value::Null);
                }
                if let Some(last_name) = args.last_name {
                    body.insert("lastName".to_string(), Value::String(last_name));
                } else if args.clear_last_name {
                    body.insert("lastName".to_string(), Value::Null);
                }
                if let Some(organization_id) = args.default_organization {
                    body.insert(
                        "defaultOrganizationId".to_string(),
                        Value::String(organization_id),
                    );
                } else if args.clear_default_organization {
                    body.insert("defaultOrganizationId".to_string(), Value::Null);
                }
                if body.is_empty() {
                    return Err("Provide at least one account update".to_string());
                }
                confirmation::require(args.yes, "Update the Cap account")?;
                agent_client::mutate(Method::PATCH, "/me", &json!(body), global_json, args.format)
                    .await
            }
            AccountCommands::Image(args) => match args.command {
                AccountImageCommands::Set(args) => {
                    confirmation::require(args.yes, "Update the Cap profile image")?;
                    let body = agent_client::image_payload(&args.image)?;
                    agent_client::mutate_confirmed(
                        Method::PUT,
                        "/me/image",
                        &body,
                        global_json,
                        args.format,
                    )
                    .await
                }
                AccountImageCommands::Remove(args) => {
                    confirmation::require(args.yes, "Remove the Cap profile image")?;
                    agent_client::mutate_confirmed(
                        Method::DELETE,
                        "/me/image",
                        &json!({}),
                        global_json,
                        args.format,
                    )
                    .await
                }
            },
            AccountCommands::Referrals(args) => {
                confirmation::require(args.yes, "Open the Cap referral portal")?;
                let client = AgentClient::from_credentials().map_err(|error| error.to_string())?;
                let value = client
                    .mutate_json_confirmed(Method::POST, "/me/referrals", &json!({}))
                    .await
                    .map_err(|error| error.to_string())?;
                agent_client::open_browser_action(&value, args.no_open);
                agent_client::print_value(&value, resolve_format(global_json, args.format))
            }
            AccountCommands::SignOutAll(args) => {
                confirmation::require(args.yes, "Sign out every Cap device and agent")?;
                let client = AgentClient::from_credentials().map_err(|error| error.to_string())?;
                let value = client
                    .mutate_json_confirmed(Method::POST, "/me/sign-out-all", &json!({}))
                    .await
                    .map_err(|error| error.to_string())?;
                credentials::delete_agent()?;
                agent_client::print_value(&value, resolve_format(global_json, args.format))
            }
        }
    }
}
