import "server-only";

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
import type { VideoMetadata } from "@cap/database/types";
import { userIsPro } from "@cap/utils";
import { ImageUploads } from "@cap/web-backend";
import {
	type Folder,
	type ImageUpload,
	type Organisation,
	PublicCollection as PublicCollectionDomain,
	type Space,
	Video,
} from "@cap/web-domain";
import { and, desc, eq, inArray, isNull, type SQL, sql } from "drizzle-orm";
import { Effect } from "effect";
import { cache } from "react";
import { getVerifiedPasswordHashes } from "@/lib/password-cookie";
import {
	PUBLIC_COLLECTION_PAGE_SIZE,
	type PublicCollectionAccess,
	type PublicCollectionKind,
	resolvePublicCollectionAccess,
	resolvePublicCollectionCandidate,
} from "@/lib/public-collections-policy";
import { runPromise } from "@/lib/server";

export type PublicCollection = {
	id: string;
	kind: PublicCollectionKind;
	name: string;
	color: "normal" | "blue" | "red" | "yellow" | null;
	description: string | null;
	spaceId: Space.SpaceIdOrOrganisationId | null;
	organizationId: Organisation.OrganisationId;
	organizationName: string;
	allowedEmailDomain: string | null;
	passwordHash: string | null;
	publicPage: Required<PublicCollectionDomain.PublicPageSettings>;
	organizationIconUrl: ImageUpload.ImageUrl | null;
	collectionLogoUrl: ImageUpload.ImageUrl | null;
};

export type PublicCollectionFolder = {
	id: Folder.FolderId;
	name: string;
	color: "normal" | "blue" | "red" | "yellow";
	parentId: Folder.FolderId | null;
	videoCount: number;
};

/**
 * Exactly the fields the public cap card renders — this object is serialized
 * into the RSC payload of an anonymous page, so internal video settings,
 * sources, and owner/org ids deliberately stay out of it.
 */
export type PublicCollectionVideo = {
	id: Video.VideoId;
	name: string;
	createdAt: Date;
	// Only the owner-set display date — never the full metadata JSON, which
	// holds internal fields (sourceName, AI summary, processing state).
	metadata: Pick<VideoMetadata, "customCreatedAt"> | undefined;
	duration: number | null;
	totalComments: number;
	totalReactions: number;
	ownerName: string;
	hasPassword: boolean;
	hasActiveUpload: boolean;
};

type PublicCollectionVideoRow = {
	id: string;
	name: string;
	createdAt: Date;
	metadata: (typeof videos.$inferSelect)["metadata"];
	duration: number | null;
	totalComments: number;
	totalReactions: number;
	ownerName: string | null;
	hasPassword: boolean;
	hasActiveUpload: boolean;
};

export type PublicCollectionPageData = {
	collection: PublicCollection;
	access: PublicCollectionAccess;
	folders: PublicCollectionFolder[];
	videos: PublicCollectionVideo[];
	currentPage: number;
	totalCount: number;
	totalPages: number;
	viewerIsSignedIn: boolean;
};

function videoPasswordPredicate(
	videoId: SQL,
	videoPassword: SQL,
	verifiedPasswordHashes: readonly string[],
) {
	const noPassword = sql`(${videoPassword} IS NULL AND NOT EXISTS (
		SELECT 1 FROM space_videos sv_password
		INNER JOIN spaces s_password ON sv_password.spaceId = s_password.id
		WHERE sv_password.videoId = ${videoId}
			AND s_password.password IS NOT NULL
	))`;

	if (verifiedPasswordHashes.length === 0) return noPassword;

	const verifiedHashes = sql.join(
		verifiedPasswordHashes.map((hash) => sql`${hash}`),
		sql`, `,
	);

	return sql`(${noPassword}
		OR ${videoPassword} IN (${verifiedHashes})
		OR EXISTS (
			SELECT 1 FROM space_videos sv_password
			INNER JOIN spaces s_password ON sv_password.spaceId = s_password.id
			WHERE sv_password.videoId = ${videoId}
				AND s_password.password IN (${verifiedHashes})
		)
	)`;
}

function hasPasswordExpression(videoId: SQL, videoPassword: SQL) {
	return sql`${videoPassword} IS NOT NULL OR EXISTS (
		SELECT 1 FROM space_videos sv_password
		INNER JOIN spaces s_password ON sv_password.spaceId = s_password.id
		WHERE sv_password.videoId = ${videoId}
			AND s_password.password IS NOT NULL
	)`;
}

export async function getPublicCollectionMetadata(collectionId: string) {
	return resolvePublicCollection(collectionId);
}

export async function getPublicCollectionPageData(
	collectionId: string,
	page: number,
): Promise<PublicCollectionPageData | null> {
	const [collection, user, verifiedPasswordHashes] = await Promise.all([
		resolvePublicCollection(collectionId),
		getCurrentUser(),
		getVerifiedPasswordHashes(),
	]);

	if (!collection) return null;

	const access = resolvePublicCollectionAccess({
		allowedEmailDomain: collection.allowedEmailDomain,
		viewerEmail: user?.email,
		passwordHash: collection.passwordHash,
		verifiedPasswordHashes,
	});

	if (access.state !== "allowed") {
		return {
			collection,
			access,
			folders: [],
			videos: [],
			currentPage: page,
			totalCount: 0,
			totalPages: 0,
			viewerIsSignedIn: Boolean(user),
		};
	}

	const [childFolders, videoPage] = await Promise.all([
		getPublicChildFolders(collection, verifiedPasswordHashes),
		getPublicCollectionVideos(collection, page, verifiedPasswordHashes),
	]);

	return {
		collection,
		access,
		folders: childFolders,
		videos: videoPage.videos,
		currentPage: page,
		totalCount: videoPage.totalCount,
		totalPages: Math.ceil(videoPage.totalCount / PUBLIC_COLLECTION_PAGE_SIZE),
		viewerIsSignedIn: Boolean(user),
	};
}

async function resolveIconUrls(keys: {
	organizationIconUrl: ImageUpload.ImageUrlOrKey | null;
	collectionLogoUrl: ImageUpload.ImageUrlOrKey | null;
}): Promise<{
	organizationIconUrl: ImageUpload.ImageUrl | null;
	collectionLogoUrl: ImageUpload.ImageUrl | null;
}> {
	const empty = {
		organizationIconUrl: null,
		collectionLogoUrl: null,
	};

	if (!keys.organizationIconUrl && !keys.collectionLogoUrl) {
		return empty;
	}

	return Effect.gen(function* () {
		const imageUploads = yield* ImageUploads;
		const resolve = (key: ImageUpload.ImageUrlOrKey | null) =>
			key ? imageUploads.resolveImageUrl(key) : Effect.succeed(null);

		return {
			organizationIconUrl: yield* resolve(keys.organizationIconUrl),
			collectionLogoUrl: yield* resolve(keys.collectionLogoUrl),
		};
	}).pipe(runPromise);
}

function collectionLogoKey(
	publicPage: Required<PublicCollectionDomain.PublicPageSettings>,
): ImageUpload.ImageUrlOrKey | null {
	return publicPage.logoUrl
		? (publicPage.logoUrl as ImageUpload.ImageUrlOrKey)
		: null;
}

function publicPageIconKeys(
	publicPage: Required<PublicCollectionDomain.PublicPageSettings>,
	keys: {
		organizationIconUrl: ImageUpload.ImageUrlOrKey | null;
	},
) {
	return {
		organizationIconUrl:
			publicPage.logoMode === "organization" ? keys.organizationIconUrl : null,
		collectionLogoUrl:
			publicPage.logoMode === "custom" ? collectionLogoKey(publicPage) : null,
	};
}

/**
 * Custom presentation (branding, CTA, hidden Cap logo) is a Pro entitlement
 * gated on the org OWNER's plan at render time, mirroring `/s/`
 * (`getSharePageBranding`): when the owner downgrades, already-public
 * collections stay reachable but fall back to the default presentation.
 */
function resolveEffectivePublicPage(
	ownerIsPro: boolean,
	stored: PublicCollectionDomain.PublicPageSettings | null | undefined,
) {
	return PublicCollectionDomain.resolvePublicPageSettings(
		ownerIsPro ? stored : null,
	);
}

const resolvePublicCollection = cache(
	async (collectionId: string): Promise<PublicCollection | null> => {
		// Fetched by primary key — both lookups in parallel since the id's kind
		// isn't known up front — then gated in `resolvePublicCollectionCandidate`
		// so the public/tombstone policy lives in one tested place.
		const [[folderRow], [spaceRow]] = await Promise.all([
			db()
				.select({
					id: folders.id,
					name: folders.name,
					color: folders.color,
					public: folders.public,
					settings: folders.settings,
					spaceId: folders.spaceId,
					organizationId: folders.organizationId,
					organizationName: organizations.name,
					organizationTombstoneAt: organizations.tombstoneAt,
					allowedEmailDomain: organizations.allowedEmailDomain,
					organizationIconUrl: organizations.iconUrl,
					ownerStripeSubscriptionStatus: users.stripeSubscriptionStatus,
					ownerThirdPartyStripeSubscriptionId:
						users.thirdPartyStripeSubscriptionId,
					passwordHash: spaces.password,
				})
				.from(folders)
				.innerJoin(organizations, eq(folders.organizationId, organizations.id))
				.innerJoin(users, eq(organizations.ownerId, users.id))
				.leftJoin(spaces, eq(folders.spaceId, spaces.id))
				.where(eq(folders.id, collectionId as Folder.FolderId))
				.limit(1),
			db()
				.select({
					id: spaces.id,
					name: spaces.name,
					description: spaces.description,
					public: spaces.public,
					settings: spaces.settings,
					organizationId: spaces.organizationId,
					organizationName: organizations.name,
					organizationTombstoneAt: organizations.tombstoneAt,
					allowedEmailDomain: organizations.allowedEmailDomain,
					organizationIconUrl: organizations.iconUrl,
					ownerStripeSubscriptionStatus: users.stripeSubscriptionStatus,
					ownerThirdPartyStripeSubscriptionId:
						users.thirdPartyStripeSubscriptionId,
					passwordHash: spaces.password,
				})
				.from(spaces)
				.innerJoin(organizations, eq(spaces.organizationId, organizations.id))
				.innerJoin(users, eq(organizations.ownerId, users.id))
				.where(eq(spaces.id, collectionId as Space.SpaceIdOrOrganisationId))
				.limit(1),
		]);

		const candidate = resolvePublicCollectionCandidate(
			folderRow ? { kind: "folder" as const, ...folderRow } : null,
			spaceRow ? { kind: "space" as const, ...spaceRow } : null,
		);

		if (!candidate) return null;

		const publicPage = resolveEffectivePublicPage(
			userIsPro({
				stripeSubscriptionStatus: candidate.ownerStripeSubscriptionStatus,
				thirdPartyStripeSubscriptionId:
					candidate.ownerThirdPartyStripeSubscriptionId,
			}),
			candidate.settings?.publicPage,
		);
		const icons = await resolveIconUrls(
			publicPageIconKeys(publicPage, {
				organizationIconUrl: candidate.organizationIconUrl,
			}),
		);

		const shared = {
			name: candidate.name,
			organizationId: candidate.organizationId,
			organizationName: candidate.organizationName,
			allowedEmailDomain: candidate.allowedEmailDomain,
			passwordHash: candidate.passwordHash,
			publicPage,
			...icons,
		};

		if (candidate.kind === "folder") {
			return {
				...shared,
				id: candidate.id,
				kind: "folder",
				color: candidate.color,
				description: null,
				spaceId: candidate.spaceId,
			};
		}

		return {
			...shared,
			id: candidate.id,
			kind: "space",
			color: null,
			description: candidate.description,
			spaceId: candidate.id,
		};
	},
);

/**
 * Single source of truth for which password protects a public collection
 * (a folder inherits its parent space's password). Reused by the password
 * verification action so it can never drift from what the page checks.
 */
export async function getPublicCollectionPasswordHash(
	collectionId: string,
): Promise<string | null> {
	const collection = await resolvePublicCollection(collectionId);
	return collection?.passwordHash ?? null;
}

/**
 * Folders in the org-wide shared area carry the ORGANIZATION id as their
 * spaceId (the "all spaces" entry) and track membership in `shared_videos`,
 * not `space_videos`.
 */
function isOrgLevelFolder(collection: PublicCollection) {
	return (
		collection.kind === "folder" &&
		collection.spaceId === collection.organizationId
	);
}

async function getPublicCollectionVideos(
	collection: PublicCollection,
	page: number,
	verifiedPasswordHashes: readonly string[],
) {
	if (collection.kind === "space") {
		return getPublicSpaceVideos(collection, page, verifiedPasswordHashes);
	}

	if (isOrgLevelFolder(collection)) {
		return getPublicOrgFolderVideos(collection, page, verifiedPasswordHashes);
	}

	if (collection.spaceId) {
		return getPublicSpaceFolderVideos(collection, page, verifiedPasswordHashes);
	}

	return getPublicUserFolderVideos(collection, page, verifiedPasswordHashes);
}

const videoSelect = {
	id: videos.id,
	name: videos.name,
	createdAt: videos.createdAt,
	metadata: videos.metadata,
	duration: videos.duration,
	totalComments: sql<number>`COUNT(DISTINCT CASE WHEN ${comments.type} = 'text' THEN ${comments.id} END)`,
	totalReactions: sql<number>`COUNT(DISTINCT CASE WHEN ${comments.type} = 'emoji' THEN ${comments.id} END)`,
	ownerName: users.name,
	hasPassword: hasPasswordExpression(
		sql`${videos.id}`,
		sql`${videos.password}`,
	).mapWith(Boolean),
	hasActiveUpload: sql`MAX(${videoUploads.videoId} IS NOT NULL)`.mapWith(
		Boolean,
	),
};

const videoGroupBy = [
	videos.id,
	videos.ownerId,
	videos.orgId,
	videos.name,
	videos.createdAt,
	videos.metadata,
	videos.source,
	videos.isScreenshot,
	videos.duration,
	videos.public,
	videos.settings,
	videos.password,
	users.name,
];

function toPublicCollectionVideos(
	videoRows: PublicCollectionVideoRow[],
): PublicCollectionVideo[] {
	return videoRows.map((video) => ({
		id: Video.VideoId.make(video.id),
		name: video.name,
		createdAt: video.createdAt,
		metadata: video.metadata?.customCreatedAt
			? { customCreatedAt: video.metadata.customCreatedAt }
			: undefined,
		duration: video.duration,
		totalComments: video.totalComments,
		totalReactions: video.totalReactions,
		ownerName: video.ownerName ?? "",
		hasPassword: video.hasPassword,
		hasActiveUpload: video.hasActiveUpload,
	}));
}

async function getPublicSpaceVideos(
	collection: PublicCollection,
	page: number,
	verifiedPasswordHashes: readonly string[],
) {
	const offset = (page - 1) * PUBLIC_COLLECTION_PAGE_SIZE;
	const where = and(
		eq(spaceVideos.spaceId, collection.id as Space.SpaceIdOrOrganisationId),
		isNull(spaceVideos.folderId),
		eq(videos.public, true),
		isNull(organizations.tombstoneAt),
		videoPasswordPredicate(
			sql`${videos.id}`,
			sql`${videos.password}`,
			verifiedPasswordHashes,
		),
	);

	const [videoRows, totalCountResult] = await Promise.all([
		db()
			.select(videoSelect)
			.from(spaceVideos)
			.innerJoin(videos, eq(spaceVideos.videoId, videos.id))
			.innerJoin(organizations, eq(videos.orgId, organizations.id))
			.leftJoin(comments, eq(videos.id, comments.videoId))
			.leftJoin(users, eq(videos.ownerId, users.id))
			.leftJoin(videoUploads, eq(videos.id, videoUploads.videoId))
			.where(where)
			.groupBy(...videoGroupBy)
			.orderBy(desc(videos.effectiveCreatedAt))
			.limit(PUBLIC_COLLECTION_PAGE_SIZE)
			.offset(offset),
		db()
			.select({ count: sql<number>`COUNT(DISTINCT ${videos.id})` })
			.from(spaceVideos)
			.innerJoin(videos, eq(spaceVideos.videoId, videos.id))
			.innerJoin(organizations, eq(videos.orgId, organizations.id))
			.where(where),
	]);

	return {
		videos: toPublicCollectionVideos(videoRows),
		totalCount: totalCountResult[0]?.count ?? 0,
	};
}

async function getPublicSpaceFolderVideos(
	collection: PublicCollection,
	page: number,
	verifiedPasswordHashes: readonly string[],
) {
	const offset = (page - 1) * PUBLIC_COLLECTION_PAGE_SIZE;
	const where = and(
		eq(spaceVideos.folderId, collection.id as Folder.FolderId),
		eq(videos.public, true),
		isNull(organizations.tombstoneAt),
		videoPasswordPredicate(
			sql`${videos.id}`,
			sql`${videos.password}`,
			verifiedPasswordHashes,
		),
	);

	const [videoRows, totalCountResult] = await Promise.all([
		db()
			.select(videoSelect)
			.from(spaceVideos)
			.innerJoin(videos, eq(spaceVideos.videoId, videos.id))
			.innerJoin(organizations, eq(videos.orgId, organizations.id))
			.leftJoin(comments, eq(videos.id, comments.videoId))
			.leftJoin(users, eq(videos.ownerId, users.id))
			.leftJoin(videoUploads, eq(videos.id, videoUploads.videoId))
			.where(where)
			.groupBy(...videoGroupBy)
			.orderBy(desc(videos.effectiveCreatedAt))
			.limit(PUBLIC_COLLECTION_PAGE_SIZE)
			.offset(offset),
		db()
			.select({ count: sql<number>`COUNT(DISTINCT ${videos.id})` })
			.from(spaceVideos)
			.innerJoin(videos, eq(spaceVideos.videoId, videos.id))
			.innerJoin(organizations, eq(videos.orgId, organizations.id))
			.where(where),
	]);

	return {
		videos: toPublicCollectionVideos(videoRows),
		totalCount: totalCountResult[0]?.count ?? 0,
	};
}

async function getPublicOrgFolderVideos(
	collection: PublicCollection,
	page: number,
	verifiedPasswordHashes: readonly string[],
) {
	const offset = (page - 1) * PUBLIC_COLLECTION_PAGE_SIZE;
	const where = and(
		eq(sharedVideos.folderId, collection.id as Folder.FolderId),
		eq(videos.public, true),
		isNull(organizations.tombstoneAt),
		videoPasswordPredicate(
			sql`${videos.id}`,
			sql`${videos.password}`,
			verifiedPasswordHashes,
		),
	);

	const [videoRows, totalCountResult] = await Promise.all([
		db()
			.select(videoSelect)
			.from(sharedVideos)
			.innerJoin(videos, eq(sharedVideos.videoId, videos.id))
			.innerJoin(organizations, eq(videos.orgId, organizations.id))
			.leftJoin(comments, eq(videos.id, comments.videoId))
			.leftJoin(users, eq(videos.ownerId, users.id))
			.leftJoin(videoUploads, eq(videos.id, videoUploads.videoId))
			.where(where)
			.groupBy(...videoGroupBy)
			.orderBy(desc(videos.effectiveCreatedAt))
			.limit(PUBLIC_COLLECTION_PAGE_SIZE)
			.offset(offset),
		db()
			.select({ count: sql<number>`COUNT(DISTINCT ${videos.id})` })
			.from(sharedVideos)
			.innerJoin(videos, eq(sharedVideos.videoId, videos.id))
			.innerJoin(organizations, eq(videos.orgId, organizations.id))
			.where(where),
	]);

	return {
		videos: toPublicCollectionVideos(videoRows),
		totalCount: totalCountResult[0]?.count ?? 0,
	};
}

async function getPublicUserFolderVideos(
	collection: PublicCollection,
	page: number,
	verifiedPasswordHashes: readonly string[],
) {
	const offset = (page - 1) * PUBLIC_COLLECTION_PAGE_SIZE;
	const where = and(
		eq(videos.folderId, collection.id as Folder.FolderId),
		eq(videos.public, true),
		isNull(organizations.tombstoneAt),
		videoPasswordPredicate(
			sql`${videos.id}`,
			sql`${videos.password}`,
			verifiedPasswordHashes,
		),
	);

	const [videoRows, totalCountResult] = await Promise.all([
		db()
			.select(videoSelect)
			.from(videos)
			.innerJoin(organizations, eq(videos.orgId, organizations.id))
			.leftJoin(comments, eq(videos.id, comments.videoId))
			.leftJoin(users, eq(videos.ownerId, users.id))
			.leftJoin(videoUploads, eq(videos.id, videoUploads.videoId))
			.where(where)
			.groupBy(...videoGroupBy)
			.orderBy(desc(videos.effectiveCreatedAt))
			.limit(PUBLIC_COLLECTION_PAGE_SIZE)
			.offset(offset),
		db()
			.select({ count: sql<number>`COUNT(DISTINCT ${videos.id})` })
			.from(videos)
			.innerJoin(organizations, eq(videos.orgId, organizations.id))
			.where(where),
	]);

	return {
		videos: toPublicCollectionVideos(videoRows),
		totalCount: totalCountResult[0]?.count ?? 0,
	};
}

async function getPublicChildFolders(
	collection: PublicCollection,
	verifiedPasswordHashes: readonly string[],
): Promise<PublicCollectionFolder[]> {
	const where =
		collection.kind === "space"
			? and(
					eq(folders.spaceId, collection.id as Space.SpaceIdOrOrganisationId),
					isNull(folders.parentId),
					eq(folders.public, true),
					isNull(organizations.tombstoneAt),
				)
			: and(
					eq(folders.parentId, collection.id as Folder.FolderId),
					eq(folders.public, true),
					isNull(organizations.tombstoneAt),
				);

	const childFolders = await db()
		.select({
			id: folders.id,
			name: folders.name,
			color: folders.color,
			parentId: folders.parentId,
		})
		.from(folders)
		.innerJoin(organizations, eq(folders.organizationId, organizations.id))
		.where(where)
		.orderBy(folders.name);

	if (childFolders.length === 0) return [];

	const folderIds = childFolders.map((folder) => folder.id);
	const counts = isOrgLevelFolder(collection)
		? await getPublicOrgFolderVideoCounts(folderIds, verifiedPasswordHashes)
		: collection.kind === "space" || Boolean(collection.spaceId)
			? await getPublicSpaceFolderVideoCounts(folderIds, verifiedPasswordHashes)
			: await getPublicUserFolderVideoCounts(folderIds, verifiedPasswordHashes);
	const countByFolderId = new Map(
		counts.map((row) => [row.folderId, row.videoCount]),
	);

	return childFolders.map((folder) => ({
		...folder,
		videoCount: countByFolderId.get(folder.id) ?? 0,
	}));
}

async function getPublicSpaceFolderVideoCounts(
	folderIds: Folder.FolderId[],
	verifiedPasswordHashes: readonly string[],
) {
	return db()
		.select({
			folderId: spaceVideos.folderId,
			videoCount: sql<number>`COUNT(DISTINCT ${videos.id})`,
		})
		.from(spaceVideos)
		.innerJoin(videos, eq(spaceVideos.videoId, videos.id))
		.innerJoin(organizations, eq(videos.orgId, organizations.id))
		.where(
			and(
				inArray(spaceVideos.folderId, folderIds),
				eq(videos.public, true),
				isNull(organizations.tombstoneAt),
				videoPasswordPredicate(
					sql`${videos.id}`,
					sql`${videos.password}`,
					verifiedPasswordHashes,
				),
			),
		)
		.groupBy(spaceVideos.folderId);
}

async function getPublicOrgFolderVideoCounts(
	folderIds: Folder.FolderId[],
	verifiedPasswordHashes: readonly string[],
) {
	return db()
		.select({
			folderId: sharedVideos.folderId,
			videoCount: sql<number>`COUNT(DISTINCT ${videos.id})`,
		})
		.from(sharedVideos)
		.innerJoin(videos, eq(sharedVideos.videoId, videos.id))
		.innerJoin(organizations, eq(videos.orgId, organizations.id))
		.where(
			and(
				inArray(sharedVideos.folderId, folderIds),
				eq(videos.public, true),
				isNull(organizations.tombstoneAt),
				videoPasswordPredicate(
					sql`${videos.id}`,
					sql`${videos.password}`,
					verifiedPasswordHashes,
				),
			),
		)
		.groupBy(sharedVideos.folderId);
}

async function getPublicUserFolderVideoCounts(
	folderIds: Folder.FolderId[],
	verifiedPasswordHashes: readonly string[],
) {
	return db()
		.select({
			folderId: videos.folderId,
			videoCount: sql<number>`COUNT(DISTINCT ${videos.id})`,
		})
		.from(videos)
		.innerJoin(organizations, eq(videos.orgId, organizations.id))
		.where(
			and(
				inArray(videos.folderId, folderIds),
				eq(videos.public, true),
				isNull(organizations.tombstoneAt),
				videoPasswordPredicate(
					sql`${videos.id}`,
					sql`${videos.password}`,
					verifiedPasswordHashes,
				),
			),
		)
		.groupBy(videos.folderId);
}
