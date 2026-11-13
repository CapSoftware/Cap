use std::path::PathBuf;

use clap::{Args, Subcommand, ValueEnum};
use reqwest::Method;
use serde_json::{Map, Value, json};

use crate::{
    OutputFormat, agent_client,
    caps::{AgentApiError, AgentClient, opaque_id},
    confirmation,
    developer_media::{self, TranscriptOptions},
    resolve_format,
};

const ABOUT: &str = "\
Cap Infra is Cap's usage-billed video and speech API. A developer app holds its videos,
transcripts, allowed domains, API keys and prepaid credits.

Amounts: 100,000 micro-credits are $1. Credit purchases are in cents, from 500 ($5) to
100000 ($1,000). Durations are in seconds.

A typical job:
  cap developers list --json
  cap developers videos upload <app> ./demo.mp4 --wait --yes --json
  cap developers videos get <app> <video> --json
  cap developers transcripts create <app> --file ./talk.m4a --wait --yes --json
  cap developers usage <app> --json
  cap developers transactions <app> --json

Every command that changes something needs --yes when stdin is not a terminal. Commands that
delete or revoke also take --dry-run, which prints what would change and changes nothing.";

#[derive(Args)]
#[command(after_help = ABOUT, after_long_help = ABOUT)]
pub struct DevelopersArgs {
    #[command(subcommand)]
    command: DeveloperCommands,
}

#[derive(Subcommand)]
enum DeveloperCommands {
    /// List your Cap Infra developer apps
    List(FormatArgs),
    /// Show one app with its domains, key prefixes, usage, credits and billing standing
    Get(DeveloperGetArgs),
    /// Show an app's usage, credit balance and whether uploads are allowed
    Usage(DeveloperGetArgs),
    /// Create an app and print its public and secret key once
    Create(DeveloperCreateArgs),
    /// Rename an app, change its environment or set its logo
    Update(DeveloperUpdateArgs),
    /// Delete an app and revoke its keys
    Delete(DeveloperDeleteArgs),
    /// Add or remove the origins allowed to use an app's public key
    Domains(DeveloperDomainsArgs),
    /// Rotate an app's API keys
    Keys(DeveloperKeysArgs),
    /// Switch automatic credit purchases on or off
    AutoTopUp(DeveloperAutoTopUpArgs),
    /// Create a checkout link to buy credits
    Credits(DeveloperCreditsArgs),
    /// Upload, read, wait for and delete an app's videos
    Videos(DeveloperVideosArgs),
    /// Turn audio or video into text, billed per audio hour from the app's credits
    Transcripts(DeveloperTranscriptsArgs),
    /// List an app's credit purchases and charges
    Transactions(DeveloperTransactionsArgs),
}

#[derive(Args)]
struct FormatArgs {
    #[arg(long, value_enum, default_value_t = OutputFormat::Text)]
    format: OutputFormat,
}

#[derive(Args)]
struct DeveloperGetArgs {
    /// App id from `cap developers list`
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
    /// Confirm without a prompt
    #[arg(long)]
    yes: bool,
    #[arg(long, value_enum, default_value_t = OutputFormat::Text)]
    format: OutputFormat,
}

#[derive(Args)]
struct DeveloperUpdateArgs {
    /// App id from `cap developers list`
    app: String,
    #[arg(long)]
    name: Option<String>,
    #[arg(long, value_enum)]
    environment: Option<DeveloperEnvironment>,
    #[arg(long)]
    logo_url: Option<String>,
    #[arg(long)]
    clear_logo: bool,
    /// Confirm without a prompt
    #[arg(long)]
    yes: bool,
    #[arg(long, value_enum, default_value_t = OutputFormat::Text)]
    format: OutputFormat,
}

#[derive(Args)]
struct DeveloperDeleteArgs {
    /// App id from `cap developers list`
    app: String,
    /// Print what would be deleted and change nothing
    #[arg(long)]
    dry_run: bool,
    /// Confirm without a prompt
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
    /// Allow an origin, for example https://app.example.com
    Add(DeveloperDomainAddArgs),
    /// Remove an allowed origin by its id or by the origin itself
    Remove(DeveloperDomainRemoveArgs),
}

#[derive(Args)]
struct DeveloperDomainAddArgs {
    /// App id from `cap developers list`
    app: String,
    /// Origin to allow, for example https://app.example.com
    domain: String,
    /// Confirm without a prompt
    #[arg(long)]
    yes: bool,
    #[arg(long, value_enum, default_value_t = OutputFormat::Text)]
    format: OutputFormat,
}

#[derive(Args)]
struct DeveloperDomainRemoveArgs {
    /// App id from `cap developers list`
    app: String,
    /// Domain id from `cap developers get`, or the origin itself
    #[arg(allow_hyphen_values = true)]
    domain: String,
    /// Print what would be removed and change nothing
    #[arg(long)]
    dry_run: bool,
    /// Confirm without a prompt
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
    /// Revoke the active keys and print a new public and secret key once
    Rotate(DeveloperKeyRotateArgs),
}

#[derive(Args)]
struct DeveloperKeyRotateArgs {
    /// App id from `cap developers list`
    app: String,
    /// Print which keys would be revoked and change nothing
    #[arg(long)]
    dry_run: bool,
    /// Confirm without a prompt
    #[arg(long)]
    yes: bool,
    #[arg(long, value_enum, default_value_t = OutputFormat::Text)]
    format: OutputFormat,
}

#[derive(Args)]
struct DeveloperAutoTopUpArgs {
    /// App id from `cap developers list`
    app: String,
    #[arg(long, conflicts_with = "disable")]
    enable: bool,
    #[arg(long, conflicts_with = "enable")]
    disable: bool,
    /// Buy credits when the balance falls below this many micro-credits (100,000 are $1)
    #[arg(long)]
    threshold_micro_credits: Option<u64>,
    /// Amount of each automatic purchase in cents, from 500 ($5) to 100000 ($1,000)
    #[arg(long)]
    amount_cents: Option<u32>,
    /// Confirm without a prompt
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
    /// Create a checkout link. Nothing is charged until someone pays it in a browser
    Purchase(DeveloperCreditPurchaseArgs),
}

#[derive(Args)]
struct DeveloperCreditPurchaseArgs {
    /// App id from `cap developers list`
    app: String,
    /// Amount in cents, from 500 ($5) to 100000 ($1,000)
    #[arg(long)]
    amount_cents: u32,
    /// Print the checkout link without opening a browser
    #[arg(long)]
    no_open: bool,
    /// Confirm without a prompt
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
    /// List an app's videos with their status, playback id and links
    List(DeveloperVideoListArgs),
    /// Show one video with its status, error reason, dimensions and links
    Get(DeveloperVideoTargetArgs),
    /// Wait until a video is ready to play or has failed
    Wait(DeveloperVideoWaitArgs),
    /// Upload a local video file to the app. Uploading is free; stored video is billed daily
    Upload(DeveloperVideoUploadArgs),
    /// Delete a video and stop its playback
    Delete(DeveloperVideoDeleteArgs),
}

#[derive(Args)]
struct DeveloperVideoTargetArgs {
    /// App id from `cap developers list`
    app: String,
    /// Video id from an upload or from `cap developers videos list`
    #[arg(allow_hyphen_values = true)]
    video: String,
    #[arg(long, value_enum, default_value_t = OutputFormat::Text)]
    format: OutputFormat,
}

#[derive(Args)]
struct DeveloperVideoWaitArgs {
    /// App id from `cap developers list`
    app: String,
    /// Video id from an upload or from `cap developers videos list`
    #[arg(allow_hyphen_values = true)]
    video: String,
    /// Give up after this many seconds, from 1 to 86400 (default 900)
    #[arg(long)]
    timeout_seconds: Option<u64>,
    #[arg(long, value_enum, default_value_t = OutputFormat::Text)]
    format: OutputFormat,
}

#[derive(Args)]
struct DeveloperVideoUploadArgs {
    /// App id from `cap developers list`
    app: String,
    /// Local video file, up to 5 GB
    file: PathBuf,
    #[arg(long)]
    name: Option<String>,
    /// Your own id for the end user this video belongs to
    #[arg(long)]
    user_id: Option<String>,
    /// Wait until the video is ready and print its links
    #[arg(long)]
    wait: bool,
    /// With --wait, give up after this many seconds, from 1 to 86400 (default 900)
    #[arg(long)]
    timeout_seconds: Option<u64>,
    /// Confirm without a prompt
    #[arg(long)]
    yes: bool,
    #[arg(long, value_enum, default_value_t = OutputFormat::Text)]
    format: OutputFormat,
}

#[derive(Args)]
struct DeveloperTranscriptsArgs {
    #[command(subcommand)]
    command: DeveloperTranscriptCommands,
}

#[derive(Subcommand)]
enum DeveloperTranscriptCommands {
    /// Transcribe a local file or a public URL
    Create(DeveloperTranscriptCreateArgs),
    /// Show a transcript with its status, cost and text
    Get(DeveloperTranscriptGetArgs),
    /// Print only the transcript text
    Text(DeveloperTranscriptTargetArgs),
    /// Wait until a transcript is complete
    Wait(DeveloperTranscriptWaitArgs),
    /// List an app's transcripts without their text
    List(DeveloperTranscriptListArgs),
    /// Delete a transcript and its stored text
    Delete(DeveloperTranscriptDeleteArgs),
}

#[derive(Args)]
struct DeveloperTranscriptCreateArgs {
    /// App id from `cap developers list`
    app: String,
    /// Local audio or video file, up to 2 GB
    #[arg(long, conflicts_with = "url")]
    file: Option<PathBuf>,
    /// Public http or https URL of an audio or video file
    #[arg(long, conflicts_with = "file")]
    url: Option<String>,
    #[arg(long)]
    name: Option<String>,
    /// Two-letter language code, or auto to detect it
    #[arg(long)]
    language: Option<String>,
    /// Your own id for the end user this transcript belongs to
    #[arg(long)]
    user_id: Option<String>,
    /// Wait for the transcript and print its text
    #[arg(long)]
    wait: bool,
    /// With --wait, give up after this many seconds, from 1 to 86400 (default 900)
    #[arg(long)]
    timeout_seconds: Option<u64>,
    /// Confirm without a prompt
    #[arg(long)]
    yes: bool,
    #[arg(long, value_enum, default_value_t = OutputFormat::Text)]
    format: OutputFormat,
}

#[derive(Args)]
struct DeveloperTranscriptGetArgs {
    /// App id from `cap developers list`
    app: String,
    /// Transcript id from `cap developers transcripts create` or `list`
    #[arg(allow_hyphen_values = true)]
    transcript: String,
    /// Include timed segments
    #[arg(long)]
    segments: bool,
    #[arg(long, value_enum, default_value_t = OutputFormat::Text)]
    format: OutputFormat,
}

#[derive(Args)]
struct DeveloperTranscriptTargetArgs {
    /// App id from `cap developers list`
    app: String,
    /// Transcript id from `cap developers transcripts create` or `list`
    #[arg(allow_hyphen_values = true)]
    transcript: String,
    #[arg(long, value_enum, default_value_t = OutputFormat::Text)]
    format: OutputFormat,
}

#[derive(Args)]
struct DeveloperTranscriptWaitArgs {
    /// App id from `cap developers list`
    app: String,
    /// Transcript id from `cap developers transcripts create` or `list`
    #[arg(allow_hyphen_values = true)]
    transcript: String,
    /// Give up after this many seconds, from 1 to 86400 (default 900)
    #[arg(long)]
    timeout_seconds: Option<u64>,
    #[arg(long, value_enum, default_value_t = OutputFormat::Text)]
    format: OutputFormat,
}

#[derive(Args)]
struct DeveloperTranscriptListArgs {
    /// App id from `cap developers list`
    app: String,
    /// One of uploading, queued, processing, complete, error
    #[arg(long)]
    status: Option<String>,
    /// Only transcripts created with this end user id
    #[arg(long)]
    user_id: Option<String>,
    /// nextCursor from the previous page
    #[arg(long)]
    cursor: Option<String>,
    /// Page size, from 1 to 100
    #[arg(long, default_value_t = 50)]
    limit: u16,
    #[arg(long, value_enum, default_value_t = OutputFormat::Text)]
    format: OutputFormat,
}

#[derive(Args)]
struct DeveloperTranscriptDeleteArgs {
    /// App id from `cap developers list`
    app: String,
    /// Transcript id from `cap developers transcripts create` or `list`
    #[arg(allow_hyphen_values = true)]
    transcript: String,
    /// Print what would be deleted and change nothing
    #[arg(long)]
    dry_run: bool,
    /// Confirm without a prompt
    #[arg(long)]
    yes: bool,
    #[arg(long, value_enum, default_value_t = OutputFormat::Text)]
    format: OutputFormat,
}

#[derive(Args)]
struct DeveloperVideoListArgs {
    /// App id from `cap developers list`
    app: String,
    /// Only videos uploaded with this end user id
    #[arg(long)]
    user_id: Option<String>,
    /// nextCursor from the previous page
    #[arg(long)]
    cursor: Option<String>,
    /// Page size, from 1 to 100
    #[arg(long, default_value_t = 50)]
    limit: u16,
    #[arg(long, value_enum, default_value_t = OutputFormat::Text)]
    format: OutputFormat,
}

#[derive(Args)]
struct DeveloperVideoDeleteArgs {
    /// App id from `cap developers list`
    app: String,
    /// Video id from an upload or from `cap developers videos list`
    #[arg(allow_hyphen_values = true)]
    video: String,
    /// Print what would be deleted and change nothing
    #[arg(long)]
    dry_run: bool,
    /// Confirm without a prompt
    #[arg(long)]
    yes: bool,
    #[arg(long, value_enum, default_value_t = OutputFormat::Text)]
    format: OutputFormat,
}

#[derive(Args)]
struct DeveloperTransactionsArgs {
    /// App id from `cap developers list`
    app: String,
    /// nextCursor from the previous page
    #[arg(long)]
    cursor: Option<String>,
    /// Page size, from 1 to 100
    #[arg(long, default_value_t = 50)]
    limit: u16,
    #[arg(long, value_enum, default_value_t = OutputFormat::Text)]
    format: OutputFormat,
}

fn invalid(message: impl Into<String>) -> AgentApiError {
    AgentApiError::local("INVALID_REQUEST", message)
}

fn confirm(yes: bool, action: &str) -> Result<(), AgentApiError> {
    confirmation::require(yes, action).map_err(|message| {
        if message == "Cancelled" {
            AgentApiError::local("CANCELLED", "The action was not confirmed")
        } else {
            AgentApiError::local("APPROVAL_REQUIRED", message).with_hint(
                "Ask the user to confirm, then run the command again with --yes. Add --dry-run to a delete or rotate command to see what it would change first.",
            )
        }
    })
}

fn print(value: &Value, format: OutputFormat) -> Result<(), AgentApiError> {
    agent_client::print_value(value, format)
        .map_err(|message| AgentApiError::local("TEMPORARY_UNAVAILABLE", message))
}

fn print_transcript_text(value: &Value, format: OutputFormat) -> Result<(), AgentApiError> {
    match format {
        OutputFormat::Json => print(value, format),
        OutputFormat::Text => {
            if developer_media::transcript_has_no_speech(value) {
                eprintln!("{}", developer_media::NO_SPEECH_NOTE);
            }
            println!(
                "{}",
                value
                    .get("text")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
            );
            Ok(())
        }
    }
}

fn page_limit(limit: u16) -> Result<String, AgentApiError> {
    if (1..=100).contains(&limit) {
        Ok(limit.to_string())
    } else {
        Err(invalid("--limit must be between 1 and 100"))
    }
}

fn app_id(app: &str) -> Result<String, AgentApiError> {
    opaque_id(app, "Developer app ID")
}

fn client() -> Result<AgentClient, AgentApiError> {
    AgentClient::from_credentials()
}

async fn read(path: &str, format: OutputFormat) -> Result<(), AgentApiError> {
    print(&client()?.get_json(path).await?, format)
}

async fn mutate(
    method: Method,
    path: &str,
    body: &Value,
    format: OutputFormat,
) -> Result<(), AgentApiError> {
    print(
        &client()?.mutate_json_confirmed(method, path, body).await?,
        format,
    )
}

impl DeveloperCommands {
    const fn local_format(&self) -> OutputFormat {
        match self {
            Self::List(args) => args.format,
            Self::Get(args) | Self::Usage(args) => args.format,
            Self::Create(args) => args.format,
            Self::Update(args) => args.format,
            Self::Delete(args) => args.format,
            Self::Domains(args) => match &args.command {
                DeveloperDomainCommands::Add(args) => args.format,
                DeveloperDomainCommands::Remove(args) => args.format,
            },
            Self::Keys(args) => match &args.command {
                DeveloperKeyCommands::Rotate(args) => args.format,
            },
            Self::AutoTopUp(args) => args.format,
            Self::Credits(args) => match &args.command {
                DeveloperCreditCommands::Purchase(args) => args.format,
            },
            Self::Videos(args) => match &args.command {
                DeveloperVideoCommands::List(args) => args.format,
                DeveloperVideoCommands::Get(args) => args.format,
                DeveloperVideoCommands::Wait(args) => args.format,
                DeveloperVideoCommands::Upload(args) => args.format,
                DeveloperVideoCommands::Delete(args) => args.format,
            },
            Self::Transcripts(args) => match &args.command {
                DeveloperTranscriptCommands::Create(args) => args.format,
                DeveloperTranscriptCommands::Get(args) => args.format,
                DeveloperTranscriptCommands::Text(args) => args.format,
                DeveloperTranscriptCommands::Wait(args) => args.format,
                DeveloperTranscriptCommands::List(args) => args.format,
                DeveloperTranscriptCommands::Delete(args) => args.format,
            },
            Self::Transactions(args) => args.format,
        }
    }
}

impl DevelopersArgs {
    pub async fn run(self, global_json: bool) -> Result<(), String> {
        let format = resolve_format(global_json, self.command.local_format());
        let result = self.run_inner(format).await;
        if let Err(error) = &result
            && format == OutputFormat::Json
        {
            error.emit_json();
        }
        result.map_err(|error| error.describe())
    }

    async fn run_inner(self, format: OutputFormat) -> Result<(), AgentApiError> {
        match self.command {
            DeveloperCommands::List(_) => read("/developer/apps", format).await,
            DeveloperCommands::Get(args) => {
                let id = app_id(&args.app)?;
                read(&format!("/developer/apps/{id}/context"), format).await
            }
            DeveloperCommands::Usage(args) => print(
                &developer_media::usage(&client()?, &args.app).await?,
                format,
            ),
            DeveloperCommands::Create(args) => {
                confirm(
                    args.yes,
                    "Create the developer app and reveal its API credentials",
                )?;
                mutate(
                    Method::POST,
                    "/developer/apps",
                    &json!({
                        "name": args.name,
                        "environment": args.environment.as_str(),
                    }),
                    format,
                )
                .await
            }
            DeveloperCommands::Update(args) => {
                let id = app_id(&args.app)?;
                confirm(args.yes, &format!("Update the developer app {id}"))?;
                if args.logo_url.is_some() && args.clear_logo {
                    return Err(invalid("--logo-url and --clear-logo cannot be combined"));
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
                    return Err(invalid("Provide at least one developer app update"));
                }
                mutate(
                    Method::PATCH,
                    &format!("/developer/apps/{id}"),
                    &Value::Object(body),
                    format,
                )
                .await
            }
            DeveloperCommands::Delete(args) => {
                let id = app_id(&args.app)?;
                if args.dry_run {
                    return print(
                        &developer_media::preview_app_delete(&client()?, &id).await?,
                        format,
                    );
                }
                confirm(
                    args.yes,
                    &format!("Delete the developer app {id} and revoke its keys"),
                )?;
                mutate(
                    Method::DELETE,
                    &format!("/developer/apps/{id}"),
                    &json!({}),
                    format,
                )
                .await
            }
            DeveloperCommands::Domains(args) => match args.command {
                DeveloperDomainCommands::Add(args) => {
                    let id = app_id(&args.app)?;
                    confirm(
                        args.yes,
                        &format!("Add the domain {} to the developer app {id}", args.domain),
                    )?;
                    mutate(
                        Method::POST,
                        &format!("/developer/apps/{id}/domains"),
                        &json!({ "domain": args.domain }),
                        format,
                    )
                    .await
                }
                DeveloperDomainCommands::Remove(args) => {
                    let id = app_id(&args.app)?;
                    let client = client()?;
                    let named = args.domain.contains(['.', ':', '/']);
                    if args.dry_run || named {
                        let entry =
                            developer_media::resolve_domain(&client, &id, &args.domain).await?;
                        if args.dry_run {
                            return print(
                                &developer_media::domain_removal_preview(&id, &entry),
                                format,
                            );
                        }
                        let domain_id = entry
                            .get("id")
                            .and_then(Value::as_str)
                            .ok_or_else(|| invalid("Cap returned a domain without an ID"))?;
                        confirm(
                            args.yes,
                            &format!(
                                "Remove the domain {} from the developer app {id}",
                                args.domain
                            ),
                        )?;
                        let domain_id = opaque_id(domain_id, "Developer domain ID")?;
                        return print(
                            &client
                                .mutate_json_confirmed(
                                    Method::DELETE,
                                    &format!("/developer/apps/{id}/domains/{domain_id}"),
                                    &json!({}),
                                )
                                .await?,
                            format,
                        );
                    }
                    let domain_id = opaque_id(&args.domain, "Developer domain ID")?;
                    confirm(
                        args.yes,
                        &format!("Remove the domain {domain_id} from the developer app {id}"),
                    )?;
                    print(
                        &client
                            .mutate_json_confirmed(
                                Method::DELETE,
                                &format!("/developer/apps/{id}/domains/{domain_id}"),
                                &json!({}),
                            )
                            .await?,
                        format,
                    )
                }
            },
            DeveloperCommands::Keys(args) => match args.command {
                DeveloperKeyCommands::Rotate(args) => {
                    let id = app_id(&args.app)?;
                    if args.dry_run {
                        return print(
                            &developer_media::preview_key_rotation(&client()?, &id).await?,
                            format,
                        );
                    }
                    confirm(
                        args.yes,
                        &format!("Rotate and reveal the API credentials of the developer app {id}"),
                    )?;
                    mutate(
                        Method::POST,
                        &format!("/developer/apps/{id}/keys/rotate"),
                        &json!({}),
                        format,
                    )
                    .await
                }
            },
            DeveloperCommands::AutoTopUp(args) => {
                confirm(args.yes, "Change automatic developer credit purchases")?;
                if args.enable == args.disable {
                    return Err(invalid("Provide exactly one of --enable or --disable"));
                }
                let id = app_id(&args.app)?;
                let mut body = Map::from_iter([("enabled".to_string(), Value::Bool(args.enable))]);
                if let Some(value) = args.threshold_micro_credits {
                    body.insert("thresholdMicroCredits".to_string(), Value::from(value));
                }
                if let Some(value) = args.amount_cents {
                    body.insert("amountCents".to_string(), Value::from(value));
                }
                mutate(
                    Method::PATCH,
                    &format!("/developer/apps/{id}/auto-top-up"),
                    &Value::Object(body),
                    format,
                )
                .await
            }
            DeveloperCommands::Credits(args) => match args.command {
                DeveloperCreditCommands::Purchase(args) => {
                    confirm(args.yes, "Create a developer credit purchase checkout")?;
                    let id = app_id(&args.app)?;
                    let value = client()?
                        .mutate_json_confirmed(
                            Method::POST,
                            &format!("/developer/apps/{id}/credits/checkout"),
                            &json!({ "amountCents": args.amount_cents }),
                        )
                        .await?;
                    agent_client::open_browser_action(&value, args.no_open);
                    print(&value, format)
                }
            },
            DeveloperCommands::Videos(args) => match args.command {
                DeveloperVideoCommands::List(args) => {
                    let limit = page_limit(args.limit)?;
                    let id = app_id(&args.app)?;
                    let query = agent_client::query(&[
                        ("userId", args.user_id),
                        ("cursor", args.cursor),
                        ("limit", Some(limit)),
                    ]);
                    read(&format!("/developer/apps/{id}/videos?{query}"), format).await
                }
                DeveloperVideoCommands::Get(args) => {
                    read(
                        &developer_media::video_path(&args.app, &args.video)?,
                        format,
                    )
                    .await
                }
                DeveloperVideoCommands::Wait(args) => {
                    let timeout = developer_media::validate_wait_seconds(args.timeout_seconds)?;
                    let value = developer_media::wait_for_video(
                        &client()?,
                        &args.app,
                        &args.video,
                        timeout,
                    )
                    .await?;
                    print(&value, format)
                }
                DeveloperVideoCommands::Upload(args) => {
                    let timeout = developer_media::validate_wait_seconds(args.timeout_seconds)?;
                    confirm(
                        args.yes,
                        "Upload the video to the app, where its storage is billed daily from the app's credits",
                    )?;
                    let client = client()?;
                    let uploaded = developer_media::upload_video(
                        &client,
                        &args.app,
                        &args.file,
                        args.name.as_deref(),
                        args.user_id.as_deref(),
                        &developer_media::Created::default(),
                    )
                    .await?;
                    if !args.wait {
                        return print(&uploaded, format);
                    }
                    let id = developer_media::created_id(&uploaded, "video")?;
                    let value =
                        developer_media::wait_for_video(&client, &args.app, &id, timeout).await?;
                    print(&value, format)
                }
                DeveloperVideoCommands::Delete(args) => {
                    let path = developer_media::video_path(&args.app, &args.video)?;
                    if args.dry_run {
                        return print(
                            &developer_media::preview_video_delete(
                                &client()?,
                                &args.app,
                                &args.video,
                            )
                            .await?,
                            format,
                        );
                    }
                    confirm(
                        args.yes,
                        &format!("Delete the developer video {}", args.video),
                    )?;
                    mutate(Method::DELETE, &path, &json!({}), format).await
                }
            },
            DeveloperCommands::Transcripts(args) => match args.command {
                DeveloperTranscriptCommands::Create(args) => {
                    confirm(
                        args.yes,
                        "Create the transcript and charge the app's credits per audio hour",
                    )?;
                    let timeout = developer_media::validate_wait_seconds(args.timeout_seconds)?;
                    let options = TranscriptOptions {
                        name: args.name,
                        language: args.language,
                        user_id: args.user_id,
                    };
                    let client = client()?;
                    let tracked = developer_media::Created::default();
                    let created = match (args.file, args.url) {
                        (Some(file), None) => {
                            developer_media::create_transcript_from_file(
                                &client, &args.app, &file, &options, &tracked,
                            )
                            .await
                        }
                        (None, Some(url)) => {
                            developer_media::create_transcript_from_url(
                                &client, &args.app, &url, &options, &tracked,
                            )
                            .await
                        }
                        _ => return Err(invalid("Provide exactly one of --file or --url")),
                    }?;
                    if !args.wait {
                        return print(&created, format);
                    }
                    let id = developer_media::created_id(&created, "transcript")?;
                    let value =
                        developer_media::wait_for_transcript(&client, &args.app, &id, timeout)
                            .await?;
                    print_transcript_text(&value, format)
                }
                DeveloperTranscriptCommands::Get(args) => {
                    let path = developer_media::transcript_path(
                        &args.app,
                        &args.transcript,
                        args.segments,
                    )?;
                    read(&path, format).await
                }
                DeveloperTranscriptCommands::Text(args) => {
                    let path =
                        developer_media::transcript_path(&args.app, &args.transcript, false)?;
                    let value = client()?.get_json(&path).await?;
                    match developer_media::transcript_status(&value) {
                        Some("complete") => print_transcript_text(&value, format),
                        Some("error") => Err(developer_media::transcript_failure(
                            &value,
                            &args.transcript,
                        )),
                        status => Err(AgentApiError::local(
                            "NOT_READY",
                            "The transcript is not complete yet",
                        )
                        .with_detail("transcriptId", args.transcript.as_str())
                        .with_detail("status", status.unwrap_or("unknown"))
                        .with_hint(format!(
                            "Wait for it with `cap developers transcripts wait {} {}`.",
                            args.app, args.transcript
                        ))),
                    }
                }
                DeveloperTranscriptCommands::Wait(args) => {
                    let timeout = developer_media::validate_wait_seconds(args.timeout_seconds)?;
                    let value = developer_media::wait_for_transcript(
                        &client()?,
                        &args.app,
                        &args.transcript,
                        timeout,
                    )
                    .await?;
                    print(&value, format)
                }
                DeveloperTranscriptCommands::List(args) => {
                    let limit = page_limit(args.limit)?;
                    let id = app_id(&args.app)?;
                    let query = agent_client::query(&[
                        ("status", args.status),
                        ("userId", args.user_id),
                        ("cursor", args.cursor),
                        ("limit", Some(limit)),
                    ]);
                    read(&format!("/developer/apps/{id}/transcripts?{query}"), format).await
                }
                DeveloperTranscriptCommands::Delete(args) => {
                    let path =
                        developer_media::transcript_path(&args.app, &args.transcript, false)?;
                    if args.dry_run {
                        return print(
                            &developer_media::preview_transcript_delete(
                                &client()?,
                                &args.app,
                                &args.transcript,
                            )
                            .await?,
                            format,
                        );
                    }
                    confirm(
                        args.yes,
                        &format!("Delete the transcript {}", args.transcript),
                    )?;
                    mutate(Method::DELETE, &path, &json!({}), format).await
                }
            },
            DeveloperCommands::Transactions(args) => {
                let limit = page_limit(args.limit)?;
                let id = app_id(&args.app)?;
                let query = agent_client::query(&[("cursor", args.cursor), ("limit", Some(limit))]);
                read(
                    &format!("/developer/apps/{id}/transactions?{query}"),
                    format,
                )
                .await
            }
        }
    }
}
