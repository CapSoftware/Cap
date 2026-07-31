import { db } from "@cap/database";
import {
	organizations,
	spaces,
	spaceVideos,
	users,
	videos,
	videoUploads,
} from "@cap/database/schema";
import type { Video } from "@cap/web-domain";
import { and, eq, isNotNull, isNull, sql } from "drizzle-orm";

export type PublicShareVideoCandidate = {
	id: Video.VideoId;
	name: string;
	ownerId: string;
	ownerName: string | null;
	public: boolean;
	hasPassword: boolean;
	hasInheritedPassword: boolean;
	allowedEmailDomain: string | null;
	isScreenshot: boolean;
	hasActiveUpload: boolean;
	sourceType:
		| "MediaConvert"
		| "local"
		| "desktopMP4"
		| "desktopSegments"
		| "webMP4";
	jobStatus: string | null;
	skipProcessing: boolean | null;
	width: number | null;
	height: number | null;
	duration: number | null;
};

export type PublicShareVideo = Omit<
	PublicShareVideoCandidate,
	| "public"
	| "hasPassword"
	| "hasInheritedPassword"
	| "allowedEmailDomain"
	| "isScreenshot"
	| "hasActiveUpload"
	| "jobStatus"
	| "skipProcessing"
>;

export const isPublicShareVideoCandidateEligible = (
	video: PublicShareVideoCandidate,
) =>
	video.public &&
	!video.hasPassword &&
	!video.hasInheritedPassword &&
	(video.allowedEmailDomain?.trim().length ?? 0) === 0 &&
	!video.isScreenshot &&
	!video.hasActiveUpload &&
	(video.sourceType !== "MediaConvert" ||
		video.jobStatus === "COMPLETE" ||
		video.skipProcessing === true);

export async function getPublicShareVideo(
	videoId: Video.VideoId,
): Promise<PublicShareVideo | null> {
	const [video] = await db()
		.select({
			id: videos.id,
			name: videos.name,
			ownerId: videos.ownerId,
			ownerName: users.name,
			public: videos.public,
			hasPassword: sql<boolean>`${videos.password} IS NOT NULL`.mapWith(
				Boolean,
			),
			allowedEmailDomain: organizations.allowedEmailDomain,
			isScreenshot: videos.isScreenshot,
			hasActiveUpload:
				sql<boolean>`${videoUploads.videoId} IS NOT NULL AND ${videoUploads.phase} <> 'complete'`.mapWith(
					Boolean,
				),
			sourceType: sql<
				PublicShareVideoCandidate["sourceType"]
			>`JSON_UNQUOTE(JSON_EXTRACT(${videos.source}, '$.type'))`,
			jobStatus: videos.jobStatus,
			skipProcessing: videos.skipProcessing,
			width: videos.width,
			height: videos.height,
			duration: videos.duration,
		})
		.from(videos)
		.innerJoin(
			organizations,
			and(
				eq(videos.orgId, organizations.id),
				isNull(organizations.tombstoneAt),
			),
		)
		.leftJoin(users, eq(videos.ownerId, users.id))
		.leftJoin(videoUploads, eq(videos.id, videoUploads.videoId))
		.where(eq(videos.id, videoId))
		.limit(1);

	if (!video) return null;

	const [inheritedPassword] = await db()
		.select({ id: spaces.id })
		.from(spaceVideos)
		.innerJoin(spaces, eq(spaceVideos.spaceId, spaces.id))
		.where(and(eq(spaceVideos.videoId, videoId), isNotNull(spaces.password)))
		.limit(1);

	const candidate: PublicShareVideoCandidate = {
		...video,
		hasInheritedPassword: Boolean(inheritedPassword),
	};

	if (!isPublicShareVideoCandidateEligible(candidate)) return null;

	return {
		id: candidate.id,
		name: candidate.name,
		ownerId: candidate.ownerId,
		ownerName: candidate.ownerName,
		sourceType: candidate.sourceType,
		width: candidate.width,
		height: candidate.height,
		duration: candidate.duration,
	};
}
