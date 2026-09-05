import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { nanoIdLength } from "@cap/database/helpers";
import {
	comments,
	organizationMembers,
	organizations,
	sharedVideos,
	spaces,
	spaceVideos,
	users,
	videoEdits,
	videos,
	videoUploads,
} from "@cap/database/schema";
import type { VideoMetadata } from "@cap/database/types";
import { buildEnv, serverEnv } from "@cap/env";
import { Logo } from "@cap/ui";
import { userIsPro } from "@cap/utils";
import {
	Database,
	ImageUploads,
	provideOptionalAuth,
	resolveEffectiveVideoRules,
	Videos,
} from "@cap/web-backend";
import { VideosPolicy } from "@cap/web-backend/src/Videos/VideosPolicy";
import {
	Comment,
	type ImageUpload,
	type Organisation,
	type Policy,
	type Video,
} from "@cap/web-domain";
import { and, eq, type InferSelectModel, isNull, sql } from "drizzle-orm";
import { Effect, Option } from "effect";
import type { Metadata } from "next";
import { headers } from "next/headers";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getVideoAnalytics } from "@/actions/videos/get-analytics";
import {
	getDashboardSpacesData,
	type OrganizationSettings,
	type Spaces,
} from "@/app/(org)/dashboard/dashboard-data";
import { isAiConfigured } from "@/lib/ai/provider";
import { completeDesktopSegmentsManifestAndQueue } from "@/lib/desktop-segments-recovery";
import { createNotification } from "@/lib/Notification";
import {
	canManageOrganizationSettings,
	getEffectiveOrganizationRole,
} from "@/lib/permissions/roles";
import { resolveDefaultPlaybackSpeed } from "@/lib/playback-speed";
import { getPublicShareVideo } from "@/lib/public-share-video";
import * as EffectRuntime from "@/lib/server";
import { runPromise } from "@/lib/server";
import { getSharePageBranding } from "@/lib/share-branding";
import { buildShareVideoMetadata } from "@/lib/share-video-metadata";
import { resolveShareWebUrl } from "@/lib/share-web-url";
import { isVideoOverShareableLinkLimit } from "@/lib/shareable-link-quota";
import {
	isIframelyCrawlerUserAgent,
	isSocialCrawlerUserAgent,
	SOCIAL_REFERRER_DOMAINS,
} from "@/lib/social-crawlers";
import { transcribeVideo } from "@/lib/transcribe";
import { canUserDownloadVideo } from "@/lib/video-download-permissions";
import {
	isEditSourceKey,
	reconcileStaleEditUpload,
} from "@/lib/video-edit-processing";
import {
	areEditSpecsEquivalent,
	createIdentityEditSpec,
} from "@/lib/video-edits";
import { optionFromTOrFirst } from "@/utils/effect";
import { isAiGenerationEnabled } from "@/utils/flags";
import { PasswordOverlay } from "./_components/PasswordOverlay";
import { PendingRecordingShare } from "./_components/PendingRecordingShare";
import { ShareHeader } from "./_components/ShareHeader";
import { Share } from "./Share";

const VIEW_NOTIFICATION_DELAY_MS = 2 * 60 * 1000;
const VIDEO_ID_PATTERN = /^[0-9abcdefghjkmnpqrstvwxyz]+$/;

type ShareVideoSearchParams = {
	[key: string]: string | string[] | undefined;
};

const isValidVideoIdParam = (videoId: string) =>
	videoId.length === nanoIdLength && VIDEO_ID_PATTERN.test(videoId);

const hasRecordingStoppedParam = (searchParams: ShareVideoSearchParams) => {
	const recordingStoppedParam = Array.isArray(searchParams.recordingStopped)
		? searchParams.recordingStopped[0]
		: searchParams.recordingStopped;

	return recordingStoppedParam === "1" || recordingStoppedParam === "true";
};

function toShareVideo<
	T extends {
		password: unknown;
		ownerId: unknown;
		organizationTombstoneAt: Date | null;
	},
>(row: T) {
	const {
		password: _password,
		ownerId: _ownerId,
		organizationTombstoneAt: _organizationTombstoneAt,
		...video
	} = row;
	return video;
}

// Helper function to fetch shared spaces data for a video
async function getSharedSpacesForVideo(videoId: Video.VideoId) {
	// Space-level and organization-level sharing are independent queries.
	const [spaceSharing, orgSharing] = await Promise.all([
		db()
			.select({
				id: spaces.id,
				name: spaces.name,
				organizationId: spaces.organizationId,
				iconUrl: spaces.iconUrl,
				settings: spaces.settings,
				hasPassword: sql`${spaces.password} IS NOT NULL`.mapWith(Boolean),
			})
			.from(spaceVideos)
			.innerJoin(spaces, eq(spaceVideos.spaceId, spaces.id))
			.innerJoin(organizations, eq(spaces.organizationId, organizations.id))
			.where(eq(spaceVideos.videoId, videoId)),
		db()
			.select({
				id: organizations.id,
				name: organizations.name,
				organizationId: organizations.id,
				iconUrl: organizations.iconUrl,
			})
			.from(sharedVideos)
			.innerJoin(
				organizations,
				eq(sharedVideos.organizationId, organizations.id),
			)
			.where(eq(sharedVideos.videoId, videoId)),
	]);

	const sharedSpaces: Array<{
		id: string;
		name: string;
		organizationId: string;
		iconUrl?: string;
		settings?: OrganizationSettings | null;
		hasPassword?: boolean;
	}> = [];

	// Add space-level sharing
	spaceSharing.forEach((space) => {
		sharedSpaces.push({
			id: space.id,
			name: space.name,
			organizationId: space.organizationId,
			iconUrl: space.iconUrl || undefined,
			settings: space.settings,
			hasPassword: space.hasPassword,
		});
	});

	// Add organization-level sharing
	orgSharing.forEach((org) => {
		sharedSpaces.push({
			id: org.id,
			name: org.name,
			organizationId: org.organizationId,
			iconUrl: org.iconUrl || undefined,
			settings: null,
			hasPassword: false,
		});
	});

	return sharedSpaces;
}

function PolicyDeniedView({
	reason,
	videoId,
}: {
	reason?: string;
	videoId: string;
}) {
	const loginHref = `/login?next=/s/${videoId}`;
	let title = "This video is private";
	let description: React.ReactNode = (
		<>
			If you own this video, please <Link href={loginHref}>sign in</Link> to
			manage sharing.
		</>
	);

	if (reason === "email_restriction_login_required") {
		title = "This video requires sign-in";
		description = (
			<>
				The owner of this video has restricted access. Please{" "}
				<Link href={loginHref}>sign in</Link> with an authorized email address to
				view.
			</>
		);
	} else if (reason === "email_restriction_denied") {
		title = "Access restricted";
		description =
			"Your email address does not meet the requirements set by the video owner.";
	}

	return (
		<div className="flex flex-col justify-center items-center p-4 min-h-screen text-center">
			<Logo className="size-32" />
			<h1 className="mb-2 text-2xl font-semibold">{title}</h1>
			<p className="text-gray-400">{description}</p>
			{reason !== "email_restriction_denied" ? (
				<Link
					href={loginHref}
					className="mt-4 inline-flex items-center rounded-full bg-gray-12 px-4 py-2 text-sm font-semibold text-gray-1"
				>
					Sign in
				</Link>
			) : null}
		</div>
	);
}

const renderPolicyDenied = (videoId: Video.VideoId, reason?: string) =>
	Effect.succeed(
		<PolicyDeniedView key={videoId} videoId={videoId} reason={reason} />,
	);

const renderNoSuchElement = (awaitRecording: boolean) =>
	awaitRecording
		? Effect.succeed(<PendingRecordingShare />)
		: Effect.sync(() => notFound());

const getShareVideoPageCatchers = (
	videoId: Video.VideoId,
	awaitRecording: boolean,
) => ({
	PolicyDenied: (e: Policy.PolicyDeniedError) =>
		renderPolicyDenied(videoId, e.reason),
	NoSuchElementException: () => renderNoSuchElement(awaitRecording),
});

export async function generateMetadata(
	props: PageProps<"/s/[videoId]">,
): Promise<Metadata> {
	const params = await props.params;
	const searchParams = await props.searchParams;
	const videoId = params.videoId as Video.VideoId;
	const awaitRecording =
		isValidVideoIdParam(videoId) && hasRecordingStoppedParam(searchParams);

	const headersList = await headers();
	const referrer =
		headersList.get("x-referrer") || headersList.get("referer") || "";
	const requestUserAgent = headersList.get("user-agent") || "";
	const isAllowedReferrer = SOCIAL_REFERRER_DOMAINS.some((domain) =>
		referrer.includes(domain),
	);
	const canRenderSocialPreview =
		isAllowedReferrer || isSocialCrawlerUserAgent(requestUserAgent);
	const shouldAdvertiseIframelyPlayer =
		isIframelyCrawlerUserAgent(requestUserAgent) &&
		(await getPublicShareVideo(videoId).catch(() => null)) !== null;
	// Share pages also serve verified custom domains. Metadata has to point at
	// the host the visitor used, or Slack drops the preview image.
	const webUrl = await resolveShareWebUrl(headersList);
	const ogImageUrl = new URL(
		`/api/video/og?videoId=${videoId}`,
		webUrl,
	).toString();

	return Effect.flatMap(Videos, (v) => v.getByIdForViewing(videoId)).pipe(
		Effect.map(
			Option.match({
				onNone: () =>
					awaitRecording
						? {
								title: "Cap: Preparing Video",
								description: "This recording is being made available.",
								robots: "noindex, nofollow",
							}
						: notFound(),
				onSome: ([video]) => {
					return {
						...buildShareVideoMetadata({
							videoId,
							name: video.name,
							sourceType: video.source.type,
							webUrl,
							canonicalWebUrl: buildEnv.NEXT_PUBLIC_WEB_URL,
							advertiseIframelyPlayer: shouldAdvertiseIframelyPlayer,
						}),
						robots: canRenderSocialPreview
							? "index, follow"
							: "noindex, nofollow",
					};
				},
			}),
		),
		Effect.catchTags({
			PolicyDenied: () =>
				Effect.succeed({
					title: "Cap: This video is restricted",
					description: "This video has restricted access.",
					openGraph: {
						images: [{ url: ogImageUrl, width: 1200, height: 630 }],
					},
					robots: "noindex, nofollow",
				}),
			VerifyVideoPasswordError: () =>
				Effect.succeed({
					title: "Cap: Password Protected Video",
					description: "This video is password protected.",
					openGraph: {
						images: [{ url: ogImageUrl, width: 1200, height: 630 }],
					},
					twitter: {
						card: "summary_large_image",
						title: "Cap: Password Protected Video",
						description: "This video is password protected.",
						images: [ogImageUrl],
					},
					robots: "noindex, nofollow",
				}),
		}),
		provideOptionalAuth,
		EffectRuntime.runPromise,
	);
}

export default async function ShareVideoPage(props: PageProps<"/s/[videoId]">) {
	const params = await props.params;
	const searchParams = await props.searchParams;
	const videoId = params.videoId as Video.VideoId;
	const awaitRecording =
		isValidVideoIdParam(videoId) && hasRecordingStoppedParam(searchParams);

	await reconcileStaleEditUpload(videoId);

	return Effect.gen(function* () {
		const videosPolicy = yield* VideosPolicy;

		const [row] = yield* Effect.promise(() =>
			db()
				.select({
					id: videos.id,
					name: videos.name,
					orgId: videos.orgId,
					createdAt: videos.createdAt,
					updatedAt: videos.updatedAt,
					effectiveCreatedAt: videos.effectiveCreatedAt,
					bucket: videos.bucket,
					storageIntegrationId: videos.storageIntegrationId,
					metadata: videos.metadata,
					public: videos.public,
					videoStartTime: videos.videoStartTime,
					audioStartTime: videos.audioStartTime,
					awsRegion: videos.awsRegion,
					awsBucket: videos.awsBucket,
					xStreamInfo: videos.xStreamInfo,
					jobId: videos.jobId,
					jobStatus: videos.jobStatus,
					isScreenshot: videos.isScreenshot,
					skipProcessing: videos.skipProcessing,
					transcriptionStatus: videos.transcriptionStatus,
					source: videos.source,
					videoSettings: videos.settings,
					width: videos.width,
					height: videos.height,
					duration: videos.duration,
					fps: videos.fps,
					firstViewEmailSentAt: videos.firstViewEmailSentAt,
					hasPassword: sql`${videos.password} IS NOT NULL`.mapWith(Boolean),
					sharedOrganization: {
						organizationId: sharedVideos.organizationId,
					},
					orgSettings: organizations.settings,
					organizationName: organizations.name,
					organizationIconUrl: organizations.iconUrl,
					shareableLinkIconUrl: organizations.shareableLinkIconUrl,
					hasActiveUpload:
						sql`${videoUploads.videoId} IS NOT NULL AND ${videos.isScreenshot} = false`.mapWith(
							Boolean,
						),
					activeUploadRawFileKey: videoUploads.rawFileKey,
					owner: users,
					ownerId: videos.ownerId,
					password: videos.password,
					organizationTombstoneAt: organizations.tombstoneAt,
				})
				.from(videos)
				.leftJoin(sharedVideos, eq(videos.id, sharedVideos.videoId))
				.innerJoin(users, eq(videos.ownerId, users.id))
				.leftJoin(videoUploads, eq(videos.id, videoUploads.videoId))
				.leftJoin(organizations, eq(videos.orgId, organizations.id))
				.where(eq(videos.id, videoId)),
		);

		// The access decision runs on the row already loaded above instead of
		// re-reading it, and stays ahead of the tombstone check so a denied or
		// password-gated video on a deleted org still resolves the way it did
		// when the policy ran before the select.
		if (row) {
			yield* videosPolicy.canViewLoaded(row, Option.fromNullable(row.password));
		}

		return Option.fromNullable(
			row && row.organizationTombstoneAt === null ? toShareVideo(row) : null,
		);
	}).pipe(
		Effect.flatten,
		Effect.map((video) => ({ needsPassword: false, video }) as const),
		Effect.catchTag("VerifyVideoPasswordError", () =>
			Effect.succeed({ needsPassword: true } as const),
		),
		Effect.map((data) => (
			// overflow-x-clip: the timeline view's theater strip breaks out to
			// 100vw, which overshoots by the scrollbar width on OSes with classic
			// scrollbars; clipping here keeps the page from gaining a horizontal
			// scroll without creating a new scroll container.
			// Desktop pins the page to the viewport so the comments rail can run
			// full height and the video column scrolls on its own; phones keep
			// ordinary document flow.
			<div
				key={videoId}
				className="flex overflow-x-clip flex-col min-h-screen bg-gray-2 lg:h-screen lg:min-h-0 lg:overflow-hidden"
			>
				<PasswordOverlay isOpen={data.needsPassword} videoId={videoId} />
				{!data.needsPassword && (
					<AuthorizedContent video={data.video} searchParams={searchParams} />
				)}
			</div>
		)),
		Effect.catchTags(getShareVideoPageCatchers(videoId, awaitRecording)),
		provideOptionalAuth,
		EffectRuntime.runPromise,
	);
}

async function AuthorizedContent({
	video,
	searchParams,
}: {
	video: Omit<
		InferSelectModel<typeof videos>,
		"folderId" | "password" | "settings" | "ownerId"
	> & {
		owner: InferSelectModel<typeof users>;
		sharedOrganization: { organizationId: Organisation.OrganisationId } | null;
		hasPassword: boolean;
		hasActiveUpload: boolean;
		activeUploadRawFileKey: string | null;
		orgSettings?: OrganizationSettings | null;
		videoSettings?: OrganizationSettings | null;
		organizationName?: string | null;
		organizationIconUrl?: ImageUpload.ImageUrlOrKey | null;
		shareableLinkIconUrl?: ImageUpload.ImageUrlOrKey | null;
	};
	searchParams: ShareVideoSearchParams;
}) {
	// will have already been fetched if auth is required
	const user = await getCurrentUser();
	const videoId = video.id;
	let recoveredDesktopSegmentsUpload = false;

	if (
		user?.id === video.owner.id &&
		!video.isScreenshot &&
		video.source?.type === "desktopSegments" &&
		!video.hasActiveUpload &&
		serverEnv().MEDIA_SERVER_URL
	) {
		try {
			const result = await completeDesktopSegmentsManifestAndQueue({
				videoId,
				userId: user.id,
			});
			recoveredDesktopSegmentsUpload =
				result.status === "queued" ||
				result.status === "already-processing" ||
				result.status === "source-committing";
		} catch (error) {
			console.error(
				`[ShareVideoPage] Failed to recover desktop segments upload ${videoId}:`,
				error,
			);
		}
	}

	const hasActiveUpload =
		video.hasActiveUpload || recoveredDesktopSegmentsUpload;
	const canRegisterView =
		!hasActiveUpload &&
		Date.now() - video.updatedAt.getTime() >= VIEW_NOTIFICATION_DELAY_MS;

	if (user && video && user.id !== video.owner.id && canRegisterView) {
		try {
			await createNotification({
				type: "view",
				videoId: video.id,
				authorId: user.id,
			});
		} catch (error) {
			console.warn("Failed to create view notification:", error);
		}
	}

	const userId = user?.id;
	const commentId = optionFromTOrFirst(searchParams.comment).pipe(
		Option.map(Comment.CommentId.make),
	);
	const replyId = optionFromTOrFirst(searchParams.reply).pipe(
		Option.map(Comment.CommentId.make),
	);
	const recordingStopped = hasRecordingStoppedParam(searchParams);

	// Everything below is an independent round trip (DB or storage); each is
	// started here and awaited together further down, so the page pays for the
	// slowest one instead of the sum of all of them.
	const spacesDataPromise: Promise<Spaces[] | null> = user
		? getDashboardSpacesData(user).catch((error) => {
				console.error("Failed to fetch spaces data for sharing dialog:", error);
				return [];
			})
		: Promise.resolve(null);

	const sharedSpacesPromise = getSharedSpacesForVideo(videoId);

	const ownerIsPro = userIsPro(video.owner);

	// Fail-open: a broken count must never take the share page down.
	const overShareLimitPromise = ownerIsPro
		? Promise.resolve(false)
		: isVideoOverShareableLinkLimit({
				id: videoId,
				ownerId: video.owner.id,
				createdAt: video.createdAt,
				isScreenshot: video.isScreenshot,
			}).catch((error) => {
				console.error(
					`[ShareVideoPage] Shareable link quota check failed for ${videoId}:`,
					error,
				);
				return false;
			});

	const aiGenerationEnabledPromise = isAiGenerationEnabled(video.owner);

	const screenshotImageUrlPromise = video.isScreenshot
		? Effect.flatMap(Videos, (videos) => videos.getThumbnailURL(videoId)).pipe(
				Effect.map(Option.getOrNull),
				runPromise,
			)
		: Promise.resolve(null);

	const customDomainPromise = (async () => {
		if (!user) {
			return { customDomain: null, domainVerified: false };
		}
		const activeOrganizationId = user.activeOrganizationId;
		if (!activeOrganizationId) {
			return { customDomain: null, domainVerified: false };
		}

		// Fetch the active org
		const orgArr = await db()
			.select({
				customDomain: organizations.customDomain,
				domainVerified: organizations.domainVerified,
			})
			.from(organizations)
			.where(eq(organizations.id, activeOrganizationId))
			.limit(1);

		const org = orgArr[0];
		if (
			org?.customDomain &&
			org.domainVerified !== null &&
			user.id === video.owner.id
		) {
			return { customDomain: org.customDomain, domainVerified: true };
		}
		return { customDomain: null, domainVerified: false };
	})();

	const sharedOrganizationsPromise = db()
		.select({ id: sharedVideos.organizationId, name: organizations.name })
		.from(sharedVideos)
		.innerJoin(organizations, eq(sharedVideos.organizationId, organizations.id))
		.where(eq(sharedVideos.videoId, videoId));

	const userOrganizationsPromise = (async () => {
		if (!userId) return [];

		const [ownedOrganizations, memberOrganizations] = await Promise.all([
			db()
				.select({ id: organizations.id, name: organizations.name })
				.from(organizations)
				.where(eq(organizations.ownerId, userId)),
			db()
				.select({ id: organizations.id, name: organizations.name })
				.from(organizations)
				.innerJoin(
					organizationMembers,
					eq(organizations.id, organizationMembers.organizationId),
				)
				.where(eq(organizationMembers.userId, userId)),
		]);

		const allOrganizations = [...ownedOrganizations, ...memberOrganizations];
		const uniqueOrganizationIds = new Set();

		return allOrganizations.filter((organization) => {
			if (uniqueOrganizationIds.has(organization.id)) return false;
			uniqueOrganizationIds.add(organization.id);
			return true;
		});
	})();

	const membersListPromise = video.sharedOrganization?.organizationId
		? db()
				.select({ userId: organizationMembers.userId })
				.from(organizationMembers)
				.where(
					eq(
						organizationMembers.organizationId,
						video.sharedOrganization.organizationId,
					),
				)
		: Promise.resolve([]);

	const commentsPromise = Effect.gen(function* () {
		const db = yield* Database;
		const imageUploads = yield* ImageUploads;

		let toplLevelCommentId = Option.none<Comment.CommentId>();

		if (Option.isSome(replyId)) {
			const [parentComment] = yield* db.use((db) =>
				db
					.select({ parentCommentId: comments.parentCommentId })
					.from(comments)
					.where(eq(comments.id, replyId.value))
					.limit(1),
			);
			toplLevelCommentId = Option.fromNullable(parentComment?.parentCommentId);
		}

		const commentToBringToTheTop = Option.orElse(
			toplLevelCommentId,
			() => commentId,
		);

		return yield* db
			.use((db) =>
				db
					.select({
						id: comments.id,
						content: comments.content,
						timestamp: comments.timestamp,
						type: comments.type,
						authorId: comments.authorId,
						videoId: comments.videoId,
						createdAt: comments.createdAt,
						updatedAt: comments.updatedAt,
						parentCommentId: comments.parentCommentId,
						mediaKey: comments.mediaKey,
						mediaDuration: comments.mediaDuration,
						mediaMeta: comments.mediaMeta,
						authorName: users.name,
						authorImage: users.image,
					})
					.from(comments)
					.leftJoin(users, eq(comments.authorId, users.id))
					.where(eq(comments.videoId, videoId))
					.orderBy(
						Option.match(commentToBringToTheTop, {
							onSome: (commentId) =>
								sql`CASE WHEN ${comments.id} = ${commentId} THEN 0 ELSE 1 END, ${comments.createdAt}`,
							onNone: () => comments.createdAt,
						}),
					),
			)
			.pipe(
				Effect.map((comments) =>
					comments.map(
						Effect.fn(function* (c) {
							return Object.assign(c, {
								authorImage: yield* Option.fromNullable(c.authorImage).pipe(
									Option.map(imageUploads.resolveImageUrl),
									Effect.transposeOption,
									Effect.map(Option.getOrNull),
								),
							});
						}),
					),
				),
				Effect.flatMap(Effect.all),
			);
	}).pipe(EffectRuntime.runPromise);

	const viewsPromise = getVideoAnalytics(videoId).then((v) => v.count);

	const canManageSharePageBrandingPromise = (async () => {
		if (!userId) return false;

		const [organizationAccess] = await db()
			.select({
				ownerId: organizations.ownerId,
				memberRole: organizationMembers.role,
			})
			.from(organizations)
			.leftJoin(
				organizationMembers,
				and(
					eq(organizationMembers.organizationId, organizations.id),
					eq(organizationMembers.userId, userId),
				),
			)
			.where(
				and(
					eq(organizations.id, video.orgId),
					isNull(organizations.tombstoneAt),
				),
			)
			.limit(1);

		if (!organizationAccess) return false;

		return canManageOrganizationSettings(
			getEffectiveOrganizationRole({
				userId,
				ownerId: organizationAccess.ownerId,
				memberRole: organizationAccess.memberRole,
			}),
		);
	})();

	const isVideoDownloadReady =
		!hasActiveUpload && video.source?.type !== "desktopSegments";

	const canDownloadVideoPromise =
		userId && isVideoDownloadReady
			? canUserDownloadVideo({
					userId,
					ownerId: video.owner.id,
					videoId,
				})
			: Promise.resolve(false);

	const videoHasEditsPromise = canDownloadVideoPromise.then((canDownload) => {
		if (!canDownload || video.isScreenshot) return false;
		return db()
			.select({ editSpec: videoEdits.editSpec })
			.from(videoEdits)
			.where(eq(videoEdits.videoId, videoId))
			.then(([videoEditRow]) =>
				videoEditRow
					? !areEditSpecsEquivalent(
							videoEditRow.editSpec,
							createIdentityEditSpec(videoEditRow.editSpec.sourceDuration),
						)
					: false,
			);
	});

	const [
		spacesData,
		sharedSpaces,
		aiGenerationEnabled,
		screenshotImageUrl,
		membersList,
		userOrganizations,
		sharedOrganizations,
		{ customDomain, domainVerified },
		canManageSharePageBranding,
		canDownloadVideo,
		videoHasEdits,
		ownerIsOverShareLimit,
	] = await Promise.all([
		spacesDataPromise,
		sharedSpacesPromise,
		aiGenerationEnabledPromise,
		screenshotImageUrlPromise,
		membersListPromise,
		userOrganizationsPromise,
		sharedOrganizationsPromise,
		customDomainPromise,
		canManageSharePageBrandingPromise,
		canDownloadVideoPromise,
		videoHasEditsPromise,
		overShareLimitPromise,
	]);

	const rules = resolveEffectiveVideoRules({
		videoSettings: video.videoSettings,
		organizationSettings: video.orgSettings,
		spaces: sharedSpaces.filter((space) => space.id !== space.organizationId),
	});
	const env = serverEnv();
	const transcriptionGenerationAvailable =
		!video.isScreenshot &&
		Boolean(env.ASSEMBLY_API_KEY) &&
		!rules.settings.disableTranscript;
	const aiProviderAvailable = isAiConfigured();

	if (
		transcriptionGenerationAvailable &&
		!hasActiveUpload &&
		video.transcriptionStatus !== "COMPLETE" &&
		video.transcriptionStatus !== "PROCESSING" &&
		video.transcriptionStatus !== "SKIPPED" &&
		video.transcriptionStatus !== "NO_AUDIO" &&
		video.transcriptionStatus !== "ERROR"
	) {
		console.log("[ShareVideoPage] Starting transcription for video:", videoId);
		transcribeVideo(videoId, video.owner.id, aiGenerationEnabled).catch(
			(error) => {
				console.error(
					`[ShareVideoPage] Error transcribing video ${videoId}:`,
					error,
				);
			},
		);
	}

	const metadata = (video.metadata as VideoMetadata) || {};
	const aiGenerationStatus = metadata.aiGenerationStatus || null;

	const initialAiData = {
		title: metadata.aiTitle || null,
		summary: metadata.summary || null,
		chapters: metadata.chapters || null,
		aiGenerationStatus,
	};

	const videoWithOrganizationInfo = await Effect.gen(function* () {
		const imageUploads = yield* ImageUploads;

		return {
			...video,
			hasActiveUpload,
			ownerIsOverShareLimit,
			owner: {
				id: video.owner.id,
				name: video.owner.name,
				isPro: ownerIsPro,
				image: video.owner.image
					? yield* imageUploads.resolveImageUrl(video.owner.image)
					: null,
			},
			organization: {
				organizationMembers: membersList.map((member) => member.userId),
				organizationId: video.sharedOrganization?.organizationId ?? undefined,
			},
			sharedOrganizations: sharedOrganizations,
			password: null,
			folderId: null,
			orgSettings: video.orgSettings || null,
			organizationName: video.organizationName,
			organizationIconUrl: video.organizationIconUrl
				? yield* imageUploads.resolveImageUrl(video.organizationIconUrl)
				: null,
			shareableLinkIconUrl: video.shareableLinkIconUrl
				? yield* imageUploads.resolveImageUrl(video.shareableLinkIconUrl)
				: null,
			settings: rules.settings,
			hasInheritedPassword: rules.hasInheritedPassword,
			inheritedPasswordSources: rules.inheritedPasswordSources,
			inheritedSpaceSettings: rules.inheritedSettings,
		};
	}).pipe(runPromise);
	const isEditProcessing =
		isEditSourceKey({
			ownerId: video.owner.id,
			videoId,
			rawFileKey: video.activeUploadRawFileKey,
		}) && !video.isScreenshot;

	const defaultPlaybackSpeed = resolveDefaultPlaybackSpeed(
		video.videoSettings?.defaultPlaybackSpeed,
		video.orgSettings?.defaultPlaybackSpeed,
	);

	const initialShareView =
		optionFromTOrFirst(searchParams.view).pipe(Option.getOrNull) ===
			"timeline" && !video.isScreenshot
			? ("timeline" as const)
			: ("classic" as const);
	// Recording media comments rides on the VIDEO OWNER's Pro plan; the
	// upload/create paths re-check server-side via canUseMediaComments.
	const canRecordMedia = Boolean(user) && videoWithOrganizationInfo.owner.isPro;

	// Bottom padding lives in Share (classic view only): the timeline view's
	// theater strip must end flush with the viewport, and Share is the one that
	// knows which view is active. Gutters moved into Share too — the comments
	// rail is flush to the viewport edge, so only the video column is centred
	// in a container.
	return (
		<div className="flex flex-col flex-1 min-h-0">
			<Share
				header={
					<ShareHeader
						data={{
							...videoWithOrganizationInfo,
							createdAt: video.metadata?.customCreatedAt
								? new Date(video.metadata.customCreatedAt)
								: video.createdAt,
						}}
						customDomain={customDomain}
						domainVerified={domainVerified}
						sharedOrganizations={
							videoWithOrganizationInfo.sharedOrganizations || []
						}
						sharedSpaces={sharedSpaces}
						userOrganizations={userOrganizations}
						spacesData={spacesData}
						branding={getSharePageBranding(videoWithOrganizationInfo)}
						canManageSharePageBranding={canManageSharePageBranding}
						canDownload={canDownloadVideo}
						hasEdits={videoHasEdits}
						// Caught separately from the copy the sidebar consumes: the
						// header renders for everyone, and a failed count is worth
						// less than the header it would otherwise take down.
						views={viewsPromise.catch(() => null)}
					/>
				}
				data={videoWithOrganizationInfo}
				screenshotImageUrl={screenshotImageUrl}
				videoSettings={videoWithOrganizationInfo.settings}
				comments={commentsPromise}
				views={viewsPromise}
				customDomain={customDomain}
				domainVerified={domainVerified}
				userOrganizations={userOrganizations}
				viewerId={user?.id ?? null}
				viewerSignedIn={user !== null}
				initialView={initialShareView}
				canRecordMedia={canRecordMedia}
				isEditProcessing={isEditProcessing}
				recordingStopped={recordingStopped}
				defaultPlaybackSpeed={defaultPlaybackSpeed}
				initialAiData={initialAiData}
				aiGenerationAvailable={aiGenerationEnabled && aiProviderAvailable}
				transcriptionGenerationAvailable={transcriptionGenerationAvailable}
			/>
		</div>
	);
}
