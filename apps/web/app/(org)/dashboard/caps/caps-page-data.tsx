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
	videoNotes,
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
import {
	and,
	desc,
	eq,
	inArray,
	isNotNull,
	isNull,
	or,
	type SQL,
	sql,
} from "drizzle-orm";
import { unionAll } from "drizzle-orm/mysql-core";
import { type Array, Effect } from "effect";
import { redirect } from "next/navigation";
import { CAP_KINDS, type CapKind } from "@/lib/cap-kind";
import { capKindCondition } from "@/lib/cap-kind-query";
import { resolveDashboardPageSize } from "@/lib/dashboard-page-size";
import { parsePageParam } from "@/lib/page-param";
import { seedThumbnailUrls } from "@/lib/seeded-thumbnails";
import { runPromise } from "@/lib/server";
import { Caps } from "./Caps";

// Helper function to fetch shared spaces data for videos
const getSharedSpacesForVideos = Effect.fn(function* (
	videoIds: Video.VideoId[],
) {
	if (videoIds.length === 0) return {};

	const db = yield* Database;

	const [spaceSharing, orgSharing] = yield* Effect.all(
		[
			db.use((db) =>
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
			),
			db.use((db) =>
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
			),
		],
		{ concurrency: "unbounded" },
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

const OVERVIEW_SECTION_SIZE: Record<CapKind, number> = {
	videos: 10,
	images: 5,
	notes: 5,
};

export async function CapsPageView({
	searchParams,
	view,
	kind,
}: {
	searchParams: Record<string, string | string[] | undefined>;
	view: "library" | "archived";
	kind?: CapKind;
}) {
	const user = await getCurrentUser();

	if (!user || !user.id) {
		redirect("/login");
	}

	const page = parsePageParam(searchParams.page);
	const limit = resolveDashboardPageSize({
		limitParam: searchParams.limit,
		preferences: user.preferences,
	});
	const isArchivedView = view === "archived";
	const isOverview = !isArchivedView && kind === undefined;

	const userId = user.id;
	const offset = (page - 1) * limit;

	// One pass gives both the library count and the archived count, so the
	// Archived entry costs no extra round trip. The OR keeps the library rows
	// (root, not archived) and every archived row, wherever it is filed.
	const libraryKindCount = (kind: CapKind) =>
		sql<number>`count(case when ${videos.archivedAt} is null and ${capKindCondition(kind) as SQL} then 1 end)`.mapWith(
			Number,
		);
	const totalCountPromise = db()
		.select({
			videos: libraryKindCount("videos"),
			images: libraryKindCount("images"),
			notes: libraryKindCount("notes"),
			archivedCount:
				sql<number>`count(case when ${videos.archivedAt} is not null then 1 end)`.mapWith(
					Number,
				),
		})
		.from(videos)
		.leftJoin(organizations, eq(videos.orgId, organizations.id))
		.where(
			and(
				eq(videos.ownerId, userId),
				eq(videos.orgId, user.activeOrganizationId),
				eq(organizations.id, user.activeOrganizationId),
				or(isNull(videos.folderId), isNotNull(videos.archivedAt)),
				isNull(organizations.tombstoneAt),
			),
		);

	const pageIds = (pageKind: CapKind | undefined, take: number, skip: number) =>
		db()
			.select({ id: videos.id })
			.from(videos)
			.leftJoin(organizations, eq(videos.orgId, organizations.id))
			.where(
				and(
					eq(videos.ownerId, userId),
					eq(videos.orgId, user.activeOrganizationId),
					isArchivedView
						? isNotNull(videos.archivedAt)
						: and(isNull(videos.folderId), isNull(videos.archivedAt)),
					pageKind ? capKindCondition(pageKind) : undefined,
					isNull(organizations.tombstoneAt),
				),
			)
			.orderBy(
				...(isArchivedView
					? [desc(videos.archivedAt), desc(videos.id)]
					: [desc(videos.effectiveCreatedAt), desc(videos.id)]),
			)
			.limit(take)
			.offset(skip);

	const capsPage = isOverview
		? unionAll(
				pageIds("videos", OVERVIEW_SECTION_SIZE.videos, 0),
				pageIds("images", OVERVIEW_SECTION_SIZE.images, 0),
				pageIds("notes", OVERVIEW_SECTION_SIZE.notes, 0),
			).as("caps_page")
		: pageIds(kind, limit, offset).as("caps_page");

	const videoDataPromise = db()
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
			archivedAt: videos.archivedAt,
			isNote: videos.isNote,
			noteExcerpt: videoNotes.excerpt,
		})
		.from(videos)
		.innerJoin(capsPage, eq(videos.id, capsPage.id))
		.leftJoin(comments, eq(videos.id, comments.videoId))
		.leftJoin(sharedVideos, eq(videos.id, sharedVideos.videoId))
		.leftJoin(organizations, eq(sharedVideos.organizationId, organizations.id))
		.leftJoin(users, eq(videos.ownerId, users.id))
		.leftJoin(videoUploads, eq(videos.id, videoUploads.videoId))
		.leftJoin(videoNotes, eq(videos.id, videoNotes.videoId))
		.groupBy(
			videos.id,
			videos.ownerId,
			videos.name,
			videos.createdAt,
			videos.metadata,
			videos.source,
			videos.isScreenshot,
			videos.isNote,
			videoNotes.excerpt,
			videos.duration,
			videos.public,
			videos.password,
			videos.settings,
			videos.orgId,
			videos.archivedAt,
			users.name,
		)
		.orderBy(
			...(isArchivedView
				? [desc(videos.archivedAt), desc(videos.id)]
				: [desc(videos.effectiveCreatedAt), desc(videos.id)]),
		);

	const foldersDataPromise = isArchivedView
		? Promise.resolve([])
		: db()
				.select({
					id: folders.id,
					name: folders.name,
					color: folders.color,
					public: folders.public,
					parentId: folders.parentId,
					createdAt: folders.createdAt,
					videoCount: sql<number>`(
        SELECT COUNT(*) FROM videos WHERE videos.folderId = folders.id AND videos.archivedAt IS NULL
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

	const organizationSettingsPromise = user.activeOrganizationId
		? db()
				.select({ settings: organizations.settings })
				.from(organizations)
				.where(eq(organizations.id, user.activeOrganizationId))
				.limit(1)
		: Promise.resolve([]);

	const [totalCountResult, videoData, foldersData, [organizationSettingsRow]] =
		await Promise.all([
			totalCountPromise,
			videoDataPromise,
			foldersDataPromise,
			organizationSettingsPromise,
		]);
	const counts = {
		videos: totalCountResult[0]?.videos ?? 0,
		images: totalCountResult[0]?.images ?? 0,
		notes: totalCountResult[0]?.notes ?? 0,
	};
	const archivedCount = totalCountResult[0]?.archivedCount ?? 0;
	const totalCount = isArchivedView
		? archivedCount
		: kind
			? counts[kind]
			: CAP_KINDS.reduce((total, each) => total + counts[each], 0);
	const organizationSettings = organizationSettingsRow?.settings ?? null;

	const videoIds = videoData.map((video) => video.id);
	const thumbnails = seedThumbnailUrls(
		user,
		videoData
			.filter((video) => !video.hasActiveUpload && !video.isNote)
			.map((video) => Video.VideoId.make(video.id)),
	);
	const sharedSpacesMap =
		await getSharedSpacesForVideos(videoIds).pipe(runPromise);

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
			counts={counts}
			kind={kind}
			thumbnails={thumbnails}
			pageSize={limit}
			archivedCount={archivedCount}
			view={view}
			analyticsEnabled={Boolean(
				serverEnv().TINYBIRD_TOKEN && serverEnv().TINYBIRD_HOST,
			)}
		/>
	);
}
