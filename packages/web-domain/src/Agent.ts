import {
	HttpApi,
	HttpApiEndpoint,
	HttpApiGroup,
	HttpApiMiddleware,
	HttpApiSchema,
	OpenApi,
} from "@effect/platform";
import { Context, Schema } from "effect";
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

export const AgentScope = Schema.Literal(
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
);
export type AgentScope = typeof AgentScope.Type;

export class AgentPrincipal extends Context.Tag("AgentPrincipal")<
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
>() {}

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
	HttpApiSchema.annotations({ status: 400 }),
) {}

export class AgentAuthenticationError extends Schema.TaggedError<AgentAuthenticationError>()(
	"AgentAuthenticationError",
	{
		...ErrorFields,
		code: Schema.Literal("AUTH_REQUIRED", "TOKEN_EXPIRED"),
	},
	HttpApiSchema.annotations({ status: 401 }),
) {}

export class AgentForbiddenError extends Schema.TaggedError<AgentForbiddenError>()(
	"AgentForbiddenError",
	{
		...ErrorFields,
		code: Schema.Literal("FORBIDDEN", "PASSWORD_REQUIRED", "CONTENT_DISABLED"),
	},
	HttpApiSchema.annotations({ status: 403 }),
) {}

export class AgentNotFoundError extends Schema.TaggedError<AgentNotFoundError>()(
	"AgentNotFoundError",
	{
		...ErrorFields,
		code: Schema.Literal("NOT_FOUND"),
	},
	HttpApiSchema.annotations({ status: 404 }),
) {}

export class AgentNotReadyError extends Schema.TaggedError<AgentNotReadyError>()(
	"AgentNotReadyError",
	{
		...ErrorFields,
		code: Schema.Literal("NOT_READY"),
	},
	HttpApiSchema.annotations({ status: 409 }),
) {}

export class AgentRateLimitedError extends Schema.TaggedError<AgentRateLimitedError>()(
	"AgentRateLimitedError",
	{
		...ErrorFields,
		code: Schema.Literal("RATE_LIMITED"),
	},
	HttpApiSchema.annotations({ status: 429 }),
) {}

export class AgentTemporaryUnavailableError extends Schema.TaggedError<AgentTemporaryUnavailableError>()(
	"AgentTemporaryUnavailableError",
	{
		...ErrorFields,
		code: Schema.Literal("TEMPORARY_UNAVAILABLE"),
	},
	HttpApiSchema.annotations({ status: 503 }),
) {}

export const AgentApiError = Schema.Union(
	AgentBadRequestError,
	AgentAuthenticationError,
	AgentForbiddenError,
	AgentNotFoundError,
	AgentNotReadyError,
	AgentRateLimitedError,
	AgentTemporaryUnavailableError,
);

export class AgentConflictError extends Schema.TaggedError<AgentConflictError>()(
	"AgentConflictError",
	{
		...ErrorFields,
		code: Schema.Literal(
			"CONFLICT",
			"IDEMPOTENCY_CONFLICT",
			"OPERATION_IN_PROGRESS",
		),
	},
	HttpApiSchema.annotations({ status: 409 }),
) {}

export class AgentApprovalRequiredError extends Schema.TaggedError<AgentApprovalRequiredError>()(
	"AgentApprovalRequiredError",
	{
		...ErrorFields,
		code: Schema.Literal("APPROVAL_REQUIRED", "SECURE_INPUT_REQUIRED"),
		approvalUrl: Schema.NullOr(Schema.String),
	},
	HttpApiSchema.annotations({ status: 428 }),
) {}

export class AgentHttpAuthMiddleware extends HttpApiMiddleware.Tag<AgentHttpAuthMiddleware>()(
	"AgentHttpAuthMiddleware",
	{
		provides: AgentPrincipal,
		failure: Schema.Union(
			AgentAuthenticationError,
			AgentTemporaryUnavailableError,
		),
	},
) {}

export const CapabilityReason = Schema.Literal(
	"CONTENT_DISABLED",
	"NOT_READY",
	"PASSWORD_REQUIRED",
	"OWNER_ONLY",
	"SCOPE_REQUIRED",
);

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
	status: Schema.Literal(
		"not_started",
		"queued",
		"processing",
		"complete",
		"error",
		"skipped",
		"no_audio",
		"unavailable",
	),
	reason: Schema.NullOr(Schema.String),
	retryable: Schema.Boolean,
});

export const AgentCapStatus = Schema.Struct({
	id: VideoId,
	overall: Schema.Literal("processing", "ready", "partial", "error"),
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
	access: Schema.Literal("owned", "shared"),
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
	scope: Schema.optional(Schema.Literal("all", "owned", "shared")),
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
	status: Schema.Literal("available", "not_ready", "unavailable"),
	reason: Schema.NullOr(Schema.String),
});

export const AgentTranscriptContent = Schema.extend(
	AgentContent,
	Schema.Struct({
		text: Schema.NullOr(Schema.String),
		cues: Schema.NullOr(Schema.Array(AgentTranscriptCue)),
	}),
);

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
	summary: Schema.extend(
		AgentContent,
		Schema.Struct({ value: Schema.NullOr(Schema.String) }),
	),
	chapters: Schema.extend(
		AgentContent,
		Schema.Struct({ value: Schema.NullOr(Schema.Array(AgentChapter)) }),
	),
	transcript: AgentTranscriptContent,
	comments: Schema.extend(
		AgentContent,
		Schema.Struct({ value: Schema.NullOr(Schema.Array(AgentComment)) }),
	),
	reactions: Schema.extend(
		AgentContent,
		Schema.Struct({ value: Schema.NullOr(Schema.Array(AgentReaction)) }),
	),
	views: Schema.Struct({
		status: Schema.Literal("available", "unavailable"),
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
	format: Schema.optional(Schema.Literal("text", "json", "vtt")),
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
	target: Schema.Literal("transcript", "ai", "all"),
	retry: Schema.optional(Schema.Boolean),
});

export const AgentProcessResponse = Schema.Struct({
	id: VideoId,
	requested: Schema.Literal("transcript", "ai", "all"),
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
	tokenKind: Schema.Literal("agent", "legacy"),
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
	type: Schema.Literal("text", "emoji"),
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

export const AgentActionReason = Schema.Literal(
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
);

export const AgentActionCapability = Schema.Struct({
	allowed: Schema.Boolean,
	reason: Schema.NullOr(AgentActionReason),
	requiredScopes: Schema.Array(AgentScope),
	confirmation: Schema.Literal("none", "user", "browser", "secure_input"),
	sideEffect: Schema.Literal(
		"read",
		"write",
		"external",
		"paid",
		"destructive",
	),
	idempotencyRequired: Schema.Boolean,
	asynchronous: Schema.Boolean,
});

export const AgentActionCapabilities = Schema.Record({
	key: Schema.String,
	value: AgentActionCapability,
});

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

export const AgentAiGenerationLanguage = Schema.Literal(
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
);

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
	role: Schema.Literal("owner", "admin", "member"),
	hasProSeat: Schema.Boolean,
	allowedEmailDomain: Schema.NullOr(Schema.String),
	customDomain: Schema.NullOr(Schema.String),
	domainVerifiedAt: Schema.NullOr(Schema.String),
	icon: Schema.NullOr(Schema.String),
	shareableLinkIcon: Schema.NullOr(Schema.String),
	settings: AgentOrganizationSettings,
	billing: Schema.Struct({
		status: Schema.NullOr(Schema.String),
		plan: Schema.Literal("free", "pro"),
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
	role: Schema.Literal("admin", "member"),
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
	role: Schema.optional(Schema.Literal("admin", "member")),
	sendEmail: Schema.optional(Schema.Boolean),
});

export const AgentMember = Schema.Struct({
	id: Schema.String,
	userId: UserId,
	email: Schema.String,
	name: Schema.NullOr(Schema.String),
	role: Schema.Literal("owner", "admin", "member"),
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
	role: Schema.Literal("owner", "admin", "member"),
	status: Schema.String,
	expiresAt: Schema.NullOr(Schema.String),
	createdAt: Schema.String,
	updatedAt: Schema.String,
	capabilities: AgentActionCapabilities,
});

export const AgentOrganizationInviteResponse = Schema.Struct({
	invite: AgentInvite,
	inviteUrl: Schema.String,
	emailDelivery: Schema.Literal("not_requested", "accepted"),
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
	color: Schema.Literal("normal", "blue", "red", "yellow"),
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
	privacy: Schema.Literal("Public", "Private"),
	public: Schema.Boolean,
	protected: Schema.Boolean,
	icon: Schema.NullOr(Schema.String),
	settings: AgentViewerSettings,
	publicPage: Schema.NullOr(PublicPageSettings),
	role: Schema.NullOr(Schema.Literal("admin", "member")),
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
	role: Schema.Literal("admin", "member"),
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
	unread: Schema.optional(Schema.Literal("true", "false")),
});

export const AgentNotification = Schema.Struct({
	id: Schema.String,
	organizationId: OrganisationId,
	type: Schema.Literal("view", "comment", "reply", "reaction", "anon_view"),
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
	range: Schema.optional(Schema.Literal("day", "week", "month", "year")),
});

export const AgentAnalyticsResponse = Schema.Struct({
	organizationId: OrganisationId,
	spaceId: Schema.NullOr(SpaceIdOrOrganisationId),
	capId: Schema.NullOr(VideoId),
	range: Schema.Literal("day", "week", "month", "year"),
	data: Schema.Unknown,
	requestId: Schema.String,
});

export const AgentCapSettingsResponse = Schema.Struct({
	id: VideoId,
	overrides: AgentViewerSettings,
	effective: AgentViewerSettings,
	inherited: Schema.Record({
		key: Schema.String,
		value: Schema.Array(
			Schema.Struct({ id: Schema.String, name: Schema.String }),
		),
	}),
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
	provider: Schema.Literal("s3", "googleDrive"),
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
	plan: Schema.Literal("free", "pro"),
	status: Schema.NullOr(Schema.String),
	managedExternally: Schema.Boolean,
	seats: Schema.Struct({ total: Schema.Number, assigned: Schema.Number }),
	capabilities: AgentActionCapabilities,
	requestId: Schema.String,
});

export const AgentSubscriptionCheckoutInput = Schema.Struct({
	interval: Schema.Literal("monthly", "yearly"),
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
	environment: Schema.Literal("development", "production"),
});

export const AgentDeveloperAppUpdateInput = Schema.Struct({
	name: Schema.optional(Schema.String),
	environment: Schema.optional(Schema.Literal("development", "production")),
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
	environment: Schema.Literal("development", "production"),
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
			keyType: Schema.Literal("public", "secret"),
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
	type: Schema.Literal(
		"topup",
		"video_create",
		"storage_daily",
		"refund",
		"adjustment",
	),
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
	processing: Schema.Literal(
		"started",
		"already-processing",
		"already-complete",
	),
	requestId: Schema.String,
});

export const AgentLoomImportInput = Schema.Struct({
	loomUrl: Schema.String,
	ownerEmail: Schema.optional(Schema.String),
	spaceName: Schema.optional(Schema.String),
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
	color: Schema.optional(Schema.Literal("normal", "blue", "red", "yellow")),
	parentId: Schema.optional(Schema.NullOr(FolderId)),
	spaceId: Schema.optional(Schema.NullOr(SpaceIdOrOrganisationId)),
	public: Schema.optional(Schema.Boolean),
});

export const AgentFolderUpdateInput = Schema.Struct({
	name: Schema.optional(Schema.String),
	color: Schema.optional(Schema.Literal("normal", "blue", "red", "yellow")),
	parentId: Schema.optional(Schema.NullOr(FolderId)),
	public: Schema.optional(Schema.Boolean),
	settings: Schema.optional(Schema.Unknown),
});

export const AgentSpaceCreateInput = Schema.Struct({
	name: Schema.String,
	description: Schema.optional(Schema.NullOr(Schema.String)),
	privacy: Schema.optional(Schema.Literal("Public", "Private")),
	public: Schema.optional(Schema.Boolean),
	settings: Schema.optional(AgentViewerSettingsInput),
});

export const AgentSpaceUpdateInput = Schema.Struct({
	name: Schema.optional(Schema.String),
	description: Schema.optional(Schema.NullOr(Schema.String)),
	privacy: Schema.optional(Schema.Literal("Public", "Private")),
	public: Schema.optional(Schema.Boolean),
	settings: Schema.optional(AgentViewerSettingsInput),
});

export const AgentCollectionPublicPageInput = Schema.extend(
	PublicPageSettingsUpdate,
	Schema.Struct({ public: Schema.optional(Schema.Boolean) }),
);

export const AgentSpaceMemberPath = Schema.Struct({
	spaceId: SpaceIdOrOrganisationId,
	userId: UserId,
});

export const AgentSpaceMemberAddInput = Schema.Struct({
	userId: UserId,
	role: Schema.optional(Schema.Literal("admin", "member")),
});

export const AgentSpaceMemberUpdateInput = Schema.Struct({
	role: Schema.Literal("admin", "member"),
});

export const AgentMoveCapInput = Schema.Struct({
	container: Schema.Literal("personal", "organization", "space"),
	organizationId: OrganisationId,
	spaceId: Schema.optional(SpaceIdOrOrganisationId),
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
	kind: Schema.Literal(
		"duplicate_cap",
		"delete_cap",
		"import_loom",
		"delete_organization",
		"set_organization_domain",
		"remove_organization_domain",
		"verify_organization_domain",
	),
	state: Schema.Literal("queued", "running", "succeeded", "failed"),
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

const addMutationErrors = <
	Name extends string,
	Method extends "POST" | "PATCH" | "PUT" | "DELETE",
	Path extends string,
>(
	endpoint: HttpApiEndpoint.HttpApiEndpoint<Name, Method, Path>,
) =>
	endpoint
		.addError(AgentBadRequestError)
		.addError(AgentAuthenticationError)
		.addError(AgentForbiddenError)
		.addError(AgentNotFoundError)
		.addError(AgentNotReadyError)
		.addError(AgentConflictError)
		.addError(AgentApprovalRequiredError)
		.addError(AgentRateLimitedError)
		.addError(AgentTemporaryUnavailableError)
		.middleware(AgentHttpAuthMiddleware);

const withReadErrors = <Name extends string, Path extends string>(
	endpoint: HttpApiEndpoint.HttpApiEndpoint<Name, "GET", Path>,
) =>
	endpoint
		.addError(AgentBadRequestError)
		.addError(AgentAuthenticationError)
		.addError(AgentForbiddenError)
		.addError(AgentNotFoundError)
		.addError(AgentNotReadyError)
		.addError(AgentRateLimitedError)
		.addError(AgentTemporaryUnavailableError)
		.middleware(AgentHttpAuthMiddleware);

export class AgentHttpApi extends HttpApiGroup.make("agent")
	.add(
		withReadErrors(HttpApiEndpoint.get("listCaps", "/caps"))
			.setUrlParams(AgentCapsListParams)
			.addSuccess(AgentCapsListResponse),
	)
	.add(
		withReadErrors(HttpApiEndpoint.get("getCap", "/caps/:id"))
			.setPath(AgentVideoPath)
			.addSuccess(AgentCapSummary),
	)
	.add(
		withReadErrors(HttpApiEndpoint.get("getContext", "/caps/:id/context"))
			.setPath(AgentVideoPath)
			.addSuccess(AgentCapContext),
	)
	.add(
		withReadErrors(HttpApiEndpoint.get("getStatus", "/caps/:id/status"))
			.setPath(AgentVideoPath)
			.addSuccess(AgentCapStatus),
	)
	.add(
		withReadErrors(HttpApiEndpoint.get("getTranscript", "/caps/:id/transcript"))
			.setPath(AgentVideoPath)
			.setUrlParams(AgentTranscriptParams),
	)
	.add(
		withReadErrors(HttpApiEndpoint.get("getDownload", "/caps/:id/download"))
			.setPath(AgentVideoPath)
			.addSuccess(AgentDownloadResponse),
	)
	.add(
		HttpApiEndpoint.post("unlockCap", "/caps/:id/unlock")
			.setPath(AgentVideoPath)
			.addSuccess(AgentUnlockResponse)
			.addError(AgentBadRequestError)
			.addError(AgentAuthenticationError)
			.addError(AgentForbiddenError)
			.addError(AgentNotFoundError)
			.addError(AgentRateLimitedError)
			.addError(AgentTemporaryUnavailableError)
			.middleware(AgentHttpAuthMiddleware),
	)
	.add(
		HttpApiEndpoint.post("createComment", "/caps/:id/comments")
			.setPath(AgentVideoPath)
			.setPayload(AgentFeedbackInput)
			.addSuccess(AgentFeedbackResponse)
			.addError(AgentBadRequestError)
			.addError(AgentAuthenticationError)
			.addError(AgentForbiddenError)
			.addError(AgentNotFoundError)
			.addError(AgentConflictError)
			.addError(AgentApprovalRequiredError)
			.addError(AgentRateLimitedError)
			.addError(AgentTemporaryUnavailableError)
			.middleware(AgentHttpAuthMiddleware),
	)
	.add(
		HttpApiEndpoint.post("createReply", "/caps/:id/comments/:commentId/replies")
			.setPath(AgentReplyPath)
			.setPayload(AgentFeedbackInput)
			.addSuccess(AgentFeedbackResponse)
			.addError(AgentBadRequestError)
			.addError(AgentAuthenticationError)
			.addError(AgentForbiddenError)
			.addError(AgentNotFoundError)
			.addError(AgentConflictError)
			.addError(AgentApprovalRequiredError)
			.addError(AgentRateLimitedError)
			.addError(AgentTemporaryUnavailableError)
			.middleware(AgentHttpAuthMiddleware),
	)
	.add(
		HttpApiEndpoint.post("createReaction", "/caps/:id/reactions")
			.setPath(AgentVideoPath)
			.setPayload(AgentFeedbackInput)
			.addSuccess(AgentFeedbackResponse)
			.addError(AgentBadRequestError)
			.addError(AgentAuthenticationError)
			.addError(AgentForbiddenError)
			.addError(AgentNotFoundError)
			.addError(AgentConflictError)
			.addError(AgentApprovalRequiredError)
			.addError(AgentRateLimitedError)
			.addError(AgentTemporaryUnavailableError)
			.middleware(AgentHttpAuthMiddleware),
	)
	.add(
		HttpApiEndpoint.patch("updateCap", "/caps/:id")
			.setPath(AgentVideoPath)
			.setPayload(AgentCapUpdateInput)
			.addSuccess(AgentCapUpdateResponse)
			.addError(AgentBadRequestError)
			.addError(AgentAuthenticationError)
			.addError(AgentForbiddenError)
			.addError(AgentNotFoundError)
			.addError(AgentConflictError)
			.addError(AgentApprovalRequiredError)
			.addError(AgentRateLimitedError)
			.addError(AgentTemporaryUnavailableError)
			.middleware(AgentHttpAuthMiddleware),
	) {}

export class AgentManagementHttpApi extends HttpApiGroup.make("agentManagement")
	.add(
		withReadErrors(HttpApiEndpoint.get("getMe", "/me")).addSuccess(
			AgentMeResponse,
		),
	)
	.add(
		withReadErrors(
			HttpApiEndpoint.get("listOrganizations", "/organizations"),
		).addSuccess(AgentOrganizationsResponse),
	)
	.add(
		withReadErrors(
			HttpApiEndpoint.get("getOrganization", "/organizations/:organizationId"),
		)
			.setPath(AgentOrganizationPath)
			.addSuccess(AgentOrganizationResponse),
	)
	.add(
		withReadErrors(
			HttpApiEndpoint.get(
				"listOrganizationMembers",
				"/organizations/:organizationId/members",
			),
		)
			.setPath(AgentOrganizationPath)
			.addSuccess(AgentMembersResponse),
	)
	.add(
		withReadErrors(
			HttpApiEndpoint.get(
				"listOrganizationInvites",
				"/organizations/:organizationId/invites",
			),
		)
			.setPath(AgentOrganizationPath)
			.addSuccess(AgentInvitesResponse),
	)
	.add(
		withReadErrors(
			HttpApiEndpoint.get(
				"listFolders",
				"/organizations/:organizationId/folders",
			),
		)
			.setPath(AgentOrganizationPath)
			.setUrlParams(AgentContainerParams)
			.addSuccess(AgentFoldersResponse),
	)
	.add(
		withReadErrors(
			HttpApiEndpoint.get(
				"listSpaces",
				"/organizations/:organizationId/spaces",
			),
		)
			.setPath(AgentOrganizationPath)
			.addSuccess(AgentSpacesResponse),
	)
	.add(
		withReadErrors(
			HttpApiEndpoint.get("listSpaceMembers", "/spaces/:spaceId/members"),
		)
			.setPath(AgentSpacePath)
			.addSuccess(AgentSpaceMembersResponse),
	)
	.add(
		withReadErrors(
			HttpApiEndpoint.get("listNotifications", "/me/notifications"),
		)
			.setUrlParams(AgentNotificationParams)
			.addSuccess(AgentNotificationsResponse),
	)
	.add(
		withReadErrors(
			HttpApiEndpoint.get(
				"getNotificationPreferences",
				"/me/notification-preferences",
			),
		).addSuccess(AgentNotificationPreferencesResponse),
	)
	.add(
		withReadErrors(HttpApiEndpoint.get("getAnalytics", "/analytics"))
			.setUrlParams(AgentAnalyticsParams)
			.addSuccess(AgentAnalyticsResponse),
	)
	.add(
		withReadErrors(HttpApiEndpoint.get("getCapSettings", "/caps/:id/settings"))
			.setPath(AgentVideoPath)
			.addSuccess(AgentCapSettingsResponse),
	)
	.add(
		withReadErrors(HttpApiEndpoint.get("getCapShares", "/caps/:id/shares"))
			.setPath(AgentVideoPath)
			.addSuccess(AgentCapSharesResponse),
	)
	.add(
		withReadErrors(
			HttpApiEndpoint.get(
				"listStorageIntegrations",
				"/organizations/:organizationId/storage-integrations",
			),
		)
			.setPath(AgentOrganizationPath)
			.addSuccess(AgentStorageIntegrationsResponse),
	)
	.add(
		withReadErrors(
			HttpApiEndpoint.get(
				"listOrganizationGoogleDriveFolders",
				"/organizations/:organizationId/storage/google-drive/folders",
			),
		)
			.setPath(AgentOrganizationPath)
			.setUrlParams(AgentGoogleDriveFolderParams)
			.addSuccess(AgentGoogleDriveFoldersResponse),
	)
	.add(
		withReadErrors(
			HttpApiEndpoint.get(
				"getOrganizationBilling",
				"/organizations/:organizationId/billing",
			),
		)
			.setPath(AgentOrganizationPath)
			.addSuccess(AgentBillingResponse),
	)
	.add(
		withReadErrors(
			HttpApiEndpoint.get("listDeveloperApps", "/developer/apps"),
		).addSuccess(AgentDeveloperAppsResponse),
	)
	.add(
		withReadErrors(
			HttpApiEndpoint.get(
				"getDeveloperAppContext",
				"/developer/apps/:appId/context",
			),
		)
			.setPath(AgentDeveloperAppPath)
			.addSuccess(AgentDeveloperAppContextResponse),
	)
	.add(
		withReadErrors(
			HttpApiEndpoint.get(
				"listDeveloperVideos",
				"/developer/apps/:appId/videos",
			),
		)
			.setPath(AgentDeveloperAppPath)
			.setUrlParams(AgentDeveloperVideoParams)
			.addSuccess(AgentDeveloperVideosResponse),
	)
	.add(
		withReadErrors(
			HttpApiEndpoint.get(
				"listDeveloperTransactions",
				"/developer/apps/:appId/transactions",
			),
		)
			.setPath(AgentDeveloperAppPath)
			.setUrlParams(AgentDeveloperListParams)
			.addSuccess(AgentDeveloperTransactionsResponse),
	)
	.add(
		addMutationErrors(
			HttpApiEndpoint.post("createDeveloperApp", "/developer/apps"),
		)
			.setPayload(AgentDeveloperAppCreateInput)
			.addSuccess(AgentDeveloperCredentialsResponse),
	)
	.add(
		addMutationErrors(
			HttpApiEndpoint.patch("updateDeveloperApp", "/developer/apps/:appId"),
		)
			.setPath(AgentDeveloperAppPath)
			.setPayload(AgentDeveloperAppUpdateInput)
			.addSuccess(AgentMutationResponse),
	)
	.add(
		addMutationErrors(
			HttpApiEndpoint.del("deleteDeveloperApp", "/developer/apps/:appId"),
		)
			.setPath(AgentDeveloperAppPath)
			.addSuccess(AgentMutationResponse),
	)
	.add(
		addMutationErrors(
			HttpApiEndpoint.post(
				"addDeveloperDomain",
				"/developer/apps/:appId/domains",
			),
		)
			.setPath(AgentDeveloperAppPath)
			.setPayload(AgentDeveloperDomainInput)
			.addSuccess(AgentMutationResponse),
	)
	.add(
		addMutationErrors(
			HttpApiEndpoint.del(
				"removeDeveloperDomain",
				"/developer/apps/:appId/domains/:domainId",
			),
		)
			.setPath(AgentDeveloperAppDomainPath)
			.addSuccess(AgentMutationResponse),
	)
	.add(
		addMutationErrors(
			HttpApiEndpoint.post(
				"rotateDeveloperKeys",
				"/developer/apps/:appId/keys/rotate",
			),
		)
			.setPath(AgentDeveloperAppPath)
			.addSuccess(AgentDeveloperCredentialsResponse),
	)
	.add(
		addMutationErrors(
			HttpApiEndpoint.patch(
				"updateDeveloperAutoTopUp",
				"/developer/apps/:appId/auto-top-up",
			),
		)
			.setPath(AgentDeveloperAppPath)
			.setPayload(AgentDeveloperAutoTopUpInput)
			.addSuccess(AgentMutationResponse),
	)
	.add(
		addMutationErrors(
			HttpApiEndpoint.post(
				"createDeveloperCreditsCheckout",
				"/developer/apps/:appId/credits/checkout",
			),
		)
			.setPath(AgentDeveloperAppPath)
			.setPayload(AgentDeveloperCreditsCheckoutInput)
			.addSuccess(AgentBrowserActionResponse),
	)
	.add(
		addMutationErrors(
			HttpApiEndpoint.del(
				"deleteDeveloperVideo",
				"/developer/apps/:appId/videos/:videoId",
			),
		)
			.setPath(AgentDeveloperVideoPath)
			.addSuccess(AgentMutationResponse),
	)
	.add(
		addMutationErrors(
			HttpApiEndpoint.del(
				"deleteOrganization",
				"/organizations/:organizationId",
			),
		)
			.setPath(AgentOrganizationPath)
			.addSuccess(AgentOperationResponse),
	)
	.add(
		addMutationErrors(
			HttpApiEndpoint.put(
				"setOrganizationDomain",
				"/organizations/:organizationId/domain",
			),
		)
			.setPath(AgentOrganizationPath)
			.setPayload(AgentOrganizationDomainInput)
			.addSuccess(AgentOperationResponse),
	)
	.add(
		addMutationErrors(
			HttpApiEndpoint.del(
				"removeOrganizationDomain",
				"/organizations/:organizationId/domain",
			),
		)
			.setPath(AgentOrganizationPath)
			.addSuccess(AgentOperationResponse),
	)
	.add(
		addMutationErrors(
			HttpApiEndpoint.post(
				"verifyOrganizationDomain",
				"/organizations/:organizationId/domain/verify",
			),
		)
			.setPath(AgentOrganizationPath)
			.addSuccess(AgentOperationResponse),
	)
	.add(
		withReadErrors(
			HttpApiEndpoint.get("getOperation", "/operations/:operationId"),
		)
			.setPath(AgentOperationPath)
			.addSuccess(AgentOperationResponse),
	)
	.add(
		addMutationErrors(HttpApiEndpoint.patch("updateMe", "/me"))
			.setPayload(AgentProfileUpdateInput)
			.addSuccess(AgentMeResponse),
	)
	.add(
		addMutationErrors(HttpApiEndpoint.put("updateProfileImage", "/me/image"))
			.setPayload(AgentImageInput)
			.addSuccess(AgentMutationResponse),
	)
	.add(
		addMutationErrors(
			HttpApiEndpoint.del("removeProfileImage", "/me/image"),
		).addSuccess(AgentMutationResponse),
	)
	.add(
		addMutationErrors(
			HttpApiEndpoint.post("signOutAllDevices", "/me/sign-out-all"),
		).addSuccess(AgentMutationResponse),
	)
	.add(
		addMutationErrors(
			HttpApiEndpoint.post("openReferralPortal", "/me/referrals"),
		).addSuccess(AgentBrowserActionResponse),
	)
	.add(
		addMutationErrors(
			HttpApiEndpoint.post("createOrganization", "/organizations"),
		)
			.setPayload(AgentOrganizationCreateInput)
			.addSuccess(AgentMutationResponse),
	)
	.add(
		addMutationErrors(
			HttpApiEndpoint.patch(
				"updateOrganization",
				"/organizations/:organizationId",
			),
		)
			.setPath(AgentOrganizationPath)
			.setPayload(AgentOrganizationUpdateInput)
			.addSuccess(AgentMutationResponse),
	)
	.add(
		addMutationErrors(
			HttpApiEndpoint.put(
				"updateOrganizationIcon",
				"/organizations/:organizationId/icon",
			),
		)
			.setPath(AgentOrganizationPath)
			.setPayload(AgentImageInput)
			.addSuccess(AgentMutationResponse),
	)
	.add(
		addMutationErrors(
			HttpApiEndpoint.del(
				"removeOrganizationIcon",
				"/organizations/:organizationId/icon",
			),
		)
			.setPath(AgentOrganizationPath)
			.addSuccess(AgentMutationResponse),
	)
	.add(
		addMutationErrors(
			HttpApiEndpoint.put(
				"updateShareableLinkIcon",
				"/organizations/:organizationId/shareable-link-icon",
			),
		)
			.setPath(AgentOrganizationPath)
			.setPayload(AgentImageInput)
			.addSuccess(AgentMutationResponse),
	)
	.add(
		addMutationErrors(
			HttpApiEndpoint.del(
				"removeShareableLinkIcon",
				"/organizations/:organizationId/shareable-link-icon",
			),
		)
			.setPath(AgentOrganizationPath)
			.addSuccess(AgentMutationResponse),
	)
	.add(
		addMutationErrors(
			HttpApiEndpoint.post(
				"createSubscriptionCheckout",
				"/organizations/:organizationId/billing/checkout",
			),
		)
			.setPath(AgentOrganizationPath)
			.setPayload(AgentSubscriptionCheckoutInput)
			.addSuccess(AgentBrowserActionResponse),
	)
	.add(
		addMutationErrors(
			HttpApiEndpoint.post(
				"createBillingPortal",
				"/organizations/:organizationId/billing/portal",
			),
		)
			.setPath(AgentOrganizationPath)
			.addSuccess(AgentBrowserActionResponse),
	)
	.add(
		addMutationErrors(
			HttpApiEndpoint.put(
				"updateOrganizationS3",
				"/organizations/:organizationId/storage/s3",
			),
		)
			.setPath(AgentOrganizationPath)
			.setPayload(AgentS3ConfigInput)
			.addSuccess(AgentMutationResponse),
	)
	.add(
		addMutationErrors(
			HttpApiEndpoint.post(
				"testOrganizationS3",
				"/organizations/:organizationId/storage/s3/test",
			),
		)
			.setPath(AgentOrganizationPath)
			.setPayload(AgentS3ConfigInput)
			.addSuccess(AgentMutationResponse),
	)
	.add(
		addMutationErrors(
			HttpApiEndpoint.del(
				"removeOrganizationS3",
				"/organizations/:organizationId/storage/s3",
			),
		)
			.setPath(AgentOrganizationPath)
			.addSuccess(AgentMutationResponse),
	)
	.add(
		addMutationErrors(
			HttpApiEndpoint.patch(
				"updateOrganizationStorageProvider",
				"/organizations/:organizationId/storage/provider",
			),
		)
			.setPath(AgentOrganizationPath)
			.setPayload(AgentStorageProviderInput)
			.addSuccess(AgentMutationResponse),
	)
	.add(
		addMutationErrors(
			HttpApiEndpoint.post(
				"connectOrganizationGoogleDrive",
				"/organizations/:organizationId/storage/google-drive/connect",
			),
		)
			.setPath(AgentOrganizationPath)
			.addSuccess(AgentBrowserActionResponse),
	)
	.add(
		addMutationErrors(
			HttpApiEndpoint.del(
				"disconnectOrganizationGoogleDrive",
				"/organizations/:organizationId/storage/google-drive",
			),
		)
			.setPath(AgentOrganizationPath)
			.addSuccess(AgentMutationResponse),
	)
	.add(
		addMutationErrors(
			HttpApiEndpoint.put(
				"setOrganizationGoogleDriveLocation",
				"/organizations/:organizationId/storage/google-drive/location",
			),
		)
			.setPath(AgentOrganizationPath)
			.setPayload(AgentGoogleDriveLocationInput)
			.addSuccess(AgentMutationResponse),
	)
	.add(
		addMutationErrors(
			HttpApiEndpoint.patch(
				"updateOrganizationSettings",
				"/organizations/:organizationId/settings",
			),
		)
			.setPath(AgentOrganizationPath)
			.setPayload(AgentOrganizationSettingsInput)
			.addSuccess(AgentMutationResponse),
	)
	.add(
		addMutationErrors(
			HttpApiEndpoint.post(
				"createOrganizationInvite",
				"/organizations/:organizationId/invites",
			),
		)
			.setPath(AgentOrganizationPath)
			.setPayload(AgentOrganizationInviteInput)
			.addSuccess(AgentOrganizationInviteResponse),
	)
	.add(
		addMutationErrors(
			HttpApiEndpoint.del(
				"deleteOrganizationInvite",
				"/organizations/:organizationId/invites/:inviteId",
			),
		)
			.setPath(AgentOrganizationInvitePath)
			.addSuccess(AgentMutationResponse),
	)
	.add(
		addMutationErrors(
			HttpApiEndpoint.patch(
				"updateOrganizationMemberSeat",
				"/organizations/:organizationId/members/:memberId/seat",
			),
		)
			.setPath(AgentOrganizationMemberPath)
			.setPayload(AgentOrganizationMemberSeatInput)
			.addSuccess(AgentMutationResponse),
	)
	.add(
		addMutationErrors(
			HttpApiEndpoint.patch(
				"updateOrganizationMember",
				"/organizations/:organizationId/members/:memberId",
			),
		)
			.setPath(AgentOrganizationMemberPath)
			.setPayload(AgentOrganizationMemberUpdateInput)
			.addSuccess(AgentMutationResponse),
	)
	.add(
		addMutationErrors(
			HttpApiEndpoint.del(
				"removeOrganizationMember",
				"/organizations/:organizationId/members/:memberId",
			),
		)
			.setPath(AgentOrganizationMemberPath)
			.addSuccess(AgentMutationResponse),
	)
	.add(
		addMutationErrors(
			HttpApiEndpoint.patch(
				"updateNotificationPreferences",
				"/me/notification-preferences",
			),
		)
			.setPayload(AgentNotificationPreferencesInput)
			.addSuccess(AgentNotificationPreferencesResponse),
	)
	.add(
		addMutationErrors(
			HttpApiEndpoint.post("markNotificationsRead", "/me/notifications/read"),
		)
			.setPayload(AgentNotificationsReadInput)
			.addSuccess(AgentMutationResponse),
	)
	.add(
		addMutationErrors(HttpApiEndpoint.post("createUpload", "/uploads"))
			.setPayload(AgentUploadCreateInput)
			.addSuccess(AgentUploadCreateResponse),
	)
	.add(
		addMutationErrors(
			HttpApiEndpoint.post("completeUpload", "/uploads/:id/complete"),
		)
			.setPath(AgentVideoPath)
			.setPayload(AgentUploadCompleteInput)
			.addSuccess(AgentUploadCompleteResponse),
	)
	.add(
		addMutationErrors(
			HttpApiEndpoint.post(
				"importLoomCap",
				"/organizations/:organizationId/imports/loom",
			),
		)
			.setPath(AgentOrganizationPath)
			.setPayload(AgentLoomImportInput)
			.addSuccess(AgentOperationResponse),
	)
	.add(
		addMutationErrors(HttpApiEndpoint.post("processCap", "/caps/:id/process"))
			.setPath(AgentVideoPath)
			.setPayload(AgentProcessInput)
			.addSuccess(AgentProcessResponse),
	)
	.add(
		addMutationErrors(
			HttpApiEndpoint.put("replaceTranscript", "/caps/:id/transcript"),
		)
			.setPath(AgentVideoPath)
			.setPayload(AgentTranscriptUpdateInput)
			.addSuccess(AgentTranscriptUpdateResponse),
	)
	.add(
		addMutationErrors(
			HttpApiEndpoint.put("updateCapPassword", "/caps/:id/password"),
		)
			.setPath(AgentVideoPath)
			.addSuccess(AgentMutationResponse),
	)
	.add(
		addMutationErrors(
			HttpApiEndpoint.post("duplicateCap", "/caps/:id/duplicate"),
		)
			.setPath(AgentVideoPath)
			.addSuccess(AgentOperationResponse),
	)
	.add(
		addMutationErrors(HttpApiEndpoint.del("deleteCap", "/caps/:id"))
			.setPath(AgentVideoPath)
			.addSuccess(AgentOperationResponse),
	)
	.add(
		addMutationErrors(
			HttpApiEndpoint.patch("updateCapSettings", "/caps/:id/settings"),
		)
			.setPath(AgentVideoPath)
			.setPayload(AgentViewerSettingsInput)
			.addSuccess(AgentMutationResponse),
	)
	.add(
		addMutationErrors(HttpApiEndpoint.patch("updateCapDate", "/caps/:id/date"))
			.setPath(AgentVideoPath)
			.setPayload(AgentCapDateInput)
			.addSuccess(AgentMutationResponse),
	)
	.add(
		addMutationErrors(
			HttpApiEndpoint.del("deleteFeedback", "/caps/:id/comments/:commentId"),
		)
			.setPath(AgentReplyPath)
			.addSuccess(AgentMutationResponse),
	)
	.add(
		addMutationErrors(HttpApiEndpoint.patch("moveCap", "/caps/:id/location"))
			.setPath(AgentVideoPath)
			.setPayload(AgentMoveCapInput)
			.addSuccess(AgentMutationResponse),
	)
	.add(
		addMutationErrors(
			HttpApiEndpoint.put(
				"shareCapWithOrganization",
				"/caps/:id/shares/organizations/:organizationId",
			),
		)
			.setPath(AgentOrganizationSharePath)
			.setPayload(AgentShareInput)
			.addSuccess(AgentMutationResponse),
	)
	.add(
		addMutationErrors(
			HttpApiEndpoint.del(
				"removeCapOrganizationShare",
				"/caps/:id/shares/organizations/:organizationId",
			),
		)
			.setPath(AgentOrganizationSharePath)
			.addSuccess(AgentMutationResponse),
	)
	.add(
		addMutationErrors(
			HttpApiEndpoint.put(
				"shareCapWithSpace",
				"/caps/:id/shares/spaces/:spaceId",
			),
		)
			.setPath(AgentSpaceSharePath)
			.setPayload(AgentShareInput)
			.addSuccess(AgentMutationResponse),
	)
	.add(
		addMutationErrors(
			HttpApiEndpoint.del(
				"removeCapSpaceShare",
				"/caps/:id/shares/spaces/:spaceId",
			),
		)
			.setPath(AgentSpaceSharePath)
			.addSuccess(AgentMutationResponse),
	)
	.add(
		addMutationErrors(
			HttpApiEndpoint.post(
				"createFolder",
				"/organizations/:organizationId/folders",
			),
		)
			.setPath(AgentOrganizationPath)
			.setPayload(AgentFolderCreateInput)
			.addSuccess(AgentMutationResponse),
	)
	.add(
		addMutationErrors(
			HttpApiEndpoint.patch("updateFolder", "/folders/:folderId"),
		)
			.setPath(AgentFolderPath)
			.setPayload(AgentFolderUpdateInput)
			.addSuccess(AgentMutationResponse),
	)
	.add(
		addMutationErrors(
			HttpApiEndpoint.patch(
				"updateFolderPublicPage",
				"/folders/:folderId/public-page",
			),
		)
			.setPath(AgentFolderPath)
			.setPayload(AgentCollectionPublicPageInput)
			.addSuccess(AgentMutationResponse),
	)
	.add(
		addMutationErrors(
			HttpApiEndpoint.put("updateFolderLogo", "/folders/:folderId/logo"),
		)
			.setPath(AgentFolderPath)
			.setPayload(AgentImageInput)
			.addSuccess(AgentMutationResponse),
	)
	.add(
		addMutationErrors(
			HttpApiEndpoint.del("removeFolderLogo", "/folders/:folderId/logo"),
		)
			.setPath(AgentFolderPath)
			.addSuccess(AgentMutationResponse),
	)
	.add(
		addMutationErrors(HttpApiEndpoint.del("deleteFolder", "/folders/:folderId"))
			.setPath(AgentFolderPath)
			.addSuccess(AgentMutationResponse),
	)
	.add(
		addMutationErrors(
			HttpApiEndpoint.post(
				"createSpace",
				"/organizations/:organizationId/spaces",
			),
		)
			.setPath(AgentOrganizationPath)
			.setPayload(AgentSpaceCreateInput)
			.addSuccess(AgentMutationResponse),
	)
	.add(
		addMutationErrors(HttpApiEndpoint.patch("updateSpace", "/spaces/:spaceId"))
			.setPath(AgentSpacePath)
			.setPayload(AgentSpaceUpdateInput)
			.addSuccess(AgentMutationResponse),
	)
	.add(
		addMutationErrors(
			HttpApiEndpoint.patch(
				"updateSpacePublicPage",
				"/spaces/:spaceId/public-page",
			),
		)
			.setPath(AgentSpacePath)
			.setPayload(AgentCollectionPublicPageInput)
			.addSuccess(AgentMutationResponse),
	)
	.add(
		addMutationErrors(
			HttpApiEndpoint.put("updateSpaceLogo", "/spaces/:spaceId/logo"),
		)
			.setPath(AgentSpacePath)
			.setPayload(AgentImageInput)
			.addSuccess(AgentMutationResponse),
	)
	.add(
		addMutationErrors(
			HttpApiEndpoint.del("removeSpaceLogo", "/spaces/:spaceId/logo"),
		)
			.setPath(AgentSpacePath)
			.addSuccess(AgentMutationResponse),
	)
	.add(
		addMutationErrors(HttpApiEndpoint.del("deleteSpace", "/spaces/:spaceId"))
			.setPath(AgentSpacePath)
			.addSuccess(AgentMutationResponse),
	)
	.add(
		addMutationErrors(
			HttpApiEndpoint.post("addSpaceMember", "/spaces/:spaceId/members"),
		)
			.setPath(AgentSpacePath)
			.setPayload(AgentSpaceMemberAddInput)
			.addSuccess(AgentMutationResponse),
	)
	.add(
		addMutationErrors(
			HttpApiEndpoint.patch(
				"updateSpaceMember",
				"/spaces/:spaceId/members/:userId",
			),
		)
			.setPath(AgentSpaceMemberPath)
			.setPayload(AgentSpaceMemberUpdateInput)
			.addSuccess(AgentMutationResponse),
	)
	.add(
		addMutationErrors(
			HttpApiEndpoint.del(
				"removeSpaceMember",
				"/spaces/:spaceId/members/:userId",
			),
		)
			.setPath(AgentSpaceMemberPath)
			.addSuccess(AgentMutationResponse),
	) {}

export class AgentAuthHttpApi extends HttpApiGroup.make("agentAuth")
	.add(
		HttpApiEndpoint.post("exchangeToken", "/auth/token")
			.setPayload(AgentTokenRequest)
			.addSuccess(AgentTokenResponse)
			.addError(AgentBadRequestError)
			.addError(AgentAuthenticationError)
			.addError(AgentRateLimitedError)
			.addError(AgentTemporaryUnavailableError),
	)
	.add(
		HttpApiEndpoint.get("getAuthStatus", "/auth/status")
			.addSuccess(AgentAuthStatusResponse)
			.addError(AgentAuthenticationError)
			.addError(AgentTemporaryUnavailableError)
			.middleware(AgentHttpAuthMiddleware),
	)
	.add(
		HttpApiEndpoint.post("revokeToken", "/auth/revoke")
			.addSuccess(AgentRevokeResponse)
			.addError(AgentAuthenticationError)
			.addError(AgentTemporaryUnavailableError)
			.middleware(AgentHttpAuthMiddleware),
	) {}

export class AgentApiContract extends HttpApi.make("cap-agent-api")
	.add(AgentAuthHttpApi)
	.add(AgentHttpApi)
	.add(AgentManagementHttpApi)
	.annotateContext(
		OpenApi.annotations({
			title: "Cap Agent API",
			description:
				"Stable personal-library API used by Cap CLI and MCP clients",
		}),
	)
	.prefix("/api/v1") {}
