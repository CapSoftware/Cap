import { Schema } from "effect";
import {
	HttpApi,
	HttpApiEndpoint,
	HttpApiError,
	HttpApiGroup,
	OpenApi,
} from "effect/http-api";
import { HttpAuthMiddleware } from "./Authentication.ts";
import { CommentId } from "./Comment.ts";
import { FolderColor, FolderId } from "./Folder.ts";
import { OrganisationId } from "./Organisation.ts";
import { SpaceIdOrOrganisationId } from "./Space.ts";
import { UploadTarget } from "./Storage.ts";
import { UserId } from "./User.ts";
import { UploadPhase, VideoId } from "./Video.ts";

const isExpoAuthPath = (pathname: string) => pathname === "/--/auth";
export const mobileFreeRecordingDurationSeconds = 5 * 60;
export const mobileRecordingDurationToleranceSeconds = 5;

export const isMobileRecordingDurationAllowed = ({
	durationSeconds,
	isPro,
}: {
	durationSeconds: number;
	isPro: boolean;
}) =>
	isPro ||
	durationSeconds <=
		mobileFreeRecordingDurationSeconds +
			mobileRecordingDurationToleranceSeconds;

export const isMobileAuthRedirectUri = (redirectUri: string) => {
	try {
		const redirectUrl = new URL(redirectUri);
		if (redirectUrl.protocol === "cap:") {
			return (
				redirectUrl.hostname === "auth" &&
				redirectUrl.username === "" &&
				redirectUrl.password === "" &&
				redirectUrl.port === "" &&
				redirectUrl.pathname === "" &&
				redirectUrl.search === "" &&
				redirectUrl.hash === ""
			);
		}

		if (
			redirectUrl.protocol !== "exp+cap:" ||
			redirectUrl.hostname !== "expo-development-client" ||
			redirectUrl.username !== "" ||
			redirectUrl.password !== "" ||
			redirectUrl.port !== "" ||
			redirectUrl.hash !== ""
		) {
			return false;
		}

		if (isExpoAuthPath(redirectUrl.pathname)) return redirectUrl.search === "";

		const embeddedUrl = redirectUrl.searchParams.get("url");
		if (
			!embeddedUrl ||
			Array.from(redirectUrl.searchParams.keys()).length !== 1
		)
			return false;

		const parsedEmbeddedUrl = new URL(embeddedUrl);
		return (
			isExpoAuthPath(parsedEmbeddedUrl.pathname) &&
			parsedEmbeddedUrl.search === "" &&
			parsedEmbeddedUrl.hash === ""
		);
	} catch {
		return false;
	}
};

export const createMobileSessionLoginRedirectUrl = ({
	deploymentOrigin,
	requestUrl,
	provider,
	organizationId,
}: {
	deploymentOrigin: string;
	requestUrl: string;
	provider?: "apple" | "google" | "workos";
	organizationId?: string;
}) => {
	const canonicalOrigin = new URL(deploymentOrigin).origin;
	const incomingUrl = new URL(requestUrl, canonicalOrigin);
	const continuationUrl = new URL(
		`${incomingUrl.pathname}${incomingUrl.search}`,
		canonicalOrigin,
	);
	if (provider === "workos") {
		continuationUrl.searchParams.delete("provider");
		continuationUrl.searchParams.delete("organizationId");
	}
	const loginRedirectUrl = new URL("/login", canonicalOrigin);
	loginRedirectUrl.searchParams.set("next", continuationUrl.toString());

	if (provider === "apple" || provider === "google") {
		loginRedirectUrl.searchParams.set("mobileProvider", provider);
	} else if (provider === "workos") {
		loginRedirectUrl.searchParams.set("mobileProvider", "workos");
		if (organizationId) {
			loginRedirectUrl.searchParams.set("organizationId", organizationId);
		}
	}

	return loginRedirectUrl;
};

const MobileAuthRedirectUri = Schema.String.check(
	Schema.makeFilter(isMobileAuthRedirectUri, {
		message: "Invalid mobile auth redirect URI",
	}),
);

export const MobileApiKeyResponse = Schema.Struct({
	type: Schema.Literal("api_key"),
	apiKey: Schema.String,
	userId: UserId,
});

export const MobileSuccessResponse = Schema.Struct({
	success: Schema.Literal(true),
});

export const MobileAuthConfigResponse = Schema.Struct({
	appleAuthAvailable: Schema.Boolean,
	googleAuthAvailable: Schema.Boolean,
	workosAuthAvailable: Schema.Boolean,
});

export const MobileSessionRequestParams = Schema.Struct({
	redirectUri: Schema.optional(MobileAuthRedirectUri),
	provider: Schema.optional(Schema.Literals(["apple", "google", "workos"])),
	organizationId: Schema.optional(Schema.String),
});

export const MobileEmailSessionRequestInput = Schema.Struct({
	email: Schema.String,
});

export const MobileEmailSessionVerifyInput = Schema.Struct({
	email: Schema.String,
	code: Schema.String,
});

export const MobileAccountDeletionInput = Schema.Struct({
	confirmation: Schema.Literal("DELETE"),
});

export const MobileUserBlockInput = Schema.Struct({
	userId: UserId,
});

export const MobileContentReportInput = Schema.Struct({
	reason: Schema.Literals([
		"harassment",
		"hate",
		"sexual",
		"violence",
		"copyright",
		"other",
	]),
});

export const MobileAuthHeaders = Schema.Struct({
	authorization: Schema.optional(Schema.String),
});

export const MobileUser = Schema.Struct({
	id: UserId,
	name: Schema.NullOr(Schema.String),
	lastName: Schema.optional(Schema.NullOr(Schema.String)),
	email: Schema.String,
	imageUrl: Schema.NullOr(Schema.String),
	activeOrganizationId: OrganisationId,
});

export const MobileOrganization = Schema.Struct({
	id: OrganisationId,
	name: Schema.String,
	iconUrl: Schema.NullOr(Schema.String),
	role: Schema.Literals(["owner", "admin", "member"]),
});

export const MobileSpace = Schema.Struct({
	id: SpaceIdOrOrganisationId,
	name: Schema.String,
	iconUrl: Schema.NullOr(Schema.String),
	kind: Schema.Literals(["organization", "space"]),
	privacy: Schema.Literals(["Public", "Private"]),
	role: Schema.NullOr(Schema.Literals(["owner", "admin", "member"])),
	canManage: Schema.Boolean,
	hasPassword: Schema.Boolean,
});

export const MobileFolder = Schema.Struct({
	id: FolderId,
	name: Schema.String,
	color: FolderColor,
	parentId: Schema.NullOr(FolderId),
	videoCount: Schema.Number,
});

export const MobileUploadProgress = Schema.Struct({
	uploaded: Schema.Number,
	total: Schema.Number,
	phase: UploadPhase,
	processingProgress: Schema.Number,
	processingMessage: Schema.NullOr(Schema.String),
	processingError: Schema.NullOr(Schema.String),
});

export const MobileCapSummary = Schema.Struct({
	id: VideoId,
	shareUrl: Schema.String,
	title: Schema.String,
	createdAt: Schema.String,
	updatedAt: Schema.String,
	ownerId: Schema.optional(UserId),
	ownerName: Schema.String,
	durationSeconds: Schema.NullOr(Schema.Number),
	thumbnailUrl: Schema.NullOr(Schema.String),
	thumbnailCacheKey: Schema.optional(Schema.NullOr(Schema.String)),
	folderId: Schema.NullOr(FolderId),
	public: Schema.Boolean,
	protected: Schema.Boolean,
	viewCount: Schema.Number,
	commentCount: Schema.Number,
	reactionCount: Schema.Number,
	upload: Schema.NullOr(MobileUploadProgress),
	ownedByCurrentUser: Schema.optional(Schema.Boolean),
});

export const MobileComment = Schema.Struct({
	id: CommentId,
	videoId: VideoId,
	type: Schema.Literals(["text", "emoji"]),
	content: Schema.String,
	timestamp: Schema.NullOr(Schema.Number),
	parentCommentId: Schema.NullOr(CommentId),
	createdAt: Schema.String,
	updatedAt: Schema.String,
	author: Schema.Struct({
		id: UserId,
		name: Schema.NullOr(Schema.String),
		imageUrl: Schema.NullOr(Schema.String),
	}),
});

export const MobileChapter = Schema.Struct({
	title: Schema.String,
	start: Schema.Number,
});

export const MobileCapDetail = Schema.Struct({
	cap: MobileCapSummary,
	summary: Schema.NullOr(Schema.String),
	chapters: Schema.Array(MobileChapter),
	transcriptionStatus: Schema.NullOr(
		Schema.Literals(["PROCESSING", "COMPLETE", "ERROR", "SKIPPED", "NO_AUDIO"]),
	),
	comments: Schema.Array(MobileComment),
	shareUrl: Schema.String,
});

export const MobileCapsListParams = Schema.Struct({
	folderId: Schema.optional(Schema.String),
	spaceId: Schema.optional(Schema.String),
	page: Schema.optional(Schema.String),
	limit: Schema.optional(Schema.String),
});

export const MobileCapsListResponse = Schema.Struct({
	folders: Schema.Array(MobileFolder),
	caps: Schema.Array(MobileCapSummary),
	page: Schema.Number,
	limit: Schema.Number,
	total: Schema.Number,
	collectionTotal: Schema.optional(Schema.Number),
	hasMore: Schema.Boolean,
});

export const MobileCapStatus = Schema.Struct({
	id: VideoId,
	upload: Schema.NullOr(MobileUploadProgress),
});

export const MobileCapStatusesInput = Schema.Struct({
	ids: Schema.Array(VideoId),
});

export const MobileCapStatusesResponse = Schema.Struct({
	caps: Schema.Array(MobileCapStatus),
});

export const MobileBootstrapResponse = Schema.Struct({
	user: MobileUser,
	organizations: Schema.Array(MobileOrganization),
	activeOrganizationId: Schema.NullOr(OrganisationId),
	rootFolders: Schema.Array(MobileFolder),
	spaces: Schema.optional(Schema.Array(MobileSpace)),
});

export const MobileActiveOrganizationInput = Schema.Struct({
	organizationId: OrganisationId,
});

export const MobileProfileInput = Schema.Struct({
	name: Schema.String,
	lastName: Schema.NullOr(Schema.String),
});

export const MobileProfileImageInput = Schema.Struct({
	data: Schema.String,
	contentType: Schema.String,
	fileName: Schema.String,
});

export const MobileCapSharingInput = Schema.Struct({
	public: Schema.Boolean,
});

export const MobileCapTitleInput = Schema.Struct({
	title: Schema.String,
});

export const MobileCapPasswordInput = Schema.Struct({
	password: Schema.NullOr(Schema.String),
});

export const MobileFolderCreateInput = Schema.Struct({
	name: Schema.String,
	color: Schema.optional(FolderColor),
	spaceId: Schema.optional(SpaceIdOrOrganisationId),
});

export const MobileVideoPath = Schema.Struct({
	id: VideoId,
});

export const MobileCommentPath = Schema.Struct({
	id: CommentId,
});

export const MobileUploadPath = Schema.Struct({
	id: VideoId,
});

export const MobileCommentCreateInput = Schema.Struct({
	content: Schema.String,
	timestamp: Schema.NullOr(Schema.Number),
	parentCommentId: Schema.optional(Schema.NullOr(CommentId)),
});

export const MobileReactionCreateInput = Schema.Struct({
	content: Schema.String,
	timestamp: Schema.NullOr(Schema.Number),
});

export const MobilePlaybackResponse = Schema.Struct({
	kind: Schema.Literals(["mp4", "hls"]),
	url: Schema.String,
	transcriptUrl: Schema.NullOr(Schema.String),
});

export const MobileDownloadResponse = Schema.Struct({
	fileName: Schema.String,
	url: Schema.String,
});

export const MobileAnalyticsRange = Schema.Literals([
	"24h",
	"7d",
	"30d",
	"lifetime",
]);

export const MobileAnalyticsParams = Schema.Struct({
	range: Schema.optional(MobileAnalyticsRange),
});

export const MobileAnalyticsBreakdown = Schema.Struct({
	name: Schema.String,
	subtitle: Schema.optional(Schema.NullOr(Schema.String)),
	views: Schema.Number,
	percentage: Schema.Number,
});

export const MobileAnalyticsData = Schema.Struct({
	capName: Schema.String,
	counts: Schema.Struct({
		caps: Schema.Number,
		views: Schema.Number,
		comments: Schema.Number,
		reactions: Schema.Number,
	}),
	chart: Schema.Array(
		Schema.Struct({
			bucket: Schema.String,
			caps: Schema.Number,
			views: Schema.Number,
			comments: Schema.Number,
			reactions: Schema.Number,
		}),
	),
	breakdowns: Schema.Struct({
		countries: Schema.Array(MobileAnalyticsBreakdown),
		cities: Schema.Array(MobileAnalyticsBreakdown),
		browsers: Schema.Array(MobileAnalyticsBreakdown),
		operatingSystems: Schema.Array(MobileAnalyticsBreakdown),
		devices: Schema.Array(MobileAnalyticsBreakdown),
		topCaps: Schema.Array(
			Schema.Struct({ ...MobileAnalyticsBreakdown.fields, id: VideoId }),
		),
	}),
});

export const MobileAnalyticsResponse = Schema.Struct({
	available: Schema.Boolean,
	data: Schema.NullOr(MobileAnalyticsData),
});

export const MobileOrganizationSettings = Schema.Struct({
	id: OrganisationId,
	name: Schema.String,
	role: Schema.Literals(["owner", "admin", "member"]),
	canManage: Schema.Boolean,
	iconUrl: Schema.NullOr(Schema.String),
	allowedEmailDomain: Schema.NullOr(Schema.String),
	customDomain: Schema.NullOr(Schema.String),
	domainVerified: Schema.Boolean,
});

export const MobileOrganizationSettingsInput = Schema.Struct({
	name: Schema.String,
	allowedEmailDomain: Schema.NullOr(Schema.String),
});

export const MobileOrganizationIconInput = Schema.Struct({
	data: Schema.String,
	contentType: Schema.String,
	fileName: Schema.String,
});

export const MobileLoomImportInput = Schema.Struct({
	loomUrl: Schema.String,
});

export const MobileLoomImportResponse = Schema.Struct({
	id: VideoId,
	shareUrl: Schema.String,
});

export const MobileUploadCreateInput = Schema.Struct({
	organizationId: Schema.optional(OrganisationId),
	folderId: Schema.optional(FolderId),
	fileName: Schema.String,
	contentType: Schema.String,
	contentLength: Schema.optional(Schema.Number),
	durationSeconds: Schema.optional(Schema.Number),
	width: Schema.optional(Schema.Number),
	height: Schema.optional(Schema.Number),
	fps: Schema.optional(Schema.Number),
});

export const MobileUploadCreateResponse = Schema.Struct({
	id: VideoId,
	shareUrl: Schema.String,
	rawFileKey: Schema.String,
	upload: UploadTarget,
});

export const MobileUploadProgressInput = Schema.Struct({
	uploaded: Schema.Number,
	total: Schema.Number,
});

export const MobileUploadCompleteInput = Schema.Struct({
	rawFileKey: Schema.String,
	contentLength: Schema.optional(Schema.Number),
});

export const MobileRecordingCreateInput = Schema.Struct({
	organizationId: Schema.optional(OrganisationId),
	folderId: Schema.optional(FolderId),
	fileName: Schema.String,
	width: Schema.Number,
	height: Schema.Number,
	fps: Schema.Number,
});

export const MobileRecordingCreateResponse = Schema.Struct({
	id: VideoId,
	shareUrl: Schema.String,
});

export const MobileRecordingUploadTargetsInput = Schema.Struct({
	subpaths: Schema.Array(Schema.String),
});

export const MobileRecordingUploadTargetsResponse = Schema.Struct({
	uploads: Schema.Record(Schema.String, UploadTarget),
});

export const MobileRecordingSegment = Schema.Struct({
	index: Schema.Number,
	duration: Schema.Number,
});

export const MobileRecordingCompleteInput = Schema.Struct({
	durationSeconds: Schema.Number,
	totalBytes: Schema.Number,
	videoSegments: Schema.Array(MobileRecordingSegment),
	audioSegments: Schema.Array(MobileRecordingSegment),
});

export class MobileHttpApi extends HttpApiGroup.make("mobile")
	.add(
		HttpApiEndpoint.get("getAuthConfig", "/session/config", {
			success: MobileAuthConfigResponse,
		}),
	)
	.add(
		HttpApiEndpoint.get("requestSession", "/session/request", {
			query: MobileSessionRequestParams,
			success: MobileApiKeyResponse,
			error: [
				HttpApiError.InternalServerError,
				HttpApiError.BadRequest,
				HttpApiError.Forbidden,
				HttpApiError.NotFound,
			],
		}),
	)
	.add(
		HttpApiEndpoint.post("requestEmailSession", "/session/email/request", {
			payload: MobileEmailSessionRequestInput,
			success: MobileSuccessResponse,
			error: [
				HttpApiError.InternalServerError,
				HttpApiError.BadRequest,
				HttpApiError.Forbidden,
				HttpApiError.NotFound,
			],
		}),
	)
	.add(
		HttpApiEndpoint.post("verifyEmailSession", "/session/email/verify", {
			payload: MobileEmailSessionVerifyInput,
			success: MobileApiKeyResponse,
			error: [
				HttpApiError.InternalServerError,
				HttpApiError.BadRequest,
				HttpApiError.Forbidden,
				HttpApiError.NotFound,
			],
		}),
	)
	.add(
		HttpApiEndpoint.post("revokeSession", "/session/revoke", {
			headers: MobileAuthHeaders,
			success: MobileSuccessResponse,
			error: [HttpApiError.Forbidden, HttpApiError.NotFound],
		}).middleware(HttpAuthMiddleware),
	)
	.add(
		HttpApiEndpoint.post("requestAccountDeletion", "/user/account-deletion", {
			payload: MobileAccountDeletionInput,
			success: MobileSuccessResponse,
			error: [
				HttpApiError.BadRequest,
				HttpApiError.Forbidden,
				HttpApiError.InternalServerError,
				HttpApiError.NotFound,
			],
		}).middleware(HttpAuthMiddleware),
	)
	.add(
		HttpApiEndpoint.post("blockUser", "/user/blocks", {
			payload: MobileUserBlockInput,
			success: MobileSuccessResponse,
			error: [
				HttpApiError.BadRequest,
				HttpApiError.Forbidden,
				HttpApiError.NotFound,
			],
		}).middleware(HttpAuthMiddleware),
	)
	.add(
		HttpApiEndpoint.get("bootstrap", "/bootstrap", {
			success: MobileBootstrapResponse,
			error: [HttpApiError.Forbidden, HttpApiError.NotFound],
		}).middleware(HttpAuthMiddleware),
	)
	.add(
		HttpApiEndpoint.patch(
			"setActiveOrganization",
			"/user/active-organization",
			{
				payload: MobileActiveOrganizationInput,
				success: MobileBootstrapResponse,
				error: [HttpApiError.Forbidden, HttpApiError.NotFound],
			},
		).middleware(HttpAuthMiddleware),
	)
	.add(
		HttpApiEndpoint.patch("updateProfile", "/user/profile", {
			payload: MobileProfileInput,
			success: MobileUser,
			error: [
				HttpApiError.BadRequest,
				HttpApiError.Forbidden,
				HttpApiError.NotFound,
			],
		}).middleware(HttpAuthMiddleware),
	)
	.add(
		HttpApiEndpoint.put("updateProfileImage", "/user/profile/image", {
			payload: MobileProfileImageInput,
			success: MobileUser,
			error: [
				HttpApiError.BadRequest,
				HttpApiError.Forbidden,
				HttpApiError.NotFound,
			],
		}).middleware(HttpAuthMiddleware),
	)
	.add(
		HttpApiEndpoint.delete("removeProfileImage", "/user/profile/image", {
			success: MobileUser,
			error: [HttpApiError.Forbidden, HttpApiError.NotFound],
		}).middleware(HttpAuthMiddleware),
	)
	.add(
		HttpApiEndpoint.get("listCaps", "/caps", {
			query: MobileCapsListParams,
			success: MobileCapsListResponse,
			error: [HttpApiError.Forbidden, HttpApiError.NotFound],
		}).middleware(HttpAuthMiddleware),
	)
	.add(
		HttpApiEndpoint.post("getCapStatuses", "/caps/statuses", {
			payload: MobileCapStatusesInput,
			success: MobileCapStatusesResponse,
			error: [
				HttpApiError.BadRequest,
				HttpApiError.Forbidden,
				HttpApiError.NotFound,
			],
		}).middleware(HttpAuthMiddleware),
	)
	.add(
		HttpApiEndpoint.post("createFolder", "/folders", {
			payload: MobileFolderCreateInput,
			success: MobileFolder,
			error: [
				HttpApiError.BadRequest,
				HttpApiError.Forbidden,
				HttpApiError.NotFound,
			],
		}).middleware(HttpAuthMiddleware),
	)
	.add(
		HttpApiEndpoint.get("getCap", "/caps/:id", {
			params: MobileVideoPath,
			success: MobileCapDetail,
			error: [HttpApiError.Forbidden, HttpApiError.NotFound],
		}).middleware(HttpAuthMiddleware),
	)
	.add(
		HttpApiEndpoint.post("reportCap", "/caps/:id/report", {
			params: MobileVideoPath,
			payload: MobileContentReportInput,
			success: MobileSuccessResponse,
			error: [
				HttpApiError.BadRequest,
				HttpApiError.Forbidden,
				HttpApiError.InternalServerError,
				HttpApiError.NotFound,
			],
		}).middleware(HttpAuthMiddleware),
	)
	.add(
		HttpApiEndpoint.get("getCapThumbnail", "/caps/:id/thumbnail", {
			params: MobileVideoPath,
			success: Schema.String,
			error: [HttpApiError.Forbidden, HttpApiError.NotFound],
		}).middleware(HttpAuthMiddleware),
	)
	.add(
		HttpApiEndpoint.patch("updateCapSharing", "/caps/:id/sharing", {
			params: MobileVideoPath,
			payload: MobileCapSharingInput,
			success: MobileCapSummary,
			error: [HttpApiError.Forbidden, HttpApiError.NotFound],
		}).middleware(HttpAuthMiddleware),
	)
	.add(
		HttpApiEndpoint.patch("updateCapTitle", "/caps/:id/title", {
			params: MobileVideoPath,
			payload: MobileCapTitleInput,
			success: MobileCapSummary,
			error: [
				HttpApiError.BadRequest,
				HttpApiError.Forbidden,
				HttpApiError.NotFound,
			],
		}).middleware(HttpAuthMiddleware),
	)
	.add(
		HttpApiEndpoint.patch("updateCapPassword", "/caps/:id/password", {
			params: MobileVideoPath,
			payload: MobileCapPasswordInput,
			success: MobileCapSummary,
			error: [
				HttpApiError.BadRequest,
				HttpApiError.Forbidden,
				HttpApiError.NotFound,
			],
		}).middleware(HttpAuthMiddleware),
	)
	.add(
		HttpApiEndpoint.delete("deleteCap", "/caps/:id", {
			params: MobileVideoPath,
			success: MobileSuccessResponse,
			error: [HttpApiError.Forbidden, HttpApiError.NotFound],
		}).middleware(HttpAuthMiddleware),
	)
	.add(
		HttpApiEndpoint.get("getPlayback", "/caps/:id/playback", {
			params: MobileVideoPath,
			success: MobilePlaybackResponse,
			error: [HttpApiError.Forbidden, HttpApiError.NotFound],
		}).middleware(HttpAuthMiddleware),
	)
	.add(
		HttpApiEndpoint.get("getDownload", "/caps/:id/download", {
			params: MobileVideoPath,
			success: MobileDownloadResponse,
			error: [HttpApiError.Forbidden, HttpApiError.NotFound],
		}).middleware(HttpAuthMiddleware),
	)
	.add(
		HttpApiEndpoint.get("getCapAnalytics", "/caps/:id/analytics", {
			params: MobileVideoPath,
			query: MobileAnalyticsParams,
			success: MobileAnalyticsResponse,
			error: [
				HttpApiError.Forbidden,
				HttpApiError.NotFound,
				HttpApiError.InternalServerError,
			],
		}).middleware(HttpAuthMiddleware),
	)
	.add(
		HttpApiEndpoint.get("getOrganizationSettings", "/organization/settings", {
			success: MobileOrganizationSettings,
			error: [HttpApiError.Forbidden, HttpApiError.NotFound],
		}).middleware(HttpAuthMiddleware),
	)
	.add(
		HttpApiEndpoint.patch(
			"updateOrganizationSettings",
			"/organization/settings",
			{
				payload: MobileOrganizationSettingsInput,
				success: MobileOrganizationSettings,
				error: [
					HttpApiError.BadRequest,
					HttpApiError.Forbidden,
					HttpApiError.NotFound,
				],
			},
		).middleware(HttpAuthMiddleware),
	)
	.add(
		HttpApiEndpoint.put(
			"updateOrganizationIcon",
			"/organization/settings/icon",
			{
				payload: MobileOrganizationIconInput,
				success: MobileOrganizationSettings,
				error: [
					HttpApiError.BadRequest,
					HttpApiError.Forbidden,
					HttpApiError.NotFound,
				],
			},
		).middleware(HttpAuthMiddleware),
	)
	.add(
		HttpApiEndpoint.delete(
			"removeOrganizationIcon",
			"/organization/settings/icon",
			{
				success: MobileOrganizationSettings,
				error: [HttpApiError.Forbidden, HttpApiError.NotFound],
			},
		).middleware(HttpAuthMiddleware),
	)
	.add(
		HttpApiEndpoint.post("importLoom", "/imports/loom", {
			payload: MobileLoomImportInput,
			success: MobileLoomImportResponse,
			error: [
				HttpApiError.BadRequest,
				HttpApiError.Forbidden,
				HttpApiError.NotFound,
				HttpApiError.InternalServerError,
			],
		}).middleware(HttpAuthMiddleware),
	)
	.add(
		HttpApiEndpoint.post("createComment", "/caps/:id/comments", {
			params: MobileVideoPath,
			payload: MobileCommentCreateInput,
			success: MobileComment,
			error: [HttpApiError.Forbidden, HttpApiError.NotFound],
		}).middleware(HttpAuthMiddleware),
	)
	.add(
		HttpApiEndpoint.delete("deleteComment", "/comments/:id", {
			params: MobileCommentPath,
			success: MobileSuccessResponse,
			error: [HttpApiError.Forbidden, HttpApiError.NotFound],
		}).middleware(HttpAuthMiddleware),
	)
	.add(
		HttpApiEndpoint.post("createReaction", "/caps/:id/reactions", {
			params: MobileVideoPath,
			payload: MobileReactionCreateInput,
			success: MobileComment,
			error: [HttpApiError.Forbidden, HttpApiError.NotFound],
		}).middleware(HttpAuthMiddleware),
	)
	.add(
		HttpApiEndpoint.post("createUpload", "/uploads", {
			payload: MobileUploadCreateInput,
			success: MobileUploadCreateResponse,
			error: [HttpApiError.Forbidden, HttpApiError.NotFound],
		}).middleware(HttpAuthMiddleware),
	)
	.add(
		HttpApiEndpoint.post("updateUploadProgress", "/uploads/:id/progress", {
			params: MobileUploadPath,
			payload: MobileUploadProgressInput,
			success: MobileSuccessResponse,
			error: [HttpApiError.Forbidden, HttpApiError.NotFound],
		}).middleware(HttpAuthMiddleware),
	)
	.add(
		HttpApiEndpoint.post("completeUpload", "/uploads/:id/complete", {
			params: MobileUploadPath,
			payload: MobileUploadCompleteInput,
			success: MobileSuccessResponse,
			error: [HttpApiError.Forbidden, HttpApiError.NotFound],
		}).middleware(HttpAuthMiddleware),
	)
	.add(
		HttpApiEndpoint.post("createRecording", "/recordings", {
			payload: MobileRecordingCreateInput,
			success: MobileRecordingCreateResponse,
			error: [
				HttpApiError.BadRequest,
				HttpApiError.Forbidden,
				HttpApiError.NotFound,
			],
		}).middleware(HttpAuthMiddleware),
	)
	.add(
		HttpApiEndpoint.post(
			"createRecordingUploadTargets",
			"/recordings/:id/segments/targets",
			{
				params: MobileUploadPath,
				payload: MobileRecordingUploadTargetsInput,
				success: MobileRecordingUploadTargetsResponse,
				error: [
					HttpApiError.BadRequest,
					HttpApiError.Forbidden,
					HttpApiError.NotFound,
				],
			},
		).middleware(HttpAuthMiddleware),
	)
	.add(
		HttpApiEndpoint.post("completeRecording", "/recordings/:id/complete", {
			params: MobileUploadPath,
			payload: MobileRecordingCompleteInput,
			success: MobileSuccessResponse,
			error: [
				HttpApiError.BadRequest,
				HttpApiError.Forbidden,
				HttpApiError.NotFound,
			],
		}).middleware(HttpAuthMiddleware),
	) {}

export class MobileApiContract extends HttpApi.make("cap-mobile-api")
	.add(MobileHttpApi)
	.annotateMerge(
		OpenApi.annotations({
			title: "Cap Mobile API",
			description: "Authenticated API used by the Cap iOS app",
		}),
	)
	.prefix("/api/mobile") {}
