import { Context, Schema } from "effect";
import {
	HttpApi,
	HttpApiEndpoint,
	HttpApiGroup,
	HttpApiMiddleware,
	OpenApi,
} from "effect/http-api";
import { CommentId } from "./Comment.ts";
import { FolderId } from "./Folder.ts";
import { OrganisationId } from "./Organisation.ts";
import {
	PublicPageSettings,
	PublicPageSettingsUpdate,
} from "./PublicCollection.ts";
import { SpaceIdOrOrganisationId } from "./Space.ts";
import { UploadTarget } from "./Storage.ts";
import { UserId } from "./User.ts";
import { VideoId } from "./Video.ts";

export const AgentScope = Schema.Literals([
	"caps:read",
	"caps:comment",
	"caps:write",
	"profile:read",
	"profile:write",
	"caps:upload",
	"caps:process",
	"caps:delete",
	"library:read",
	"library:write",
	"analytics:read",
	"organizations:read",
	"organizations:manage",
	"organizations:members",
	"notifications:read",
	"notifications:write",
	"integrations:read",
	"integrations:write",
	"billing:read",
	"billing:write",
	"developer:read",
	"developer:write",
	"developer:secrets",
]);
export type AgentScope = typeof AgentScope.Type;

export class AgentPrincipal extends Context.Service<
	AgentPrincipal,
	{
		id: UserId;
		email: string;
		activeOrganizationId: OrganisationId;
		scopes: ReadonlySet<AgentScope>;
		tokenId: string;
		tokenKind: "agent" | "legacy";
		expiresAt: Date | null;
	}
>()("AgentPrincipal") {}

const ErrorFields = {
	message: Schema.String,
	retryable: Schema.Boolean,
	retryAfterMs: Schema.NullOr(Schema.Number),
	requestId: Schema.String,
};

export class AgentBadRequestError extends Schema.TaggedError<AgentBadRequestError>()(
	"AgentBadRequestError",
	{
		...ErrorFields,
		code: Schema.Literal("INVALID_REQUEST"),
	},
	{ httpApiStatus: 400 },
) {}

export class AgentAuthenticationError extends Schema.TaggedError<AgentAuthenticationError>()(
	"AgentAuthenticationError",
	{
		...ErrorFields,
		code: Schema.Literals(["AUTH_REQUIRED", "TOKEN_EXPIRED"]),
	},
	{ httpApiStatus: 401 },
) {}

export class AgentForbiddenError extends Schema.TaggedError<AgentForbiddenError>()(
	"AgentForbiddenError",
	{
		...ErrorFields,
		code: Schema.Literals([
			"FORBIDDEN",
			"PASSWORD_REQUIRED",
			"CONTENT_DISABLED",
		]),
	},
	{ httpApiStatus: 403 },
) {}

export class AgentNotFoundError extends Schema.TaggedError<AgentNotFoundError>()(
	"AgentNotFoundError",
	{
		...ErrorFields,
		code: Schema.Literal("NOT_FOUND"),
	},
	{ httpApiStatus: 404 },
) {}

export class AgentNotReadyError extends Schema.TaggedError<AgentNotReadyError>()(
	"AgentNotReadyError",
	{
		...ErrorFields,
		code: Schema.Literal("NOT_READY"),
	},
	{ httpApiStatus: 409 },
) {}

export class AgentRateLimitedError extends Schema.TaggedError<AgentRateLimitedError>()(
	"AgentRateLimitedError",
	{
		...ErrorFields,
		code: Schema.Literal("RATE_LIMITED"),
	},
	{ httpApiStatus: 429 },
) {}

export class AgentTemporaryUnavailableError extends Schema.TaggedError<AgentTemporaryUnavailableError>()(
	"AgentTemporaryUnavailableError",
	{
		...ErrorFields,
		code: Schema.Literal("TEMPORARY_UNAVAILABLE"),
	},
	{ httpApiStatus: 503 },
) {}

export const AgentApiError = Schema.Union([
	AgentBadRequestError,
	AgentAuthenticationError,
	AgentForbiddenError,
	AgentNotFoundError,
	AgentNotReadyError,
	AgentRateLimitedError,
	AgentTemporaryUnavailableError,
]);

export class AgentConflictError extends Schema.TaggedError<AgentConflictError>()(
	"AgentConflictError",
	{
		...ErrorFields,
		code: Schema.Literals([
			"CONFLICT",
			"IDEMPOTENCY_CONFLICT",
			"OPERATION_IN_PROGRESS",
		]),
	},
	{ httpApiStatus: 409 },
) {}

export class AgentApprovalRequiredError extends Schema.TaggedError<AgentApprovalRequiredError>()(
	"AgentApprovalRequiredError",
	{
		...ErrorFields,
		code: Schema.Literals(["APPROVAL_REQUIRED", "SECURE_INPUT_REQUIRED"]),
		approvalUrl: Schema.NullOr(Schema.String),
	},
	{ httpApiStatus: 428 },
) {}

export class AgentHttpAuthMiddleware extends HttpApiMiddleware.Service<
	AgentHttpAuthMiddleware,
	{ provides: AgentPrincipal }
>()("AgentHttpAuthMiddleware", {
	error: Schema.Union([
		AgentAuthenticationError,
		AgentTemporaryUnavailableError,
	]),
}) {}

export const CapabilityReason = Schema.Literals([
	"CONTENT_DISABLED",
	"NOT_READY",
	"PASSWORD_REQUIRED",
	"OWNER_ONLY",
	"SCOPE_REQUIRED",
]);

export const AgentCapability = Schema.Struct({
	allowed: Schema.Boolean,
	reason: Schema.NullOr(CapabilityReason),
});

export const AgentCapabilities = Schema.Struct({
	view: AgentCapability,
	summary: AgentCapability,
	chapters: AgentCapability,
	transcript: AgentCapability,
	comments: AgentCapability,
	reactions: AgentCapability,
	download: AgentCapability,
	comment: AgentCapability,
	react: AgentCapability,
	editTitle: AgentCapability,
	editVisibility: AgentCapability,
	processTranscript: AgentCapability,
	processAi: AgentCapability,
	editTranscript: AgentCapability,
	editPassword: AgentCapability,
	duplicate: AgentCapability,
	delete: AgentCapability,
});

export const AgentProcessState = Schema.Struct({
	status: Schema.Literals([
		"not_started",
		"queued",
		"processing",
		"complete",
		"error",
		"skipped",
		"no_audio",
		"unavailable",
	]),
	reason: Schema.NullOr(Schema.String),
	retryable: Schema.Boolean,
});

export const AgentCapStatus = Schema.Struct({
	id: VideoId,
	overall: Schema.Literals(["processing", "ready", "partial", "error"]),
	upload: AgentProcessState,
	transcript: AgentProcessState,
	ai: AgentProcessState,
	updatedAt: Schema.String,
});

export const AgentCapSummary = Schema.Struct({
	id: VideoId,
	shareUrl: Schema.String,
	title: Schema.String,
	aiTitle: Schema.NullOr(Schema.String),
	createdAt: Schema.String,
	updatedAt: Schema.String,
	durationMs: Schema.NullOr(Schema.Number),
	owner: Schema.Struct({
		id: UserId,
		name: Schema.NullOr(Schema.String),
	}),
	organizationId: OrganisationId,
	folderId: Schema.NullOr(FolderId),
	access: Schema.Literals(["owned", "shared"]),
	sharing: Schema.Struct({
		public: Schema.Boolean,
		protected: Schema.Boolean,
	}),
	counts: Schema.Struct({
		comments: Schema.Number,
		reactions: Schema.Number,
	}),
	status: AgentCapStatus,
	capabilities: AgentCapabilities,
});

export const AgentCapsListParams = Schema.Struct({
	cursor: Schema.optional(Schema.String),
	limit: Schema.optional(Schema.String),
	scope: Schema.optional(Schema.Literals(["all", "owned", "shared"])),
	organizationId: Schema.optional(Schema.String),
	folderId: Schema.optional(Schema.String),
	search: Schema.optional(Schema.String),
	updatedAfter: Schema.optional(Schema.String),
});

export const AgentCapsListResponse = Schema.Struct({
	caps: Schema.Array(AgentCapSummary),
	nextCursor: Schema.NullOr(Schema.String),
	requestId: Schema.String,
});

export const AgentVideoPath = Schema.Struct({ id: VideoId });

export const AgentChapter = Schema.Struct({
	title: Schema.String,
	startMs: Schema.Number,
});

export const AgentTranscriptCue = Schema.Struct({
	startMs: Schema.Number,
	endMs: Schema.Number,
	text: Schema.String,
});

export const AgentContent = Schema.Struct({
	status: Schema.Literals(["available", "not_ready", "unavailable"]),
	reason: Schema.NullOr(Schema.String),
});

export const AgentTranscriptContent = Schema.Struct({
	...AgentContent.fields,
	text: Schema.NullOr(Schema.String),
	cues: Schema.NullOr(Schema.Array(AgentTranscriptCue)),
});

export const AgentComment = Schema.Struct({
	id: CommentId,
	videoId: VideoId,
	content: Schema.String,
	timestampMs: Schema.NullOr(Schema.Number),
	parentCommentId: Schema.NullOr(CommentId),
	createdAt: Schema.String,
	updatedAt: Schema.String,
	author: Schema.Struct({
		id: UserId,
		name: Schema.NullOr(Schema.String),
	}),
});

export const AgentReaction = Schema.Struct({
	id: CommentId,
	videoId: VideoId,
	content: Schema.String,
	timestampMs: Schema.NullOr(Schema.Number),
	createdAt: Schema.String,
	author: Schema.Struct({
		id: UserId,
		name: Schema.NullOr(Schema.String),
	}),
});

export const AgentCapContext = Schema.Struct({
	cap: AgentCapSummary,
	title: Schema.Struct({
		current: Schema.String,
		ai: Schema.NullOr(Schema.String),
		manuallyEdited: Schema.Boolean,
	}),
	summary: Schema.Struct({
		...AgentContent.fields,
		value: Schema.NullOr(Schema.String),
	}),
	chapters: Schema.Struct({
		...AgentContent.fields,
		value: Schema.NullOr(Schema.Array(AgentChapter)),
	}),
	transcript: AgentTranscriptContent,
	comments: Schema.Struct({
		...AgentContent.fields,
		value: Schema.NullOr(Schema.Array(AgentComment)),
	}),
	reactions: Schema.Struct({
		...AgentContent.fields,
		value: Schema.NullOr(Schema.Array(AgentReaction)),
	}),
	views: Schema.Struct({
		status: Schema.Literals(["available", "unavailable"]),
		aggregate: Schema.NullOr(Schema.Number),
		reason: Schema.NullOr(Schema.String),
	}),
	metadata: Schema.Struct({
		source: Schema.String,
		width: Schema.NullOr(Schema.Number),
		height: Schema.NullOr(Schema.Number),
		fps: Schema.NullOr(Schema.Number),
	}),
	requestId: Schema.String,
});

export const AgentTranscriptParams = Schema.Struct({
	format: Schema.optional(Schema.Literals(["text", "json", "vtt"])),
});

export const AgentTranscriptJsonResponse = Schema.Struct({
	id: VideoId,
	revision: Schema.String,
	cues: Schema.Array(AgentTranscriptCue),
	requestId: Schema.String,
});

export const AgentTranscriptUpdateInput = Schema.Struct({
	expectedRevision: Schema.String,
	cues: Schema.Array(AgentTranscriptCue),
});

export const AgentTranscriptUpdateResponse = Schema.Struct({
	id: VideoId,
	revision: Schema.String,
	cueCount: Schema.Number,
	updatedAt: Schema.String,
	requestId: Schema.String,
});

export const AgentProcessInput = Schema.Struct({
	target: Schema.Literals(["transcript", "ai", "all"]),
	retry: Schema.optional(Schema.Boolean),
});

export const AgentProcessResponse = Schema.Struct({
	id: VideoId,
	requested: Schema.Literals(["transcript", "ai", "all"]),
	transcript: AgentProcessState,
	ai: AgentProcessState,
	requestId: Schema.String,
});

export const AgentDownloadResponse = Schema.Struct({
	fileName: Schema.String,
	url: Schema.String,
	expiresAt: Schema.String,
	requestId: Schema.String,
});

export const AgentTokenRequest = Schema.Struct({
	code: Schema.String,
	codeVerifier: Schema.String,
	redirectUri: Schema.String,
});

export const AgentTokenResponse = Schema.Struct({
	accessToken: Schema.String,
	tokenType: Schema.Literal("Bearer"),
	expiresAt: Schema.String,
	scopes: Schema.Array(AgentScope),
	requestId: Schema.String,
});

export const AgentAuthStatusResponse = Schema.Struct({
	authenticated: Schema.Literal(true),
	tokenKind: Schema.Literals(["agent", "legacy"]),
	expiresAt: Schema.NullOr(Schema.String),
	scopes: Schema.Array(AgentScope),
	requestId: Schema.String,
});

export const AgentRevokeResponse = Schema.Struct({
	revoked: Schema.Boolean,
	requestId: Schema.String,
});

export const AgentUnlockResponse = Schema.Struct({
	accessGrant: Schema.String,
	expiresAt: Schema.String,
	requestId: Schema.String,
});

export const AgentFeedbackInput = Schema.Struct({
	content: Schema.String,
	timestampMs: Schema.optional(Schema.NullOr(Schema.Number)),
});

export const AgentReplyPath = Schema.Struct({
	id: VideoId,
	commentId: CommentId,
});

export const AgentFeedbackResponse = Schema.Struct({
	id: CommentId,
	videoId: VideoId,
	type: Schema.Literals(["text", "emoji"]),
	content: Schema.String,
	timestampMs: Schema.NullOr(Schema.Number),
	parentCommentId: Schema.NullOr(CommentId),
	createdAt: Schema.String,
	updatedAt: Schema.String,
	author: Schema.Struct({
		id: UserId,
		name: Schema.NullOr(Schema.String),
	}),
	requestId: Schema.String,
});

export const AgentCapUpdateInput = Schema.Struct({
	title: Schema.optional(Schema.String),
	public: Schema.optional(Schema.Boolean),
});

export const AgentCapUpdateResponse = Schema.Struct({
	id: VideoId,
	title: Schema.String,
	public: Schema.Boolean,
	updatedAt: Schema.String,
	requestId: Schema.String,
});

export const AgentActionReason = Schema.Literals([
	"SCOPE_REQUIRED",
	"ROLE_REQUIRED",
	"OWNER_ONLY",
	"PLAN_REQUIRED",
	"CONTENT_DISABLED",
	"PASSWORD_REQUIRED",
	"NOT_READY",
	"CONFLICT",
	"APPROVAL_REQUIRED",
	"SECURE_INPUT_REQUIRED",
	"OPERATION_IN_PROGRESS",
]);

export const AgentActionCapability = Schema.Struct({
	allowed: Schema.Boolean,
	reason: Schema.NullOr(AgentActionReason),
	requiredScopes: Schema.Array(AgentScope),
	confirmation: Schema.Literals(["none", "user", "browser", "secure_input"]),
	sideEffect: Schema.Literals([
		"read",
		"write",
		"external",
		"paid",
		"destructive",
	]),
	idempotencyRequired: Schema.Boolean,
	asynchronous: Schema.Boolean,
});

export const AgentActionCapabilities = Schema.Record(
	Schema.String,
	AgentActionCapability,
);

export const AgentViewerSettings = Schema.Struct({
	disableSummary: Schema.NullOr(Schema.Boolean),
	disableCaptions: Schema.NullOr(Schema.Boolean),
	disableChapters: Schema.NullOr(Schema.Boolean),
	disableReactions: Schema.NullOr(Schema.Boolean),
	disableTranscript: Schema.NullOr(Schema.Boolean),
	disableComments: Schema.NullOr(Schema.Boolean),
	defaultPlaybackSpeed: Schema.NullOr(Schema.Number),
});

export const AgentMeResponse = Schema.Struct({
	id: UserId,
	email: Schema.String,
	name: Schema.NullOr(Schema.String),
	lastName: Schema.NullOr(Schema.String),
	image: Schema.NullOr(Schema.String),
	activeOrganizationId: Schema.NullOr(OrganisationId),
	defaultOrganizationId: Schema.NullOr(OrganisationId),
	createdAt: Schema.String,
	capabilities: AgentActionCapabilities,
	requestId: Schema.String,
});

export const AgentOrganizationPath = Schema.Struct({
	organizationId: OrganisationId,
});

export const AgentOrganizationMemberPath = Schema.Struct({
	organizationId: OrganisationId,
	memberId: Schema.String,
});

export const AgentOrganizationInvitePath = Schema.Struct({
	organizationId: OrganisationId,
	inviteId: Schema.String,
});

export const AgentAiGenerationLanguage = Schema.Literals([
	"auto",
	"en",
	"es",
	"fr",
	"de",
	"pt",
	"it",
	"nl",
	"pl",
	"ro",
	"sk",
	"ru",
	"tr",
	"ja",
	"ko",
	"zh",
	"ar",
	"hi",
	"bn",
	"ta",
	"te",
	"mr",
	"gu",
	"ur",
	"fa",
	"he",
]);

export const AgentOrganizationSettings = Schema.Struct({
	disableSummary: Schema.NullOr(Schema.Boolean),
	disableCaptions: Schema.NullOr(Schema.Boolean),
	disableChapters: Schema.NullOr(Schema.Boolean),
	disableReactions: Schema.NullOr(Schema.Boolean),
	disableTranscript: Schema.NullOr(Schema.Boolean),
	disableComments: Schema.NullOr(Schema.Boolean),
	hideShareableLinkCapLogo: Schema.NullOr(Schema.Boolean),
	shareableLinkUseOrganizationIcon: Schema.NullOr(Schema.Boolean),
	aiGenerationLanguage: Schema.NullOr(AgentAiGenerationLanguage),
	defaultPlaybackSpeed: Schema.NullOr(Schema.Number),
});

export const AgentOrganization = Schema.Struct({
	id: OrganisationId,
	name: Schema.String,
	ownerId: UserId,
	role: Schema.Literals(["owner", "admin", "member"]),
	hasProSeat: Schema.Boolean,
	allowedEmailDomain: Schema.NullOr(Schema.String),
	customDomain: Schema.NullOr(Schema.String),
	domainVerifiedAt: Schema.NullOr(Schema.String),
	icon: Schema.NullOr(Schema.String),
	shareableLinkIcon: Schema.NullOr(Schema.String),
	settings: AgentOrganizationSettings,
	billing: Schema.Struct({
		status: Schema.NullOr(Schema.String),
		plan: Schema.Literals(["free", "pro"]),
	}),
	createdAt: Schema.String,
	updatedAt: Schema.String,
	capabilities: AgentActionCapabilities,
});

export const AgentOrganizationsResponse = Schema.Struct({
	organizations: Schema.Array(AgentOrganization),
	requestId: Schema.String,
});

export const AgentOrganizationResponse = Schema.Struct({
	organization: AgentOrganization,
	requestId: Schema.String,
});

export const AgentOrganizationUpdateInput = Schema.Struct({
	name: Schema.optional(Schema.String),
	allowedEmailDomain: Schema.optional(Schema.NullOr(Schema.String)),
});

export const AgentOrganizationCreateInput = Schema.Struct({
	name: Schema.String,
});

export const AgentOrganizationDomainInput = Schema.Struct({
	domain: Schema.String,
});

export const AgentOrganizationMemberUpdateInput = Schema.Struct({
	role: Schema.Literals(["admin", "member"]),
});

export const AgentOrganizationMemberSeatInput = Schema.Struct({
	enabled: Schema.Boolean,
});

export const AgentOrganizationSettingsInput = Schema.Struct({
	disableSummary: Schema.optional(Schema.Boolean),
	disableCaptions: Schema.optional(Schema.Boolean),
	disableChapters: Schema.optional(Schema.Boolean),
	disableReactions: Schema.optional(Schema.Boolean),
	disableTranscript: Schema.optional(Schema.Boolean),
	disableComments: Schema.optional(Schema.Boolean),
	hideShareableLinkCapLogo: Schema.optional(Schema.Boolean),
	shareableLinkUseOrganizationIcon: Schema.optional(Schema.Boolean),
	aiGenerationLanguage: Schema.optional(AgentAiGenerationLanguage),
	defaultPlaybackSpeed: Schema.optional(Schema.Number),
});

export const AgentOrganizationInviteInput = Schema.Struct({
	email: Schema.String,
	role: Schema.optional(Schema.Literals(["admin", "member"])),
	sendEmail: Schema.optional(Schema.Boolean),
});

export const AgentMember = Schema.Struct({
	id: Schema.String,
	userId: UserId,
	email: Schema.String,
	name: Schema.NullOr(Schema.String),
	role: Schema.Literals(["owner", "admin", "member"]),
	hasProSeat: Schema.Boolean,
	createdAt: Schema.String,
	updatedAt: Schema.String,
	capabilities: AgentActionCapabilities,
});

export const AgentMembersResponse = Schema.Struct({
	members: Schema.Array(AgentMember),
	requestId: Schema.String,
});

export const AgentInvite = Schema.Struct({
	id: Schema.String,
	invitedEmail: Schema.String,
	role: Schema.Literals(["owner", "admin", "member"]),
	status: Schema.String,
	expiresAt: Schema.NullOr(Schema.String),
	createdAt: Schema.String,
	updatedAt: Schema.String,
	capabilities: AgentActionCapabilities,
});

export const AgentOrganizationInviteResponse = Schema.Struct({
	invite: AgentInvite,
	inviteUrl: Schema.String,
	emailDelivery: Schema.Literals(["not_requested", "accepted"]),
	requestId: Schema.String,
});

export const AgentInvitesResponse = Schema.Struct({
	invites: Schema.Array(AgentInvite),
	requestId: Schema.String,
});

export const AgentContainerParams = Schema.Struct({
	spaceId: Schema.optional(Schema.String),
	parentId: Schema.optional(Schema.String),
});

export const AgentFolder = Schema.Struct({
	id: FolderId,
	name: Schema.String,
	color: Schema.Literals(["normal", "blue", "red", "yellow"]),
	public: Schema.Boolean,
	organizationId: OrganisationId,
	createdById: UserId,
	parentId: Schema.NullOr(FolderId),
	spaceId: Schema.NullOr(SpaceIdOrOrganisationId),
	settings: Schema.Unknown,
	publicPage: Schema.NullOr(PublicPageSettings),
	createdAt: Schema.String,
	updatedAt: Schema.String,
	capabilities: AgentActionCapabilities,
});

export const AgentFoldersResponse = Schema.Struct({
	folders: Schema.Array(AgentFolder),
	requestId: Schema.String,
});

export const AgentSpace = Schema.Struct({
	id: SpaceIdOrOrganisationId,
	name: Schema.String,
	description: Schema.NullOr(Schema.String),
	organizationId: OrganisationId,
	createdById: UserId,
	primary: Schema.Boolean,
	privacy: Schema.Literals(["Public", "Private"]),
	public: Schema.Boolean,
	protected: Schema.Boolean,
	icon: Schema.NullOr(Schema.String),
	settings: AgentViewerSettings,
	publicPage: Schema.NullOr(PublicPageSettings),
	role: Schema.NullOr(Schema.Literals(["admin", "member"])),
	counts: Schema.Struct({
		members: Schema.Number,
		caps: Schema.Number,
		folders: Schema.Number,
	}),
	createdAt: Schema.String,
	updatedAt: Schema.String,
	capabilities: AgentActionCapabilities,
});

export const AgentSpacesResponse = Schema.Struct({
	spaces: Schema.Array(AgentSpace),
	requestId: Schema.String,
});

export const AgentSpacePath = Schema.Struct({
	spaceId: SpaceIdOrOrganisationId,
});

export const AgentSpaceMember = Schema.Struct({
	id: Schema.String,
	userId: UserId,
	email: Schema.String,
	name: Schema.NullOr(Schema.String),
	role: Schema.Literals(["admin", "member"]),
	createdAt: Schema.String,
	updatedAt: Schema.String,
	capabilities: AgentActionCapabilities,
});

export const AgentSpaceMembersResponse = Schema.Struct({
	members: Schema.Array(AgentSpaceMember),
	requestId: Schema.String,
});

export const AgentNotificationParams = Schema.Struct({
	cursor: Schema.optional(Schema.String),
	limit: Schema.optional(Schema.String),
	unread: Schema.optional(Schema.Literals(["true", "false"])),
});

export const AgentNotification = Schema.Struct({
	id: Schema.String,
	organizationId: OrganisationId,
	type: Schema.Literals(["view", "comment", "reply", "reaction", "anon_view"]),
	data: Schema.Unknown,
	videoId: Schema.NullOr(Schema.String),
	readAt: Schema.NullOr(Schema.String),
	createdAt: Schema.String,
});

export const AgentNotificationsResponse = Schema.Struct({
	notifications: Schema.Array(AgentNotification),
	nextCursor: Schema.NullOr(Schema.String),
	unreadCount: Schema.Number,
	requestId: Schema.String,
});

export const AgentNotificationPreferencesResponse = Schema.Struct({
	pauseComments: Schema.Boolean,
	pauseReplies: Schema.Boolean,
	pauseViews: Schema.Boolean,
	pauseReactions: Schema.Boolean,
	pauseAnonymousViews: Schema.Boolean,
	requestId: Schema.String,
});

export const AgentAnalyticsParams = Schema.Struct({
	organizationId: Schema.String,
	spaceId: Schema.optional(Schema.String),
	capId: Schema.optional(Schema.String),
	range: Schema.optional(Schema.Literals(["day", "week", "month", "year"])),
});

export const AgentAnalyticsResponse = Schema.Struct({
	organizationId: OrganisationId,
	spaceId: Schema.NullOr(SpaceIdOrOrganisationId),
	capId: Schema.NullOr(VideoId),
	range: Schema.Literals(["day", "week", "month", "year"]),
	data: Schema.Unknown,
	requestId: Schema.String,
});

export const AgentCapSettingsResponse = Schema.Struct({
	id: VideoId,
	overrides: AgentViewerSettings,
	effective: AgentViewerSettings,
	inherited: Schema.Record(
		Schema.String,
		Schema.Array(Schema.Struct({ id: Schema.String, name: Schema.String })),
	),
	capabilities: AgentActionCapabilities,
	requestId: Schema.String,
});

export const AgentCapSharesResponse = Schema.Struct({
	id: VideoId,
	public: Schema.Boolean,
	protected: Schema.Boolean,
	organizations: Schema.Array(
		Schema.Struct({
			organizationId: OrganisationId,
			organizationName: Schema.String,
			folderId: Schema.NullOr(FolderId),
			sharedAt: Schema.String,
		}),
	),
	spaces: Schema.Array(
		Schema.Struct({
			spaceId: SpaceIdOrOrganisationId,
			spaceName: Schema.String,
			organizationId: OrganisationId,
			folderId: Schema.NullOr(FolderId),
			addedAt: Schema.String,
		}),
	),
	capabilities: AgentActionCapabilities,
	requestId: Schema.String,
});

export const AgentStorageIntegration = Schema.Struct({
	id: Schema.String,
	provider: Schema.String,
	displayName: Schema.String,
	status: Schema.String,
	active: Schema.Boolean,
	createdAt: Schema.String,
	updatedAt: Schema.String,
	capabilities: AgentActionCapabilities,
});

export const AgentStorageIntegrationsResponse = Schema.Struct({
	integrations: Schema.Array(AgentStorageIntegration),
	requestId: Schema.String,
});

export const AgentS3ConfigInput = Schema.Struct({
	provider: Schema.String,
	accessKeyId: Schema.String,
	secretAccessKey: Schema.String,
	endpoint: Schema.String,
	bucketName: Schema.String,
	region: Schema.String,
});

export const AgentStorageProviderInput = Schema.Struct({
	provider: Schema.Literals(["s3", "googleDrive"]),
});

export const AgentGoogleDriveFolderParams = Schema.Struct({
	parentId: Schema.optional(Schema.String),
});

export const AgentGoogleDriveFoldersResponse = Schema.Struct({
	folders: Schema.Array(
		Schema.Struct({
			id: Schema.String,
			name: Schema.String,
			driveId: Schema.NullOr(Schema.String),
			driveName: Schema.NullOr(Schema.String),
		}),
	),
	requestId: Schema.String,
});

export const AgentGoogleDriveLocationInput = Schema.Struct({
	folderId: Schema.String,
	folderName: Schema.optional(Schema.NullOr(Schema.String)),
	driveId: Schema.optional(Schema.NullOr(Schema.String)),
	driveName: Schema.optional(Schema.NullOr(Schema.String)),
});

export const AgentBillingResponse = Schema.Struct({
	organizationId: OrganisationId,
	plan: Schema.Literals(["free", "pro"]),
	status: Schema.NullOr(Schema.String),
	managedExternally: Schema.Boolean,
	seats: Schema.Struct({ total: Schema.Number, assigned: Schema.Number }),
	capabilities: AgentActionCapabilities,
	requestId: Schema.String,
});

export const AgentSubscriptionCheckoutInput = Schema.Struct({
	interval: Schema.Literals(["monthly", "yearly"]),
	quantity: Schema.optional(Schema.Number),
});

export const AgentDeveloperCreditsCheckoutInput = Schema.Struct({
	amountCents: Schema.Number,
});

export const AgentBrowserActionResponse = Schema.Struct({
	action: Schema.String,
	url: Schema.String,
	requestId: Schema.String,
});

export const AgentDeveloperAppPath = Schema.Struct({ appId: Schema.String });
export const AgentDeveloperAppDomainPath = Schema.Struct({
	appId: Schema.String,
	domainId: Schema.String,
});
export const AgentDeveloperVideoPath = Schema.Struct({
	appId: Schema.String,
	videoId: Schema.String,
});

export const AgentDeveloperAppCreateInput = Schema.Struct({
	name: Schema.String,
	environment: Schema.Literals(["development", "production"]),
});

export const AgentDeveloperAppUpdateInput = Schema.Struct({
	name: Schema.optional(Schema.String),
	environment: Schema.optional(Schema.Literals(["development", "production"])),
	logoUrl: Schema.optional(Schema.NullOr(Schema.String)),
});

export const AgentDeveloperDomainInput = Schema.Struct({
	domain: Schema.String,
});

export const AgentDeveloperAutoTopUpInput = Schema.Struct({
	enabled: Schema.Boolean,
	thresholdMicroCredits: Schema.optional(Schema.Number),
	amountCents: Schema.optional(Schema.Number),
});

export const AgentDeveloperApp = Schema.Struct({
	id: Schema.String,
	name: Schema.String,
	environment: Schema.Literals(["development", "production"]),
	logoUrl: Schema.NullOr(Schema.String),
	createdAt: Schema.String,
	updatedAt: Schema.String,
	capabilities: AgentActionCapabilities,
});

export const AgentDeveloperAppsResponse = Schema.Struct({
	apps: Schema.Array(AgentDeveloperApp),
	requestId: Schema.String,
});

export const AgentDeveloperCredentialsResponse = Schema.Struct({
	appId: Schema.String,
	publicKey: Schema.String,
	secretKey: Schema.String,
	requestId: Schema.String,
});

export const AgentDeveloperAppContextResponse = Schema.Struct({
	app: AgentDeveloperApp,
	domains: Schema.Array(
		Schema.Struct({
			id: Schema.String,
			domain: Schema.String,
			createdAt: Schema.String,
		}),
	),
	keys: Schema.Array(
		Schema.Struct({
			id: Schema.String,
			keyType: Schema.Literals(["public", "secret"]),
			keyPrefix: Schema.String,
			lastUsedAt: Schema.NullOr(Schema.String),
			revokedAt: Schema.NullOr(Schema.String),
			createdAt: Schema.String,
		}),
	),
	usage: Schema.Struct({
		videoCount: Schema.Number,
		storageMinutes: Schema.Number,
	}),
	credits: Schema.NullOr(
		Schema.Struct({
			balanceMicroCredits: Schema.Number,
			autoTopUpEnabled: Schema.Boolean,
			autoTopUpThresholdMicroCredits: Schema.Number,
			autoTopUpAmountCents: Schema.Number,
		}),
	),
	requestId: Schema.String,
});

export const AgentDeveloperListParams = Schema.Struct({
	cursor: Schema.optional(Schema.String),
	limit: Schema.optional(Schema.String),
});

export const AgentDeveloperVideoParams = Schema.Struct({
	userId: Schema.optional(Schema.String),
	cursor: Schema.optional(Schema.String),
	limit: Schema.optional(Schema.String),
});

export const AgentDeveloperVideo = Schema.Struct({
	id: Schema.String,
	appId: Schema.String,
	externalUserId: Schema.NullOr(Schema.String),
	name: Schema.String,
	durationSeconds: Schema.NullOr(Schema.Number),
	width: Schema.NullOr(Schema.Number),
	height: Schema.NullOr(Schema.Number),
	fps: Schema.NullOr(Schema.Number),
	transcriptionStatus: Schema.NullOr(Schema.String),
	createdAt: Schema.String,
	updatedAt: Schema.String,
	capabilities: AgentActionCapabilities,
});

export const AgentDeveloperVideosResponse = Schema.Struct({
	videos: Schema.Array(AgentDeveloperVideo),
	nextCursor: Schema.NullOr(Schema.String),
	requestId: Schema.String,
});

export const AgentDeveloperCreditTransaction = Schema.Struct({
	id: Schema.String,
	type: Schema.Literals([
		"topup",
		"video_create",
		"storage_daily",
		"refund",
		"adjustment",
	]),
	amountMicroCredits: Schema.Number,
	balanceAfterMicroCredits: Schema.Number,
	referenceId: Schema.NullOr(Schema.String),
	referenceType: Schema.NullOr(Schema.String),
	createdAt: Schema.String,
});

export const AgentDeveloperTransactionsResponse = Schema.Struct({
	transactions: Schema.Array(AgentDeveloperCreditTransaction),
	nextCursor: Schema.NullOr(Schema.String),
	requestId: Schema.String,
});

export const AgentMutationResponse = Schema.Struct({
	resource: Schema.Struct({
		type: Schema.String,
		id: Schema.String,
		revision: Schema.NullOr(Schema.String),
	}),
	action: Schema.String,
	requestId: Schema.String,
});

export const AgentUploadCreateInput = Schema.Struct({
	organizationId: Schema.optional(OrganisationId),
	folderId: Schema.optional(FolderId),
	fileName: Schema.String,
	contentType: Schema.Literal("video/mp4"),
	contentLength: Schema.optional(Schema.Number),
	durationSeconds: Schema.optional(Schema.Number),
	width: Schema.optional(Schema.Number),
	height: Schema.optional(Schema.Number),
	fps: Schema.optional(Schema.Number),
	title: Schema.optional(Schema.String),
});

export const AgentUploadCreateResponse = Schema.Struct({
	id: VideoId,
	shareUrl: Schema.String,
	rawFileKey: Schema.String,
	upload: UploadTarget,
	requestId: Schema.String,
});

export const AgentUploadCompleteInput = Schema.Struct({
	rawFileKey: Schema.String,
	contentLength: Schema.optional(Schema.Number),
});

export const AgentUploadCompleteResponse = Schema.Struct({
	id: VideoId,
	processing: Schema.Literals([
		"started",
		"already-processing",
		"already-complete",
	]),
	requestId: Schema.String,
});

export const AgentLoomImportInput = Schema.Struct({
	loomUrl: Schema.String,
	ownerEmail: Schema.optional(Schema.NullOr(Schema.String)),
	spaceName: Schema.optional(Schema.NullOr(Schema.String)),
});

export const AgentProfileUpdateInput = Schema.Struct({
	name: Schema.optional(Schema.NullOr(Schema.String)),
	lastName: Schema.optional(Schema.NullOr(Schema.String)),
	defaultOrganizationId: Schema.optional(Schema.NullOr(OrganisationId)),
});

export const AgentImageInput = Schema.Struct({
	data: Schema.String,
	contentType: Schema.String,
	fileName: Schema.String,
});

export const AgentNotificationPreferencesInput = Schema.Struct({
	pauseComments: Schema.optional(Schema.Boolean),
	pauseReplies: Schema.optional(Schema.Boolean),
	pauseViews: Schema.optional(Schema.Boolean),
	pauseReactions: Schema.optional(Schema.Boolean),
	pauseAnonymousViews: Schema.optional(Schema.Boolean),
});

export const AgentNotificationsReadInput = Schema.Struct({
	ids: Schema.optional(Schema.Array(Schema.String)),
	all: Schema.optional(Schema.Boolean),
});

export const AgentViewerSettingsInput = Schema.Struct({
	disableSummary: Schema.optional(Schema.NullOr(Schema.Boolean)),
	disableCaptions: Schema.optional(Schema.NullOr(Schema.Boolean)),
	disableChapters: Schema.optional(Schema.NullOr(Schema.Boolean)),
	disableReactions: Schema.optional(Schema.NullOr(Schema.Boolean)),
	disableTranscript: Schema.optional(Schema.NullOr(Schema.Boolean)),
	disableComments: Schema.optional(Schema.NullOr(Schema.Boolean)),
	defaultPlaybackSpeed: Schema.optional(Schema.NullOr(Schema.Number)),
});

export const AgentCapDateInput = Schema.Struct({ createdAt: Schema.String });

export const AgentFolderPath = Schema.Struct({ folderId: FolderId });

export const AgentFolderCreateInput = Schema.Struct({
	name: Schema.String,
	color: Schema.optional(Schema.Literals(["normal", "blue", "red", "yellow"])),
	parentId: Schema.optional(Schema.NullOr(FolderId)),
	spaceId: Schema.optional(Schema.NullOr(SpaceIdOrOrganisationId)),
	public: Schema.optional(Schema.Boolean),
});

export const AgentFolderUpdateInput = Schema.Struct({
	name: Schema.optional(Schema.String),
	color: Schema.optional(Schema.Literals(["normal", "blue", "red", "yellow"])),
	parentId: Schema.optional(Schema.NullOr(FolderId)),
	public: Schema.optional(Schema.Boolean),
	settings: Schema.optional(Schema.Unknown),
});

export const AgentSpaceCreateInput = Schema.Struct({
	name: Schema.String,
	description: Schema.optional(Schema.NullOr(Schema.String)),
	privacy: Schema.optional(Schema.Literals(["Public", "Private"])),
	public: Schema.optional(Schema.Boolean),
	settings: Schema.optional(AgentViewerSettingsInput),
});

export const AgentSpaceUpdateInput = Schema.Struct({
	name: Schema.optional(Schema.String),
	description: Schema.optional(Schema.NullOr(Schema.String)),
	privacy: Schema.optional(Schema.Literals(["Public", "Private"])),
	public: Schema.optional(Schema.Boolean),
	settings: Schema.optional(AgentViewerSettingsInput),
});

export const AgentCollectionPublicPageInput = Schema.Struct({
	...PublicPageSettingsUpdate.fields,
	public: Schema.optional(Schema.Boolean),
});

export const AgentSpaceMemberPath = Schema.Struct({
	spaceId: SpaceIdOrOrganisationId,
	userId: UserId,
});

export const AgentSpaceMemberAddInput = Schema.Struct({
	userId: UserId,
	role: Schema.optional(Schema.Literals(["admin", "member"])),
});

export const AgentSpaceMemberUpdateInput = Schema.Struct({
	role: Schema.Literals(["admin", "member"]),
});

export const AgentMoveCapInput = Schema.Struct({
	container: Schema.Literals(["personal", "organization", "space"]),
	organizationId: OrganisationId,
	spaceId: Schema.optional(Schema.NullOr(SpaceIdOrOrganisationId)),
	folderId: Schema.NullOr(FolderId),
});

export const AgentOrganizationSharePath = Schema.Struct({
	id: VideoId,
	organizationId: OrganisationId,
});

export const AgentSpaceSharePath = Schema.Struct({
	id: VideoId,
	spaceId: SpaceIdOrOrganisationId,
});

export const AgentShareInput = Schema.Struct({
	folderId: Schema.optional(Schema.NullOr(FolderId)),
});

export const AgentOperationPath = Schema.Struct({ operationId: Schema.String });

export const AgentOperationResponse = Schema.Struct({
	id: Schema.String,
	kind: Schema.Literals([
		"duplicate_cap",
		"delete_cap",
		"import_loom",
		"delete_organization",
		"set_organization_domain",
		"remove_organization_domain",
		"verify_organization_domain",
		"transfer_org_content",
	]),
	state: Schema.Literals(["queued", "running", "succeeded", "failed"]),
	resourceId: Schema.String,
	resultResourceId: Schema.NullOr(Schema.String),
	result: Schema.NullOr(Schema.Unknown),
	error: Schema.NullOr(
		Schema.Struct({ code: Schema.String, message: Schema.String }),
	),
	createdAt: Schema.String,
	updatedAt: Schema.String,
	completedAt: Schema.NullOr(Schema.String),
	requestId: Schema.String,
});

export class AgentHttpApi extends HttpApiGroup.make("agent")
	.add(
		HttpApiEndpoint.get("listCaps", "/caps", {
			query: AgentCapsListParams,
			success: AgentCapsListResponse,
			error: [
				AgentBadRequestError,
				AgentAuthenticationError,
				AgentForbiddenError,
				AgentNotFoundError,
				AgentNotReadyError,
				AgentRateLimitedError,
				AgentTemporaryUnavailableError,
			],
		}).middleware(AgentHttpAuthMiddleware),
	)
	.add(
		HttpApiEndpoint.get("getCap", "/caps/:id", {
			params: AgentVideoPath,
			success: AgentCapSummary,
			error: [
				AgentBadRequestError,
				AgentAuthenticationError,
				AgentForbiddenError,
				AgentNotFoundError,
				AgentNotReadyError,
				AgentRateLimitedError,
				AgentTemporaryUnavailableError,
			],
		}).middleware(AgentHttpAuthMiddleware),
	)
	.add(
		HttpApiEndpoint.get("getContext", "/caps/:id/context", {
			params: AgentVideoPath,
			success: AgentCapContext,
			error: [
				AgentBadRequestError,
				AgentAuthenticationError,
				AgentForbiddenError,
				AgentNotFoundError,
				AgentNotReadyError,
				AgentRateLimitedError,
				AgentTemporaryUnavailableError,
			],
		}).middleware(AgentHttpAuthMiddleware),
	)
	.add(
		HttpApiEndpoint.get("getStatus", "/caps/:id/status", {
			params: AgentVideoPath,
			success: AgentCapStatus,
			error: [
				AgentBadRequestError,
				AgentAuthenticationError,
				AgentForbiddenError,
				AgentNotFoundError,
				AgentNotReadyError,
				AgentRateLimitedError,
				AgentTemporaryUnavailableError,
			],
		}).middleware(AgentHttpAuthMiddleware),
	)
	.add(
		HttpApiEndpoint.get("getTranscript", "/caps/:id/transcript", {
			params: AgentVideoPath,
			query: AgentTranscriptParams,
			error: [
				AgentBadRequestError,
				AgentAuthenticationError,
				AgentForbiddenError,
				AgentNotFoundError,
				AgentNotReadyError,
				AgentRateLimitedError,
				AgentTemporaryUnavailableError,
			],
		}).middleware(AgentHttpAuthMiddleware),
	)
	.add(
		HttpApiEndpoint.get("getDownload", "/caps/:id/download", {
			params: AgentVideoPath,
			success: AgentDownloadResponse,
			error: [
				AgentBadRequestError,
				AgentAuthenticationError,
				AgentForbiddenError,
				AgentNotFoundError,
				AgentNotReadyError,
				AgentRateLimitedError,
				AgentTemporaryUnavailableError,
			],
		}).middleware(AgentHttpAuthMiddleware),
	)
	.add(
		HttpApiEndpoint.post("unlockCap", "/caps/:id/unlock", {
			params: AgentVideoPath,
			success: AgentUnlockResponse,
			error: [
				AgentBadRequestError,
				AgentAuthenticationError,
				AgentForbiddenError,
				AgentNotFoundError,
				AgentRateLimitedError,
				AgentTemporaryUnavailableError,
			],
		}).middleware(AgentHttpAuthMiddleware),
	)
	.add(
		HttpApiEndpoint.post("createComment", "/caps/:id/comments", {
			params: AgentVideoPath,
			payload: AgentFeedbackInput,
			success: AgentFeedbackResponse,
			error: [
				AgentBadRequestError,
				AgentAuthenticationError,
				AgentForbiddenError,
				AgentNotFoundError,
				AgentConflictError,
				AgentApprovalRequiredError,
				AgentRateLimitedError,
				AgentTemporaryUnavailableError,
			],
		}).middleware(AgentHttpAuthMiddleware),
	)
	.add(
		HttpApiEndpoint.post(
			"createReply",
			"/caps/:id/comments/:commentId/replies",
			{
				params: AgentReplyPath,
				payload: AgentFeedbackInput,
				success: AgentFeedbackResponse,
				error: [
					AgentBadRequestError,
					AgentAuthenticationError,
					AgentForbiddenError,
					AgentNotFoundError,
					AgentConflictError,
					AgentApprovalRequiredError,
					AgentRateLimitedError,
					AgentTemporaryUnavailableError,
				],
			},
		).middleware(AgentHttpAuthMiddleware),
	)
	.add(
		HttpApiEndpoint.post("createReaction", "/caps/:id/reactions", {
			params: AgentVideoPath,
			payload: AgentFeedbackInput,
			success: AgentFeedbackResponse,
			error: [
				AgentBadRequestError,
				AgentAuthenticationError,
				AgentForbiddenError,
				AgentNotFoundError,
				AgentConflictError,
				AgentApprovalRequiredError,
				AgentRateLimitedError,
				AgentTemporaryUnavailableError,
			],
		}).middleware(AgentHttpAuthMiddleware),
	)
	.add(
		HttpApiEndpoint.patch("updateCap", "/caps/:id", {
			params: AgentVideoPath,
			payload: AgentCapUpdateInput,
			success: AgentCapUpdateResponse,
			error: [
				AgentBadRequestError,
				AgentAuthenticationError,
				AgentForbiddenError,
				AgentNotFoundError,
				AgentConflictError,
				AgentApprovalRequiredError,
				AgentRateLimitedError,
				AgentTemporaryUnavailableError,
			],
		}).middleware(AgentHttpAuthMiddleware),
	) {}

export class AgentManagementHttpApi extends HttpApiGroup.make("agentManagement")
	.add(
		HttpApiEndpoint.get("getMe", "/me", {
			success: AgentMeResponse,
			error: [
				AgentBadRequestError,
				AgentAuthenticationError,
				AgentForbiddenError,
				AgentNotFoundError,
				AgentNotReadyError,
				AgentRateLimitedError,
				AgentTemporaryUnavailableError,
			],
		}).middleware(AgentHttpAuthMiddleware),
	)
	.add(
		HttpApiEndpoint.get("listOrganizations", "/organizations", {
			success: AgentOrganizationsResponse,
			error: [
				AgentBadRequestError,
				AgentAuthenticationError,
				AgentForbiddenError,
				AgentNotFoundError,
				AgentNotReadyError,
				AgentRateLimitedError,
				AgentTemporaryUnavailableError,
			],
		}).middleware(AgentHttpAuthMiddleware),
	)
	.add(
		HttpApiEndpoint.get("getOrganization", "/organizations/:organizationId", {
			params: AgentOrganizationPath,
			success: AgentOrganizationResponse,
			error: [
				AgentBadRequestError,
				AgentAuthenticationError,
				AgentForbiddenError,
				AgentNotFoundError,
				AgentNotReadyError,
				AgentRateLimitedError,
				AgentTemporaryUnavailableError,
			],
		}).middleware(AgentHttpAuthMiddleware),
	)
	.add(
		HttpApiEndpoint.get(
			"listOrganizationMembers",
			"/organizations/:organizationId/members",
			{
				params: AgentOrganizationPath,
				success: AgentMembersResponse,
				error: [
					AgentBadRequestError,
					AgentAuthenticationError,
					AgentForbiddenError,
					AgentNotFoundError,
					AgentNotReadyError,
					AgentRateLimitedError,
					AgentTemporaryUnavailableError,
				],
			},
		).middleware(AgentHttpAuthMiddleware),
	)
	.add(
		HttpApiEndpoint.get(
			"listOrganizationInvites",
			"/organizations/:organizationId/invites",
			{
				params: AgentOrganizationPath,
				success: AgentInvitesResponse,
				error: [
					AgentBadRequestError,
					AgentAuthenticationError,
					AgentForbiddenError,
					AgentNotFoundError,
					AgentNotReadyError,
					AgentRateLimitedError,
					AgentTemporaryUnavailableError,
				],
			},
		).middleware(AgentHttpAuthMiddleware),
	)
	.add(
		HttpApiEndpoint.get(
			"listFolders",
			"/organizations/:organizationId/folders",
			{
				params: AgentOrganizationPath,
				query: AgentContainerParams,
				success: AgentFoldersResponse,
				error: [
					AgentBadRequestError,
					AgentAuthenticationError,
					AgentForbiddenError,
					AgentNotFoundError,
					AgentNotReadyError,
					AgentRateLimitedError,
					AgentTemporaryUnavailableError,
				],
			},
		).middleware(AgentHttpAuthMiddleware),
	)
	.add(
		HttpApiEndpoint.get("listSpaces", "/organizations/:organizationId/spaces", {
			params: AgentOrganizationPath,
			success: AgentSpacesResponse,
			error: [
				AgentBadRequestError,
				AgentAuthenticationError,
				AgentForbiddenError,
				AgentNotFoundError,
				AgentNotReadyError,
				AgentRateLimitedError,
				AgentTemporaryUnavailableError,
			],
		}).middleware(AgentHttpAuthMiddleware),
	)
	.add(
		HttpApiEndpoint.get("listSpaceMembers", "/spaces/:spaceId/members", {
			params: AgentSpacePath,
			success: AgentSpaceMembersResponse,
			error: [
				AgentBadRequestError,
				AgentAuthenticationError,
				AgentForbiddenError,
				AgentNotFoundError,
				AgentNotReadyError,
				AgentRateLimitedError,
				AgentTemporaryUnavailableError,
			],
		}).middleware(AgentHttpAuthMiddleware),
	)
	.add(
		HttpApiEndpoint.get("listNotifications", "/me/notifications", {
			query: AgentNotificationParams,
			success: AgentNotificationsResponse,
			error: [
				AgentBadRequestError,
				AgentAuthenticationError,
				AgentForbiddenError,
				AgentNotFoundError,
				AgentNotReadyError,
				AgentRateLimitedError,
				AgentTemporaryUnavailableError,
			],
		}).middleware(AgentHttpAuthMiddleware),
	)
	.add(
		HttpApiEndpoint.get(
			"getNotificationPreferences",
			"/me/notification-preferences",
			{
				success: AgentNotificationPreferencesResponse,
				error: [
					AgentBadRequestError,
					AgentAuthenticationError,
					AgentForbiddenError,
					AgentNotFoundError,
					AgentNotReadyError,
					AgentRateLimitedError,
					AgentTemporaryUnavailableError,
				],
			},
		).middleware(AgentHttpAuthMiddleware),
	)
	.add(
		HttpApiEndpoint.get("getAnalytics", "/analytics", {
			query: AgentAnalyticsParams,
			success: AgentAnalyticsResponse,
			error: [
				AgentBadRequestError,
				AgentAuthenticationError,
				AgentForbiddenError,
				AgentNotFoundError,
				AgentNotReadyError,
				AgentRateLimitedError,
				AgentTemporaryUnavailableError,
			],
		}).middleware(AgentHttpAuthMiddleware),
	)
	.add(
		HttpApiEndpoint.get("getCapSettings", "/caps/:id/settings", {
			params: AgentVideoPath,
			success: AgentCapSettingsResponse,
			error: [
				AgentBadRequestError,
				AgentAuthenticationError,
				AgentForbiddenError,
				AgentNotFoundError,
				AgentNotReadyError,
				AgentRateLimitedError,
				AgentTemporaryUnavailableError,
			],
		}).middleware(AgentHttpAuthMiddleware),
	)
	.add(
		HttpApiEndpoint.get("getCapShares", "/caps/:id/shares", {
			params: AgentVideoPath,
			success: AgentCapSharesResponse,
			error: [
				AgentBadRequestError,
				AgentAuthenticationError,
				AgentForbiddenError,
				AgentNotFoundError,
				AgentNotReadyError,
				AgentRateLimitedError,
				AgentTemporaryUnavailableError,
			],
		}).middleware(AgentHttpAuthMiddleware),
	)
	.add(
		HttpApiEndpoint.get(
			"listStorageIntegrations",
			"/organizations/:organizationId/storage-integrations",
			{
				params: AgentOrganizationPath,
				success: AgentStorageIntegrationsResponse,
				error: [
					AgentBadRequestError,
					AgentAuthenticationError,
					AgentForbiddenError,
					AgentNotFoundError,
					AgentNotReadyError,
					AgentRateLimitedError,
					AgentTemporaryUnavailableError,
				],
			},
		).middleware(AgentHttpAuthMiddleware),
	)
	.add(
		HttpApiEndpoint.get(
			"listOrganizationGoogleDriveFolders",
			"/organizations/:organizationId/storage/google-drive/folders",
			{
				params: AgentOrganizationPath,
				query: AgentGoogleDriveFolderParams,
				success: AgentGoogleDriveFoldersResponse,
				error: [
					AgentBadRequestError,
					AgentAuthenticationError,
					AgentForbiddenError,
					AgentNotFoundError,
					AgentNotReadyError,
					AgentRateLimitedError,
					AgentTemporaryUnavailableError,
				],
			},
		).middleware(AgentHttpAuthMiddleware),
	)
	.add(
		HttpApiEndpoint.get(
			"getOrganizationBilling",
			"/organizations/:organizationId/billing",
			{
				params: AgentOrganizationPath,
				success: AgentBillingResponse,
				error: [
					AgentBadRequestError,
					AgentAuthenticationError,
					AgentForbiddenError,
					AgentNotFoundError,
					AgentNotReadyError,
					AgentRateLimitedError,
					AgentTemporaryUnavailableError,
				],
			},
		).middleware(AgentHttpAuthMiddleware),
	)
	.add(
		HttpApiEndpoint.get("listDeveloperApps", "/developer/apps", {
			success: AgentDeveloperAppsResponse,
			error: [
				AgentBadRequestError,
				AgentAuthenticationError,
				AgentForbiddenError,
				AgentNotFoundError,
				AgentNotReadyError,
				AgentRateLimitedError,
				AgentTemporaryUnavailableError,
			],
		}).middleware(AgentHttpAuthMiddleware),
	)
	.add(
		HttpApiEndpoint.get(
			"getDeveloperAppContext",
			"/developer/apps/:appId/context",
			{
				params: AgentDeveloperAppPath,
				success: AgentDeveloperAppContextResponse,
				error: [
					AgentBadRequestError,
					AgentAuthenticationError,
					AgentForbiddenError,
					AgentNotFoundError,
					AgentNotReadyError,
					AgentRateLimitedError,
					AgentTemporaryUnavailableError,
				],
			},
		).middleware(AgentHttpAuthMiddleware),
	)
	.add(
		HttpApiEndpoint.get(
			"listDeveloperVideos",
			"/developer/apps/:appId/videos",
			{
				params: AgentDeveloperAppPath,
				query: AgentDeveloperVideoParams,
				success: AgentDeveloperVideosResponse,
				error: [
					AgentBadRequestError,
					AgentAuthenticationError,
					AgentForbiddenError,
					AgentNotFoundError,
					AgentNotReadyError,
					AgentRateLimitedError,
					AgentTemporaryUnavailableError,
				],
			},
		).middleware(AgentHttpAuthMiddleware),
	)
	.add(
		HttpApiEndpoint.get(
			"listDeveloperTransactions",
			"/developer/apps/:appId/transactions",
			{
				params: AgentDeveloperAppPath,
				query: AgentDeveloperListParams,
				success: AgentDeveloperTransactionsResponse,
				error: [
					AgentBadRequestError,
					AgentAuthenticationError,
					AgentForbiddenError,
					AgentNotFoundError,
					AgentNotReadyError,
					AgentRateLimitedError,
					AgentTemporaryUnavailableError,
				],
			},
		).middleware(AgentHttpAuthMiddleware),
	)
	.add(
		HttpApiEndpoint.post("createDeveloperApp", "/developer/apps", {
			payload: AgentDeveloperAppCreateInput,
			success: AgentDeveloperCredentialsResponse,
			error: [
				AgentBadRequestError,
				AgentAuthenticationError,
				AgentForbiddenError,
				AgentNotFoundError,
				AgentNotReadyError,
				AgentConflictError,
				AgentApprovalRequiredError,
				AgentRateLimitedError,
				AgentTemporaryUnavailableError,
			],
		}).middleware(AgentHttpAuthMiddleware),
	)
	.add(
		HttpApiEndpoint.patch("updateDeveloperApp", "/developer/apps/:appId", {
			params: AgentDeveloperAppPath,
			payload: AgentDeveloperAppUpdateInput,
			success: AgentMutationResponse,
			error: [
				AgentBadRequestError,
				AgentAuthenticationError,
				AgentForbiddenError,
				AgentNotFoundError,
				AgentNotReadyError,
				AgentConflictError,
				AgentApprovalRequiredError,
				AgentRateLimitedError,
				AgentTemporaryUnavailableError,
			],
		}).middleware(AgentHttpAuthMiddleware),
	)
	.add(
		HttpApiEndpoint.delete("deleteDeveloperApp", "/developer/apps/:appId", {
			params: AgentDeveloperAppPath,
			success: AgentMutationResponse,
			error: [
				AgentBadRequestError,
				AgentAuthenticationError,
				AgentForbiddenError,
				AgentNotFoundError,
				AgentNotReadyError,
				AgentConflictError,
				AgentApprovalRequiredError,
				AgentRateLimitedError,
				AgentTemporaryUnavailableError,
			],
		}).middleware(AgentHttpAuthMiddleware),
	)
	.add(
		HttpApiEndpoint.post(
			"addDeveloperDomain",
			"/developer/apps/:appId/domains",
			{
				params: AgentDeveloperAppPath,
				payload: AgentDeveloperDomainInput,
				success: AgentMutationResponse,
				error: [
					AgentBadRequestError,
					AgentAuthenticationError,
					AgentForbiddenError,
					AgentNotFoundError,
					AgentNotReadyError,
					AgentConflictError,
					AgentApprovalRequiredError,
					AgentRateLimitedError,
					AgentTemporaryUnavailableError,
				],
			},
		).middleware(AgentHttpAuthMiddleware),
	)
	.add(
		HttpApiEndpoint.delete(
			"removeDeveloperDomain",
			"/developer/apps/:appId/domains/:domainId",
			{
				params: AgentDeveloperAppDomainPath,
				success: AgentMutationResponse,
				error: [
					AgentBadRequestError,
					AgentAuthenticationError,
					AgentForbiddenError,
					AgentNotFoundError,
					AgentNotReadyError,
					AgentConflictError,
					AgentApprovalRequiredError,
					AgentRateLimitedError,
					AgentTemporaryUnavailableError,
				],
			},
		).middleware(AgentHttpAuthMiddleware),
	)
	.add(
		HttpApiEndpoint.post(
			"rotateDeveloperKeys",
			"/developer/apps/:appId/keys/rotate",
			{
				params: AgentDeveloperAppPath,
				success: AgentDeveloperCredentialsResponse,
				error: [
					AgentBadRequestError,
					AgentAuthenticationError,
					AgentForbiddenError,
					AgentNotFoundError,
					AgentNotReadyError,
					AgentConflictError,
					AgentApprovalRequiredError,
					AgentRateLimitedError,
					AgentTemporaryUnavailableError,
				],
			},
		).middleware(AgentHttpAuthMiddleware),
	)
	.add(
		HttpApiEndpoint.patch(
			"updateDeveloperAutoTopUp",
			"/developer/apps/:appId/auto-top-up",
			{
				params: AgentDeveloperAppPath,
				payload: AgentDeveloperAutoTopUpInput,
				success: AgentMutationResponse,
				error: [
					AgentBadRequestError,
					AgentAuthenticationError,
					AgentForbiddenError,
					AgentNotFoundError,
					AgentNotReadyError,
					AgentConflictError,
					AgentApprovalRequiredError,
					AgentRateLimitedError,
					AgentTemporaryUnavailableError,
				],
			},
		).middleware(AgentHttpAuthMiddleware),
	)
	.add(
		HttpApiEndpoint.post(
			"createDeveloperCreditsCheckout",
			"/developer/apps/:appId/credits/checkout",
			{
				params: AgentDeveloperAppPath,
				payload: AgentDeveloperCreditsCheckoutInput,
				success: AgentBrowserActionResponse,
				error: [
					AgentBadRequestError,
					AgentAuthenticationError,
					AgentForbiddenError,
					AgentNotFoundError,
					AgentNotReadyError,
					AgentConflictError,
					AgentApprovalRequiredError,
					AgentRateLimitedError,
					AgentTemporaryUnavailableError,
				],
			},
		).middleware(AgentHttpAuthMiddleware),
	)
	.add(
		HttpApiEndpoint.delete(
			"deleteDeveloperVideo",
			"/developer/apps/:appId/videos/:videoId",
			{
				params: AgentDeveloperVideoPath,
				success: AgentMutationResponse,
				error: [
					AgentBadRequestError,
					AgentAuthenticationError,
					AgentForbiddenError,
					AgentNotFoundError,
					AgentNotReadyError,
					AgentConflictError,
					AgentApprovalRequiredError,
					AgentRateLimitedError,
					AgentTemporaryUnavailableError,
				],
			},
		).middleware(AgentHttpAuthMiddleware),
	)
	.add(
		HttpApiEndpoint.delete(
			"deleteOrganization",
			"/organizations/:organizationId",
			{
				params: AgentOrganizationPath,
				success: AgentOperationResponse,
				error: [
					AgentBadRequestError,
					AgentAuthenticationError,
					AgentForbiddenError,
					AgentNotFoundError,
					AgentNotReadyError,
					AgentConflictError,
					AgentApprovalRequiredError,
					AgentRateLimitedError,
					AgentTemporaryUnavailableError,
				],
			},
		).middleware(AgentHttpAuthMiddleware),
	)
	.add(
		HttpApiEndpoint.put(
			"setOrganizationDomain",
			"/organizations/:organizationId/domain",
			{
				params: AgentOrganizationPath,
				payload: AgentOrganizationDomainInput,
				success: AgentOperationResponse,
				error: [
					AgentBadRequestError,
					AgentAuthenticationError,
					AgentForbiddenError,
					AgentNotFoundError,
					AgentNotReadyError,
					AgentConflictError,
					AgentApprovalRequiredError,
					AgentRateLimitedError,
					AgentTemporaryUnavailableError,
				],
			},
		).middleware(AgentHttpAuthMiddleware),
	)
	.add(
		HttpApiEndpoint.delete(
			"removeOrganizationDomain",
			"/organizations/:organizationId/domain",
			{
				params: AgentOrganizationPath,
				success: AgentOperationResponse,
				error: [
					AgentBadRequestError,
					AgentAuthenticationError,
					AgentForbiddenError,
					AgentNotFoundError,
					AgentNotReadyError,
					AgentConflictError,
					AgentApprovalRequiredError,
					AgentRateLimitedError,
					AgentTemporaryUnavailableError,
				],
			},
		).middleware(AgentHttpAuthMiddleware),
	)
	.add(
		HttpApiEndpoint.post(
			"verifyOrganizationDomain",
			"/organizations/:organizationId/domain/verify",
			{
				params: AgentOrganizationPath,
				success: AgentOperationResponse,
				error: [
					AgentBadRequestError,
					AgentAuthenticationError,
					AgentForbiddenError,
					AgentNotFoundError,
					AgentNotReadyError,
					AgentConflictError,
					AgentApprovalRequiredError,
					AgentRateLimitedError,
					AgentTemporaryUnavailableError,
				],
			},
		).middleware(AgentHttpAuthMiddleware),
	)
	.add(
		HttpApiEndpoint.get("getOperation", "/operations/:operationId", {
			params: AgentOperationPath,
			success: AgentOperationResponse,
			error: [
				AgentBadRequestError,
				AgentAuthenticationError,
				AgentForbiddenError,
				AgentNotFoundError,
				AgentNotReadyError,
				AgentRateLimitedError,
				AgentTemporaryUnavailableError,
			],
		}).middleware(AgentHttpAuthMiddleware),
	)
	.add(
		HttpApiEndpoint.patch("updateMe", "/me", {
			payload: AgentProfileUpdateInput,
			success: AgentMeResponse,
			error: [
				AgentBadRequestError,
				AgentAuthenticationError,
				AgentForbiddenError,
				AgentNotFoundError,
				AgentNotReadyError,
				AgentConflictError,
				AgentApprovalRequiredError,
				AgentRateLimitedError,
				AgentTemporaryUnavailableError,
			],
		}).middleware(AgentHttpAuthMiddleware),
	)
	.add(
		HttpApiEndpoint.put("updateProfileImage", "/me/image", {
			payload: AgentImageInput,
			success: AgentMutationResponse,
			error: [
				AgentBadRequestError,
				AgentAuthenticationError,
				AgentForbiddenError,
				AgentNotFoundError,
				AgentNotReadyError,
				AgentConflictError,
				AgentApprovalRequiredError,
				AgentRateLimitedError,
				AgentTemporaryUnavailableError,
			],
		}).middleware(AgentHttpAuthMiddleware),
	)
	.add(
		HttpApiEndpoint.delete("removeProfileImage", "/me/image", {
			success: AgentMutationResponse,
			error: [
				AgentBadRequestError,
				AgentAuthenticationError,
				AgentForbiddenError,
				AgentNotFoundError,
				AgentNotReadyError,
				AgentConflictError,
				AgentApprovalRequiredError,
				AgentRateLimitedError,
				AgentTemporaryUnavailableError,
			],
		}).middleware(AgentHttpAuthMiddleware),
	)
	.add(
		HttpApiEndpoint.post("signOutAllDevices", "/me/sign-out-all", {
			success: AgentMutationResponse,
			error: [
				AgentBadRequestError,
				AgentAuthenticationError,
				AgentForbiddenError,
				AgentNotFoundError,
				AgentNotReadyError,
				AgentConflictError,
				AgentApprovalRequiredError,
				AgentRateLimitedError,
				AgentTemporaryUnavailableError,
			],
		}).middleware(AgentHttpAuthMiddleware),
	)
	.add(
		HttpApiEndpoint.post("openReferralPortal", "/me/referrals", {
			success: AgentBrowserActionResponse,
			error: [
				AgentBadRequestError,
				AgentAuthenticationError,
				AgentForbiddenError,
				AgentNotFoundError,
				AgentNotReadyError,
				AgentConflictError,
				AgentApprovalRequiredError,
				AgentRateLimitedError,
				AgentTemporaryUnavailableError,
			],
		}).middleware(AgentHttpAuthMiddleware),
	)
	.add(
		HttpApiEndpoint.post("createOrganization", "/organizations", {
			payload: AgentOrganizationCreateInput,
			success: AgentMutationResponse,
			error: [
				AgentBadRequestError,
				AgentAuthenticationError,
				AgentForbiddenError,
				AgentNotFoundError,
				AgentNotReadyError,
				AgentConflictError,
				AgentApprovalRequiredError,
				AgentRateLimitedError,
				AgentTemporaryUnavailableError,
			],
		}).middleware(AgentHttpAuthMiddleware),
	)
	.add(
		HttpApiEndpoint.patch(
			"updateOrganization",
			"/organizations/:organizationId",
			{
				params: AgentOrganizationPath,
				payload: AgentOrganizationUpdateInput,
				success: AgentMutationResponse,
				error: [
					AgentBadRequestError,
					AgentAuthenticationError,
					AgentForbiddenError,
					AgentNotFoundError,
					AgentNotReadyError,
					AgentConflictError,
					AgentApprovalRequiredError,
					AgentRateLimitedError,
					AgentTemporaryUnavailableError,
				],
			},
		).middleware(AgentHttpAuthMiddleware),
	)
	.add(
		HttpApiEndpoint.put(
			"updateOrganizationIcon",
			"/organizations/:organizationId/icon",
			{
				params: AgentOrganizationPath,
				payload: AgentImageInput,
				success: AgentMutationResponse,
				error: [
					AgentBadRequestError,
					AgentAuthenticationError,
					AgentForbiddenError,
					AgentNotFoundError,
					AgentNotReadyError,
					AgentConflictError,
					AgentApprovalRequiredError,
					AgentRateLimitedError,
					AgentTemporaryUnavailableError,
				],
			},
		).middleware(AgentHttpAuthMiddleware),
	)
	.add(
		HttpApiEndpoint.delete(
			"removeOrganizationIcon",
			"/organizations/:organizationId/icon",
			{
				params: AgentOrganizationPath,
				success: AgentMutationResponse,
				error: [
					AgentBadRequestError,
					AgentAuthenticationError,
					AgentForbiddenError,
					AgentNotFoundError,
					AgentNotReadyError,
					AgentConflictError,
					AgentApprovalRequiredError,
					AgentRateLimitedError,
					AgentTemporaryUnavailableError,
				],
			},
		).middleware(AgentHttpAuthMiddleware),
	)
	.add(
		HttpApiEndpoint.put(
			"updateShareableLinkIcon",
			"/organizations/:organizationId/shareable-link-icon",
			{
				params: AgentOrganizationPath,
				payload: AgentImageInput,
				success: AgentMutationResponse,
				error: [
					AgentBadRequestError,
					AgentAuthenticationError,
					AgentForbiddenError,
					AgentNotFoundError,
					AgentNotReadyError,
					AgentConflictError,
					AgentApprovalRequiredError,
					AgentRateLimitedError,
					AgentTemporaryUnavailableError,
				],
			},
		).middleware(AgentHttpAuthMiddleware),
	)
	.add(
		HttpApiEndpoint.delete(
			"removeShareableLinkIcon",
			"/organizations/:organizationId/shareable-link-icon",
			{
				params: AgentOrganizationPath,
				success: AgentMutationResponse,
				error: [
					AgentBadRequestError,
					AgentAuthenticationError,
					AgentForbiddenError,
					AgentNotFoundError,
					AgentNotReadyError,
					AgentConflictError,
					AgentApprovalRequiredError,
					AgentRateLimitedError,
					AgentTemporaryUnavailableError,
				],
			},
		).middleware(AgentHttpAuthMiddleware),
	)
	.add(
		HttpApiEndpoint.post(
			"createSubscriptionCheckout",
			"/organizations/:organizationId/billing/checkout",
			{
				params: AgentOrganizationPath,
				payload: AgentSubscriptionCheckoutInput,
				success: AgentBrowserActionResponse,
				error: [
					AgentBadRequestError,
					AgentAuthenticationError,
					AgentForbiddenError,
					AgentNotFoundError,
					AgentNotReadyError,
					AgentConflictError,
					AgentApprovalRequiredError,
					AgentRateLimitedError,
					AgentTemporaryUnavailableError,
				],
			},
		).middleware(AgentHttpAuthMiddleware),
	)
	.add(
		HttpApiEndpoint.post(
			"createBillingPortal",
			"/organizations/:organizationId/billing/portal",
			{
				params: AgentOrganizationPath,
				success: AgentBrowserActionResponse,
				error: [
					AgentBadRequestError,
					AgentAuthenticationError,
					AgentForbiddenError,
					AgentNotFoundError,
					AgentNotReadyError,
					AgentConflictError,
					AgentApprovalRequiredError,
					AgentRateLimitedError,
					AgentTemporaryUnavailableError,
				],
			},
		).middleware(AgentHttpAuthMiddleware),
	)
	.add(
		HttpApiEndpoint.put(
			"updateOrganizationS3",
			"/organizations/:organizationId/storage/s3",
			{
				params: AgentOrganizationPath,
				payload: AgentS3ConfigInput,
				success: AgentMutationResponse,
				error: [
					AgentBadRequestError,
					AgentAuthenticationError,
					AgentForbiddenError,
					AgentNotFoundError,
					AgentNotReadyError,
					AgentConflictError,
					AgentApprovalRequiredError,
					AgentRateLimitedError,
					AgentTemporaryUnavailableError,
				],
			},
		).middleware(AgentHttpAuthMiddleware),
	)
	.add(
		HttpApiEndpoint.post(
			"testOrganizationS3",
			"/organizations/:organizationId/storage/s3/test",
			{
				params: AgentOrganizationPath,
				payload: AgentS3ConfigInput,
				success: AgentMutationResponse,
				error: [
					AgentBadRequestError,
					AgentAuthenticationError,
					AgentForbiddenError,
					AgentNotFoundError,
					AgentNotReadyError,
					AgentConflictError,
					AgentApprovalRequiredError,
					AgentRateLimitedError,
					AgentTemporaryUnavailableError,
				],
			},
		).middleware(AgentHttpAuthMiddleware),
	)
	.add(
		HttpApiEndpoint.delete(
			"removeOrganizationS3",
			"/organizations/:organizationId/storage/s3",
			{
				params: AgentOrganizationPath,
				success: AgentMutationResponse,
				error: [
					AgentBadRequestError,
					AgentAuthenticationError,
					AgentForbiddenError,
					AgentNotFoundError,
					AgentNotReadyError,
					AgentConflictError,
					AgentApprovalRequiredError,
					AgentRateLimitedError,
					AgentTemporaryUnavailableError,
				],
			},
		).middleware(AgentHttpAuthMiddleware),
	)
	.add(
		HttpApiEndpoint.patch(
			"updateOrganizationStorageProvider",
			"/organizations/:organizationId/storage/provider",
			{
				params: AgentOrganizationPath,
				payload: AgentStorageProviderInput,
				success: AgentMutationResponse,
				error: [
					AgentBadRequestError,
					AgentAuthenticationError,
					AgentForbiddenError,
					AgentNotFoundError,
					AgentNotReadyError,
					AgentConflictError,
					AgentApprovalRequiredError,
					AgentRateLimitedError,
					AgentTemporaryUnavailableError,
				],
			},
		).middleware(AgentHttpAuthMiddleware),
	)
	.add(
		HttpApiEndpoint.post(
			"connectOrganizationGoogleDrive",
			"/organizations/:organizationId/storage/google-drive/connect",
			{
				params: AgentOrganizationPath,
				success: AgentBrowserActionResponse,
				error: [
					AgentBadRequestError,
					AgentAuthenticationError,
					AgentForbiddenError,
					AgentNotFoundError,
					AgentNotReadyError,
					AgentConflictError,
					AgentApprovalRequiredError,
					AgentRateLimitedError,
					AgentTemporaryUnavailableError,
				],
			},
		).middleware(AgentHttpAuthMiddleware),
	)
	.add(
		HttpApiEndpoint.delete(
			"disconnectOrganizationGoogleDrive",
			"/organizations/:organizationId/storage/google-drive",
			{
				params: AgentOrganizationPath,
				success: AgentMutationResponse,
				error: [
					AgentBadRequestError,
					AgentAuthenticationError,
					AgentForbiddenError,
					AgentNotFoundError,
					AgentNotReadyError,
					AgentConflictError,
					AgentApprovalRequiredError,
					AgentRateLimitedError,
					AgentTemporaryUnavailableError,
				],
			},
		).middleware(AgentHttpAuthMiddleware),
	)
	.add(
		HttpApiEndpoint.put(
			"setOrganizationGoogleDriveLocation",
			"/organizations/:organizationId/storage/google-drive/location",
			{
				params: AgentOrganizationPath,
				payload: AgentGoogleDriveLocationInput,
				success: AgentMutationResponse,
				error: [
					AgentBadRequestError,
					AgentAuthenticationError,
					AgentForbiddenError,
					AgentNotFoundError,
					AgentNotReadyError,
					AgentConflictError,
					AgentApprovalRequiredError,
					AgentRateLimitedError,
					AgentTemporaryUnavailableError,
				],
			},
		).middleware(AgentHttpAuthMiddleware),
	)
	.add(
		HttpApiEndpoint.patch(
			"updateOrganizationSettings",
			"/organizations/:organizationId/settings",
			{
				params: AgentOrganizationPath,
				payload: AgentOrganizationSettingsInput,
				success: AgentMutationResponse,
				error: [
					AgentBadRequestError,
					AgentAuthenticationError,
					AgentForbiddenError,
					AgentNotFoundError,
					AgentNotReadyError,
					AgentConflictError,
					AgentApprovalRequiredError,
					AgentRateLimitedError,
					AgentTemporaryUnavailableError,
				],
			},
		).middleware(AgentHttpAuthMiddleware),
	)
	.add(
		HttpApiEndpoint.post(
			"createOrganizationInvite",
			"/organizations/:organizationId/invites",
			{
				params: AgentOrganizationPath,
				payload: AgentOrganizationInviteInput,
				success: AgentOrganizationInviteResponse,
				error: [
					AgentBadRequestError,
					AgentAuthenticationError,
					AgentForbiddenError,
					AgentNotFoundError,
					AgentNotReadyError,
					AgentConflictError,
					AgentApprovalRequiredError,
					AgentRateLimitedError,
					AgentTemporaryUnavailableError,
				],
			},
		).middleware(AgentHttpAuthMiddleware),
	)
	.add(
		HttpApiEndpoint.delete(
			"deleteOrganizationInvite",
			"/organizations/:organizationId/invites/:inviteId",
			{
				params: AgentOrganizationInvitePath,
				success: AgentMutationResponse,
				error: [
					AgentBadRequestError,
					AgentAuthenticationError,
					AgentForbiddenError,
					AgentNotFoundError,
					AgentNotReadyError,
					AgentConflictError,
					AgentApprovalRequiredError,
					AgentRateLimitedError,
					AgentTemporaryUnavailableError,
				],
			},
		).middleware(AgentHttpAuthMiddleware),
	)
	.add(
		HttpApiEndpoint.patch(
			"updateOrganizationMemberSeat",
			"/organizations/:organizationId/members/:memberId/seat",
			{
				params: AgentOrganizationMemberPath,
				payload: AgentOrganizationMemberSeatInput,
				success: AgentMutationResponse,
				error: [
					AgentBadRequestError,
					AgentAuthenticationError,
					AgentForbiddenError,
					AgentNotFoundError,
					AgentNotReadyError,
					AgentConflictError,
					AgentApprovalRequiredError,
					AgentRateLimitedError,
					AgentTemporaryUnavailableError,
				],
			},
		).middleware(AgentHttpAuthMiddleware),
	)
	.add(
		HttpApiEndpoint.patch(
			"updateOrganizationMember",
			"/organizations/:organizationId/members/:memberId",
			{
				params: AgentOrganizationMemberPath,
				payload: AgentOrganizationMemberUpdateInput,
				success: AgentMutationResponse,
				error: [
					AgentBadRequestError,
					AgentAuthenticationError,
					AgentForbiddenError,
					AgentNotFoundError,
					AgentNotReadyError,
					AgentConflictError,
					AgentApprovalRequiredError,
					AgentRateLimitedError,
					AgentTemporaryUnavailableError,
				],
			},
		).middleware(AgentHttpAuthMiddleware),
	)
	.add(
		HttpApiEndpoint.delete(
			"removeOrganizationMember",
			"/organizations/:organizationId/members/:memberId",
			{
				params: AgentOrganizationMemberPath,
				success: AgentMutationResponse,
				error: [
					AgentBadRequestError,
					AgentAuthenticationError,
					AgentForbiddenError,
					AgentNotFoundError,
					AgentNotReadyError,
					AgentConflictError,
					AgentApprovalRequiredError,
					AgentRateLimitedError,
					AgentTemporaryUnavailableError,
				],
			},
		).middleware(AgentHttpAuthMiddleware),
	)
	.add(
		HttpApiEndpoint.patch(
			"updateNotificationPreferences",
			"/me/notification-preferences",
			{
				payload: AgentNotificationPreferencesInput,
				success: AgentNotificationPreferencesResponse,
				error: [
					AgentBadRequestError,
					AgentAuthenticationError,
					AgentForbiddenError,
					AgentNotFoundError,
					AgentNotReadyError,
					AgentConflictError,
					AgentApprovalRequiredError,
					AgentRateLimitedError,
					AgentTemporaryUnavailableError,
				],
			},
		).middleware(AgentHttpAuthMiddleware),
	)
	.add(
		HttpApiEndpoint.post("markNotificationsRead", "/me/notifications/read", {
			payload: AgentNotificationsReadInput,
			success: AgentMutationResponse,
			error: [
				AgentBadRequestError,
				AgentAuthenticationError,
				AgentForbiddenError,
				AgentNotFoundError,
				AgentNotReadyError,
				AgentConflictError,
				AgentApprovalRequiredError,
				AgentRateLimitedError,
				AgentTemporaryUnavailableError,
			],
		}).middleware(AgentHttpAuthMiddleware),
	)
	.add(
		HttpApiEndpoint.post("createUpload", "/uploads", {
			payload: AgentUploadCreateInput,
			success: AgentUploadCreateResponse,
			error: [
				AgentBadRequestError,
				AgentAuthenticationError,
				AgentForbiddenError,
				AgentNotFoundError,
				AgentNotReadyError,
				AgentConflictError,
				AgentApprovalRequiredError,
				AgentRateLimitedError,
				AgentTemporaryUnavailableError,
			],
		}).middleware(AgentHttpAuthMiddleware),
	)
	.add(
		HttpApiEndpoint.post("completeUpload", "/uploads/:id/complete", {
			params: AgentVideoPath,
			payload: AgentUploadCompleteInput,
			success: AgentUploadCompleteResponse,
			error: [
				AgentBadRequestError,
				AgentAuthenticationError,
				AgentForbiddenError,
				AgentNotFoundError,
				AgentNotReadyError,
				AgentConflictError,
				AgentApprovalRequiredError,
				AgentRateLimitedError,
				AgentTemporaryUnavailableError,
			],
		}).middleware(AgentHttpAuthMiddleware),
	)
	.add(
		HttpApiEndpoint.post(
			"importLoomCap",
			"/organizations/:organizationId/imports/loom",
			{
				params: AgentOrganizationPath,
				payload: AgentLoomImportInput,
				success: AgentOperationResponse,
				error: [
					AgentBadRequestError,
					AgentAuthenticationError,
					AgentForbiddenError,
					AgentNotFoundError,
					AgentNotReadyError,
					AgentConflictError,
					AgentApprovalRequiredError,
					AgentRateLimitedError,
					AgentTemporaryUnavailableError,
				],
			},
		).middleware(AgentHttpAuthMiddleware),
	)
	.add(
		HttpApiEndpoint.post("processCap", "/caps/:id/process", {
			params: AgentVideoPath,
			payload: AgentProcessInput,
			success: AgentProcessResponse,
			error: [
				AgentBadRequestError,
				AgentAuthenticationError,
				AgentForbiddenError,
				AgentNotFoundError,
				AgentNotReadyError,
				AgentConflictError,
				AgentApprovalRequiredError,
				AgentRateLimitedError,
				AgentTemporaryUnavailableError,
			],
		}).middleware(AgentHttpAuthMiddleware),
	)
	.add(
		HttpApiEndpoint.put("replaceTranscript", "/caps/:id/transcript", {
			params: AgentVideoPath,
			payload: AgentTranscriptUpdateInput,
			success: AgentTranscriptUpdateResponse,
			error: [
				AgentBadRequestError,
				AgentAuthenticationError,
				AgentForbiddenError,
				AgentNotFoundError,
				AgentNotReadyError,
				AgentConflictError,
				AgentApprovalRequiredError,
				AgentRateLimitedError,
				AgentTemporaryUnavailableError,
			],
		}).middleware(AgentHttpAuthMiddleware),
	)
	.add(
		HttpApiEndpoint.put("updateCapPassword", "/caps/:id/password", {
			params: AgentVideoPath,
			success: AgentMutationResponse,
			error: [
				AgentBadRequestError,
				AgentAuthenticationError,
				AgentForbiddenError,
				AgentNotFoundError,
				AgentNotReadyError,
				AgentConflictError,
				AgentApprovalRequiredError,
				AgentRateLimitedError,
				AgentTemporaryUnavailableError,
			],
		}).middleware(AgentHttpAuthMiddleware),
	)
	.add(
		HttpApiEndpoint.post("duplicateCap", "/caps/:id/duplicate", {
			params: AgentVideoPath,
			success: AgentOperationResponse,
			error: [
				AgentBadRequestError,
				AgentAuthenticationError,
				AgentForbiddenError,
				AgentNotFoundError,
				AgentNotReadyError,
				AgentConflictError,
				AgentApprovalRequiredError,
				AgentRateLimitedError,
				AgentTemporaryUnavailableError,
			],
		}).middleware(AgentHttpAuthMiddleware),
	)
	.add(
		HttpApiEndpoint.delete("deleteCap", "/caps/:id", {
			params: AgentVideoPath,
			success: AgentOperationResponse,
			error: [
				AgentBadRequestError,
				AgentAuthenticationError,
				AgentForbiddenError,
				AgentNotFoundError,
				AgentNotReadyError,
				AgentConflictError,
				AgentApprovalRequiredError,
				AgentRateLimitedError,
				AgentTemporaryUnavailableError,
			],
		}).middleware(AgentHttpAuthMiddleware),
	)
	.add(
		HttpApiEndpoint.patch("updateCapSettings", "/caps/:id/settings", {
			params: AgentVideoPath,
			payload: AgentViewerSettingsInput,
			success: AgentMutationResponse,
			error: [
				AgentBadRequestError,
				AgentAuthenticationError,
				AgentForbiddenError,
				AgentNotFoundError,
				AgentNotReadyError,
				AgentConflictError,
				AgentApprovalRequiredError,
				AgentRateLimitedError,
				AgentTemporaryUnavailableError,
			],
		}).middleware(AgentHttpAuthMiddleware),
	)
	.add(
		HttpApiEndpoint.patch("updateCapDate", "/caps/:id/date", {
			params: AgentVideoPath,
			payload: AgentCapDateInput,
			success: AgentMutationResponse,
			error: [
				AgentBadRequestError,
				AgentAuthenticationError,
				AgentForbiddenError,
				AgentNotFoundError,
				AgentNotReadyError,
				AgentConflictError,
				AgentApprovalRequiredError,
				AgentRateLimitedError,
				AgentTemporaryUnavailableError,
			],
		}).middleware(AgentHttpAuthMiddleware),
	)
	.add(
		HttpApiEndpoint.delete("deleteFeedback", "/caps/:id/comments/:commentId", {
			params: AgentReplyPath,
			success: AgentMutationResponse,
			error: [
				AgentBadRequestError,
				AgentAuthenticationError,
				AgentForbiddenError,
				AgentNotFoundError,
				AgentNotReadyError,
				AgentConflictError,
				AgentApprovalRequiredError,
				AgentRateLimitedError,
				AgentTemporaryUnavailableError,
			],
		}).middleware(AgentHttpAuthMiddleware),
	)
	.add(
		HttpApiEndpoint.patch("moveCap", "/caps/:id/location", {
			params: AgentVideoPath,
			payload: AgentMoveCapInput,
			success: AgentMutationResponse,
			error: [
				AgentBadRequestError,
				AgentAuthenticationError,
				AgentForbiddenError,
				AgentNotFoundError,
				AgentNotReadyError,
				AgentConflictError,
				AgentApprovalRequiredError,
				AgentRateLimitedError,
				AgentTemporaryUnavailableError,
			],
		}).middleware(AgentHttpAuthMiddleware),
	)
	.add(
		HttpApiEndpoint.put(
			"shareCapWithOrganization",
			"/caps/:id/shares/organizations/:organizationId",
			{
				params: AgentOrganizationSharePath,
				payload: AgentShareInput,
				success: AgentMutationResponse,
				error: [
					AgentBadRequestError,
					AgentAuthenticationError,
					AgentForbiddenError,
					AgentNotFoundError,
					AgentNotReadyError,
					AgentConflictError,
					AgentApprovalRequiredError,
					AgentRateLimitedError,
					AgentTemporaryUnavailableError,
				],
			},
		).middleware(AgentHttpAuthMiddleware),
	)
	.add(
		HttpApiEndpoint.delete(
			"removeCapOrganizationShare",
			"/caps/:id/shares/organizations/:organizationId",
			{
				params: AgentOrganizationSharePath,
				success: AgentMutationResponse,
				error: [
					AgentBadRequestError,
					AgentAuthenticationError,
					AgentForbiddenError,
					AgentNotFoundError,
					AgentNotReadyError,
					AgentConflictError,
					AgentApprovalRequiredError,
					AgentRateLimitedError,
					AgentTemporaryUnavailableError,
				],
			},
		).middleware(AgentHttpAuthMiddleware),
	)
	.add(
		HttpApiEndpoint.put(
			"shareCapWithSpace",
			"/caps/:id/shares/spaces/:spaceId",
			{
				params: AgentSpaceSharePath,
				payload: AgentShareInput,
				success: AgentMutationResponse,
				error: [
					AgentBadRequestError,
					AgentAuthenticationError,
					AgentForbiddenError,
					AgentNotFoundError,
					AgentNotReadyError,
					AgentConflictError,
					AgentApprovalRequiredError,
					AgentRateLimitedError,
					AgentTemporaryUnavailableError,
				],
			},
		).middleware(AgentHttpAuthMiddleware),
	)
	.add(
		HttpApiEndpoint.delete(
			"removeCapSpaceShare",
			"/caps/:id/shares/spaces/:spaceId",
			{
				params: AgentSpaceSharePath,
				success: AgentMutationResponse,
				error: [
					AgentBadRequestError,
					AgentAuthenticationError,
					AgentForbiddenError,
					AgentNotFoundError,
					AgentNotReadyError,
					AgentConflictError,
					AgentApprovalRequiredError,
					AgentRateLimitedError,
					AgentTemporaryUnavailableError,
				],
			},
		).middleware(AgentHttpAuthMiddleware),
	)
	.add(
		HttpApiEndpoint.post(
			"createFolder",
			"/organizations/:organizationId/folders",
			{
				params: AgentOrganizationPath,
				payload: AgentFolderCreateInput,
				success: AgentMutationResponse,
				error: [
					AgentBadRequestError,
					AgentAuthenticationError,
					AgentForbiddenError,
					AgentNotFoundError,
					AgentNotReadyError,
					AgentConflictError,
					AgentApprovalRequiredError,
					AgentRateLimitedError,
					AgentTemporaryUnavailableError,
				],
			},
		).middleware(AgentHttpAuthMiddleware),
	)
	.add(
		HttpApiEndpoint.patch("updateFolder", "/folders/:folderId", {
			params: AgentFolderPath,
			payload: AgentFolderUpdateInput,
			success: AgentMutationResponse,
			error: [
				AgentBadRequestError,
				AgentAuthenticationError,
				AgentForbiddenError,
				AgentNotFoundError,
				AgentNotReadyError,
				AgentConflictError,
				AgentApprovalRequiredError,
				AgentRateLimitedError,
				AgentTemporaryUnavailableError,
			],
		}).middleware(AgentHttpAuthMiddleware),
	)
	.add(
		HttpApiEndpoint.patch(
			"updateFolderPublicPage",
			"/folders/:folderId/public-page",
			{
				params: AgentFolderPath,
				payload: AgentCollectionPublicPageInput,
				success: AgentMutationResponse,
				error: [
					AgentBadRequestError,
					AgentAuthenticationError,
					AgentForbiddenError,
					AgentNotFoundError,
					AgentNotReadyError,
					AgentConflictError,
					AgentApprovalRequiredError,
					AgentRateLimitedError,
					AgentTemporaryUnavailableError,
				],
			},
		).middleware(AgentHttpAuthMiddleware),
	)
	.add(
		HttpApiEndpoint.put("updateFolderLogo", "/folders/:folderId/logo", {
			params: AgentFolderPath,
			payload: AgentImageInput,
			success: AgentMutationResponse,
			error: [
				AgentBadRequestError,
				AgentAuthenticationError,
				AgentForbiddenError,
				AgentNotFoundError,
				AgentNotReadyError,
				AgentConflictError,
				AgentApprovalRequiredError,
				AgentRateLimitedError,
				AgentTemporaryUnavailableError,
			],
		}).middleware(AgentHttpAuthMiddleware),
	)
	.add(
		HttpApiEndpoint.delete("removeFolderLogo", "/folders/:folderId/logo", {
			params: AgentFolderPath,
			success: AgentMutationResponse,
			error: [
				AgentBadRequestError,
				AgentAuthenticationError,
				AgentForbiddenError,
				AgentNotFoundError,
				AgentNotReadyError,
				AgentConflictError,
				AgentApprovalRequiredError,
				AgentRateLimitedError,
				AgentTemporaryUnavailableError,
			],
		}).middleware(AgentHttpAuthMiddleware),
	)
	.add(
		HttpApiEndpoint.delete("deleteFolder", "/folders/:folderId", {
			params: AgentFolderPath,
			success: AgentMutationResponse,
			error: [
				AgentBadRequestError,
				AgentAuthenticationError,
				AgentForbiddenError,
				AgentNotFoundError,
				AgentNotReadyError,
				AgentConflictError,
				AgentApprovalRequiredError,
				AgentRateLimitedError,
				AgentTemporaryUnavailableError,
			],
		}).middleware(AgentHttpAuthMiddleware),
	)
	.add(
		HttpApiEndpoint.post(
			"createSpace",
			"/organizations/:organizationId/spaces",
			{
				params: AgentOrganizationPath,
				payload: AgentSpaceCreateInput,
				success: AgentMutationResponse,
				error: [
					AgentBadRequestError,
					AgentAuthenticationError,
					AgentForbiddenError,
					AgentNotFoundError,
					AgentNotReadyError,
					AgentConflictError,
					AgentApprovalRequiredError,
					AgentRateLimitedError,
					AgentTemporaryUnavailableError,
				],
			},
		).middleware(AgentHttpAuthMiddleware),
	)
	.add(
		HttpApiEndpoint.patch("updateSpace", "/spaces/:spaceId", {
			params: AgentSpacePath,
			payload: AgentSpaceUpdateInput,
			success: AgentMutationResponse,
			error: [
				AgentBadRequestError,
				AgentAuthenticationError,
				AgentForbiddenError,
				AgentNotFoundError,
				AgentNotReadyError,
				AgentConflictError,
				AgentApprovalRequiredError,
				AgentRateLimitedError,
				AgentTemporaryUnavailableError,
			],
		}).middleware(AgentHttpAuthMiddleware),
	)
	.add(
		HttpApiEndpoint.patch(
			"updateSpacePublicPage",
			"/spaces/:spaceId/public-page",
			{
				params: AgentSpacePath,
				payload: AgentCollectionPublicPageInput,
				success: AgentMutationResponse,
				error: [
					AgentBadRequestError,
					AgentAuthenticationError,
					AgentForbiddenError,
					AgentNotFoundError,
					AgentNotReadyError,
					AgentConflictError,
					AgentApprovalRequiredError,
					AgentRateLimitedError,
					AgentTemporaryUnavailableError,
				],
			},
		).middleware(AgentHttpAuthMiddleware),
	)
	.add(
		HttpApiEndpoint.put("updateSpaceLogo", "/spaces/:spaceId/logo", {
			params: AgentSpacePath,
			payload: AgentImageInput,
			success: AgentMutationResponse,
			error: [
				AgentBadRequestError,
				AgentAuthenticationError,
				AgentForbiddenError,
				AgentNotFoundError,
				AgentNotReadyError,
				AgentConflictError,
				AgentApprovalRequiredError,
				AgentRateLimitedError,
				AgentTemporaryUnavailableError,
			],
		}).middleware(AgentHttpAuthMiddleware),
	)
	.add(
		HttpApiEndpoint.delete("removeSpaceLogo", "/spaces/:spaceId/logo", {
			params: AgentSpacePath,
			success: AgentMutationResponse,
			error: [
				AgentBadRequestError,
				AgentAuthenticationError,
				AgentForbiddenError,
				AgentNotFoundError,
				AgentNotReadyError,
				AgentConflictError,
				AgentApprovalRequiredError,
				AgentRateLimitedError,
				AgentTemporaryUnavailableError,
			],
		}).middleware(AgentHttpAuthMiddleware),
	)
	.add(
		HttpApiEndpoint.delete("deleteSpace", "/spaces/:spaceId", {
			params: AgentSpacePath,
			success: AgentMutationResponse,
			error: [
				AgentBadRequestError,
				AgentAuthenticationError,
				AgentForbiddenError,
				AgentNotFoundError,
				AgentNotReadyError,
				AgentConflictError,
				AgentApprovalRequiredError,
				AgentRateLimitedError,
				AgentTemporaryUnavailableError,
			],
		}).middleware(AgentHttpAuthMiddleware),
	)
	.add(
		HttpApiEndpoint.post("addSpaceMember", "/spaces/:spaceId/members", {
			params: AgentSpacePath,
			payload: AgentSpaceMemberAddInput,
			success: AgentMutationResponse,
			error: [
				AgentBadRequestError,
				AgentAuthenticationError,
				AgentForbiddenError,
				AgentNotFoundError,
				AgentNotReadyError,
				AgentConflictError,
				AgentApprovalRequiredError,
				AgentRateLimitedError,
				AgentTemporaryUnavailableError,
			],
		}).middleware(AgentHttpAuthMiddleware),
	)
	.add(
		HttpApiEndpoint.patch(
			"updateSpaceMember",
			"/spaces/:spaceId/members/:userId",
			{
				params: AgentSpaceMemberPath,
				payload: AgentSpaceMemberUpdateInput,
				success: AgentMutationResponse,
				error: [
					AgentBadRequestError,
					AgentAuthenticationError,
					AgentForbiddenError,
					AgentNotFoundError,
					AgentNotReadyError,
					AgentConflictError,
					AgentApprovalRequiredError,
					AgentRateLimitedError,
					AgentTemporaryUnavailableError,
				],
			},
		).middleware(AgentHttpAuthMiddleware),
	)
	.add(
		HttpApiEndpoint.delete(
			"removeSpaceMember",
			"/spaces/:spaceId/members/:userId",
			{
				params: AgentSpaceMemberPath,
				success: AgentMutationResponse,
				error: [
					AgentBadRequestError,
					AgentAuthenticationError,
					AgentForbiddenError,
					AgentNotFoundError,
					AgentNotReadyError,
					AgentConflictError,
					AgentApprovalRequiredError,
					AgentRateLimitedError,
					AgentTemporaryUnavailableError,
				],
			},
		).middleware(AgentHttpAuthMiddleware),
	) {}

export class AgentAuthHttpApi extends HttpApiGroup.make("agentAuth")
	.add(
		HttpApiEndpoint.post("exchangeToken", "/auth/token", {
			payload: AgentTokenRequest,
			success: AgentTokenResponse,
			error: [
				AgentBadRequestError,
				AgentAuthenticationError,
				AgentRateLimitedError,
				AgentTemporaryUnavailableError,
			],
		}),
	)
	.add(
		HttpApiEndpoint.get("getAuthStatus", "/auth/status", {
			success: AgentAuthStatusResponse,
			error: [AgentAuthenticationError, AgentTemporaryUnavailableError],
		}).middleware(AgentHttpAuthMiddleware),
	)
	.add(
		HttpApiEndpoint.post("revokeToken", "/auth/revoke", {
			success: AgentRevokeResponse,
			error: [AgentAuthenticationError, AgentTemporaryUnavailableError],
		}).middleware(AgentHttpAuthMiddleware),
	) {}

export class AgentApiContract extends HttpApi.make("cap-agent-api")
	.add(AgentAuthHttpApi)
	.add(AgentHttpApi)
	.add(AgentManagementHttpApi)
	.annotateMerge(
		OpenApi.annotations({
			title: "Cap Agent API",
			description:
				"Stable personal-library API used by Cap CLI and MCP clients",
		}),
	)
	.prefix("/api/v1") {}
