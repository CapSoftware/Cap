import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import {
	comments,
	organizations,
	sharedVideos,
	users,
	videos,
	videoUploads,
} from "@cap/database/schema";
import type { VideoMetadata } from "@cap/database/types";
import { buildEnv } from "@cap/env";
import { provideOptionalAuth, Videos, VideosPolicy } from "@cap/web-backend";
import { type Organisation, Policy, type Video } from "@cap/web-domain";
import { and, eq, isNull, sql } from "drizzle-orm";
import { Effect, Option } from "effect";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import * as EffectRuntime from "@/lib/server";
import { transcribeVideo } from "@/lib/transcribe";
import { isAiGenerationEnabled } from "@/utils/flags";
import { EmbedVideo } from "./_components/EmbedVideo";
import { PasswordOverlay } from "./_components/PasswordOverlay";

export async function generateMetadata(
	props: PageProps<"/embed/[videoId]">,
): Promise<Metadata> {
	const params = await props.params;
	const videoId = params.videoId as Video.VideoId;

	return Effect.flatMap(Videos, (v) => v.getByIdForViewing(videoId)).pipe(
		Effect.map(
			Option.match({
				onNone: () => notFound(),
				onSome: ([video]) => ({
					title: `${video.name} | Cap Recording`,
					description: "Watch this video on Cap",
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
						videos: [
							{
								url: new URL(
									`/api/playlist?userId=${video.ownerId}&videoId=${video.id}`,
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
								`/embed/${videoId}`,
								buildEnv.NEXT_PUBLIC_WEB_URL,
							).toString(),
							streamUrl: new URL(
								`/api/playlist?userId=${video.ownerId}&videoId=${video.id}`,
								buildEnv.NEXT_PUBLIC_WEB_URL,
							).toString(),
							width: 1280,
							height: 720,
						},
					},
					robots: "index, follow",
				}),
			}),
		),
		Effect.catchTags({
			PolicyDenied: () =>
				Effect.succeed({
					title: "Cap: This video is private",
					description: "This video is private and cannot be shared.",
					robots: "noindex, nofollow",
				}),
			VerifyVideoPasswordError: () =>
				Effect.succeed({
					title: "Cap: Password Protected Video",
					description: "This video is password protected.",
					robots: "noindex, nofollow",
				}),
		}),
		provideOptionalAuth,
		EffectRuntime.runPromise,
	);
}

export default async function EmbedVideoPage(
	props: PageProps<"/embed/[videoId]">,
) {
	const params = await props.params;
	const searchParams = await props.searchParams;
	const videoId = params.videoId as Video.VideoId;
	const autoplay = searchParams.autoplay === "true";

	return Effect.gen(function* () {
		const videosPolicy = yield* VideosPolicy;

		const [video] = yield* Effect.promise(() =>
			db()
				.select({
					id: videos.id,
					name: videos.name,
					ownerId: videos.ownerId,
					orgId: videos.orgId,
					settings: videos.settings,
					createdAt: videos.createdAt,
					effectiveCreatedAt: videos.effectiveCreatedAt,
					updatedAt: videos.updatedAt,
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
					folderId: videos.folderId,
					width: videos.width,
					height: videos.height,
					duration: videos.duration,
					fps: videos.fps,
					hasPassword: sql`${videos.password} IS NOT NULL`.mapWith(Boolean),
					sharedOrganization: {
						organizationId: sharedVideos.organizationId,
					},
					hasActiveUpload: sql`${videoUploads.videoId} IS NOT NULL`.mapWith(
						Boolean,
					),
				})
				.from(videos)
				.leftJoin(sharedVideos, eq(videos.id, sharedVideos.videoId))
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
			<div className="min-h-screen bg-black">
				<PasswordOverlay isOpen={data.needsPassword} videoId={videoId} />
				{!data.needsPassword && (
					<EmbedContent video={data.video} autoplay={autoplay} />
				)}
			</div>
		)),
		Effect.catchTags({
			PolicyDenied: () =>
				Effect.succeed(
					<div className="flex flex-col justify-center items-center min-h-screen text-center text-white bg-black">
						<h1 className="mb-4 text-2xl font-bold">This video is private</h1>
						<p className="text-gray-400">
							If you own this video, please <Link href="/login">sign in</Link>{" "}
							to manage sharing.
						</p>
					</div>,
				),
			NoSuchElementException: () => Effect.sync(() => notFound()),
		}),
		provideOptionalAuth,
		EffectRuntime.runPromise,
	);
}

async function EmbedContent({
	video,
	autoplay,
}: {
	video: Omit<typeof videos.$inferSelect, "password"> & {
		sharedOrganization: { organizationId: Organisation.OrganisationId } | null;
		hasActiveUpload: boolean | undefined;
	};
	autoplay: boolean;
}) {
	const user = await getCurrentUser();

	let aiGenerationEnabled = false;
	const videoOwnerQuery = await db()
		.select({
			email: users.email,
			stripeSubscriptionStatus: users.stripeSubscriptionStatus,
			thirdPartyStripeSubscriptionId: users.thirdPartyStripeSubscriptionId,
		})
		.from(users)
		.where(eq(users.id, video.ownerId))
		.limit(1);

	if (videoOwnerQuery.length > 0 && videoOwnerQuery[0]) {
		const videoOwner = videoOwnerQuery[0];
		aiGenerationEnabled = await isAiGenerationEnabled(videoOwner);
	}

	if (
		video.transcriptionStatus !== "COMPLETE" &&
		video.transcriptionStatus !== "PROCESSING" &&
		video.transcriptionStatus !== "SKIPPED" &&
		video.transcriptionStatus !== "NO_AUDIO"
	) {
		transcribeVideo(video.id, video.ownerId, aiGenerationEnabled);
	}

	const currentMetadata = (video.metadata as VideoMetadata) || {};
	let initialAiData = null;

	if (
		currentMetadata.summary ||
		currentMetadata.chapters ||
		currentMetadata.aiTitle
	) {
		initialAiData = {
			title: currentMetadata.aiTitle || null,
			summary: currentMetadata.summary || null,
			chapters: currentMetadata.chapters || null,
		};
	}

	if (video.isScreenshot === true) {
		return (
			<div className="flex justify-center items-center min-h-screen text-white bg-black">
				<p>Screenshots cannot be embedded</p>
			</div>
		);
	}

	const commentsQuery = await db()
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
		})
		.from(comments)
		.leftJoin(users, eq(comments.authorId, users.id))
		.where(eq(comments.videoId, video.id));

	const videoOwner = await db()
		.select({
			name: users.name,
		})
		.from(users)
		.where(eq(users.id, video.ownerId))
		.limit(1);

	return (
		<EmbedVideo
			data={video}
			user={user}
			comments={commentsQuery}
			chapters={initialAiData?.chapters || []}
			ownerName={videoOwner[0]?.name || null}
			autoplay={autoplay}
		/>
	);
}
