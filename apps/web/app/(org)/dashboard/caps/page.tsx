import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import {
	comments,
	folders,
	organizations,
	sharedVideos,
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
	resolveEffectiveVideoRules,
} from "@cap/web-backend";
import { type ImageUpload, Video } from "@cap/web-domain";
import { and, count, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { type Array, Effect } from "effect";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { runPromise } from "@/lib/server";
import { Caps } from "./Caps";

export const metadata: Metadata = {
	title: "My Caps — Cap",
};

// Helper function to fetch shared spaces data for videos
const getSharedSpacesForVideos = Effect.fn(function* (
	videoIds: Video.VideoId[],
) {
	if (videoIds.length === 0) return {};

	const db = yield* Database;

	// Fetch space-level sharing
	const spaceSharing = yield* db.use((db) =>
		db
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
			.innerJoin(organizations, eq(spaces.organizationId, organizations.id))
			.where(inArray(spaceVideos.videoId, videoIds)),
	);

	// Fetch organization-level sharing
	const orgSharing = yield* db.use((db) =>
		db
			.select({
				videoId: sharedVideos.videoId,
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
			.where(inArray(sharedVideos.videoId, videoIds)),
	);

	// Combine and group by videoId
	const sharedSpacesMap: Record<
		string,
		Array<{
			id: string;
			name: string;
			organizationId: string;
			isOrg: boolean;
			iconUrl?: ImageUpload.ImageUrlOrKey | null;
			settings?: (typeof spaces.$inferSelect)["settings"];
			hasPassword: boolean;
		}>
	> = {};

	// Add space-level sharing
	spaceSharing.forEach((space) => {
		if (!sharedSpacesMap[space.videoId]) {
			sharedSpacesMap[space.videoId] = [];
		}
		sharedSpacesMap[space.videoId]?.push({
			id: space.id,
			name: space.name,
			organizationId: space.organizationId,
			isOrg: false,
			iconUrl: space.iconUrl,
			settings: space.settings,
			hasPassword: space.hasPassword,
		});
	});

	// Add organization-level sharing
	orgSharing.forEach((org) => {
		if (!sharedSpacesMap[org.videoId]) {
			sharedSpacesMap[org.videoId] = [];
		}
		sharedSpacesMap[org.videoId]?.push({
			id: org.id,
			name: org.name,
			organizationId: org.organizationId,
			isOrg: true,
			iconUrl: org.iconUrl,
			settings: null,
			hasPassword: false,
		});
	});

	return sharedSpacesMap;
});

export default async function CapsPage(props: PageProps<"/dashboard/caps">) {
	const searchParams = await props.searchParams;
	const user = await getCurrentUser();

	if (!user || !user.id) {
		redirect("/login");
	}

	const page = Number(searchParams.page) || 1;
	const limit = Number(searchParams.limit) || 15;

	const userId = user.id;
	const offset = (page - 1) * limit;

	const totalCountResult = await db()
		.select({ count: count() })
		.from(videos)
		.leftJoin(organizations, eq(videos.orgId, organizations.id))
		.where(
			and(
				eq(videos.ownerId, userId),
				eq(organizations.id, user.activeOrganizationId),
				isNull(organizations.tombstoneAt),
			),
		);

	const totalCount = totalCountResult[0]?.count || 0;

	const videoData = await db()
		.select({
			id: videos.id,
			ownerId: videos.ownerId,
			name: videos.name,
			createdAt: videos.createdAt,
			metadata: videos.metadata,
			source: videos.source,
			isScreenshot: videos.isScreenshot,
			duration: videos.duration,
			public: videos.public,
			totalComments: sql<number>`COUNT(DISTINCT CASE WHEN ${comments.type} = 'text' THEN ${comments.id} END)`,
			totalReactions: sql<number>`COUNT(DISTINCT CASE WHEN ${comments.type} = 'emoji' THEN ${comments.id} END)`,
			sharedOrganizations: sql<
				{
					id: string;
					name: string;
					iconUrl: ImageUpload.ImageUrlOrKey | null;
				}[]
			>`
        COALESCE(
          JSON_ARRAYAGG(
            JSON_OBJECT(
              'id', ${organizations.id},
              'name', ${organizations.name},
              'iconUrl', ${organizations.iconUrl}
            )
          ),
          JSON_ARRAY()
        )
      `,
			ownerName: users.name,
			effectiveDate: videos.effectiveCreatedAt,
			hasPassword: sql`${videos.password} IS NOT NULL`.mapWith(Boolean),
			hasActiveUpload:
				sql`${videoUploads.videoId} IS NOT NULL AND ${videos.isScreenshot} = false`.mapWith(
					Boolean,
				),
			settings: videos.settings,
		})
		.from(videos)
		.leftJoin(comments, eq(videos.id, comments.videoId))
		.leftJoin(organizations, eq(videos.orgId, organizations.id))
		.leftJoin(users, eq(videos.ownerId, users.id))
		.leftJoin(videoUploads, eq(videos.id, videoUploads.videoId))
		.where(
			and(
				eq(videos.ownerId, userId),
				eq(videos.orgId, user.activeOrganizationId),
				isNull(videos.folderId),
				isNull(organizations.tombstoneAt),
			),
		)
		.groupBy(
			videos.id,
			videos.ownerId,
			videos.name,
			videos.createdAt,
			videos.metadata,
			videos.source,
			videos.isScreenshot,
			videos.duration,
			videos.public,
			videos.password,
			videos.settings,
			videos.orgId,
			users.name,
		)
		.orderBy(desc(videos.effectiveCreatedAt))
		.limit(limit)
		.offset(offset);

	const foldersData = await db()
		.select({
			id: folders.id,
			name: folders.name,
			color: folders.color,
			public: folders.public,
			parentId: folders.parentId,
			videoCount: sql<number>`(
        SELECT COUNT(*) FROM videos WHERE videos.folderId = folders.id
      )`,
		})
		.from(folders)
		.where(
			and(
				eq(folders.organizationId, user.activeOrganizationId),
				eq(folders.createdById, user.id),
				isNull(folders.parentId),
				isNull(folders.spaceId),
			),
		);

	// Fetch shared spaces data for all videos
	const videoIds = videoData.map((video) => video.id);
	const sharedSpacesMap =
		await getSharedSpacesForVideos(videoIds).pipe(runPromise);
	const [organizationSettingsRow] = user.activeOrganizationId
		? await db()
				.select({ settings: organizations.settings })
				.from(organizations)
				.where(eq(organizations.id, user.activeOrganizationId))
				.limit(1)
		: [];
	const organizationSettings = organizationSettingsRow?.settings ?? null;

	const processedVideoData = await Effect.all(
		videoData.map(
			Effect.fn(function* (video) {
				const imageUploads = yield* ImageUploads;

				const { effectiveDate: _effectiveDate, ...videoWithoutEffectiveDate } =
					video;
				const sharedSpaces = sharedSpacesMap[video.id] ?? [];
				const rules = resolveEffectiveVideoRules({
					videoSettings: video.settings,
					organizationSettings,
					spaces: sharedSpaces.filter((space) => !space.isOrg),
				});

				return {
					...videoWithoutEffectiveDate,
					id: Video.VideoId.make(video.id),
					foldersData,
					settings: video.settings,
					hasInheritedPassword: rules.hasInheritedPassword,
					inheritedPasswordSources: rules.inheritedPasswordSources,
					inheritedSpaceSettings: rules.inheritedSettings,
					sharedOrganizations: yield* Effect.all(
						(video.sharedOrganizations ?? [])
							.filter((organization) => organization.id !== null)
							.map(
								Effect.fn(function* (org) {
									return {
										...org,
										iconUrl: org.iconUrl
											? yield* imageUploads.resolveImageUrl(org.iconUrl)
											: null,
									};
								}),
							),
					),
					sharedSpaces: yield* Effect.all(
						sharedSpaces.map(
							Effect.fn(function* (space) {
								return {
									...space,
									iconUrl: space.iconUrl
										? yield* imageUploads.resolveImageUrl(space.iconUrl)
										: null,
								};
							}),
						),
					),
					ownerName: video.ownerName ?? "",
					metadata: video.metadata as
						| {
								customCreatedAt?: string;
								[key: string]: unknown;
						  }
						| undefined,
				};
			}),
		),
	).pipe(runPromise);

	return (
		<Caps
			data={processedVideoData}
			folders={foldersData}
			count={totalCount}
			analyticsEnabled={Boolean(
				serverEnv().TINYBIRD_TOKEN && serverEnv().TINYBIRD_HOST,
			)}
		/>
	);
}
