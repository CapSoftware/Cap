use clap::{ArgGroup, Args, Subcommand};
use reqwest::Method;
use serde_json::{Map, Value, json};

use crate::{OutputFormat, agent_client, confirmation};

#[derive(Args)]
pub struct NotificationsArgs {
    #[command(subcommand)]
    command: NotificationCommands,
}

#[derive(Subcommand)]
enum NotificationCommands {
    List(NotificationListArgs),
    Preferences(NotificationPreferencesArgs),
    Read(NotificationReadArgs),
}

#[derive(Args)]
struct NotificationListArgs {
    #[arg(long)]
    unread: bool,
    #[arg(long)]
    cursor: Option<String>,
    #[arg(long, default_value_t = 50, value_parser = clap::value_parser!(u16).range(1..=100))]
    limit: u16,
    #[arg(long, value_enum, default_value_t = OutputFormat::Text)]
    format: OutputFormat,
}

#[derive(Args)]
#[command(args_conflicts_with_subcommands = true)]
struct NotificationPreferencesArgs {
    #[command(subcommand)]
    command: Option<NotificationPreferencesCommands>,
    #[arg(long)]
    pause_comments: Option<bool>,
    #[arg(long)]
    pause_replies: Option<bool>,
    #[arg(long)]
    pause_views: Option<bool>,
    #[arg(long)]
    pause_reactions: Option<bool>,
    #[arg(long)]
    pause_anonymous_views: Option<bool>,
    #[arg(long)]
    yes: bool,
    #[arg(long, value_enum, default_value_t = OutputFormat::Text)]
    format: OutputFormat,
}

#[derive(Subcommand)]
enum NotificationPreferencesCommands {
    Get(NotificationFormatArgs),
}

#[derive(Args)]
struct NotificationFormatArgs {
    #[arg(long, value_enum, default_value_t = OutputFormat::Text)]
    format: OutputFormat,
}

#[derive(Args)]
#[command(group(ArgGroup::new("selection").required(true).args(["all", "ids"])))]
struct NotificationReadArgs {
    #[arg(long)]
    all: bool,
    #[arg(long, value_delimiter = ',')]
    ids: Vec<String>,
    #[arg(long)]
    yes: bool,
    #[arg(long, value_enum, default_value_t = OutputFormat::Text)]
    format: OutputFormat,
}

impl NotificationsArgs {
    pub async fn run(self, global_json: bool) -> Result<(), String> {
        match self.command {
            NotificationCommands::List(args) => {
                let query = agent_client::query(&[
                    ("unread", args.unread.then(|| "true".to_string())),
                    ("cursor", args.cursor),
                    ("limit", Some(args.limit.to_string())),
                ]);
                agent_client::read(
                    &format!("/me/notifications?{query}"),
                    global_json,
                    args.format,
                )
                .await
            }
            NotificationCommands::Preferences(args) => {
                if let Some(NotificationPreferencesCommands::Get(format)) = args.command {
                    return agent_client::read(
                        "/me/notification-preferences",
                        global_json,
                        format.format,
                    )
                    .await;
                }
                let mut body = Map::new();
                for (key, value) in [
                    ("pauseComments", args.pause_comments),
                    ("pauseReplies", args.pause_replies),
                    ("pauseViews", args.pause_views),
                    ("pauseReactions", args.pause_reactions),
                    ("pauseAnonymousViews", args.pause_anonymous_views),
                ] {
                    if let Some(value) = value {
                        body.insert(key.to_string(), Value::Bool(value));
                    }
                }
                if body.is_empty() {
                    return agent_client::read(
                        "/me/notification-preferences",
                        global_json,
                        args.format,
                    )
                    .await;
                }
                confirmation::require(args.yes, "Update notification preferences")?;
                agent_client::mutate(
                    Method::PATCH,
                    "/me/notification-preferences",
                    &json!(body),
                    global_json,
                    args.format,
                )
                .await
            }
            NotificationCommands::Read(args) => {
                confirmation::require(args.yes, "Mark notifications as read")?;
                agent_client::mutate(
                    Method::POST,
                    "/me/notifications/read",
                    &json!({ "all": args.all, "ids": args.ids }),
                    global_json,
                    args.format,
                )
                .await
            }
        }
    }
}
