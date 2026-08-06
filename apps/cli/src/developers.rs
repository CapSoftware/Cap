use clap::{Args, Subcommand, ValueEnum};
use reqwest::Method;
use serde_json::{Map, Value, json};

use crate::{
    OutputFormat, agent_client,
    caps::{AgentClient, opaque_id},
    confirmation, resolve_format,
};

#[derive(Args)]
pub struct DevelopersArgs {
    #[command(subcommand)]
    command: DeveloperCommands,
}

#[derive(Subcommand)]
enum DeveloperCommands {
    List(FormatArgs),
    Get(DeveloperGetArgs),
    Create(DeveloperCreateArgs),
    Update(DeveloperUpdateArgs),
    Delete(DeveloperDeleteArgs),
    Domains(DeveloperDomainsArgs),
    Keys(DeveloperKeysArgs),
    AutoTopUp(DeveloperAutoTopUpArgs),
    Credits(DeveloperCreditsArgs),
    Videos(DeveloperVideosArgs),
    Transactions(DeveloperTransactionsArgs),
}

#[derive(Args)]
struct FormatArgs {
    #[arg(long, value_enum, default_value_t = OutputFormat::Text)]
    format: OutputFormat,
}

#[derive(Args)]
struct DeveloperGetArgs {
    app: String,
    #[arg(long, value_enum, default_value_t = OutputFormat::Text)]
    format: OutputFormat,
}

#[derive(Clone, Copy, ValueEnum)]
enum DeveloperEnvironment {
    Development,
    Production,
}

impl DeveloperEnvironment {
    const fn as_str(self) -> &'static str {
        match self {
            Self::Development => "development",
            Self::Production => "production",
        }
    }
}

#[derive(Args)]
struct DeveloperCreateArgs {
    name: String,
    #[arg(long, value_enum, default_value_t = DeveloperEnvironment::Development)]
    environment: DeveloperEnvironment,
    #[arg(long)]
    yes: bool,
    #[arg(long, value_enum, default_value_t = OutputFormat::Text)]
    format: OutputFormat,
}

#[derive(Args)]
struct DeveloperUpdateArgs {
    app: String,
    #[arg(long)]
    name: Option<String>,
    #[arg(long, value_enum)]
    environment: Option<DeveloperEnvironment>,
    #[arg(long)]
    logo_url: Option<String>,
    #[arg(long)]
    clear_logo: bool,
    #[arg(long)]
    yes: bool,
    #[arg(long, value_enum, default_value_t = OutputFormat::Text)]
    format: OutputFormat,
}

#[derive(Args)]
struct DeveloperDeleteArgs {
    app: String,
    #[arg(long)]
    yes: bool,
    #[arg(long, value_enum, default_value_t = OutputFormat::Text)]
    format: OutputFormat,
}

#[derive(Args)]
struct DeveloperDomainsArgs {
    #[command(subcommand)]
    command: DeveloperDomainCommands,
}

#[derive(Subcommand)]
enum DeveloperDomainCommands {
    Add(DeveloperDomainAddArgs),
    Remove(DeveloperDomainRemoveArgs),
}

#[derive(Args)]
struct DeveloperDomainAddArgs {
    app: String,
    domain: String,
    #[arg(long)]
    yes: bool,
    #[arg(long, value_enum, default_value_t = OutputFormat::Text)]
    format: OutputFormat,
}

#[derive(Args)]
struct DeveloperDomainRemoveArgs {
    app: String,
    domain_id: String,
    #[arg(long)]
    yes: bool,
    #[arg(long, value_enum, default_value_t = OutputFormat::Text)]
    format: OutputFormat,
}

#[derive(Args)]
struct DeveloperKeysArgs {
    #[command(subcommand)]
    command: DeveloperKeyCommands,
}

#[derive(Subcommand)]
enum DeveloperKeyCommands {
    Rotate(DeveloperKeyRotateArgs),
}

#[derive(Args)]
struct DeveloperKeyRotateArgs {
    app: String,
    #[arg(long)]
    yes: bool,
    #[arg(long, value_enum, default_value_t = OutputFormat::Text)]
    format: OutputFormat,
}

#[derive(Args)]
struct DeveloperAutoTopUpArgs {
    app: String,
    #[arg(long, conflicts_with = "disable")]
    enable: bool,
    #[arg(long, conflicts_with = "enable")]
    disable: bool,
    #[arg(long)]
    threshold_micro_credits: Option<u64>,
    #[arg(long)]
    amount_cents: Option<u32>,
    #[arg(long)]
    yes: bool,
    #[arg(long, value_enum, default_value_t = OutputFormat::Text)]
    format: OutputFormat,
}

#[derive(Args)]
struct DeveloperCreditsArgs {
    #[command(subcommand)]
    command: DeveloperCreditCommands,
}

#[derive(Subcommand)]
enum DeveloperCreditCommands {
    Purchase(DeveloperCreditPurchaseArgs),
}

#[derive(Args)]
struct DeveloperCreditPurchaseArgs {
    app: String,
    #[arg(long)]
    amount_cents: u32,
    #[arg(long)]
    no_open: bool,
    #[arg(long)]
    yes: bool,
    #[arg(long, value_enum, default_value_t = OutputFormat::Text)]
    format: OutputFormat,
}

#[derive(Args)]
struct DeveloperVideosArgs {
    #[command(subcommand)]
    command: DeveloperVideoCommands,
}

#[derive(Subcommand)]
enum DeveloperVideoCommands {
    List(DeveloperVideoListArgs),
    Delete(DeveloperVideoDeleteArgs),
}

#[derive(Args)]
struct DeveloperVideoListArgs {
    app: String,
    #[arg(long)]
    user_id: Option<String>,
    #[arg(long)]
    cursor: Option<String>,
    #[arg(long, default_value_t = 50)]
    limit: u16,
    #[arg(long, value_enum, default_value_t = OutputFormat::Text)]
    format: OutputFormat,
}

#[derive(Args)]
struct DeveloperVideoDeleteArgs {
    app: String,
    video: String,
    #[arg(long)]
    yes: bool,
    #[arg(long, value_enum, default_value_t = OutputFormat::Text)]
    format: OutputFormat,
}

#[derive(Args)]
struct DeveloperTransactionsArgs {
    app: String,
    #[arg(long)]
    cursor: Option<String>,
    #[arg(long, default_value_t = 50)]
    limit: u16,
    #[arg(long, value_enum, default_value_t = OutputFormat::Text)]
    format: OutputFormat,
}

impl DevelopersArgs {
    pub async fn run(self, global_json: bool) -> Result<(), String> {
        match self.command {
            DeveloperCommands::List(args) => {
                agent_client::read("/developer/apps", global_json, args.format).await
            }
            DeveloperCommands::Get(args) => {
                let id =
                    opaque_id(&args.app, "Developer app ID").map_err(|error| error.to_string())?;
                agent_client::read(
                    &format!("/developer/apps/{id}/context"),
                    global_json,
                    args.format,
                )
                .await
            }
            DeveloperCommands::Create(args) => {
                confirmation::require(
                    args.yes,
                    "Create the developer app and reveal its API credentials",
                )?;
                agent_client::mutate_confirmed(
                    Method::POST,
                    "/developer/apps",
                    &json!({
                        "name": args.name,
                        "environment": args.environment.as_str(),
                    }),
                    global_json,
                    args.format,
                )
                .await
            }
            DeveloperCommands::Update(args) => {
                confirmation::require(args.yes, "Update the developer app")?;
                let id =
                    opaque_id(&args.app, "Developer app ID").map_err(|error| error.to_string())?;
                if args.logo_url.is_some() && args.clear_logo {
                    return Err("--logo-url and --clear-logo cannot be combined".to_string());
                }
                let mut body = Map::new();
                if let Some(name) = args.name {
                    body.insert("name".to_string(), Value::String(name));
                }
                if let Some(environment) = args.environment {
                    body.insert(
                        "environment".to_string(),
                        Value::String(environment.as_str().to_string()),
                    );
                }
                if let Some(logo_url) = args.logo_url {
                    body.insert("logoUrl".to_string(), Value::String(logo_url));
                } else if args.clear_logo {
                    body.insert("logoUrl".to_string(), Value::Null);
                }
                if body.is_empty() {
                    return Err("Provide at least one developer app update".to_string());
                }
                agent_client::mutate_confirmed(
                    Method::PATCH,
                    &format!("/developer/apps/{id}"),
                    &Value::Object(body),
                    global_json,
                    args.format,
                )
                .await
            }
            DeveloperCommands::Delete(args) => {
                confirmation::require(args.yes, "Delete the developer app and revoke its keys")?;
                let id =
                    opaque_id(&args.app, "Developer app ID").map_err(|error| error.to_string())?;
                agent_client::mutate_confirmed(
                    Method::DELETE,
                    &format!("/developer/apps/{id}"),
                    &json!({}),
                    global_json,
                    args.format,
                )
                .await
            }
            DeveloperCommands::Domains(args) => match args.command {
                DeveloperDomainCommands::Add(args) => {
                    confirmation::require(args.yes, "Add the developer app domain")?;
                    let id = opaque_id(&args.app, "Developer app ID")
                        .map_err(|error| error.to_string())?;
                    agent_client::mutate_confirmed(
                        Method::POST,
                        &format!("/developer/apps/{id}/domains"),
                        &json!({ "domain": args.domain }),
                        global_json,
                        args.format,
                    )
                    .await
                }
                DeveloperDomainCommands::Remove(args) => {
                    confirmation::require(args.yes, "Remove the developer app domain")?;
                    let id = opaque_id(&args.app, "Developer app ID")
                        .map_err(|error| error.to_string())?;
                    let domain_id = opaque_id(&args.domain_id, "Developer domain ID")
                        .map_err(|error| error.to_string())?;
                    agent_client::mutate_confirmed(
                        Method::DELETE,
                        &format!("/developer/apps/{id}/domains/{domain_id}"),
                        &json!({}),
                        global_json,
                        args.format,
                    )
                    .await
                }
            },
            DeveloperCommands::Keys(args) => match args.command {
                DeveloperKeyCommands::Rotate(args) => {
                    confirmation::require(
                        args.yes,
                        "Rotate and reveal the developer app API credentials",
                    )?;
                    let id = opaque_id(&args.app, "Developer app ID")
                        .map_err(|error| error.to_string())?;
                    agent_client::mutate_confirmed(
                        Method::POST,
                        &format!("/developer/apps/{id}/keys/rotate"),
                        &json!({}),
                        global_json,
                        args.format,
                    )
                    .await
                }
            },
            DeveloperCommands::AutoTopUp(args) => {
                confirmation::require(args.yes, "Change automatic developer credit purchases")?;
                if args.enable == args.disable {
                    return Err("Provide exactly one of --enable or --disable".to_string());
                }
                let id =
                    opaque_id(&args.app, "Developer app ID").map_err(|error| error.to_string())?;
                let mut body = Map::from_iter([("enabled".to_string(), Value::Bool(args.enable))]);
                if let Some(value) = args.threshold_micro_credits {
                    body.insert("thresholdMicroCredits".to_string(), Value::from(value));
                }
                if let Some(value) = args.amount_cents {
                    body.insert("amountCents".to_string(), Value::from(value));
                }
                agent_client::mutate_confirmed(
                    Method::PATCH,
                    &format!("/developer/apps/{id}/auto-top-up"),
                    &Value::Object(body),
                    global_json,
                    args.format,
                )
                .await
            }
            DeveloperCommands::Credits(args) => match args.command {
                DeveloperCreditCommands::Purchase(args) => {
                    confirmation::require(args.yes, "Create a developer credit purchase checkout")?;
                    let id = opaque_id(&args.app, "Developer app ID")
                        .map_err(|error| error.to_string())?;
                    let client =
                        AgentClient::from_credentials().map_err(|error| error.to_string())?;
                    let value = client
                        .mutate_json_confirmed(
                            Method::POST,
                            &format!("/developer/apps/{id}/credits/checkout"),
                            &json!({ "amountCents": args.amount_cents }),
                        )
                        .await
                        .map_err(|error| error.to_string())?;
                    agent_client::open_browser_action(&value, args.no_open);
                    agent_client::print_value(&value, resolve_format(global_json, args.format))
                }
            },
            DeveloperCommands::Videos(args) => match args.command {
                DeveloperVideoCommands::List(args) => {
                    if !(1..=100).contains(&args.limit) {
                        return Err("--limit must be between 1 and 100".to_string());
                    }
                    let id = opaque_id(&args.app, "Developer app ID")
                        .map_err(|error| error.to_string())?;
                    let query = agent_client::query(&[
                        ("userId", args.user_id),
                        ("cursor", args.cursor),
                        ("limit", Some(args.limit.to_string())),
                    ]);
                    agent_client::read(
                        &format!("/developer/apps/{id}/videos?{query}"),
                        global_json,
                        args.format,
                    )
                    .await
                }
                DeveloperVideoCommands::Delete(args) => {
                    confirmation::require(args.yes, "Delete the developer SDK video")?;
                    let id = opaque_id(&args.app, "Developer app ID")
                        .map_err(|error| error.to_string())?;
                    let video_id = opaque_id(&args.video, "Developer video ID")
                        .map_err(|error| error.to_string())?;
                    agent_client::mutate_confirmed(
                        Method::DELETE,
                        &format!("/developer/apps/{id}/videos/{video_id}"),
                        &json!({}),
                        global_json,
                        args.format,
                    )
                    .await
                }
            },
            DeveloperCommands::Transactions(args) => {
                if !(1..=100).contains(&args.limit) {
                    return Err("--limit must be between 1 and 100".to_string());
                }
                let id =
                    opaque_id(&args.app, "Developer app ID").map_err(|error| error.to_string())?;
                let query = agent_client::query(&[
                    ("cursor", args.cursor),
                    ("limit", Some(args.limit.to_string())),
                ]);
                agent_client::read(
                    &format!("/developer/apps/{id}/transactions?{query}"),
                    global_json,
                    args.format,
                )
                .await
            }
        }
    }
}
