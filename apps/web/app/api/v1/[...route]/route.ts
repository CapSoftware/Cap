import { createHash, createHmac } from "node:crypto";
import { HeadBucketCommand, S3Client } from "@aws-sdk/client-s3";
import {
	decrypt,
	encrypt,
	hashPassword,
	verifyPassword,
} from "@cap/database/crypto";
import { sendEmail } from "@cap/database/emails/config";
import { OrganizationInvite } from "@cap/database/emails/organization-invite";
import { nanoId, nanoIdLong } from "@cap/database/helpers";
import * as Db from "@cap/database/schema";
import { buildEnv, serverEnv } from "@cap/env";
import {
	STRIPE_DEVELOPER_CREDITS_PRODUCT_ID,
	STRIPE_PLAN_IDS,
	stripe,
	userIsPro,
} from "@cap/utils";
import {
	AgentManagement,
	collectPasswordHashes,
	Database,
	type GoogleDriveIntegrationConfig,
	getGoogleDriveAccessToken,
	getGoogleDriveAuthUrl,
	getGoogleDriveFolderLocation,
	getGoogleDriveUserEmail,
	ImageUploads,
	resolveEffectiveVideoRules,
	Storage,
	Videos,
} from "@cap/web-backend";
import {
	Agent,
	Comment,
	CurrentUser,
	Folder,
	type ImageUpload,
	Organisation,
	S3Bucket,
	Space,
	Storage as StorageDomain,
	Video,
} from "@cap/web-domain";
import {
	HttpApiBuilder,
	HttpServerRequest,
	HttpServerResponse,
} from "@effect/platform";
import {
	and,
	desc,
	eq,
	gt,
	inArray,
	isNull,
	lt,
	ne,
	or,
	sql,
} from "drizzle-orm";
import { union } from "drizzle-orm/mysql-core";
import { Effect, Layer, Option, Schema } from "effect";
import { revalidatePath } from "next/cache";
import { start } from "workflow/api";
import { downloadLoomVideo } from "@/actions/loom";
import { getOrgAnalyticsData } from "@/app/(org)/dashboard/analytics/data";
import {
	createAgentAccessGrant,
	readAgentAccessGrant,
} from "@/lib/agent-access-grant";
import {
	agentCapabilities,
	agentStatus,
	agentTranscriptRevision,
	decodeAgentCursor,
	encodeAgentCursor,
	escapeAgentLikePattern,
	isAgentHttpUrl,
	normalizeAgentMetadata,
	parseAgentDate,
	parseAgentLimit,
	parseAgentVtt,
	renderAgentVtt,
	transcriptTextFromCues,
} from "@/lib/agent-api";
import {
	agentAction,
	agentViewerSettings,
	decodeNotificationCursor,
	developerCapabilities,
	encodeNotificationCursor,
	integrationCapabilities,
	libraryCapabilities,
	normalizeOrganization,
	organizationCapabilities,
	profileCapabilities,
} from "@/lib/agent-management";
import { agentApiToHandler } from "@/lib/agent-server";
import {
	exchangeAgentAuthorizationCode,
	getAgentAuthStatus,
	revokeAgentAccessToken,
} from "@/lib/agent-token";
import {
	isAgentUploadAllowedForMeasuredDuration,
	isAgentUploadAllowedForPlan,
} from "@/lib/agent-upload-entitlement";
import {
	createAgentFeedback,
	isAgentIdempotencyKey,
	runAgentExternalMutation,
	runAgentMutation,
	updateAgentCap,
} from "@/lib/agent-write";
import { hashKey } from "@/lib/developer-key-hash";
import { startAiGeneration } from "@/lib/generate-ai";
import { probeVideoViaMediaServer } from "@/lib/media-client";
import { provisionOrganizationInvitee } from "@/lib/organization-provisioning";
import {
	canChangeOrganizationMemberRole,
	canRemoveOrganizationMember,
	getEffectiveOrganizationRole,
} from "@/lib/permissions/roles";
import { normalizePlaybackSpeed } from "@/lib/playback-speed";
import { isRateLimited, RATE_LIMIT_IDS } from "@/lib/rate-limit";
import { transcribeVideo } from "@/lib/transcribe";
import { startVideoProcessingWorkflow } from "@/lib/video-processing";
import { isAiGenerationEnabled } from "@/utils/flags";
import {
	calculateProSeats,
	hasActiveDirectSubscription,
	selectProSeatProvider,
} from "@/utils/organization";
import { agentCapOperationWorkflow } from "@/workflows/agent-cap-operation";
import { importLoomVideoWorkflow } from "@/workflows/import-loom-video";

export const dynamic = "force-dynamic";

type CapRow = {
	id: Video.VideoId;
	ownerId: (typeof Db.users.$inferSelect)["id"];
	ownerName: string | null;
	orgId: (typeof Db.organizations.$inferSelect)["id"];
	name: string;
	public: boolean;
	hasPassword: boolean;
	duration: number | null;
	folderId: (typeof Db.folders.$inferSelect)["id"] | null;
	createdAt: Date;
	updatedAt: Date;
	width: number | null;
	height: number | null;
	fps: number | null;
	source: (typeof Db.videos.$inferSelect)["source"];
	metadata: unknown;
	transcriptionStatus: (typeof Db.videos.$inferSelect)["transcriptionStatus"];
	videoSettings: (typeof Db.videos.$inferSelect)["settings"];
	organizationSettings: (typeof Db.organizations.$inferSelect)["settings"];
	commentCount: number;
	reactionCount: number;
	uploadPhase: (typeof Db.videoUploads.$inferSelect)["phase"] | null;
	uploadError: string | null;
};

type SpaceRuleRow = {
	videoId: Video.VideoId;
	id: string;
	name: string;
	settings: (typeof Db.spaces.$inferSelect)["settings"];
	hasPassword: boolean;
};

type TranscriptData = {
	vtt: string;
	text: string;
	cues: (typeof Agent.AgentTranscriptCue)["Type"][];
};

type StatusRow = Pick<
	CapRow,
	| "id"
	| "updatedAt"
	| "transcriptionStatus"
	| "metadata"
	| "uploadPhase"
	| "uploadError"
>;

const makeRequestId = () => crypto.randomUUID();

const deterministicAgentId = (namespace: string, ...parts: string[]) =>
	createHash("sha256")
		.update([namespace, ...parts].join("\0"), "utf8")
		.digest("base64url")
		.slice(0, 15);

const affectedRows = (result: unknown) =>
	Array.isArray(result)
		? ((result[0] as { affectedRows?: number } | undefined)?.affectedRows ?? 0)
		: ((result as { affectedRows?: number }).affectedRows ?? 0);

const defaultProOrganizationSettings = {
	disableSummary: false,
	disableChapters: false,
	disableTranscript: false,
	hideShareableLinkCapLogo: false,
	shareableLinkUseOrganizationIcon: false,
	aiGenerationLanguage: "auto" as const,
};

const DeveloperKeyOperationResult = Schema.Struct({
	appId: Schema.String,
	publicKeyId: Schema.String,
	secretKeyId: Schema.String,
});

const readDeveloperCredentials = Effect.fn("Agent.readDeveloperCredentials")(
	function* (
		principal: Agent.AgentPrincipal["Type"],
		result: (typeof DeveloperKeyOperationResult)["Type"],
		requestId: string,
	) {
		const database = yield* Database;
		const rows = yield* database.use((db) =>
			db
				.select({
					id: Db.developerApiKeys.id,
					encryptedKey: Db.developerApiKeys.encryptedKey,
				})
				.from(Db.developerApiKeys)
				.innerJoin(
					Db.developerApps,
					eq(Db.developerApiKeys.appId, Db.developerApps.id),
				)
				.where(
					and(
						eq(Db.developerApps.id, result.appId),
						eq(Db.developerApps.ownerId, principal.id),
						isNull(Db.developerApps.deletedAt),
						inArray(Db.developerApiKeys.id, [
							result.publicKeyId,
							result.secretKeyId,
						]),
					),
				),
		);
		const publicKey = rows.find((row) => row.id === result.publicKeyId);
		const secretKey = rows.find((row) => row.id === result.secretKeyId);
		if (!publicKey || !secretKey) {
			return yield* temporarilyUnavailable(
				requestId,
				"Developer credentials are temporarily unavailable",
			);
		}
		const [publicKeyRaw, secretKeyRaw] = yield* Effect.tryPromise(() =>
			Promise.all([
				decrypt(publicKey.encryptedKey),
				decrypt(secretKey.encryptedKey),
			]),
		).pipe(
			Effect.mapError(() =>
				temporarilyUnavailable(
					requestId,
					"Developer credentials are temporarily unavailable",
				),
			),
		);
		return {
			appId: result.appId,
			publicKey: publicKeyRaw,
			secretKey: secretKeyRaw,
			requestId,
		};
	},
);

const commonError = (requestId: string, message: string) => ({
	message,
	retryable: false,
	retryAfterMs: null,
	requestId,
});

const AGENT_UPLOAD_PLAN_LIMIT_MESSAGE =
	"Free plan uploads require a recording duration of 5 minutes or less. Upgrade to Cap Pro to upload longer recordings.";
const AGENT_UPLOAD_PENDING_FILE_NAME = "agent-upload.mp4";
const AGENT_UPLOAD_REJECTION_ERROR = "AGENT_UPLOAD_DURATION_LIMIT_EXCEEDED";

const agentUploadPendingRawFileKey = (
	ownerId: string,
	videoId: Video.VideoId,
) => `${ownerId}/${videoId}/${AGENT_UPLOAD_PENDING_FILE_NAME}`;

const agentUploadVerifiedRawFileKey = (
	ownerId: string,
	videoId: Video.VideoId,
	verificationId: string,
) =>
	`${ownerId}/${videoId}/verified-upload-${deterministicAgentId(
		"agent-upload-completion",
		ownerId,
		videoId,
		verificationId,
	)}.mp4`;

const badRequest = (requestId: string, message: string) =>
	new Agent.AgentBadRequestError({
		...commonError(requestId, message),
		code: "INVALID_REQUEST",
	});

const forbidden = (requestId: string, message = "Access is not allowed") =>
	new Agent.AgentForbiddenError({
		...commonError(requestId, message),
		code: "FORBIDDEN",
	});

const passwordRequired = (requestId: string) =>
	new Agent.AgentForbiddenError({
		...commonError(
			requestId,
			"This Cap must be unlocked before it can be read",
		),
		code: "PASSWORD_REQUIRED",
	});

const contentDisabled = (requestId: string, content: string) =>
	new Agent.AgentForbiddenError({
		...commonError(requestId, `${content} is disabled for this Cap`),
		code: "CONTENT_DISABLED",
	});

const notFound = (requestId: string) =>
	new Agent.AgentNotFoundError({
		...commonError(requestId, "Cap not found"),
		code: "NOT_FOUND",
	});

const notReady = (requestId: string, message: string) =>
	new Agent.AgentNotReadyError({
		message,
		code: "NOT_READY",
		retryable: true,
		retryAfterMs: 2_000,
		requestId,
	});

const temporarilyUnavailable = (requestId: string, message: string) =>
	new Agent.AgentTemporaryUnavailableError({
		message,
		code: "TEMPORARY_UNAVAILABLE",
		retryable: true,
		retryAfterMs: null,
		requestId,
	});

const rateLimited = (requestId: string) =>
	new Agent.AgentRateLimitedError({
		message: "Too many requests. Try again later",
		code: "RATE_LIMITED",
		retryable: true,
		retryAfterMs: 60_000,
		requestId,
	});

const approvalRequired = (requestId: string, message: string) =>
	new Agent.AgentApprovalRequiredError({
		...commonError(requestId, message),
		code: "APPROVAL_REQUIRED",
		approvalUrl: null,
	});

const withMappedErrors = <A, E, R>(
	effect: Effect.Effect<A, E, R>,
	requestId: string,
) =>
	effect.pipe(
		Effect.catchTags({
			DatabaseError: () =>
				Effect.fail(
					temporarilyUnavailable(requestId, "The Cap library is unavailable"),
				),
			NoSuchElementException: () => Effect.fail(notFound(requestId)),
			PolicyDenied: () => Effect.fail(forbidden(requestId)),
			S3Error: () =>
				Effect.fail(
					temporarilyUnavailable(requestId, "Cap storage is unavailable"),
				),
			StorageError: () =>
				Effect.fail(
					temporarilyUnavailable(requestId, "Cap storage is unavailable"),
				),
			UnknownException: () =>
				Effect.fail(
					temporarilyUnavailable(
						requestId,
						"The request could not be completed",
					),
				),
			VerifyVideoPasswordError: () => Effect.fail(passwordRequired(requestId)),
			VideoNotFoundError: () => Effect.fail(notFound(requestId)),
		}),
		Effect.tapErrorCause(Effect.logError),
	);

const toCurrentUser = (
	principal: Agent.AgentPrincipal["Type"],
): CurrentUser["Type"] => ({
	id: principal.id,
	email: principal.email,
	activeOrganizationId: principal.activeOrganizationId,
	iconUrlOrKey: Option.none(),
});

const hasScope = (
	principal: Agent.AgentPrincipal["Type"],
	scope: Agent.AgentScope,
) => principal.scopes.has(scope);

const requireScope = (
	principal: Agent.AgentPrincipal["Type"],
	scope: Agent.AgentScope,
	requestId: string,
) =>
	principal.scopes.has(scope)
		? Effect.void
		: Effect.fail(forbidden(requestId, `The ${scope} permission is required`));

const pickViewerSettings = (
	settings:
		| (typeof Db.videos.$inferSelect)["settings"]
		| (typeof Db.organizations.$inferSelect)["settings"]
		| (typeof Db.spaces.$inferSelect)["settings"],
) => ({
	disableSummary: settings?.disableSummary,
	disableCaptions: settings?.disableCaptions,
	disableChapters: settings?.disableChapters,
	disableReactions: settings?.disableReactions,
	disableTranscript: settings?.disableTranscript,
	disableComments: settings?.disableComments,
});

const getMetadataChapterValues = (metadata: unknown) => {
	const value = normalizeAgentMetadata(metadata).chapters;
	if (!Array.isArray(value)) return [];
	return value.flatMap((chapter) => {
		if (!chapter || typeof chapter !== "object" || Array.isArray(chapter)) {
			return [];
		}
		const { title, start } = chapter as Record<string, unknown>;
		return typeof title === "string" &&
			typeof start === "number" &&
			Number.isFinite(start)
			? [{ title, startMs: Math.round(start * 1000) }]
			: [];
	});
};

const getMetadataString = (metadata: unknown, key: "aiTitle" | "summary") => {
	const value = normalizeAgentMetadata(metadata)[key];
	return typeof value === "string" && value.length > 0 ? value : null;
};

const getStatus = (row: StatusRow) => {
	const metadata = normalizeAgentMetadata(row.metadata);
	return agentStatus({
		id: row.id,
		updatedAt: row.updatedAt,
		transcriptionStatus: row.transcriptionStatus,
		aiGenerationStatus: metadata.aiGenerationStatus,
		uploadPhase: row.uploadPhase,
		uploadError: row.uploadError,
	});
};

const getCapRows = Effect.fn("Agent.getCapRows")(function* (
	videoId?: Video.VideoId,
) {
	const database = yield* Database;
	return yield* database.use((db) => {
		const query = db
			.select({
				id: Db.videos.id,
				ownerId: Db.videos.ownerId,
				ownerName: Db.users.name,
				orgId: Db.videos.orgId,
				name: Db.videos.name,
				public: Db.videos.public,
				hasPassword: sql<boolean>`${Db.videos.password} IS NOT NULL`.mapWith(
					Boolean,
				),
				duration: Db.videos.duration,
				folderId: Db.videos.folderId,
				createdAt: Db.videos.createdAt,
				updatedAt: Db.videos.updatedAt,
				width: Db.videos.width,
				height: Db.videos.height,
				fps: Db.videos.fps,
				source: Db.videos.source,
				metadata: Db.videos.metadata,
				transcriptionStatus: Db.videos.transcriptionStatus,
				videoSettings: Db.videos.settings,
				organizationSettings: Db.organizations.settings,
				commentCount: sql<number>`(
					SELECT COUNT(*) FROM ${Db.comments}
					WHERE ${Db.comments.videoId} = ${Db.videos.id}
						AND ${Db.comments.type} = 'text'
				)`.mapWith(Number),
				reactionCount: sql<number>`(
					SELECT COUNT(*) FROM ${Db.comments}
					WHERE ${Db.comments.videoId} = ${Db.videos.id}
						AND ${Db.comments.type} = 'emoji'
				)`.mapWith(Number),
				uploadPhase: Db.videoUploads.phase,
				uploadError: Db.videoUploads.processingError,
			})
			.from(Db.videos)
			.innerJoin(Db.organizations, eq(Db.videos.orgId, Db.organizations.id))
			.leftJoin(Db.users, eq(Db.videos.ownerId, Db.users.id))
			.leftJoin(Db.videoUploads, eq(Db.videos.id, Db.videoUploads.videoId));

		return videoId ? query.where(eq(Db.videos.id, videoId)).limit(1) : query;
	});
});

const getStatusRow = Effect.fn("Agent.getStatusRow")(function* (
	videoId: Video.VideoId,
) {
	const database = yield* Database;
	const [row] = yield* database.use((db) =>
		db
			.select({
				id: Db.videos.id,
				updatedAt: Db.videos.updatedAt,
				transcriptionStatus: Db.videos.transcriptionStatus,
				metadata: Db.videos.metadata,
				uploadPhase: Db.videoUploads.phase,
				uploadError: Db.videoUploads.processingError,
			})
			.from(Db.videos)
			.leftJoin(Db.videoUploads, eq(Db.videos.id, Db.videoUploads.videoId))
			.where(eq(Db.videos.id, videoId))
			.limit(1),
	);
	if (!row) return yield* Effect.fail(new Video.NotFoundError());
	return row;
});

const getSpaceRules = Effect.fn("Agent.getSpaceRules")(function* (
	videoIds: ReadonlyArray<Video.VideoId>,
) {
	if (videoIds.length === 0) return [] as SpaceRuleRow[];
	const database = yield* Database;
	return yield* database.use((db) =>
		db
			.select({
				videoId: Db.spaceVideos.videoId,
				id: Db.spaces.id,
				name: Db.spaces.name,
				settings: Db.spaces.settings,
				hasPassword: sql<boolean>`${Db.spaces.password} IS NOT NULL`.mapWith(
					Boolean,
				),
			})
			.from(Db.spaceVideos)
			.innerJoin(Db.spaces, eq(Db.spaceVideos.spaceId, Db.spaces.id))
			.where(inArray(Db.spaceVideos.videoId, videoIds)),
	);
});

const rulesForRow = (row: CapRow, spaceRows: ReadonlyArray<SpaceRuleRow>) =>
	resolveEffectiveVideoRules({
		videoSettings: pickViewerSettings(row.videoSettings),
		organizationSettings: pickViewerSettings(row.organizationSettings),
		spaces: spaceRows
			.filter((space) => space.videoId === row.id)
			.map((space) => ({
				id: space.id,
				name: space.name,
				settings: pickViewerSettings(space.settings),
				hasPassword: space.hasPassword,
			})),
	});

const toCapSummary = (
	row: CapRow,
	rules: ReturnType<typeof rulesForRow>,
	principal: Agent.AgentPrincipal["Type"],
	locked: boolean,
): (typeof Agent.AgentCapSummary)["Type"] => {
	const metadata = normalizeAgentMetadata(row.metadata);
	const isOwner = row.ownerId === principal.id;
	return {
		id: row.id,
		shareUrl: `${serverEnv().WEB_URL}/s/${row.id}`,
		title: row.name,
		aiTitle: getMetadataString(metadata, "aiTitle"),
		createdAt: row.createdAt.toISOString(),
		updatedAt: row.updatedAt.toISOString(),
		durationMs: row.duration === null ? null : Math.round(row.duration * 1000),
		owner: { id: row.ownerId, name: row.ownerName },
		organizationId: row.orgId,
		folderId: row.folderId,
		access: isOwner ? "owned" : "shared",
		sharing: {
			public: row.public,
			protected: row.hasPassword || rules.hasInheritedPassword,
		},
		counts: {
			comments: Number(row.commentCount),
			reactions: Number(row.reactionCount),
		},
		status: getStatus(row),
		capabilities: agentCapabilities({
			isOwner,
			hasReadScope: hasScope(principal, "caps:read"),
			hasCommentScope: hasScope(principal, "caps:comment"),
			hasWriteScope: hasScope(principal, "caps:write"),
			hasProcessScope: hasScope(principal, "caps:process"),
			hasDeleteScope: hasScope(principal, "caps:delete"),
			passwordRequired: locked,
			transcriptStatus: row.transcriptionStatus,
			hasSummary:
				typeof metadata.summary === "string" && metadata.summary.length > 0,
			hasChapters:
				Array.isArray(metadata.chapters) && metadata.chapters.length > 0,
			settings: rules.settings,
		}),
	};
};

const getViewableVideo = Effect.fn("Agent.getViewableVideo")(function* (
	videoId: Video.VideoId,
	verifiedPasswordHashes?: ReadonlyArray<string>,
) {
	const principal = yield* Agent.AgentPrincipal;
	const request = yield* HttpServerRequest.HttpServerRequest;
	const grant =
		verifiedPasswordHashes === undefined
			? yield* Effect.promise(() =>
					readAgentAccessGrant(
						request.headers["x-cap-access-grant"],
						videoId,
						principal.id,
					),
				)
			: null;
	const passwords =
		verifiedPasswordHashes ?? (grant ? [grant.passwordHash] : []);
	const videos = yield* Videos;
	const maybeVideo = yield* videos
		.getByIdForViewing(videoId)
		.pipe(
			Effect.provideService(CurrentUser, toCurrentUser(principal)),
			Effect.provideService(Video.VideoPasswordAttachment, { passwords }),
		);
	if (Option.isNone(maybeVideo))
		return yield* Effect.fail(new Video.NotFoundError());
	return maybeVideo.value[0];
});

const getViewableCap = Effect.fn("Agent.getViewableCap")(function* (
	videoId: Video.VideoId,
	verifiedPasswordHashes?: ReadonlyArray<string>,
) {
	const principal = yield* Agent.AgentPrincipal;
	const video = yield* getViewableVideo(videoId, verifiedPasswordHashes);
	const [row] = yield* getCapRows(videoId);
	if (!row) return yield* Effect.fail(new Video.NotFoundError());
	const spaces = yield* getSpaceRules([videoId]);
	const rules = rulesForRow(row, spaces);
	return {
		video,
		row,
		rules,
		cap: toCapSummary(row, rules, principal, false),
	};
});

const listCaps = Effect.fn("Agent.listCaps")(function* (
	params: (typeof Agent.AgentCapsListParams)["Type"],
	requestId: string,
) {
	const principal = yield* Agent.AgentPrincipal;
	const database = yield* Database;
	const limit = parseAgentLimit(params.limit);
	if (limit === null)
		return yield* badRequest(requestId, "limit must be positive");
	const cursor = decodeAgentCursor(params.cursor);
	if (cursor === undefined)
		return yield* badRequest(requestId, "cursor is invalid");
	const updatedAfter = parseAgentDate(params.updatedAfter);
	if (updatedAfter === undefined) {
		return yield* badRequest(requestId, "updatedAfter is invalid");
	}
	const search = params.search?.trim();
	if (search && search.length > 200) {
		return yield* badRequest(requestId, "search is too long");
	}

	const rows = yield* database.use((db) => {
		const organizationId = params.organizationId
			? Organisation.OrganisationId.make(params.organizationId)
			: null;
		const folderId = params.folderId
			? Folder.FolderId.make(params.folderId)
			: null;
		const ownedCaps = db
			.select({ videoId: Db.videos.id })
			.from(Db.videos)
			.where(
				and(
					eq(Db.videos.ownerId, principal.id),
					organizationId ? eq(Db.videos.orgId, organizationId) : undefined,
					folderId ? eq(Db.videos.folderId, folderId) : undefined,
				),
			);
		const organizationCaps = db
			.select({ videoId: Db.sharedVideos.videoId })
			.from(Db.organizationMembers)
			.innerJoin(
				Db.sharedVideos,
				eq(
					Db.organizationMembers.organizationId,
					Db.sharedVideos.organizationId,
				),
			)
			.where(
				and(
					eq(Db.organizationMembers.userId, principal.id),
					organizationId
						? eq(Db.sharedVideos.organizationId, organizationId)
						: undefined,
					folderId ? eq(Db.sharedVideos.folderId, folderId) : undefined,
				),
			);
		const spaceCaps = db
			.select({ videoId: Db.spaceVideos.videoId })
			.from(Db.spaceMembers)
			.innerJoin(
				Db.spaceVideos,
				eq(Db.spaceMembers.spaceId, Db.spaceVideos.spaceId),
			)
			.innerJoin(Db.spaces, eq(Db.spaceMembers.spaceId, Db.spaces.id))
			.where(
				and(
					eq(Db.spaceMembers.userId, principal.id),
					organizationId
						? eq(Db.spaces.organizationId, organizationId)
						: undefined,
					folderId ? eq(Db.spaceVideos.folderId, folderId) : undefined,
				),
			);
		const accessibleCaps =
			params.scope === "owned"
				? ownedCaps.as("accessible_caps")
				: params.scope === "shared"
					? union(organizationCaps, spaceCaps).as("accessible_caps")
					: union(ownedCaps, organizationCaps, spaceCaps).as("accessible_caps");
		const cursorFilter = cursor
			? or(
					lt(Db.videos.updatedAt, new Date(cursor.updatedAt)),
					and(
						eq(Db.videos.updatedAt, new Date(cursor.updatedAt)),
						lt(Db.videos.id, Video.VideoId.make(cursor.id)),
					),
				)
			: undefined;
		const filters = [
			params.scope === "shared"
				? ne(Db.videos.ownerId, principal.id)
				: undefined,
			isNull(Db.organizations.tombstoneAt),
			search
				? sql`${Db.videos.name} LIKE ${`%${escapeAgentLikePattern(search)}%`} ESCAPE '!'`
				: undefined,
			updatedAfter ? gt(Db.videos.updatedAt, updatedAfter) : undefined,
			cursorFilter,
		];

		return db
			.select({
				id: Db.videos.id,
				ownerId: Db.videos.ownerId,
				ownerName: Db.users.name,
				orgId: Db.videos.orgId,
				name: Db.videos.name,
				public: Db.videos.public,
				hasPassword: sql<boolean>`${Db.videos.password} IS NOT NULL`.mapWith(
					Boolean,
				),
				duration: Db.videos.duration,
				folderId: Db.videos.folderId,
				createdAt: Db.videos.createdAt,
				updatedAt: Db.videos.updatedAt,
				width: Db.videos.width,
				height: Db.videos.height,
				fps: Db.videos.fps,
				source: Db.videos.source,
				metadata: Db.videos.metadata,
				transcriptionStatus: Db.videos.transcriptionStatus,
				videoSettings: Db.videos.settings,
				organizationSettings: Db.organizations.settings,
				commentCount: sql<number>`(
					SELECT COUNT(*) FROM ${Db.comments}
					WHERE ${Db.comments.videoId} = ${Db.videos.id}
						AND ${Db.comments.type} = 'text'
				)`.mapWith(Number),
				reactionCount: sql<number>`(
					SELECT COUNT(*) FROM ${Db.comments}
					WHERE ${Db.comments.videoId} = ${Db.videos.id}
						AND ${Db.comments.type} = 'emoji'
				)`.mapWith(Number),
				uploadPhase: Db.videoUploads.phase,
				uploadError: Db.videoUploads.processingError,
			})
			.from(Db.videos)
			.innerJoin(accessibleCaps, eq(Db.videos.id, accessibleCaps.videoId))
			.innerJoin(Db.organizations, eq(Db.videos.orgId, Db.organizations.id))
			.leftJoin(Db.users, eq(Db.videos.ownerId, Db.users.id))
			.leftJoin(Db.videoUploads, eq(Db.videos.id, Db.videoUploads.videoId))
			.where(and(...filters))
			.orderBy(desc(Db.videos.updatedAt), desc(Db.videos.id))
			.limit(limit + 1);
	});

	const pageRows = rows.slice(0, limit);
	const spaces = yield* getSpaceRules(pageRows.map((row) => row.id));
	const caps = pageRows.map((row) => {
		const rules = rulesForRow(row, spaces);
		const isOwner = row.ownerId === principal.id;
		return toCapSummary(
			row,
			rules,
			principal,
			!isOwner && (row.hasPassword || rules.hasInheritedPassword),
		);
	});
	const last = pageRows.at(-1);
	return {
		caps,
		nextCursor:
			rows.length > limit && last
				? encodeAgentCursor({
						updatedAt: last.updatedAt.toISOString(),
						id: last.id,
					})
				: null,
		requestId,
	};
});

const readTranscript = Effect.fn("Agent.readTranscript")(function* (
	video: Video.Video,
	requestId: string,
) {
	const storage = yield* Storage;
	const [bucket] = yield* storage.getAccessForVideo(video);
	const object = yield* bucket.getObject(
		`${video.ownerId}/${video.id}/transcription.vtt`,
	);
	if (Option.isNone(object)) {
		return yield* notReady(
			requestId,
			"Transcript content is not available yet",
		);
	}
	const cues = parseAgentVtt(object.value);
	return {
		vtt: object.value,
		cues,
		text: transcriptTextFromCues(cues),
		revision: agentTranscriptRevision(object.value),
	};
});

const getFeedback = Effect.fn("Agent.getFeedback")(function* (
	videoId: Video.VideoId,
) {
	const database = yield* Database;
	return yield* database.use((db) =>
		db
			.select({
				id: Db.comments.id,
				videoId: Db.comments.videoId,
				type: Db.comments.type,
				content: Db.comments.content,
				timestamp: Db.comments.timestamp,
				parentCommentId: Db.comments.parentCommentId,
				createdAt: Db.comments.createdAt,
				updatedAt: Db.comments.updatedAt,
				authorId: Db.comments.authorId,
				authorName: Db.users.name,
			})
			.from(Db.comments)
			.leftJoin(Db.users, eq(Db.comments.authorId, Db.users.id))
			.where(eq(Db.comments.videoId, videoId))
			.orderBy(Db.comments.createdAt, Db.comments.id),
	);
});

const getContext = Effect.fn("Agent.getContext")(function* (
	videoId: Video.VideoId,
	requestId: string,
) {
	const { video, row, rules, cap } = yield* getViewableCap(videoId);
	const videos = yield* Videos;
	const principal = yield* Agent.AgentPrincipal;
	const metadata = normalizeAgentMetadata(row.metadata);
	const summary = getMetadataString(metadata, "summary");
	const chapters = getMetadataChapterValues(metadata);
	const canReadTranscript = cap.capabilities.transcript.allowed;
	const canReadComments = cap.capabilities.comments.allowed;
	const canReadReactions = cap.capabilities.reactions.allowed;

	const [transcript, feedback, views] = yield* Effect.all(
		[
			canReadTranscript
				? readTranscript(video, requestId).pipe(
						Effect.map(Option.some),
						Effect.catchTag("AgentNotReadyError", () =>
							Effect.succeed(Option.none<TranscriptData>()),
						),
					)
				: Effect.succeed(Option.none<TranscriptData>()),
			canReadComments || canReadReactions
				? getFeedback(videoId)
				: Effect.succeed([]),
			videos.getAnalytics(videoId).pipe(
				Effect.provideService(CurrentUser, toCurrentUser(principal)),
				Effect.map((result) => ({
					status: "available" as const,
					aggregate: result.count,
					reason: null,
				})),
				Effect.catchAll(() =>
					Effect.succeed({
						status: "unavailable" as const,
						aggregate: null,
						reason: "ANALYTICS_UNAVAILABLE",
					}),
				),
			),
		],
		{ concurrency: 3 },
	);

	const comments = feedback
		.filter((item) => item.type === "text")
		.map((item) => ({
			id: Comment.CommentId.make(item.id),
			videoId: item.videoId,
			content: item.content,
			timestampMs:
				item.timestamp === null ? null : Math.round(item.timestamp * 1000),
			parentCommentId: item.parentCommentId,
			createdAt: item.createdAt.toISOString(),
			updatedAt: item.updatedAt.toISOString(),
			author: { id: item.authorId, name: item.authorName },
		}));
	const reactions = feedback
		.filter((item) => item.type === "emoji")
		.map((item) => ({
			id: Comment.CommentId.make(item.id),
			videoId: item.videoId,
			content: item.content,
			timestampMs:
				item.timestamp === null ? null : Math.round(item.timestamp * 1000),
			createdAt: item.createdAt.toISOString(),
			author: { id: item.authorId, name: item.authorName },
		}));

	return {
		cap,
		title: {
			current: row.name,
			ai: getMetadataString(metadata, "aiTitle"),
			manuallyEdited: metadata.titleManuallyEdited === true,
		},
		summary: rules.settings.disableSummary
			? {
					status: "unavailable" as const,
					reason: "CONTENT_DISABLED",
					value: null,
				}
			: summary
				? { status: "available" as const, reason: null, value: summary }
				: { status: "not_ready" as const, reason: "NOT_READY", value: null },
		chapters: rules.settings.disableChapters
			? {
					status: "unavailable" as const,
					reason: "CONTENT_DISABLED",
					value: null,
				}
			: chapters.length > 0
				? { status: "available" as const, reason: null, value: chapters }
				: { status: "not_ready" as const, reason: "NOT_READY", value: null },
		transcript: rules.settings.disableTranscript
			? {
					status: "unavailable" as const,
					reason: "CONTENT_DISABLED",
					text: null,
					cues: null,
				}
			: Option.isSome(transcript)
				? {
						status: "available" as const,
						reason: null,
						text: transcript.value.text,
						cues: transcript.value.cues,
					}
				: {
						status: "not_ready" as const,
						reason: "NOT_READY",
						text: null,
						cues: null,
					},
		comments: canReadComments
			? { status: "available" as const, reason: null, value: comments }
			: {
					status: "unavailable" as const,
					reason: "CONTENT_DISABLED",
					value: null,
				},
		reactions: canReadReactions
			? { status: "available" as const, reason: null, value: reactions }
			: {
					status: "unavailable" as const,
					reason: "CONTENT_DISABLED",
					value: null,
				},
		views,
		metadata: {
			source: row.source.type,
			width: row.width,
			height: row.height,
			fps: row.fps,
		},
		requestId,
	};
});

const unlockCap = Effect.fn("Agent.unlockCap")(function* (
	videoId: Video.VideoId,
	requestId: string,
) {
	const principal = yield* Agent.AgentPrincipal;
	const request = yield* HttpServerRequest.HttpServerRequest;
	const contentType = request.headers["content-type"]?.toLowerCase() ?? "";
	if (!contentType.startsWith("text/plain")) {
		return yield* badRequest(requestId, "Password input must be text/plain");
	}
	const contentLength = Number(request.headers["content-length"] ?? "0");
	if (Number.isFinite(contentLength) && contentLength > 1_024) {
		return yield* badRequest(requestId, "Password input is too large");
	}
	const password = yield* request.text.pipe(
		HttpServerRequest.withMaxBodySize(Option.some(1_024)),
		Effect.catchTag("RequestError", () =>
			Effect.fail(badRequest(requestId, "Password input is invalid")),
		),
	);
	if (password.length === 0 || Buffer.byteLength(password, "utf8") > 512) {
		return yield* badRequest(requestId, "Password input is invalid");
	}

	const headers = new Headers();
	for (const [name, value] of Object.entries(request.headers)) {
		headers.set(name, value);
	}
	if (
		yield* Effect.promise(() =>
			isRateLimited(RATE_LIMIT_IDS.AGENT_UNLOCK, {
				key: `agent-unlock:${principal.id}`,
				headers,
			}),
		)
	) {
		return yield* rateLimited(requestId);
	}
	const requiresPassword = yield* getViewableVideo(videoId).pipe(
		Effect.as(false),
		Effect.catchTag("VerifyVideoPasswordError", () => Effect.succeed(true)),
	);
	if (!requiresPassword) {
		return yield* badRequest(requestId, "This Cap does not require a password");
	}

	const database = yield* Database;
	const [videoRows, spacePasswords] = yield* database.use((db) =>
		Promise.all([
			db
				.select({ password: Db.videos.password })
				.from(Db.videos)
				.where(eq(Db.videos.id, videoId))
				.limit(1),
			db
				.select({ password: Db.spaces.password })
				.from(Db.spaceVideos)
				.innerJoin(Db.spaces, eq(Db.spaceVideos.spaceId, Db.spaces.id))
				.where(eq(Db.spaceVideos.videoId, videoId)),
		]),
	);
	const [videoRow] = videoRows;
	if (!videoRow) return yield* notFound(requestId);
	const passwordHashes = collectPasswordHashes({
		videoPassword: videoRow.password,
		spacePasswords,
	});
	if (passwordHashes.length === 0) return yield* notFound(requestId);
	const verifiedHash = yield* Effect.tryPromise(async () => {
		for (const passwordHash of passwordHashes) {
			if (await verifyPassword(passwordHash, password)) return passwordHash;
		}
		return null;
	});
	if (!verifiedHash) return yield* passwordRequired(requestId);
	yield* getViewableCap(videoId, [verifiedHash]);
	const { grant, expiresAt } = yield* Effect.promise(() =>
		createAgentAccessGrant(videoId, principal.id, verifiedHash),
	);
	return {
		accessGrant: grant,
		expiresAt: expiresAt.toISOString(),
		requestId,
	};
});

const requireAgentWrites = (_requestId: string) => Effect.void;

const capabilityFailure = (
	requestId: string,
	capability: (typeof Agent.AgentCapability)["Type"],
) => {
	switch (capability.reason) {
		case "CONTENT_DISABLED":
			return contentDisabled(requestId, "This action");
		case "PASSWORD_REQUIRED":
			return passwordRequired(requestId);
		default:
			return forbidden(requestId);
	}
};

const requestIdempotencyKey = Effect.gen(function* () {
	const request = yield* HttpServerRequest.HttpServerRequest;
	return request.headers["idempotency-key"] ?? "";
});

const decodeMutationResponse = Schema.decodeUnknownSync(
	Agent.AgentMutationResponse,
);

const decodeBrowserActionResponse = Schema.decodeUnknownSync(
	Agent.AgentBrowserActionResponse,
);

const mutationResponse = (
	type: string,
	id: string,
	action: string,
	requestId: string,
	revision: Date | null = null,
): (typeof Agent.AgentMutationResponse)["Type"] => ({
	resource: {
		type,
		id,
		revision: revision?.toISOString() ?? null,
	},
	action,
	requestId,
});

const decodeAgentImage = (
	payload: (typeof Agent.AgentImageInput)["Type"],
	maximumBytes = 1024 * 1024,
) => {
	const contentType = payload.contentType.trim().toLowerCase();
	if (!new Set(["image/jpeg", "image/png"]).has(contentType)) return null;
	if (
		payload.fileName.length === 0 ||
		payload.fileName.length > 255 ||
		payload.data.length === 0 ||
		payload.data.length > Math.ceil((maximumBytes * 4) / 3) + 4
	) {
		return null;
	}
	const data = Buffer.from(payload.data, "base64");
	if (
		data.length === 0 ||
		data.length > maximumBytes ||
		data.toString("base64").replace(/=+$/, "") !==
			payload.data.replace(/=+$/, "")
	) {
		return null;
	}
	return {
		contentType,
		fileName: payload.fileName,
		data: new Uint8Array(data),
	};
};

const ensureAgentStripeCustomer = Effect.fn("Agent.ensureStripeCustomer")(
	function* (
		principal: Agent.AgentPrincipal["Type"],
		providerIdempotencyKey: string,
		requestId: string,
	) {
		const database = yield* Database;
		const [account] = yield* database.use((db) =>
			db
				.select({
					stripeCustomerId: Db.users.stripeCustomerId,
				})
				.from(Db.users)
				.where(eq(Db.users.id, principal.id))
				.limit(1),
		);
		if (!account) return yield* notFound(requestId);
		if (account.stripeCustomerId) return account.stripeCustomerId;
		const customer = yield* Effect.tryPromise(async () => {
			const existing = await stripe().customers.list({
				email: principal.email,
				limit: 1,
			});
			const first = existing.data[0];
			if (first) {
				return stripe().customers.update(
					first.id,
					{
						metadata: { ...first.metadata, userId: principal.id },
					},
					{ idempotencyKey: `${providerIdempotencyKey}:customer-update` },
				);
			}
			return stripe().customers.create(
				{
					email: principal.email,
					metadata: { userId: principal.id },
				},
				{ idempotencyKey: `${providerIdempotencyKey}:customer-create` },
			);
		});
		yield* database.use((db) =>
			db
				.update(Db.users)
				.set({ stripeCustomerId: customer.id })
				.where(eq(Db.users.id, principal.id)),
		);
		return customer.id;
	},
);

const googleDriveProvider = "googleDrive";

const createAgentGoogleDriveState = (
	userId: string,
	organizationId: Organisation.OrganisationId,
) => {
	const payload = Buffer.from(
		JSON.stringify({
			userId,
			expiresAt: Date.now() + 10 * 60 * 1000,
			scope: "organization",
			organizationId,
			agent: true,
		}),
	).toString("base64url");
	const signature = createHmac("sha256", serverEnv().NEXTAUTH_SECRET)
		.update(payload)
		.digest("base64url");
	return `${payload}.${signature}`;
};

const getAgentOrganizationDrive = Effect.fn("Agent.getOrganizationDrive")(
	function* (organizationId: Organisation.OrganisationId) {
		const database = yield* Database;
		const [drive] = yield* database.use((db) =>
			db
				.select()
				.from(Db.storageIntegrations)
				.where(
					and(
						eq(Db.storageIntegrations.organizationId, organizationId),
						eq(Db.storageIntegrations.provider, googleDriveProvider),
					),
				)
				.orderBy(
					desc(Db.storageIntegrations.active),
					desc(Db.storageIntegrations.updatedAt),
				)
				.limit(1),
		);
		return drive ?? null;
	},
);

const parseAgentDriveConfig = (encryptedConfig: string) =>
	Effect.tryPromise(
		async () =>
			JSON.parse(
				await decrypt(encryptedConfig),
			) as GoogleDriveIntegrationConfig,
	);

const resolveAgentS3Config = Effect.fn("Agent.resolveS3Config")(function* (
	organizationId: Organisation.OrganisationId,
	payload: (typeof Agent.AgentS3ConfigInput)["Type"],
	requestId: string,
) {
	const provider = payload.provider.trim();
	const endpoint = payload.endpoint.trim();
	const bucketName = payload.bucketName.trim();
	const region = payload.region.trim();
	if (
		provider.length === 0 ||
		provider.length > 64 ||
		bucketName.length === 0 ||
		bucketName.length > 255 ||
		region.length === 0 ||
		region.length > 64
	) {
		return yield* badRequest(requestId, "S3 configuration is invalid");
	}
	if (endpoint) {
		try {
			const url = new URL(endpoint);
			if (!new Set(["http:", "https:"]).has(url.protocol)) {
				return yield* badRequest(requestId, "S3 endpoint is invalid");
			}
		} catch {
			return yield* badRequest(requestId, "S3 endpoint is invalid");
		}
	}
	let accessKeyId = payload.accessKeyId.trim();
	let secretAccessKey = payload.secretAccessKey.trim();
	if (!accessKeyId || !secretAccessKey) {
		if (accessKeyId || secretAccessKey) {
			return yield* badRequest(
				requestId,
				"Provide both S3 access key ID and secret access key",
			);
		}
		const database = yield* Database;
		const [existing] = yield* database.use((db) =>
			db
				.select({
					accessKeyId: Db.s3Buckets.accessKeyId,
					secretAccessKey: Db.s3Buckets.secretAccessKey,
				})
				.from(Db.s3Buckets)
				.where(
					and(
						eq(Db.s3Buckets.organizationId, organizationId),
						eq(Db.s3Buckets.active, true),
					),
				)
				.orderBy(desc(Db.s3Buckets.updatedAt))
				.limit(1),
		);
		if (!existing) {
			return yield* badRequest(
				requestId,
				"S3 access key ID and secret access key are required",
			);
		}
		[accessKeyId, secretAccessKey] = yield* Effect.tryPromise(() =>
			Promise.all([
				decrypt(existing.accessKeyId),
				decrypt(existing.secretAccessKey),
			]),
		);
	}
	if (accessKeyId.length > 512 || secretAccessKey.length > 2048) {
		return yield* badRequest(requestId, "S3 credentials are invalid");
	}
	return {
		provider,
		endpoint,
		bucketName,
		region,
		accessKeyId,
		secretAccessKey,
	};
});

const testAgentS3Config = Effect.fn("Agent.testS3Config")(function* (
	config: {
		provider: string;
		endpoint: string;
		bucketName: string;
		region: string;
		accessKeyId: string;
		secretAccessKey: string;
	},
	requestId: string,
) {
	return yield* Effect.tryPromise({
		try: async () => {
			const controller = new AbortController();
			const timeout = setTimeout(() => controller.abort(), 5_000);
			try {
				const client = new S3Client({
					endpoint: config.endpoint || undefined,
					region: config.region,
					credentials: {
						accessKeyId: config.accessKeyId,
						secretAccessKey: config.secretAccessKey,
					},
				});
				await client.send(
					new HeadBucketCommand({ Bucket: config.bucketName }),
					{ abortSignal: controller.signal },
				);
			} finally {
				clearTimeout(timeout);
			}
		},
		catch: () =>
			badRequest(
				requestId,
				"Cap could not access the S3 bucket with this configuration",
			),
	});
});

type ViewerSettingsInput = typeof Agent.AgentViewerSettingsInput.Type;

const mergeViewerSettings = <
	T extends Record<string, unknown> | null | undefined,
>(
	current: T,
	update: ViewerSettingsInput,
) => {
	const next: Record<string, unknown> = { ...(current ?? {}) };
	for (const [key, value] of Object.entries(update)) {
		if (value === null) delete next[key];
		else if (value !== undefined) next[key] = value;
	}
	return next;
};

const hasViewerSettingsUpdate = (value: ViewerSettingsInput) =>
	Object.values(value).some((setting) => setting !== undefined);

const mergeSpaceViewerSettings = (
	current: (typeof Db.spaces.$inferSelect)["settings"],
	update: ViewerSettingsInput,
): NonNullable<(typeof Db.spaces.$inferInsert)["settings"]> =>
	mergeViewerSettings(current, {
		disableSummary: update.disableSummary,
		disableCaptions: update.disableCaptions,
		disableChapters: update.disableChapters,
		disableReactions: update.disableReactions,
		disableTranscript: update.disableTranscript,
		disableComments: update.disableComments,
	}) as NonNullable<(typeof Db.spaces.$inferInsert)["settings"]>;

const hasProSpaceSettingEnabled = (settings: ViewerSettingsInput) =>
	settings.disableSummary === true ||
	settings.disableChapters === true ||
	settings.disableTranscript === true;

const AgentUploadMutationState = Schema.Struct({
	id: Video.VideoId,
	organizationId: Organisation.OrganisationId,
	rawFileKey: Schema.String,
	shareUrl: Schema.String,
	requestId: Schema.String,
});

const AgentUploadCompletionState = Schema.Struct({
	id: Video.VideoId,
	ownerId: Schema.String,
	bucketId: Schema.NullOr(Schema.String),
	rawFileKey: Schema.String,
	requestId: Schema.String,
});

const AgentProcessMutationState = Schema.Struct({
	id: Video.VideoId,
	ownerId: Schema.String,
	target: Schema.Literal("transcript", "ai", "all"),
	transcriptionStatus: Schema.NullOr(Schema.String),
	aiGenerationStatus: Schema.NullOr(Schema.String),
	aiEnabled: Schema.Boolean,
	requestId: Schema.String,
});

const AgentOperationMutationState = Schema.Struct({
	operationId: Schema.String,
	requestId: Schema.String,
});

const toAgentOperationResponse = (
	operation: typeof Db.agentApiOperations.$inferSelect,
	requestId: string,
): (typeof Agent.AgentOperationResponse)["Type"] => ({
	id: operation.id,
	kind: operation.kind,
	state: operation.state,
	resourceId: operation.resourceId,
	resultResourceId: operation.resultResourceId,
	result: operation.result ?? null,
	error:
		operation.errorCode && operation.errorMessage
			? { code: operation.errorCode, message: operation.errorMessage }
			: null,
	createdAt: operation.createdAt.toISOString(),
	updatedAt: operation.updatedAt.toISOString(),
	completedAt: operation.completedAt?.toISOString() ?? null,
	requestId,
});

const getAgentOperation = Effect.fn("Agent.getOperation")(function* (
	operationId: string,
	requestId: string,
) {
	if (!/^[A-Za-z0-9_-]{5,128}$/.test(operationId)) {
		return yield* badRequest(requestId, "Operation ID is invalid");
	}
	const principal = yield* Agent.AgentPrincipal;
	const database = yield* Database;
	const [operation] = yield* database.use((db) =>
		db
			.select()
			.from(Db.agentApiOperations)
			.where(
				and(
					eq(Db.agentApiOperations.id, operationId),
					eq(Db.agentApiOperations.userId, principal.id),
				),
			)
			.limit(1),
	);
	if (!operation) return yield* notFound(requestId);
	return toAgentOperationResponse(operation, requestId);
});

const requireUserConfirmedRequest = Effect.fn(
	"Agent.requireUserConfirmedRequest",
)(function* (requestId: string) {
	const request = yield* HttpServerRequest.HttpServerRequest;
	if (request.headers["x-cap-confirmation"] !== "user") {
		return yield* approvalRequired(
			requestId,
			"Explicit user confirmation is required for this operation",
		);
	}
});

type AgentImageTarget =
	| { type: "profile" }
	| {
			type: "organization";
			organizationId: Organisation.OrganisationId;
			image: "icon" | "shareableLinkIcon";
	  }
	| { type: "folder"; folderId: Folder.FolderId }
	| { type: "space"; spaceId: Space.SpaceIdOrOrganisationId };

const requireAgentStorageManager = Effect.fn("Agent.requireStorageManager")(
	function* (
		principal: Agent.AgentPrincipal["Type"],
		organizationId: Organisation.OrganisationId,
		scope: "integrations:read" | "integrations:write",
		requestId: string,
	) {
		yield* requireScope(principal, scope, requestId);
		const management = yield* AgentManagement;
		yield* management.requireOrganizationManager(principal.id, organizationId);
		const database = yield* Database;
		const [account] = yield* database.use((db) =>
			db
				.select({
					stripeSubscriptionStatus: Db.users.stripeSubscriptionStatus,
					thirdPartyStripeSubscriptionId:
						Db.users.thirdPartyStripeSubscriptionId,
				})
				.from(Db.users)
				.where(eq(Db.users.id, principal.id))
				.limit(1),
		);
		if (!account || !userIsPro(account)) {
			return yield* forbidden(
				requestId,
				"Cap Pro is required to manage storage integrations",
			);
		}
	},
);

const updateAgentImage = Effect.fn("Agent.updateImage")(function* (input: {
	target: AgentImageTarget;
	payload: (typeof Agent.AgentImageInput)["Type"] | null;
	requestId: string;
}) {
	yield* requireAgentWrites(input.requestId);
	yield* requireUserConfirmedRequest(input.requestId);
	const principal = yield* Agent.AgentPrincipal;
	const image = input.payload ? decodeAgentImage(input.payload) : null;
	if (input.payload && !image) {
		return yield* badRequest(
			input.requestId,
			"Image must be a PNG or JPEG no larger than 1 MB",
		);
	}
	let collectionOrganizationId: Organisation.OrganisationId | null = null;
	if (input.target.type === "profile") {
		yield* requireScope(principal, "profile:write", input.requestId);
	} else if (input.target.type === "organization") {
		yield* requireScope(principal, "organizations:manage", input.requestId);
		const management = yield* AgentManagement;
		yield* management.requireOrganizationManager(
			principal.id,
			input.target.organizationId,
		);
	} else {
		yield* requireScope(principal, "library:write", input.requestId);
		const management = yield* AgentManagement;
		const access =
			input.target.type === "folder"
				? yield* management
						.getFolderAccess(principal.id, input.target.folderId)
						.pipe(
							Effect.map((access) => ({
								canManage: access.canManage,
								organizationId: access.folder.organizationId,
							})),
						)
				: yield* management
						.getSpaceAccess(principal.id, input.target.spaceId)
						.pipe(
							Effect.map((access) => ({
								canManage: access.canManage,
								organizationId: access.organizationId,
							})),
						);
		if (!access.canManage) return yield* forbidden(input.requestId);
		collectionOrganizationId = access.organizationId;
		const organization = normalizeOrganization(
			yield* management.getOrganization(principal.id, collectionOrganizationId),
			principal.scopes,
		);
		if (organization.billing.plan !== "pro") {
			return yield* forbidden(
				input.requestId,
				"Cap Pro is required for collection branding",
			);
		}
	}
	const targetId =
		input.target.type === "profile"
			? principal.id
			: input.target.type === "organization"
				? input.target.organizationId
				: input.target.type === "folder"
					? input.target.folderId
					: input.target.spaceId;
	const operation =
		input.target.type === "profile"
			? "update_profile_image"
			: input.target.type === "organization"
				? input.target.image === "icon"
					? "update_organization_icon"
					: "update_shareable_link_icon"
				: input.target.type === "folder"
					? "update_folder_logo"
					: "update_space_logo";
	return yield* runAgentExternalMutation({
		principal,
		operation,
		idempotencyKey: yield* requestIdempotencyKey,
		request: {
			target: input.target,
			image: input.payload
				? {
						contentType: input.payload.contentType,
						fileName: input.payload.fileName,
						sha256: createHash("sha256")
							.update(input.payload.data)
							.digest("hex"),
					}
				: null,
		},
		requestId: input.requestId,
		decodeReplay: decodeMutationResponse,
		execute: () =>
			Effect.gen(function* () {
				const database = yield* Database;
				const imageUploads = yield* ImageUploads;
				const target = input.target;
				if (target.type === "profile") {
					const [account] = yield* database.use((db) =>
						db
							.select({ image: Db.users.image })
							.from(Db.users)
							.where(eq(Db.users.id, principal.id))
							.limit(1),
					);
					if (!account) return yield* notFound(input.requestId);
					yield* imageUploads.applyUpdate({
						payload: image ? Option.some(image) : Option.none(),
						existing: Option.fromNullable(account.image),
						keyPrefix: `users/${principal.id}`,
						update: (db, urlOrKey) =>
							db
								.update(Db.users)
								.set({ image: urlOrKey })
								.where(eq(Db.users.id, principal.id)),
					});
				} else if (target.type === "organization") {
					const organizationTarget = target;
					const [organization] = yield* database.use((db) =>
						db
							.select({
								icon: Db.organizations.iconUrl,
								shareableLinkIcon: Db.organizations.shareableLinkIconUrl,
								stripeSubscriptionStatus: Db.users.stripeSubscriptionStatus,
								thirdPartyStripeSubscriptionId:
									Db.users.thirdPartyStripeSubscriptionId,
							})
							.from(Db.organizations)
							.innerJoin(Db.users, eq(Db.organizations.ownerId, Db.users.id))
							.where(
								and(
									eq(Db.organizations.id, organizationTarget.organizationId),
									isNull(Db.organizations.tombstoneAt),
								),
							)
							.limit(1),
					);
					if (!organization) return yield* notFound(input.requestId);
					if (
						organizationTarget.image === "shareableLinkIcon" &&
						!userIsPro(organization)
					) {
						return yield* forbidden(
							input.requestId,
							"Cap Pro is required for shareable link branding",
						);
					}
					const existing =
						organizationTarget.image === "icon"
							? organization.icon
							: organization.shareableLinkIcon;
					const keyPrefix =
						organizationTarget.image === "icon"
							? `organizations/${organizationTarget.organizationId}`
							: `organizations/${organizationTarget.organizationId}/shareable-links`;
					yield* imageUploads.applyUpdate({
						payload: image ? Option.some(image) : Option.none(),
						existing: Option.fromNullable(existing),
						keyPrefix,
						update: (db, urlOrKey) =>
							db
								.update(Db.organizations)
								.set(
									organizationTarget.image === "icon"
										? { iconUrl: urlOrKey }
										: { shareableLinkIconUrl: urlOrKey },
								)
								.where(
									eq(Db.organizations.id, organizationTarget.organizationId),
								),
					});
				} else {
					const organizationId = collectionOrganizationId;
					if (!organizationId) {
						return yield* temporarilyUnavailable(
							input.requestId,
							"Collection organization is unavailable",
						);
					}
					const [collection] =
						target.type === "folder"
							? yield* database.use((db) =>
									db
										.select({ settings: Db.folders.settings })
										.from(Db.folders)
										.where(eq(Db.folders.id, target.folderId))
										.limit(1),
								)
							: yield* database.use((db) =>
									db
										.select({ settings: Db.spaces.settings })
										.from(Db.spaces)
										.where(eq(Db.spaces.id, target.spaceId))
										.limit(1),
								);
					if (!collection) return yield* notFound(input.requestId);
					const settings = collection.settings as {
						publicPage?: { logoUrl?: string };
					} | null;
					yield* imageUploads.applyUpdate({
						payload: image ? Option.some(image) : Option.none(),
						existing: Option.fromNullable(
							settings?.publicPage?.logoUrl as
								| ImageUpload.ImageUrlOrKey
								| undefined,
						),
						keyPrefix: `organizations/${organizationId}/collections/${targetId}/logo`,
						update: (db, urlOrKey) => {
							const patch = JSON.stringify({
								publicPage: {
									logoUrl: urlOrKey ?? null,
									logoMode: urlOrKey ? "custom" : "cap",
								},
							});
							return target.type === "folder"
								? db
										.update(Db.folders)
										.set({
											settings: sql`JSON_MERGE_PATCH(COALESCE(${Db.folders.settings}, '{}'), CAST(${patch} AS JSON))`,
										})
										.where(eq(Db.folders.id, target.folderId))
								: db
										.update(Db.spaces)
										.set({
											settings: sql`JSON_MERGE_PATCH(COALESCE(${Db.spaces.settings}, '{}'), CAST(${patch} AS JSON))`,
										})
										.where(eq(Db.spaces.id, target.spaceId));
						},
					});
				}
				const now = new Date();
				return mutationResponse(
					input.target.type === "profile"
						? "profile_image"
						: input.target.type === "organization"
							? input.target.image === "icon"
								? "organization_icon"
								: "shareable_link_icon"
							: input.target.type === "folder"
								? "folder_logo"
								: "space_logo",
					targetId,
					image ? "updated" : "deleted",
					input.requestId,
					now,
				);
			}),
	});
});

const updateAgentCollectionPublicPage = Effect.fn(
	"Agent.updateCollectionPublicPage",
)(function* (input: {
	target:
		| { type: "folder"; folderId: Folder.FolderId }
		| { type: "space"; spaceId: Space.SpaceIdOrOrganisationId };
	payload: (typeof Agent.AgentCollectionPublicPageInput)["Type"];
	requestId: string;
}) {
	yield* requireAgentWrites(input.requestId);
	yield* requireUserConfirmedRequest(input.requestId);
	const principal = yield* Agent.AgentPrincipal;
	yield* requireScope(principal, "library:write", input.requestId);
	const { public: publicValue, ...publicPageValues } = input.payload;
	const publicPage = Object.fromEntries(
		Object.entries(publicPageValues).filter(([, value]) => value !== undefined),
	);
	if (publicValue === undefined && Object.keys(publicPage).length === 0) {
		return yield* badRequest(
			input.requestId,
			"At least one public page field is required",
		);
	}
	const management = yield* AgentManagement;
	const access =
		input.target.type === "folder"
			? yield* management
					.getFolderAccess(principal.id, input.target.folderId)
					.pipe(
						Effect.map((access) => ({
							canManage: access.canManage,
							organizationId: access.folder.organizationId,
						})),
					)
			: yield* management
					.getSpaceAccess(principal.id, input.target.spaceId)
					.pipe(
						Effect.map((access) => ({
							canManage: access.canManage,
							organizationId: access.organizationId,
						})),
					);
	if (!access.canManage) return yield* forbidden(input.requestId);
	const organizationId = access.organizationId;
	if (publicValue === true || Object.keys(publicPage).length > 0) {
		const organization = normalizeOrganization(
			yield* management.getOrganization(principal.id, organizationId),
			principal.scopes,
		);
		if (organization.billing.plan !== "pro") {
			return yield* forbidden(
				input.requestId,
				"Cap Pro is required for public collection customization",
			);
		}
	}
	const targetId =
		input.target.type === "folder"
			? input.target.folderId
			: input.target.spaceId;
	return yield* runAgentMutation({
		principal,
		operation: `update_${input.target.type}_public_page`,
		idempotencyKey: yield* requestIdempotencyKey,
		request: { target: input.target, payload: input.payload },
		requestId: input.requestId,
		decodeReplay: decodeMutationResponse,
		execute: async (tx) => {
			const now = new Date();
			const settingsPatch =
				Object.keys(publicPage).length > 0
					? JSON.stringify({ publicPage })
					: null;
			const result =
				input.target.type === "folder"
					? await tx
							.update(Db.folders)
							.set({
								public: publicValue,
								settings: settingsPatch
									? sql`JSON_MERGE_PATCH(COALESCE(${Db.folders.settings}, '{}'), CAST(${settingsPatch} AS JSON))`
									: undefined,
								updatedAt: now,
							})
							.where(eq(Db.folders.id, input.target.folderId))
					: await tx
							.update(Db.spaces)
							.set({
								public: publicValue,
								settings: settingsPatch
									? sql`JSON_MERGE_PATCH(COALESCE(${Db.spaces.settings}, '{}'), CAST(${settingsPatch} AS JSON))`
									: undefined,
								updatedAt: now,
							})
							.where(eq(Db.spaces.id, input.target.spaceId));
			if (affectedRows(result) === 0) return { state: "not_found" };
			return {
				state: "success",
				response: mutationResponse(
					`${input.target.type}_public_page`,
					targetId,
					"updated",
					input.requestId,
					now,
				),
			};
		},
	});
});

const queueAgentCapOperation = Effect.fn("Agent.queueCapOperation")(
	function* (input: {
		videoId: Video.VideoId;
		kind: "duplicate_cap" | "delete_cap";
		scope: Agent.AgentScope;
		requestId: string;
	}) {
		yield* requireAgentWrites(input.requestId);
		yield* requireUserConfirmedRequest(input.requestId);
		const principal = yield* Agent.AgentPrincipal;
		yield* requireScope(principal, input.scope, input.requestId);
		const operationId = nanoId();
		const destinationId =
			input.kind === "duplicate_cap" ? Video.VideoId.make(nanoId()) : null;
		const state = yield* runAgentMutation({
			principal,
			operation: input.kind,
			idempotencyKey: yield* requestIdempotencyKey,
			request: { videoId: input.videoId },
			requestId: input.requestId,
			decodeReplay: Schema.decodeUnknownSync(AgentOperationMutationState),
			execute: async (tx) => {
				const [video] = await tx
					.select()
					.from(Db.videos)
					.where(
						and(
							eq(Db.videos.id, input.videoId),
							eq(Db.videos.ownerId, principal.id),
						),
					)
					.limit(1)
					.for("update");
				if (!video) return { state: "not_found" };
				await tx.insert(Db.agentApiOperations).values({
					id: operationId,
					userId: principal.id,
					kind: input.kind,
					resourceId: input.videoId,
					resultResourceId: destinationId,
					payload: {
						snapshot: {
							id: video.id,
							ownerId: video.ownerId,
							orgId: video.orgId,
							name: video.name,
							bucket: video.bucket,
							storageIntegrationId: video.storageIntegrationId,
							duration: video.duration,
							width: video.width,
							height: video.height,
							fps: video.fps,
							metadata: video.metadata,
							public: video.public,
							settings: video.settings,
							transcriptionStatus: video.transcriptionStatus,
							source: video.source,
							folderId: video.folderId,
							isScreenshot: video.isScreenshot,
							skipProcessing: video.skipProcessing,
						},
						destinationId,
					},
				});
				return {
					state: "success",
					response: { operationId, requestId: input.requestId },
				};
			},
		});
		yield* Effect.tryPromise(() =>
			start(agentCapOperationWorkflow, [{ operationId: state.operationId }]),
		);
		return yield* getAgentOperation(state.operationId, state.requestId);
	},
);

const queueAgentOrganizationDelete = Effect.fn("Agent.queueOrganizationDelete")(
	function* (organizationId: Organisation.OrganisationId, requestId: string) {
		yield* requireAgentWrites(requestId);
		yield* requireUserConfirmedRequest(requestId);
		const principal = yield* Agent.AgentPrincipal;
		yield* requireScope(principal, "organizations:manage", requestId);
		const operationId = nanoId();
		const state = yield* runAgentMutation({
			principal,
			operation: "delete_organization",
			idempotencyKey: yield* requestIdempotencyKey,
			request: { organizationId },
			requestId,
			decodeReplay: Schema.decodeUnknownSync(AgentOperationMutationState),
			execute: async (tx) => {
				const [organization] = await tx
					.select({ id: Db.organizations.id })
					.from(Db.organizations)
					.where(
						and(
							eq(Db.organizations.id, organizationId),
							eq(Db.organizations.ownerId, principal.id),
							isNull(Db.organizations.tombstoneAt),
						),
					)
					.limit(1)
					.for("update");
				if (!organization) return { state: "not_found" };
				await tx.insert(Db.agentApiOperations).values({
					id: operationId,
					userId: principal.id,
					kind: "delete_organization",
					resourceId: organizationId,
					resultResourceId: null,
					payload: { organizationId },
				});
				return {
					state: "success",
					response: { operationId, requestId },
				};
			},
		});
		yield* Effect.tryPromise(() =>
			start(agentCapOperationWorkflow, [{ operationId: state.operationId }]),
		);
		return yield* getAgentOperation(state.operationId, state.requestId);
	},
);

const queueAgentOrganizationDomain = Effect.fn("Agent.queueOrganizationDomain")(
	function* (input: {
		organizationId: Organisation.OrganisationId;
		kind:
			| "set_organization_domain"
			| "remove_organization_domain"
			| "verify_organization_domain";
		domain?: string;
		requestId: string;
	}) {
		yield* requireAgentWrites(input.requestId);
		yield* requireUserConfirmedRequest(input.requestId);
		const principal = yield* Agent.AgentPrincipal;
		yield* requireScope(principal, "organizations:manage", input.requestId);
		const management = yield* AgentManagement;
		yield* management.requireOrganizationManager(
			principal.id,
			input.organizationId,
		);
		const operationId = nanoId();
		const state = yield* runAgentMutation({
			principal,
			operation: input.kind,
			idempotencyKey: yield* requestIdempotencyKey,
			request: {
				organizationId: input.organizationId,
				domain: input.domain,
			},
			requestId: input.requestId,
			decodeReplay: Schema.decodeUnknownSync(AgentOperationMutationState),
			execute: async (tx) => {
				const [[organization], [membership], [account]] = await Promise.all([
					tx
						.select({ ownerId: Db.organizations.ownerId })
						.from(Db.organizations)
						.where(
							and(
								eq(Db.organizations.id, input.organizationId),
								isNull(Db.organizations.tombstoneAt),
							),
						)
						.limit(1)
						.for("update"),
					tx
						.select({ role: Db.organizationMembers.role })
						.from(Db.organizationMembers)
						.where(
							and(
								eq(Db.organizationMembers.organizationId, input.organizationId),
								eq(Db.organizationMembers.userId, principal.id),
							),
						)
						.limit(1),
					tx
						.select({
							stripeSubscriptionStatus: Db.users.stripeSubscriptionStatus,
							thirdPartyStripeSubscriptionId:
								Db.users.thirdPartyStripeSubscriptionId,
						})
						.from(Db.users)
						.where(eq(Db.users.id, principal.id))
						.limit(1),
				]);
				if (!organization || !account) return { state: "not_found" };
				if (
					organization.ownerId !== principal.id &&
					membership?.role !== "owner" &&
					membership?.role !== "admin"
				) {
					return { state: "forbidden" };
				}
				if (input.kind === "set_organization_domain" && !userIsPro(account)) {
					return { state: "forbidden" };
				}
				if (input.domain) {
					const [conflict] = await tx
						.select({ id: Db.organizations.id })
						.from(Db.organizations)
						.where(
							and(
								eq(Db.organizations.customDomain, input.domain),
								ne(Db.organizations.id, input.organizationId),
							),
						)
						.limit(1);
					if (conflict) return { state: "conflict" };
				}
				await tx.insert(Db.agentApiOperations).values({
					id: operationId,
					userId: principal.id,
					kind: input.kind,
					resourceId: input.organizationId,
					resultResourceId: null,
					payload: {
						organizationId: input.organizationId,
						domain: input.domain,
					},
				});
				return {
					state: "success",
					response: { operationId, requestId: input.requestId },
				};
			},
		});
		yield* Effect.tryPromise(() =>
			start(agentCapOperationWorkflow, [{ operationId: state.operationId }]),
		);
		return yield* getAgentOperation(state.operationId, state.requestId);
	},
);

const queueAgentLoomImport = Effect.fn("Agent.queueLoomImport")(
	function* (input: {
		organizationId: Organisation.OrganisationId;
		payload: (typeof Agent.AgentLoomImportInput)["Type"];
		requestId: string;
	}) {
		yield* requireAgentWrites(input.requestId);
		yield* requireUserConfirmedRequest(input.requestId);
		const principal = yield* Agent.AgentPrincipal;
		yield* requireScope(principal, "caps:write", input.requestId);
		const loomUrl = input.payload.loomUrl.trim();
		let parsedLoomUrl: URL;
		try {
			parsedLoomUrl = new URL(loomUrl);
		} catch {
			return yield* badRequest(input.requestId, "Loom URL is invalid");
		}
		if (
			loomUrl.length > 2_048 ||
			(parsedLoomUrl.hostname !== "loom.com" &&
				!parsedLoomUrl.hostname.endsWith(".loom.com"))
		) {
			return yield* badRequest(input.requestId, "Loom URL is invalid");
		}
		const ownerEmail = input.payload.ownerEmail?.trim().toLowerCase();
		if (
			ownerEmail &&
			(ownerEmail.length > 255 ||
				!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(ownerEmail))
		) {
			return yield* badRequest(input.requestId, "Owner email is invalid");
		}
		const spaceName = input.payload.spaceName?.trim().replace(/\s+/g, " ");
		if (
			spaceName !== undefined &&
			(spaceName.length === 0 || spaceName.length > 255)
		) {
			return yield* badRequest(
				input.requestId,
				"Space name must be between 1 and 255 characters",
			);
		}
		const management = yield* AgentManagement;
		yield* management.getMembership(principal.id, input.organizationId);
		if (ownerEmail || spaceName) {
			yield* management.requireOrganizationManager(
				principal.id,
				input.organizationId,
			);
		}
		if (ownerEmail) {
			yield* requireScope(principal, "organizations:members", input.requestId);
		}
		if (spaceName) {
			yield* requireScope(principal, "library:write", input.requestId);
		}
		const database = yield* Database;
		const [account] = yield* database.use((db) =>
			db
				.select({
					stripeSubscriptionStatus: Db.users.stripeSubscriptionStatus,
					thirdPartyStripeSubscriptionId:
						Db.users.thirdPartyStripeSubscriptionId,
				})
				.from(Db.users)
				.where(eq(Db.users.id, principal.id))
				.limit(1),
		);
		if (!account) return yield* notFound(input.requestId);
		if (!userIsPro(account)) {
			return yield* forbidden(
				input.requestId,
				"Importing from Loom requires Cap Pro",
			);
		}
		const request = yield* HttpServerRequest.HttpServerRequest;
		const headers = new Headers();
		for (const [name, value] of Object.entries(request.headers)) {
			headers.set(name, value);
		}
		const idempotencyKey = yield* requestIdempotencyKey;
		const state = yield* runAgentExternalMutation({
			principal,
			operation: "import_loom",
			idempotencyKey,
			request: {
				organizationId: input.organizationId,
				loomUrl,
				ownerEmail: ownerEmail ?? null,
				spaceName: spaceName ?? null,
			},
			requestId: input.requestId,
			decodeReplay: Schema.decodeUnknownSync(AgentOperationMutationState),
			execute: (providerIdempotencyKey) =>
				Effect.gen(function* () {
					if (
						yield* Effect.promise(() =>
							isRateLimited(RATE_LIMIT_IDS.AGENT_LOOM_IMPORT, {
								key: `loom-import:${principal.id}`,
								headers,
							}),
						)
					) {
						return yield* rateLimited(input.requestId);
					}
					const download = yield* Effect.tryPromise({
						try: () => downloadLoomVideo(loomUrl),
						catch: () =>
							temporarilyUnavailable(
								input.requestId,
								"Loom could not be reached",
							),
					});
					if (!download.success || !download.videoId || !download.downloadUrl) {
						return yield* badRequest(
							input.requestId,
							download.error ?? "The Loom video is unavailable",
						);
					}
					let ownerId = principal.id;
					if (ownerEmail) {
						const provisioned = yield* Effect.tryPromise({
							try: () =>
								provisionOrganizationInvitee({
									organizationId: input.organizationId,
									email: ownerEmail,
									invitedByUserId: principal.id,
									role: "member",
								}),
							catch: () =>
								temporarilyUnavailable(
									input.requestId,
									"The Loom import owner could not be provisioned",
								),
						});
						ownerId = provisioned.userId;
					}
					const loomVideoId = download.videoId;
					const operationId = deterministicAgentId(
						"loom_operation",
						principal.id,
						providerIdempotencyKey,
					);
					const videoId = Video.VideoId.make(
						deterministicAgentId(
							"loom_video",
							principal.id,
							providerIdempotencyKey,
						),
					);
					const writable = yield* Storage.getWritableAccessForUser(
						ownerId,
						input.organizationId,
					);
					const rawFileKey = `${ownerId}/${videoId}/raw-upload.mp4`;
					const now = new Date();
					const importState = yield* database.use((db) =>
						db.transaction(async (tx) => {
							const [existingImport] = await tx
								.select({ id: Db.importedVideos.id })
								.from(Db.importedVideos)
								.where(
									and(
										eq(Db.importedVideos.orgId, input.organizationId),
										eq(Db.importedVideos.source, "loom"),
										eq(Db.importedVideos.sourceId, loomVideoId),
									),
								)
								.limit(1)
								.for("update");
							if (existingImport && existingImport.id !== videoId) {
								return "conflict" as const;
							}
							const [existingOperation] = await tx
								.select({ id: Db.agentApiOperations.id })
								.from(Db.agentApiOperations)
								.where(eq(Db.agentApiOperations.id, operationId))
								.limit(1);
							if (!existingOperation) {
								if (!existingImport) {
									await tx.insert(Db.videos).values({
										id: videoId,
										name:
											download.videoName?.slice(0, 255) ??
											`Loom Import - ${now.toISOString().slice(0, 10)}`,
										ownerId,
										orgId: input.organizationId,
										source: { type: "webMP4" },
										bucket: Option.getOrNull(writable.bucketId),
										storageIntegrationId: Option.getOrNull(
											writable.storageIntegrationId,
										),
										public: serverEnv().CAP_VIDEOS_DEFAULT_PUBLIC,
										duration: download.durationSeconds,
										width: download.width,
										height: download.height,
									});
									await tx.insert(Db.videoUploads).values({
										videoId,
										phase: "uploading",
										processingProgress: 0,
										processingMessage: "Importing from Loom...",
									});
									await tx.insert(Db.importedVideos).values({
										id: videoId,
										orgId: input.organizationId,
										source: "loom",
										sourceId: loomVideoId,
									});
								}
								let spaceId: Space.SpaceIdOrOrganisationId | null = null;
								if (spaceName) {
									const [existingSpace] = await tx
										.select({ id: Db.spaces.id })
										.from(Db.spaces)
										.where(
											and(
												eq(Db.spaces.organizationId, input.organizationId),
												sql`LOWER(${Db.spaces.name}) = ${spaceName.toLowerCase()}`,
											),
										)
										.limit(1);
									spaceId =
										existingSpace?.id ??
										Space.SpaceId.make(
											deterministicAgentId(
												"loom_space",
												input.organizationId,
												spaceName.toLowerCase(),
											),
										);
									if (!existingSpace) {
										await tx.insert(Db.spaces).values({
											id: spaceId,
											name: spaceName,
											organizationId: input.organizationId,
											createdById: principal.id,
										});
									}
									for (const [userId, role] of [
										[principal.id, "admin"],
										[ownerId, ownerId === principal.id ? "admin" : "member"],
									] as const) {
										await tx
											.insert(Db.spaceMembers)
											.values({
												id: deterministicAgentId(
													"loom_space_member",
													spaceId,
													userId,
												),
												spaceId,
												userId,
												role,
											})
											.onDuplicateKeyUpdate({
												set: { role: sql`${Db.spaceMembers.role}` },
											});
									}
									await tx.insert(Db.spaceVideos).values({
										id: deterministicAgentId(
											"loom_space_video",
											spaceId,
											videoId,
										),
										spaceId,
										videoId,
										addedById: principal.id,
									});
								}
								await tx.insert(Db.agentApiOperations).values({
									id: operationId,
									userId: principal.id,
									kind: "import_loom",
									resourceId: input.organizationId,
									resultResourceId: videoId,
									payload: {
										organizationId: input.organizationId,
										videoId,
										ownerId,
										loomVideoId,
										spaceId,
									},
								});
							}
							return "ready" as const;
						}),
					);
					if (importState === "conflict") {
						return yield* new Agent.AgentConflictError({
							...commonError(
								input.requestId,
								"This Loom video has already been imported",
							),
							code: "CONFLICT",
						});
					}
					yield* Effect.tryPromise(() =>
						start(importLoomVideoWorkflow, [
							{
								videoId,
								userId: ownerId,
								rawFileKey,
								bucketId: Option.getOrNull(writable.bucketId),
								loomVideoId,
								agentOperationId: operationId,
							},
						]),
					).pipe(Effect.asVoid);
					return { operationId, requestId: input.requestId };
				}),
		});
		return yield* getAgentOperation(state.operationId, state.requestId);
	},
);

const normalizeTranscriptCues = (
	cues: ReadonlyArray<(typeof Agent.AgentTranscriptCue)["Type"]>,
) => {
	if (cues.length === 0 || cues.length > 50_000) return null;
	let previousStartMs = -1;
	const normalized: (typeof Agent.AgentTranscriptCue)["Type"][] = [];
	for (const cue of cues) {
		const text = cue.text.replace(/\s+/g, " ").trim();
		if (
			!Number.isSafeInteger(cue.startMs) ||
			!Number.isSafeInteger(cue.endMs) ||
			cue.startMs < 0 ||
			cue.endMs < cue.startMs ||
			cue.startMs < previousStartMs ||
			text.length === 0 ||
			text.length > 10_000
		) {
			return null;
		}
		normalized.push({ startMs: cue.startMs, endMs: cue.endMs, text });
		previousStartMs = cue.startMs;
	}
	const vtt = renderAgentVtt(normalized);
	return Buffer.byteLength(vtt, "utf8") <= 10 * 1024 * 1024
		? { cues: normalized, vtt }
		: null;
};

const AgentHandlersLive = HttpApiBuilder.group(
	Agent.AgentApiContract,
	"agent",
	(handlers) =>
		handlers
			.handle("listCaps", ({ urlParams }) => {
				const requestId = makeRequestId();
				return withMappedErrors(listCaps(urlParams, requestId), requestId);
			})
			.handle("getCap", ({ path }) => {
				const requestId = makeRequestId();
				return withMappedErrors(
					getViewableCap(path.id).pipe(Effect.map(({ cap }) => cap)),
					requestId,
				);
			})
			.handle("getContext", ({ path }) => {
				const requestId = makeRequestId();
				return withMappedErrors(getContext(path.id, requestId), requestId);
			})
			.handle("getStatus", ({ path }) => {
				const requestId = makeRequestId();
				return withMappedErrors(
					Effect.gen(function* () {
						yield* getViewableVideo(path.id);
						return getStatus(yield* getStatusRow(path.id));
					}),
					requestId,
				);
			})
			.handle("getTranscript", ({ path, urlParams }) => {
				const requestId = makeRequestId();
				return withMappedErrors(
					Effect.gen(function* () {
						const { video, cap } = yield* getViewableCap(path.id);
						if (cap.capabilities.transcript.reason === "CONTENT_DISABLED") {
							return yield* contentDisabled(requestId, "Transcript");
						}
						if (!cap.capabilities.transcript.allowed) {
							return yield* notReady(requestId, "Transcript is not ready");
						}
						const transcript = yield* readTranscript(video, requestId);
						switch (urlParams.format ?? "text") {
							case "json":
								return HttpServerResponse.unsafeJson({
									id: path.id,
									revision: transcript.revision,
									cues: transcript.cues,
									requestId,
								});
							case "vtt":
								return HttpServerResponse.text(transcript.vtt, {
									headers: { "Content-Type": "text/vtt; charset=utf-8" },
								});
							case "text":
								return HttpServerResponse.text(transcript.text, {
									headers: { "Content-Type": "text/plain; charset=utf-8" },
								});
						}
					}),
					requestId,
				);
			})
			.handle("getDownload", ({ path }) => {
				const requestId = makeRequestId();
				return withMappedErrors(
					Effect.gen(function* () {
						const { cap } = yield* getViewableCap(path.id);
						if (!cap.capabilities.download.allowed) {
							return yield* forbidden(requestId);
						}
						const videos = yield* Videos;
						const principal = yield* Agent.AgentPrincipal;
						const result = yield* videos
							.getDownloadInfo(path.id)
							.pipe(
								Effect.provideService(CurrentUser, toCurrentUser(principal)),
							);
						if (Option.isNone(result)) {
							return yield* notReady(requestId, "Download is not ready");
						}
						return {
							fileName: result.value.fileName,
							url: result.value.downloadUrl,
							expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
							requestId,
						};
					}),
					requestId,
				);
			})
			.handle("unlockCap", ({ path }) => {
				const requestId = makeRequestId();
				return withMappedErrors(unlockCap(path.id, requestId), requestId);
			})
			.handle("createComment", ({ path, payload }) => {
				const requestId = makeRequestId();
				return withMappedErrors(
					Effect.gen(function* () {
						yield* requireAgentWrites(requestId);
						yield* requireUserConfirmedRequest(requestId);
						const principal = yield* Agent.AgentPrincipal;
						const { cap, row } = yield* getViewableCap(path.id);
						if (!cap.capabilities.comment.allowed) {
							return yield* capabilityFailure(
								requestId,
								cap.capabilities.comment,
							);
						}
						return yield* createAgentFeedback({
							videoId: path.id,
							principal,
							type: "text",
							content: payload.content,
							timestampMs: payload.timestampMs ?? null,
							parentCommentId: null,
							idempotencyKey: yield* requestIdempotencyKey,
							requestId,
							durationMs:
								row.duration === null ? null : Math.round(row.duration * 1_000),
						});
					}),
					requestId,
				);
			})
			.handle("createReply", ({ path, payload }) => {
				const requestId = makeRequestId();
				return withMappedErrors(
					Effect.gen(function* () {
						yield* requireAgentWrites(requestId);
						yield* requireUserConfirmedRequest(requestId);
						const principal = yield* Agent.AgentPrincipal;
						const { cap, row } = yield* getViewableCap(path.id);
						if (!cap.capabilities.comment.allowed) {
							return yield* capabilityFailure(
								requestId,
								cap.capabilities.comment,
							);
						}
						return yield* createAgentFeedback({
							videoId: path.id,
							principal,
							type: "text",
							content: payload.content,
							timestampMs: payload.timestampMs ?? null,
							parentCommentId: path.commentId,
							idempotencyKey: yield* requestIdempotencyKey,
							requestId,
							durationMs:
								row.duration === null ? null : Math.round(row.duration * 1_000),
						});
					}),
					requestId,
				);
			})
			.handle("createReaction", ({ path, payload }) => {
				const requestId = makeRequestId();
				return withMappedErrors(
					Effect.gen(function* () {
						yield* requireAgentWrites(requestId);
						yield* requireUserConfirmedRequest(requestId);
						const principal = yield* Agent.AgentPrincipal;
						const { cap, row } = yield* getViewableCap(path.id);
						if (!cap.capabilities.react.allowed) {
							return yield* capabilityFailure(
								requestId,
								cap.capabilities.react,
							);
						}
						return yield* createAgentFeedback({
							videoId: path.id,
							principal,
							type: "emoji",
							content: payload.content,
							timestampMs: payload.timestampMs ?? null,
							parentCommentId: null,
							idempotencyKey: yield* requestIdempotencyKey,
							requestId,
							durationMs:
								row.duration === null ? null : Math.round(row.duration * 1_000),
						});
					}),
					requestId,
				);
			})
			.handle("updateCap", ({ path, payload }) => {
				const requestId = makeRequestId();
				return withMappedErrors(
					Effect.gen(function* () {
						yield* requireAgentWrites(requestId);
						yield* requireUserConfirmedRequest(requestId);
						const principal = yield* Agent.AgentPrincipal;
						const { cap } = yield* getViewableCap(path.id);
						if (
							(payload.title !== undefined &&
								!cap.capabilities.editTitle.allowed) ||
							(payload.public !== undefined &&
								!cap.capabilities.editVisibility.allowed)
						) {
							return yield* forbidden(requestId);
						}
						return yield* updateAgentCap({
							videoId: path.id,
							principal,
							title: payload.title,
							public: payload.public,
							idempotencyKey: yield* requestIdempotencyKey,
							requestId,
						});
					}),
					requestId,
				);
			}),
);

const AgentManagementHandlersLive = HttpApiBuilder.group(
	Agent.AgentApiContract,
	"agentManagement",
	(handlers) =>
		handlers
			.handle("getMe", () => {
				const requestId = makeRequestId();
				return withMappedErrors(
					Effect.gen(function* () {
						const principal = yield* Agent.AgentPrincipal;
						yield* requireScope(principal, "profile:read", requestId);
						const management = yield* AgentManagement;
						const account = yield* management.getAccount(principal.id);
						return {
							...account,
							image: account.image ?? null,
							activeOrganizationId: account.activeOrganizationId ?? null,
							defaultOrganizationId: account.defaultOrganizationId ?? null,
							createdAt: account.createdAt.toISOString(),
							capabilities: profileCapabilities(principal.scopes),
							requestId,
						};
					}),
					requestId,
				);
			})
			.handle("listOrganizations", () => {
				const requestId = makeRequestId();
				return withMappedErrors(
					Effect.gen(function* () {
						const principal = yield* Agent.AgentPrincipal;
						yield* requireScope(principal, "organizations:read", requestId);
						const management = yield* AgentManagement;
						const rows = yield* management.listOrganizations(principal.id);
						return {
							organizations: rows.map((row) =>
								normalizeOrganization(row, principal.scopes),
							),
							requestId,
						};
					}),
					requestId,
				);
			})
			.handle("getOrganization", ({ path }) => {
				const requestId = makeRequestId();
				return withMappedErrors(
					Effect.gen(function* () {
						const principal = yield* Agent.AgentPrincipal;
						yield* requireScope(principal, "organizations:read", requestId);
						const management = yield* AgentManagement;
						const row = yield* management.getOrganization(
							principal.id,
							path.organizationId,
						);
						return {
							organization: normalizeOrganization(row, principal.scopes),
							requestId,
						};
					}),
					requestId,
				);
			})
			.handle("listOrganizationMembers", ({ path }) => {
				const requestId = makeRequestId();
				return withMappedErrors(
					Effect.gen(function* () {
						const principal = yield* Agent.AgentPrincipal;
						yield* requireScope(principal, "organizations:read", requestId);
						const management = yield* AgentManagement;
						const caller = yield* management.getMembership(
							principal.id,
							path.organizationId,
						);
						const rows = yield* management.listMembers(
							principal.id,
							path.organizationId,
						);
						const callerCapabilities = organizationCapabilities(
							caller.role,
							principal.scopes,
						);
						return {
							members: rows.map((row) => {
								const role =
									row.role === "owner" || row.role === "admin"
										? row.role
										: "member";
								const canChange =
									role !== "owner" && callerCapabilities.manageMembers.allowed;
								return {
									...row,
									role,
									createdAt: row.createdAt.toISOString(),
									updatedAt: row.updatedAt.toISOString(),
									capabilities: {
										update: {
											...callerCapabilities.manageMembers,
											allowed: canChange,
											reason: canChange
												? null
												: (callerCapabilities.manageMembers.reason ??
													"OWNER_ONLY"),
										},
										remove: {
											...callerCapabilities.manageMembers,
											allowed: canChange,
											reason: canChange
												? null
												: (callerCapabilities.manageMembers.reason ??
													"OWNER_ONLY"),
											sideEffect: "destructive" as const,
										},
									},
								};
							}),
							requestId,
						};
					}),
					requestId,
				);
			})
			.handle("listOrganizationInvites", ({ path }) => {
				const requestId = makeRequestId();
				return withMappedErrors(
					Effect.gen(function* () {
						const principal = yield* Agent.AgentPrincipal;
						yield* requireScope(principal, "organizations:read", requestId);
						const management = yield* AgentManagement;
						const caller = yield* management.requireOrganizationManager(
							principal.id,
							path.organizationId,
						);
						const rows = yield* management.listInvites(
							principal.id,
							path.organizationId,
						);
						const capability = organizationCapabilities(
							caller.role,
							principal.scopes,
						).manageMembers;
						return {
							invites: rows.map((row) => ({
								id: row.id,
								invitedEmail: row.invitedEmail,
								role:
									row.role === "owner" || row.role === "admin"
										? row.role
										: "member",
								status: row.status,
								expiresAt: row.expiresAt?.toISOString() ?? null,
								createdAt: row.createdAt.toISOString(),
								updatedAt: row.updatedAt.toISOString(),
								capabilities: { revoke: capability },
							})),
							requestId,
						};
					}),
					requestId,
				);
			})
			.handle("listFolders", ({ path, urlParams }) => {
				const requestId = makeRequestId();
				return withMappedErrors(
					Effect.gen(function* () {
						const principal = yield* Agent.AgentPrincipal;
						yield* requireScope(principal, "library:read", requestId);
						const management = yield* AgentManagement;
						const spaceId = urlParams.spaceId
							? Space.SpaceId.make(urlParams.spaceId)
							: null;
						const parentId =
							urlParams.parentId === "root"
								? null
								: urlParams.parentId
									? Folder.FolderId.make(urlParams.parentId)
									: undefined;
						const rows = yield* management.listFolders(
							principal.id,
							path.organizationId,
							spaceId,
							parentId,
						);
						const canManage =
							spaceId === null
								? true
								: String(spaceId) === String(path.organizationId)
									? (yield* management.getMembership(
											principal.id,
											path.organizationId,
										)).role !== "member"
									: (yield* management.getSpaceAccess(principal.id, spaceId))
											.canManage;
						return {
							folders: rows.map((row) => ({
								id: row.id,
								name: row.name,
								color: row.color,
								public: row.public,
								organizationId: row.organizationId,
								createdById: row.createdById,
								parentId: row.parentId,
								spaceId: row.spaceId,
								settings: row.settings ?? null,
								publicPage: row.settings?.publicPage ?? null,
								createdAt: row.createdAt.toISOString(),
								updatedAt: row.updatedAt.toISOString(),
								capabilities: libraryCapabilities(
									canManage &&
										(spaceId !== null || row.createdById === principal.id),
									principal.scopes,
								),
							})),
							requestId,
						};
					}),
					requestId,
				);
			})
			.handle("listSpaces", ({ path }) => {
				const requestId = makeRequestId();
				return withMappedErrors(
					Effect.gen(function* () {
						const principal = yield* Agent.AgentPrincipal;
						yield* requireScope(principal, "library:read", requestId);
						const management = yield* AgentManagement;
						const membership = yield* management.getMembership(
							principal.id,
							path.organizationId,
						);
						const rows = yield* management.listSpaces(
							principal.id,
							path.organizationId,
						);
						return {
							spaces: rows.map((row) => {
								const canManage =
									row.createdById === principal.id ||
									row.role === "admin" ||
									membership.role !== "member";
								return {
									id: row.id,
									name: row.name,
									description: row.description,
									organizationId: row.organizationId,
									createdById: row.createdById,
									primary: row.primary,
									privacy: row.privacy,
									public: row.public,
									protected: row.hasPassword,
									icon: row.icon,
									settings: agentViewerSettings(row.settings),
									publicPage: row.settings?.publicPage ?? null,
									role: row.role,
									counts: {
										members: row.memberCount,
										caps: row.capCount,
										folders: row.folderCount,
									},
									createdAt: row.createdAt.toISOString(),
									updatedAt: row.updatedAt.toISOString(),
									capabilities: libraryCapabilities(
										canManage,
										principal.scopes,
									),
								};
							}),
							requestId,
						};
					}),
					requestId,
				);
			})
			.handle("listSpaceMembers", ({ path }) => {
				const requestId = makeRequestId();
				return withMappedErrors(
					Effect.gen(function* () {
						const principal = yield* Agent.AgentPrincipal;
						yield* requireScope(principal, "library:read", requestId);
						const management = yield* AgentManagement;
						const access = yield* management.getSpaceAccess(
							principal.id,
							path.spaceId,
						);
						const rows = yield* management.listSpaceMembers(
							principal.id,
							path.spaceId,
						);
						const capability = libraryCapabilities(
							access.canManage,
							principal.scopes,
						).manageMembers;
						return {
							members: rows.map((row) => ({
								...row,
								createdAt: row.createdAt.toISOString(),
								updatedAt: row.updatedAt.toISOString(),
								capabilities: {
									update: capability,
									remove: {
										...capability,
										sideEffect: "destructive" as const,
									},
								},
							})),
							requestId,
						};
					}),
					requestId,
				);
			})
			.handle("listNotifications", ({ urlParams }) => {
				const requestId = makeRequestId();
				return withMappedErrors(
					Effect.gen(function* () {
						const principal = yield* Agent.AgentPrincipal;
						yield* requireScope(principal, "notifications:read", requestId);
						const limit = parseAgentLimit(urlParams.limit);
						if (limit === null) {
							return yield* badRequest(requestId, "limit must be positive");
						}
						const cursor = decodeNotificationCursor(urlParams.cursor);
						if (cursor === undefined) {
							return yield* badRequest(requestId, "cursor is invalid");
						}
						const management = yield* AgentManagement;
						const { rows, unreadCount } = yield* management.listNotifications(
							principal.id,
							limit,
							cursor,
							urlParams.unread === undefined
								? null
								: urlParams.unread === "true",
						);
						const page = rows.slice(0, limit);
						const last = page.at(-1);
						return {
							notifications: page.map((row) => ({
								id: row.id,
								organizationId: row.orgId,
								type: row.type,
								data: row.data,
								videoId: row.videoId,
								readAt: row.readAt?.toISOString() ?? null,
								createdAt: row.createdAt.toISOString(),
							})),
							nextCursor:
								rows.length > limit && last
									? encodeNotificationCursor({
											createdAt: last.createdAt,
											id: last.id,
										})
									: null,
							unreadCount,
							requestId,
						};
					}),
					requestId,
				);
			})
			.handle("getNotificationPreferences", () => {
				const requestId = makeRequestId();
				return withMappedErrors(
					Effect.gen(function* () {
						const principal = yield* Agent.AgentPrincipal;
						yield* requireScope(principal, "notifications:read", requestId);
						const management = yield* AgentManagement;
						const preferences = yield* management.getNotificationPreferences(
							principal.id,
						);
						return {
							pauseComments: preferences?.pauseComments ?? false,
							pauseReplies: preferences?.pauseReplies ?? false,
							pauseViews: preferences?.pauseViews ?? false,
							pauseReactions: preferences?.pauseReactions ?? false,
							pauseAnonymousViews: preferences?.pauseAnonViews ?? false,
							requestId,
						};
					}),
					requestId,
				);
			})
			.handle("getAnalytics", ({ urlParams }) => {
				const requestId = makeRequestId();
				return withMappedErrors(
					Effect.gen(function* () {
						const principal = yield* Agent.AgentPrincipal;
						yield* requireScope(principal, "analytics:read", requestId);
						const organizationId = Organisation.OrganisationId.make(
							urlParams.organizationId,
						);
						const spaceId = urlParams.spaceId
							? Space.SpaceId.make(urlParams.spaceId)
							: null;
						const capId = urlParams.capId
							? Video.VideoId.make(urlParams.capId)
							: null;
						const management = yield* AgentManagement;
						yield* management.assertAnalyticsAccess(
							principal.id,
							organizationId,
							spaceId,
							capId,
						);
						const range = urlParams.range ?? "month";
						const dashboardRange = {
							day: "24h",
							week: "7d",
							month: "30d",
							year: "lifetime",
						} as const;
						const data = yield* Effect.tryPromise(() =>
							getOrgAnalyticsData(
								organizationId,
								dashboardRange[range],
								spaceId ?? undefined,
								capId ?? undefined,
							),
						);
						return {
							organizationId,
							spaceId,
							capId,
							range,
							data,
							requestId,
						};
					}),
					requestId,
				);
			})
			.handle("getCapSettings", ({ path }) => {
				const requestId = makeRequestId();
				return withMappedErrors(
					Effect.gen(function* () {
						const principal = yield* Agent.AgentPrincipal;
						const { row, rules } = yield* getViewableCap(path.id);
						const canUpdate =
							row.ownerId === principal.id && hasScope(principal, "caps:write");
						return {
							id: path.id,
							overrides: agentViewerSettings(row.videoSettings),
							effective: {
								...agentViewerSettings(rules.settings),
								defaultPlaybackSpeed:
									row.videoSettings?.defaultPlaybackSpeed ??
									row.organizationSettings?.defaultPlaybackSpeed ??
									null,
							},
							inherited: rules.inheritedSettings,
							capabilities: {
								read: agentAction({ allowed: true }),
								update: agentAction({
									allowed: canUpdate,
									reason:
										row.ownerId !== principal.id
											? "OWNER_ONLY"
											: canUpdate
												? null
												: "SCOPE_REQUIRED",
									requiredScopes: ["caps:write"],
									confirmation: "user",
									sideEffect: "write",
								}),
							},
							requestId,
						};
					}),
					requestId,
				);
			})
			.handle("getCapShares", ({ path }) => {
				const requestId = makeRequestId();
				return withMappedErrors(
					Effect.gen(function* () {
						const principal = yield* Agent.AgentPrincipal;
						const { row, rules } = yield* getViewableCap(path.id);
						if (row.ownerId !== principal.id) {
							return yield* forbidden(
								requestId,
								"Only the Cap owner can inspect sharing targets",
							);
						}
						const database = yield* Database;
						const [organizations, spaces] = yield* database.use((db) =>
							Promise.all([
								db
									.select({
										organizationId: Db.sharedVideos.organizationId,
										organizationName: Db.organizations.name,
										folderId: Db.sharedVideos.folderId,
										sharedAt: Db.sharedVideos.sharedAt,
									})
									.from(Db.sharedVideos)
									.innerJoin(
										Db.organizations,
										eq(Db.sharedVideos.organizationId, Db.organizations.id),
									)
									.where(eq(Db.sharedVideos.videoId, path.id))
									.orderBy(Db.organizations.name, Db.sharedVideos.id),
								db
									.select({
										spaceId: Db.spaceVideos.spaceId,
										spaceName: Db.spaces.name,
										organizationId: Db.spaces.organizationId,
										folderId: Db.spaceVideos.folderId,
										addedAt: Db.spaceVideos.addedAt,
									})
									.from(Db.spaceVideos)
									.innerJoin(
										Db.spaces,
										eq(Db.spaceVideos.spaceId, Db.spaces.id),
									)
									.where(eq(Db.spaceVideos.videoId, path.id))
									.orderBy(Db.spaces.name, Db.spaceVideos.id),
							]),
						);
						const canUpdate = hasScope(principal, "caps:write");
						return {
							id: path.id,
							public: row.public,
							protected: row.hasPassword || rules.hasInheritedPassword,
							organizations: organizations.map((share) => ({
								...share,
								sharedAt: share.sharedAt.toISOString(),
							})),
							spaces: spaces.map((share) => ({
								...share,
								addedAt: share.addedAt.toISOString(),
							})),
							capabilities: {
								update: agentAction({
									allowed: canUpdate,
									reason: canUpdate ? null : "SCOPE_REQUIRED",
									requiredScopes: ["caps:write"],
									confirmation: "user",
									sideEffect: "write",
								}),
							},
							requestId,
						};
					}),
					requestId,
				);
			})
			.handle("listStorageIntegrations", ({ path }) => {
				const requestId = makeRequestId();
				return withMappedErrors(
					Effect.gen(function* () {
						const principal = yield* Agent.AgentPrincipal;
						yield* requireScope(principal, "integrations:read", requestId);
						const management = yield* AgentManagement;
						const membership = yield* management.getMembership(
							principal.id,
							path.organizationId,
						);
						const database = yield* Database;
						const rows = yield* management.listStorageIntegrations(
							principal.id,
							path.organizationId,
						);
						const s3Rows = yield* database.use((db) =>
							db
								.select({
									id: Db.s3Buckets.id,
									provider: Db.s3Buckets.provider,
									active: Db.s3Buckets.active,
									createdAt: Db.s3Buckets.createdAt,
									updatedAt: Db.s3Buckets.updatedAt,
								})
								.from(Db.s3Buckets)
								.where(
									and(
										eq(Db.s3Buckets.organizationId, path.organizationId),
										eq(Db.s3Buckets.active, true),
									),
								)
								.orderBy(desc(Db.s3Buckets.updatedAt))
								.limit(1),
						);
						const capabilities = integrationCapabilities(
							membership.role !== "member",
							principal.scopes,
						);
						return {
							integrations: [
								...rows,
								...s3Rows.map((row) => ({
									...row,
									displayName: "S3-compatible storage",
									status: "active",
								})),
							].map((row) => ({
								...row,
								createdAt: row.createdAt.toISOString(),
								updatedAt: row.updatedAt.toISOString(),
								capabilities,
							})),
							requestId,
						};
					}),
					requestId,
				);
			})
			.handle("listOrganizationGoogleDriveFolders", ({ path, urlParams }) => {
				const requestId = makeRequestId();
				return withMappedErrors(
					Effect.gen(function* () {
						const principal = yield* Agent.AgentPrincipal;
						yield* requireScope(principal, "integrations:read", requestId);
						const management = yield* AgentManagement;
						yield* management.requireOrganizationManager(
							principal.id,
							path.organizationId,
						);
						const database = yield* Database;
						const [account] = yield* database.use((db) =>
							db
								.select({
									stripeSubscriptionStatus: Db.users.stripeSubscriptionStatus,
									thirdPartyStripeSubscriptionId:
										Db.users.thirdPartyStripeSubscriptionId,
								})
								.from(Db.users)
								.where(eq(Db.users.id, principal.id))
								.limit(1),
						);
						if (!account || !userIsPro(account)) {
							return yield* forbidden(
								requestId,
								"Cap Pro is required to manage storage integrations",
							);
						}
						const drive = yield* getAgentOrganizationDrive(path.organizationId);
						if (!drive || drive.status !== "active") {
							return yield* notReady(
								requestId,
								"Google Drive is not connected",
							);
						}
						const config = yield* parseAgentDriveConfig(drive.encryptedConfig);
						const accessToken = yield* getGoogleDriveAccessToken(config);
						const parentId = urlParams.parentId?.trim() || "root";
						const escapedParentId = parentId
							.replace(/\\/g, "\\\\")
							.replace(/'/g, "\\'");
						const url = new URL("https://www.googleapis.com/drive/v3/files");
						url.searchParams.set(
							"q",
							`'${escapedParentId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`,
						);
						url.searchParams.set("fields", "files(id,name,driveId)");
						url.searchParams.set("spaces", "drive");
						url.searchParams.set("supportsAllDrives", "true");
						url.searchParams.set("includeItemsFromAllDrives", "true");
						if (config.driveId) {
							url.searchParams.set("corpora", "drive");
							url.searchParams.set("driveId", config.driveId);
						}
						const body = yield* Effect.tryPromise(async () => {
							const response = await fetch(url, {
								headers: { Authorization: `Bearer ${accessToken}` },
							});
							if (!response.ok) {
								throw new Error(
									`Google Drive returned HTTP ${response.status}`,
								);
							}
							return (await response.json()) as {
								files?: Array<{
									id?: string;
									name?: string;
									driveId?: string | null;
								}>;
							};
						});
						return {
							folders:
								body.files?.flatMap((folder) =>
									folder.id && folder.name
										? [
												{
													id: folder.id,
													name: folder.name,
													driveId: folder.driveId ?? null,
													driveName: null,
												},
											]
										: [],
								) ?? [],
							requestId,
						};
					}),
					requestId,
				);
			})
			.handle("getOrganizationBilling", ({ path }) => {
				const requestId = makeRequestId();
				return withMappedErrors(
					Effect.gen(function* () {
						const principal = yield* Agent.AgentPrincipal;
						yield* requireScope(principal, "billing:read", requestId);
						const management = yield* AgentManagement;
						const billing = yield* management.getBilling(
							principal.id,
							path.organizationId,
						);
						const organization = normalizeOrganization(
							billing.organization,
							principal.scopes,
						);
						return {
							organizationId: path.organizationId,
							plan: organization.billing.plan,
							status: organization.billing.status,
							managedExternally:
								billing.organization.ownerThirdPartySubscriptionId !== null,
							seats: {
								total: billing.totalSeats,
								assigned: billing.assignedSeats,
							},
							capabilities: organizationCapabilities(
								billing.membership.role,
								principal.scopes,
							),
							requestId,
						};
					}),
					requestId,
				);
			})
			.handle("listDeveloperApps", () => {
				const requestId = makeRequestId();
				return withMappedErrors(
					Effect.gen(function* () {
						const principal = yield* Agent.AgentPrincipal;
						yield* requireScope(principal, "developer:read", requestId);
						const management = yield* AgentManagement;
						const rows = yield* management.listDeveloperApps(principal.id);
						const capabilities = developerCapabilities(principal.scopes);
						return {
							apps: rows.map((row) => ({
								...row,
								createdAt: row.createdAt.toISOString(),
								updatedAt: row.updatedAt.toISOString(),
								capabilities,
							})),
							requestId,
						};
					}),
					requestId,
				);
			})
			.handle("getDeveloperAppContext", ({ path }) => {
				const requestId = makeRequestId();
				return withMappedErrors(
					Effect.gen(function* () {
						const principal = yield* Agent.AgentPrincipal;
						yield* requireScope(principal, "developer:read", requestId);
						const management = yield* AgentManagement;
						const context = yield* management.getDeveloperAppContext(
							principal.id,
							path.appId,
						);
						return {
							app: {
								...context.app,
								createdAt: context.app.createdAt.toISOString(),
								updatedAt: context.app.updatedAt.toISOString(),
								capabilities: developerCapabilities(principal.scopes),
							},
							domains: context.domains.map((domain) => ({
								...domain,
								createdAt: domain.createdAt.toISOString(),
							})),
							keys: context.keys.map((key) => ({
								...key,
								lastUsedAt: key.lastUsedAt?.toISOString() ?? null,
								revokedAt: key.revokedAt?.toISOString() ?? null,
								createdAt: key.createdAt.toISOString(),
							})),
							usage: {
								videoCount: context.videoCount,
								storageMinutes: context.storageMinutes,
							},
							credits: context.credits,
							requestId,
						};
					}),
					requestId,
				);
			})
			.handle("listDeveloperVideos", ({ path, urlParams }) => {
				const requestId = makeRequestId();
				return withMappedErrors(
					Effect.gen(function* () {
						const principal = yield* Agent.AgentPrincipal;
						yield* requireScope(principal, "developer:read", requestId);
						const limit = parseAgentLimit(urlParams.limit);
						const decodedCursor = decodeAgentCursor(urlParams.cursor);
						if (limit === null || decodedCursor === undefined) {
							return yield* badRequest(requestId, "Pagination is invalid");
						}
						const cursor = decodedCursor
							? {
									createdAt: new Date(decodedCursor.updatedAt),
									id: decodedCursor.id,
								}
							: null;
						const externalUserId = urlParams.userId?.trim() || null;
						if ((externalUserId?.length ?? 0) > 255) {
							return yield* badRequest(requestId, "User ID is too long");
						}
						const management = yield* AgentManagement;
						const rows = yield* management.listDeveloperVideos(
							principal.id,
							path.appId,
							limit,
							cursor,
							externalUserId,
						);
						const hasMore = rows.length > limit;
						const page = rows.slice(0, limit);
						const next = hasMore ? page.at(-1) : undefined;
						const capabilities = developerCapabilities(principal.scopes);
						return {
							videos: page.map((video) => ({
								id: video.id,
								appId: video.appId,
								externalUserId: video.externalUserId,
								name: video.name,
								durationSeconds: video.duration,
								width: video.width,
								height: video.height,
								fps: video.fps,
								transcriptionStatus: video.transcriptionStatus,
								createdAt: video.createdAt.toISOString(),
								updatedAt: video.updatedAt.toISOString(),
								capabilities,
							})),
							nextCursor: next
								? encodeAgentCursor({
										updatedAt: next.createdAt.toISOString(),
										id: next.id,
									})
								: null,
							requestId,
						};
					}),
					requestId,
				);
			})
			.handle("listDeveloperTransactions", ({ path, urlParams }) => {
				const requestId = makeRequestId();
				return withMappedErrors(
					Effect.gen(function* () {
						const principal = yield* Agent.AgentPrincipal;
						yield* requireScope(principal, "developer:read", requestId);
						const limit = parseAgentLimit(urlParams.limit);
						const decodedCursor = decodeAgentCursor(urlParams.cursor);
						if (limit === null || decodedCursor === undefined) {
							return yield* badRequest(requestId, "Pagination is invalid");
						}
						const cursor = decodedCursor
							? {
									createdAt: new Date(decodedCursor.updatedAt),
									id: decodedCursor.id,
								}
							: null;
						const management = yield* AgentManagement;
						const rows = yield* management.listDeveloperTransactions(
							principal.id,
							path.appId,
							limit,
							cursor,
						);
						const hasMore = rows.length > limit;
						const page = rows.slice(0, limit);
						const next = hasMore ? page.at(-1) : undefined;
						return {
							transactions: page.map((transaction) => ({
								...transaction,
								referenceId: transaction.referenceId ?? null,
								referenceType: transaction.referenceType ?? null,
								createdAt: transaction.createdAt.toISOString(),
							})),
							nextCursor: next
								? encodeAgentCursor({
										updatedAt: next.createdAt.toISOString(),
										id: next.id,
									})
								: null,
							requestId,
						};
					}),
					requestId,
				);
			})
			.handle("createDeveloperApp", ({ payload }) => {
				const requestId = makeRequestId();
				return withMappedErrors(
					Effect.gen(function* () {
						yield* requireAgentWrites(requestId);
						yield* requireUserConfirmedRequest(requestId);
						const principal = yield* Agent.AgentPrincipal;
						yield* requireScope(principal, "developer:write", requestId);
						yield* requireScope(principal, "developer:secrets", requestId);
						const name = payload.name.trim();
						if (name.length === 0 || name.length > 255) {
							return yield* badRequest(
								requestId,
								"Developer app name is invalid",
							);
						}
						const result = yield* runAgentMutation({
							principal,
							operation: "create_developer_app",
							idempotencyKey: yield* requestIdempotencyKey,
							request: { name, environment: payload.environment },
							requestId,
							decodeReplay: Schema.decodeUnknownSync(
								DeveloperKeyOperationResult,
							),
							execute: async (tx) => {
								const appId = nanoId();
								const publicKeyId = nanoId();
								const secretKeyId = nanoId();
								const publicKeyRaw = `cpk_${nanoIdLong()}`;
								const secretKeyRaw = `csk_${nanoIdLong()}`;
								const [
									publicKeyHash,
									secretKeyHash,
									encryptedPublicKey,
									encryptedSecretKey,
								] = await Promise.all([
									hashKey(publicKeyRaw),
									hashKey(secretKeyRaw),
									encrypt(publicKeyRaw),
									encrypt(secretKeyRaw),
								]);
								await tx.insert(Db.developerApps).values({
									id: appId,
									ownerId: principal.id,
									name,
									environment: payload.environment,
								});
								await tx.insert(Db.developerApiKeys).values([
									{
										id: publicKeyId,
										appId,
										keyType: "public",
										keyPrefix: publicKeyRaw.slice(0, 12),
										keyHash: publicKeyHash,
										encryptedKey: encryptedPublicKey,
									},
									{
										id: secretKeyId,
										appId,
										keyType: "secret",
										keyPrefix: secretKeyRaw.slice(0, 12),
										keyHash: secretKeyHash,
										encryptedKey: encryptedSecretKey,
									},
								]);
								await tx.insert(Db.developerCreditAccounts).values({
									id: nanoId(),
									appId,
									ownerId: principal.id,
								});
								return {
									state: "success",
									response: { appId, publicKeyId, secretKeyId },
								};
							},
						});
						return yield* readDeveloperCredentials(
							principal,
							result,
							requestId,
						);
					}),
					requestId,
				);
			})
			.handle("updateDeveloperApp", ({ path, payload }) => {
				const requestId = makeRequestId();
				return withMappedErrors(
					Effect.gen(function* () {
						yield* requireAgentWrites(requestId);
						const principal = yield* Agent.AgentPrincipal;
						yield* requireScope(principal, "developer:write", requestId);
						if (Object.values(payload).every((value) => value === undefined)) {
							return yield* badRequest(
								requestId,
								"At least one developer app field is required",
							);
						}
						const name = payload.name?.trim();
						const logoUrl =
							payload.logoUrl === null ? null : payload.logoUrl?.trim();
						if (
							(name !== undefined &&
								(name.length === 0 || name.length > 255)) ||
							(logoUrl !== undefined &&
								logoUrl !== null &&
								(logoUrl.length > 1024 || !isAgentHttpUrl(logoUrl)))
						) {
							return yield* badRequest(
								requestId,
								"Developer app fields are invalid",
							);
						}
						return yield* runAgentMutation({
							principal,
							operation: "update_developer_app",
							idempotencyKey: yield* requestIdempotencyKey,
							request: { path, ...payload, name, logoUrl },
							requestId,
							decodeReplay: decodeMutationResponse,
							execute: async (tx) => {
								const [app] = await tx
									.select({ id: Db.developerApps.id })
									.from(Db.developerApps)
									.where(
										and(
											eq(Db.developerApps.id, path.appId),
											eq(Db.developerApps.ownerId, principal.id),
											isNull(Db.developerApps.deletedAt),
										),
									)
									.limit(1)
									.for("update");
								if (!app) return { state: "not_found" };
								const now = new Date();
								await tx
									.update(Db.developerApps)
									.set({
										name,
										environment: payload.environment,
										logoUrl,
										updatedAt: now,
									})
									.where(eq(Db.developerApps.id, path.appId));
								return {
									state: "success",
									response: mutationResponse(
										"developer_app",
										path.appId,
										"updated",
										requestId,
										now,
									),
								};
							},
						});
					}),
					requestId,
				);
			})
			.handle("deleteDeveloperApp", ({ path }) => {
				const requestId = makeRequestId();
				return withMappedErrors(
					Effect.gen(function* () {
						yield* requireAgentWrites(requestId);
						yield* requireUserConfirmedRequest(requestId);
						const principal = yield* Agent.AgentPrincipal;
						yield* requireScope(principal, "developer:write", requestId);
						return yield* runAgentMutation({
							principal,
							operation: "delete_developer_app",
							idempotencyKey: yield* requestIdempotencyKey,
							request: path,
							requestId,
							decodeReplay: decodeMutationResponse,
							execute: async (tx) => {
								const [app] = await tx
									.select({ id: Db.developerApps.id })
									.from(Db.developerApps)
									.where(
										and(
											eq(Db.developerApps.id, path.appId),
											eq(Db.developerApps.ownerId, principal.id),
											isNull(Db.developerApps.deletedAt),
										),
									)
									.limit(1)
									.for("update");
								if (!app) return { state: "not_found" };
								const now = new Date();
								await tx
									.update(Db.developerApiKeys)
									.set({ revokedAt: now })
									.where(
										and(
											eq(Db.developerApiKeys.appId, path.appId),
											isNull(Db.developerApiKeys.revokedAt),
										),
									);
								await tx
									.update(Db.developerApps)
									.set({ deletedAt: now, updatedAt: now })
									.where(eq(Db.developerApps.id, path.appId));
								return {
									state: "success",
									response: mutationResponse(
										"developer_app",
										path.appId,
										"deleted",
										requestId,
										now,
									),
								};
							},
						});
					}),
					requestId,
				);
			})
			.handle("addDeveloperDomain", ({ path, payload }) => {
				const requestId = makeRequestId();
				return withMappedErrors(
					Effect.gen(function* () {
						yield* requireAgentWrites(requestId);
						const principal = yield* Agent.AgentPrincipal;
						yield* requireScope(principal, "developer:write", requestId);
						const domain = payload.domain.trim().toLowerCase();
						if (!/^https?:\/\/[a-z0-9.-]+(:[0-9]+)?$/.test(domain)) {
							return yield* badRequest(
								requestId,
								"Domain must be a valid HTTP or HTTPS origin",
							);
						}
						return yield* runAgentMutation({
							principal,
							operation: "add_developer_domain",
							idempotencyKey: yield* requestIdempotencyKey,
							request: { path, domain },
							requestId,
							decodeReplay: decodeMutationResponse,
							execute: async (tx) => {
								const [app] = await tx
									.select({ id: Db.developerApps.id })
									.from(Db.developerApps)
									.where(
										and(
											eq(Db.developerApps.id, path.appId),
											eq(Db.developerApps.ownerId, principal.id),
											isNull(Db.developerApps.deletedAt),
										),
									)
									.limit(1)
									.for("update");
								if (!app) return { state: "not_found" };
								const id = deterministicAgentId(
									"developer_domain",
									path.appId,
									domain,
								);
								await tx
									.insert(Db.developerAppDomains)
									.values({ id, appId: path.appId, domain })
									.onDuplicateKeyUpdate({
										set: { domain: sql`${Db.developerAppDomains.domain}` },
									});
								return {
									state: "success",
									response: mutationResponse(
										"developer_domain",
										id,
										"created",
										requestId,
									),
								};
							},
						});
					}),
					requestId,
				);
			})
			.handle("removeDeveloperDomain", ({ path }) => {
				const requestId = makeRequestId();
				return withMappedErrors(
					Effect.gen(function* () {
						yield* requireAgentWrites(requestId);
						const principal = yield* Agent.AgentPrincipal;
						yield* requireScope(principal, "developer:write", requestId);
						return yield* runAgentMutation({
							principal,
							operation: "remove_developer_domain",
							idempotencyKey: yield* requestIdempotencyKey,
							request: path,
							requestId,
							decodeReplay: decodeMutationResponse,
							execute: async (tx) => {
								const [app] = await tx
									.select({ id: Db.developerApps.id })
									.from(Db.developerApps)
									.where(
										and(
											eq(Db.developerApps.id, path.appId),
											eq(Db.developerApps.ownerId, principal.id),
											isNull(Db.developerApps.deletedAt),
										),
									)
									.limit(1);
								if (!app) return { state: "not_found" };
								const result = await tx
									.delete(Db.developerAppDomains)
									.where(
										and(
											eq(Db.developerAppDomains.id, path.domainId),
											eq(Db.developerAppDomains.appId, path.appId),
										),
									);
								if (affectedRows(result) === 0) return { state: "not_found" };
								return {
									state: "success",
									response: mutationResponse(
										"developer_domain",
										path.domainId,
										"deleted",
										requestId,
									),
								};
							},
						});
					}),
					requestId,
				);
			})
			.handle("rotateDeveloperKeys", ({ path }) => {
				const requestId = makeRequestId();
				return withMappedErrors(
					Effect.gen(function* () {
						yield* requireAgentWrites(requestId);
						yield* requireUserConfirmedRequest(requestId);
						const principal = yield* Agent.AgentPrincipal;
						yield* requireScope(principal, "developer:secrets", requestId);
						const result = yield* runAgentMutation({
							principal,
							operation: "rotate_developer_keys",
							idempotencyKey: yield* requestIdempotencyKey,
							request: path,
							requestId,
							decodeReplay: Schema.decodeUnknownSync(
								DeveloperKeyOperationResult,
							),
							execute: async (tx) => {
								const [app] = await tx
									.select({ id: Db.developerApps.id })
									.from(Db.developerApps)
									.where(
										and(
											eq(Db.developerApps.id, path.appId),
											eq(Db.developerApps.ownerId, principal.id),
											isNull(Db.developerApps.deletedAt),
										),
									)
									.limit(1)
									.for("update");
								if (!app) return { state: "not_found" };
								const publicKeyId = nanoId();
								const secretKeyId = nanoId();
								const publicKeyRaw = `cpk_${nanoIdLong()}`;
								const secretKeyRaw = `csk_${nanoIdLong()}`;
								const [
									publicKeyHash,
									secretKeyHash,
									encryptedPublicKey,
									encryptedSecretKey,
								] = await Promise.all([
									hashKey(publicKeyRaw),
									hashKey(secretKeyRaw),
									encrypt(publicKeyRaw),
									encrypt(secretKeyRaw),
								]);
								const now = new Date();
								await tx
									.update(Db.developerApiKeys)
									.set({ revokedAt: now })
									.where(
										and(
											eq(Db.developerApiKeys.appId, path.appId),
											isNull(Db.developerApiKeys.revokedAt),
										),
									);
								await tx.insert(Db.developerApiKeys).values([
									{
										id: publicKeyId,
										appId: path.appId,
										keyType: "public",
										keyPrefix: publicKeyRaw.slice(0, 12),
										keyHash: publicKeyHash,
										encryptedKey: encryptedPublicKey,
									},
									{
										id: secretKeyId,
										appId: path.appId,
										keyType: "secret",
										keyPrefix: secretKeyRaw.slice(0, 12),
										keyHash: secretKeyHash,
										encryptedKey: encryptedSecretKey,
									},
								]);
								return {
									state: "success",
									response: {
										appId: path.appId,
										publicKeyId,
										secretKeyId,
									},
								};
							},
						});
						return yield* readDeveloperCredentials(
							principal,
							result,
							requestId,
						);
					}),
					requestId,
				);
			})
			.handle("updateDeveloperAutoTopUp", ({ path, payload }) => {
				const requestId = makeRequestId();
				return withMappedErrors(
					Effect.gen(function* () {
						yield* requireAgentWrites(requestId);
						yield* requireUserConfirmedRequest(requestId);
						const principal = yield* Agent.AgentPrincipal;
						yield* requireScope(principal, "developer:write", requestId);
						yield* requireScope(principal, "billing:write", requestId);
						if (
							(payload.thresholdMicroCredits !== undefined &&
								(!Number.isSafeInteger(payload.thresholdMicroCredits) ||
									payload.thresholdMicroCredits < 0)) ||
							(payload.amountCents !== undefined &&
								(!Number.isSafeInteger(payload.amountCents) ||
									payload.amountCents <= 0 ||
									payload.amountCents > 100_000))
						) {
							return yield* badRequest(
								requestId,
								"Auto top-up values are invalid",
							);
						}
						return yield* runAgentMutation({
							principal,
							operation: "update_developer_auto_top_up",
							idempotencyKey: yield* requestIdempotencyKey,
							request: { path, payload },
							requestId,
							decodeReplay: decodeMutationResponse,
							execute: async (tx) => {
								const [app] = await tx
									.select({ id: Db.developerApps.id })
									.from(Db.developerApps)
									.where(
										and(
											eq(Db.developerApps.id, path.appId),
											eq(Db.developerApps.ownerId, principal.id),
											isNull(Db.developerApps.deletedAt),
										),
									)
									.limit(1);
								if (!app) return { state: "not_found" };
								const now = new Date();
								const result = await tx
									.update(Db.developerCreditAccounts)
									.set({
										autoTopUpEnabled: payload.enabled,
										autoTopUpThresholdMicroCredits:
											payload.thresholdMicroCredits,
										autoTopUpAmountCents: payload.amountCents,
										updatedAt: now,
									})
									.where(eq(Db.developerCreditAccounts.appId, path.appId));
								if (affectedRows(result) === 0) return { state: "not_found" };
								return {
									state: "success",
									response: mutationResponse(
										"developer_auto_top_up",
										path.appId,
										payload.enabled ? "enabled" : "disabled",
										requestId,
										now,
									),
								};
							},
						});
					}),
					requestId,
				);
			})
			.handle("createDeveloperCreditsCheckout", ({ path, payload }) => {
				const requestId = makeRequestId();
				return withMappedErrors(
					Effect.gen(function* () {
						yield* requireAgentWrites(requestId);
						yield* requireUserConfirmedRequest(requestId);
						const principal = yield* Agent.AgentPrincipal;
						yield* requireScope(principal, "developer:write", requestId);
						yield* requireScope(principal, "billing:write", requestId);
						if (
							!Number.isSafeInteger(payload.amountCents) ||
							payload.amountCents < 500 ||
							payload.amountCents > 100_000
						) {
							return yield* badRequest(
								requestId,
								"Developer credit purchase must be between $5 and $1,000",
							);
						}
						return yield* runAgentExternalMutation({
							principal,
							operation: "create_developer_credits_checkout",
							idempotencyKey: yield* requestIdempotencyKey,
							request: { path, amountCents: payload.amountCents },
							requestId,
							decodeReplay: decodeBrowserActionResponse,
							execute: (providerIdempotencyKey) =>
								Effect.gen(function* () {
									const database = yield* Database;
									const [account] = yield* database.use((db) =>
										db
											.select({
												id: Db.developerCreditAccounts.id,
											})
											.from(Db.developerApps)
											.innerJoin(
												Db.developerCreditAccounts,
												eq(
													Db.developerCreditAccounts.appId,
													Db.developerApps.id,
												),
											)
											.where(
												and(
													eq(Db.developerApps.id, path.appId),
													eq(Db.developerApps.ownerId, principal.id),
													isNull(Db.developerApps.deletedAt),
												),
											)
											.limit(1),
									);
									if (!account) return yield* notFound(requestId);
									const customerId = yield* ensureAgentStripeCustomer(
										principal,
										providerIdempotencyKey,
										requestId,
									);
									yield* database.use((db) =>
										db
											.update(Db.developerCreditAccounts)
											.set({ stripeCustomerId: customerId })
											.where(eq(Db.developerCreditAccounts.id, account.id)),
									);
									const session = yield* Effect.tryPromise(() =>
										stripe().checkout.sessions.create(
											{
												customer: customerId,
												line_items: [
													{
														price_data: {
															currency: "usd",
															product:
																STRIPE_DEVELOPER_CREDITS_PRODUCT_ID[
																	buildEnv.NEXT_PUBLIC_IS_CAP
																		? "production"
																		: "development"
																],
															unit_amount: payload.amountCents,
														},
														quantity: 1,
													},
												],
												mode: "payment",
												success_url: `${serverEnv().WEB_URL}/cli/complete?developerCredits=success`,
												cancel_url: `${serverEnv().WEB_URL}/cli/complete?developerCredits=cancelled`,
												metadata: {
													type: "developer_credits",
													appId: path.appId,
													accountId: account.id,
													amountCents: String(payload.amountCents),
													userId: principal.id,
												},
											},
											{
												idempotencyKey: `${providerIdempotencyKey}:checkout`,
											},
										),
									);
									if (!session.url) {
										return yield* temporarilyUnavailable(
											requestId,
											"Developer credits checkout is unavailable",
										);
									}
									return {
										action: "developer_credits_checkout",
										url: session.url,
										requestId,
									};
								}),
						});
					}),
					requestId,
				);
			})
			.handle("deleteDeveloperVideo", ({ path }) => {
				const requestId = makeRequestId();
				return withMappedErrors(
					Effect.gen(function* () {
						yield* requireAgentWrites(requestId);
						yield* requireUserConfirmedRequest(requestId);
						const principal = yield* Agent.AgentPrincipal;
						yield* requireScope(principal, "developer:write", requestId);
						return yield* runAgentMutation({
							principal,
							operation: "delete_developer_video",
							idempotencyKey: yield* requestIdempotencyKey,
							request: path,
							requestId,
							decodeReplay: decodeMutationResponse,
							execute: async (tx) => {
								const [video] = await tx
									.select({ id: Db.developerVideos.id })
									.from(Db.developerVideos)
									.innerJoin(
										Db.developerApps,
										eq(Db.developerVideos.appId, Db.developerApps.id),
									)
									.where(
										and(
											eq(Db.developerVideos.id, path.videoId),
											eq(Db.developerVideos.appId, path.appId),
											eq(Db.developerApps.ownerId, principal.id),
											isNull(Db.developerApps.deletedAt),
											isNull(Db.developerVideos.deletedAt),
										),
									)
									.limit(1)
									.for("update");
								if (!video) return { state: "not_found" };
								const now = new Date();
								await tx
									.update(Db.developerVideos)
									.set({ deletedAt: now, updatedAt: now })
									.where(eq(Db.developerVideos.id, path.videoId));
								return {
									state: "success",
									response: mutationResponse(
										"developer_video",
										path.videoId,
										"deleted",
										requestId,
										now,
									),
								};
							},
						});
					}),
					requestId,
				);
			})
			.handle("createSubscriptionCheckout", ({ path, payload }) => {
				const requestId = makeRequestId();
				return withMappedErrors(
					Effect.gen(function* () {
						yield* requireAgentWrites(requestId);
						yield* requireUserConfirmedRequest(requestId);
						const principal = yield* Agent.AgentPrincipal;
						yield* requireScope(principal, "billing:write", requestId);
						const management = yield* AgentManagement;
						const membership = yield* management.getMembership(
							principal.id,
							path.organizationId,
						);
						if (membership.role !== "owner") {
							return yield* forbidden(
								requestId,
								"Only the organization owner can manage billing",
							);
						}
						const database = yield* Database;
						const [account] = yield* database.use((db) =>
							db
								.select({
									stripeSubscriptionStatus: Db.users.stripeSubscriptionStatus,
									thirdPartyStripeSubscriptionId:
										Db.users.thirdPartyStripeSubscriptionId,
								})
								.from(Db.users)
								.where(eq(Db.users.id, principal.id))
								.limit(1),
						);
						const [members] = yield* database.use((db) =>
							db
								.select({
									memberCount: sql<number>`COUNT(*)`.mapWith(Number),
								})
								.from(Db.organizationMembers)
								.where(
									eq(
										Db.organizationMembers.organizationId,
										path.organizationId,
									),
								),
						);
						if (!account) return yield* notFound(requestId);
						if (userIsPro(account)) {
							return yield* badRequest(
								requestId,
								"The organization owner already has Cap Pro",
							);
						}
						const quantity =
							payload.quantity ?? Math.max(1, members?.memberCount ?? 1);
						if (
							!Number.isSafeInteger(quantity) ||
							quantity < 1 ||
							quantity > 1_000
						) {
							return yield* badRequest(
								requestId,
								"Subscription quantity must be between 1 and 1,000",
							);
						}
						return yield* runAgentExternalMutation({
							principal,
							operation: "create_subscription_checkout",
							idempotencyKey: yield* requestIdempotencyKey,
							request: { path, interval: payload.interval, quantity },
							requestId,
							decodeReplay: decodeBrowserActionResponse,
							execute: (providerIdempotencyKey) =>
								Effect.gen(function* () {
									const customerId = yield* ensureAgentStripeCustomer(
										principal,
										providerIdempotencyKey,
										requestId,
									);
									const environment =
										serverEnv().VERCEL_ENV === "production"
											? "production"
											: "development";
									const session = yield* Effect.tryPromise(() =>
										stripe().checkout.sessions.create(
											{
												customer: customerId,
												line_items: [
													{
														price:
															STRIPE_PLAN_IDS[environment][payload.interval],
														quantity,
													},
												],
												mode: "subscription",
												success_url: `${serverEnv().WEB_URL}/cli/complete?subscription=success`,
												cancel_url: `${serverEnv().WEB_URL}/cli/complete?subscription=cancelled`,
												allow_promotion_codes: true,
												metadata: {
													platform: "agent",
													organizationId: path.organizationId,
													userId: principal.id,
												},
											},
											{
												idempotencyKey: `${providerIdempotencyKey}:checkout`,
											},
										),
									);
									if (!session.url) {
										return yield* temporarilyUnavailable(
											requestId,
											"Subscription checkout is unavailable",
										);
									}
									return {
										action: "subscription_checkout",
										url: session.url,
										requestId,
									};
								}),
						});
					}),
					requestId,
				);
			})
			.handle("createBillingPortal", ({ path }) => {
				const requestId = makeRequestId();
				return withMappedErrors(
					Effect.gen(function* () {
						yield* requireAgentWrites(requestId);
						yield* requireUserConfirmedRequest(requestId);
						const principal = yield* Agent.AgentPrincipal;
						yield* requireScope(principal, "billing:write", requestId);
						const management = yield* AgentManagement;
						const membership = yield* management.getMembership(
							principal.id,
							path.organizationId,
						);
						if (membership.role !== "owner") {
							return yield* forbidden(
								requestId,
								"Only the organization owner can manage billing",
							);
						}
						const database = yield* Database;
						const [account] = yield* database.use((db) =>
							db
								.select({
									thirdPartyStripeSubscriptionId:
										Db.users.thirdPartyStripeSubscriptionId,
								})
								.from(Db.users)
								.where(eq(Db.users.id, principal.id))
								.limit(1),
						);
						if (!account) return yield* notFound(requestId);
						if (account.thirdPartyStripeSubscriptionId) {
							return yield* badRequest(
								requestId,
								"This subscription is managed by an external provider",
							);
						}
						return yield* runAgentExternalMutation({
							principal,
							operation: "create_billing_portal",
							idempotencyKey: yield* requestIdempotencyKey,
							request: path,
							requestId,
							decodeReplay: decodeBrowserActionResponse,
							execute: (providerIdempotencyKey) =>
								Effect.gen(function* () {
									const customerId = yield* ensureAgentStripeCustomer(
										principal,
										providerIdempotencyKey,
										requestId,
									);
									const session = yield* Effect.tryPromise(() =>
										stripe().billingPortal.sessions.create(
											{
												customer: customerId,
												return_url: `${serverEnv().WEB_URL}/cli/complete?billing=updated`,
											},
											{
												idempotencyKey: `${providerIdempotencyKey}:portal`,
											},
										),
									);
									return {
										action: "billing_portal",
										url: session.url,
										requestId,
									};
								}),
						});
					}),
					requestId,
				);
			})
			.handle("deleteOrganization", ({ path }) => {
				const requestId = makeRequestId();
				return withMappedErrors(
					queueAgentOrganizationDelete(path.organizationId, requestId),
					requestId,
				);
			})
			.handle("setOrganizationDomain", ({ path, payload }) => {
				const requestId = makeRequestId();
				const domain = payload.domain.trim().toLowerCase();
				if (
					!/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(
						domain,
					)
				) {
					return withMappedErrors(
						Effect.fail(badRequest(requestId, "Custom domain is invalid")),
						requestId,
					);
				}
				return withMappedErrors(
					queueAgentOrganizationDomain({
						organizationId: path.organizationId,
						kind: "set_organization_domain",
						domain,
						requestId,
					}),
					requestId,
				);
			})
			.handle("removeOrganizationDomain", ({ path }) => {
				const requestId = makeRequestId();
				return withMappedErrors(
					queueAgentOrganizationDomain({
						organizationId: path.organizationId,
						kind: "remove_organization_domain",
						requestId,
					}),
					requestId,
				);
			})
			.handle("verifyOrganizationDomain", ({ path }) => {
				const requestId = makeRequestId();
				return withMappedErrors(
					queueAgentOrganizationDomain({
						organizationId: path.organizationId,
						kind: "verify_organization_domain",
						requestId,
					}),
					requestId,
				);
			})
			.handle("getOperation", ({ path }) => {
				const requestId = makeRequestId();
				return withMappedErrors(
					getAgentOperation(path.operationId, requestId),
					requestId,
				);
			})
			.handle("updateOrganization", ({ path, payload }) => {
				const requestId = makeRequestId();
				return withMappedErrors(
					Effect.gen(function* () {
						yield* requireAgentWrites(requestId);
						const principal = yield* Agent.AgentPrincipal;
						yield* requireScope(principal, "organizations:manage", requestId);
						const management = yield* AgentManagement;
						yield* management.requireOrganizationManager(
							principal.id,
							path.organizationId,
						);
						if (
							payload.name === undefined &&
							payload.allowedEmailDomain === undefined
						) {
							return yield* badRequest(
								requestId,
								"At least one organization field is required",
							);
						}
						const name = payload.name?.trim();
						const allowedEmailDomain =
							payload.allowedEmailDomain?.trim().toLowerCase() || null;
						if (
							(name !== undefined &&
								(name.length === 0 || name.length > 255)) ||
							(allowedEmailDomain !== null &&
								(allowedEmailDomain.length > 255 ||
									!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(allowedEmailDomain)))
						) {
							return yield* badRequest(
								requestId,
								"Organization fields are invalid",
							);
						}
						return yield* runAgentMutation({
							principal,
							operation: "update_organization",
							idempotencyKey: yield* requestIdempotencyKey,
							request: { path, name, allowedEmailDomain },
							requestId,
							decodeReplay: decodeMutationResponse,
							execute: async (tx) => {
								const [organization] = await tx
									.select({ id: Db.organizations.id })
									.from(Db.organizations)
									.where(eq(Db.organizations.id, path.organizationId))
									.limit(1)
									.for("update");
								if (!organization) return { state: "not_found" };
								const now = new Date();
								await tx
									.update(Db.organizations)
									.set({
										name,
										allowedEmailDomain:
											payload.allowedEmailDomain === undefined
												? undefined
												: allowedEmailDomain,
										updatedAt: now,
									})
									.where(eq(Db.organizations.id, path.organizationId));
								return {
									state: "success",
									response: mutationResponse(
										"organization",
										path.organizationId,
										"updated",
										requestId,
										now,
									),
								};
							},
						});
					}),
					requestId,
				);
			})
			.handle("updateOrganizationSettings", ({ path, payload }) => {
				const requestId = makeRequestId();
				return withMappedErrors(
					Effect.gen(function* () {
						yield* requireAgentWrites(requestId);
						const principal = yield* Agent.AgentPrincipal;
						yield* requireScope(principal, "organizations:manage", requestId);
						if (Object.values(payload).every((value) => value === undefined)) {
							return yield* badRequest(
								requestId,
								"At least one organization setting is required",
							);
						}
						const management = yield* AgentManagement;
						yield* management.requireOrganizationManager(
							principal.id,
							path.organizationId,
						);
						const sanitizedPayload =
							payload.defaultPlaybackSpeed === undefined
								? payload
								: {
										...payload,
										defaultPlaybackSpeed: normalizePlaybackSpeed(
											payload.defaultPlaybackSpeed,
										),
									};
						return yield* runAgentMutation({
							principal,
							operation: "update_organization_settings",
							idempotencyKey: yield* requestIdempotencyKey,
							request: { path, payload: sanitizedPayload },
							requestId,
							decodeReplay: decodeMutationResponse,
							execute: async (tx) => {
								const [[organization], [account]] = await Promise.all([
									tx
										.select({ settings: Db.organizations.settings })
										.from(Db.organizations)
										.where(
											and(
												eq(Db.organizations.id, path.organizationId),
												isNull(Db.organizations.tombstoneAt),
											),
										)
										.limit(1)
										.for("update"),
									tx
										.select({
											stripeSubscriptionStatus:
												Db.users.stripeSubscriptionStatus,
											thirdPartyStripeSubscriptionId:
												Db.users.thirdPartyStripeSubscriptionId,
										})
										.from(Db.users)
										.where(eq(Db.users.id, principal.id))
										.limit(1),
								]);
								if (!organization || !account) return { state: "not_found" };
								const current = organization.settings ?? {};
								const submitted = { ...current, ...sanitizedPayload };
								const next = userIsPro(account)
									? submitted
									: {
											...submitted,
											disableSummary:
												current.disableSummary ??
												defaultProOrganizationSettings.disableSummary,
											disableChapters:
												current.disableChapters ??
												defaultProOrganizationSettings.disableChapters,
											disableTranscript:
												current.disableTranscript ??
												defaultProOrganizationSettings.disableTranscript,
											hideShareableLinkCapLogo:
												current.hideShareableLinkCapLogo ??
												defaultProOrganizationSettings.hideShareableLinkCapLogo,
											shareableLinkUseOrganizationIcon:
												current.shareableLinkUseOrganizationIcon ??
												defaultProOrganizationSettings.shareableLinkUseOrganizationIcon,
											aiGenerationLanguage:
												current.aiGenerationLanguage ??
												defaultProOrganizationSettings.aiGenerationLanguage,
										};
								const now = new Date();
								await tx
									.update(Db.organizations)
									.set({ settings: next, updatedAt: now })
									.where(eq(Db.organizations.id, path.organizationId));
								return {
									state: "success",
									response: mutationResponse(
										"organization_settings",
										path.organizationId,
										"updated",
										requestId,
										now,
									),
								};
							},
						});
					}),
					requestId,
				);
			})
			.handle("createOrganizationInvite", ({ path, payload }) => {
				const requestId = makeRequestId();
				return withMappedErrors(
					Effect.gen(function* () {
						yield* requireAgentWrites(requestId);
						const principal = yield* Agent.AgentPrincipal;
						yield* requireScope(principal, "organizations:members", requestId);
						const management = yield* AgentManagement;
						const actor = yield* management.requireOrganizationManager(
							principal.id,
							path.organizationId,
						);
						const email = payload.email.trim().toLowerCase();
						const role = payload.role ?? "member";
						const shouldSendEmail = payload.sendEmail ?? true;
						if (
							email.length > 255 ||
							!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
						) {
							return yield* badRequest(requestId, "Invite email is invalid");
						}
						const idempotencyKey = yield* requestIdempotencyKey;
						const invitation = yield* runAgentMutation({
							principal,
							operation: "create_organization_invite",
							idempotencyKey,
							request: { path, email, role, sendEmail: shouldSendEmail },
							requestId,
							decodeReplay: Schema.decodeUnknownSync(
								Agent.AgentOrganizationInviteResponse,
							),
							execute: async (tx) => {
								const [member] = await tx
									.select({ id: Db.organizationMembers.id })
									.from(Db.organizationMembers)
									.innerJoin(
										Db.users,
										eq(Db.organizationMembers.userId, Db.users.id),
									)
									.where(
										and(
											eq(
												Db.organizationMembers.organizationId,
												path.organizationId,
											),
											sql`LOWER(${Db.users.email}) = ${email}`,
										),
									)
									.limit(1);
								if (member) return { state: "conflict" };
								const [existing] = await tx
									.select()
									.from(Db.organizationInvites)
									.where(
										and(
											eq(
												Db.organizationInvites.organizationId,
												path.organizationId,
											),
											sql`LOWER(TRIM(${Db.organizationInvites.invitedEmail})) = ${email}`,
										),
									)
									.orderBy(Db.organizationInvites.createdAt)
									.limit(1)
									.for("update");
								const now = new Date();
								const id =
									existing?.id ??
									deterministicAgentId(
										"organization_invite",
										path.organizationId,
										email,
									);
								if (existing) {
									await tx
										.update(Db.organizationInvites)
										.set({ role, status: "pending", updatedAt: now })
										.where(eq(Db.organizationInvites.id, existing.id));
								} else {
									await tx.insert(Db.organizationInvites).values({
										id,
										organizationId: path.organizationId,
										invitedEmail: email,
										invitedByUserId: principal.id,
										role,
										createdAt: now,
										updatedAt: now,
									});
								}
								return {
									state: "success",
									response: {
										invite: {
											id,
											invitedEmail: email,
											role,
											status: "pending",
											expiresAt: existing?.expiresAt?.toISOString() ?? null,
											createdAt:
												existing?.createdAt.toISOString() ?? now.toISOString(),
											updatedAt: now.toISOString(),
											capabilities: organizationCapabilities(
												actor.role,
												principal.scopes,
											),
										},
										inviteUrl: `${serverEnv().WEB_URL}/invite/${id}`,
										emailDelivery: "not_requested" as const,
										requestId,
									},
								};
							},
						});
						if (!shouldSendEmail) return invitation;
						const database = yield* Database;
						const [organization] = yield* database.use((db) =>
							db
								.select({ name: Db.organizations.name })
								.from(Db.organizations)
								.where(
									and(
										eq(Db.organizations.id, path.organizationId),
										isNull(Db.organizations.tombstoneAt),
									),
								)
								.limit(1),
						);
						if (!organization) return yield* notFound(requestId);
						return yield* runAgentExternalMutation({
							principal,
							operation: "send_organization_invite_email",
							idempotencyKey,
							request: {
								organizationId: path.organizationId,
								inviteId: invitation.invite.id,
								email,
							},
							requestId,
							decodeReplay: Schema.decodeUnknownSync(
								Agent.AgentOrganizationInviteResponse,
							),
							execute: (providerIdempotencyKey) =>
								Effect.tryPromise({
									try: async () => {
										const delivery = await sendEmail({
											email,
											subject: `Invitation to join ${organization.name} on Cap`,
											react: OrganizationInvite({
												email,
												url: invitation.inviteUrl,
												organizationName: organization.name,
											}),
											idempotencyKey: providerIdempotencyKey,
										});
										if (delivery?.error)
											throw new Error(delivery.error.message);
										return {
											...invitation,
											emailDelivery: "accepted" as const,
										};
									},
									catch: () =>
										temporarilyUnavailable(
											requestId,
											"The organization invite email could not be delivered",
										),
								}),
						});
					}),
					requestId,
				);
			})
			.handle("deleteOrganizationInvite", ({ path }) => {
				const requestId = makeRequestId();
				return withMappedErrors(
					Effect.gen(function* () {
						yield* requireAgentWrites(requestId);
						const principal = yield* Agent.AgentPrincipal;
						yield* requireScope(principal, "organizations:members", requestId);
						const management = yield* AgentManagement;
						yield* management.requireOrganizationManager(
							principal.id,
							path.organizationId,
						);
						return yield* runAgentMutation({
							principal,
							operation: "delete_organization_invite",
							idempotencyKey: yield* requestIdempotencyKey,
							request: path,
							requestId,
							decodeReplay: decodeMutationResponse,
							execute: async (tx) => {
								const result = await tx
									.delete(Db.organizationInvites)
									.where(
										and(
											eq(Db.organizationInvites.id, path.inviteId),
											eq(
												Db.organizationInvites.organizationId,
												path.organizationId,
											),
										),
									);
								if (affectedRows(result) === 0) return { state: "not_found" };
								const now = new Date();
								return {
									state: "success",
									response: mutationResponse(
										"organization_invite",
										path.inviteId,
										"deleted",
										requestId,
										now,
									),
								};
							},
						});
					}),
					requestId,
				);
			})
			.handle("updateOrganizationMember", ({ path, payload }) => {
				const requestId = makeRequestId();
				return withMappedErrors(
					Effect.gen(function* () {
						yield* requireAgentWrites(requestId);
						const principal = yield* Agent.AgentPrincipal;
						yield* requireScope(principal, "organizations:members", requestId);
						const management = yield* AgentManagement;
						const actor = yield* management.requireOrganizationManager(
							principal.id,
							path.organizationId,
						);
						return yield* runAgentMutation({
							principal,
							operation: "update_organization_member",
							idempotencyKey: yield* requestIdempotencyKey,
							request: { path, role: payload.role },
							requestId,
							decodeReplay: decodeMutationResponse,
							execute: async (tx) => {
								const [organization] = await tx
									.select({ ownerId: Db.organizations.ownerId })
									.from(Db.organizations)
									.where(
										and(
											eq(Db.organizations.id, path.organizationId),
											isNull(Db.organizations.tombstoneAt),
										),
									)
									.limit(1)
									.for("update");
								const [member] = await tx
									.select({
										userId: Db.organizationMembers.userId,
										role: Db.organizationMembers.role,
									})
									.from(Db.organizationMembers)
									.where(
										and(
											eq(Db.organizationMembers.id, path.memberId),
											eq(
												Db.organizationMembers.organizationId,
												path.organizationId,
											),
										),
									)
									.limit(1)
									.for("update");
								if (!organization || !member) return { state: "not_found" };
								const targetRole = getEffectiveOrganizationRole({
									userId: member.userId,
									ownerId: organization.ownerId,
									memberRole: member.role,
								});
								if (
									!canChangeOrganizationMemberRole({
										actorRole: actor.role,
										actorUserId: principal.id,
										targetUserId: member.userId,
										ownerId: organization.ownerId,
										targetRole,
										nextRole: payload.role,
									})
								) {
									return { state: "forbidden" };
								}
								const now = new Date();
								await tx
									.update(Db.organizationMembers)
									.set({ role: payload.role, updatedAt: now })
									.where(eq(Db.organizationMembers.id, path.memberId));
								return {
									state: "success",
									response: mutationResponse(
										"organization_member",
										path.memberId,
										"updated",
										requestId,
										now,
									),
								};
							},
						});
					}),
					requestId,
				);
			})
			.handle("updateOrganizationMemberSeat", ({ path, payload }) => {
				const requestId = makeRequestId();
				return withMappedErrors(
					Effect.gen(function* () {
						yield* requireAgentWrites(requestId);
						const principal = yield* Agent.AgentPrincipal;
						yield* requireScope(principal, "organizations:members", requestId);
						const management = yield* AgentManagement;
						yield* management.requireOrganizationManager(
							principal.id,
							path.organizationId,
						);
						return yield* runAgentMutation({
							principal,
							operation: "update_organization_member_seat",
							idempotencyKey: yield* requestIdempotencyKey,
							request: { path, enabled: payload.enabled },
							requestId,
							decodeReplay: decodeMutationResponse,
							execute: async (tx) => {
								const [organization] = await tx
									.select({ ownerId: Db.organizations.ownerId })
									.from(Db.organizations)
									.where(
										and(
											eq(Db.organizations.id, path.organizationId),
											isNull(Db.organizations.tombstoneAt),
										),
									)
									.limit(1)
									.for("update");
								const [member] = await tx
									.select()
									.from(Db.organizationMembers)
									.where(
										and(
											eq(Db.organizationMembers.id, path.memberId),
											eq(
												Db.organizationMembers.organizationId,
												path.organizationId,
											),
										),
									)
									.limit(1)
									.for("update");
								if (!organization || !member) return { state: "not_found" };
								if (member.userId === organization.ownerId) {
									return { state: "forbidden" };
								}
								if (member.hasProSeat === payload.enabled) {
									return {
										state: "success",
										response: mutationResponse(
											"organization_member_seat",
											path.memberId,
											payload.enabled ? "enabled" : "disabled",
											requestId,
										),
									};
								}
								if (payload.enabled) {
									const allMembers = await tx
										.select({
											id: Db.organizationMembers.id,
											userId: Db.organizationMembers.userId,
											hasProSeat: Db.organizationMembers.hasProSeat,
										})
										.from(Db.organizationMembers)
										.where(
											eq(
												Db.organizationMembers.organizationId,
												path.organizationId,
											),
										)
										.for("update");
									const managerIds = Array.from(
										new Set([organization.ownerId, principal.id]),
									);
									const managers = await tx
										.select({
											id: Db.users.id,
											inviteQuota: Db.users.inviteQuota,
											stripeSubscriptionId: Db.users.stripeSubscriptionId,
											stripeSubscriptionStatus:
												Db.users.stripeSubscriptionStatus,
										})
										.from(Db.users)
										.where(inArray(Db.users.id, managerIds));
									const owner = managers.find(
										(manager) => manager.id === organization.ownerId,
									);
									const currentManager = managers.find(
										(manager) => manager.id === principal.id,
									);
									const seatProvider = selectProSeatProvider({
										actor: currentManager,
										owner,
										actorCanManageProSeats: true,
									});
									if (!seatProvider) return { state: "conflict" };
									const { proSeatsRemaining } = calculateProSeats({
										inviteQuota: seatProvider.inviteQuota ?? 1,
										ownerId: organization.ownerId,
										ownerIsPro: hasActiveDirectSubscription(owner),
										members: allMembers,
									});
									if (proSeatsRemaining <= 0) return { state: "conflict" };
									await tx
										.update(Db.organizationMembers)
										.set({ hasProSeat: true })
										.where(eq(Db.organizationMembers.id, path.memberId));
									if (seatProvider.stripeSubscriptionId) {
										await tx
											.update(Db.users)
											.set({
												thirdPartyStripeSubscriptionId:
													seatProvider.stripeSubscriptionId,
											})
											.where(eq(Db.users.id, member.userId));
									}
								} else {
									await tx
										.update(Db.organizationMembers)
										.set({ hasProSeat: false })
										.where(eq(Db.organizationMembers.id, path.memberId));
									const otherProSeats = await tx
										.select({ id: Db.organizationMembers.id })
										.from(Db.organizationMembers)
										.where(
											and(
												eq(Db.organizationMembers.userId, member.userId),
												eq(Db.organizationMembers.hasProSeat, true),
											),
										)
										.limit(1);
									if (otherProSeats.length === 0) {
										await tx
											.update(Db.users)
											.set({ thirdPartyStripeSubscriptionId: null })
											.where(eq(Db.users.id, member.userId));
									} else {
										const [remainingOrganization] = await tx
											.select({
												stripeSubscriptionId: Db.users.stripeSubscriptionId,
											})
											.from(Db.organizationMembers)
											.innerJoin(
												Db.organizations,
												eq(
													Db.organizationMembers.organizationId,
													Db.organizations.id,
												),
											)
											.innerJoin(
												Db.users,
												eq(Db.organizations.ownerId, Db.users.id),
											)
											.where(
												and(
													eq(Db.organizationMembers.userId, member.userId),
													eq(Db.organizationMembers.hasProSeat, true),
												),
											)
											.limit(1);
										await tx
											.update(Db.users)
											.set({
												thirdPartyStripeSubscriptionId:
													remainingOrganization?.stripeSubscriptionId ?? null,
											})
											.where(eq(Db.users.id, member.userId));
									}
								}
								const now = new Date();
								return {
									state: "success",
									response: mutationResponse(
										"organization_member_seat",
										path.memberId,
										payload.enabled ? "enabled" : "disabled",
										requestId,
										now,
									),
								};
							},
						});
					}),
					requestId,
				);
			})
			.handle("removeOrganizationMember", ({ path }) => {
				const requestId = makeRequestId();
				return withMappedErrors(
					Effect.gen(function* () {
						yield* requireAgentWrites(requestId);
						const principal = yield* Agent.AgentPrincipal;
						yield* requireScope(principal, "organizations:members", requestId);
						const management = yield* AgentManagement;
						const actor = yield* management.requireOrganizationManager(
							principal.id,
							path.organizationId,
						);
						return yield* runAgentMutation({
							principal,
							operation: "remove_organization_member",
							idempotencyKey: yield* requestIdempotencyKey,
							request: path,
							requestId,
							decodeReplay: decodeMutationResponse,
							execute: async (tx) => {
								const [organization] = await tx
									.select({ ownerId: Db.organizations.ownerId })
									.from(Db.organizations)
									.where(
										and(
											eq(Db.organizations.id, path.organizationId),
											isNull(Db.organizations.tombstoneAt),
										),
									)
									.limit(1)
									.for("update");
								const [member] = await tx
									.select({
										userId: Db.organizationMembers.userId,
										role: Db.organizationMembers.role,
										email: Db.users.email,
									})
									.from(Db.organizationMembers)
									.innerJoin(
										Db.users,
										eq(Db.organizationMembers.userId, Db.users.id),
									)
									.where(
										and(
											eq(Db.organizationMembers.id, path.memberId),
											eq(
												Db.organizationMembers.organizationId,
												path.organizationId,
											),
										),
									)
									.limit(1)
									.for("update");
								if (!organization || !member) return { state: "not_found" };
								const targetRole = getEffectiveOrganizationRole({
									userId: member.userId,
									ownerId: organization.ownerId,
									memberRole: member.role,
								});
								if (
									!canRemoveOrganizationMember({
										actorRole: actor.role,
										actorUserId: principal.id,
										targetUserId: member.userId,
										ownerId: organization.ownerId,
										targetRole,
									})
								) {
									return { state: "forbidden" };
								}
								const organizationSpaces = await tx
									.select({ id: Db.spaces.id })
									.from(Db.spaces)
									.where(eq(Db.spaces.organizationId, path.organizationId));
								const spaceIds = organizationSpaces.map((space) => space.id);
								if (spaceIds.length > 0) {
									await tx
										.delete(Db.spaceMembers)
										.where(
											and(
												eq(Db.spaceMembers.userId, member.userId),
												inArray(Db.spaceMembers.spaceId, spaceIds),
											),
										);
								}
								await tx
									.delete(Db.organizationInvites)
									.where(
										and(
											eq(
												Db.organizationInvites.organizationId,
												path.organizationId,
											),
											sql`LOWER(TRIM(${Db.organizationInvites.invitedEmail})) = ${member.email.toLowerCase()}`,
										),
									);
								const result = await tx
									.delete(Db.organizationMembers)
									.where(
										and(
											eq(Db.organizationMembers.id, path.memberId),
											eq(
												Db.organizationMembers.organizationId,
												path.organizationId,
											),
										),
									);
								if (affectedRows(result) === 0) return { state: "not_found" };
								const now = new Date();
								return {
									state: "success",
									response: mutationResponse(
										"organization_member",
										path.memberId,
										"deleted",
										requestId,
										now,
									),
								};
							},
						});
					}),
					requestId,
				);
			})
			.handle("updateMe", ({ payload }) => {
				const requestId = makeRequestId();
				return withMappedErrors(
					Effect.gen(function* () {
						yield* requireAgentWrites(requestId);
						const principal = yield* Agent.AgentPrincipal;
						yield* requireScope(principal, "profile:write", requestId);
						if (
							payload.name === undefined &&
							payload.lastName === undefined &&
							payload.defaultOrganizationId === undefined
						) {
							return yield* badRequest(
								requestId,
								"At least one profile field is required",
							);
						}
						const name = payload.name?.trim() || null;
						const lastName = payload.lastName?.trim() || null;
						if ((name?.length ?? 0) > 255 || (lastName?.length ?? 0) > 255) {
							return yield* badRequest(requestId, "Profile names are too long");
						}
						const response = yield* runAgentMutation({
							principal,
							operation: "update_profile",
							idempotencyKey: yield* requestIdempotencyKey,
							request: {
								name,
								lastName,
								defaultOrganizationId: payload.defaultOrganizationId,
							},
							requestId,
							decodeReplay: Schema.decodeUnknownSync(Agent.AgentMeResponse),
							execute: async (tx) => {
								if (payload.defaultOrganizationId) {
									const [membership] = await tx
										.select({ id: Db.organizationMembers.id })
										.from(Db.organizationMembers)
										.where(
											and(
												eq(Db.organizationMembers.userId, principal.id),
												eq(
													Db.organizationMembers.organizationId,
													payload.defaultOrganizationId,
												),
											),
										)
										.limit(1);
									if (!membership) return { state: "forbidden" };
								}
								await tx
									.update(Db.users)
									.set({
										name: payload.name === undefined ? undefined : name,
										lastName:
											payload.lastName === undefined ? undefined : lastName,
										defaultOrgId: payload.defaultOrganizationId,
									})
									.where(eq(Db.users.id, principal.id));
								const [account] = await tx
									.select({
										id: Db.users.id,
										email: Db.users.email,
										name: Db.users.name,
										lastName: Db.users.lastName,
										image: Db.users.image,
										activeOrganizationId: Db.users.activeOrganizationId,
										defaultOrganizationId: Db.users.defaultOrgId,
										createdAt: Db.users.created_at,
									})
									.from(Db.users)
									.where(eq(Db.users.id, principal.id))
									.limit(1);
								if (!account) return { state: "not_found" };
								return {
									state: "success",
									response: {
										...account,
										image: account.image ?? null,
										activeOrganizationId: account.activeOrganizationId ?? null,
										defaultOrganizationId:
											account.defaultOrganizationId ?? null,
										createdAt: account.createdAt.toISOString(),
										capabilities: profileCapabilities(principal.scopes),
										requestId,
									},
								};
							},
						});
						return response;
					}),
					requestId,
				);
			})
			.handle("updateProfileImage", ({ payload }) => {
				const requestId = makeRequestId();
				return withMappedErrors(
					updateAgentImage({
						target: { type: "profile" },
						payload,
						requestId,
					}),
					requestId,
				);
			})
			.handle("removeProfileImage", () => {
				const requestId = makeRequestId();
				return withMappedErrors(
					updateAgentImage({
						target: { type: "profile" },
						payload: null,
						requestId,
					}),
					requestId,
				);
			})
			.handle("signOutAllDevices", () => {
				const requestId = makeRequestId();
				return withMappedErrors(
					Effect.gen(function* () {
						yield* requireAgentWrites(requestId);
						yield* requireUserConfirmedRequest(requestId);
						const principal = yield* Agent.AgentPrincipal;
						yield* requireScope(principal, "profile:write", requestId);
						return yield* runAgentMutation({
							principal,
							operation: "sign_out_all_devices",
							idempotencyKey: yield* requestIdempotencyKey,
							request: { userId: principal.id },
							requestId,
							decodeReplay: decodeMutationResponse,
							execute: async (tx) => {
								const [account] = await tx
									.select({ id: Db.users.id })
									.from(Db.users)
									.where(eq(Db.users.id, principal.id))
									.limit(1)
									.for("update");
								if (!account) return { state: "not_found" };
								await tx
									.update(Db.users)
									.set({
										authSessionVersion: sql`${Db.users.authSessionVersion} + 1`,
									})
									.where(eq(Db.users.id, principal.id));
								await tx
									.delete(Db.sessions)
									.where(eq(Db.sessions.userId, principal.id));
								await tx
									.delete(Db.authApiKeys)
									.where(eq(Db.authApiKeys.userId, principal.id));
								await tx
									.update(Db.agentApiKeys)
									.set({ revokedAt: new Date() })
									.where(
										and(
											eq(Db.agentApiKeys.userId, principal.id),
											isNull(Db.agentApiKeys.revokedAt),
										),
									);
								return {
									state: "success",
									response: mutationResponse(
										"account_sessions",
										principal.id,
										"revoked",
										requestId,
										new Date(),
									),
								};
							},
						});
					}),
					requestId,
				);
			})
			.handle("openReferralPortal", () => {
				const requestId = makeRequestId();
				return withMappedErrors(
					Effect.gen(function* () {
						yield* requireAgentWrites(requestId);
						yield* requireUserConfirmedRequest(requestId);
						const principal = yield* Agent.AgentPrincipal;
						yield* requireScope(principal, "profile:read", requestId);
						const apiKey = serverEnv().DUB_API_KEY;
						if (!apiKey) {
							return yield* forbidden(
								requestId,
								"Cap referrals are not available on this server",
							);
						}
						const database = yield* Database;
						const [account] = yield* database.use((db) =>
							db
								.select({ name: Db.users.name, image: Db.users.image })
								.from(Db.users)
								.where(eq(Db.users.id, principal.id))
								.limit(1),
						);
						if (!account) return yield* notFound(requestId);
						return yield* runAgentExternalMutation({
							principal,
							operation: "open_referral_portal",
							idempotencyKey: yield* requestIdempotencyKey,
							request: { userId: principal.id },
							requestId,
							decodeReplay: Schema.decodeUnknownSync(
								Agent.AgentBrowserActionResponse,
							),
							execute: () =>
								Effect.tryPromise({
									try: async () => {
										const response = await fetch(
											"https://api.dub.co/tokens/embed/referrals",
											{
												method: "POST",
												headers: {
													Authorization: `Bearer ${apiKey}`,
													"Content-Type": "application/json",
												},
												body: JSON.stringify({
													tenantId: principal.id,
													partner: {
														name: account.name ?? principal.email,
														email: principal.email,
														image: account.image ?? undefined,
														tenantId: principal.id,
													},
												}),
											},
										);
										if (!response.ok) throw new Error("Dub request failed");
										const data: unknown = await response.json();
										if (!data || typeof data !== "object") {
											throw new Error("Dub response is invalid");
										}
										const token =
											("publicToken" in data &&
												typeof data.publicToken === "string" &&
												data.publicToken) ||
											("token" in data &&
												typeof data.token === "string" &&
												data.token);
										if (!token) throw new Error("Dub token is missing");
										return {
											action: "open_referrals",
											url: `https://app.dub.co/embed/referrals?token=${encodeURIComponent(token)}`,
											requestId,
										};
									},
									catch: () =>
										temporarilyUnavailable(
											requestId,
											"The referral portal could not be opened",
										),
								}),
						});
					}),
					requestId,
				);
			})
			.handle("createOrganization", ({ payload }) => {
				const requestId = makeRequestId();
				return withMappedErrors(
					Effect.gen(function* () {
						yield* requireAgentWrites(requestId);
						yield* requireUserConfirmedRequest(requestId);
						const principal = yield* Agent.AgentPrincipal;
						yield* requireScope(principal, "organizations:manage", requestId);
						const name = payload.name.trim();
						if (name.length === 0 || name.length > 255) {
							return yield* badRequest(
								requestId,
								"Organization name is invalid",
							);
						}
						const idempotencyKey = yield* requestIdempotencyKey;
						const organizationId = Organisation.OrganisationId.make(
							deterministicAgentId(
								"organization",
								principal.id,
								idempotencyKey,
							),
						);
						return yield* runAgentMutation({
							principal,
							operation: "create_organization",
							idempotencyKey,
							request: { name },
							requestId,
							decodeReplay: decodeMutationResponse,
							execute: async (tx) => {
								const [existingName] = await tx
									.select({ id: Db.organizations.id })
									.from(Db.organizations)
									.where(
										and(
											sql`LOWER(${Db.organizations.name}) = ${name.toLowerCase()}`,
											isNull(Db.organizations.tombstoneAt),
										),
									)
									.limit(1);
								if (existingName && existingName.id !== organizationId) {
									return { state: "conflict" };
								}
								await tx
									.insert(Db.organizations)
									.values({
										id: organizationId,
										ownerId: principal.id,
										name,
									})
									.onDuplicateKeyUpdate({
										set: { id: sql`${Db.organizations.id}` },
									});
								const [organization] = await tx
									.select({
										ownerId: Db.organizations.ownerId,
										name: Db.organizations.name,
										tombstoneAt: Db.organizations.tombstoneAt,
									})
									.from(Db.organizations)
									.where(eq(Db.organizations.id, organizationId))
									.limit(1)
									.for("update");
								if (
									!organization ||
									organization.ownerId !== principal.id ||
									organization.name !== name ||
									organization.tombstoneAt !== null
								) {
									return { state: "conflict" };
								}
								await tx
									.insert(Db.organizationMembers)
									.values({
										id: deterministicAgentId(
											"organization_member",
											organizationId,
											principal.id,
										),
										userId: principal.id,
										organizationId,
										role: "owner",
									})
									.onDuplicateKeyUpdate({
										set: { id: sql`${Db.organizationMembers.id}` },
									});
								await tx
									.update(Db.users)
									.set({ activeOrganizationId: organizationId })
									.where(eq(Db.users.id, principal.id));
								return {
									state: "success",
									response: mutationResponse(
										"organization",
										organizationId,
										"created",
										requestId,
										new Date(),
									),
								};
							},
						});
					}),
					requestId,
				);
			})
			.handle("updateOrganizationIcon", ({ path, payload }) => {
				const requestId = makeRequestId();
				return withMappedErrors(
					updateAgentImage({
						target: {
							type: "organization",
							organizationId: path.organizationId,
							image: "icon",
						},
						payload,
						requestId,
					}),
					requestId,
				);
			})
			.handle("removeOrganizationIcon", ({ path }) => {
				const requestId = makeRequestId();
				return withMappedErrors(
					updateAgentImage({
						target: {
							type: "organization",
							organizationId: path.organizationId,
							image: "icon",
						},
						payload: null,
						requestId,
					}),
					requestId,
				);
			})
			.handle("updateShareableLinkIcon", ({ path, payload }) => {
				const requestId = makeRequestId();
				return withMappedErrors(
					updateAgentImage({
						target: {
							type: "organization",
							organizationId: path.organizationId,
							image: "shareableLinkIcon",
						},
						payload,
						requestId,
					}),
					requestId,
				);
			})
			.handle("removeShareableLinkIcon", ({ path }) => {
				const requestId = makeRequestId();
				return withMappedErrors(
					updateAgentImage({
						target: {
							type: "organization",
							organizationId: path.organizationId,
							image: "shareableLinkIcon",
						},
						payload: null,
						requestId,
					}),
					requestId,
				);
			})
			.handle("updateOrganizationS3", ({ path, payload }) => {
				const requestId = makeRequestId();
				return withMappedErrors(
					Effect.gen(function* () {
						yield* requireAgentWrites(requestId);
						yield* requireUserConfirmedRequest(requestId);
						const principal = yield* Agent.AgentPrincipal;
						yield* requireAgentStorageManager(
							principal,
							path.organizationId,
							"integrations:write",
							requestId,
						);
						const config = yield* resolveAgentS3Config(
							path.organizationId,
							payload,
							requestId,
						);
						return yield* runAgentExternalMutation({
							principal,
							operation: "update_organization_s3",
							idempotencyKey: yield* requestIdempotencyKey,
							request: {
								path,
								provider: config.provider,
								endpoint: config.endpoint,
								bucketName: config.bucketName,
								region: config.region,
								accessKeyIdHash: createHash("sha256")
									.update(config.accessKeyId)
									.digest("hex"),
								secretAccessKeyHash: createHash("sha256")
									.update(config.secretAccessKey)
									.digest("hex"),
							},
							requestId,
							decodeReplay: decodeMutationResponse,
							execute: () =>
								Effect.gen(function* () {
									yield* testAgentS3Config(config, requestId);
									const database = yield* Database;
									const encrypted = yield* Effect.tryPromise(async () => {
										const [
											accessKeyId,
											secretAccessKey,
											endpoint,
											bucketName,
											region,
										] = await Promise.all([
											encrypt(config.accessKeyId),
											encrypt(config.secretAccessKey),
											config.endpoint ? encrypt(config.endpoint) : null,
											encrypt(config.bucketName),
											encrypt(config.region),
										]);
										return {
											accessKeyId,
											secretAccessKey,
											endpoint,
											bucketName,
											region,
										};
									});
									const id = S3Bucket.S3BucketId.make(nanoId());
									yield* database.use((db) =>
										db.transaction(async (tx) => {
											await tx
												.update(Db.s3Buckets)
												.set({ active: false })
												.where(
													eq(Db.s3Buckets.organizationId, path.organizationId),
												);
											await tx.insert(Db.s3Buckets).values({
												id,
												ownerId: principal.id,
												organizationId: path.organizationId,
												provider: config.provider,
												...encrypted,
												active: true,
											});
										}),
									);
									return mutationResponse(
										"storage_s3",
										id,
										"configured",
										requestId,
										new Date(),
									);
								}),
						});
					}),
					requestId,
				);
			})
			.handle("testOrganizationS3", ({ path, payload }) => {
				const requestId = makeRequestId();
				return withMappedErrors(
					Effect.gen(function* () {
						yield* requireAgentWrites(requestId);
						yield* requireUserConfirmedRequest(requestId);
						const principal = yield* Agent.AgentPrincipal;
						yield* requireAgentStorageManager(
							principal,
							path.organizationId,
							"integrations:write",
							requestId,
						);
						const config = yield* resolveAgentS3Config(
							path.organizationId,
							payload,
							requestId,
						);
						return yield* runAgentExternalMutation({
							principal,
							operation: "test_organization_s3",
							idempotencyKey: yield* requestIdempotencyKey,
							request: {
								path,
								endpoint: config.endpoint,
								bucketName: config.bucketName,
								region: config.region,
								credentialHash: createHash("sha256")
									.update(`${config.accessKeyId}\0${config.secretAccessKey}`)
									.digest("hex"),
							},
							requestId,
							decodeReplay: decodeMutationResponse,
							execute: () =>
								testAgentS3Config(config, requestId).pipe(
									Effect.as(
										mutationResponse(
											"storage_s3",
											path.organizationId,
											"verified",
											requestId,
											new Date(),
										),
									),
								),
						});
					}),
					requestId,
				);
			})
			.handle("removeOrganizationS3", ({ path }) => {
				const requestId = makeRequestId();
				return withMappedErrors(
					Effect.gen(function* () {
						yield* requireAgentWrites(requestId);
						yield* requireUserConfirmedRequest(requestId);
						const principal = yield* Agent.AgentPrincipal;
						yield* requireAgentStorageManager(
							principal,
							path.organizationId,
							"integrations:write",
							requestId,
						);
						return yield* runAgentMutation({
							principal,
							operation: "remove_organization_s3",
							idempotencyKey: yield* requestIdempotencyKey,
							request: path,
							requestId,
							decodeReplay: decodeMutationResponse,
							execute: async (tx) => {
								const [bucket] = await tx
									.select({ id: Db.s3Buckets.id })
									.from(Db.s3Buckets)
									.where(
										and(
											eq(Db.s3Buckets.organizationId, path.organizationId),
											eq(Db.s3Buckets.active, true),
										),
									)
									.orderBy(desc(Db.s3Buckets.updatedAt))
									.limit(1)
									.for("update");
								if (!bucket) return { state: "not_found" };
								const now = new Date();
								await tx
									.update(Db.s3Buckets)
									.set({ active: false, updatedAt: now })
									.where(eq(Db.s3Buckets.id, bucket.id));
								return {
									state: "success",
									response: mutationResponse(
										"storage_s3",
										bucket.id,
										"disconnected",
										requestId,
										now,
									),
								};
							},
						});
					}),
					requestId,
				);
			})
			.handle("connectOrganizationGoogleDrive", ({ path }) => {
				const requestId = makeRequestId();
				return withMappedErrors(
					Effect.gen(function* () {
						yield* requireAgentWrites(requestId);
						yield* requireUserConfirmedRequest(requestId);
						const principal = yield* Agent.AgentPrincipal;
						yield* requireAgentStorageManager(
							principal,
							path.organizationId,
							"integrations:write",
							requestId,
						);
						return yield* runAgentExternalMutation({
							principal,
							operation: "connect_organization_google_drive",
							idempotencyKey: yield* requestIdempotencyKey,
							request: path,
							requestId,
							decodeReplay: decodeBrowserActionResponse,
							execute: () =>
								Effect.try({
									try: () => ({
										action: "google_drive_connect",
										url: getGoogleDriveAuthUrl({
											state: createAgentGoogleDriveState(
												principal.id,
												path.organizationId,
											),
										}),
										requestId,
									}),
									catch: () =>
										temporarilyUnavailable(
											requestId,
											"Google Drive authorization is unavailable",
										),
								}),
						});
					}),
					requestId,
				);
			})
			.handle("disconnectOrganizationGoogleDrive", ({ path }) => {
				const requestId = makeRequestId();
				return withMappedErrors(
					Effect.gen(function* () {
						yield* requireAgentWrites(requestId);
						yield* requireUserConfirmedRequest(requestId);
						const principal = yield* Agent.AgentPrincipal;
						yield* requireAgentStorageManager(
							principal,
							path.organizationId,
							"integrations:write",
							requestId,
						);
						return yield* runAgentMutation({
							principal,
							operation: "disconnect_organization_google_drive",
							idempotencyKey: yield* requestIdempotencyKey,
							request: path,
							requestId,
							decodeReplay: decodeMutationResponse,
							execute: async (tx) => {
								const [drive] = await tx
									.select({ id: Db.storageIntegrations.id })
									.from(Db.storageIntegrations)
									.where(
										and(
											eq(
												Db.storageIntegrations.organizationId,
												path.organizationId,
											),
											eq(Db.storageIntegrations.provider, googleDriveProvider),
										),
									)
									.orderBy(desc(Db.storageIntegrations.updatedAt))
									.limit(1)
									.for("update");
								if (!drive) return { state: "not_found" };
								const now = new Date();
								await tx
									.update(Db.storageIntegrations)
									.set({
										active: false,
										status: "disconnected",
										googleDriveAccessToken: null,
										googleDriveAccessTokenExpiresAt: null,
										googleDriveTokenRefreshLeaseId: null,
										googleDriveTokenRefreshLeaseExpiresAt: null,
										googleDriveStorageQuotaCache: null,
										updatedAt: now,
									})
									.where(
										and(
											eq(
												Db.storageIntegrations.organizationId,
												path.organizationId,
											),
											eq(Db.storageIntegrations.provider, googleDriveProvider),
										),
									);
								return {
									state: "success",
									response: mutationResponse(
										"storage_google_drive",
										drive.id,
										"disconnected",
										requestId,
										now,
									),
								};
							},
						});
					}),
					requestId,
				);
			})
			.handle("updateOrganizationStorageProvider", ({ path, payload }) => {
				const requestId = makeRequestId();
				return withMappedErrors(
					Effect.gen(function* () {
						yield* requireAgentWrites(requestId);
						yield* requireUserConfirmedRequest(requestId);
						const principal = yield* Agent.AgentPrincipal;
						yield* requireAgentStorageManager(
							principal,
							path.organizationId,
							"integrations:write",
							requestId,
						);
						return yield* runAgentMutation({
							principal,
							operation: "update_organization_storage_provider",
							idempotencyKey: yield* requestIdempotencyKey,
							request: { path, provider: payload.provider },
							requestId,
							decodeReplay: decodeMutationResponse,
							execute: async (tx) => {
								if (payload.provider === "s3") {
									const [bucket] = await tx
										.select({ id: Db.s3Buckets.id })
										.from(Db.s3Buckets)
										.where(
											and(
												eq(Db.s3Buckets.organizationId, path.organizationId),
												eq(Db.s3Buckets.active, true),
											),
										)
										.orderBy(desc(Db.s3Buckets.updatedAt))
										.limit(1);
									if (!bucket) return { state: "not_found" };
									await tx
										.update(Db.storageIntegrations)
										.set({ active: false })
										.where(
											eq(
												Db.storageIntegrations.organizationId,
												path.organizationId,
											),
										);
									return {
										state: "success",
										response: mutationResponse(
											"storage_provider",
											bucket.id,
											"activated",
											requestId,
											new Date(),
										),
									};
								}
								const [drive] = await tx
									.select({ id: Db.storageIntegrations.id })
									.from(Db.storageIntegrations)
									.where(
										and(
											eq(
												Db.storageIntegrations.organizationId,
												path.organizationId,
											),
											eq(Db.storageIntegrations.provider, googleDriveProvider),
											eq(Db.storageIntegrations.status, "active"),
										),
									)
									.orderBy(desc(Db.storageIntegrations.updatedAt))
									.limit(1)
									.for("update");
								if (!drive) return { state: "not_found" };
								await tx
									.update(Db.storageIntegrations)
									.set({ active: false })
									.where(
										eq(
											Db.storageIntegrations.organizationId,
											path.organizationId,
										),
									);
								await tx
									.update(Db.storageIntegrations)
									.set({ active: true })
									.where(eq(Db.storageIntegrations.id, drive.id));
								return {
									state: "success",
									response: mutationResponse(
										"storage_provider",
										drive.id,
										"activated",
										requestId,
										new Date(),
									),
								};
							},
						});
					}),
					requestId,
				);
			})
			.handle("setOrganizationGoogleDriveLocation", ({ path, payload }) => {
				const requestId = makeRequestId();
				return withMappedErrors(
					Effect.gen(function* () {
						yield* requireAgentWrites(requestId);
						yield* requireUserConfirmedRequest(requestId);
						const principal = yield* Agent.AgentPrincipal;
						yield* requireAgentStorageManager(
							principal,
							path.organizationId,
							"integrations:write",
							requestId,
						);
						const folderId = payload.folderId.trim();
						if (folderId.length === 0 || folderId.length > 255) {
							return yield* badRequest(
								requestId,
								"Google Drive folder ID is invalid",
							);
						}
						return yield* runAgentExternalMutation({
							principal,
							operation: "set_organization_google_drive_location",
							idempotencyKey: yield* requestIdempotencyKey,
							request: { path, ...payload, folderId },
							requestId,
							decodeReplay: decodeMutationResponse,
							execute: (providerIdempotencyKey) =>
								Effect.gen(function* () {
									const drive = yield* getAgentOrganizationDrive(
										path.organizationId,
									);
									if (!drive || drive.status !== "active") {
										return yield* notReady(
											requestId,
											"Google Drive is not connected",
										);
									}
									const config = yield* parseAgentDriveConfig(
										drive.encryptedConfig,
									);
									const location =
										folderId === "root"
											? {
													id: "root",
													name: "My Drive",
													driveId: null,
													driveName: null,
												}
											: yield* getGoogleDriveFolderLocation(config, folderId);
									const nextConfig: GoogleDriveIntegrationConfig = {
										...config,
										folderId: location.id,
										folderName: payload.folderName ?? location.name,
										driveId: payload.driveId ?? location.driveId ?? null,
										driveName: payload.driveName ?? location.driveName ?? null,
										folderLayout: "userVideo",
									};
									const email = yield* getGoogleDriveUserEmail(nextConfig);
									const encryptedConfig = yield* Effect.tryPromise(() =>
										encrypt(
											JSON.stringify({
												...nextConfig,
												email: email ?? undefined,
											}),
										),
									);
									const displayName = email
										? `Google Drive (${email})`
										: "Google Drive";
									const database = yield* Database;
									const object = yield* database.use((db) =>
										db
											.select({ id: Db.storageObjects.id })
											.from(Db.storageObjects)
											.where(eq(Db.storageObjects.integrationId, drive.id))
											.limit(1),
									);
									const video = yield* database.use((db) =>
										db
											.select({ id: Db.videos.id })
											.from(Db.videos)
											.where(eq(Db.videos.storageIntegrationId, drive.id))
											.limit(1),
									);
									const hasStoredData = object.length > 0 || video.length > 0;
									const nextId = hasStoredData
										? StorageDomain.StorageIntegrationId.make(
												deterministicAgentId(
													"google_drive_location",
													drive.id,
													providerIdempotencyKey,
												),
											)
										: drive.id;
									yield* database.use((db) =>
										db.transaction(async (tx) => {
											if (hasStoredData) {
												if (drive.active) {
													await tx
														.update(Db.storageIntegrations)
														.set({ active: false })
														.where(
															eq(
																Db.storageIntegrations.organizationId,
																path.organizationId,
															),
														);
												}
												await tx
													.insert(Db.storageIntegrations)
													.values({
														id: nextId,
														ownerId: principal.id,
														organizationId: path.organizationId,
														provider: googleDriveProvider,
														displayName,
														status: "active",
														active: drive.active,
														encryptedConfig,
													})
													.onDuplicateKeyUpdate({
														set: {
															displayName,
															status: "active",
															active: drive.active,
															encryptedConfig,
														},
													});
												return;
											}
											await tx
												.update(Db.storageIntegrations)
												.set({
													displayName,
													status: "active",
													encryptedConfig,
													googleDriveStorageQuotaCache: null,
												})
												.where(eq(Db.storageIntegrations.id, drive.id));
										}),
									);
									return mutationResponse(
										"storage_google_drive",
										nextId,
										"location_updated",
										requestId,
										new Date(),
									);
								}),
						});
					}),
					requestId,
				);
			})
			.handle("updateNotificationPreferences", ({ payload }) => {
				const requestId = makeRequestId();
				return withMappedErrors(
					Effect.gen(function* () {
						yield* requireAgentWrites(requestId);
						const principal = yield* Agent.AgentPrincipal;
						yield* requireScope(principal, "notifications:write", requestId);
						if (Object.values(payload).every((value) => value === undefined)) {
							return yield* badRequest(
								requestId,
								"At least one preference is required",
							);
						}
						return yield* runAgentMutation({
							principal,
							operation: "update_notification_preferences",
							idempotencyKey: yield* requestIdempotencyKey,
							request: payload,
							requestId,
							decodeReplay: Schema.decodeUnknownSync(
								Agent.AgentNotificationPreferencesResponse,
							),
							execute: async (tx) => {
								const [user] = await tx
									.select({ preferences: Db.users.preferences })
									.from(Db.users)
									.where(eq(Db.users.id, principal.id))
									.limit(1)
									.for("update");
								if (!user) return { state: "not_found" };
								const current = user.preferences?.notifications;
								const notifications = {
									pauseComments:
										payload.pauseComments ?? current?.pauseComments ?? false,
									pauseReplies:
										payload.pauseReplies ?? current?.pauseReplies ?? false,
									pauseViews:
										payload.pauseViews ?? current?.pauseViews ?? false,
									pauseReactions:
										payload.pauseReactions ?? current?.pauseReactions ?? false,
									pauseAnonViews:
										payload.pauseAnonymousViews ??
										current?.pauseAnonViews ??
										false,
								};
								await tx
									.update(Db.users)
									.set({
										preferences: {
											...(user.preferences ?? {}),
											notifications,
										},
									})
									.where(eq(Db.users.id, principal.id));
								return {
									state: "success",
									response: {
										pauseComments: notifications.pauseComments,
										pauseReplies: notifications.pauseReplies,
										pauseViews: notifications.pauseViews,
										pauseReactions: notifications.pauseReactions,
										pauseAnonymousViews: notifications.pauseAnonViews,
										requestId,
									},
								};
							},
						});
					}),
					requestId,
				);
			})
			.handle("markNotificationsRead", ({ payload }) => {
				const requestId = makeRequestId();
				return withMappedErrors(
					Effect.gen(function* () {
						yield* requireAgentWrites(requestId);
						const principal = yield* Agent.AgentPrincipal;
						yield* requireScope(principal, "notifications:write", requestId);
						const ids = [...new Set(payload.ids ?? [])];
						if (
							(payload.all ? 1 : 0) + (ids.length > 0 ? 1 : 0) !== 1 ||
							ids.length > 100
						) {
							return yield* badRequest(
								requestId,
								"Choose all or between one and 100 notification IDs",
							);
						}
						return yield* runAgentMutation({
							principal,
							operation: "mark_notifications_read",
							idempotencyKey: yield* requestIdempotencyKey,
							request: { all: payload.all === true, ids },
							requestId,
							decodeReplay: decodeMutationResponse,
							execute: async (tx) => {
								await tx
									.update(Db.notifications)
									.set({ readAt: new Date() })
									.where(
										and(
											eq(Db.notifications.recipientId, principal.id),
											payload.all
												? undefined
												: inArray(Db.notifications.id, ids),
										),
									);
								return {
									state: "success",
									response: mutationResponse(
										"notifications",
										payload.all ? "all" : ids.join(","),
										"marked_read",
										requestId,
									),
								};
							},
						});
					}),
					requestId,
				);
			})
			.handle("createUpload", ({ payload }) => {
				const requestId = makeRequestId();
				return withMappedErrors(
					Effect.gen(function* () {
						yield* requireAgentWrites(requestId);
						const principal = yield* Agent.AgentPrincipal;
						yield* requireScope(principal, "caps:upload", requestId);
						const contentLength = payload.contentLength ?? 0;
						if (
							!payload.fileName.trim() ||
							payload.fileName.length > 255 ||
							contentLength < 0 ||
							(payload.durationSeconds !== undefined &&
								payload.durationSeconds < 0) ||
							(payload.width !== undefined && payload.width <= 0) ||
							(payload.height !== undefined && payload.height <= 0) ||
							(payload.fps !== undefined && payload.fps <= 0)
						) {
							return yield* badRequest(requestId, "Upload metadata is invalid");
						}
						const organizationId =
							payload.organizationId ?? principal.activeOrganizationId;
						const management = yield* AgentManagement;
						yield* management.getMembership(principal.id, organizationId);
						if (payload.folderId) {
							const access = yield* management.getFolderAccess(
								principal.id,
								payload.folderId,
							);
							if (
								access.folder.organizationId !== organizationId ||
								access.folder.spaceId !== null ||
								access.folder.createdById !== principal.id
							) {
								return yield* forbidden(requestId);
							}
						}
						const database = yield* Database;
						const [account] = yield* database.use((db) =>
							db
								.select({
									stripeSubscriptionStatus: Db.users.stripeSubscriptionStatus,
									thirdPartyStripeSubscriptionId:
										Db.users.thirdPartyStripeSubscriptionId,
								})
								.from(Db.users)
								.where(eq(Db.users.id, principal.id))
								.limit(1),
						);
						if (
							!isAgentUploadAllowedForPlan({
								durationSeconds: payload.durationSeconds,
								isPro: userIsPro(account),
							})
						) {
							return yield* forbidden(
								requestId,
								AGENT_UPLOAD_PLAN_LIMIT_MESSAGE,
							);
						}
						const storage = yield* Storage;
						const writable = yield* storage.getWritableAccessForUser(
							principal.id,
							organizationId,
						);
						const videoId = Video.VideoId.make(nanoId());
						const rawFileKey = agentUploadPendingRawFileKey(
							principal.id,
							videoId,
						);
						const fileTitle = payload.fileName.replace(/\.[^/.]+$/, "").trim();
						const title = payload.title?.trim() || fileTitle || "Cap Upload";
						if (title.length > 255) {
							return yield* badRequest(requestId, "Upload title is too long");
						}
						const state = yield* runAgentMutation({
							principal,
							operation: "create_upload",
							idempotencyKey: yield* requestIdempotencyKey,
							request: payload,
							requestId,
							decodeReplay: Schema.decodeUnknownSync(AgentUploadMutationState),
							execute: async (tx) => {
								const now = new Date();
								await tx.insert(Db.videos).values({
									id: videoId,
									name: title,
									ownerId: principal.id,
									orgId: organizationId,
									source: { type: "webMP4" },
									bucket: Option.getOrNull(writable.bucketId),
									storageIntegrationId: Option.getOrNull(
										writable.storageIntegrationId,
									),
									folderId: payload.folderId ?? null,
									public: serverEnv().CAP_VIDEOS_DEFAULT_PUBLIC,
									duration: payload.durationSeconds,
									width: payload.width,
									height: payload.height,
									fps: payload.fps,
									metadata: {
										sourceName: payload.fileName,
										agentUpload: { state: "pending" },
									},
									createdAt: now,
									updatedAt: now,
								});
								await tx.insert(Db.videoUploads).values({
									videoId,
									total: contentLength,
									mode: "singlepart",
								});
								return {
									state: "success",
									response: {
										id: videoId,
										organizationId,
										rawFileKey,
										shareUrl: `${serverEnv().WEB_URL}/s/${videoId}`,
										requestId,
									},
								};
							},
						});
						const upload = yield* writable.access.createUploadTarget(
							state.rawFileKey,
							{
								contentType: "video/mp4",
								method: "put",
								fields: {
									"Content-Type": "video/mp4",
									"x-amz-meta-userid": principal.id,
									"x-amz-meta-source": "cap-agent-cli",
								},
							},
						);
						return {
							id: state.id,
							shareUrl: state.shareUrl,
							rawFileKey: state.rawFileKey,
							upload,
							requestId: state.requestId,
						};
					}),
					requestId,
				);
			})
			.handle("completeUpload", ({ path, payload }) => {
				const requestId = makeRequestId();
				return withMappedErrors(
					Effect.gen(function* () {
						yield* requireAgentWrites(requestId);
						const principal = yield* Agent.AgentPrincipal;
						yield* requireScope(principal, "caps:upload", requestId);
						const expectedRawFileKey = agentUploadPendingRawFileKey(
							principal.id,
							path.id,
						);
						const legacyRawFileKey = `${principal.id}/${path.id}/raw-upload.mp4`;
						if (
							(payload.rawFileKey !== expectedRawFileKey &&
								payload.rawFileKey !== legacyRawFileKey) ||
							(payload.contentLength !== undefined && payload.contentLength < 0)
						) {
							return yield* badRequest(
								requestId,
								"Upload completion is invalid",
							);
						}
						const idempotencyKey = yield* requestIdempotencyKey;
						if (!isAgentIdempotencyKey(idempotencyKey)) {
							return yield* badRequest(
								requestId,
								"A valid Idempotency-Key header is required",
							);
						}
						const database = yield* Database;
						const [account] = yield* database.use((db) =>
							db
								.select({
									stripeSubscriptionStatus: Db.users.stripeSubscriptionStatus,
									thirdPartyStripeSubscriptionId:
										Db.users.thirdPartyStripeSubscriptionId,
								})
								.from(Db.users)
								.where(eq(Db.users.id, principal.id))
								.limit(1),
						);
						const [completedUploadRecord] = yield* database.use((db) =>
							db
								.select({ id: Db.agentApiIdempotency.id })
								.from(Db.agentApiIdempotency)
								.where(
									and(
										eq(Db.agentApiIdempotency.userId, principal.id),
										eq(Db.agentApiIdempotency.operation, "complete_upload"),
										eq(Db.agentApiIdempotency.state, "complete"),
										sql`JSON_UNQUOTE(JSON_EXTRACT(${Db.agentApiIdempotency.response}, '$.id')) = ${path.id}`,
										sql`JSON_UNQUOTE(JSON_EXTRACT(${Db.agentApiIdempotency.response}, '$.rawFileKey')) = ${payload.rawFileKey}`,
									),
								)
								.limit(1),
						);
						const isPro = userIsPro(account);
						const [createUploadRecord] = yield* database.use((db) =>
							db
								.select({ id: Db.agentApiIdempotency.id })
								.from(Db.agentApiIdempotency)
								.where(
									and(
										eq(Db.agentApiIdempotency.userId, principal.id),
										eq(Db.agentApiIdempotency.operation, "create_upload"),
										sql`JSON_UNQUOTE(JSON_EXTRACT(${Db.agentApiIdempotency.response}, '$.id')) = ${path.id}`,
										sql`JSON_UNQUOTE(JSON_EXTRACT(${Db.agentApiIdempotency.response}, '$.rawFileKey')) = ${payload.rawFileKey}`,
									),
								)
								.limit(1),
						);
						const [uploadVideo] = yield* database.use((db) =>
							db
								.select({
									id: Db.videos.id,
									ownerId: Db.videos.ownerId,
									metadata: Db.videos.metadata,
								})
								.from(Db.videos)
								.where(eq(Db.videos.id, path.id))
								.limit(1),
						);
						if (!uploadVideo) return yield* notFound(requestId);
						if (uploadVideo.ownerId !== principal.id) {
							return yield* forbidden(requestId);
						}
						const initialAgentUpload =
							uploadVideo.metadata?.agentUpload ??
							(completedUploadRecord
								? ({
										state: "accepted",
										rawFileKey: payload.rawFileKey,
									} as const)
								: createUploadRecord
									? ({ state: "pending" } as const)
									: undefined);
						if (!initialAgentUpload) return yield* notFound(requestId);
						if (completedUploadRecord && !uploadVideo.metadata?.agentUpload) {
							yield* database.use((db) =>
								db.transaction(async (tx) => {
									const [lockedVideo] = await tx
										.select({ metadata: Db.videos.metadata })
										.from(Db.videos)
										.where(
											and(
												eq(Db.videos.id, path.id),
												eq(Db.videos.ownerId, principal.id),
											),
										)
										.limit(1)
										.for("update");
									if (!lockedVideo || lockedVideo.metadata?.agentUpload) return;
									await tx
										.update(Db.videos)
										.set({
											metadata: {
												...(lockedVideo.metadata ?? {}),
												agentUpload: {
													state: "accepted",
													rawFileKey: payload.rawFileKey,
												},
											},
										})
										.where(eq(Db.videos.id, path.id));
								}),
							);
						}
						const video = yield* getViewableVideo(path.id);
						const storage = yield* Storage;
						const [bucket] = yield* storage.getAccessForVideo(video);
						const deleteStoredKeyIfPresent = (key: string) =>
							bucket.listObjects({ prefix: key, maxKeys: 2 }).pipe(
								Effect.flatMap((page) => {
									const objects = (page.Contents ?? [])
										.filter((object) => object.Key === key)
										.map((object) => ({ Key: object.Key }));
									return objects.length > 0
										? bucket.deleteObjects(objects)
										: Effect.void;
								}),
							);
						const deleteRejectedUpload = () =>
							Effect.gen(function* () {
								const prefix = `${principal.id}/${path.id}/`;
								const keys: string[] = [];
								let continuationToken: string | undefined;
								do {
									const page = yield* bucket.listObjects({
										prefix,
										maxKeys: 1_000,
										continuationToken,
									});
									for (const object of page.Contents ?? []) {
										if (object.Key) keys.push(object.Key);
									}
									continuationToken = page.IsTruncated
										? page.NextContinuationToken
										: undefined;
								} while (continuationToken);
								for (let index = 0; index < keys.length; index += 1_000) {
									yield* bucket.deleteObjects(
										keys
											.slice(index, index + 1_000)
											.map((key) => ({ Key: key })),
									);
								}
								yield* database.use((db) =>
									db.transaction(async (tx) => {
										await tx
											.delete(Db.comments)
											.where(eq(Db.comments.videoId, path.id));
										await tx
											.delete(Db.notifications)
											.where(eq(Db.notifications.videoId, path.id));
										await tx
											.delete(Db.videoUploads)
											.where(eq(Db.videoUploads.videoId, path.id));
										await tx
											.delete(Db.importedVideos)
											.where(eq(Db.importedVideos.id, path.id));
										await tx
											.delete(Db.sharedVideos)
											.where(eq(Db.sharedVideos.videoId, path.id));
										await tx
											.delete(Db.spaceVideos)
											.where(eq(Db.spaceVideos.videoId, path.id));
										await tx
											.delete(Db.videoEdits)
											.where(eq(Db.videoEdits.videoId, path.id));
										await tx
											.delete(Db.videos)
											.where(
												and(
													eq(Db.videos.id, path.id),
													eq(Db.videos.ownerId, principal.id),
												),
											);
										await tx
											.delete(Db.agentApiIdempotency)
											.where(
												and(
													eq(Db.agentApiIdempotency.userId, principal.id),
													eq(Db.agentApiIdempotency.operation, "create_upload"),
													sql`JSON_UNQUOTE(JSON_EXTRACT(${Db.agentApiIdempotency.response}, '$.id')) = ${path.id}`,
												),
											);
									}),
								);
							});
						if (initialAgentUpload.state === "rejected") {
							yield* deleteRejectedUpload();
							return yield* forbidden(
								requestId,
								AGENT_UPLOAD_PLAN_LIMIT_MESSAGE,
							);
						}
						let acceptedRawFileKey =
							initialAgentUpload.state === "accepted"
								? initialAgentUpload.rawFileKey
								: undefined;
						if (
							initialAgentUpload.state === "accepted" &&
							!acceptedRawFileKey
						) {
							return yield* temporarilyUnavailable(
								requestId,
								"The upload completion state is unavailable",
							);
						}
						if (initialAgentUpload.state === "pending") {
							const candidateRawFileKey = agentUploadVerifiedRawFileKey(
								principal.id,
								path.id,
								requestId,
							);
							yield* bucket.copyObject(
								`${bucket.bucketName}/${payload.rawFileKey}`,
								candidateRawFileKey,
							);
							let measuredDuration: number | undefined;
							if (!isPro) {
								const candidateUrl = yield* bucket.getInternalSignedObjectUrl(
									candidateRawFileKey,
									{ expiresIn: 5 * 60 },
								);
								const measured = yield* Effect.tryPromise(() =>
									probeVideoViaMediaServer(candidateUrl, { maxRetries: 0 }),
								).pipe(
									Effect.catchAll(() =>
										deleteStoredKeyIfPresent(candidateRawFileKey).pipe(
											Effect.zipRight(
												Effect.fail(
													temporarilyUnavailable(
														requestId,
														"Cap could not verify the uploaded recording duration. Retry the completion request.",
													),
												),
											),
										),
									),
								);
								measuredDuration = measured.duration;
							}
							const allowed = isAgentUploadAllowedForMeasuredDuration({
								durationSeconds: measuredDuration ?? Number.NaN,
								isPro,
							});
							const decision = yield* database.use((db) =>
								db.transaction(async (tx) => {
									const [lockedVideo] = await tx
										.select({
											id: Db.videos.id,
											ownerId: Db.videos.ownerId,
											metadata: Db.videos.metadata,
										})
										.from(Db.videos)
										.where(eq(Db.videos.id, path.id))
										.limit(1)
										.for("update");
									if (!lockedVideo || lockedVideo.ownerId !== principal.id) {
										return { state: "not_found" as const };
									}
									const agentUpload =
										lockedVideo.metadata?.agentUpload ??
										(createUploadRecord
											? ({ state: "pending" } as const)
											: undefined);
									if (!agentUpload) return { state: "not_found" as const };
									if (agentUpload.state === "accepted") {
										return agentUpload.rawFileKey
											? {
													state: "accepted" as const,
													rawFileKey: agentUpload.rawFileKey,
												}
											: { state: "invalid" as const };
									}
									if (agentUpload.state === "rejected") {
										return { state: "rejected" as const };
									}
									const [upload] = await tx
										.select({ videoId: Db.videoUploads.videoId })
										.from(Db.videoUploads)
										.where(eq(Db.videoUploads.videoId, path.id))
										.limit(1)
										.for("update");
									if (!upload) return { state: "not_found" as const };
									if (!allowed) {
										await tx
											.update(Db.videos)
											.set({
												metadata: {
													...(lockedVideo.metadata ?? {}),
													agentUpload: { state: "rejected" },
												},
											})
											.where(eq(Db.videos.id, path.id));
										await tx
											.update(Db.videoUploads)
											.set({
												phase: "error",
												processingMessage: "Upload rejected",
												processingError: AGENT_UPLOAD_REJECTION_ERROR,
												updatedAt: new Date(),
											})
											.where(eq(Db.videoUploads.videoId, path.id));
										return { state: "rejected" as const };
									}
									await tx
										.update(Db.videos)
										.set({
											...(measuredDuration === undefined
												? {}
												: { duration: measuredDuration }),
											metadata: {
												...(lockedVideo.metadata ?? {}),
												agentUpload: {
													state: "accepted",
													rawFileKey: candidateRawFileKey,
												},
											},
										})
										.where(eq(Db.videos.id, path.id));
									if (payload.contentLength !== undefined) {
										await tx
											.update(Db.videoUploads)
											.set({
												uploaded: payload.contentLength,
												total: payload.contentLength,
												updatedAt: new Date(),
											})
											.where(eq(Db.videoUploads.videoId, path.id));
									}
									return {
										state: "accepted" as const,
										rawFileKey: candidateRawFileKey,
									};
								}),
							);
							if (decision.state === "not_found") {
								yield* deleteStoredKeyIfPresent(candidateRawFileKey);
								return yield* notFound(requestId);
							}
							if (decision.state === "invalid") {
								yield* deleteStoredKeyIfPresent(candidateRawFileKey);
								return yield* temporarilyUnavailable(
									requestId,
									"The upload completion state is unavailable",
								);
							}
							if (decision.state === "rejected") {
								yield* deleteRejectedUpload();
								return yield* forbidden(
									requestId,
									AGENT_UPLOAD_PLAN_LIMIT_MESSAGE,
								);
							}
							acceptedRawFileKey = decision.rawFileKey;
							if (acceptedRawFileKey !== candidateRawFileKey) {
								yield* deleteStoredKeyIfPresent(candidateRawFileKey);
							}
						}
						if (!acceptedRawFileKey) {
							return yield* temporarilyUnavailable(
								requestId,
								"The upload completion state is unavailable",
							);
						}
						if (payload.rawFileKey !== acceptedRawFileKey) {
							yield* deleteStoredKeyIfPresent(payload.rawFileKey);
						}
						const state = yield* runAgentMutation({
							principal,
							operation: "complete_upload",
							idempotencyKey,
							request: { path, payload },
							requestId,
							decodeReplay: Schema.decodeUnknownSync(
								AgentUploadCompletionState,
							),
							execute: async (tx) => {
								const [video] = await tx
									.select({
										id: Db.videos.id,
										ownerId: Db.videos.ownerId,
										bucketId: Db.videos.bucket,
										metadata: Db.videos.metadata,
									})
									.from(Db.videos)
									.where(
										and(
											eq(Db.videos.id, path.id),
											eq(Db.videos.ownerId, principal.id),
										),
									)
									.limit(1)
									.for("update");
								if (!video) return { state: "not_found" };
								const agentUpload = video.metadata?.agentUpload;
								if (
									agentUpload?.state !== "accepted" ||
									agentUpload.rawFileKey !== acceptedRawFileKey
								) {
									return { state: "conflict" };
								}
								const [upload] = await tx
									.select({ videoId: Db.videoUploads.videoId })
									.from(Db.videoUploads)
									.where(eq(Db.videoUploads.videoId, path.id))
									.limit(1)
									.for("update");
								if (!upload) return { state: "not_found" };
								return {
									state: "success",
									response: {
										id: video.id,
										ownerId: video.ownerId,
										bucketId: video.bucketId,
										rawFileKey: agentUpload.rawFileKey,
										requestId,
									},
								};
							},
						});
						const processing = yield* Effect.tryPromise(() =>
							startVideoProcessingWorkflow({
								videoId: state.id,
								userId: state.ownerId,
								rawFileKey: state.rawFileKey,
								bucketId: state.bucketId,
								processingMessage: "Starting video processing...",
								startFailureMessage:
									"Video uploaded, but processing could not start.",
								mode: "singlepart",
							}),
						);
						return {
							id: state.id,
							processing,
							requestId: state.requestId,
						};
					}),
					requestId,
				);
			})
			.handle("importLoomCap", ({ path, payload }) => {
				const requestId = makeRequestId();
				return withMappedErrors(
					queueAgentLoomImport({
						organizationId: path.organizationId,
						payload,
						requestId,
					}),
					requestId,
				);
			})
			.handle("processCap", ({ path, payload }) => {
				const requestId = makeRequestId();
				return withMappedErrors(
					Effect.gen(function* () {
						yield* requireAgentWrites(requestId);
						yield* requireUserConfirmedRequest(requestId);
						const principal = yield* Agent.AgentPrincipal;
						yield* requireScope(principal, "caps:process", requestId);
						const { row, rules } = yield* getViewableCap(path.id);
						if (row.ownerId !== principal.id) {
							return yield* forbidden(requestId);
						}
						const includesTranscript = payload.target !== "ai";
						const includesAi = payload.target !== "transcript";
						if (includesTranscript && rules.settings.disableTranscript) {
							return yield* contentDisabled(requestId, "Transcript");
						}
						let aiEnabled = false;
						if (includesAi) {
							const database = yield* Database;
							const [owner] = yield* database.use((db) =>
								db
									.select({
										email: Db.users.email,
										stripeSubscriptionStatus: Db.users.stripeSubscriptionStatus,
										thirdPartyStripeSubscriptionId:
											Db.users.thirdPartyStripeSubscriptionId,
									})
									.from(Db.users)
									.where(eq(Db.users.id, principal.id))
									.limit(1),
							);
							aiEnabled = owner
								? yield* Effect.promise(() => isAiGenerationEnabled(owner))
								: false;
							if (!aiEnabled) {
								return yield* forbidden(
									requestId,
									"AI generation is not available for this account",
								);
							}
						}
						const state = yield* runAgentMutation({
							principal,
							operation: "process_cap",
							idempotencyKey: yield* requestIdempotencyKey,
							request: { id: path.id, payload },
							requestId,
							decodeReplay: Schema.decodeUnknownSync(AgentProcessMutationState),
							execute: async (tx) => {
								const [video] = await tx
									.select({
										id: Db.videos.id,
										ownerId: Db.videos.ownerId,
										transcriptionStatus: Db.videos.transcriptionStatus,
										metadata: Db.videos.metadata,
									})
									.from(Db.videos)
									.where(
										and(
											eq(Db.videos.id, path.id),
											eq(Db.videos.ownerId, principal.id),
										),
									)
									.limit(1)
									.for("update");
								if (!video) return { state: "not_found" };
								const metadata = normalizeAgentMetadata(video.metadata);
								const aiStatus = metadata.aiGenerationStatus ?? null;
								if (
									includesAi &&
									(aiStatus === "ERROR" || aiStatus === "SKIPPED") &&
									payload.retry !== true
								) {
									return { state: "conflict" };
								}
								if (
									payload.target === "ai" &&
									video.transcriptionStatus !== "COMPLETE"
								) {
									return { state: "conflict" };
								}
								if (
									payload.target === "all" &&
									video.transcriptionStatus === "PROCESSING" &&
									aiStatus !== "QUEUED" &&
									aiStatus !== "PROCESSING" &&
									aiStatus !== "COMPLETE"
								) {
									return { state: "conflict" };
								}
								let transcriptionStatus = video.transcriptionStatus;
								if (includesTranscript && transcriptionStatus === "ERROR") {
									if (payload.retry !== true) return { state: "conflict" };
									await tx
										.update(Db.videos)
										.set({ transcriptionStatus: null, updatedAt: new Date() })
										.where(
											and(
												eq(Db.videos.id, path.id),
												eq(Db.videos.transcriptionStatus, "ERROR"),
											),
										);
									transcriptionStatus = null;
								}
								if (
									includesTranscript &&
									(transcriptionStatus === "SKIPPED" ||
										transcriptionStatus === "NO_AUDIO")
								) {
									return { state: "conflict" };
								}
								return {
									state: "success",
									response: {
										id: video.id,
										ownerId: video.ownerId,
										target: payload.target,
										transcriptionStatus,
										aiGenerationStatus: aiStatus,
										aiEnabled,
										requestId,
									},
								};
							},
						});
						if (
							state.target !== "ai" &&
							state.transcriptionStatus !== "COMPLETE"
						) {
							const result = yield* Effect.tryPromise(() =>
								transcribeVideo(
									state.id,
									state.ownerId,
									state.target === "all" && state.aiEnabled,
								),
							);
							if (!result.success) {
								return yield* temporarilyUnavailable(requestId, result.message);
							}
						} else if (state.target !== "transcript") {
							const result = yield* Effect.tryPromise(() =>
								startAiGeneration(state.id, state.ownerId),
							);
							if (!result.success) {
								return yield* temporarilyUnavailable(requestId, result.message);
							}
						}
						const status = getStatus(yield* getStatusRow(path.id));
						return {
							id: path.id,
							requested: payload.target,
							transcript: status.transcript,
							ai: status.ai,
							requestId: state.requestId,
						};
					}),
					requestId,
				);
			})
			.handle("replaceTranscript", ({ path, payload }) => {
				const requestId = makeRequestId();
				return withMappedErrors(
					Effect.gen(function* () {
						yield* requireAgentWrites(requestId);
						yield* requireUserConfirmedRequest(requestId);
						const principal = yield* Agent.AgentPrincipal;
						yield* requireScope(principal, "caps:write", requestId);
						if (!/^[a-f0-9]{64}$/.test(payload.expectedRevision)) {
							return yield* badRequest(
								requestId,
								"expectedRevision is invalid",
							);
						}
						const normalized = normalizeTranscriptCues(payload.cues);
						if (!normalized) {
							return yield* badRequest(
								requestId,
								"Transcript cues are invalid",
							);
						}
						const { video, cap } = yield* getViewableCap(path.id);
						if (!cap.capabilities.editTranscript.allowed) {
							return yield* capabilityFailure(
								requestId,
								cap.capabilities.editTranscript,
							);
						}
						const storage = yield* Storage;
						const [bucket] = yield* storage.getAccessForVideo(video);
						const transcriptKey = `${video.ownerId}/${path.id}/transcription.vtt`;
						const desiredRevision = agentTranscriptRevision(normalized.vtt);
						const response = yield* runAgentMutation({
							principal,
							operation: "replace_transcript",
							idempotencyKey: yield* requestIdempotencyKey,
							request: {
								id: path.id,
								expectedRevision: payload.expectedRevision,
								desiredRevision,
							},
							requestId,
							decodeReplay: Schema.decodeUnknownSync(
								Agent.AgentTranscriptUpdateResponse,
							),
							execute: async (tx) => {
								const [ownedVideo] = await tx
									.select({ id: Db.videos.id })
									.from(Db.videos)
									.where(
										and(
											eq(Db.videos.id, path.id),
											eq(Db.videos.ownerId, principal.id),
										),
									)
									.limit(1)
									.for("update");
								if (!ownedVideo) return { state: "not_found" };
								const object = await Effect.runPromise(
									bucket.getObject(transcriptKey),
								);
								if (Option.isNone(object)) return { state: "not_found" };
								const currentRevision = agentTranscriptRevision(object.value);
								if (
									currentRevision !== payload.expectedRevision &&
									currentRevision !== desiredRevision
								) {
									return { state: "conflict" };
								}
								if (currentRevision !== desiredRevision) {
									await Effect.runPromise(
										bucket.putObject(transcriptKey, normalized.vtt, {
											contentType: "text/vtt",
										}),
									);
								}
								const now = new Date();
								await tx
									.update(Db.videos)
									.set({ updatedAt: now })
									.where(eq(Db.videos.id, path.id));
								return {
									state: "success",
									response: {
										id: path.id,
										revision: desiredRevision,
										cueCount: normalized.cues.length,
										updatedAt: now.toISOString(),
										requestId,
									},
								};
							},
						});
						yield* Effect.sync(() => revalidatePath(`/s/${path.id}`));
						return response;
					}),
					requestId,
				);
			})
			.handle("updateCapPassword", ({ path }) => {
				const requestId = makeRequestId();
				return withMappedErrors(
					Effect.gen(function* () {
						yield* requireAgentWrites(requestId);
						yield* requireUserConfirmedRequest(requestId);
						const principal = yield* Agent.AgentPrincipal;
						yield* requireScope(principal, "caps:write", requestId);
						const request = yield* HttpServerRequest.HttpServerRequest;
						const contentType =
							request.headers["content-type"]?.toLowerCase() ?? "";
						if (!contentType.startsWith("text/plain")) {
							return yield* badRequest(
								requestId,
								"Password input must be text/plain",
							);
						}
						const value = yield* request.text.pipe(
							HttpServerRequest.withMaxBodySize(Option.some(1_024)),
							Effect.catchTag("RequestError", () =>
								Effect.fail(badRequest(requestId, "Password input is invalid")),
							),
						);
						const password = value.trim();
						if (Buffer.byteLength(password, "utf8") > 512) {
							return yield* badRequest(
								requestId,
								"Password input is too large",
							);
						}
						const fingerprint = createHash("sha256")
							.update(password, "utf8")
							.digest("hex");
						const nextPassword = password
							? yield* Effect.tryPromise(() => hashPassword(password))
							: null;
						const response = yield* runAgentMutation({
							principal,
							operation: "update_cap_password",
							idempotencyKey: yield* requestIdempotencyKey,
							request: { id: path.id, fingerprint },
							requestId,
							decodeReplay: decodeMutationResponse,
							execute: async (tx) => {
								const [video] = await tx
									.select({ id: Db.videos.id })
									.from(Db.videos)
									.where(
										and(
											eq(Db.videos.id, path.id),
											eq(Db.videos.ownerId, principal.id),
										),
									)
									.limit(1)
									.for("update");
								if (!video) return { state: "not_found" };
								const now = new Date();
								await tx
									.update(Db.videos)
									.set({ password: nextPassword, updatedAt: now })
									.where(eq(Db.videos.id, path.id));
								return {
									state: "success",
									response: mutationResponse(
										"cap",
										path.id,
										password ? "password_set" : "password_cleared",
										requestId,
										now,
									),
								};
							},
						});
						yield* Effect.sync(() => revalidatePath(`/s/${path.id}`));
						return response;
					}),
					requestId,
				);
			})
			.handle("duplicateCap", ({ path }) => {
				const requestId = makeRequestId();
				return withMappedErrors(
					queueAgentCapOperation({
						videoId: path.id,
						kind: "duplicate_cap",
						scope: "caps:write",
						requestId,
					}),
					requestId,
				);
			})
			.handle("deleteCap", ({ path }) => {
				const requestId = makeRequestId();
				return withMappedErrors(
					queueAgentCapOperation({
						videoId: path.id,
						kind: "delete_cap",
						scope: "caps:delete",
						requestId,
					}),
					requestId,
				);
			})
			.handle("updateCapSettings", ({ path, payload }) => {
				const requestId = makeRequestId();
				return withMappedErrors(
					Effect.gen(function* () {
						yield* requireAgentWrites(requestId);
						const principal = yield* Agent.AgentPrincipal;
						yield* requireScope(principal, "caps:write", requestId);
						if (!hasViewerSettingsUpdate(payload)) {
							return yield* badRequest(
								requestId,
								"At least one setting is required",
							);
						}
						if (
							payload.defaultPlaybackSpeed !== undefined &&
							payload.defaultPlaybackSpeed !== null &&
							(payload.defaultPlaybackSpeed < 0.25 ||
								payload.defaultPlaybackSpeed > 4)
						) {
							return yield* badRequest(
								requestId,
								"defaultPlaybackSpeed must be between 0.25 and 4",
							);
						}
						return yield* runAgentMutation({
							principal,
							operation: "update_cap_settings",
							idempotencyKey: yield* requestIdempotencyKey,
							request: { id: path.id, payload },
							requestId,
							decodeReplay: decodeMutationResponse,
							execute: async (tx) => {
								const [video] = await tx
									.select({ settings: Db.videos.settings })
									.from(Db.videos)
									.where(
										and(
											eq(Db.videos.id, path.id),
											eq(Db.videos.ownerId, principal.id),
										),
									)
									.limit(1)
									.for("update");
								if (!video) return { state: "not_found" };
								const now = new Date();
								await tx
									.update(Db.videos)
									.set({
										settings: mergeViewerSettings(video.settings, payload),
										updatedAt: now,
									})
									.where(eq(Db.videos.id, path.id));
								return {
									state: "success",
									response: mutationResponse(
										"cap",
										path.id,
										"settings_updated",
										requestId,
										now,
									),
								};
							},
						});
					}),
					requestId,
				);
			})
			.handle("updateCapDate", ({ path, payload }) => {
				const requestId = makeRequestId();
				return withMappedErrors(
					Effect.gen(function* () {
						yield* requireAgentWrites(requestId);
						const principal = yield* Agent.AgentPrincipal;
						yield* requireScope(principal, "caps:write", requestId);
						const createdAt = parseAgentDate(payload.createdAt);
						if (!createdAt || createdAt.getTime() > Date.now() + 60_000) {
							return yield* badRequest(
								requestId,
								"createdAt must be a valid past UTC timestamp",
							);
						}
						return yield* runAgentMutation({
							principal,
							operation: "update_cap_date",
							idempotencyKey: yield* requestIdempotencyKey,
							request: { id: path.id, createdAt: createdAt.toISOString() },
							requestId,
							decodeReplay: decodeMutationResponse,
							execute: async (tx) => {
								const [video] = await tx
									.select({ id: Db.videos.id, metadata: Db.videos.metadata })
									.from(Db.videos)
									.where(
										and(
											eq(Db.videos.id, path.id),
											eq(Db.videos.ownerId, principal.id),
										),
									)
									.limit(1)
									.for("update");
								if (!video) return { state: "not_found" };
								const now = new Date();
								await tx
									.update(Db.videos)
									.set({
										metadata: {
											...(video.metadata ?? {}),
											customCreatedAt: createdAt.toISOString(),
										},
										updatedAt: now,
									})
									.where(eq(Db.videos.id, path.id));
								return {
									state: "success",
									response: mutationResponse(
										"cap",
										path.id,
										"date_updated",
										requestId,
										now,
									),
								};
							},
						});
					}),
					requestId,
				);
			})
			.handle("deleteFeedback", ({ path }) => {
				const requestId = makeRequestId();
				return withMappedErrors(
					Effect.gen(function* () {
						yield* requireAgentWrites(requestId);
						const principal = yield* Agent.AgentPrincipal;
						yield* requireScope(principal, "caps:comment", requestId);
						return yield* runAgentMutation({
							principal,
							operation: "delete_feedback",
							idempotencyKey: yield* requestIdempotencyKey,
							request: { videoId: path.id, commentId: path.commentId },
							requestId,
							decodeReplay: decodeMutationResponse,
							execute: async (tx) => {
								const [comment] = await tx
									.select({ id: Db.comments.id })
									.from(Db.comments)
									.where(
										and(
											eq(Db.comments.id, path.commentId),
											eq(Db.comments.videoId, path.id),
											eq(Db.comments.authorId, principal.id),
										),
									)
									.limit(1)
									.for("update");
								if (!comment) return { state: "not_found" };
								await tx
									.delete(Db.comments)
									.where(
										and(
											eq(Db.comments.id, path.commentId),
											eq(Db.comments.videoId, path.id),
											eq(Db.comments.authorId, principal.id),
										),
									);
								return {
									state: "success",
									response: mutationResponse(
										"feedback",
										path.commentId,
										"deleted",
										requestId,
									),
								};
							},
						});
					}),
					requestId,
				);
			})
			.handle("moveCap", ({ path, payload }) => {
				const requestId = makeRequestId();
				return withMappedErrors(
					Effect.gen(function* () {
						yield* requireAgentWrites(requestId);
						const principal = yield* Agent.AgentPrincipal;
						yield* requireScope(principal, "library:write", requestId);
						if (payload.container === "space" && !payload.spaceId) {
							return yield* badRequest(
								requestId,
								"spaceId is required for a space move",
							);
						}
						if (payload.container !== "space" && payload.spaceId) {
							return yield* badRequest(
								requestId,
								"spaceId is only valid for a space move",
							);
						}
						const targetSpaceId =
							payload.container === "organization"
								? payload.organizationId
								: payload.spaceId;
						return yield* runAgentMutation({
							principal,
							operation: "move_cap",
							idempotencyKey: yield* requestIdempotencyKey,
							request: { id: path.id, payload },
							requestId,
							decodeReplay: decodeMutationResponse,
							execute: async (tx) => {
								const [video] = await tx
									.select({ id: Db.videos.id, orgId: Db.videos.orgId })
									.from(Db.videos)
									.where(
										and(
											eq(Db.videos.id, path.id),
											eq(Db.videos.ownerId, principal.id),
										),
									)
									.limit(1)
									.for("update");
								if (!video) return { state: "not_found" };
								if (payload.folderId) {
									const [folder] = await tx
										.select({ id: Db.folders.id })
										.from(Db.folders)
										.where(
											and(
												eq(Db.folders.id, payload.folderId),
												eq(Db.folders.organizationId, payload.organizationId),
												payload.container === "personal"
													? and(
															isNull(Db.folders.spaceId),
															eq(Db.folders.createdById, principal.id),
														)
													: eq(
															Db.folders.spaceId,
															payload.container === "organization"
																? payload.organizationId
																: (targetSpaceId ?? payload.organizationId),
														),
											),
										)
										.limit(1);
									if (!folder) return { state: "forbidden" };
								}
								if (payload.container === "personal") {
									if (video.orgId !== payload.organizationId) {
										return { state: "forbidden" };
									}
									await tx
										.update(Db.videos)
										.set({ folderId: payload.folderId, updatedAt: new Date() })
										.where(
											and(
												eq(Db.videos.id, path.id),
												eq(Db.videos.ownerId, principal.id),
											),
										);
								} else if (payload.container === "organization") {
									const [share] = await tx
										.select({ id: Db.sharedVideos.id })
										.from(Db.sharedVideos)
										.where(
											and(
												eq(Db.sharedVideos.videoId, path.id),
												eq(
													Db.sharedVideos.organizationId,
													payload.organizationId,
												),
											),
										)
										.limit(1)
										.for("update");
									if (!share) return { state: "not_found" };
									await tx
										.update(Db.sharedVideos)
										.set({ folderId: payload.folderId })
										.where(eq(Db.sharedVideos.id, share.id));
								} else {
									const [share] = await tx
										.select({ id: Db.spaceVideos.id })
										.from(Db.spaceVideos)
										.innerJoin(
											Db.spaces,
											eq(Db.spaceVideos.spaceId, Db.spaces.id),
										)
										.where(
											and(
												eq(Db.spaceVideos.videoId, path.id),
												eq(
													Db.spaceVideos.spaceId,
													targetSpaceId ?? payload.organizationId,
												),
												eq(Db.spaces.organizationId, payload.organizationId),
											),
										)
										.limit(1)
										.for("update");
									if (!share) return { state: "not_found" };
									await tx
										.update(Db.spaceVideos)
										.set({ folderId: payload.folderId })
										.where(eq(Db.spaceVideos.id, share.id));
								}
								return {
									state: "success",
									response: mutationResponse(
										"cap",
										path.id,
										"moved",
										requestId,
									),
								};
							},
						});
					}),
					requestId,
				);
			})
			.handle("shareCapWithOrganization", ({ path, payload }) => {
				const requestId = makeRequestId();
				return withMappedErrors(
					Effect.gen(function* () {
						yield* requireAgentWrites(requestId);
						const principal = yield* Agent.AgentPrincipal;
						yield* requireScope(principal, "library:write", requestId);
						return yield* runAgentMutation({
							principal,
							operation: "share_cap_organization",
							idempotencyKey: yield* requestIdempotencyKey,
							request: { path, payload },
							requestId,
							decodeReplay: decodeMutationResponse,
							execute: async (tx) => {
								const [[video], [membership]] = await Promise.all([
									tx
										.select({ id: Db.videos.id })
										.from(Db.videos)
										.where(
											and(
												eq(Db.videos.id, path.id),
												eq(Db.videos.ownerId, principal.id),
											),
										)
										.limit(1),
									tx
										.select({ id: Db.organizationMembers.id })
										.from(Db.organizationMembers)
										.where(
											and(
												eq(Db.organizationMembers.userId, principal.id),
												eq(
													Db.organizationMembers.organizationId,
													path.organizationId,
												),
											),
										)
										.limit(1),
								]);
								if (!video) return { state: "not_found" };
								if (!membership) return { state: "forbidden" };
								if (payload.folderId) {
									const [folder] = await tx
										.select({ id: Db.folders.id })
										.from(Db.folders)
										.where(
											and(
												eq(Db.folders.id, payload.folderId),
												eq(Db.folders.organizationId, path.organizationId),
												eq(Db.folders.spaceId, path.organizationId),
											),
										)
										.limit(1);
									if (!folder) return { state: "forbidden" };
								}
								const [existing] = await tx
									.select({ id: Db.sharedVideos.id })
									.from(Db.sharedVideos)
									.where(
										and(
											eq(Db.sharedVideos.videoId, path.id),
											eq(Db.sharedVideos.organizationId, path.organizationId),
										),
									)
									.limit(1)
									.for("update");
								if (existing) {
									await tx
										.update(Db.sharedVideos)
										.set({ folderId: payload.folderId ?? null })
										.where(eq(Db.sharedVideos.id, existing.id));
								} else {
									await tx.insert(Db.sharedVideos).values({
										id: deterministicAgentId(
											"organization_share",
											path.id,
											path.organizationId,
										),
										videoId: path.id,
										organizationId: path.organizationId,
										folderId: payload.folderId ?? null,
										sharedByUserId: principal.id,
									});
								}
								return {
									state: "success",
									response: mutationResponse(
										"cap",
										path.id,
										"organization_shared",
										requestId,
									),
								};
							},
						});
					}),
					requestId,
				);
			})
			.handle("removeCapOrganizationShare", ({ path }) => {
				const requestId = makeRequestId();
				return withMappedErrors(
					Effect.gen(function* () {
						yield* requireAgentWrites(requestId);
						const principal = yield* Agent.AgentPrincipal;
						yield* requireScope(principal, "library:write", requestId);
						return yield* runAgentMutation({
							principal,
							operation: "remove_cap_organization_share",
							idempotencyKey: yield* requestIdempotencyKey,
							request: path,
							requestId,
							decodeReplay: decodeMutationResponse,
							execute: async (tx) => {
								const [video] = await tx
									.select({ id: Db.videos.id })
									.from(Db.videos)
									.where(
										and(
											eq(Db.videos.id, path.id),
											eq(Db.videos.ownerId, principal.id),
										),
									)
									.limit(1);
								if (!video) return { state: "not_found" };
								await tx
									.delete(Db.sharedVideos)
									.where(
										and(
											eq(Db.sharedVideos.videoId, path.id),
											eq(Db.sharedVideos.organizationId, path.organizationId),
										),
									);
								return {
									state: "success",
									response: mutationResponse(
										"cap",
										path.id,
										"organization_unshared",
										requestId,
									),
								};
							},
						});
					}),
					requestId,
				);
			})
			.handle("shareCapWithSpace", ({ path, payload }) => {
				const requestId = makeRequestId();
				return withMappedErrors(
					Effect.gen(function* () {
						yield* requireAgentWrites(requestId);
						const principal = yield* Agent.AgentPrincipal;
						yield* requireScope(principal, "library:write", requestId);
						const management = yield* AgentManagement;
						yield* management.getSpaceAccess(principal.id, path.spaceId);
						return yield* runAgentMutation({
							principal,
							operation: "share_cap_space",
							idempotencyKey: yield* requestIdempotencyKey,
							request: { path, payload },
							requestId,
							decodeReplay: decodeMutationResponse,
							execute: async (tx) => {
								const [video] = await tx
									.select({ id: Db.videos.id })
									.from(Db.videos)
									.where(
										and(
											eq(Db.videos.id, path.id),
											eq(Db.videos.ownerId, principal.id),
										),
									)
									.limit(1);
								if (!video) return { state: "not_found" };
								if (payload.folderId) {
									const [folder] = await tx
										.select({ id: Db.folders.id })
										.from(Db.folders)
										.where(
											and(
												eq(Db.folders.id, payload.folderId),
												eq(Db.folders.spaceId, path.spaceId),
											),
										)
										.limit(1);
									if (!folder) return { state: "forbidden" };
								}
								const [existing] = await tx
									.select({ id: Db.spaceVideos.id })
									.from(Db.spaceVideos)
									.where(
										and(
											eq(Db.spaceVideos.videoId, path.id),
											eq(Db.spaceVideos.spaceId, path.spaceId),
										),
									)
									.limit(1)
									.for("update");
								if (existing) {
									await tx
										.update(Db.spaceVideos)
										.set({ folderId: payload.folderId ?? null })
										.where(eq(Db.spaceVideos.id, existing.id));
								} else {
									await tx.insert(Db.spaceVideos).values({
										id: deterministicAgentId(
											"space_share",
											path.id,
											path.spaceId,
										),
										spaceId: path.spaceId,
										videoId: path.id,
										folderId: payload.folderId ?? null,
										addedById: principal.id,
									});
								}
								return {
									state: "success",
									response: mutationResponse(
										"cap",
										path.id,
										"space_shared",
										requestId,
									),
								};
							},
						});
					}),
					requestId,
				);
			})
			.handle("removeCapSpaceShare", ({ path }) => {
				const requestId = makeRequestId();
				return withMappedErrors(
					Effect.gen(function* () {
						yield* requireAgentWrites(requestId);
						const principal = yield* Agent.AgentPrincipal;
						yield* requireScope(principal, "library:write", requestId);
						return yield* runAgentMutation({
							principal,
							operation: "remove_cap_space_share",
							idempotencyKey: yield* requestIdempotencyKey,
							request: path,
							requestId,
							decodeReplay: decodeMutationResponse,
							execute: async (tx) => {
								const [video] = await tx
									.select({ id: Db.videos.id })
									.from(Db.videos)
									.where(
										and(
											eq(Db.videos.id, path.id),
											eq(Db.videos.ownerId, principal.id),
										),
									)
									.limit(1);
								if (!video) return { state: "not_found" };
								await tx
									.delete(Db.spaceVideos)
									.where(
										and(
											eq(Db.spaceVideos.videoId, path.id),
											eq(Db.spaceVideos.spaceId, path.spaceId),
										),
									);
								return {
									state: "success",
									response: mutationResponse(
										"cap",
										path.id,
										"space_unshared",
										requestId,
									),
								};
							},
						});
					}),
					requestId,
				);
			})
			.handle("createFolder", ({ path, payload }) => {
				const requestId = makeRequestId();
				return withMappedErrors(
					Effect.gen(function* () {
						yield* requireAgentWrites(requestId);
						const principal = yield* Agent.AgentPrincipal;
						yield* requireScope(principal, "library:write", requestId);
						const name = payload.name.trim();
						if (!name || name.length > 255) {
							return yield* badRequest(requestId, "Folder name is invalid");
						}
						const management = yield* AgentManagement;
						const membership = yield* management.getMembership(
							principal.id,
							path.organizationId,
						);
						if (
							payload.spaceId === path.organizationId &&
							membership.role === "member"
						) {
							return yield* forbidden(requestId);
						}
						if (payload.spaceId && payload.spaceId !== path.organizationId) {
							const access = yield* management.getSpaceAccess(
								principal.id,
								payload.spaceId,
							);
							if (
								!access.canManage ||
								access.organizationId !== path.organizationId
							) {
								return yield* forbidden(requestId);
							}
						}
						if (payload.parentId) {
							const parent = yield* management.getFolderAccess(
								principal.id,
								payload.parentId,
							);
							if (
								!parent.canManage ||
								parent.folder.organizationId !== path.organizationId ||
								parent.folder.spaceId !== (payload.spaceId ?? null)
							) {
								return yield* forbidden(requestId);
							}
						}
						if (payload.public) {
							const organization = normalizeOrganization(
								yield* management.getOrganization(
									principal.id,
									path.organizationId,
								),
								principal.scopes,
							);
							if (organization.billing.plan !== "pro") {
								return yield* forbidden(
									requestId,
									"Cap Pro is required for public collections",
								);
							}
						}
						const folderId = Folder.FolderId.make(nanoId());
						return yield* runAgentMutation({
							principal,
							operation: "create_folder",
							idempotencyKey: yield* requestIdempotencyKey,
							request: { path, payload: { ...payload, name }, folderId },
							requestId,
							decodeReplay: decodeMutationResponse,
							execute: async (tx) => {
								const now = new Date();
								await tx.insert(Db.folders).values({
									id: folderId,
									name,
									color: payload.color ?? "normal",
									public: payload.public ?? false,
									organizationId: path.organizationId,
									createdById: principal.id,
									parentId: payload.parentId ?? null,
									spaceId: payload.spaceId ?? null,
									createdAt: now,
									updatedAt: now,
								});
								return {
									state: "success",
									response: mutationResponse(
										"folder",
										folderId,
										"created",
										requestId,
										now,
									),
								};
							},
						});
					}),
					requestId,
				);
			})
			.handle("updateFolder", ({ path, payload }) => {
				const requestId = makeRequestId();
				return withMappedErrors(
					Effect.gen(function* () {
						yield* requireAgentWrites(requestId);
						const principal = yield* Agent.AgentPrincipal;
						yield* requireScope(principal, "library:write", requestId);
						if (Object.values(payload).every((value) => value === undefined)) {
							return yield* badRequest(
								requestId,
								"At least one folder field is required",
							);
						}
						const name = payload.name?.trim();
						if (name !== undefined && (!name || name.length > 255)) {
							return yield* badRequest(requestId, "Folder name is invalid");
						}
						if (
							payload.settings !== undefined &&
							(!payload.settings ||
								typeof payload.settings !== "object" ||
								Array.isArray(payload.settings))
						) {
							return yield* badRequest(
								requestId,
								"Folder settings must be an object",
							);
						}
						const management = yield* AgentManagement;
						const access = yield* management.getFolderAccess(
							principal.id,
							path.folderId,
						);
						if (!access.canManage) return yield* forbidden(requestId);
						if (payload.public) {
							const organization = normalizeOrganization(
								yield* management.getOrganization(
									principal.id,
									access.folder.organizationId,
								),
								principal.scopes,
							);
							if (organization.billing.plan !== "pro") {
								return yield* forbidden(
									requestId,
									"Cap Pro is required for public collections",
								);
							}
						}
						if (payload.parentId) {
							const parent = yield* management.getFolderAccess(
								principal.id,
								payload.parentId,
							);
							if (
								!parent.canManage ||
								parent.folder.organizationId !== access.folder.organizationId ||
								parent.folder.spaceId !== access.folder.spaceId
							) {
								return yield* forbidden(requestId);
							}
						}
						return yield* runAgentMutation({
							principal,
							operation: "update_folder",
							idempotencyKey: yield* requestIdempotencyKey,
							request: { path, payload: { ...payload, name } },
							requestId,
							decodeReplay: decodeMutationResponse,
							execute: async (tx) => {
								const [folder] = await tx
									.select({ parentId: Db.folders.parentId })
									.from(Db.folders)
									.where(eq(Db.folders.id, path.folderId))
									.limit(1)
									.for("update");
								if (!folder) return { state: "not_found" };
								if (payload.parentId === path.folderId)
									return { state: "conflict" };
								let parentId = payload.parentId ?? null;
								for (let depth = 0; parentId && depth < 100; depth += 1) {
									if (parentId === path.folderId) return { state: "conflict" };
									const [parent] = await tx
										.select({ parentId: Db.folders.parentId })
										.from(Db.folders)
										.where(eq(Db.folders.id, parentId))
										.limit(1);
									if (!parent) return { state: "not_found" };
									parentId = parent.parentId;
								}
								if (parentId) return { state: "conflict" };
								const now = new Date();
								await tx
									.update(Db.folders)
									.set({
										name,
										color: payload.color,
										parentId: payload.parentId,
										public: payload.public,
										settings:
											payload.settings as typeof Db.folders.$inferInsert.settings,
										updatedAt: now,
									})
									.where(eq(Db.folders.id, path.folderId));
								return {
									state: "success",
									response: mutationResponse(
										"folder",
										path.folderId,
										"updated",
										requestId,
										now,
									),
								};
							},
						});
					}),
					requestId,
				);
			})
			.handle("updateFolderPublicPage", ({ path, payload }) => {
				const requestId = makeRequestId();
				return withMappedErrors(
					updateAgentCollectionPublicPage({
						target: { type: "folder", folderId: path.folderId },
						payload,
						requestId,
					}),
					requestId,
				);
			})
			.handle("updateFolderLogo", ({ path, payload }) => {
				const requestId = makeRequestId();
				return withMappedErrors(
					updateAgentImage({
						target: { type: "folder", folderId: path.folderId },
						payload,
						requestId,
					}),
					requestId,
				);
			})
			.handle("removeFolderLogo", ({ path }) => {
				const requestId = makeRequestId();
				return withMappedErrors(
					updateAgentImage({
						target: { type: "folder", folderId: path.folderId },
						payload: null,
						requestId,
					}),
					requestId,
				);
			})
			.handle("deleteFolder", ({ path }) => {
				const requestId = makeRequestId();
				return withMappedErrors(
					Effect.gen(function* () {
						yield* requireAgentWrites(requestId);
						const principal = yield* Agent.AgentPrincipal;
						yield* requireScope(principal, "library:write", requestId);
						const management = yield* AgentManagement;
						const access = yield* management.getFolderAccess(
							principal.id,
							path.folderId,
						);
						if (!access.canManage) return yield* forbidden(requestId);
						return yield* runAgentMutation({
							principal,
							operation: "delete_folder",
							idempotencyKey: yield* requestIdempotencyKey,
							request: path,
							requestId,
							decodeReplay: decodeMutationResponse,
							execute: async (tx) => {
								const [folder] = await tx
									.select({
										id: Db.folders.id,
										parentId: Db.folders.parentId,
										spaceId: Db.folders.spaceId,
										organizationId: Db.folders.organizationId,
									})
									.from(Db.folders)
									.where(eq(Db.folders.id, path.folderId))
									.limit(1)
									.for("update");
								if (!folder) return { state: "not_found" };
								const folderIds = [folder.id];
								const seenFolderIds = new Set(folderIds);
								for (let offset = 0; offset < folderIds.length; offset += 100) {
									if (folderIds.length > 1_000) return { state: "conflict" };
									const parents = folderIds.slice(offset, offset + 100);
									const children = await tx
										.select({ id: Db.folders.id })
										.from(Db.folders)
										.where(inArray(Db.folders.parentId, parents));
									for (const child of children) {
										if (seenFolderIds.has(child.id)) continue;
										seenFolderIds.add(child.id);
										folderIds.push(child.id);
									}
								}
								if (folder.spaceId === null) {
									await tx
										.update(Db.videos)
										.set({ folderId: folder.parentId })
										.where(
											and(
												inArray(Db.videos.folderId, folderIds),
												eq(Db.videos.ownerId, principal.id),
											),
										);
								} else if (folder.spaceId === folder.organizationId) {
									await tx
										.update(Db.sharedVideos)
										.set({ folderId: folder.parentId })
										.where(
											and(
												inArray(Db.sharedVideos.folderId, folderIds),
												eq(
													Db.sharedVideos.organizationId,
													folder.organizationId,
												),
											),
										);
								} else {
									await tx
										.update(Db.spaceVideos)
										.set({ folderId: folder.parentId })
										.where(
											and(
												inArray(Db.spaceVideos.folderId, folderIds),
												eq(Db.spaceVideos.spaceId, folder.spaceId),
											),
										);
								}
								await tx
									.delete(Db.folders)
									.where(inArray(Db.folders.id, folderIds));
								return {
									state: "success",
									response: mutationResponse(
										"folder",
										path.folderId,
										"deleted",
										requestId,
									),
								};
							},
						});
					}),
					requestId,
				);
			})
			.handle("createSpace", ({ path, payload }) => {
				const requestId = makeRequestId();
				return withMappedErrors(
					Effect.gen(function* () {
						yield* requireAgentWrites(requestId);
						const principal = yield* Agent.AgentPrincipal;
						yield* requireScope(principal, "library:write", requestId);
						const name = payload.name.trim();
						const description = payload.description?.trim() || null;
						if (!name || name.length > 255) {
							return yield* badRequest(requestId, "Space name is invalid");
						}
						if ((description?.length ?? 0) > 1_000) {
							return yield* badRequest(
								requestId,
								"Space description is too long",
							);
						}
						if (payload.settings?.defaultPlaybackSpeed !== undefined) {
							return yield* badRequest(
								requestId,
								"defaultPlaybackSpeed is not supported for spaces",
							);
						}
						const management = yield* AgentManagement;
						yield* management.requireOrganizationManager(
							principal.id,
							path.organizationId,
						);
						const organization = normalizeOrganization(
							yield* management.getOrganization(
								principal.id,
								path.organizationId,
							),
							principal.scopes,
						);
						if (
							(payload.public ||
								hasProSpaceSettingEnabled(payload.settings ?? {})) &&
							organization.billing.plan !== "pro"
						) {
							return yield* forbidden(
								requestId,
								"Cap Pro is required for these space settings",
							);
						}
						const spaceId = Space.SpaceId.make(nanoId());
						return yield* runAgentMutation({
							principal,
							operation: "create_space",
							idempotencyKey: yield* requestIdempotencyKey,
							request: {
								path,
								payload: { ...payload, name, description },
								spaceId,
							},
							requestId,
							decodeReplay: decodeMutationResponse,
							execute: async (tx) => {
								const [existing] = await tx
									.select({ id: Db.spaces.id })
									.from(Db.spaces)
									.where(
										and(
											eq(Db.spaces.organizationId, path.organizationId),
											eq(Db.spaces.name, name),
										),
									)
									.limit(1)
									.for("update");
								if (existing) return { state: "conflict" };
								const now = new Date();
								await tx.insert(Db.spaces).values({
									id: spaceId,
									name,
									description,
									organizationId: path.organizationId,
									createdById: principal.id,
									privacy: payload.privacy ?? "Private",
									public: payload.public ?? false,
									settings: mergeSpaceViewerSettings(
										null,
										payload.settings ?? {},
									),
									createdAt: now,
									updatedAt: now,
								});
								await tx.insert(Db.spaceMembers).values({
									id: nanoId(),
									spaceId,
									userId: principal.id,
									role: "admin",
									createdAt: now,
									updatedAt: now,
								});
								return {
									state: "success",
									response: mutationResponse(
										"space",
										spaceId,
										"created",
										requestId,
										now,
									),
								};
							},
						});
					}),
					requestId,
				);
			})
			.handle("updateSpace", ({ path, payload }) => {
				const requestId = makeRequestId();
				return withMappedErrors(
					Effect.gen(function* () {
						yield* requireAgentWrites(requestId);
						const principal = yield* Agent.AgentPrincipal;
						yield* requireScope(principal, "library:write", requestId);
						if (Object.values(payload).every((value) => value === undefined)) {
							return yield* badRequest(
								requestId,
								"At least one space field is required",
							);
						}
						const name = payload.name?.trim();
						const description = payload.description?.trim() || null;
						if (name !== undefined && (!name || name.length > 255)) {
							return yield* badRequest(requestId, "Space name is invalid");
						}
						if ((description?.length ?? 0) > 1_000) {
							return yield* badRequest(
								requestId,
								"Space description is too long",
							);
						}
						if (payload.settings?.defaultPlaybackSpeed !== undefined) {
							return yield* badRequest(
								requestId,
								"defaultPlaybackSpeed is not supported for spaces",
							);
						}
						const management = yield* AgentManagement;
						const access = yield* management.getSpaceAccess(
							principal.id,
							path.spaceId,
						);
						if (!access.canManage) return yield* forbidden(requestId);
						const organization = normalizeOrganization(
							yield* management.getOrganization(
								principal.id,
								access.organizationId,
							),
							principal.scopes,
						);
						if (
							(payload.public === true ||
								hasProSpaceSettingEnabled(payload.settings ?? {})) &&
							organization.billing.plan !== "pro"
						) {
							return yield* forbidden(
								requestId,
								"Cap Pro is required for these space settings",
							);
						}
						return yield* runAgentMutation({
							principal,
							operation: "update_space",
							idempotencyKey: yield* requestIdempotencyKey,
							request: { path, payload: { ...payload, name, description } },
							requestId,
							decodeReplay: decodeMutationResponse,
							execute: async (tx) => {
								const [space] = await tx
									.select({
										settings: Db.spaces.settings,
										public: Db.spaces.public,
									})
									.from(Db.spaces)
									.where(eq(Db.spaces.id, path.spaceId))
									.limit(1)
									.for("update");
								if (!space) return { state: "not_found" };
								const now = new Date();
								await tx
									.update(Db.spaces)
									.set({
										name,
										description:
											payload.description === undefined
												? undefined
												: description,
										privacy: payload.privacy,
										public: payload.public,
										settings: payload.settings
											? mergeSpaceViewerSettings(
													space.settings,
													payload.settings,
												)
											: undefined,
										updatedAt: now,
									})
									.where(eq(Db.spaces.id, path.spaceId));
								return {
									state: "success",
									response: mutationResponse(
										"space",
										path.spaceId,
										"updated",
										requestId,
										now,
									),
								};
							},
						});
					}),
					requestId,
				);
			})
			.handle("updateSpacePublicPage", ({ path, payload }) => {
				const requestId = makeRequestId();
				return withMappedErrors(
					updateAgentCollectionPublicPage({
						target: { type: "space", spaceId: path.spaceId },
						payload,
						requestId,
					}),
					requestId,
				);
			})
			.handle("updateSpaceLogo", ({ path, payload }) => {
				const requestId = makeRequestId();
				return withMappedErrors(
					updateAgentImage({
						target: { type: "space", spaceId: path.spaceId },
						payload,
						requestId,
					}),
					requestId,
				);
			})
			.handle("removeSpaceLogo", ({ path }) => {
				const requestId = makeRequestId();
				return withMappedErrors(
					updateAgentImage({
						target: { type: "space", spaceId: path.spaceId },
						payload: null,
						requestId,
					}),
					requestId,
				);
			})
			.handle("deleteSpace", ({ path }) => {
				const requestId = makeRequestId();
				return withMappedErrors(
					Effect.gen(function* () {
						yield* requireAgentWrites(requestId);
						const principal = yield* Agent.AgentPrincipal;
						yield* requireScope(principal, "library:write", requestId);
						const management = yield* AgentManagement;
						const access = yield* management.getSpaceAccess(
							principal.id,
							path.spaceId,
						);
						if (!access.canManage) return yield* forbidden(requestId);
						return yield* runAgentMutation({
							principal,
							operation: "delete_space",
							idempotencyKey: yield* requestIdempotencyKey,
							request: path,
							requestId,
							decodeReplay: decodeMutationResponse,
							execute: async (tx) => {
								const [space] = await tx
									.select({ primary: Db.spaces.primary })
									.from(Db.spaces)
									.where(eq(Db.spaces.id, path.spaceId))
									.limit(1)
									.for("update");
								if (!space) return { state: "not_found" };
								if (space.primary) return { state: "conflict" };
								await tx
									.delete(Db.spaceVideos)
									.where(eq(Db.spaceVideos.spaceId, path.spaceId));
								await tx
									.delete(Db.spaceMembers)
									.where(eq(Db.spaceMembers.spaceId, path.spaceId));
								await tx
									.delete(Db.folders)
									.where(eq(Db.folders.spaceId, path.spaceId));
								await tx
									.delete(Db.spaces)
									.where(eq(Db.spaces.id, path.spaceId));
								return {
									state: "success",
									response: mutationResponse(
										"space",
										path.spaceId,
										"deleted",
										requestId,
									),
								};
							},
						});
					}),
					requestId,
				);
			})
			.handle("addSpaceMember", ({ path, payload }) => {
				const requestId = makeRequestId();
				return withMappedErrors(
					Effect.gen(function* () {
						yield* requireAgentWrites(requestId);
						const principal = yield* Agent.AgentPrincipal;
						yield* requireScope(principal, "library:write", requestId);
						const management = yield* AgentManagement;
						const access = yield* management.getSpaceAccess(
							principal.id,
							path.spaceId,
						);
						if (!access.canManage) return yield* forbidden(requestId);
						return yield* runAgentMutation({
							principal,
							operation: "add_space_member",
							idempotencyKey: yield* requestIdempotencyKey,
							request: { path, payload },
							requestId,
							decodeReplay: decodeMutationResponse,
							execute: async (tx) => {
								const [[organizationMember], [existing]] = await Promise.all([
									tx
										.select({ id: Db.organizationMembers.id })
										.from(Db.organizationMembers)
										.where(
											and(
												eq(
													Db.organizationMembers.organizationId,
													access.organizationId,
												),
												eq(Db.organizationMembers.userId, payload.userId),
											),
										)
										.limit(1),
									tx
										.select({ id: Db.spaceMembers.id })
										.from(Db.spaceMembers)
										.where(
											and(
												eq(Db.spaceMembers.spaceId, path.spaceId),
												eq(Db.spaceMembers.userId, payload.userId),
											),
										)
										.limit(1)
										.for("update"),
								]);
								if (!organizationMember) return { state: "forbidden" };
								if (existing) return { state: "conflict" };
								const now = new Date();
								await tx.insert(Db.spaceMembers).values({
									id: nanoId(),
									spaceId: path.spaceId,
									userId: payload.userId,
									role: payload.role ?? "member",
									createdAt: now,
									updatedAt: now,
								});
								return {
									state: "success",
									response: mutationResponse(
										"space_member",
										payload.userId,
										"added",
										requestId,
										now,
									),
								};
							},
						});
					}),
					requestId,
				);
			})
			.handle("updateSpaceMember", ({ path, payload }) => {
				const requestId = makeRequestId();
				return withMappedErrors(
					Effect.gen(function* () {
						yield* requireAgentWrites(requestId);
						const principal = yield* Agent.AgentPrincipal;
						yield* requireScope(principal, "library:write", requestId);
						const management = yield* AgentManagement;
						const access = yield* management.getSpaceAccess(
							principal.id,
							path.spaceId,
						);
						if (!access.canManage) return yield* forbidden(requestId);
						if (
							path.userId === access.createdById &&
							payload.role !== "admin"
						) {
							return yield* forbidden(
								requestId,
								"The space creator must remain an admin",
							);
						}
						return yield* runAgentMutation({
							principal,
							operation: "update_space_member",
							idempotencyKey: yield* requestIdempotencyKey,
							request: { path, payload },
							requestId,
							decodeReplay: decodeMutationResponse,
							execute: async (tx) => {
								const [member] = await tx
									.select({ id: Db.spaceMembers.id })
									.from(Db.spaceMembers)
									.where(
										and(
											eq(Db.spaceMembers.spaceId, path.spaceId),
											eq(Db.spaceMembers.userId, path.userId),
										),
									)
									.limit(1)
									.for("update");
								if (!member) return { state: "not_found" };
								const now = new Date();
								await tx
									.update(Db.spaceMembers)
									.set({ role: payload.role, updatedAt: now })
									.where(eq(Db.spaceMembers.id, member.id));
								return {
									state: "success",
									response: mutationResponse(
										"space_member",
										path.userId,
										"updated",
										requestId,
										now,
									),
								};
							},
						});
					}),
					requestId,
				);
			})
			.handle("removeSpaceMember", ({ path }) => {
				const requestId = makeRequestId();
				return withMappedErrors(
					Effect.gen(function* () {
						yield* requireAgentWrites(requestId);
						const principal = yield* Agent.AgentPrincipal;
						yield* requireScope(principal, "library:write", requestId);
						const management = yield* AgentManagement;
						const access = yield* management.getSpaceAccess(
							principal.id,
							path.spaceId,
						);
						if (!access.canManage) return yield* forbidden(requestId);
						if (path.userId === access.createdById) {
							return yield* forbidden(
								requestId,
								"The space creator cannot be removed",
							);
						}
						return yield* runAgentMutation({
							principal,
							operation: "remove_space_member",
							idempotencyKey: yield* requestIdempotencyKey,
							request: path,
							requestId,
							decodeReplay: decodeMutationResponse,
							execute: async (tx) => {
								const [member] = await tx
									.select({ id: Db.spaceMembers.id })
									.from(Db.spaceMembers)
									.where(
										and(
											eq(Db.spaceMembers.spaceId, path.spaceId),
											eq(Db.spaceMembers.userId, path.userId),
										),
									)
									.limit(1)
									.for("update");
								if (!member) return { state: "not_found" };
								await tx
									.delete(Db.spaceMembers)
									.where(eq(Db.spaceMembers.id, member.id));
								return {
									state: "success",
									response: mutationResponse(
										"space_member",
										path.userId,
										"removed",
										requestId,
									),
								};
							},
						});
					}),
					requestId,
				);
			}),
);

const AgentAuthHandlersLive = HttpApiBuilder.group(
	Agent.AgentApiContract,
	"agentAuth",
	(handlers) =>
		handlers
			.handle("exchangeToken", ({ payload }) => {
				const requestId = makeRequestId();
				return Effect.gen(function* () {
					const request = yield* HttpServerRequest.HttpServerRequest;
					const headers = new Headers();
					for (const [name, value] of Object.entries(request.headers)) {
						headers.set(name, value);
					}
					if (
						yield* Effect.promise(() =>
							isRateLimited(RATE_LIMIT_IDS.AGENT_TOKEN_EXCHANGE, {
								headers,
							}),
						)
					) {
						return yield* rateLimited(requestId);
					}
					return yield* exchangeAgentAuthorizationCode(payload, requestId);
				}).pipe(
					Effect.catchTag("DatabaseError", () =>
						Effect.fail(
							temporarilyUnavailable(
								requestId,
								"Authentication is temporarily unavailable",
							),
						),
					),
					Effect.tapErrorCause(Effect.logError),
				);
			})
			.handle("getAuthStatus", () => getAgentAuthStatus(makeRequestId()))
			.handle("revokeToken", () => {
				const requestId = makeRequestId();
				return revokeAgentAccessToken(requestId).pipe(
					Effect.catchTag("DatabaseError", () =>
						Effect.fail(
							temporarilyUnavailable(
								requestId,
								"Authentication is temporarily unavailable",
							),
						),
					),
					Effect.tapErrorCause(Effect.logError),
				);
			}),
);

const ApiLive = HttpApiBuilder.api(Agent.AgentApiContract).pipe(
	Layer.provide(
		Layer.mergeAll(
			AgentHandlersLive,
			AgentManagementHandlersLive,
			AgentAuthHandlersLive,
		),
	),
);

const handler = agentApiToHandler(ApiLive);

export const GET = handler;
export const OPTIONS = handler;
export const POST = handler;
export const PATCH = handler;
export const PUT = handler;
export const DELETE = handler;
