import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import {
	comments,
	organizationMembers,
	organizations,
	sharedVideos,
	spaces,
	spaceVideos,
	users,
	videos,
	videoUploads,
} from "@cap/database/schema";
import type { VideoMetadata } from "@cap/database/types";
import { buildEnv } from "@cap/env";
import { Logo } from "@cap/ui";
import { userIsPro } from "@cap/utils";
import {
	Database,
	ImageUploads,
	provideOptionalAuth,
	Videos,
} from "@cap/web-backend";
import { VideosPolicy } from "@cap/web-backend/src/Videos/VideosPolicy";
import {
	Comment,
	type Organisation,
	Policy,
	type Video,
} from "@cap/web-domain";
import { and, eq, type InferSelectModel, isNull, sql } from "drizzle-orm";
import { Effect, Option } from "effect";
import type { Metadata } from "next";
import { headers } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getVideoAnalytics } from "@/actions/videos/get-analytics";
import {
	getDashboardData,
	type OrganizationSettings,
} from "@/app/(org)/dashboard/dashboard-data";
import { createNotification } from "@/lib/Notification";
import * as EffectRuntime from "@/lib/server";
import { runPromise } from "@/lib/server";
import { transcribeVideo } from "@/lib/transcribe";
import { optionFromTOrFirst } from "@/utils/effect";
import { isAiGenerationEnabled } from "@/utils/flags";
import { PasswordOverlay } from "./_components/PasswordOverlay";
import { ShareHeader } from "./_components/ShareHeader";
import { Share } from "./Share";

// Helper function to fetch shared spaces data for a video
async function getSharedSpacesForVideo(videoId: Video.VideoId) {
	// Fetch space-level sharing
	const spaceSharing = await db()
		.select({
			id: spaces.id,
			name: spaces.name,
			organizationId: spaces.organizationId,
			iconUrl: organizations.iconUrl,
		})
		.from(spaceVideos)
		.innerJoin(spaces, eq(spaceVideos.spaceId, spaces.id))
		.innerJoin(organizations, eq(spaces.organizationId, organizations.id))
		.where(eq(spaceVideos.videoId, videoId));

	// Fetch organization-level sharing
	const orgSharing = await db()
		.select({
			id: organizations.id,
			name: organizations.name,
			organizationId: organizations.id,
			iconUrl: organizations.iconUrl,
		})
		.from(sharedVideos)
		.innerJoin(organizations, eq(sharedVideos.organizationId, organizations.id))
		.where(eq(sharedVideos.videoId, videoId));

	const sharedSpaces: Array<{
		id: string;
		name: string;
		organizationId: string;
		iconUrl?: string;
	}> = [];

	// Add space-level sharing
	spaceSharing.forEach((space) => {
		sharedSpaces.push({
			id: space.id,
			name: space.name,
			organizationId: space.organizationId,
			iconUrl: space.iconUrl || undefined,
		});
	});

	// Add organization-level sharing
	orgSharing.forEach((org) => {
		sharedSpaces.push({
			id: org.id,
			name: org.name,
			organizationId: org.organizationId,
			iconUrl: org.iconUrl || undefined,
		});
	});

	return sharedSpaces;
}

const ALLOWED_REFERRERS = [
	"x.com",
	"twitter.com",
	"facebook.com",
	"fb.com",
	"slack.com",
	"notion.so",
	"linkedin.com",
];

function PolicyDeniedView() {
	return (
		<div className="flex flex-col justify-center items-center p-4 min-h-screen text-center">
			<Logo className="size-32" />
			<h1 className="mb-2 text-2xl font-semibold">This video is private</h1>
			<p className="text-gray-400">
				If you own this video, please <Link href="/login">sign in</Link> to
				manage sharing.
			</p>
		</div>
	);
}

const renderPolicyDenied = (videoId: Video.VideoId) =>
	Effect.succeed(<PolicyDeniedView key={videoId} />);

const renderNoSuchElement = () => Effect.sync(() => redirect("/dashboard"));

const getShareVideoPageCatchers = (videoId: Video.VideoId) => ({
	PolicyDenied: () => renderPolicyDenied(videoId),
	NoSuchElementException: renderNoSuchElement,
});

export async function generateMetadata(
	props: PageProps<"/s/[videoId]">,
): Promise<Metadata> {
	const params = await props.params;
	const videoId = params.videoId as Video.VideoId;

	const referrer = (await headers()).get("x-referrer") || "";
	const isAllowedReferrer = ALLOWED_REFERRERS.some((domain) =>
		referrer.includes(domain),
	);

	return Effect.flatMap(Videos, (v) => v.getByIdForViewing(videoId)).pipe(
		Effect.map(
			Option.match({
				onNone: () => redirect("/dashboard"),
				onSome: ([video]) => ({
					title: `${video.name} | Cap Recording`,
					description: "Watch this video on Cap",
					openGraph: {
						title: `${video.name} | Cap Recording`,
						description: "Watch this video on Cap",
						type: "video.other",
						url: new URL(
							`/s/${videoId}`,
							buildEnv.NEXT_PUBLIC_WEB_URL,
						).toString(),
						images: [
							{
								url: new URL(
									`/api/video/og?videoId=${videoId}`,
									buildEnv.NEXT_PUBLIC_WEB_URL,
								).toString(),
								width: 1200,
								height: 630,
							},
						],
						videos: [
							{
								url: new URL(
									`/api/playlist?videoId=${video.id}&videoType=mp4`,
									buildEnv.NEXT_PUBLIC_WEB_URL,
								).toString(),
								width: 1280,
								height: 720,
								type: "video/mp4",
							},
						],
					},
					twitter: {
						card: "player",
						title: `${video.name} | Cap Recording`,
						description: "Watch this video on Cap",
						images: [
							new URL(
								`/api/video/og?videoId=${videoId}`,
								buildEnv.NEXT_PUBLIC_WEB_URL,
							).toString(),
						],
						players: {
							playerUrl: new URL(
								`/embed/${videoId}?autoplay=1`,
								buildEnv.NEXT_PUBLIC_WEB_URL,
							).toString(),
							streamUrl: new URL(
								`/api/playlist?videoId=${video.id}&videoType=mp4`,
								buildEnv.NEXT_PUBLIC_WEB_URL,
							).toString(),
							width: 1280,
							height: 720,
						},
					},
					robots: isAllowedReferrer ? "index, follow" : "noindex, nofollow",
				}),
			}),
		),
		Effect.catchTags({
			PolicyDenied: () =>
				Effect.succeed({
					title: "Cap: This video is private",
					description: "This video is private and cannot be shared.",
					openGraph: {
						type: "website",
						images: [
							{
								url: new URL(
									`/api/video/og?videoId=${videoId}`,
									buildEnv.NEXT_PUBLIC_WEB_URL,
								).toString(),
								width: 1200,
								height: 630,
							},
						],
						videos: [
							{
								url: new URL(
									`/api/playlist?videoId=${videoId}&videoType=mp4`,
									buildEnv.NEXT_PUBLIC_WEB_URL,
								).toString(),
								width: 1280,
								height: 720,
								type: "video/mp4",
							},
						],
					},
					robots: "noindex, nofollow",
				}),
			VerifyVideoPasswordError: () =>
				Effect.succeed({
					title: "Cap: Password Protected Video",
					description: "This video is password protected.",
					openGraph: {
						images: [
							{
								url: new URL(
									`/api/video/og?videoId=${videoId}`,
									buildEnv.NEXT_PUBLIC_WEB_URL,
								).toString(),
								width: 1200,
								height: 630,
							},
						],
					},
					twitter: {
						card: "summary_large_image",
						title: "Cap: Password Protected Video",
						description: "This video is password protected.",
						images: [
							new URL(
								`/api/video/og?videoId=${videoId}`,
								buildEnv.NEXT_PUBLIC_WEB_URL,
							).toString(),
						],
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

	return Effect.gen(function* () {
		const videosPolicy = yield* VideosPolicy;

		const [video] = yield* Effect.promise(() =>
			db()
				.select({
					id: videos.id,
					name: videos.name,
					orgId: videos.orgId,
					createdAt: videos.createdAt,
					updatedAt: videos.updatedAt,
					effectiveCreatedAt: videos.effectiveCreatedAt,
					bucket: videos.bucket,
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
					hasPassword: sql`${videos.password} IS NOT NULL`.mapWith(Boolean),
					sharedOrganization: {
						organizationId: sharedVideos.organizationId,
					},
					orgSettings: organizations.settings,
					hasActiveUpload: sql`${videoUploads.videoId} IS NOT NULL`.mapWith(
						Boolean,
					),
					owner: users,
				})
				.from(videos)
				.leftJoin(sharedVideos, eq(videos.id, sharedVideos.videoId))
				.innerJoin(users, eq(videos.ownerId, users.id))
				.leftJoin(videoUploads, eq(videos.id, videoUploads.videoId))
				.leftJoin(organizations, eq(videos.orgId, organizations.id))
				.where(and(eq(videos.id, videoId), isNull(organizations.tombstoneAt))),
		).pipe(Policy.withPublicPolicy(videosPolicy.canView(videoId)));

		return Option.fromNullable(video);
	}).pipe(
		Effect.flatten,
		Effect.map((video) => ({ needsPassword: false, video }) as const),
		Effect.catchTag("VerifyVideoPasswordError", () =>
			Effect.succeed({ needsPassword: true } as const),
		),
		Effect.map((data) => (
			<div key={videoId} className="flex flex-col min-h-screen bg-gray-2">
				<PasswordOverlay isOpen={data.needsPassword} videoId={videoId} />
				{!data.needsPassword && (
					<AuthorizedContent video={data.video} searchParams={searchParams} />
				)}
			</div>
		)),
		Effect.catchTags(getShareVideoPageCatchers(videoId)),
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
		orgSettings?: OrganizationSettings | null;
		videoSettings?: OrganizationSettings | null;
	};
	searchParams: { [key: string]: string | string[] | undefined };
}) {
	// will have already been fetched if auth is required
	const user = await getCurrentUser();
	const videoId = video.id;

	if (user && video && user.id !== video.owner.id) {
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

	// Fetch spaces data for the sharing dialog
	let spacesData = null;
	if (user) {
		try {
			const dashboardData = await getDashboardData(user);
			spacesData = dashboardData.spacesData;
		} catch (error) {
			console.error("Failed to fetch spaces data for sharing dialog:", error);
			spacesData = [];
		}
	}

	// Fetch shared spaces data for this video
	const sharedSpaces = await getSharedSpacesForVideo(videoId);

	let aiGenerationEnabled = false;
	const videoOwnerQuery = await db()
		.select({
			email: users.email,
			stripeSubscriptionStatus: users.stripeSubscriptionStatus,
			thirdPartyStripeSubscriptionId: users.thirdPartyStripeSubscriptionId,
		})
		.from(users)
		.where(eq(users.id, video.owner.id))
		.limit(1);

	if (videoOwnerQuery.length > 0 && videoOwnerQuery[0]) {
		const videoOwner = videoOwnerQuery[0];
		aiGenerationEnabled = await isAiGenerationEnabled(videoOwner);
	}

	if (video.sharedOrganization?.organizationId) {
		const organization = await db()
			.select()
			.from(organizations)
			.where(eq(organizations.id, video.sharedOrganization.organizationId))
			.limit(1);

		if (organization[0]?.allowedEmailDomain) {
			if (
				!user?.email ||
				!user.email.endsWith(`@${organization[0].allowedEmailDomain}`)
			) {
				console.log(
					"[ShareVideoPage] Access denied - domain restriction:",
					organization[0].allowedEmailDomain,
				);
				return (
					<div className="flex flex-col justify-center items-center p-4 min-h-screen text-center">
						<h1 className="mb-4 text-2xl font-bold">Access Restricted</h1>
						<p className="mb-2 text-gray-10">
							This video is only accessible to members of this organization.
						</p>
						<p className="text-gray-600">
							Please sign in with your organization email address to access this
							content.
						</p>
					</div>
				);
			}
		}
	}

	if (
		!video.hasActiveUpload &&
		video.transcriptionStatus !== "COMPLETE" &&
		video.transcriptionStatus !== "PROCESSING" &&
		video.transcriptionStatus !== "SKIPPED" &&
		video.transcriptionStatus !== "NO_AUDIO"
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

	const currentMetadata = (video.metadata as VideoMetadata) || {};
	const metadata = currentMetadata;
	const aiGenerationStatus = metadata.aiGenerationStatus || null;

	const initialAiData = {
		title: metadata.aiTitle || null,
		summary: metadata.summary || null,
		chapters: metadata.chapters || null,
		aiGenerationStatus,
	};

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

	const [
		membersList,
		userOrganizations,
		sharedOrganizations,
		{ customDomain, domainVerified },
	] = await Promise.all([
		membersListPromise,
		userOrganizationsPromise,
		sharedOrganizationsPromise,
		customDomainPromise,
	]);

	const videoWithOrganizationInfo = await Effect.gen(function* () {
		const imageUploads = yield* ImageUploads;

		return {
			...video,
			owner: {
				id: video.owner.id,
				name: video.owner.name,
				isPro: userIsPro(video.owner),
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
			settings: video.videoSettings || null,
		};
	}).pipe(runPromise);

	return (
		<>
			<div className="container flex-1 px-4 mx-auto">
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
				/>

				<Share
					data={videoWithOrganizationInfo}
					videoSettings={videoWithOrganizationInfo.settings}
					comments={commentsPromise}
					views={viewsPromise}
					customDomain={customDomain}
					domainVerified={domainVerified}
					userOrganizations={userOrganizations}
					viewerId={user?.id ?? null}
					initialAiData={initialAiData}
					aiGenerationEnabled={aiGenerationEnabled}
				/>
			</div>
			<div className="py-4 mt-auto">
				<a
					target="_blank"
					href={`/?ref=video_${video.id}`}
					className="flex justify-center items-center px-4 py-2 mx-auto mb-2 space-x-2 bg-white rounded-full border border-gray-5 w-fit"
				>
					<span className="text-sm">Recorded with</span>
					<Logo className="w-14 h-auto" />
				</a>
			</div>
		</>
	);
}
