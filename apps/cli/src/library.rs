use std::path::PathBuf;

use clap::{ArgGroup, Args, Subcommand, ValueEnum};
use reqwest::Method;
use serde_json::{Map, Value, json};

use crate::{
    OutputFormat,
    agent_client::{self, SpaceRole},
    caps::opaque_id,
    confirmation,
};

#[derive(Args)]
pub struct LibraryArgs {
    #[command(subcommand)]
    command: LibraryCommands,
}

#[derive(Subcommand)]
enum LibraryCommands {
    Folders(FoldersArgs),
    Spaces(SpacesArgs),
}

#[derive(Args)]
struct FoldersArgs {
    #[command(subcommand)]
    command: FolderCommands,
}

#[derive(Subcommand)]
enum FolderCommands {
    List(FolderListArgs),
    Create(FolderCreateArgs),
    Update(FolderUpdateArgs),
    PublicPage(CollectionPublicPageArgs),
    Logo(CollectionLogoArgs),
    Delete(FolderDeleteArgs),
}

#[derive(Clone, Copy, ValueEnum)]
enum FolderColor {
    Normal,
    Blue,
    Red,
    Yellow,
}

impl FolderColor {
    const fn as_str(self) -> &'static str {
        match self {
            Self::Normal => "normal",
            Self::Blue => "blue",
            Self::Red => "red",
            Self::Yellow => "yellow",
        }
    }
}

#[derive(Args)]
struct FolderListArgs {
    organization: String,
    #[arg(long)]
    space: Option<String>,
    #[arg(long)]
    parent: Option<String>,
    #[arg(long)]
    root: bool,
    #[arg(long, value_enum, default_value_t = OutputFormat::Text)]
    format: OutputFormat,
}

#[derive(Args)]
struct FolderCreateArgs {
    organization: String,
    name: String,
    #[arg(long, value_enum, default_value_t = FolderColor::Normal)]
    color: FolderColor,
    #[arg(long)]
    parent: Option<String>,
    #[arg(long)]
    space: Option<String>,
    #[arg(long)]
    public: bool,
    #[arg(long)]
    yes: bool,
    #[arg(long, value_enum, default_value_t = OutputFormat::Text)]
    format: OutputFormat,
}

#[derive(Args)]
#[command(group(ArgGroup::new("parent_action").args(["parent", "root"])))]
struct FolderUpdateArgs {
    folder: String,
    #[arg(long)]
    name: Option<String>,
    #[arg(long, value_enum)]
    color: Option<FolderColor>,
    #[arg(long)]
    parent: Option<String>,
    #[arg(long)]
    root: bool,
    #[arg(long)]
    public: Option<bool>,
    #[arg(long)]
    settings_json: Option<String>,
    #[arg(long)]
    yes: bool,
    #[arg(long, value_enum, default_value_t = OutputFormat::Text)]
    format: OutputFormat,
}

#[derive(Args)]
struct FolderDeleteArgs {
    folder: String,
    #[arg(long)]
    yes: bool,
    #[arg(long, value_enum, default_value_t = OutputFormat::Text)]
    format: OutputFormat,
}

#[derive(Args)]
struct SpacesArgs {
    #[command(subcommand)]
    command: SpaceCommands,
}

#[derive(Subcommand)]
enum SpaceCommands {
    List(SpaceListArgs),
    Create(SpaceCreateArgs),
    Update(SpaceUpdateArgs),
    PublicPage(CollectionPublicPageArgs),
    Logo(CollectionLogoArgs),
    Delete(SpaceDeleteArgs),
    Members(SpaceMembersArgs),
}

#[derive(Clone, Copy, ValueEnum)]
enum CollectionLogoMode {
    Cap,
    Organization,
    Custom,
    None,
}

impl CollectionLogoMode {
    const fn as_str(self) -> &'static str {
        match self {
            Self::Cap => "cap",
            Self::Organization => "organization",
            Self::Custom => "custom",
            Self::None => "none",
        }
    }
}

#[derive(Clone, Copy, ValueEnum)]
enum CollectionLayout {
    Grid,
    List,
}

impl CollectionLayout {
    const fn as_str(self) -> &'static str {
        match self {
            Self::Grid => "grid",
            Self::List => "list",
        }
    }
}

#[derive(Args)]
struct CollectionPublicPageArgs {
    collection: String,
    #[arg(long)]
    public: Option<bool>,
    #[arg(long)]
    title: Option<String>,
    #[arg(long)]
    subtitle: Option<String>,
    #[arg(long)]
    hide_title: Option<bool>,
    #[arg(long)]
    hide_copy_link: Option<bool>,
    #[arg(long, value_enum)]
    logo_mode: Option<CollectionLogoMode>,
    #[arg(long)]
    cta_label: Option<String>,
    #[arg(long)]
    cta_url: Option<String>,
    #[arg(long, value_enum)]
    layout: Option<CollectionLayout>,
    #[arg(long)]
    grid_columns: Option<u8>,
    #[arg(long)]
    yes: bool,
    #[arg(long, value_enum, default_value_t = OutputFormat::Text)]
    format: OutputFormat,
}

#[derive(Args)]
struct CollectionLogoArgs {
    #[command(subcommand)]
    command: CollectionLogoCommands,
}

#[derive(Subcommand)]
enum CollectionLogoCommands {
    Set(CollectionLogoSetArgs),
    Remove(CollectionLogoRemoveArgs),
}

#[derive(Args)]
struct CollectionLogoSetArgs {
    collection: String,
    image: PathBuf,
    #[arg(long)]
    yes: bool,
    #[arg(long, value_enum, default_value_t = OutputFormat::Text)]
    format: OutputFormat,
}

#[derive(Args)]
struct CollectionLogoRemoveArgs {
    collection: String,
    #[arg(long)]
    yes: bool,
    #[arg(long, value_enum, default_value_t = OutputFormat::Text)]
    format: OutputFormat,
}

#[derive(Clone, Copy, ValueEnum)]
enum SpacePrivacy {
    Public,
    Private,
}

impl SpacePrivacy {
    const fn as_str(self) -> &'static str {
        match self {
            Self::Public => "Public",
            Self::Private => "Private",
        }
    }
}

#[derive(Args)]
struct SpaceListArgs {
    organization: String,
    #[arg(long, value_enum, default_value_t = OutputFormat::Text)]
    format: OutputFormat,
}

#[derive(Args, Default)]
struct ViewerSettingsArgs {
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
}

impl ViewerSettingsArgs {
    fn value(&self) -> Option<Value> {
        let mut settings = Map::new();
        for (key, value) in [
            ("disableSummary", self.disable_summary),
            ("disableCaptions", self.disable_captions),
            ("disableChapters", self.disable_chapters),
            ("disableReactions", self.disable_reactions),
            ("disableTranscript", self.disable_transcript),
            ("disableComments", self.disable_comments),
        ] {
            if let Some(value) = value {
                settings.insert(key.to_string(), Value::Bool(value));
            }
        }
        (!settings.is_empty()).then_some(Value::Object(settings))
    }
}

#[derive(Args)]
struct SpaceCreateArgs {
    organization: String,
    name: String,
    #[arg(long)]
    description: Option<String>,
    #[arg(long, value_enum, default_value_t = SpacePrivacy::Private)]
    privacy: SpacePrivacy,
    #[arg(long)]
    public: bool,
    #[command(flatten)]
    settings: ViewerSettingsArgs,
    #[arg(long)]
    yes: bool,
    #[arg(long, value_enum, default_value_t = OutputFormat::Text)]
    format: OutputFormat,
}

#[derive(Args)]
struct SpaceUpdateArgs {
    space: String,
    #[arg(long)]
    name: Option<String>,
    #[arg(long)]
    description: Option<String>,
    #[arg(long)]
    clear_description: bool,
    #[arg(long, value_enum)]
    privacy: Option<SpacePrivacy>,
    #[arg(long)]
    public: Option<bool>,
    #[command(flatten)]
    settings: ViewerSettingsArgs,
    #[arg(long)]
    yes: bool,
    #[arg(long, value_enum, default_value_t = OutputFormat::Text)]
    format: OutputFormat,
}

#[derive(Args)]
struct SpaceDeleteArgs {
    space: String,
    #[arg(long)]
    yes: bool,
    #[arg(long, value_enum, default_value_t = OutputFormat::Text)]
    format: OutputFormat,
}

#[derive(Args)]
struct SpaceMembersArgs {
    #[command(subcommand)]
    command: SpaceMemberCommands,
}

#[derive(Subcommand)]
enum SpaceMemberCommands {
    List(SpaceMemberListArgs),
    Add(SpaceMemberAddArgs),
    Update(SpaceMemberUpdateArgs),
    Remove(SpaceMemberRemoveArgs),
}

#[derive(Args)]
struct SpaceMemberListArgs {
    space: String,
    #[arg(long, value_enum, default_value_t = OutputFormat::Text)]
    format: OutputFormat,
}

#[derive(Args)]
struct SpaceMemberAddArgs {
    space: String,
    user: String,
    #[arg(long, value_enum, default_value_t = SpaceRole::Member)]
    role: SpaceRole,
    #[arg(long)]
    yes: bool,
    #[arg(long, value_enum, default_value_t = OutputFormat::Text)]
    format: OutputFormat,
}

#[derive(Args)]
struct SpaceMemberUpdateArgs {
    space: String,
    user: String,
    #[arg(long, value_enum)]
    role: SpaceRole,
    #[arg(long)]
    yes: bool,
    #[arg(long, value_enum, default_value_t = OutputFormat::Text)]
    format: OutputFormat,
}

#[derive(Args)]
struct SpaceMemberRemoveArgs {
    space: String,
    user: String,
    #[arg(long)]
    yes: bool,
    #[arg(long, value_enum, default_value_t = OutputFormat::Text)]
    format: OutputFormat,
}

fn add_optional(body: &mut Map<String, Value>, key: &str, value: Option<Value>) {
    if let Some(value) = value {
        body.insert(key.to_string(), value);
    }
}

async fn update_collection_public_page(
    kind: &str,
    args: CollectionPublicPageArgs,
    global_json: bool,
) -> Result<(), String> {
    confirmation::require(args.yes, "Update the public collection page")?;
    if let Some(columns) = args.grid_columns
        && !matches!(columns, 2..=5)
    {
        return Err("--grid-columns must be between 2 and 5".to_string());
    }
    let id = opaque_id(&args.collection, "Collection ID").map_err(|error| error.to_string())?;
    let mut body = Map::new();
    add_optional(&mut body, "public", args.public.map(Value::Bool));
    add_optional(&mut body, "title", args.title.map(Value::String));
    add_optional(&mut body, "subtitle", args.subtitle.map(Value::String));
    add_optional(&mut body, "hideTitle", args.hide_title.map(Value::Bool));
    add_optional(
        &mut body,
        "hideCopyLink",
        args.hide_copy_link.map(Value::Bool),
    );
    add_optional(
        &mut body,
        "logoMode",
        args.logo_mode
            .map(|mode| Value::String(mode.as_str().to_string())),
    );
    add_optional(&mut body, "ctaLabel", args.cta_label.map(Value::String));
    add_optional(&mut body, "ctaUrl", args.cta_url.map(Value::String));
    add_optional(
        &mut body,
        "layout",
        args.layout
            .map(|layout| Value::String(layout.as_str().to_string())),
    );
    add_optional(&mut body, "gridColumns", args.grid_columns.map(Value::from));
    if body.is_empty() {
        return Err("Provide at least one public page update".to_string());
    }
    agent_client::mutate_confirmed(
        Method::PATCH,
        &format!("/{kind}/{id}/public-page"),
        &Value::Object(body),
        global_json,
        args.format,
    )
    .await
}

async fn update_collection_logo(
    kind: &str,
    args: CollectionLogoArgs,
    global_json: bool,
) -> Result<(), String> {
    match args.command {
        CollectionLogoCommands::Set(args) => {
            confirmation::require(args.yes, "Update the public collection logo")?;
            let id =
                opaque_id(&args.collection, "Collection ID").map_err(|error| error.to_string())?;
            let body = agent_client::image_payload(&args.image)?;
            agent_client::mutate_confirmed(
                Method::PUT,
                &format!("/{kind}/{id}/logo"),
                &body,
                global_json,
                args.format,
            )
            .await
        }
        CollectionLogoCommands::Remove(args) => {
            confirmation::require(args.yes, "Remove the public collection logo")?;
            let id =
                opaque_id(&args.collection, "Collection ID").map_err(|error| error.to_string())?;
            agent_client::mutate_confirmed(
                Method::DELETE,
                &format!("/{kind}/{id}/logo"),
                &json!({}),
                global_json,
                args.format,
            )
            .await
        }
    }
}

impl LibraryArgs {
    pub async fn run(self, global_json: bool) -> Result<(), String> {
        match self.command {
            LibraryCommands::Folders(args) => run_folders(args, global_json).await,
            LibraryCommands::Spaces(args) => run_spaces(args, global_json).await,
        }
    }
}

async fn run_folders(args: FoldersArgs, global_json: bool) -> Result<(), String> {
    match args.command {
        FolderCommands::List(args) => {
            let organization = opaque_id(&args.organization, "Organization ID")
                .map_err(|error| error.to_string())?;
            let parent = if args.root {
                Some("root".to_string())
            } else {
                args.parent
            };
            let query = agent_client::query(&[("spaceId", args.space), ("parentId", parent)]);
            agent_client::read(
                &format!("/organizations/{organization}/folders?{query}"),
                global_json,
                args.format,
            )
            .await
        }
        FolderCommands::Create(args) => {
            let organization = opaque_id(&args.organization, "Organization ID")
                .map_err(|error| error.to_string())?;
            confirmation::require(args.yes, "Create the folder")?;
            agent_client::mutate(
                Method::POST,
                &format!("/organizations/{organization}/folders"),
                &json!({
                    "name": args.name,
                    "color": args.color.as_str(),
                    "parentId": args.parent,
                    "spaceId": args.space,
                    "public": args.public,
                }),
                global_json,
                args.format,
            )
            .await
        }
        FolderCommands::Update(args) => {
            let folder = opaque_id(&args.folder, "Folder ID").map_err(|error| error.to_string())?;
            let mut body = Map::new();
            add_optional(&mut body, "name", args.name.map(Value::String));
            add_optional(
                &mut body,
                "color",
                args.color
                    .map(|color| Value::String(color.as_str().to_string())),
            );
            if args.root {
                body.insert("parentId".to_string(), Value::Null);
            } else {
                add_optional(&mut body, "parentId", args.parent.map(Value::String));
            }
            add_optional(&mut body, "public", args.public.map(Value::Bool));
            if let Some(settings) = args.settings_json {
                let value: Value = serde_json::from_str(&settings)
                    .map_err(|error| format!("Invalid --settings-json: {error}"))?;
                if !value.is_object() {
                    return Err("--settings-json must be a JSON object".to_string());
                }
                body.insert("settings".to_string(), value);
            }
            if body.is_empty() {
                return Err("Provide at least one folder update".to_string());
            }
            confirmation::require(args.yes, "Update the folder")?;
            agent_client::mutate(
                Method::PATCH,
                &format!("/folders/{folder}"),
                &Value::Object(body),
                global_json,
                args.format,
            )
            .await
        }
        FolderCommands::PublicPage(args) => {
            update_collection_public_page("folders", args, global_json).await
        }
        FolderCommands::Logo(args) => update_collection_logo("folders", args, global_json).await,
        FolderCommands::Delete(args) => {
            let folder = opaque_id(&args.folder, "Folder ID").map_err(|error| error.to_string())?;
            confirmation::require(
                args.yes,
                "Delete the folder and move its Caps to the parent",
            )?;
            agent_client::mutate(
                Method::DELETE,
                &format!("/folders/{folder}"),
                &json!({}),
                global_json,
                args.format,
            )
            .await
        }
    }
}

async fn run_spaces(args: SpacesArgs, global_json: bool) -> Result<(), String> {
    match args.command {
        SpaceCommands::List(args) => {
            let organization = opaque_id(&args.organization, "Organization ID")
                .map_err(|error| error.to_string())?;
            agent_client::read(
                &format!("/organizations/{organization}/spaces"),
                global_json,
                args.format,
            )
            .await
        }
        SpaceCommands::Create(args) => {
            let organization = opaque_id(&args.organization, "Organization ID")
                .map_err(|error| error.to_string())?;
            confirmation::require(args.yes, "Create the space")?;
            let mut body = Map::from_iter([
                ("name".to_string(), Value::String(args.name)),
                (
                    "privacy".to_string(),
                    Value::String(args.privacy.as_str().to_string()),
                ),
                ("public".to_string(), Value::Bool(args.public)),
            ]);
            add_optional(
                &mut body,
                "description",
                args.description.map(Value::String),
            );
            add_optional(&mut body, "settings", args.settings.value());
            agent_client::mutate(
                Method::POST,
                &format!("/organizations/{organization}/spaces"),
                &Value::Object(body),
                global_json,
                args.format,
            )
            .await
        }
        SpaceCommands::Update(args) => {
            let space = opaque_id(&args.space, "Space ID").map_err(|error| error.to_string())?;
            let mut body = Map::new();
            add_optional(&mut body, "name", args.name.map(Value::String));
            if args.clear_description {
                body.insert("description".to_string(), Value::Null);
            } else {
                add_optional(
                    &mut body,
                    "description",
                    args.description.map(Value::String),
                );
            }
            add_optional(
                &mut body,
                "privacy",
                args.privacy
                    .map(|privacy| Value::String(privacy.as_str().to_string())),
            );
            add_optional(&mut body, "public", args.public.map(Value::Bool));
            add_optional(&mut body, "settings", args.settings.value());
            if body.is_empty() {
                return Err("Provide at least one space update".to_string());
            }
            confirmation::require(args.yes, "Update the space")?;
            agent_client::mutate(
                Method::PATCH,
                &format!("/spaces/{space}"),
                &Value::Object(body),
                global_json,
                args.format,
            )
            .await
        }
        SpaceCommands::PublicPage(args) => {
            update_collection_public_page("spaces", args, global_json).await
        }
        SpaceCommands::Logo(args) => update_collection_logo("spaces", args, global_json).await,
        SpaceCommands::Delete(args) => {
            let space = opaque_id(&args.space, "Space ID").map_err(|error| error.to_string())?;
            confirmation::require(args.yes, "Permanently delete the space")?;
            agent_client::mutate(
                Method::DELETE,
                &format!("/spaces/{space}"),
                &json!({}),
                global_json,
                args.format,
            )
            .await
        }
        SpaceCommands::Members(args) => run_space_members(args, global_json).await,
    }
}

async fn run_space_members(args: SpaceMembersArgs, global_json: bool) -> Result<(), String> {
    match args.command {
        SpaceMemberCommands::List(args) => {
            let space = opaque_id(&args.space, "Space ID").map_err(|error| error.to_string())?;
            agent_client::read(
                &format!("/spaces/{space}/members"),
                global_json,
                args.format,
            )
            .await
        }
        SpaceMemberCommands::Add(args) => {
            let space = opaque_id(&args.space, "Space ID").map_err(|error| error.to_string())?;
            let user = opaque_id(&args.user, "User ID").map_err(|error| error.to_string())?;
            confirmation::require(args.yes, "Add the space member")?;
            agent_client::mutate(
                Method::POST,
                &format!("/spaces/{space}/members"),
                &json!({ "userId": user, "role": args.role.as_str() }),
                global_json,
                args.format,
            )
            .await
        }
        SpaceMemberCommands::Update(args) => {
            let space = opaque_id(&args.space, "Space ID").map_err(|error| error.to_string())?;
            let user = opaque_id(&args.user, "User ID").map_err(|error| error.to_string())?;
            confirmation::require(args.yes, "Change the space member role")?;
            agent_client::mutate(
                Method::PATCH,
                &format!("/spaces/{space}/members/{user}"),
                &json!({ "role": args.role.as_str() }),
                global_json,
                args.format,
            )
            .await
        }
        SpaceMemberCommands::Remove(args) => {
            let space = opaque_id(&args.space, "Space ID").map_err(|error| error.to_string())?;
            let user = opaque_id(&args.user, "User ID").map_err(|error| error.to_string())?;
            confirmation::require(args.yes, "Remove the space member")?;
            agent_client::mutate(
                Method::DELETE,
                &format!("/spaces/{space}/members/{user}"),
                &json!({}),
                global_json,
                args.format,
            )
            .await
        }
    }
}
