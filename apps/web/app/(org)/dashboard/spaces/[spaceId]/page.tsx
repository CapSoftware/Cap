import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import {
	comments,
	folders,
	organizationMembers,
	organizations,
	sharedVideos,
	spaceMembers,
	spaces,
	spaceVideos,
	users,
	videos,
} from "@cap/database/schema";
import { serverEnv } from "@cap/env";
import { Video } from "@cap/web-domain";
import { and, count, desc, eq, isNull, sql } from "drizzle-orm";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { SharedCaps } from "./SharedCaps";

export const metadata: Metadata = {
	title: "Shared Caps — Cap",
};

type SpaceData = {
	id: string;
	name: string;
	organizationId: string;
	createdById: string;
};

type OrganizationData = {
	id: string;
	name: string;
	ownerId: string;
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
async function fetchSpaceData(id: string) {
	return db()
		.select({
			id: spaces.id,
			name: spaces.name,
			organizationId: spaces.organizationId,
			createdById: spaces.createdById,
		})
		.from(spaces)
		.where(eq(spaces.id, id))
		.limit(1);
}

async function fetchOrganizationData(id: string) {
	return db()
		.select({
			id: organizations.id,
			name: organizations.name,
			ownerId: organizations.ownerId,
		})
		.from(organizations)
		.where(eq(organizations.id, id))
		.limit(1);
}

async function fetchFolders(spaceId: string) {
	return db()
		.select({
			id: folders.id,
			name: folders.name,
			color: folders.color,
			parentId: folders.parentId,
			spaceId: folders.spaceId,
			videoCount: sql<number>`(
          SELECT COUNT(*) FROM videos WHERE videos.folderId = folders.id
        )`,
		})
		.from(folders)
		.where(and(eq(folders.spaceId, spaceId), isNull(folders.parentId)));
}

async function fetchSpaceMembers(spaceId: string) {
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

async function fetchOrganizationMembers(orgId: string) {
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
	const userId = user?.id as string;
	// this is just how it work atm
	const spaceOrOrgId = params.spaceId;

	// Parallelize fetching space and org data
	const [spaceData, organizationData] = await Promise.all([
		fetchSpaceData(spaceOrOrgId),
		fetchOrganizationData(spaceOrOrgId),
	]);

	// organizationData assignment handled above
	if (spaceData.length === 0 && organizationData.length === 0) {
		notFound();
	}

	const isSpace = spaceData.length > 0;

	if (isSpace) {
		const space = spaceData[0] as SpaceData;
		const isSpaceCreator = space.createdById === userId;
		let hasAccess = isSpaceCreator;
		if (!isSpaceCreator) {
			const [spaceMembership, orgMembership] = await Promise.all([
				db()
					.select({ id: spaceMembers.id })
					.from(spaceMembers)
					.where(
						and(
							eq(spaceMembers.userId, userId),
							eq(spaceMembers.spaceId, spaceOrOrgId),
						),
					)
					.limit(1),
				db()
					.select({ id: organizationMembers.id })
					.from(organizationMembers)
					.where(
						and(
							eq(organizationMembers.userId, userId),
							eq(organizationMembers.organizationId, space.organizationId),
						),
					)
					.limit(1),
			]);
			hasAccess = spaceMembership.length > 0 || orgMembership.length > 0;
		}
		if (!hasAccess) notFound();

		// Fetch members in parallel
		const [spaceMembersData, organizationMembersData, foldersData] =
			await Promise.all([
				fetchSpaceMembers(spaceOrOrgId),
				fetchOrganizationMembers(space.organizationId),
				fetchFolders(spaceOrOrgId),
			]);

		async function fetchSpaceVideos(
			spaceId: string,
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
					})
					.from(spaceVideos)
					.innerJoin(videos, eq(spaceVideos.videoId, videos.id))
					.leftJoin(comments, eq(videos.id, comments.videoId))
					.leftJoin(users, eq(videos.ownerId, users.id))
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
			spaceOrOrgId,
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
				dubApiKeyEnabled={!!serverEnv().DUB_API_KEY}
				spaceMembers={spaceMembersData}
				organizationMembers={organizationMembersData}
				currentUserId={userId}
				folders={foldersData}
			/>
		);
	} else {
		const organization = organizationData[0] as OrganizationData;
		const isOrgOwner = organization.ownerId === userId;

		if (!isOrgOwner) {
			const orgMembership = await db()
				.select({ id: organizationMembers.id })
				.from(organizationMembers)
				.where(
					and(
						eq(organizationMembers.userId, userId),
						eq(organizationMembers.organizationId, spaceOrOrgId),
					),
				)
				.limit(1);

			if (orgMembership.length === 0) {
				notFound();
			}
		}

		async function fetchOrganizationVideos(
			orgId: string,
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
					})
					.from(sharedVideos)
					.innerJoin(videos, eq(sharedVideos.videoId, videos.id))
					.leftJoin(comments, eq(videos.id, comments.videoId))
					.leftJoin(users, eq(videos.ownerId, users.id))
					.where(
						and(
							eq(sharedVideos.organizationId, orgId),
							isNull(videos.folderId),
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
				fetchOrganizationVideos(spaceOrOrgId, page, limit),
				fetchOrganizationMembers(spaceOrOrgId),
				fetchFolders(spaceOrOrgId),
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
				dubApiKeyEnabled={!!serverEnv().DUB_API_KEY}
				organizationMembers={organizationMembersData}
				currentUserId={userId}
				folders={foldersData}
			/>
		);
	}
}
