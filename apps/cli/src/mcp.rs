use std::time::Duration;

use clap::{Args, Subcommand};
use reqwest::Method;
use rmcp::{
    ErrorData, RoleServer, ServerHandler, ServiceExt,
    handler::server::{router::tool::ToolRouter, wrapper::Parameters},
    model::{
        CallToolResult, ContentBlock, Implementation, ListResourceTemplatesResult,
        PaginatedRequestParams, ReadResourceRequestParams, ReadResourceResult, Resource,
        ResourceContents, ResourceTemplate, ServerCapabilities, ServerInfo,
    },
    schemars, tool, tool_handler, tool_router,
};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};

use crate::caps::{AgentApiError, AgentClient, cap_id, opaque_id};

#[derive(Args)]
pub struct McpArgs {
    #[command(subcommand)]
    command: McpCommands,
}

#[derive(Subcommand)]
enum McpCommands {
    Serve,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct ListCapsInput {
    #[serde(default)]
    scope: Option<String>,
    #[serde(default)]
    organization_id: Option<String>,
    #[serde(default)]
    folder_id: Option<String>,
    #[serde(default)]
    search: Option<String>,
    #[serde(default)]
    updated_after: Option<String>,
    #[serde(default)]
    cursor: Option<String>,
    #[serde(default)]
    limit: Option<u16>,
}

fn list_caps_path(input: ListCapsInput) -> Result<String, AgentApiError> {
    let scope = input.scope.unwrap_or_else(|| "all".to_string());
    if !matches!(scope.as_str(), "all" | "owned" | "shared") {
        return Err(AgentApiError {
            code: "INVALID_REQUEST".to_string(),
            message: "scope must be all, owned, or shared".to_string(),
            retryable: false,
            retry_after_ms: None,
            request_id: None,
        });
    }
    let limit = input.limit.unwrap_or(50);
    if !(1..=100).contains(&limit) {
        return Err(AgentApiError {
            code: "INVALID_REQUEST".to_string(),
            message: "limit must be between 1 and 100".to_string(),
            retryable: false,
            retry_after_ms: None,
            request_id: None,
        });
    }
    let mut query = url::form_urlencoded::Serializer::new(String::new());
    query.append_pair("scope", &scope);
    query.append_pair("limit", &limit.to_string());
    for (key, value) in [
        ("organizationId", input.organization_id),
        ("folderId", input.folder_id),
        ("search", input.search),
        ("updatedAfter", input.updated_after),
        ("cursor", input.cursor),
    ] {
        if let Some(value) = value {
            query.append_pair(key, &value);
        }
    }
    Ok(format!("/caps?{}", query.finish()))
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct CapInput {
    cap: String,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct WaitInput {
    cap: String,
    #[serde(default)]
    wait_for: Option<String>,
    #[serde(default)]
    timeout_seconds: Option<u64>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct ProcessInput {
    cap: String,
    #[serde(default)]
    target: Option<String>,
    #[serde(default)]
    retry: bool,
    confirmed: bool,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct LoomImportInput {
    loom_url: String,
    organization_id: String,
    #[serde(default)]
    owner_email: Option<String>,
    #[serde(default)]
    space_name: Option<String>,
    confirmed: bool,
}

#[derive(Debug, Deserialize, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
struct TranscriptCueInput {
    start_ms: u64,
    end_ms: u64,
    text: String,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct TranscriptReplaceInput {
    cap: String,
    expected_revision: String,
    cues: Vec<TranscriptCueInput>,
    confirmed: bool,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct CapOperationInput {
    cap: String,
    confirmed: bool,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct OperationInput {
    operation_id: String,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct OperationWaitInput {
    operation_id: String,
    #[serde(default)]
    timeout_seconds: Option<u64>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct FeedbackInput {
    cap: String,
    content: String,
    #[serde(default)]
    timestamp_ms: Option<u64>,
    confirmed: bool,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct ReplyInput {
    cap: String,
    comment_id: String,
    content: String,
    #[serde(default)]
    timestamp_ms: Option<u64>,
    confirmed: bool,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct TitleInput {
    cap: String,
    title: String,
    confirmed: bool,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct VisibilityInput {
    cap: String,
    public: bool,
    confirmed: bool,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct OrganizationInput {
    organization_id: String,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct OrganizationCreateInput {
    name: String,
    confirmed: bool,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct OrganizationActionInput {
    organization_id: String,
    confirmed: bool,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct OrganizationBillingCheckoutInput {
    organization_id: String,
    #[serde(default)]
    interval: Option<String>,
    #[serde(default)]
    quantity: Option<u32>,
    confirmed: bool,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct OrganizationStorageProviderInput {
    organization_id: String,
    provider: String,
    confirmed: bool,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct OrganizationGoogleDriveFoldersInput {
    organization_id: String,
    #[serde(default)]
    parent_id: Option<String>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct OrganizationGoogleDriveLocationInput {
    organization_id: String,
    folder_id: String,
    #[serde(default)]
    folder_name: Option<String>,
    #[serde(default)]
    drive_id: Option<String>,
    #[serde(default)]
    drive_name: Option<String>,
    confirmed: bool,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct OrganizationUpdateInput {
    organization_id: String,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    allowed_email_domain: Option<String>,
    #[serde(default)]
    clear_allowed_email_domain: bool,
    confirmed: bool,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct OrganizationSettingsInput {
    organization_id: String,
    #[serde(default)]
    disable_summary: Option<bool>,
    #[serde(default)]
    disable_captions: Option<bool>,
    #[serde(default)]
    disable_chapters: Option<bool>,
    #[serde(default)]
    disable_reactions: Option<bool>,
    #[serde(default)]
    disable_transcript: Option<bool>,
    #[serde(default)]
    disable_comments: Option<bool>,
    #[serde(default)]
    hide_shareable_link_cap_logo: Option<bool>,
    #[serde(default)]
    shareable_link_use_organization_icon: Option<bool>,
    #[serde(default)]
    ai_generation_language: Option<String>,
    #[serde(default)]
    default_playback_speed: Option<f64>,
    confirmed: bool,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct OrganizationInviteAddInput {
    organization_id: String,
    email: String,
    #[serde(default)]
    role: Option<String>,
    #[serde(default)]
    send_email: Option<bool>,
    confirmed: bool,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct OrganizationInviteRemoveInput {
    organization_id: String,
    invite_id: String,
    confirmed: bool,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct OrganizationMemberRoleInput {
    organization_id: String,
    member_id: String,
    role: String,
    confirmed: bool,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct OrganizationMemberSeatInput {
    organization_id: String,
    member_id: String,
    enabled: bool,
    confirmed: bool,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct OrganizationMemberRemoveInput {
    organization_id: String,
    member_id: String,
    confirmed: bool,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct OrganizationDeleteInput {
    organization_id: String,
    confirmed: bool,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct OrganizationDomainSetInput {
    organization_id: String,
    domain: String,
    confirmed: bool,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct OrganizationDomainInput {
    organization_id: String,
    confirmed: bool,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct SpaceInput {
    space_id: String,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct DeveloperAppInput {
    app_id: String,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct DeveloperVideoListInput {
    app_id: String,
    #[serde(default)]
    user_id: Option<String>,
    #[serde(default)]
    cursor: Option<String>,
    #[serde(default)]
    limit: Option<u16>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct DeveloperVideoDeleteInput {
    app_id: String,
    video_id: String,
    confirmed: bool,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct DeveloperTransactionListInput {
    app_id: String,
    #[serde(default)]
    cursor: Option<String>,
    #[serde(default)]
    limit: Option<u16>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct DeveloperAppUpdateInput {
    app_id: String,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    environment: Option<String>,
    #[serde(default)]
    logo_url: Option<String>,
    #[serde(default)]
    clear_logo: bool,
    confirmed: bool,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct DeveloperAppDeleteInput {
    app_id: String,
    confirmed: bool,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct DeveloperDomainAddInput {
    app_id: String,
    domain: String,
    confirmed: bool,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct DeveloperDomainRemoveInput {
    app_id: String,
    domain_id: String,
    confirmed: bool,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct DeveloperAutoTopUpInput {
    app_id: String,
    enabled: bool,
    #[serde(default)]
    threshold_micro_credits: Option<u64>,
    #[serde(default)]
    amount_cents: Option<u32>,
    confirmed: bool,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct DeveloperCreditsCheckoutInput {
    app_id: String,
    amount_cents: u32,
    confirmed: bool,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct FolderListInput {
    organization_id: String,
    #[serde(default)]
    space_id: Option<String>,
    #[serde(default)]
    parent_id: Option<String>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct NotificationListInput {
    #[serde(default)]
    unread: Option<bool>,
    #[serde(default)]
    cursor: Option<String>,
    #[serde(default)]
    limit: Option<u16>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct AnalyticsInput {
    organization_id: String,
    #[serde(default)]
    space_id: Option<String>,
    #[serde(default)]
    cap_id: Option<String>,
    #[serde(default)]
    range: Option<String>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct AccountUpdateInput {
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    last_name: Option<String>,
    #[serde(default)]
    default_organization_id: Option<String>,
    confirmed: bool,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct AccountReferralsInput {
    confirmed: bool,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct NotificationPreferencesInput {
    #[serde(default)]
    pause_comments: Option<bool>,
    #[serde(default)]
    pause_replies: Option<bool>,
    #[serde(default)]
    pause_views: Option<bool>,
    #[serde(default)]
    pause_reactions: Option<bool>,
    #[serde(default)]
    pause_anonymous_views: Option<bool>,
    confirmed: bool,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct NotificationsReadInput {
    #[serde(default)]
    ids: Vec<String>,
    #[serde(default)]
    all: bool,
    confirmed: bool,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct CapSettingsUpdateInput {
    cap: String,
    #[serde(default)]
    disable_summary: Option<bool>,
    #[serde(default)]
    disable_captions: Option<bool>,
    #[serde(default)]
    disable_chapters: Option<bool>,
    #[serde(default)]
    disable_reactions: Option<bool>,
    #[serde(default)]
    disable_transcript: Option<bool>,
    #[serde(default)]
    disable_comments: Option<bool>,
    #[serde(default)]
    default_playback_speed: Option<f64>,
    confirmed: bool,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct CapMoveInput {
    cap: String,
    container: String,
    organization_id: String,
    #[serde(default)]
    space_id: Option<String>,
    #[serde(default)]
    folder_id: Option<String>,
    confirmed: bool,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct CapShareInput {
    cap: String,
    target_type: String,
    target_id: String,
    #[serde(default)]
    folder_id: Option<String>,
    #[serde(default)]
    remove: bool,
    confirmed: bool,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct FolderCreateInput {
    organization_id: String,
    name: String,
    #[serde(default)]
    color: Option<String>,
    #[serde(default)]
    parent_id: Option<String>,
    #[serde(default)]
    space_id: Option<String>,
    #[serde(default)]
    public: bool,
    confirmed: bool,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct FolderUpdateInput {
    folder_id: String,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    color: Option<String>,
    #[serde(default)]
    parent_id: Option<String>,
    #[serde(default)]
    move_to_root: bool,
    #[serde(default)]
    public: Option<bool>,
    confirmed: bool,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct FolderDeleteInput {
    folder_id: String,
    confirmed: bool,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct CollectionPublicPageInput {
    kind: String,
    collection_id: String,
    #[serde(default)]
    public: Option<bool>,
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    subtitle: Option<String>,
    #[serde(default)]
    hide_title: Option<bool>,
    #[serde(default)]
    hide_copy_link: Option<bool>,
    #[serde(default)]
    logo_mode: Option<String>,
    #[serde(default)]
    cta_label: Option<String>,
    #[serde(default)]
    cta_url: Option<String>,
    #[serde(default)]
    layout: Option<String>,
    #[serde(default)]
    grid_columns: Option<u8>,
    confirmed: bool,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct SpaceCreateInput {
    organization_id: String,
    name: String,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    privacy: Option<String>,
    #[serde(default)]
    public: bool,
    confirmed: bool,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct SpaceUpdateInput {
    space_id: String,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    privacy: Option<String>,
    #[serde(default)]
    public: Option<bool>,
    confirmed: bool,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct SpaceDeleteInput {
    space_id: String,
    confirmed: bool,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct SpaceMemberMutationInput {
    space_id: String,
    user_id: String,
    action: String,
    #[serde(default)]
    role: Option<String>,
    confirmed: bool,
}

#[derive(Clone)]
struct CapMcpServer {
    client: AgentClient,
    tool_router: ToolRouter<Self>,
}

impl CapMcpServer {
    fn new(client: AgentClient) -> Self {
        Self {
            client,
            tool_router: Self::tool_router(),
        }
    }

    fn result(result: Result<Value, AgentApiError>) -> CallToolResult {
        match result {
            Ok(value) => CallToolResult::structured(value),
            Err(mut error) => {
                if error.code == "PASSWORD_REQUIRED" {
                    error.message = format!(
                        "{} Run `cap caps unlock` in a secure terminal; MCP never accepts passwords.",
                        error.message
                    );
                }
                CallToolResult::structured_error(serde_json::to_value(error).unwrap_or_else(|_| {
                    json!({
                        "code": "TEMPORARY_UNAVAILABLE",
                        "message": "The Cap response could not be represented",
                        "retryable": true,
                    })
                }))
            }
        }
    }

    fn require_confirmation(confirmed: bool, action: &str) -> Option<CallToolResult> {
        (!confirmed).then(|| {
            Self::result(Err(AgentApiError {
                code: "APPROVAL_REQUIRED".to_string(),
                message: format!(
                    "Ask the user to confirm before you {action}, then retry with confirmed=true"
                ),
                retryable: false,
                retry_after_ms: None,
                request_id: None,
            }))
        })
    }

    fn invalid(message: impl Into<String>) -> AgentApiError {
        AgentApiError {
            code: "INVALID_REQUEST".to_string(),
            message: message.into(),
            retryable: false,
            retry_after_ms: None,
            request_id: None,
        }
    }

    async fn wait(
        &self,
        input: WaitInput,
        context: &rmcp::service::RequestContext<RoleServer>,
    ) -> Result<Value, AgentApiError> {
        let id = cap_id(&input.cap)?;
        let timeout = input.timeout_seconds.unwrap_or(600);
        if timeout == 0 || timeout > 86_400 {
            return Err(AgentApiError {
                code: "INVALID_REQUEST".to_string(),
                message: "timeoutSeconds must be between 1 and 86400".to_string(),
                retryable: false,
                retry_after_ms: None,
                request_id: None,
            });
        }
        let wait_for = input.wait_for.as_deref().unwrap_or("all");
        if !matches!(wait_for, "transcript" | "ai" | "all") {
            return Err(AgentApiError {
                code: "INVALID_REQUEST".to_string(),
                message: "waitFor must be transcript, ai, or all".to_string(),
                retryable: false,
                retry_after_ms: None,
                request_id: None,
            });
        }
        let deadline = tokio::time::Instant::now() + Duration::from_secs(timeout);
        let status_path = format!("/caps/{id}/status");
        let mut attempt = 0_u32;
        loop {
            let status = tokio::select! {
                _ = context.ct.cancelled() => return Err(AgentApiError {
                    code: "TEMPORARY_UNAVAILABLE".to_string(),
                    message: "The MCP request was cancelled".to_string(),
                    retryable: false,
                    retry_after_ms: None,
                    request_id: None,
                }),
                result = self.client.get_json(&status_path) => result?,
            };
            let state = |key: &str| {
                status
                    .get(key)
                    .and_then(|value| value.get("status"))
                    .and_then(Value::as_str)
            };
            let terminal = |key| {
                matches!(
                    state(key),
                    Some("complete" | "skipped" | "no_audio" | "unavailable")
                )
            };
            let failed = match wait_for {
                "transcript" => state("transcript") == Some("error"),
                "ai" => state("ai") == Some("error"),
                _ => state("transcript") == Some("error") || state("ai") == Some("error"),
            };
            if failed {
                return Err(AgentApiError {
                    code: "NOT_READY".to_string(),
                    message: "Cap processing failed".to_string(),
                    retryable: false,
                    retry_after_ms: None,
                    request_id: None,
                });
            }
            let complete = match wait_for {
                "transcript" => terminal("transcript"),
                "ai" => terminal("ai"),
                _ => terminal("transcript") && terminal("ai"),
            };
            if complete {
                return Ok(status);
            }
            if tokio::time::Instant::now() >= deadline {
                return Err(AgentApiError {
                    code: "NOT_READY".to_string(),
                    message: "Timed out waiting for Cap processing".to_string(),
                    retryable: true,
                    retry_after_ms: Some(2_000),
                    request_id: None,
                });
            }
            let delay = 500_u64.saturating_mul(1_u64 << attempt.min(4));
            tokio::select! {
                _ = context.ct.cancelled() => return Err(AgentApiError {
                    code: "TEMPORARY_UNAVAILABLE".to_string(),
                    message: "The MCP request was cancelled".to_string(),
                    retryable: false,
                    retry_after_ms: None,
                    request_id: None,
                }),
                () = tokio::time::sleep(Duration::from_millis(delay.min(10_000))) => {}
            }
            attempt = attempt.saturating_add(1);
        }
    }

    async fn wait_operation(
        &self,
        input: OperationWaitInput,
        context: &rmcp::service::RequestContext<RoleServer>,
    ) -> Result<Value, AgentApiError> {
        let operation_id = opaque_id(&input.operation_id, "Operation ID")?;
        let timeout = input.timeout_seconds.unwrap_or(600);
        if timeout == 0 || timeout > 86_400 {
            return Err(Self::invalid("timeoutSeconds must be between 1 and 86400"));
        }
        let deadline = tokio::time::Instant::now() + Duration::from_secs(timeout);
        let path = format!("/operations/{operation_id}");
        let mut attempt = 0_u32;
        loop {
            let operation = tokio::select! {
                _ = context.ct.cancelled() => return Err(Self::invalid("The MCP request was cancelled")),
                result = self.client.get_json(&path) => result?,
            };
            match operation.get("state").and_then(Value::as_str) {
                Some("succeeded") => return Ok(operation),
                Some("failed") => {
                    return Err(AgentApiError {
                        code: "OPERATION_FAILED".to_string(),
                        message: operation
                            .get("error")
                            .and_then(|error| error.get("message"))
                            .and_then(Value::as_str)
                            .unwrap_or("Cap operation failed")
                            .to_string(),
                        retryable: false,
                        retry_after_ms: None,
                        request_id: operation
                            .get("requestId")
                            .and_then(Value::as_str)
                            .map(str::to_string),
                    });
                }
                Some("queued" | "running") => {}
                _ => return Err(Self::invalid("Cap returned an invalid operation state")),
            }
            if tokio::time::Instant::now() >= deadline {
                return Err(AgentApiError {
                    code: "NOT_READY".to_string(),
                    message: "Timed out waiting for the Cap operation".to_string(),
                    retryable: true,
                    retry_after_ms: Some(2_000),
                    request_id: None,
                });
            }
            let delay = 500_u64.saturating_mul(1_u64 << attempt.min(4));
            tokio::select! {
                _ = context.ct.cancelled() => return Err(Self::invalid("The MCP request was cancelled")),
                () = tokio::time::sleep(Duration::from_millis(delay.min(10_000))) => {}
            }
            attempt = attempt.saturating_add(1);
        }
    }
}

#[tool_router(router = tool_router)]
impl CapMcpServer {
    #[tool(
        name = "caps_list",
        description = "List Caps visible in the authenticated personal library without loading transcripts or media URLs",
        annotations(
            read_only_hint = true,
            destructive_hint = false,
            idempotent_hint = true,
            open_world_hint = true
        )
    )]
    async fn caps_list(&self, Parameters(input): Parameters<ListCapsInput>) -> CallToolResult {
        let path = match list_caps_path(input) {
            Ok(path) => path,
            Err(error) => return Self::result(Err(error)),
        };
        Self::result(self.client.get_json(&path).await)
    }

    #[tool(
        name = "caps_get",
        description = "Get lightweight Cap metadata, processing state, counts, and explicit capabilities",
        annotations(
            read_only_hint = true,
            destructive_hint = false,
            idempotent_hint = true,
            open_world_hint = true
        )
    )]
    async fn caps_get(&self, Parameters(input): Parameters<CapInput>) -> CallToolResult {
        let result = match cap_id(&input.cap) {
            Ok(id) => self.client.get_json(&format!("/caps/{id}")).await,
            Err(error) => Err(error),
        };
        Self::result(result)
    }

    #[tool(
        name = "caps_context",
        description = "Get Cap content and activity. Large transcript and activity fields are returned as cap:// resources",
        annotations(
            read_only_hint = true,
            destructive_hint = false,
            idempotent_hint = true,
            open_world_hint = true
        )
    )]
    async fn caps_context(&self, Parameters(input): Parameters<CapInput>) -> CallToolResult {
        let id = match cap_id(&input.cap) {
            Ok(id) => id,
            Err(error) => return Self::result(Err(error)),
        };
        let mut context = match self.client.get_json(&format!("/caps/{id}/context")).await {
            Ok(context) => context,
            Err(error) => return Self::result(Err(error)),
        };
        let serialized_size = serde_json::to_vec(&context).map_or(0, |value| value.len());
        if serialized_size <= 64 * 1024 {
            return CallToolResult::structured(context);
        }
        let mut links = Vec::new();
        if let Some(object) = context.as_object_mut() {
            for field in ["transcript", "comments", "reactions"] {
                if object.contains_key(field) {
                    let uri = format!("cap://caps/{id}/{field}");
                    object.insert(field.to_string(), json!({ "resourceUri": uri }));
                    links.push(ContentBlock::resource_link(
                        Resource::new(&uri, format!("Cap {field}"))
                            .with_mime_type("application/json"),
                    ));
                }
            }
        }
        let mut result = CallToolResult::structured(context);
        result.content.extend(links);
        result
    }

    #[tool(
        name = "caps_wait",
        description = "Wait for existing transcript or AI processing to finish. This never starts processing",
        annotations(
            read_only_hint = true,
            destructive_hint = false,
            idempotent_hint = true,
            open_world_hint = true
        )
    )]
    async fn caps_wait(
        &self,
        Parameters(input): Parameters<WaitInput>,
        context: rmcp::service::RequestContext<RoleServer>,
    ) -> CallToolResult {
        Self::result(self.wait(input, &context).await)
    }

    #[tool(
        name = "caps_process",
        description = "Explicitly start transcript or AI processing after user confirmation. This may incur paid work; reads and caps_wait never call it",
        annotations(
            read_only_hint = false,
            destructive_hint = false,
            idempotent_hint = false,
            open_world_hint = true
        )
    )]
    async fn caps_process(&self, Parameters(input): Parameters<ProcessInput>) -> CallToolResult {
        if let Some(result) =
            Self::require_confirmation(input.confirmed, "start paid Cap processing")
        {
            return result;
        }
        let id = match cap_id(&input.cap) {
            Ok(id) => id,
            Err(error) => return Self::result(Err(error)),
        };
        let target = input.target.as_deref().unwrap_or("all");
        if !matches!(target, "transcript" | "ai" | "all") {
            return Self::result(Err(Self::invalid("target must be transcript, ai, or all")));
        }
        Self::result(
            self.client
                .mutate_json_confirmed(
                    Method::POST,
                    &format!("/caps/{id}/process"),
                    &json!({ "target": target, "retry": input.retry }),
                )
                .await,
        )
    }

    #[tool(
        name = "caps_import_loom",
        description = "Start a durable Loom import after explicit user confirmation; optional owner_email and space_name provide the per-row primitive for migration batches",
        annotations(
            read_only_hint = false,
            destructive_hint = false,
            idempotent_hint = false,
            open_world_hint = true
        )
    )]
    async fn caps_import_loom(
        &self,
        Parameters(input): Parameters<LoomImportInput>,
    ) -> CallToolResult {
        if let Some(result) = Self::require_confirmation(input.confirmed, "import the Loom video") {
            return result;
        }
        let organization_id = match opaque_id(&input.organization_id, "Organization ID") {
            Ok(id) => id,
            Err(error) => return Self::result(Err(error)),
        };
        Self::result(
            self.client
                .mutate_json_confirmed(
                    Method::POST,
                    &format!("/organizations/{organization_id}/imports/loom"),
                    &json!({
                        "loomUrl": input.loom_url,
                        "ownerEmail": input.owner_email,
                        "spaceName": input.space_name,
                    }),
                )
                .await,
        )
    }

    #[tool(
        name = "caps_transcript_replace",
        description = "Replace transcript cues using the revision from cap://caps/{id}/transcript after explicit user confirmation",
        annotations(
            read_only_hint = false,
            destructive_hint = false,
            idempotent_hint = false,
            open_world_hint = true
        )
    )]
    async fn caps_transcript_replace(
        &self,
        Parameters(input): Parameters<TranscriptReplaceInput>,
    ) -> CallToolResult {
        if let Some(result) = Self::require_confirmation(input.confirmed, "replace this transcript")
        {
            return result;
        }
        let id = match cap_id(&input.cap) {
            Ok(id) => id,
            Err(error) => return Self::result(Err(error)),
        };
        Self::result(
            self.client
                .mutate_json_confirmed(
                    Method::PUT,
                    &format!("/caps/{id}/transcript"),
                    &json!({
                        "expectedRevision": input.expected_revision,
                        "cues": input.cues,
                    }),
                )
                .await,
        )
    }

    #[tool(
        name = "operations_get",
        description = "Get the current state and result of an asynchronous Cap operation",
        annotations(
            read_only_hint = true,
            destructive_hint = false,
            idempotent_hint = true,
            open_world_hint = true
        )
    )]
    async fn operations_get(
        &self,
        Parameters(input): Parameters<OperationInput>,
    ) -> CallToolResult {
        let operation_id = match opaque_id(&input.operation_id, "Operation ID") {
            Ok(id) => id,
            Err(error) => return Self::result(Err(error)),
        };
        Self::result(
            self.client
                .get_json(&format!("/operations/{operation_id}"))
                .await,
        )
    }

    #[tool(
        name = "operations_wait",
        description = "Wait for an existing durable Cap operation to finish without starting new work",
        annotations(
            read_only_hint = true,
            destructive_hint = false,
            idempotent_hint = true,
            open_world_hint = true
        )
    )]
    async fn operations_wait(
        &self,
        Parameters(input): Parameters<OperationWaitInput>,
        context: rmcp::service::RequestContext<RoleServer>,
    ) -> CallToolResult {
        Self::result(self.wait_operation(input, &context).await)
    }

    #[tool(
        name = "caps_duplicate",
        description = "Queue a retry-safe Cap and media duplication after explicit user confirmation",
        annotations(
            read_only_hint = false,
            destructive_hint = false,
            idempotent_hint = false,
            open_world_hint = true
        )
    )]
    async fn caps_duplicate(
        &self,
        Parameters(input): Parameters<CapOperationInput>,
    ) -> CallToolResult {
        if let Some(result) = Self::require_confirmation(input.confirmed, "duplicate this Cap") {
            return result;
        }
        let id = match cap_id(&input.cap) {
            Ok(id) => id,
            Err(error) => return Self::result(Err(error)),
        };
        Self::result(
            self.client
                .mutate_json_confirmed(Method::POST, &format!("/caps/{id}/duplicate"), &json!({}))
                .await,
        )
    }

    #[tool(
        name = "caps_delete",
        description = "Permanently delete a Cap and its media through a retry-safe operation after explicit user confirmation",
        annotations(
            read_only_hint = false,
            destructive_hint = true,
            idempotent_hint = false,
            open_world_hint = true
        )
    )]
    async fn caps_delete(
        &self,
        Parameters(input): Parameters<CapOperationInput>,
    ) -> CallToolResult {
        if let Some(result) =
            Self::require_confirmation(input.confirmed, "permanently delete this Cap and its media")
        {
            return result;
        }
        let id = match cap_id(&input.cap) {
            Ok(id) => id,
            Err(error) => return Self::result(Err(error)),
        };
        Self::result(
            self.client
                .mutate_json_confirmed(Method::DELETE, &format!("/caps/{id}"), &json!({}))
                .await,
        )
    }

    #[tool(
        name = "account_get",
        description = "Get the authenticated Cap account and explicit account capabilities",
        annotations(
            read_only_hint = true,
            destructive_hint = false,
            idempotent_hint = true,
            open_world_hint = true
        )
    )]
    async fn account_get(&self) -> CallToolResult {
        Self::result(self.client.get_json("/me").await)
    }

    #[tool(
        name = "account_referrals_open",
        description = "Create a focused Dub referral-portal browser handoff after explicit user confirmation",
        annotations(
            read_only_hint = false,
            destructive_hint = false,
            idempotent_hint = false,
            open_world_hint = true
        )
    )]
    async fn account_referrals_open(
        &self,
        Parameters(input): Parameters<AccountReferralsInput>,
    ) -> CallToolResult {
        if let Some(result) =
            Self::require_confirmation(input.confirmed, "open the Cap referral portal")
        {
            return result;
        }
        Self::result(
            self.client
                .mutate_json_confirmed(Method::POST, "/me/referrals", &json!({}))
                .await,
        )
    }

    #[tool(
        name = "organizations_list",
        description = "List organizations visible to the authenticated account with roles, plan state, and capabilities",
        annotations(
            read_only_hint = true,
            destructive_hint = false,
            idempotent_hint = true,
            open_world_hint = true
        )
    )]
    async fn organizations_list(&self) -> CallToolResult {
        Self::result(self.client.get_json("/organizations").await)
    }

    #[tool(
        name = "organization_create",
        description = "Create an organization after explicit user confirmation",
        annotations(
            read_only_hint = false,
            destructive_hint = false,
            idempotent_hint = false,
            open_world_hint = true
        )
    )]
    async fn organization_create(
        &self,
        Parameters(input): Parameters<OrganizationCreateInput>,
    ) -> CallToolResult {
        if let Some(result) = Self::require_confirmation(input.confirmed, "create an organization")
        {
            return result;
        }
        Self::result(
            self.client
                .mutate_json_confirmed(
                    Method::POST,
                    "/organizations",
                    &json!({ "name": input.name }),
                )
                .await,
        )
    }

    #[tool(
        name = "organization_get",
        description = "Get one organization and the authenticated account's capabilities in it",
        annotations(
            read_only_hint = true,
            destructive_hint = false,
            idempotent_hint = true,
            open_world_hint = true
        )
    )]
    async fn organization_get(
        &self,
        Parameters(input): Parameters<OrganizationInput>,
    ) -> CallToolResult {
        let id = match opaque_id(&input.organization_id, "Organization ID") {
            Ok(id) => id,
            Err(error) => return Self::result(Err(error)),
        };
        Self::result(self.client.get_json(&format!("/organizations/{id}")).await)
    }

    #[tool(
        name = "organization_members",
        description = "List organization members and member-management capabilities",
        annotations(
            read_only_hint = true,
            destructive_hint = false,
            idempotent_hint = true,
            open_world_hint = true
        )
    )]
    async fn organization_members(
        &self,
        Parameters(input): Parameters<OrganizationInput>,
    ) -> CallToolResult {
        let id = match opaque_id(&input.organization_id, "Organization ID") {
            Ok(id) => id,
            Err(error) => return Self::result(Err(error)),
        };
        Self::result(
            self.client
                .get_json(&format!("/organizations/{id}/members"))
                .await,
        )
    }

    #[tool(
        name = "organization_invites",
        description = "List pending organization invitations without exposing invite secrets",
        annotations(
            read_only_hint = true,
            destructive_hint = false,
            idempotent_hint = true,
            open_world_hint = true
        )
    )]
    async fn organization_invites(
        &self,
        Parameters(input): Parameters<OrganizationInput>,
    ) -> CallToolResult {
        let id = match opaque_id(&input.organization_id, "Organization ID") {
            Ok(id) => id,
            Err(error) => return Self::result(Err(error)),
        };
        Self::result(
            self.client
                .get_json(&format!("/organizations/{id}/invites"))
                .await,
        )
    }

    #[tool(
        name = "organization_billing",
        description = "Get plan, subscription state, seat counts, and billing capabilities without initiating payment",
        annotations(
            read_only_hint = true,
            destructive_hint = false,
            idempotent_hint = true,
            open_world_hint = true
        )
    )]
    async fn organization_billing(
        &self,
        Parameters(input): Parameters<OrganizationInput>,
    ) -> CallToolResult {
        let id = match opaque_id(&input.organization_id, "Organization ID") {
            Ok(id) => id,
            Err(error) => return Self::result(Err(error)),
        };
        Self::result(
            self.client
                .get_json(&format!("/organizations/{id}/billing"))
                .await,
        )
    }

    #[tool(
        name = "organization_billing_checkout",
        description = "Create a Cap Pro checkout URL after explicit user confirmation; the user completes payment in a browser",
        annotations(
            read_only_hint = false,
            destructive_hint = false,
            idempotent_hint = false,
            open_world_hint = true
        )
    )]
    async fn organization_billing_checkout(
        &self,
        Parameters(input): Parameters<OrganizationBillingCheckoutInput>,
    ) -> CallToolResult {
        if let Some(result) =
            Self::require_confirmation(input.confirmed, "create a Cap Pro checkout")
        {
            return result;
        }
        let id = match opaque_id(&input.organization_id, "Organization ID") {
            Ok(id) => id,
            Err(error) => return Self::result(Err(error)),
        };
        let interval = input.interval.unwrap_or_else(|| "yearly".to_string());
        if !matches!(interval.as_str(), "monthly" | "yearly") {
            return Self::result(Err(Self::invalid("interval must be monthly or yearly")));
        }
        let mut body = Map::from_iter([("interval".to_string(), Value::String(interval))]);
        if let Some(quantity) = input.quantity {
            body.insert("quantity".to_string(), Value::from(quantity));
        }
        Self::result(
            self.client
                .mutate_json_confirmed(
                    Method::POST,
                    &format!("/organizations/{id}/billing/checkout"),
                    &Value::Object(body),
                )
                .await,
        )
    }

    #[tool(
        name = "organization_billing_portal",
        description = "Create a Stripe billing-portal URL after explicit user confirmation; the user manages billing in a browser",
        annotations(
            read_only_hint = false,
            destructive_hint = false,
            idempotent_hint = false,
            open_world_hint = true
        )
    )]
    async fn organization_billing_portal(
        &self,
        Parameters(input): Parameters<OrganizationActionInput>,
    ) -> CallToolResult {
        if let Some(result) =
            Self::require_confirmation(input.confirmed, "open the Cap billing portal")
        {
            return result;
        }
        let id = match opaque_id(&input.organization_id, "Organization ID") {
            Ok(id) => id,
            Err(error) => return Self::result(Err(error)),
        };
        Self::result(
            self.client
                .mutate_json_confirmed(
                    Method::POST,
                    &format!("/organizations/{id}/billing/portal"),
                    &json!({}),
                )
                .await,
        )
    }

    #[tool(
        name = "organization_storage_integrations",
        description = "List storage integration metadata and status without returning credentials or signed URLs",
        annotations(
            read_only_hint = true,
            destructive_hint = false,
            idempotent_hint = true,
            open_world_hint = true
        )
    )]
    async fn organization_storage_integrations(
        &self,
        Parameters(input): Parameters<OrganizationInput>,
    ) -> CallToolResult {
        let id = match opaque_id(&input.organization_id, "Organization ID") {
            Ok(id) => id,
            Err(error) => return Self::result(Err(error)),
        };
        Self::result(
            self.client
                .get_json(&format!("/organizations/{id}/storage-integrations"))
                .await,
        )
    }

    #[tool(
        name = "organization_storage_provider_set",
        description = "Select S3 or Google Drive as the active organization storage provider after explicit user confirmation",
        annotations(
            read_only_hint = false,
            destructive_hint = false,
            idempotent_hint = false,
            open_world_hint = true
        )
    )]
    async fn organization_storage_provider_set(
        &self,
        Parameters(input): Parameters<OrganizationStorageProviderInput>,
    ) -> CallToolResult {
        if let Some(result) =
            Self::require_confirmation(input.confirmed, "change the organization storage provider")
        {
            return result;
        }
        if !matches!(input.provider.as_str(), "s3" | "googleDrive") {
            return Self::result(Err(Self::invalid("provider must be s3 or googleDrive")));
        }
        let id = match opaque_id(&input.organization_id, "Organization ID") {
            Ok(id) => id,
            Err(error) => return Self::result(Err(error)),
        };
        Self::result(
            self.client
                .mutate_json_confirmed(
                    Method::PATCH,
                    &format!("/organizations/{id}/storage/provider"),
                    &json!({ "provider": input.provider }),
                )
                .await,
        )
    }

    #[tool(
        name = "organization_google_drive_connect",
        description = "Create a Google Drive authorization URL after explicit user confirmation; the user completes OAuth in a browser",
        annotations(
            read_only_hint = false,
            destructive_hint = false,
            idempotent_hint = false,
            open_world_hint = true
        )
    )]
    async fn organization_google_drive_connect(
        &self,
        Parameters(input): Parameters<OrganizationActionInput>,
    ) -> CallToolResult {
        if let Some(result) =
            Self::require_confirmation(input.confirmed, "connect organization Google Drive")
        {
            return result;
        }
        let id = match opaque_id(&input.organization_id, "Organization ID") {
            Ok(id) => id,
            Err(error) => return Self::result(Err(error)),
        };
        Self::result(
            self.client
                .mutate_json_confirmed(
                    Method::POST,
                    &format!("/organizations/{id}/storage/google-drive/connect"),
                    &json!({}),
                )
                .await,
        )
    }

    #[tool(
        name = "organization_google_drive_folders",
        description = "List Google Drive folders available to an organization without returning OAuth credentials",
        annotations(
            read_only_hint = true,
            destructive_hint = false,
            idempotent_hint = true,
            open_world_hint = true
        )
    )]
    async fn organization_google_drive_folders(
        &self,
        Parameters(input): Parameters<OrganizationGoogleDriveFoldersInput>,
    ) -> CallToolResult {
        let id = match opaque_id(&input.organization_id, "Organization ID") {
            Ok(id) => id,
            Err(error) => return Self::result(Err(error)),
        };
        let query = {
            let mut serializer = url::form_urlencoded::Serializer::new(String::new());
            if let Some(parent_id) = input.parent_id {
                serializer.append_pair("parentId", &parent_id);
            }
            serializer.finish()
        };
        let path = if query.is_empty() {
            format!("/organizations/{id}/storage/google-drive/folders")
        } else {
            format!("/organizations/{id}/storage/google-drive/folders?{query}")
        };
        Self::result(self.client.get_json(&path).await)
    }

    #[tool(
        name = "organization_google_drive_location_set",
        description = "Set the Google Drive folder used by an organization after explicit user confirmation",
        annotations(
            read_only_hint = false,
            destructive_hint = false,
            idempotent_hint = false,
            open_world_hint = true
        )
    )]
    async fn organization_google_drive_location_set(
        &self,
        Parameters(input): Parameters<OrganizationGoogleDriveLocationInput>,
    ) -> CallToolResult {
        if let Some(result) = Self::require_confirmation(
            input.confirmed,
            "change the organization Google Drive location",
        ) {
            return result;
        }
        let id = match opaque_id(&input.organization_id, "Organization ID") {
            Ok(id) => id,
            Err(error) => return Self::result(Err(error)),
        };
        Self::result(
            self.client
                .mutate_json_confirmed(
                    Method::PUT,
                    &format!("/organizations/{id}/storage/google-drive/location"),
                    &json!({
                        "folderId": input.folder_id,
                        "folderName": input.folder_name,
                        "driveId": input.drive_id,
                        "driveName": input.drive_name,
                    }),
                )
                .await,
        )
    }

    #[tool(
        name = "organization_google_drive_disconnect",
        description = "Disconnect Google Drive from an organization after explicit user confirmation",
        annotations(
            read_only_hint = false,
            destructive_hint = true,
            idempotent_hint = false,
            open_world_hint = true
        )
    )]
    async fn organization_google_drive_disconnect(
        &self,
        Parameters(input): Parameters<OrganizationActionInput>,
    ) -> CallToolResult {
        if let Some(result) =
            Self::require_confirmation(input.confirmed, "disconnect organization Google Drive")
        {
            return result;
        }
        let id = match opaque_id(&input.organization_id, "Organization ID") {
            Ok(id) => id,
            Err(error) => return Self::result(Err(error)),
        };
        Self::result(
            self.client
                .mutate_json_confirmed(
                    Method::DELETE,
                    &format!("/organizations/{id}/storage/google-drive"),
                    &json!({}),
                )
                .await,
        )
    }

    #[tool(
        name = "organization_update",
        description = "Update an organization name or allowed email domain after explicit user confirmation",
        annotations(
            read_only_hint = false,
            destructive_hint = false,
            idempotent_hint = false,
            open_world_hint = true
        )
    )]
    async fn organization_update(
        &self,
        Parameters(input): Parameters<OrganizationUpdateInput>,
    ) -> CallToolResult {
        if let Some(result) = Self::require_confirmation(input.confirmed, "update the organization")
        {
            return result;
        }
        let id = match opaque_id(&input.organization_id, "Organization ID") {
            Ok(id) => id,
            Err(error) => return Self::result(Err(error)),
        };
        if input.allowed_email_domain.is_some() && input.clear_allowed_email_domain {
            return Self::result(Err(Self::invalid(
                "allowedEmailDomain and clearAllowedEmailDomain cannot both be set",
            )));
        }
        let mut body = Map::new();
        if let Some(name) = input.name {
            body.insert("name".to_string(), Value::String(name));
        }
        if let Some(domain) = input.allowed_email_domain {
            body.insert("allowedEmailDomain".to_string(), Value::String(domain));
        } else if input.clear_allowed_email_domain {
            body.insert("allowedEmailDomain".to_string(), Value::Null);
        }
        if body.is_empty() {
            return Self::result(Err(Self::invalid(
                "name or an allowed email domain change is required",
            )));
        }
        Self::result(
            self.client
                .mutate_json_confirmed(
                    Method::PATCH,
                    &format!("/organizations/{id}"),
                    &Value::Object(body),
                )
                .await,
        )
    }

    #[tool(
        name = "organization_settings_update",
        description = "Update organization content and playback preferences after explicit user confirmation",
        annotations(
            read_only_hint = false,
            destructive_hint = false,
            idempotent_hint = false,
            open_world_hint = true
        )
    )]
    async fn organization_settings_update(
        &self,
        Parameters(input): Parameters<OrganizationSettingsInput>,
    ) -> CallToolResult {
        if let Some(result) =
            Self::require_confirmation(input.confirmed, "update organization preferences")
        {
            return result;
        }
        let id = match opaque_id(&input.organization_id, "Organization ID") {
            Ok(id) => id,
            Err(error) => return Self::result(Err(error)),
        };
        let mut body = Map::new();
        for (key, value) in [
            ("disableSummary", input.disable_summary),
            ("disableCaptions", input.disable_captions),
            ("disableChapters", input.disable_chapters),
            ("disableReactions", input.disable_reactions),
            ("disableTranscript", input.disable_transcript),
            ("disableComments", input.disable_comments),
            (
                "hideShareableLinkCapLogo",
                input.hide_shareable_link_cap_logo,
            ),
            (
                "shareableLinkUseOrganizationIcon",
                input.shareable_link_use_organization_icon,
            ),
        ] {
            if let Some(value) = value {
                body.insert(key.to_string(), Value::Bool(value));
            }
        }
        if let Some(language) = input.ai_generation_language {
            body.insert("aiGenerationLanguage".to_string(), Value::String(language));
        }
        if let Some(speed) = input.default_playback_speed {
            let Some(speed) = serde_json::Number::from_f64(speed) else {
                return Self::result(Err(Self::invalid("defaultPlaybackSpeed must be finite")));
            };
            body.insert("defaultPlaybackSpeed".to_string(), Value::Number(speed));
        }
        if body.is_empty() {
            return Self::result(Err(Self::invalid(
                "at least one organization preference is required",
            )));
        }
        Self::result(
            self.client
                .mutate_json_confirmed(
                    Method::PATCH,
                    &format!("/organizations/{id}/settings"),
                    &Value::Object(body),
                )
                .await,
        )
    }

    #[tool(
        name = "organization_invite_add",
        description = "Create an organization invite and deliver its email by default after explicit user confirmation; set send_email=false for link-only provisioning",
        annotations(
            read_only_hint = false,
            destructive_hint = false,
            idempotent_hint = false,
            open_world_hint = true
        )
    )]
    async fn organization_invite_add(
        &self,
        Parameters(input): Parameters<OrganizationInviteAddInput>,
    ) -> CallToolResult {
        if let Some(result) =
            Self::require_confirmation(input.confirmed, "create the organization invite")
        {
            return result;
        }
        let id = match opaque_id(&input.organization_id, "Organization ID") {
            Ok(id) => id,
            Err(error) => return Self::result(Err(error)),
        };
        let role = input.role.as_deref().unwrap_or("member");
        if !matches!(role, "admin" | "member") {
            return Self::result(Err(Self::invalid("role must be admin or member")));
        }
        Self::result(
            self.client
                .mutate_json_confirmed(
                    Method::POST,
                    &format!("/organizations/{id}/invites"),
                    &json!({
                        "email": input.email,
                        "role": role,
                        "sendEmail": input.send_email.unwrap_or(true),
                    }),
                )
                .await,
        )
    }

    #[tool(
        name = "organization_invite_remove",
        description = "Remove a pending organization invite after explicit user confirmation",
        annotations(
            read_only_hint = false,
            destructive_hint = true,
            idempotent_hint = false,
            open_world_hint = true
        )
    )]
    async fn organization_invite_remove(
        &self,
        Parameters(input): Parameters<OrganizationInviteRemoveInput>,
    ) -> CallToolResult {
        if let Some(result) =
            Self::require_confirmation(input.confirmed, "remove the organization invite")
        {
            return result;
        }
        let id = match opaque_id(&input.organization_id, "Organization ID") {
            Ok(id) => id,
            Err(error) => return Self::result(Err(error)),
        };
        let invite_id = match opaque_id(&input.invite_id, "Invite ID") {
            Ok(id) => id,
            Err(error) => return Self::result(Err(error)),
        };
        Self::result(
            self.client
                .mutate_json_confirmed(
                    Method::DELETE,
                    &format!("/organizations/{id}/invites/{invite_id}"),
                    &json!({}),
                )
                .await,
        )
    }

    #[tool(
        name = "organization_member_role",
        description = "Change an organization member role after explicit user confirmation",
        annotations(
            read_only_hint = false,
            destructive_hint = false,
            idempotent_hint = false,
            open_world_hint = true
        )
    )]
    async fn organization_member_role(
        &self,
        Parameters(input): Parameters<OrganizationMemberRoleInput>,
    ) -> CallToolResult {
        if let Some(result) =
            Self::require_confirmation(input.confirmed, "change the organization member role")
        {
            return result;
        }
        let id = match opaque_id(&input.organization_id, "Organization ID") {
            Ok(id) => id,
            Err(error) => return Self::result(Err(error)),
        };
        let member_id = match opaque_id(&input.member_id, "Member ID") {
            Ok(id) => id,
            Err(error) => return Self::result(Err(error)),
        };
        if !matches!(input.role.as_str(), "admin" | "member") {
            return Self::result(Err(Self::invalid("role must be admin or member")));
        }
        Self::result(
            self.client
                .mutate_json_confirmed(
                    Method::PATCH,
                    &format!("/organizations/{id}/members/{member_id}"),
                    &json!({ "role": input.role }),
                )
                .await,
        )
    }

    #[tool(
        name = "organization_member_seat",
        description = "Assign or remove an organization member Pro seat after explicit user confirmation",
        annotations(
            read_only_hint = false,
            destructive_hint = false,
            idempotent_hint = false,
            open_world_hint = true
        )
    )]
    async fn organization_member_seat(
        &self,
        Parameters(input): Parameters<OrganizationMemberSeatInput>,
    ) -> CallToolResult {
        if let Some(result) =
            Self::require_confirmation(input.confirmed, "change the organization member Pro seat")
        {
            return result;
        }
        let id = match opaque_id(&input.organization_id, "Organization ID") {
            Ok(id) => id,
            Err(error) => return Self::result(Err(error)),
        };
        let member_id = match opaque_id(&input.member_id, "Member ID") {
            Ok(id) => id,
            Err(error) => return Self::result(Err(error)),
        };
        Self::result(
            self.client
                .mutate_json_confirmed(
                    Method::PATCH,
                    &format!("/organizations/{id}/members/{member_id}/seat"),
                    &json!({ "enabled": input.enabled }),
                )
                .await,
        )
    }

    #[tool(
        name = "organization_member_remove",
        description = "Remove an organization member and their space memberships after explicit user confirmation",
        annotations(
            read_only_hint = false,
            destructive_hint = true,
            idempotent_hint = false,
            open_world_hint = true
        )
    )]
    async fn organization_member_remove(
        &self,
        Parameters(input): Parameters<OrganizationMemberRemoveInput>,
    ) -> CallToolResult {
        if let Some(result) =
            Self::require_confirmation(input.confirmed, "remove the organization member")
        {
            return result;
        }
        let id = match opaque_id(&input.organization_id, "Organization ID") {
            Ok(id) => id,
            Err(error) => return Self::result(Err(error)),
        };
        let member_id = match opaque_id(&input.member_id, "Member ID") {
            Ok(id) => id,
            Err(error) => return Self::result(Err(error)),
        };
        Self::result(
            self.client
                .mutate_json_confirmed(
                    Method::DELETE,
                    &format!("/organizations/{id}/members/{member_id}"),
                    &json!({}),
                )
                .await,
        )
    }

    #[tool(
        name = "organization_delete",
        description = "Permanently delete an organization and all of its Caps after explicit user confirmation; returns an asynchronous operation",
        annotations(
            read_only_hint = false,
            destructive_hint = true,
            idempotent_hint = false,
            open_world_hint = true
        )
    )]
    async fn organization_delete(
        &self,
        Parameters(input): Parameters<OrganizationDeleteInput>,
    ) -> CallToolResult {
        if let Some(result) = Self::require_confirmation(
            input.confirmed,
            "permanently delete the organization and all of its Caps",
        ) {
            return result;
        }
        let id = match opaque_id(&input.organization_id, "Organization ID") {
            Ok(id) => id,
            Err(error) => return Self::result(Err(error)),
        };
        Self::result(
            self.client
                .mutate_json_confirmed(Method::DELETE, &format!("/organizations/{id}"), &json!({}))
                .await,
        )
    }

    #[tool(
        name = "organization_domain_set",
        description = "Configure an organization custom domain after explicit user confirmation; returns an asynchronous operation",
        annotations(
            read_only_hint = false,
            destructive_hint = false,
            idempotent_hint = false,
            open_world_hint = true
        )
    )]
    async fn organization_domain_set(
        &self,
        Parameters(input): Parameters<OrganizationDomainSetInput>,
    ) -> CallToolResult {
        if let Some(result) =
            Self::require_confirmation(input.confirmed, "set the organization custom domain")
        {
            return result;
        }
        let id = match opaque_id(&input.organization_id, "Organization ID") {
            Ok(id) => id,
            Err(error) => return Self::result(Err(error)),
        };
        Self::result(
            self.client
                .mutate_json_confirmed(
                    Method::PUT,
                    &format!("/organizations/{id}/domain"),
                    &json!({ "domain": input.domain }),
                )
                .await,
        )
    }

    #[tool(
        name = "organization_domain_remove",
        description = "Remove an organization custom domain after explicit user confirmation; returns an asynchronous operation",
        annotations(
            read_only_hint = false,
            destructive_hint = true,
            idempotent_hint = false,
            open_world_hint = true
        )
    )]
    async fn organization_domain_remove(
        &self,
        Parameters(input): Parameters<OrganizationDomainInput>,
    ) -> CallToolResult {
        if let Some(result) =
            Self::require_confirmation(input.confirmed, "remove the organization custom domain")
        {
            return result;
        }
        let id = match opaque_id(&input.organization_id, "Organization ID") {
            Ok(id) => id,
            Err(error) => return Self::result(Err(error)),
        };
        Self::result(
            self.client
                .mutate_json_confirmed(
                    Method::DELETE,
                    &format!("/organizations/{id}/domain"),
                    &json!({}),
                )
                .await,
        )
    }

    #[tool(
        name = "organization_domain_verify",
        description = "Recheck organization custom-domain DNS and verification after explicit user confirmation; returns an asynchronous operation",
        annotations(
            read_only_hint = false,
            destructive_hint = false,
            idempotent_hint = false,
            open_world_hint = true
        )
    )]
    async fn organization_domain_verify(
        &self,
        Parameters(input): Parameters<OrganizationDomainInput>,
    ) -> CallToolResult {
        if let Some(result) =
            Self::require_confirmation(input.confirmed, "verify the organization custom domain")
        {
            return result;
        }
        let id = match opaque_id(&input.organization_id, "Organization ID") {
            Ok(id) => id,
            Err(error) => return Self::result(Err(error)),
        };
        Self::result(
            self.client
                .mutate_json_confirmed(
                    Method::POST,
                    &format!("/organizations/{id}/domain/verify"),
                    &json!({}),
                )
                .await,
        )
    }

    #[tool(
        name = "folders_list",
        description = "List folders in a personal, organization, or space container",
        annotations(
            read_only_hint = true,
            destructive_hint = false,
            idempotent_hint = true,
            open_world_hint = true
        )
    )]
    async fn folders_list(&self, Parameters(input): Parameters<FolderListInput>) -> CallToolResult {
        let organization = match opaque_id(&input.organization_id, "Organization ID") {
            Ok(id) => id,
            Err(error) => return Self::result(Err(error)),
        };
        let path = {
            let mut query = url::form_urlencoded::Serializer::new(String::new());
            if let Some(space_id) = input.space_id {
                query.append_pair("spaceId", &space_id);
            }
            if let Some(parent_id) = input.parent_id {
                query.append_pair("parentId", &parent_id);
            }
            format!("/organizations/{organization}/folders?{}", query.finish())
        };
        Self::result(self.client.get_json(&path).await)
    }

    #[tool(
        name = "spaces_list",
        description = "List spaces visible in an organization with counts, roles, and capabilities",
        annotations(
            read_only_hint = true,
            destructive_hint = false,
            idempotent_hint = true,
            open_world_hint = true
        )
    )]
    async fn spaces_list(
        &self,
        Parameters(input): Parameters<OrganizationInput>,
    ) -> CallToolResult {
        let id = match opaque_id(&input.organization_id, "Organization ID") {
            Ok(id) => id,
            Err(error) => return Self::result(Err(error)),
        };
        Self::result(
            self.client
                .get_json(&format!("/organizations/{id}/spaces"))
                .await,
        )
    }

    #[tool(
        name = "space_members",
        description = "List members and roles for a visible space",
        annotations(
            read_only_hint = true,
            destructive_hint = false,
            idempotent_hint = true,
            open_world_hint = true
        )
    )]
    async fn space_members(&self, Parameters(input): Parameters<SpaceInput>) -> CallToolResult {
        let id = match opaque_id(&input.space_id, "Space ID") {
            Ok(id) => id,
            Err(error) => return Self::result(Err(error)),
        };
        Self::result(self.client.get_json(&format!("/spaces/{id}/members")).await)
    }

    #[tool(
        name = "notifications_list",
        description = "List notifications for the authenticated recipient with cursor pagination",
        annotations(
            read_only_hint = true,
            destructive_hint = false,
            idempotent_hint = true,
            open_world_hint = true
        )
    )]
    async fn notifications_list(
        &self,
        Parameters(input): Parameters<NotificationListInput>,
    ) -> CallToolResult {
        let limit = input.limit.unwrap_or(50);
        if !(1..=100).contains(&limit) {
            return Self::result(Err(AgentApiError {
                code: "INVALID_REQUEST".to_string(),
                message: "limit must be between 1 and 100".to_string(),
                retryable: false,
                retry_after_ms: None,
                request_id: None,
            }));
        }
        let path = {
            let mut query = url::form_urlencoded::Serializer::new(String::new());
            query.append_pair("limit", &limit.to_string());
            if let Some(unread) = input.unread {
                query.append_pair("unread", if unread { "true" } else { "false" });
            }
            if let Some(cursor) = input.cursor {
                query.append_pair("cursor", &cursor);
            }
            format!("/me/notifications?{}", query.finish())
        };
        Self::result(self.client.get_json(&path).await)
    }

    #[tool(
        name = "notification_preferences_get",
        description = "Get notification preferences for the authenticated account",
        annotations(
            read_only_hint = true,
            destructive_hint = false,
            idempotent_hint = true,
            open_world_hint = true
        )
    )]
    async fn notification_preferences_get(&self) -> CallToolResult {
        Self::result(self.client.get_json("/me/notification-preferences").await)
    }

    #[tool(
        name = "analytics_get",
        description = "Get tenant-bound organization, space, or Cap analytics for an explicit time range",
        annotations(
            read_only_hint = true,
            destructive_hint = false,
            idempotent_hint = true,
            open_world_hint = true
        )
    )]
    async fn analytics_get(&self, Parameters(input): Parameters<AnalyticsInput>) -> CallToolResult {
        let range = input.range.unwrap_or_else(|| "month".to_string());
        if !matches!(range.as_str(), "day" | "week" | "month" | "year") {
            return Self::result(Err(AgentApiError {
                code: "INVALID_REQUEST".to_string(),
                message: "range must be day, week, month, or year".to_string(),
                retryable: false,
                retry_after_ms: None,
                request_id: None,
            }));
        }
        let path = {
            let mut query = url::form_urlencoded::Serializer::new(String::new());
            query.append_pair("organizationId", &input.organization_id);
            query.append_pair("range", &range);
            if let Some(space_id) = input.space_id {
                query.append_pair("spaceId", &space_id);
            }
            if let Some(cap_id) = input.cap_id {
                query.append_pair("capId", &cap_id);
            }
            format!("/analytics?{}", query.finish())
        };
        Self::result(self.client.get_json(&path).await)
    }

    #[tool(
        name = "developer_apps_list",
        description = "List developer apps without returning API key material",
        annotations(
            read_only_hint = true,
            destructive_hint = false,
            idempotent_hint = true,
            open_world_hint = true
        )
    )]
    async fn developer_apps_list(&self) -> CallToolResult {
        Self::result(self.client.get_json("/developer/apps").await)
    }

    #[tool(
        name = "developer_app_context",
        description = "Get developer app domains, key metadata, usage, storage, and credits without exposing secrets",
        annotations(
            read_only_hint = true,
            destructive_hint = false,
            idempotent_hint = true,
            open_world_hint = true
        )
    )]
    async fn developer_app_context(
        &self,
        Parameters(input): Parameters<DeveloperAppInput>,
    ) -> CallToolResult {
        let id = match opaque_id(&input.app_id, "Developer app ID") {
            Ok(id) => id,
            Err(error) => return Self::result(Err(error)),
        };
        Self::result(
            self.client
                .get_json(&format!("/developer/apps/{id}/context"))
                .await,
        )
    }

    #[tool(
        name = "developer_videos_list",
        description = "List SDK videos for a developer app with cursor pagination and an optional external user ID filter",
        annotations(
            read_only_hint = true,
            destructive_hint = false,
            idempotent_hint = true,
            open_world_hint = true
        )
    )]
    async fn developer_videos_list(
        &self,
        Parameters(input): Parameters<DeveloperVideoListInput>,
    ) -> CallToolResult {
        let id = match opaque_id(&input.app_id, "Developer app ID") {
            Ok(id) => id,
            Err(error) => return Self::result(Err(error)),
        };
        let limit = input.limit.unwrap_or(50);
        if !(1..=100).contains(&limit) {
            return Self::result(Err(Self::invalid("limit must be between 1 and 100")));
        }
        let query = {
            let mut serializer = url::form_urlencoded::Serializer::new(String::new());
            serializer.append_pair("limit", &limit.to_string());
            if let Some(user_id) = input.user_id {
                serializer.append_pair("userId", &user_id);
            }
            if let Some(cursor) = input.cursor {
                serializer.append_pair("cursor", &cursor);
            }
            serializer.finish()
        };
        Self::result(
            self.client
                .get_json(&format!("/developer/apps/{id}/videos?{query}"))
                .await,
        )
    }

    #[tool(
        name = "developer_transactions_list",
        description = "List developer credit transactions with cursor pagination",
        annotations(
            read_only_hint = true,
            destructive_hint = false,
            idempotent_hint = true,
            open_world_hint = true
        )
    )]
    async fn developer_transactions_list(
        &self,
        Parameters(input): Parameters<DeveloperTransactionListInput>,
    ) -> CallToolResult {
        let id = match opaque_id(&input.app_id, "Developer app ID") {
            Ok(id) => id,
            Err(error) => return Self::result(Err(error)),
        };
        let limit = input.limit.unwrap_or(50);
        if !(1..=100).contains(&limit) {
            return Self::result(Err(Self::invalid("limit must be between 1 and 100")));
        }
        let query = {
            let mut serializer = url::form_urlencoded::Serializer::new(String::new());
            serializer.append_pair("limit", &limit.to_string());
            if let Some(cursor) = input.cursor {
                serializer.append_pair("cursor", &cursor);
            }
            serializer.finish()
        };
        Self::result(
            self.client
                .get_json(&format!("/developer/apps/{id}/transactions?{query}"))
                .await,
        )
    }

    #[tool(
        name = "developer_video_delete",
        description = "Delete an SDK video from a developer app after explicit user confirmation",
        annotations(
            read_only_hint = false,
            destructive_hint = true,
            idempotent_hint = false,
            open_world_hint = true
        )
    )]
    async fn developer_video_delete(
        &self,
        Parameters(input): Parameters<DeveloperVideoDeleteInput>,
    ) -> CallToolResult {
        if let Some(result) =
            Self::require_confirmation(input.confirmed, "delete the developer SDK video")
        {
            return result;
        }
        let id = match opaque_id(&input.app_id, "Developer app ID") {
            Ok(id) => id,
            Err(error) => return Self::result(Err(error)),
        };
        let video_id = match opaque_id(&input.video_id, "Developer video ID") {
            Ok(id) => id,
            Err(error) => return Self::result(Err(error)),
        };
        Self::result(
            self.client
                .mutate_json_confirmed(
                    Method::DELETE,
                    &format!("/developer/apps/{id}/videos/{video_id}"),
                    &json!({}),
                )
                .await,
        )
    }

    #[tool(
        name = "developer_app_update",
        description = "Update developer app metadata after explicit user confirmation",
        annotations(
            read_only_hint = false,
            destructive_hint = false,
            idempotent_hint = false,
            open_world_hint = true
        )
    )]
    async fn developer_app_update(
        &self,
        Parameters(input): Parameters<DeveloperAppUpdateInput>,
    ) -> CallToolResult {
        if let Some(result) =
            Self::require_confirmation(input.confirmed, "update the developer app")
        {
            return result;
        }
        let id = match opaque_id(&input.app_id, "Developer app ID") {
            Ok(id) => id,
            Err(error) => return Self::result(Err(error)),
        };
        if input.logo_url.is_some() && input.clear_logo {
            return Self::result(Err(Self::invalid(
                "logoUrl and clearLogo cannot both be set",
            )));
        }
        let mut body = Map::new();
        if let Some(name) = input.name {
            body.insert("name".to_string(), Value::String(name));
        }
        if let Some(environment) = input.environment {
            if !matches!(environment.as_str(), "development" | "production") {
                return Self::result(Err(Self::invalid(
                    "environment must be development or production",
                )));
            }
            body.insert("environment".to_string(), Value::String(environment));
        }
        if let Some(logo_url) = input.logo_url {
            body.insert("logoUrl".to_string(), Value::String(logo_url));
        } else if input.clear_logo {
            body.insert("logoUrl".to_string(), Value::Null);
        }
        if body.is_empty() {
            return Self::result(Err(Self::invalid(
                "at least one developer app update is required",
            )));
        }
        Self::result(
            self.client
                .mutate_json_confirmed(
                    Method::PATCH,
                    &format!("/developer/apps/{id}"),
                    &Value::Object(body),
                )
                .await,
        )
    }

    #[tool(
        name = "developer_app_delete",
        description = "Delete a developer app and revoke its keys after explicit user confirmation",
        annotations(
            read_only_hint = false,
            destructive_hint = true,
            idempotent_hint = false,
            open_world_hint = true
        )
    )]
    async fn developer_app_delete(
        &self,
        Parameters(input): Parameters<DeveloperAppDeleteInput>,
    ) -> CallToolResult {
        if let Some(result) = Self::require_confirmation(
            input.confirmed,
            "delete the developer app and revoke its keys",
        ) {
            return result;
        }
        let id = match opaque_id(&input.app_id, "Developer app ID") {
            Ok(id) => id,
            Err(error) => return Self::result(Err(error)),
        };
        Self::result(
            self.client
                .mutate_json_confirmed(Method::DELETE, &format!("/developer/apps/{id}"), &json!({}))
                .await,
        )
    }

    #[tool(
        name = "developer_domain_add",
        description = "Add an allowed origin to a developer app after explicit user confirmation",
        annotations(
            read_only_hint = false,
            destructive_hint = false,
            idempotent_hint = false,
            open_world_hint = true
        )
    )]
    async fn developer_domain_add(
        &self,
        Parameters(input): Parameters<DeveloperDomainAddInput>,
    ) -> CallToolResult {
        if let Some(result) =
            Self::require_confirmation(input.confirmed, "add the developer app domain")
        {
            return result;
        }
        let id = match opaque_id(&input.app_id, "Developer app ID") {
            Ok(id) => id,
            Err(error) => return Self::result(Err(error)),
        };
        Self::result(
            self.client
                .mutate_json_confirmed(
                    Method::POST,
                    &format!("/developer/apps/{id}/domains"),
                    &json!({ "domain": input.domain }),
                )
                .await,
        )
    }

    #[tool(
        name = "developer_domain_remove",
        description = "Remove an allowed origin from a developer app after explicit user confirmation",
        annotations(
            read_only_hint = false,
            destructive_hint = true,
            idempotent_hint = false,
            open_world_hint = true
        )
    )]
    async fn developer_domain_remove(
        &self,
        Parameters(input): Parameters<DeveloperDomainRemoveInput>,
    ) -> CallToolResult {
        if let Some(result) =
            Self::require_confirmation(input.confirmed, "remove the developer app domain")
        {
            return result;
        }
        let id = match opaque_id(&input.app_id, "Developer app ID") {
            Ok(id) => id,
            Err(error) => return Self::result(Err(error)),
        };
        let domain_id = match opaque_id(&input.domain_id, "Developer domain ID") {
            Ok(id) => id,
            Err(error) => return Self::result(Err(error)),
        };
        Self::result(
            self.client
                .mutate_json_confirmed(
                    Method::DELETE,
                    &format!("/developer/apps/{id}/domains/{domain_id}"),
                    &json!({}),
                )
                .await,
        )
    }

    #[tool(
        name = "developer_auto_top_up_update",
        description = "Configure future automatic developer credit purchases after explicit user confirmation",
        annotations(
            read_only_hint = false,
            destructive_hint = false,
            idempotent_hint = false,
            open_world_hint = true
        )
    )]
    async fn developer_auto_top_up_update(
        &self,
        Parameters(input): Parameters<DeveloperAutoTopUpInput>,
    ) -> CallToolResult {
        if let Some(result) = Self::require_confirmation(
            input.confirmed,
            "change automatic developer credit purchases",
        ) {
            return result;
        }
        let id = match opaque_id(&input.app_id, "Developer app ID") {
            Ok(id) => id,
            Err(error) => return Self::result(Err(error)),
        };
        let mut body = Map::from_iter([("enabled".to_string(), Value::Bool(input.enabled))]);
        if let Some(value) = input.threshold_micro_credits {
            body.insert("thresholdMicroCredits".to_string(), Value::from(value));
        }
        if let Some(value) = input.amount_cents {
            body.insert("amountCents".to_string(), Value::from(value));
        }
        Self::result(
            self.client
                .mutate_json_confirmed(
                    Method::PATCH,
                    &format!("/developer/apps/{id}/auto-top-up"),
                    &Value::Object(body),
                )
                .await,
        )
    }

    #[tool(
        name = "developer_credits_checkout",
        description = "Create a developer-credit purchase URL after explicit user confirmation; the user completes payment in a browser",
        annotations(
            read_only_hint = false,
            destructive_hint = false,
            idempotent_hint = false,
            open_world_hint = true
        )
    )]
    async fn developer_credits_checkout(
        &self,
        Parameters(input): Parameters<DeveloperCreditsCheckoutInput>,
    ) -> CallToolResult {
        if let Some(result) =
            Self::require_confirmation(input.confirmed, "create a developer credit checkout")
        {
            return result;
        }
        let id = match opaque_id(&input.app_id, "Developer app ID") {
            Ok(id) => id,
            Err(error) => return Self::result(Err(error)),
        };
        Self::result(
            self.client
                .mutate_json_confirmed(
                    Method::POST,
                    &format!("/developer/apps/{id}/credits/checkout"),
                    &json!({ "amountCents": input.amount_cents }),
                )
                .await,
        )
    }

    #[tool(
        name = "account_update",
        description = "Update account profile fields after explicit user confirmation",
        annotations(
            read_only_hint = false,
            destructive_hint = false,
            idempotent_hint = false,
            open_world_hint = true
        )
    )]
    async fn account_update(
        &self,
        Parameters(input): Parameters<AccountUpdateInput>,
    ) -> CallToolResult {
        if let Some(result) = Self::require_confirmation(input.confirmed, "update the account") {
            return result;
        }
        let mut body = Map::new();
        if let Some(name) = input.name {
            body.insert("name".to_string(), Value::String(name));
        }
        if let Some(last_name) = input.last_name {
            body.insert("lastName".to_string(), Value::String(last_name));
        }
        if let Some(organization_id) = input.default_organization_id {
            body.insert(
                "defaultOrganizationId".to_string(),
                Value::String(organization_id),
            );
        }
        Self::result(
            self.client
                .mutate_json(Method::PATCH, "/me", &Value::Object(body))
                .await,
        )
    }

    #[tool(
        name = "notification_preferences_update",
        description = "Update notification preferences after explicit user confirmation",
        annotations(
            read_only_hint = false,
            destructive_hint = false,
            idempotent_hint = false,
            open_world_hint = true
        )
    )]
    async fn notification_preferences_update(
        &self,
        Parameters(input): Parameters<NotificationPreferencesInput>,
    ) -> CallToolResult {
        if let Some(result) =
            Self::require_confirmation(input.confirmed, "update notification preferences")
        {
            return result;
        }
        let mut body = Map::new();
        for (key, value) in [
            ("pauseComments", input.pause_comments),
            ("pauseReplies", input.pause_replies),
            ("pauseViews", input.pause_views),
            ("pauseReactions", input.pause_reactions),
            ("pauseAnonymousViews", input.pause_anonymous_views),
        ] {
            if let Some(value) = value {
                body.insert(key.to_string(), Value::Bool(value));
            }
        }
        Self::result(
            self.client
                .mutate_json_confirmed(
                    Method::PATCH,
                    "/me/notification-preferences",
                    &Value::Object(body),
                )
                .await,
        )
    }

    #[tool(
        name = "notifications_mark_read",
        description = "Mark selected or all notifications read after explicit user confirmation",
        annotations(
            read_only_hint = false,
            destructive_hint = false,
            idempotent_hint = false,
            open_world_hint = true
        )
    )]
    async fn notifications_mark_read(
        &self,
        Parameters(input): Parameters<NotificationsReadInput>,
    ) -> CallToolResult {
        if let Some(result) =
            Self::require_confirmation(input.confirmed, "mark notifications as read")
        {
            return result;
        }
        Self::result(
            self.client
                .mutate_json_confirmed(
                    Method::POST,
                    "/me/notifications/read",
                    &json!({ "ids": input.ids, "all": input.all }),
                )
                .await,
        )
    }

    #[tool(
        name = "caps_settings_get",
        description = "Get Cap viewer-setting overrides, effective settings, inheritance, and capabilities",
        annotations(
            read_only_hint = true,
            destructive_hint = false,
            idempotent_hint = true,
            open_world_hint = true
        )
    )]
    async fn caps_settings_get(&self, Parameters(input): Parameters<CapInput>) -> CallToolResult {
        let id = match cap_id(&input.cap) {
            Ok(id) => id,
            Err(error) => return Self::result(Err(error)),
        };
        Self::result(self.client.get_json(&format!("/caps/{id}/settings")).await)
    }

    #[tool(
        name = "caps_settings_update",
        description = "Update Cap viewer settings after explicit user confirmation",
        annotations(
            read_only_hint = false,
            destructive_hint = false,
            idempotent_hint = false,
            open_world_hint = true
        )
    )]
    async fn caps_settings_update(
        &self,
        Parameters(input): Parameters<CapSettingsUpdateInput>,
    ) -> CallToolResult {
        if let Some(result) =
            Self::require_confirmation(input.confirmed, "update these Cap viewer settings")
        {
            return result;
        }
        let id = match cap_id(&input.cap) {
            Ok(id) => id,
            Err(error) => return Self::result(Err(error)),
        };
        let mut body = Map::new();
        for (key, value) in [
            ("disableSummary", input.disable_summary),
            ("disableCaptions", input.disable_captions),
            ("disableChapters", input.disable_chapters),
            ("disableReactions", input.disable_reactions),
            ("disableTranscript", input.disable_transcript),
            ("disableComments", input.disable_comments),
        ] {
            if let Some(value) = value {
                body.insert(key.to_string(), Value::Bool(value));
            }
        }
        if let Some(speed) = input.default_playback_speed {
            body.insert("defaultPlaybackSpeed".to_string(), json!(speed));
        }
        if body.is_empty() {
            return Self::result(Err(Self::invalid("Provide at least one Cap setting")));
        }
        Self::result(
            self.client
                .mutate_json_confirmed(
                    Method::PATCH,
                    &format!("/caps/{id}/settings"),
                    &Value::Object(body),
                )
                .await,
        )
    }

    #[tool(
        name = "caps_shares_get",
        description = "Get explicit organization and space sharing targets for an owned Cap",
        annotations(
            read_only_hint = true,
            destructive_hint = false,
            idempotent_hint = true,
            open_world_hint = true
        )
    )]
    async fn caps_shares_get(&self, Parameters(input): Parameters<CapInput>) -> CallToolResult {
        let id = match cap_id(&input.cap) {
            Ok(id) => id,
            Err(error) => return Self::result(Err(error)),
        };
        Self::result(self.client.get_json(&format!("/caps/{id}/shares")).await)
    }

    #[tool(
        name = "caps_move",
        description = "Move an owned Cap within its personal, organization, or space container after explicit user confirmation",
        annotations(
            read_only_hint = false,
            destructive_hint = false,
            idempotent_hint = false,
            open_world_hint = true
        )
    )]
    async fn caps_move(&self, Parameters(input): Parameters<CapMoveInput>) -> CallToolResult {
        if let Some(result) = Self::require_confirmation(input.confirmed, "move this Cap") {
            return result;
        }
        if !matches!(
            input.container.as_str(),
            "personal" | "organization" | "space"
        ) {
            return Self::result(Err(Self::invalid(
                "container must be personal, organization, or space",
            )));
        }
        let id = match cap_id(&input.cap) {
            Ok(id) => id,
            Err(error) => return Self::result(Err(error)),
        };
        Self::result(
            self.client
                .mutate_json(
                    Method::PATCH,
                    &format!("/caps/{id}/location"),
                    &json!({
                        "container": input.container,
                        "organizationId": input.organization_id,
                        "spaceId": input.space_id,
                        "folderId": input.folder_id,
                    }),
                )
                .await,
        )
    }

    #[tool(
        name = "caps_share_set",
        description = "Add, update, or remove an organization or space share after explicit user confirmation",
        annotations(
            read_only_hint = false,
            destructive_hint = false,
            idempotent_hint = false,
            open_world_hint = true
        )
    )]
    async fn caps_share_set(&self, Parameters(input): Parameters<CapShareInput>) -> CallToolResult {
        if let Some(result) = Self::require_confirmation(input.confirmed, "change this Cap share") {
            return result;
        }
        let segment = match input.target_type.as_str() {
            "organization" => "organizations",
            "space" => "spaces",
            _ => {
                return Self::result(Err(Self::invalid(
                    "targetType must be organization or space",
                )));
            }
        };
        let id = match cap_id(&input.cap) {
            Ok(id) => id,
            Err(error) => return Self::result(Err(error)),
        };
        let target = match opaque_id(&input.target_id, "Share target ID") {
            Ok(id) => id,
            Err(error) => return Self::result(Err(error)),
        };
        Self::result(
            self.client
                .mutate_json(
                    if input.remove {
                        Method::DELETE
                    } else {
                        Method::PUT
                    },
                    &format!("/caps/{id}/shares/{segment}/{target}"),
                    &json!({ "folderId": input.folder_id }),
                )
                .await,
        )
    }

    #[tool(
        name = "folder_create",
        description = "Create a folder in an explicit personal, organization, or space container after user confirmation",
        annotations(
            read_only_hint = false,
            destructive_hint = false,
            idempotent_hint = false,
            open_world_hint = true
        )
    )]
    async fn folder_create(
        &self,
        Parameters(input): Parameters<FolderCreateInput>,
    ) -> CallToolResult {
        if let Some(result) = Self::require_confirmation(input.confirmed, "create this folder") {
            return result;
        }
        let color = input.color.unwrap_or_else(|| "normal".to_string());
        if !matches!(color.as_str(), "normal" | "blue" | "red" | "yellow") {
            return Self::result(Err(Self::invalid(
                "color must be normal, blue, red, or yellow",
            )));
        }
        let organization = match opaque_id(&input.organization_id, "Organization ID") {
            Ok(id) => id,
            Err(error) => return Self::result(Err(error)),
        };
        Self::result(
            self.client
                .mutate_json(
                    Method::POST,
                    &format!("/organizations/{organization}/folders"),
                    &json!({
                        "name": input.name,
                        "color": color,
                        "parentId": input.parent_id,
                        "spaceId": input.space_id,
                        "public": input.public,
                    }),
                )
                .await,
        )
    }

    #[tool(
        name = "folder_update",
        description = "Update or move a folder after explicit user confirmation",
        annotations(
            read_only_hint = false,
            destructive_hint = false,
            idempotent_hint = false,
            open_world_hint = true
        )
    )]
    async fn folder_update(
        &self,
        Parameters(input): Parameters<FolderUpdateInput>,
    ) -> CallToolResult {
        if let Some(result) = Self::require_confirmation(input.confirmed, "update this folder") {
            return result;
        }
        if let Some(color) = input.color.as_deref()
            && !matches!(color, "normal" | "blue" | "red" | "yellow")
        {
            return Self::result(Err(Self::invalid(
                "color must be normal, blue, red, or yellow",
            )));
        }
        let folder = match opaque_id(&input.folder_id, "Folder ID") {
            Ok(id) => id,
            Err(error) => return Self::result(Err(error)),
        };
        let mut body = Map::new();
        if let Some(name) = input.name {
            body.insert("name".to_string(), Value::String(name));
        }
        if let Some(color) = input.color {
            body.insert("color".to_string(), Value::String(color));
        }
        if input.move_to_root {
            body.insert("parentId".to_string(), Value::Null);
        } else if let Some(parent_id) = input.parent_id {
            body.insert("parentId".to_string(), Value::String(parent_id));
        }
        if let Some(public) = input.public {
            body.insert("public".to_string(), Value::Bool(public));
        }
        if body.is_empty() {
            return Self::result(Err(Self::invalid("Provide at least one folder update")));
        }
        Self::result(
            self.client
                .mutate_json(
                    Method::PATCH,
                    &format!("/folders/{folder}"),
                    &Value::Object(body),
                )
                .await,
        )
    }

    #[tool(
        name = "collection_public_page_update",
        description = "Update a folder or space public page and visibility after explicit user confirmation",
        annotations(
            read_only_hint = false,
            destructive_hint = false,
            idempotent_hint = false,
            open_world_hint = true
        )
    )]
    async fn collection_public_page_update(
        &self,
        Parameters(input): Parameters<CollectionPublicPageInput>,
    ) -> CallToolResult {
        if let Some(result) =
            Self::require_confirmation(input.confirmed, "update the public collection page")
        {
            return result;
        }
        if !matches!(input.kind.as_str(), "folder" | "space") {
            return Self::result(Err(Self::invalid("kind must be folder or space")));
        }
        if input
            .logo_mode
            .as_deref()
            .is_some_and(|value| !matches!(value, "cap" | "organization" | "custom" | "none"))
        {
            return Self::result(Err(Self::invalid(
                "logoMode must be cap, organization, custom, or none",
            )));
        }
        if input
            .layout
            .as_deref()
            .is_some_and(|value| !matches!(value, "grid" | "list"))
        {
            return Self::result(Err(Self::invalid("layout must be grid or list")));
        }
        if input
            .grid_columns
            .is_some_and(|value| !(2..=5).contains(&value))
        {
            return Self::result(Err(Self::invalid("gridColumns must be between 2 and 5")));
        }
        let id = match opaque_id(&input.collection_id, "Collection ID") {
            Ok(id) => id,
            Err(error) => return Self::result(Err(error)),
        };
        let mut body = Map::new();
        for (key, value) in [
            ("public", input.public.map(Value::Bool)),
            ("title", input.title.map(Value::String)),
            ("subtitle", input.subtitle.map(Value::String)),
            ("hideTitle", input.hide_title.map(Value::Bool)),
            ("hideCopyLink", input.hide_copy_link.map(Value::Bool)),
            ("logoMode", input.logo_mode.map(Value::String)),
            ("ctaLabel", input.cta_label.map(Value::String)),
            ("ctaUrl", input.cta_url.map(Value::String)),
            ("layout", input.layout.map(Value::String)),
            ("gridColumns", input.grid_columns.map(Value::from)),
        ] {
            if let Some(value) = value {
                body.insert(key.to_string(), value);
            }
        }
        if body.is_empty() {
            return Self::result(Err(Self::invalid(
                "at least one public page update is required",
            )));
        }
        let kind = if input.kind == "folder" {
            "folders"
        } else {
            "spaces"
        };
        Self::result(
            self.client
                .mutate_json_confirmed(
                    Method::PATCH,
                    &format!("/{kind}/{id}/public-page"),
                    &Value::Object(body),
                )
                .await,
        )
    }

    #[tool(
        name = "folder_delete",
        description = "Delete a folder and move contained Caps to its parent after explicit user confirmation",
        annotations(
            read_only_hint = false,
            destructive_hint = true,
            idempotent_hint = false,
            open_world_hint = true
        )
    )]
    async fn folder_delete(
        &self,
        Parameters(input): Parameters<FolderDeleteInput>,
    ) -> CallToolResult {
        if let Some(result) = Self::require_confirmation(input.confirmed, "delete this folder") {
            return result;
        }
        let folder = match opaque_id(&input.folder_id, "Folder ID") {
            Ok(id) => id,
            Err(error) => return Self::result(Err(error)),
        };
        Self::result(
            self.client
                .mutate_json(Method::DELETE, &format!("/folders/{folder}"), &json!({}))
                .await,
        )
    }

    #[tool(
        name = "space_create",
        description = "Create a space after explicit user confirmation",
        annotations(
            read_only_hint = false,
            destructive_hint = false,
            idempotent_hint = false,
            open_world_hint = true
        )
    )]
    async fn space_create(
        &self,
        Parameters(input): Parameters<SpaceCreateInput>,
    ) -> CallToolResult {
        if let Some(result) = Self::require_confirmation(input.confirmed, "create this space") {
            return result;
        }
        let privacy = input.privacy.unwrap_or_else(|| "Private".to_string());
        if !matches!(privacy.as_str(), "Public" | "Private") {
            return Self::result(Err(Self::invalid("privacy must be Public or Private")));
        }
        let organization = match opaque_id(&input.organization_id, "Organization ID") {
            Ok(id) => id,
            Err(error) => return Self::result(Err(error)),
        };
        Self::result(
            self.client
                .mutate_json(
                    Method::POST,
                    &format!("/organizations/{organization}/spaces"),
                    &json!({
                        "name": input.name,
                        "description": input.description,
                        "privacy": privacy,
                        "public": input.public,
                    }),
                )
                .await,
        )
    }

    #[tool(
        name = "space_update",
        description = "Update a space after explicit user confirmation",
        annotations(
            read_only_hint = false,
            destructive_hint = false,
            idempotent_hint = false,
            open_world_hint = true
        )
    )]
    async fn space_update(
        &self,
        Parameters(input): Parameters<SpaceUpdateInput>,
    ) -> CallToolResult {
        if let Some(result) = Self::require_confirmation(input.confirmed, "update this space") {
            return result;
        }
        if let Some(privacy) = input.privacy.as_deref()
            && !matches!(privacy, "Public" | "Private")
        {
            return Self::result(Err(Self::invalid("privacy must be Public or Private")));
        }
        let space = match opaque_id(&input.space_id, "Space ID") {
            Ok(id) => id,
            Err(error) => return Self::result(Err(error)),
        };
        let mut body = Map::new();
        if let Some(name) = input.name {
            body.insert("name".to_string(), Value::String(name));
        }
        if let Some(description) = input.description {
            body.insert("description".to_string(), Value::String(description));
        }
        if let Some(privacy) = input.privacy {
            body.insert("privacy".to_string(), Value::String(privacy));
        }
        if let Some(public) = input.public {
            body.insert("public".to_string(), Value::Bool(public));
        }
        if body.is_empty() {
            return Self::result(Err(Self::invalid("Provide at least one space update")));
        }
        Self::result(
            self.client
                .mutate_json(
                    Method::PATCH,
                    &format!("/spaces/{space}"),
                    &Value::Object(body),
                )
                .await,
        )
    }

    #[tool(
        name = "space_delete",
        description = "Permanently delete a non-primary space after explicit user confirmation",
        annotations(
            read_only_hint = false,
            destructive_hint = true,
            idempotent_hint = false,
            open_world_hint = true
        )
    )]
    async fn space_delete(
        &self,
        Parameters(input): Parameters<SpaceDeleteInput>,
    ) -> CallToolResult {
        if let Some(result) = Self::require_confirmation(input.confirmed, "delete this space") {
            return result;
        }
        let space = match opaque_id(&input.space_id, "Space ID") {
            Ok(id) => id,
            Err(error) => return Self::result(Err(error)),
        };
        Self::result(
            self.client
                .mutate_json(Method::DELETE, &format!("/spaces/{space}"), &json!({}))
                .await,
        )
    }

    #[tool(
        name = "space_member_set",
        description = "Add, update, or remove a space member after explicit user confirmation",
        annotations(
            read_only_hint = false,
            destructive_hint = false,
            idempotent_hint = false,
            open_world_hint = true
        )
    )]
    async fn space_member_set(
        &self,
        Parameters(input): Parameters<SpaceMemberMutationInput>,
    ) -> CallToolResult {
        if let Some(result) =
            Self::require_confirmation(input.confirmed, "change this space member")
        {
            return result;
        }
        let space = match opaque_id(&input.space_id, "Space ID") {
            Ok(id) => id,
            Err(error) => return Self::result(Err(error)),
        };
        let user = match opaque_id(&input.user_id, "User ID") {
            Ok(id) => id,
            Err(error) => return Self::result(Err(error)),
        };
        let (method, path, body) = match input.action.as_str() {
            "add" => (
                Method::POST,
                format!("/spaces/{space}/members"),
                json!({ "userId": user, "role": input.role.unwrap_or_else(|| "member".to_string()) }),
            ),
            "update" => {
                let Some(role) = input.role else {
                    return Self::result(Err(Self::invalid(
                        "role is required when action is update",
                    )));
                };
                (
                    Method::PATCH,
                    format!("/spaces/{space}/members/{user}"),
                    json!({ "role": role }),
                )
            }
            "remove" => (
                Method::DELETE,
                format!("/spaces/{space}/members/{user}"),
                json!({}),
            ),
            _ => {
                return Self::result(Err(Self::invalid("action must be add, update, or remove")));
            }
        };
        Self::result(self.client.mutate_json(method, &path, &body).await)
    }

    #[tool(
        name = "caps_comment",
        description = "Post a comment after explicit user confirmation",
        annotations(
            read_only_hint = false,
            destructive_hint = false,
            idempotent_hint = false,
            open_world_hint = true
        )
    )]
    async fn caps_comment(&self, Parameters(input): Parameters<FeedbackInput>) -> CallToolResult {
        if let Some(result) = Self::require_confirmation(input.confirmed, "post this comment") {
            return result;
        }
        let id = match cap_id(&input.cap) {
            Ok(id) => id,
            Err(error) => return Self::result(Err(error)),
        };
        Self::result(
            self.client
                .mutate_json_confirmed(
                    Method::POST,
                    &format!("/caps/{id}/comments"),
                    &json!({ "content": input.content, "timestampMs": input.timestamp_ms }),
                )
                .await,
        )
    }

    #[tool(
        name = "caps_reply",
        description = "Reply to a comment after explicit user confirmation",
        annotations(
            read_only_hint = false,
            destructive_hint = false,
            idempotent_hint = false,
            open_world_hint = true
        )
    )]
    async fn caps_reply(&self, Parameters(input): Parameters<ReplyInput>) -> CallToolResult {
        if let Some(result) = Self::require_confirmation(input.confirmed, "post this reply") {
            return result;
        }
        let id = match cap_id(&input.cap) {
            Ok(id) => id,
            Err(error) => return Self::result(Err(error)),
        };
        let comment_id = match opaque_id(&input.comment_id, "Comment ID") {
            Ok(id) => id,
            Err(error) => return Self::result(Err(error)),
        };
        Self::result(
            self.client
                .mutate_json_confirmed(
                    Method::POST,
                    &format!("/caps/{id}/comments/{comment_id}/replies"),
                    &json!({ "content": input.content, "timestampMs": input.timestamp_ms }),
                )
                .await,
        )
    }

    #[tool(
        name = "caps_react",
        description = "Add a reaction after explicit user confirmation",
        annotations(
            read_only_hint = false,
            destructive_hint = false,
            idempotent_hint = false,
            open_world_hint = true
        )
    )]
    async fn caps_react(&self, Parameters(input): Parameters<FeedbackInput>) -> CallToolResult {
        if let Some(result) = Self::require_confirmation(input.confirmed, "post this reaction") {
            return result;
        }
        let id = match cap_id(&input.cap) {
            Ok(id) => id,
            Err(error) => return Self::result(Err(error)),
        };
        Self::result(
            self.client
                .mutate_json_confirmed(
                    Method::POST,
                    &format!("/caps/{id}/reactions"),
                    &json!({ "content": input.content, "timestampMs": input.timestamp_ms }),
                )
                .await,
        )
    }

    #[tool(
        name = "caps_update_title",
        description = "Change a Cap title after explicit user confirmation",
        annotations(
            read_only_hint = false,
            destructive_hint = false,
            idempotent_hint = false,
            open_world_hint = true
        )
    )]
    async fn caps_update_title(&self, Parameters(input): Parameters<TitleInput>) -> CallToolResult {
        if let Some(result) = Self::require_confirmation(input.confirmed, "change this Cap title") {
            return result;
        }
        let id = match cap_id(&input.cap) {
            Ok(id) => id,
            Err(error) => return Self::result(Err(error)),
        };
        Self::result(
            self.client
                .mutate_json_confirmed(
                    Method::PATCH,
                    &format!("/caps/{id}"),
                    &json!({ "title": input.title }),
                )
                .await,
        )
    }

    #[tool(
        name = "caps_set_visibility",
        description = "Set a Cap public or private after explicit user confirmation",
        annotations(
            read_only_hint = false,
            destructive_hint = false,
            idempotent_hint = false,
            open_world_hint = true
        )
    )]
    async fn caps_set_visibility(
        &self,
        Parameters(input): Parameters<VisibilityInput>,
    ) -> CallToolResult {
        if let Some(result) =
            Self::require_confirmation(input.confirmed, "change this Cap visibility")
        {
            return result;
        }
        let id = match cap_id(&input.cap) {
            Ok(id) => id,
            Err(error) => return Self::result(Err(error)),
        };
        Self::result(
            self.client
                .mutate_json_confirmed(
                    Method::PATCH,
                    &format!("/caps/{id}"),
                    &json!({ "public": input.public }),
                )
                .await,
        )
    }
}

#[tool_handler(router = self.tool_router)]
impl ServerHandler for CapMcpServer {
    fn get_info(&self) -> ServerInfo {
        ServerInfo::new(
            ServerCapabilities::builder()
                .enable_tools()
                .enable_resources()
                .build(),
        )
        .with_server_info(Implementation::new("cap", env!("CARGO_PKG_VERSION")))
        .with_instructions(
            "Use Cap resources for large transcript and activity data. Passwords, S3 credentials, image files, and newly issued developer credentials are never accepted or returned by MCP; use the corresponding `cap caps`, `cap organizations`, `cap account`, or `cap developers` command in a secure terminal.",
        )
    }

    async fn list_resource_templates(
        &self,
        _request: Option<PaginatedRequestParams>,
        _context: rmcp::service::RequestContext<RoleServer>,
    ) -> Result<ListResourceTemplatesResult, ErrorData> {
        Ok(ListResourceTemplatesResult::with_all_items(
            ["transcript", "comments", "reactions"]
                .into_iter()
                .map(|field| {
                    ResourceTemplate::new(
                        format!("cap://caps/{{id}}/{field}"),
                        format!("Cap {field}"),
                    )
                    .with_description(format!("Full {field} content for a Cap"))
                    .with_mime_type("application/json")
                })
                .collect(),
        ))
    }

    async fn read_resource(
        &self,
        request: ReadResourceRequestParams,
        _context: rmcp::service::RequestContext<RoleServer>,
    ) -> Result<ReadResourceResult, ErrorData> {
        let url = url::Url::parse(&request.uri)
            .map_err(|_| ErrorData::invalid_params("Invalid Cap resource URI", None))?;
        if url.scheme() != "cap" || url.host_str() != Some("caps") {
            return Err(ErrorData::resource_not_found("Unknown Cap resource", None));
        }
        let segments = url
            .path_segments()
            .map(|segments| segments.filter(|part| !part.is_empty()).collect::<Vec<_>>())
            .unwrap_or_default();
        let [id, field] = segments.as_slice() else {
            return Err(ErrorData::resource_not_found("Unknown Cap resource", None));
        };
        if !matches!(*field, "transcript" | "comments" | "reactions") {
            return Err(ErrorData::resource_not_found("Unknown Cap resource", None));
        }
        let id = cap_id(id).map_err(|error| {
            ErrorData::invalid_params(error.message.clone(), serde_json::to_value(error).ok())
        })?;
        let path = if *field == "transcript" {
            format!("/caps/{id}/transcript?format=json")
        } else {
            format!("/caps/{id}/context")
        };
        let resource = self.client.get_json(&path).await.map_err(|error| {
            let message = if error.code == "PASSWORD_REQUIRED" {
                "PASSWORD_REQUIRED: run `cap caps unlock` in a secure terminal".to_string()
            } else {
                error.to_string()
            };
            ErrorData::invalid_params(message, serde_json::to_value(error).ok())
        })?;
        let content = if *field == "transcript" {
            &resource
        } else {
            resource
                .get(*field)
                .ok_or_else(|| ErrorData::resource_not_found("Cap resource is unavailable", None))?
        };
        let text = serde_json::to_string(content)
            .map_err(|error| ErrorData::internal_error(error.to_string(), None))?;
        Ok(ReadResourceResult::new(vec![
            ResourceContents::text(text, request.uri).with_mime_type("application/json"),
        ]))
    }
}

impl McpArgs {
    pub async fn run(self) -> Result<(), String> {
        match self.command {
            McpCommands::Serve => {
                let client = AgentClient::from_credentials().map_err(|error| error.to_string())?;
                let service = CapMcpServer::new(client)
                    .serve(rmcp::transport::stdio())
                    .await
                    .map_err(|error| error.to_string())?;
                service.waiting().await.map_err(|error| error.to_string())?;
                Ok(())
            }
        }
    }
}
