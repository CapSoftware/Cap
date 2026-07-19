use std::{
    io::{self, IsTerminal, Read},
    path::PathBuf,
};

use clap::{Args, Subcommand, ValueEnum};
use reqwest::Method;
use serde_json::{Map, Value, json};

use crate::{
    OutputFormat, agent_client,
    caps::{AgentClient, opaque_id},
    confirmation, resolve_format,
};

#[derive(Args)]
pub struct OrganizationsArgs {
    #[command(subcommand)]
    command: OrganizationCommands,
}

#[derive(Subcommand)]
enum OrganizationCommands {
    List(FormatArgs),
    Create(OrganizationCreateArgs),
    Get(OrganizationArgs),
    Members(OrganizationArgs),
    Invites(OrganizationArgs),
    Billing(OrganizationBillingArgs),
    Storage(OrganizationStorageArgs),
    Update(OrganizationUpdateArgs),
    Icon(OrganizationIconArgs),
    ShareableIcon(OrganizationIconArgs),
    Settings(OrganizationSettingsArgs),
    Invite(OrganizationInviteArgs),
    Member(OrganizationMemberArgs),
    Domain(OrganizationDomainArgs),
    Delete(OrganizationDeleteArgs),
}

#[derive(Args)]
struct FormatArgs {
    #[arg(long, value_enum, default_value_t = OutputFormat::Text)]
    format: OutputFormat,
}

#[derive(Args)]
struct OrganizationArgs {
    organization: String,
    #[arg(long, value_enum, default_value_t = OutputFormat::Text)]
    format: OutputFormat,
}

#[derive(Args)]
struct OrganizationCreateArgs {
    name: String,
    #[arg(long)]
    yes: bool,
    #[arg(long, value_enum, default_value_t = OutputFormat::Text)]
    format: OutputFormat,
}

#[derive(Args)]
struct OrganizationIconArgs {
    #[command(subcommand)]
    command: OrganizationIconCommands,
}

#[derive(Subcommand)]
enum OrganizationIconCommands {
    Set(OrganizationIconSetArgs),
    Remove(OrganizationIconRemoveArgs),
}

#[derive(Args)]
struct OrganizationIconSetArgs {
    organization: String,
    image: PathBuf,
    #[arg(long)]
    yes: bool,
    #[arg(long, value_enum, default_value_t = OutputFormat::Text)]
    format: OutputFormat,
}

#[derive(Args)]
struct OrganizationIconRemoveArgs {
    organization: String,
    #[arg(long)]
    yes: bool,
    #[arg(long, value_enum, default_value_t = OutputFormat::Text)]
    format: OutputFormat,
}

#[derive(Args)]
struct OrganizationBillingArgs {
    #[command(subcommand)]
    command: OrganizationBillingCommands,
}

#[derive(Subcommand)]
enum OrganizationBillingCommands {
    Get(OrganizationArgs),
    Checkout(OrganizationBillingCheckoutArgs),
    Portal(OrganizationBillingPortalArgs),
}

#[derive(Clone, Copy, ValueEnum)]
enum BillingInterval {
    Monthly,
    Yearly,
}

impl BillingInterval {
    const fn as_str(self) -> &'static str {
        match self {
            Self::Monthly => "monthly",
            Self::Yearly => "yearly",
        }
    }
}

#[derive(Args)]
struct OrganizationBillingCheckoutArgs {
    organization: String,
    #[arg(long, value_enum, default_value_t = BillingInterval::Yearly)]
    interval: BillingInterval,
    #[arg(long)]
    quantity: Option<u32>,
    #[arg(long)]
    no_open: bool,
    #[arg(long)]
    yes: bool,
    #[arg(long, value_enum, default_value_t = OutputFormat::Text)]
    format: OutputFormat,
}

#[derive(Args)]
struct OrganizationBillingPortalArgs {
    organization: String,
    #[arg(long)]
    no_open: bool,
    #[arg(long)]
    yes: bool,
    #[arg(long, value_enum, default_value_t = OutputFormat::Text)]
    format: OutputFormat,
}

#[derive(Args)]
struct OrganizationStorageArgs {
    #[command(subcommand)]
    command: OrganizationStorageCommands,
}

#[derive(Subcommand)]
enum OrganizationStorageCommands {
    List(OrganizationArgs),
    S3(OrganizationS3Args),
    Provider(OrganizationStorageProviderArgs),
    GoogleDrive(OrganizationGoogleDriveArgs),
}

#[derive(Args)]
struct OrganizationS3Args {
    #[command(subcommand)]
    command: OrganizationS3Commands,
}

#[derive(Subcommand)]
enum OrganizationS3Commands {
    Set(OrganizationS3ConfigArgs),
    Test(OrganizationS3ConfigArgs),
    Remove(OrganizationS3RemoveArgs),
}

#[derive(Args)]
struct OrganizationS3ConfigArgs {
    organization: String,
    #[arg(long, default_value = "aws")]
    provider: String,
    #[arg(long, default_value = "https://s3.amazonaws.com")]
    endpoint: String,
    #[arg(long)]
    bucket: String,
    #[arg(long, default_value = "us-east-1")]
    region: String,
    #[arg(long, conflicts_with = "credentials_stdin")]
    reuse_credentials: bool,
    #[arg(long, conflicts_with = "reuse_credentials")]
    credentials_stdin: bool,
    #[arg(long)]
    yes: bool,
    #[arg(long, value_enum, default_value_t = OutputFormat::Text)]
    format: OutputFormat,
}

#[derive(Args)]
struct OrganizationS3RemoveArgs {
    organization: String,
    #[arg(long)]
    yes: bool,
    #[arg(long, value_enum, default_value_t = OutputFormat::Text)]
    format: OutputFormat,
}

#[derive(Clone, Copy, ValueEnum)]
enum OrganizationStorageProvider {
    S3,
    GoogleDrive,
}

impl OrganizationStorageProvider {
    const fn as_str(self) -> &'static str {
        match self {
            Self::S3 => "s3",
            Self::GoogleDrive => "googleDrive",
        }
    }
}

#[derive(Args)]
struct OrganizationStorageProviderArgs {
    organization: String,
    #[arg(long, value_enum)]
    provider: OrganizationStorageProvider,
    #[arg(long)]
    yes: bool,
    #[arg(long, value_enum, default_value_t = OutputFormat::Text)]
    format: OutputFormat,
}

#[derive(Args)]
struct OrganizationGoogleDriveArgs {
    #[command(subcommand)]
    command: OrganizationGoogleDriveCommands,
}

#[derive(Subcommand)]
enum OrganizationGoogleDriveCommands {
    Connect(OrganizationGoogleDriveConnectArgs),
    Folders(OrganizationGoogleDriveFoldersArgs),
    Location(OrganizationGoogleDriveLocationArgs),
    Disconnect(OrganizationGoogleDriveDisconnectArgs),
}

#[derive(Args)]
struct OrganizationGoogleDriveConnectArgs {
    organization: String,
    #[arg(long)]
    no_open: bool,
    #[arg(long)]
    yes: bool,
    #[arg(long, value_enum, default_value_t = OutputFormat::Text)]
    format: OutputFormat,
}

#[derive(Args)]
struct OrganizationGoogleDriveFoldersArgs {
    organization: String,
    #[arg(long)]
    parent_id: Option<String>,
    #[arg(long, value_enum, default_value_t = OutputFormat::Text)]
    format: OutputFormat,
}

#[derive(Args)]
struct OrganizationGoogleDriveLocationArgs {
    organization: String,
    folder_id: String,
    #[arg(long)]
    folder_name: Option<String>,
    #[arg(long)]
    drive_id: Option<String>,
    #[arg(long)]
    drive_name: Option<String>,
    #[arg(long)]
    yes: bool,
    #[arg(long, value_enum, default_value_t = OutputFormat::Text)]
    format: OutputFormat,
}

#[derive(Args)]
struct OrganizationGoogleDriveDisconnectArgs {
    organization: String,
    #[arg(long)]
    yes: bool,
    #[arg(long, value_enum, default_value_t = OutputFormat::Text)]
    format: OutputFormat,
}

#[derive(Clone, Copy, ValueEnum)]
enum OrganizationRole {
    Admin,
    Member,
}

impl OrganizationRole {
    const fn as_str(self) -> &'static str {
        match self {
            Self::Admin => "admin",
            Self::Member => "member",
        }
    }
}

#[derive(Args)]
struct OrganizationUpdateArgs {
    organization: String,
    #[arg(long)]
    name: Option<String>,
    #[arg(long, conflicts_with = "clear_allowed_email_domain")]
    allowed_email_domain: Option<String>,
    #[arg(long)]
    clear_allowed_email_domain: bool,
    #[arg(long)]
    yes: bool,
    #[arg(long, value_enum, default_value_t = OutputFormat::Text)]
    format: OutputFormat,
}

#[derive(Args)]
struct OrganizationSettingsArgs {
    organization: String,
    #[arg(long)]
    disable_summary: Option<bool>,
    #[arg(long)]
    disable_captions: Option<bool>,
    #[arg(long)]
    disable_chapters: Option<bool>,
    #[arg(long)]
    disable_reactions: Option<bool>,
    #[arg(long)]
    disable_transcript: Option<bool>,
    #[arg(long)]
    disable_comments: Option<bool>,
    #[arg(long)]
    hide_shareable_link_cap_logo: Option<bool>,
    #[arg(long)]
    shareable_link_use_organization_icon: Option<bool>,
    #[arg(long)]
    ai_generation_language: Option<String>,
    #[arg(long)]
    default_playback_speed: Option<f64>,
    #[arg(long)]
    yes: bool,
    #[arg(long, value_enum, default_value_t = OutputFormat::Text)]
    format: OutputFormat,
}

#[derive(Args)]
struct OrganizationInviteArgs {
    #[command(subcommand)]
    command: OrganizationInviteCommands,
}

#[derive(Subcommand)]
enum OrganizationInviteCommands {
    Add(OrganizationInviteAddArgs),
    Remove(OrganizationInviteRemoveArgs),
}

#[derive(Args)]
struct OrganizationInviteAddArgs {
    organization: String,
    #[arg(long)]
    email: String,
    #[arg(long, value_enum, default_value_t = OrganizationRole::Member)]
    role: OrganizationRole,
    #[arg(long, help = "Create a link without delivering the invitation email")]
    no_email: bool,
    #[arg(long)]
    yes: bool,
    #[arg(long, value_enum, default_value_t = OutputFormat::Text)]
    format: OutputFormat,
}

#[derive(Args)]
struct OrganizationInviteRemoveArgs {
    organization: String,
    invite_id: String,
    #[arg(long)]
    yes: bool,
    #[arg(long, value_enum, default_value_t = OutputFormat::Text)]
    format: OutputFormat,
}

#[derive(Args)]
struct OrganizationMemberArgs {
    #[command(subcommand)]
    command: OrganizationMemberCommands,
}

#[derive(Subcommand)]
enum OrganizationMemberCommands {
    Role(OrganizationMemberRoleArgs),
    Seat(OrganizationMemberSeatArgs),
    Remove(OrganizationMemberRemoveArgs),
}

#[derive(Args)]
struct OrganizationMemberRoleArgs {
    organization: String,
    member_id: String,
    #[arg(long, value_enum)]
    role: OrganizationRole,
    #[arg(long)]
    yes: bool,
    #[arg(long, value_enum, default_value_t = OutputFormat::Text)]
    format: OutputFormat,
}

#[derive(Args)]
struct OrganizationMemberRemoveArgs {
    organization: String,
    member_id: String,
    #[arg(long)]
    yes: bool,
    #[arg(long, value_enum, default_value_t = OutputFormat::Text)]
    format: OutputFormat,
}

#[derive(Args)]
struct OrganizationMemberSeatArgs {
    organization: String,
    member_id: String,
    #[arg(long, conflicts_with = "disable")]
    enable: bool,
    #[arg(long, conflicts_with = "enable")]
    disable: bool,
    #[arg(long)]
    yes: bool,
    #[arg(long, value_enum, default_value_t = OutputFormat::Text)]
    format: OutputFormat,
}

#[derive(Args)]
struct OrganizationDeleteArgs {
    organization: String,
    #[arg(long)]
    wait: bool,
    #[arg(long, default_value_t = 600)]
    timeout: u64,
    #[arg(long)]
    yes: bool,
    #[arg(long, value_enum, default_value_t = OutputFormat::Text)]
    format: OutputFormat,
}

#[derive(Args)]
struct OrganizationDomainArgs {
    #[command(subcommand)]
    command: OrganizationDomainCommands,
}

#[derive(Subcommand)]
enum OrganizationDomainCommands {
    Set(OrganizationDomainSetArgs),
    Remove(OrganizationDomainOperationArgs),
    Verify(OrganizationDomainOperationArgs),
}

#[derive(Args)]
struct OrganizationDomainSetArgs {
    organization: String,
    domain: String,
    #[arg(long)]
    wait: bool,
    #[arg(long, default_value_t = 600)]
    timeout: u64,
    #[arg(long)]
    yes: bool,
    #[arg(long, value_enum, default_value_t = OutputFormat::Text)]
    format: OutputFormat,
}

#[derive(Args)]
struct OrganizationDomainOperationArgs {
    organization: String,
    #[arg(long)]
    wait: bool,
    #[arg(long, default_value_t = 600)]
    timeout: u64,
    #[arg(long)]
    yes: bool,
    #[arg(long, value_enum, default_value_t = OutputFormat::Text)]
    format: OutputFormat,
}

async fn run_operation(
    method: Method,
    path: &str,
    wait: bool,
    timeout: u64,
    format: OutputFormat,
    global_json: bool,
) -> Result<(), String> {
    let client = AgentClient::from_credentials().map_err(|error| error.to_string())?;
    let mut value = client
        .mutate_json_confirmed(method, path, &json!({}))
        .await
        .map_err(|error| error.to_string())?;
    if wait {
        let operation_id = value
            .get("id")
            .and_then(Value::as_str)
            .ok_or_else(|| "Cap returned an invalid operation".to_string())?;
        value = crate::jobs::wait_operation(&client, operation_id, timeout)
            .await
            .map_err(|error| error.to_string())?;
    }
    agent_client::print_value(&value, resolve_format(global_json, format))
}

fn read_s3_credentials(reuse: bool, credentials_stdin: bool) -> Result<(String, String), String> {
    if reuse {
        return Ok((String::new(), String::new()));
    }
    if credentials_stdin {
        let mut value = String::new();
        io::stdin()
            .lock()
            .take(16 * 1024)
            .read_to_string(&mut value)
            .map_err(|error| error.to_string())?;
        let lines = value.lines().collect::<Vec<_>>();
        if lines.len() != 2 || lines.iter().any(|line| line.is_empty()) {
            return Err(
                "--credentials-stdin expects the access key ID and secret access key on exactly two non-empty lines"
                    .to_string(),
            );
        }
        return Ok((lines[0].to_string(), lines[1].to_string()));
    }
    if !io::stdin().is_terminal() {
        return Err(
            "Non-interactive S3 configuration requires --credentials-stdin or --reuse-credentials"
                .to_string(),
        );
    }
    let access_key_id =
        rpassword::prompt_password("S3 access key ID: ").map_err(|error| error.to_string())?;
    let secret_access_key =
        rpassword::prompt_password("S3 secret access key: ").map_err(|error| error.to_string())?;
    if access_key_id.is_empty() || secret_access_key.is_empty() {
        return Err("S3 credentials cannot be empty".to_string());
    }
    Ok((access_key_id, secret_access_key))
}

fn s3_config_body(args: &OrganizationS3ConfigArgs) -> Result<Value, String> {
    let (access_key_id, secret_access_key) =
        read_s3_credentials(args.reuse_credentials, args.credentials_stdin)?;
    Ok(json!({
        "provider": args.provider,
        "accessKeyId": access_key_id,
        "secretAccessKey": secret_access_key,
        "endpoint": args.endpoint,
        "bucketName": args.bucket,
        "region": args.region,
    }))
}

impl OrganizationsArgs {
    pub async fn run(self, global_json: bool) -> Result<(), String> {
        match self.command {
            OrganizationCommands::List(args) => {
                agent_client::read("/organizations", global_json, args.format).await
            }
            OrganizationCommands::Create(args) => {
                confirmation::require(args.yes, "Create the organization")?;
                agent_client::mutate_confirmed(
                    Method::POST,
                    "/organizations",
                    &json!({ "name": args.name }),
                    global_json,
                    args.format,
                )
                .await
            }
            OrganizationCommands::Get(args) => {
                let id = opaque_id(&args.organization, "Organization ID")
                    .map_err(|error| error.to_string())?;
                agent_client::read(&format!("/organizations/{id}"), global_json, args.format).await
            }
            OrganizationCommands::Members(args) => {
                let id = opaque_id(&args.organization, "Organization ID")
                    .map_err(|error| error.to_string())?;
                agent_client::read(
                    &format!("/organizations/{id}/members"),
                    global_json,
                    args.format,
                )
                .await
            }
            OrganizationCommands::Invites(args) => {
                let id = opaque_id(&args.organization, "Organization ID")
                    .map_err(|error| error.to_string())?;
                agent_client::read(
                    &format!("/organizations/{id}/invites"),
                    global_json,
                    args.format,
                )
                .await
            }
            OrganizationCommands::Billing(args) => match args.command {
                OrganizationBillingCommands::Get(args) => {
                    let id = opaque_id(&args.organization, "Organization ID")
                        .map_err(|error| error.to_string())?;
                    agent_client::read(
                        &format!("/organizations/{id}/billing"),
                        global_json,
                        args.format,
                    )
                    .await
                }
                OrganizationBillingCommands::Checkout(args) => {
                    confirmation::require(args.yes, "Create the Cap Pro checkout")?;
                    let id = opaque_id(&args.organization, "Organization ID")
                        .map_err(|error| error.to_string())?;
                    let client =
                        AgentClient::from_credentials().map_err(|error| error.to_string())?;
                    let mut body = Map::from_iter([(
                        "interval".to_string(),
                        Value::String(args.interval.as_str().to_string()),
                    )]);
                    if let Some(quantity) = args.quantity {
                        body.insert("quantity".to_string(), Value::from(quantity));
                    }
                    let value = client
                        .mutate_json_confirmed(
                            Method::POST,
                            &format!("/organizations/{id}/billing/checkout"),
                            &Value::Object(body),
                        )
                        .await
                        .map_err(|error| error.to_string())?;
                    agent_client::open_browser_action(&value, args.no_open);
                    agent_client::print_value(&value, resolve_format(global_json, args.format))
                }
                OrganizationBillingCommands::Portal(args) => {
                    confirmation::require(args.yes, "Open the Cap billing portal")?;
                    let id = opaque_id(&args.organization, "Organization ID")
                        .map_err(|error| error.to_string())?;
                    let client =
                        AgentClient::from_credentials().map_err(|error| error.to_string())?;
                    let value = client
                        .mutate_json_confirmed(
                            Method::POST,
                            &format!("/organizations/{id}/billing/portal"),
                            &json!({}),
                        )
                        .await
                        .map_err(|error| error.to_string())?;
                    agent_client::open_browser_action(&value, args.no_open);
                    agent_client::print_value(&value, resolve_format(global_json, args.format))
                }
            },
            OrganizationCommands::Storage(args) => match args.command {
                OrganizationStorageCommands::List(args) => {
                    let id = opaque_id(&args.organization, "Organization ID")
                        .map_err(|error| error.to_string())?;
                    agent_client::read(
                        &format!("/organizations/{id}/storage-integrations"),
                        global_json,
                        args.format,
                    )
                    .await
                }
                OrganizationStorageCommands::S3(args) => match args.command {
                    OrganizationS3Commands::Set(args) => {
                        confirmation::require(args.yes, "Configure organization S3 storage")?;
                        let id = opaque_id(&args.organization, "Organization ID")
                            .map_err(|error| error.to_string())?;
                        let body = s3_config_body(&args)?;
                        agent_client::mutate_confirmed(
                            Method::PUT,
                            &format!("/organizations/{id}/storage/s3"),
                            &body,
                            global_json,
                            args.format,
                        )
                        .await
                    }
                    OrganizationS3Commands::Test(args) => {
                        confirmation::require(args.yes, "Test organization S3 storage")?;
                        let id = opaque_id(&args.organization, "Organization ID")
                            .map_err(|error| error.to_string())?;
                        let body = s3_config_body(&args)?;
                        agent_client::mutate_confirmed(
                            Method::POST,
                            &format!("/organizations/{id}/storage/s3/test"),
                            &body,
                            global_json,
                            args.format,
                        )
                        .await
                    }
                    OrganizationS3Commands::Remove(args) => {
                        confirmation::require(args.yes, "Remove organization S3 storage")?;
                        let id = opaque_id(&args.organization, "Organization ID")
                            .map_err(|error| error.to_string())?;
                        agent_client::mutate_confirmed(
                            Method::DELETE,
                            &format!("/organizations/{id}/storage/s3"),
                            &json!({}),
                            global_json,
                            args.format,
                        )
                        .await
                    }
                },
                OrganizationStorageCommands::Provider(args) => {
                    confirmation::require(args.yes, "Change the organization storage provider")?;
                    let id = opaque_id(&args.organization, "Organization ID")
                        .map_err(|error| error.to_string())?;
                    agent_client::mutate_confirmed(
                        Method::PATCH,
                        &format!("/organizations/{id}/storage/provider"),
                        &json!({ "provider": args.provider.as_str() }),
                        global_json,
                        args.format,
                    )
                    .await
                }
                OrganizationStorageCommands::GoogleDrive(args) => match args.command {
                    OrganizationGoogleDriveCommands::Connect(args) => {
                        confirmation::require(args.yes, "Connect organization Google Drive")?;
                        let id = opaque_id(&args.organization, "Organization ID")
                            .map_err(|error| error.to_string())?;
                        let client =
                            AgentClient::from_credentials().map_err(|error| error.to_string())?;
                        let value = client
                            .mutate_json_confirmed(
                                Method::POST,
                                &format!("/organizations/{id}/storage/google-drive/connect"),
                                &json!({}),
                            )
                            .await
                            .map_err(|error| error.to_string())?;
                        agent_client::open_browser_action(&value, args.no_open);
                        agent_client::print_value(&value, resolve_format(global_json, args.format))
                    }
                    OrganizationGoogleDriveCommands::Folders(args) => {
                        let id = opaque_id(&args.organization, "Organization ID")
                            .map_err(|error| error.to_string())?;
                        let query = agent_client::query(&[("parentId", args.parent_id)]);
                        let path = if query.is_empty() {
                            format!("/organizations/{id}/storage/google-drive/folders")
                        } else {
                            format!("/organizations/{id}/storage/google-drive/folders?{query}")
                        };
                        agent_client::read(&path, global_json, args.format).await
                    }
                    OrganizationGoogleDriveCommands::Location(args) => {
                        confirmation::require(
                            args.yes,
                            "Change the organization Google Drive location",
                        )?;
                        let id = opaque_id(&args.organization, "Organization ID")
                            .map_err(|error| error.to_string())?;
                        agent_client::mutate_confirmed(
                            Method::PUT,
                            &format!("/organizations/{id}/storage/google-drive/location"),
                            &json!({
                                "folderId": args.folder_id,
                                "folderName": args.folder_name,
                                "driveId": args.drive_id,
                                "driveName": args.drive_name,
                            }),
                            global_json,
                            args.format,
                        )
                        .await
                    }
                    OrganizationGoogleDriveCommands::Disconnect(args) => {
                        confirmation::require(args.yes, "Disconnect organization Google Drive")?;
                        let id = opaque_id(&args.organization, "Organization ID")
                            .map_err(|error| error.to_string())?;
                        agent_client::mutate_confirmed(
                            Method::DELETE,
                            &format!("/organizations/{id}/storage/google-drive"),
                            &json!({}),
                            global_json,
                            args.format,
                        )
                        .await
                    }
                },
            },
            OrganizationCommands::Update(args) => {
                confirmation::require(args.yes, "Update the organization")?;
                let id = opaque_id(&args.organization, "Organization ID")
                    .map_err(|error| error.to_string())?;
                let mut body = Map::new();
                if let Some(name) = args.name {
                    body.insert("name".to_string(), Value::String(name));
                }
                if let Some(domain) = args.allowed_email_domain {
                    body.insert("allowedEmailDomain".to_string(), Value::String(domain));
                } else if args.clear_allowed_email_domain {
                    body.insert("allowedEmailDomain".to_string(), Value::Null);
                }
                if body.is_empty() {
                    return Err(
                        "Provide --name, --allowed-email-domain, or --clear-allowed-email-domain"
                            .to_string(),
                    );
                }
                agent_client::mutate_confirmed(
                    Method::PATCH,
                    &format!("/organizations/{id}"),
                    &Value::Object(body),
                    global_json,
                    args.format,
                )
                .await
            }
            OrganizationCommands::Icon(args) => match args.command {
                OrganizationIconCommands::Set(args) => {
                    confirmation::require(args.yes, "Update the organization icon")?;
                    let id = opaque_id(&args.organization, "Organization ID")
                        .map_err(|error| error.to_string())?;
                    let body = agent_client::image_payload(&args.image)?;
                    agent_client::mutate_confirmed(
                        Method::PUT,
                        &format!("/organizations/{id}/icon"),
                        &body,
                        global_json,
                        args.format,
                    )
                    .await
                }
                OrganizationIconCommands::Remove(args) => {
                    confirmation::require(args.yes, "Remove the organization icon")?;
                    let id = opaque_id(&args.organization, "Organization ID")
                        .map_err(|error| error.to_string())?;
                    agent_client::mutate_confirmed(
                        Method::DELETE,
                        &format!("/organizations/{id}/icon"),
                        &json!({}),
                        global_json,
                        args.format,
                    )
                    .await
                }
            },
            OrganizationCommands::ShareableIcon(args) => match args.command {
                OrganizationIconCommands::Set(args) => {
                    confirmation::require(args.yes, "Update the shareable link icon")?;
                    let id = opaque_id(&args.organization, "Organization ID")
                        .map_err(|error| error.to_string())?;
                    let body = agent_client::image_payload(&args.image)?;
                    agent_client::mutate_confirmed(
                        Method::PUT,
                        &format!("/organizations/{id}/shareable-link-icon"),
                        &body,
                        global_json,
                        args.format,
                    )
                    .await
                }
                OrganizationIconCommands::Remove(args) => {
                    confirmation::require(args.yes, "Remove the shareable link icon")?;
                    let id = opaque_id(&args.organization, "Organization ID")
                        .map_err(|error| error.to_string())?;
                    agent_client::mutate_confirmed(
                        Method::DELETE,
                        &format!("/organizations/{id}/shareable-link-icon"),
                        &json!({}),
                        global_json,
                        args.format,
                    )
                    .await
                }
            },
            OrganizationCommands::Settings(args) => {
                confirmation::require(args.yes, "Update organization preferences")?;
                let id = opaque_id(&args.organization, "Organization ID")
                    .map_err(|error| error.to_string())?;
                let mut body = Map::new();
                for (key, value) in [
                    ("disableSummary", args.disable_summary),
                    ("disableCaptions", args.disable_captions),
                    ("disableChapters", args.disable_chapters),
                    ("disableReactions", args.disable_reactions),
                    ("disableTranscript", args.disable_transcript),
                    ("disableComments", args.disable_comments),
                    (
                        "hideShareableLinkCapLogo",
                        args.hide_shareable_link_cap_logo,
                    ),
                    (
                        "shareableLinkUseOrganizationIcon",
                        args.shareable_link_use_organization_icon,
                    ),
                ] {
                    if let Some(value) = value {
                        body.insert(key.to_string(), Value::Bool(value));
                    }
                }
                if let Some(language) = args.ai_generation_language {
                    body.insert("aiGenerationLanguage".to_string(), Value::String(language));
                }
                if let Some(speed) = args.default_playback_speed {
                    let speed = serde_json::Number::from_f64(speed)
                        .ok_or_else(|| "Default playback speed must be finite".to_string())?;
                    body.insert("defaultPlaybackSpeed".to_string(), Value::Number(speed));
                }
                if body.is_empty() {
                    return Err("Provide at least one organization preference".to_string());
                }
                agent_client::mutate_confirmed(
                    Method::PATCH,
                    &format!("/organizations/{id}/settings"),
                    &Value::Object(body),
                    global_json,
                    args.format,
                )
                .await
            }
            OrganizationCommands::Invite(args) => match args.command {
                OrganizationInviteCommands::Add(args) => {
                    confirmation::require(
                        args.yes,
                        if args.no_email {
                            "Create the organization invite link"
                        } else {
                            "Create and email the organization invite"
                        },
                    )?;
                    let id = opaque_id(&args.organization, "Organization ID")
                        .map_err(|error| error.to_string())?;
                    agent_client::mutate_confirmed(
                        Method::POST,
                        &format!("/organizations/{id}/invites"),
                        &json!({
                            "email": args.email,
                            "role": args.role.as_str(),
                            "sendEmail": !args.no_email,
                        }),
                        global_json,
                        args.format,
                    )
                    .await
                }
                OrganizationInviteCommands::Remove(args) => {
                    confirmation::require(args.yes, "Remove the organization invite")?;
                    let id = opaque_id(&args.organization, "Organization ID")
                        .map_err(|error| error.to_string())?;
                    let invite_id = opaque_id(&args.invite_id, "Invite ID")
                        .map_err(|error| error.to_string())?;
                    agent_client::mutate_confirmed(
                        Method::DELETE,
                        &format!("/organizations/{id}/invites/{invite_id}"),
                        &json!({}),
                        global_json,
                        args.format,
                    )
                    .await
                }
            },
            OrganizationCommands::Member(args) => match args.command {
                OrganizationMemberCommands::Role(args) => {
                    confirmation::require(args.yes, "Change the organization member role")?;
                    let id = opaque_id(&args.organization, "Organization ID")
                        .map_err(|error| error.to_string())?;
                    let member_id = opaque_id(&args.member_id, "Member ID")
                        .map_err(|error| error.to_string())?;
                    agent_client::mutate_confirmed(
                        Method::PATCH,
                        &format!("/organizations/{id}/members/{member_id}"),
                        &json!({ "role": args.role.as_str() }),
                        global_json,
                        args.format,
                    )
                    .await
                }
                OrganizationMemberCommands::Seat(args) => {
                    confirmation::require(args.yes, "Change the organization member Pro seat")?;
                    if args.enable == args.disable {
                        return Err("Provide exactly one of --enable or --disable".to_string());
                    }
                    let id = opaque_id(&args.organization, "Organization ID")
                        .map_err(|error| error.to_string())?;
                    let member_id = opaque_id(&args.member_id, "Member ID")
                        .map_err(|error| error.to_string())?;
                    agent_client::mutate_confirmed(
                        Method::PATCH,
                        &format!("/organizations/{id}/members/{member_id}/seat"),
                        &json!({ "enabled": args.enable }),
                        global_json,
                        args.format,
                    )
                    .await
                }
                OrganizationMemberCommands::Remove(args) => {
                    confirmation::require(args.yes, "Remove the organization member")?;
                    let id = opaque_id(&args.organization, "Organization ID")
                        .map_err(|error| error.to_string())?;
                    let member_id = opaque_id(&args.member_id, "Member ID")
                        .map_err(|error| error.to_string())?;
                    agent_client::mutate_confirmed(
                        Method::DELETE,
                        &format!("/organizations/{id}/members/{member_id}"),
                        &json!({}),
                        global_json,
                        args.format,
                    )
                    .await
                }
            },
            OrganizationCommands::Delete(args) => {
                confirmation::require(
                    args.yes,
                    "Permanently delete the organization and all of its Caps",
                )?;
                let id = opaque_id(&args.organization, "Organization ID")
                    .map_err(|error| error.to_string())?;
                run_operation(
                    Method::DELETE,
                    &format!("/organizations/{id}"),
                    args.wait,
                    args.timeout,
                    args.format,
                    global_json,
                )
                .await
            }
            OrganizationCommands::Domain(args) => match args.command {
                OrganizationDomainCommands::Set(args) => {
                    confirmation::require(args.yes, "Set the organization custom domain")?;
                    let id = opaque_id(&args.organization, "Organization ID")
                        .map_err(|error| error.to_string())?;
                    let client =
                        AgentClient::from_credentials().map_err(|error| error.to_string())?;
                    let mut value = client
                        .mutate_json_confirmed(
                            Method::PUT,
                            &format!("/organizations/{id}/domain"),
                            &json!({ "domain": args.domain }),
                        )
                        .await
                        .map_err(|error| error.to_string())?;
                    if args.wait {
                        let operation_id = value
                            .get("id")
                            .and_then(Value::as_str)
                            .ok_or_else(|| "Cap returned an invalid operation".to_string())?;
                        value = crate::jobs::wait_operation(&client, operation_id, args.timeout)
                            .await
                            .map_err(|error| error.to_string())?;
                    }
                    agent_client::print_value(&value, resolve_format(global_json, args.format))
                }
                OrganizationDomainCommands::Remove(args) => {
                    confirmation::require(args.yes, "Remove the organization custom domain")?;
                    let id = opaque_id(&args.organization, "Organization ID")
                        .map_err(|error| error.to_string())?;
                    run_operation(
                        Method::DELETE,
                        &format!("/organizations/{id}/domain"),
                        args.wait,
                        args.timeout,
                        args.format,
                        global_json,
                    )
                    .await
                }
                OrganizationDomainCommands::Verify(args) => {
                    confirmation::require(args.yes, "Verify the organization custom domain")?;
                    let id = opaque_id(&args.organization, "Organization ID")
                        .map_err(|error| error.to_string())?;
                    run_operation(
                        Method::POST,
                        &format!("/organizations/{id}/domain/verify"),
                        args.wait,
                        args.timeout,
                        args.format,
                        global_json,
                    )
                    .await
                }
            },
        }
    }
}
