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
	videoUploads,
} from "@cap/database/schema";
import { serverEnv } from "@cap/env";
import {
	Database,
	ImageUploads,
	makeCurrentUserLayer,
	resolveEffectiveVideoRules,
	Spaces,
} from "@cap/web-backend";
import {
	type ImageUpload,
	type Organisation,
	Space,
	Video,
} from "@cap/web-domain";
import { and, count, desc, eq, inArray, isNull, sql } from "drizzle-orm";
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
	image?: ImageUpload.ImageUrl | null;
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
			public: folders.public,
			parentId: folders.parentId,
			spaceId: folders.spaceId,
			videoCount: sql<number>`(
          SELECT COUNT(*) FROM ${table} WHERE ${table}.folderId = folders.id
        )`,
		})
		.from(folders)
		.where(and(eq(folders.spaceId, spaceId), isNull(folders.parentId)));
}

const fetchSpaceMembers = Effect.fn(function* (
	spaceId: Space.SpaceIdOrOrganisationId,
) {
	const db = yield* Database;
	const imageUploads = yield* ImageUploads;

	return yield* db
		.use((db) =>
			db
				.select({
					id: spaceMembers.id,
					userId: spaceMembers.userId,
					role: spaceMembers.role,
					name: users.name,
					email: users.email,
					image: users.image,
				})
				.from(spaceMembers)
				.innerJoin(users, eq(spaceMembers.userId, users.id))
				.where(eq(spaceMembers.spaceId, spaceId)),
		)
		.pipe(
			Effect.map((v) =>
				v.map(
					Effect.fn(function* (v) {
						return {
							...v,
							image: v.image
								? yield* imageUploads.resolveImageUrl(v.image)
								: null,
						};
					}),
				),
			),
			Effect.flatMap(Effect.all),
		);
});

const fetchOrganizationMembers = Effect.fn(function* (
	orgId: Organisation.OrganisationId,
) {
	const db = yield* Database;
	const imageUploads = yield* ImageUploads;

	return yield* db
		.use((db) =>
			db
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
				.where(eq(organizationMembers.organizationId, orgId)),
		)
		.pipe(
			Effect.map((v) =>
				v.map(
					Effect.fn(function* (v) {
						return {
							...v,
							image: v.image
								? yield* imageUploads.resolveImageUrl(v.image)
								: null,
						};
					}),
				),
			),
			Effect.flatMap(Effect.all),
		);
});

async function fetchSharedSpacesForVideos(videoIds: Video.VideoId[]) {
	if (videoIds.length === 0) return {};

	const rows = await db()
		.select({
			videoId: spaceVideos.videoId,
			id: spaces.id,
			name: spaces.name,
			organizationId: spaces.organizationId,
			iconUrl: spaces.iconUrl,
			settings: spaces.settings,
			hasPassword: sql`${spaces.password} IS NOT NULL`.mapWith(Boolean),
		})
		.from(spaceVideos)
		.innerJoin(spaces, eq(spaceVideos.spaceId, spaces.id))
		.where(inArray(spaceVideos.videoId, videoIds));

	const resolvedRows = await Effect.gen(function* () {
		const imageUploads = yield* ImageUploads;

		return yield* Effect.all(
			rows.map(
				Effect.fn(function* (row) {
					return {
						...row,
						isOrg: false as const,
						iconUrl: row.iconUrl
							? yield* imageUploads.resolveImageUrl(row.iconUrl)
							: null,
					};
				}),
			),
		);
	}).pipe(runPromise);

	return resolvedRows.reduce<
		Record<string, Omit<(typeof resolvedRows)[number], "videoId">[]>
	>((acc, row) => {
		const spaces = acc[row.videoId] ?? [];
		acc[row.videoId] = spaces;
		const { videoId: _videoId, ...space } = row;
		spaces.push(space);
		return acc;
	}, {});
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
		Effect.provide(makeCurrentUserLayer(user)),
		runPromise,
	);

	if (!spaceOrOrg) notFound();

	if (spaceOrOrg.variant === "space") {
		const { space } = spaceOrOrg;

		// Fetch members in parallel
		const [spaceMembersData, organizationMembersData, foldersData] =
			await Promise.all([
				fetchSpaceMembers(space.id).pipe(runPromise),
				fetchOrganizationMembers(space.organizationId).pipe(runPromise),
				fetchFolders(space.id, false),
			]);
		const resolvedSpace = await Effect.gen(function* () {
			const imageUploads = yield* ImageUploads;
			return {
				...space,
				iconUrl: space.iconUrl
					? yield* imageUploads.resolveImageUrl(space.iconUrl)
					: null,
			};
		}).pipe(runPromise);

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
						isScreenshot: videos.isScreenshot,
						duration: videos.duration,
						public: videos.public,
						settings: videos.settings,
						hasPassword: sql`${videos.password} IS NOT NULL`.mapWith(Boolean),
						totalComments: sql<number>`COUNT(DISTINCT CASE WHEN ${comments.type} = 'text' THEN ${comments.id} END)`,
						totalReactions: sql<number>`COUNT(DISTINCT CASE WHEN ${comments.type} = 'emoji' THEN ${comments.id} END)`,
						ownerName: users.name,
						effectiveDate: videos.effectiveCreatedAt,
						hasActiveUpload:
							sql`${videoUploads.videoId} IS NOT NULL AND ${videos.isScreenshot} = false`.mapWith(
								Boolean,
							),
					})
					.from(spaceVideos)
					.innerJoin(videos, eq(spaceVideos.videoId, videos.id))
					.leftJoin(comments, eq(videos.id, comments.videoId))
					.leftJoin(users, eq(videos.ownerId, users.id))
					.leftJoin(videoUploads, eq(videos.id, videoUploads.videoId))
					.leftJoin(organizations, eq(videos.orgId, organizations.id))
					.where(
						and(
							eq(spaceVideos.spaceId, spaceId),
							isNull(spaceVideos.folderId),
							isNull(organizations.tombstoneAt),
						),
					)
					.groupBy(
						videos.id,
						videos.ownerId,
						videos.name,
						videos.createdAt,
						videos.metadata,
						videos.isScreenshot,
						videos.duration,
						videos.public,
						videos.settings,
						videos.password,
						users.name,
					)
					.orderBy(desc(videos.effectiveCreatedAt))
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
		const sharedSpacesMap = await fetchSharedSpacesForVideos(
			spaceVideoData.map((video) => Video.VideoId.make(video.id)),
		);
		const [organizationSettingsRow] = await db()
			.select({ settings: organizations.settings })
			.from(organizations)
			.where(eq(organizations.id, space.organizationId))
			.limit(1);
		const organizationSettings = organizationSettingsRow?.settings ?? null;
		const processedVideoData = spaceVideoData.map((video) => {
			const { effectiveDate: _effectiveDate, ...videoWithoutEffectiveDate } =
				video;
			const sharedSpaces = sharedSpacesMap[video.id] ?? [];
			const rules = resolveEffectiveVideoRules({
				videoSettings: video.settings,
				organizationSettings,
				spaces: sharedSpaces,
			});
			return {
				...videoWithoutEffectiveDate,
				id: Video.VideoId.make(video.id),
				hasInheritedPassword: rules.hasInheritedPassword,
				inheritedPasswordSources: rules.inheritedPasswordSources,
				inheritedSpaceSettings: rules.inheritedSettings,
				sharedSpaces,
				ownerName: video.ownerName ?? null,
				metadata: video.metadata as
					| { customCreatedAt?: string; [key: string]: unknown }
					| undefined,
			};
		});

		return (
			<SharedCaps
				data={processedVideoData}
				count={totalCount}
				spaceData={resolvedSpace}
				spaceId={params.spaceId as Space.SpaceIdOrOrganisationId}
				analyticsEnabled={Boolean(
					serverEnv().TINYBIRD_TOKEN && serverEnv().TINYBIRD_HOST,
				)}
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
						isScreenshot: videos.isScreenshot,
						duration: videos.duration,
						public: videos.public,
						settings: videos.settings,
						hasPassword: sql`${videos.password} IS NOT NULL`.mapWith(Boolean),
						totalComments: sql<number>`COUNT(DISTINCT CASE WHEN ${comments.type} = 'text' THEN ${comments.id} END)`,
						totalReactions: sql<number>`COUNT(DISTINCT CASE WHEN ${comments.type} = 'emoji' THEN ${comments.id} END)`,
						ownerName: users.name,
						effectiveDate: videos.effectiveCreatedAt,
						hasActiveUpload:
							sql`${videoUploads.videoId} IS NOT NULL AND ${videos.isScreenshot} = false`.mapWith(
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
						videos.isScreenshot,
						users.name,
						videos.duration,
						videos.public,
						videos.settings,
						videos.password,
					)
					.orderBy(desc(videos.effectiveCreatedAt))
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
				fetchOrganizationMembers(organization.id).pipe(runPromise),
				fetchFolders(organization.id, true),
			]);

		const { videos: orgVideoData, totalCount } = organizationVideos;
		const sharedSpacesMap = await fetchSharedSpacesForVideos(
			orgVideoData.map((video) => Video.VideoId.make(video.id)),
		);
		const [organizationSettingsRow] = await db()
			.select({ settings: organizations.settings })
			.from(organizations)
			.where(eq(organizations.id, organization.id))
			.limit(1);
		const organizationSettings = organizationSettingsRow?.settings ?? null;
		const processedVideoData = orgVideoData.map((video) => {
			const { effectiveDate: _effectiveDate, ...videoWithoutEffectiveDate } =
				video;
			const sharedSpaces = sharedSpacesMap[video.id] ?? [];
			const rules = resolveEffectiveVideoRules({
				videoSettings: video.settings,
				organizationSettings,
				spaces: sharedSpaces,
			});
			return {
				...videoWithoutEffectiveDate,
				id: Video.VideoId.make(video.id),
				hasInheritedPassword: rules.hasInheritedPassword,
				inheritedPasswordSources: rules.inheritedPasswordSources,
				inheritedSpaceSettings: rules.inheritedSettings,
				sharedSpaces,
				ownerName: video.ownerName ?? null,
				metadata: video.metadata as
					| { customCreatedAt?: string; [key: string]: unknown }
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
				analyticsEnabled={Boolean(
					serverEnv().TINYBIRD_TOKEN && serverEnv().TINYBIRD_HOST,
				)}
				organizationMembers={organizationMembersData}
				currentUserId={user.id}
				folders={foldersData}
			/>
		);
	}
}
