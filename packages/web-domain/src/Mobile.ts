import {
	HttpApi,
	HttpApiEndpoint,
	HttpApiError,
	HttpApiGroup,
	OpenApi,
} from "@effect/platform";
import { Schema } from "effect";
import { HttpAuthMiddleware } from "./Authentication.ts";
import { CommentId } from "./Comment.ts";
import { FolderColor, FolderId } from "./Folder.ts";
import { OrganisationId } from "./Organisation.ts";
import { UploadTarget } from "./Storage.ts";
import { UserId } from "./User.ts";
import { UploadPhase, VideoId } from "./Video.ts";

const isExpoAuthPath = (pathname: string) => pathname === "/--/auth";

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

const MobileAuthRedirectUri = Schema.String.pipe(
	Schema.filter(
		(redirectUri) =>
			isMobileAuthRedirectUri(redirectUri) ||
			"Invalid mobile auth redirect URI",
	),
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
	googleAuthAvailable: Schema.Boolean,
	workosAuthAvailable: Schema.Boolean,
});

export const MobileSessionRequestParams = Schema.Struct({
	redirectUri: Schema.optional(MobileAuthRedirectUri),
	provider: Schema.optional(Schema.Literal("google", "workos")),
	organizationId: Schema.optional(Schema.String),
});

export const MobileEmailSessionRequestInput = Schema.Struct({
	email: Schema.String,
});

export const MobileEmailSessionVerifyInput = Schema.Struct({
	email: Schema.String,
	code: Schema.String,
});

export const MobileAuthHeaders = Schema.Struct({
	authorization: Schema.optional(Schema.String),
});

export const MobileUser = Schema.Struct({
	id: UserId,
	name: Schema.NullOr(Schema.String),
	email: Schema.String,
	imageUrl: Schema.NullOr(Schema.String),
	activeOrganizationId: OrganisationId,
});

export const MobileOrganization = Schema.Struct({
	id: OrganisationId,
	name: Schema.String,
	iconUrl: Schema.NullOr(Schema.String),
	role: Schema.Literal("owner", "admin", "member"),
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
	ownerName: Schema.String,
	durationSeconds: Schema.NullOr(Schema.Number),
	thumbnailUrl: Schema.NullOr(Schema.String),
	folderId: Schema.NullOr(FolderId),
	public: Schema.Boolean,
	protected: Schema.Boolean,
	viewCount: Schema.Number,
	commentCount: Schema.Number,
	reactionCount: Schema.Number,
	upload: Schema.NullOr(MobileUploadProgress),
});

export const MobileComment = Schema.Struct({
	id: CommentId,
	videoId: VideoId,
	type: Schema.Literal("text", "emoji"),
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
		Schema.Literal("PROCESSING", "COMPLETE", "ERROR", "SKIPPED", "NO_AUDIO"),
	),
	comments: Schema.Array(MobileComment),
	shareUrl: Schema.String,
});

export const MobileCapsListParams = Schema.Struct({
	folderId: Schema.optional(Schema.String),
	page: Schema.optional(Schema.String),
	limit: Schema.optional(Schema.String),
});

export const MobileCapsListResponse = Schema.Struct({
	folders: Schema.Array(MobileFolder),
	caps: Schema.Array(MobileCapSummary),
	page: Schema.Number,
	limit: Schema.Number,
	total: Schema.Number,
	hasMore: Schema.Boolean,
});

export const MobileBootstrapResponse = Schema.Struct({
	user: MobileUser,
	organizations: Schema.Array(MobileOrganization),
	activeOrganizationId: Schema.NullOr(OrganisationId),
	rootFolders: Schema.Array(MobileFolder),
});

export const MobileActiveOrganizationInput = Schema.Struct({
	organizationId: OrganisationId,
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
	kind: Schema.Literal("mp4", "hls"),
	url: Schema.String,
	transcriptUrl: Schema.NullOr(Schema.String),
});

export const MobileDownloadResponse = Schema.Struct({
	fileName: Schema.String,
	url: Schema.String,
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
	cap: MobileCapSummary,
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
	cap: MobileCapSummary,
});

export const MobileRecordingUploadTargetsInput = Schema.Struct({
	subpaths: Schema.Array(Schema.String),
});

export const MobileRecordingUploadTargetsResponse = Schema.Struct({
	uploads: Schema.Record({ key: Schema.String, value: UploadTarget }),
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
		HttpApiEndpoint.get("getAuthConfig", "/session/config").addSuccess(
			MobileAuthConfigResponse,
		),
	)
	.add(
		HttpApiEndpoint.get("requestSession", "/session/request")
			.setUrlParams(MobileSessionRequestParams)
			.addSuccess(MobileApiKeyResponse)
			.addError(HttpApiError.InternalServerError)
			.addError(HttpApiError.BadRequest)
			.addError(HttpApiError.Forbidden)
			.addError(HttpApiError.NotFound),
	)
	.add(
		HttpApiEndpoint.post("requestEmailSession", "/session/email/request")
			.setPayload(MobileEmailSessionRequestInput)
			.addSuccess(MobileSuccessResponse)
			.addError(HttpApiError.InternalServerError)
			.addError(HttpApiError.BadRequest)
			.addError(HttpApiError.Forbidden)
			.addError(HttpApiError.NotFound),
	)
	.add(
		HttpApiEndpoint.post("verifyEmailSession", "/session/email/verify")
			.setPayload(MobileEmailSessionVerifyInput)
			.addSuccess(MobileApiKeyResponse)
			.addError(HttpApiError.InternalServerError)
			.addError(HttpApiError.BadRequest)
			.addError(HttpApiError.Forbidden)
			.addError(HttpApiError.NotFound),
	)
	.add(
		HttpApiEndpoint.post("revokeSession", "/session/revoke")
			.setHeaders(MobileAuthHeaders)
			.addSuccess(MobileSuccessResponse)
			.middleware(HttpAuthMiddleware)
			.addError(HttpApiError.Forbidden)
			.addError(HttpApiError.NotFound),
	)
	.add(
		HttpApiEndpoint.get("bootstrap", "/bootstrap")
			.addSuccess(MobileBootstrapResponse)
			.middleware(HttpAuthMiddleware)
			.addError(HttpApiError.Forbidden)
			.addError(HttpApiError.NotFound),
	)
	.add(
		HttpApiEndpoint.patch("setActiveOrganization", "/user/active-organization")
			.setPayload(MobileActiveOrganizationInput)
			.addSuccess(MobileBootstrapResponse)
			.middleware(HttpAuthMiddleware)
			.addError(HttpApiError.Forbidden)
			.addError(HttpApiError.NotFound),
	)
	.add(
		HttpApiEndpoint.get("listCaps", "/caps")
			.setUrlParams(MobileCapsListParams)
			.addSuccess(MobileCapsListResponse)
			.middleware(HttpAuthMiddleware)
			.addError(HttpApiError.Forbidden)
			.addError(HttpApiError.NotFound),
	)
	.add(
		HttpApiEndpoint.post("createFolder", "/folders")
			.setPayload(MobileFolderCreateInput)
			.addSuccess(MobileFolder)
			.middleware(HttpAuthMiddleware)
			.addError(HttpApiError.BadRequest)
			.addError(HttpApiError.Forbidden)
			.addError(HttpApiError.NotFound),
	)
	.add(
		HttpApiEndpoint.get("getCap", "/caps/:id")
			.setPath(MobileVideoPath)
			.addSuccess(MobileCapDetail)
			.middleware(HttpAuthMiddleware)
			.addError(HttpApiError.Forbidden)
			.addError(HttpApiError.NotFound),
	)
	.add(
		HttpApiEndpoint.patch("updateCapSharing", "/caps/:id/sharing")
			.setPath(MobileVideoPath)
			.setPayload(MobileCapSharingInput)
			.addSuccess(MobileCapSummary)
			.middleware(HttpAuthMiddleware)
			.addError(HttpApiError.Forbidden)
			.addError(HttpApiError.NotFound),
	)
	.add(
		HttpApiEndpoint.patch("updateCapTitle", "/caps/:id/title")
			.setPath(MobileVideoPath)
			.setPayload(MobileCapTitleInput)
			.addSuccess(MobileCapSummary)
			.middleware(HttpAuthMiddleware)
			.addError(HttpApiError.BadRequest)
			.addError(HttpApiError.Forbidden)
			.addError(HttpApiError.NotFound),
	)
	.add(
		HttpApiEndpoint.patch("updateCapPassword", "/caps/:id/password")
			.setPath(MobileVideoPath)
			.setPayload(MobileCapPasswordInput)
			.addSuccess(MobileCapSummary)
			.middleware(HttpAuthMiddleware)
			.addError(HttpApiError.BadRequest)
			.addError(HttpApiError.Forbidden)
			.addError(HttpApiError.NotFound),
	)
	.add(
		HttpApiEndpoint.del("deleteCap", "/caps/:id")
			.setPath(MobileVideoPath)
			.addSuccess(MobileSuccessResponse)
			.middleware(HttpAuthMiddleware)
			.addError(HttpApiError.Forbidden)
			.addError(HttpApiError.NotFound),
	)
	.add(
		HttpApiEndpoint.get("getPlayback", "/caps/:id/playback")
			.setPath(MobileVideoPath)
			.addSuccess(MobilePlaybackResponse)
			.middleware(HttpAuthMiddleware)
			.addError(HttpApiError.Forbidden)
			.addError(HttpApiError.NotFound),
	)
	.add(
		HttpApiEndpoint.get("getDownload", "/caps/:id/download")
			.setPath(MobileVideoPath)
			.addSuccess(MobileDownloadResponse)
			.middleware(HttpAuthMiddleware)
			.addError(HttpApiError.Forbidden)
			.addError(HttpApiError.NotFound),
	)
	.add(
		HttpApiEndpoint.post("createComment", "/caps/:id/comments")
			.setPath(MobileVideoPath)
			.setPayload(MobileCommentCreateInput)
			.addSuccess(MobileComment)
			.middleware(HttpAuthMiddleware)
			.addError(HttpApiError.Forbidden)
			.addError(HttpApiError.NotFound),
	)
	.add(
		HttpApiEndpoint.del("deleteComment", "/comments/:id")
			.setPath(MobileCommentPath)
			.addSuccess(MobileSuccessResponse)
			.middleware(HttpAuthMiddleware)
			.addError(HttpApiError.Forbidden)
			.addError(HttpApiError.NotFound),
	)
	.add(
		HttpApiEndpoint.post("createReaction", "/caps/:id/reactions")
			.setPath(MobileVideoPath)
			.setPayload(MobileReactionCreateInput)
			.addSuccess(MobileComment)
			.middleware(HttpAuthMiddleware)
			.addError(HttpApiError.Forbidden)
			.addError(HttpApiError.NotFound),
	)
	.add(
		HttpApiEndpoint.post("createUpload", "/uploads")
			.setPayload(MobileUploadCreateInput)
			.addSuccess(MobileUploadCreateResponse)
			.middleware(HttpAuthMiddleware)
			.addError(HttpApiError.Forbidden)
			.addError(HttpApiError.NotFound),
	)
	.add(
		HttpApiEndpoint.post("updateUploadProgress", "/uploads/:id/progress")
			.setPath(MobileUploadPath)
			.setPayload(MobileUploadProgressInput)
			.addSuccess(MobileSuccessResponse)
			.middleware(HttpAuthMiddleware)
			.addError(HttpApiError.Forbidden)
			.addError(HttpApiError.NotFound),
	)
	.add(
		HttpApiEndpoint.post("completeUpload", "/uploads/:id/complete")
			.setPath(MobileUploadPath)
			.setPayload(MobileUploadCompleteInput)
			.addSuccess(MobileSuccessResponse)
			.middleware(HttpAuthMiddleware)
			.addError(HttpApiError.Forbidden)
			.addError(HttpApiError.NotFound),
	)
	.add(
		HttpApiEndpoint.post("createRecording", "/recordings")
			.setPayload(MobileRecordingCreateInput)
			.addSuccess(MobileRecordingCreateResponse)
			.middleware(HttpAuthMiddleware)
			.addError(HttpApiError.BadRequest)
			.addError(HttpApiError.Forbidden)
			.addError(HttpApiError.NotFound),
	)
	.add(
		HttpApiEndpoint.post(
			"createRecordingUploadTargets",
			"/recordings/:id/segments/targets",
		)
			.setPath(MobileUploadPath)
			.setPayload(MobileRecordingUploadTargetsInput)
			.addSuccess(MobileRecordingUploadTargetsResponse)
			.middleware(HttpAuthMiddleware)
			.addError(HttpApiError.BadRequest)
			.addError(HttpApiError.Forbidden)
			.addError(HttpApiError.NotFound),
	)
	.add(
		HttpApiEndpoint.post("completeRecording", "/recordings/:id/complete")
			.setPath(MobileUploadPath)
			.setPayload(MobileRecordingCompleteInput)
			.addSuccess(MobileSuccessResponse)
			.middleware(HttpAuthMiddleware)
			.addError(HttpApiError.BadRequest)
			.addError(HttpApiError.Forbidden)
			.addError(HttpApiError.NotFound),
	) {}

export class MobileApiContract extends HttpApi.make("cap-mobile-api")
	.add(MobileHttpApi)
	.annotateContext(
		OpenApi.annotations({
			title: "Cap Mobile API",
			description: "Authenticated API used by the Cap iOS app",
		}),
	)
	.prefix("/api/mobile") {}
