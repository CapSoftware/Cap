import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import {
	comments,
	folders,
	organizationMembers,
	sharedVideos,
	spaceMembers,
	spaceVideos,
	users,
	videos,
	videoUploads,
} from "@cap/database/schema";
import { serverEnv } from "@cap/env";
import { Spaces } from "@cap/web-backend";
import { CurrentUser, type Organisation, Space, Video } from "@cap/web-domain";
import { and, count, desc, eq, isNull, sql } from "drizzle-orm";
import { Effect } from "effect";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { runPromise } from "@/lib/server";
import { SharedCaps } from "./SharedCaps";

export const metadata: Metadata = {
	title: "Shared Caps — Cap",
};

export type SpaceMemberData = {
	id: string;
	userId: string;
	role: string;
	image?: string | null;
	name: string | null;
	email: string;
};

// --- Helper functions ---
async function fetchFolders(
	spaceId: Space.SpaceIdOrOrganisationId,
	allSpacesEntry: boolean,
) {
	const table = allSpacesEntry ? sharedVideos : spaceVideos;
	return db()
		.select({
			id: folders.id,
			name: folders.name,
			color: folders.color,
			parentId: folders.parentId,
			spaceId: folders.spaceId,
			videoCount: sql<number>`(
          SELECT COUNT(*) FROM ${table} WHERE ${table}.folderId = folders.id
        )`,
		})
		.from(folders)
		.where(and(eq(folders.spaceId, spaceId), isNull(folders.parentId)));
}

async function fetchSpaceMembers(spaceId: Space.SpaceIdOrOrganisationId) {
	return db()
		.select({
			id: spaceMembers.id,
			userId: spaceMembers.userId,
			role: sql<string>`'member'`,
			name: users.name,
			email: users.email,
			image: users.image,
		})
		.from(spaceMembers)
		.innerJoin(users, eq(spaceMembers.userId, users.id))
		.where(eq(spaceMembers.spaceId, spaceId));
}

async function fetchOrganizationMembers(orgId: Organisation.OrganisationId) {
	return db()
		.select({
			id: organizationMembers.id,
			userId: organizationMembers.userId,
			role: organizationMembers.role,
			name: users.name,
			email: users.email,
			image: users.image,
		})
		.from(organizationMembers)
		.innerJoin(users, eq(organizationMembers.userId, users.id))
		.where(eq(organizationMembers.organizationId, orgId));
}

export default async function SharedCapsPage(props: {
	params: Promise<{ spaceId: string }>;
	searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
	const searchParams = await props.searchParams;
	const params = await props.params;
	const page = Number(searchParams.page) || 1;
	const limit = Number(searchParams.limit) || 15;
	const user = await getCurrentUser();
	if (!user) notFound();

	const spaceOrOrg = await Effect.flatMap(Spaces, (s) =>
		s.getSpaceOrOrg(Space.SpaceId.make(params.spaceId)),
	).pipe(
		Effect.catchTag("PolicyDenied", () => Effect.sync(() => notFound())),
		Effect.provideService(CurrentUser, user),
		runPromise,
	);

	if (!spaceOrOrg) notFound();

	if (spaceOrOrg.variant === "space") {
		const { space } = spaceOrOrg;

		// Fetch members in parallel
		const [spaceMembersData, organizationMembersData, foldersData] =
			await Promise.all([
				fetchSpaceMembers(space.id),
				fetchOrganizationMembers(space.organizationId),
				fetchFolders(space.id, false),
			]);

		async function fetchSpaceVideos(
			spaceId: Space.SpaceIdOrOrganisationId,
			page: number,
			limit: number,
		) {
			const offset = (page - 1) * limit;
			const [videoRows, totalCountResult] = await Promise.all([
				db()
					.select({
						id: videos.id,
						ownerId: videos.ownerId,
						name: videos.name,
						createdAt: videos.createdAt,
						metadata: videos.metadata,
						duration: videos.duration,
						totalComments: sql<number>`COUNT(DISTINCT CASE WHEN ${comments.type} = 'text' THEN ${comments.id} END)`,
						totalReactions: sql<number>`COUNT(DISTINCT CASE WHEN ${comments.type} = 'emoji' THEN ${comments.id} END)`,
						ownerName: users.name,
						effectiveDate: sql<string>`COALESCE(JSON_UNQUOTE(JSON_EXTRACT(${videos.metadata}, '$.customCreatedAt')), ${videos.createdAt})`,
						hasActiveUpload: sql`${videoUploads.videoId} IS NOT NULL`.mapWith(
							Boolean,
						),
					})
					.from(spaceVideos)
					.innerJoin(videos, eq(spaceVideos.videoId, videos.id))
					.leftJoin(comments, eq(videos.id, comments.videoId))
					.leftJoin(users, eq(videos.ownerId, users.id))
					.leftJoin(videoUploads, eq(videos.id, videoUploads.videoId))
					.where(
						and(eq(spaceVideos.spaceId, spaceId), isNull(spaceVideos.folderId)),
					)
					.groupBy(
						videos.id,
						videos.ownerId,
						videos.name,
						videos.createdAt,
						videos.metadata,
						users.name,
					)
					.orderBy(
						desc(
							sql`COALESCE(JSON_UNQUOTE(JSON_EXTRACT(${videos.metadata}, '$.customCreatedAt')), ${videos.createdAt})`,
						),
					)
					.limit(limit)
					.offset(offset),
				db()
					.select({ count: count() })
					.from(spaceVideos)
					.where(
						and(eq(spaceVideos.spaceId, spaceId), isNull(spaceVideos.folderId)),
					),
			]);
			return {
				videos: videoRows,
				totalCount: totalCountResult[0]?.count || 0,
			};
		}

		// Fetch videos and count in parallel
		const { videos: spaceVideoData, totalCount } = await fetchSpaceVideos(
			space.id,
			page,
			limit,
		);
		const processedVideoData = spaceVideoData.map((video) => {
			const { effectiveDate, ...videoWithoutEffectiveDate } = video;
			return {
				...videoWithoutEffectiveDate,
				id: Video.VideoId.make(video.id),
				ownerName: video.ownerName ?? null,
				metadata: video.metadata as
					| { customCreatedAt?: string; [key: string]: any }
					| undefined,
			};
		});

		return (
			<SharedCaps
				data={processedVideoData}
				count={totalCount}
				spaceData={space}
				spaceId={params.spaceId as Space.SpaceIdOrOrganisationId}
				dubApiKeyEnabled={!!serverEnv().DUB_API_KEY}
				spaceMembers={spaceMembersData}
				organizationMembers={organizationMembersData}
				currentUserId={user.id}
				folders={foldersData}
			/>
		);
	}

	if (spaceOrOrg.variant === "organization") {
		const { organization } = spaceOrOrg;

		async function fetchOrganizationVideos(
			orgId: Organisation.OrganisationId,
			page: number,
			limit: number,
		) {
			const offset = (page - 1) * limit;
			const [videoRows, totalCountResult] = await Promise.all([
				db()
					.select({
						id: videos.id,
						ownerId: videos.ownerId,
						name: videos.name,
						createdAt: videos.createdAt,
						metadata: videos.metadata,
						duration: videos.duration,
						totalComments: sql<number>`COUNT(DISTINCT CASE WHEN ${comments.type} = 'text' THEN ${comments.id} END)`,
						totalReactions: sql<number>`COUNT(DISTINCT CASE WHEN ${comments.type} = 'emoji' THEN ${comments.id} END)`,
						ownerName: users.name,
						effectiveDate: sql<string>`COALESCE(JSON_UNQUOTE(JSON_EXTRACT(${videos.metadata}, '$.customCreatedAt')), ${videos.createdAt})`,
						hasActiveUpload: sql`${videoUploads.videoId} IS NOT NULL`.mapWith(
							Boolean,
						),
					})
					.from(sharedVideos)
					.innerJoin(videos, eq(sharedVideos.videoId, videos.id))
					.leftJoin(comments, eq(videos.id, comments.videoId))
					.leftJoin(users, eq(videos.ownerId, users.id))
					.leftJoin(videoUploads, eq(videos.id, videoUploads.videoId))
					.where(
						and(
							eq(sharedVideos.organizationId, orgId),
							isNull(sharedVideos.folderId),
						),
					)
					.groupBy(
						videos.id,
						videos.ownerId,
						videos.name,
						videos.createdAt,
						videos.metadata,
						users.name,
						videos.duration,
					)
					.orderBy(
						desc(
							sql`COALESCE(JSON_UNQUOTE(JSON_EXTRACT(${videos.metadata}, '$.customCreatedAt')), ${videos.createdAt})`,
						),
					)
					.limit(limit)
					.offset(offset),
				db()
					.select({ count: count() })
					.from(sharedVideos)
					.innerJoin(videos, eq(sharedVideos.videoId, videos.id))
					.where(
						and(
							eq(sharedVideos.organizationId, orgId),
							isNull(videos.folderId),
						),
					),
			]);
			return {
				videos: videoRows,
				totalCount: totalCountResult[0]?.count || 0,
			};
		}

		// Fetch videos and count in parallel

		const [organizationVideos, organizationMembersData, foldersData] =
			await Promise.all([
				fetchOrganizationVideos(organization.id, page, limit),
				fetchOrganizationMembers(organization.id),
				fetchFolders(organization.id, true),
			]);

		const { videos: orgVideoData, totalCount } = organizationVideos;
		const processedVideoData = orgVideoData.map((video) => {
			const { effectiveDate, ...videoWithoutEffectiveDate } = video;
			return {
				...videoWithoutEffectiveDate,
				id: Video.VideoId.make(video.id),
				ownerName: video.ownerName ?? null,
				metadata: video.metadata as
					| { customCreatedAt?: string; [key: string]: any }
					| undefined,
			};
		});

		return (
			<SharedCaps
				data={processedVideoData}
				count={totalCount}
				hideSharedWith
				organizationData={organization}
				spaceId={params.spaceId as Space.SpaceIdOrOrganisationId}
				dubApiKeyEnabled={!!serverEnv().DUB_API_KEY}
				organizationMembers={organizationMembersData}
				currentUserId={user.id}
				folders={foldersData}
			/>
		);
	}
}
