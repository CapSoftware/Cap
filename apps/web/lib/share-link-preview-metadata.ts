import { db } from "@cap/database";
import { organizations, users, videos } from "@cap/database/schema";
import { userIsPro } from "@cap/utils";
import type { Organisation, User, Video } from "@cap/web-domain";
import { eq, sql } from "drizzle-orm";
import { shareLinkUrl } from "./share-link";
import {
	linkPreviewAccessKey,
	linkPreviewImagePath,
	readLinkPreview,
} from "./share-link-preview";
import type { ShareVideoLinkPreview } from "./share-video-metadata";
import { getSharedSpacesForVideo } from "./video-shared-spaces";

export async function organizationShareDomain(
	organizationId: Organisation.OrganisationId,
): Promise<string | null> {
	const [organization] = await db()
		.select({
			customDomain: organizations.customDomain,
			domainVerified: organizations.domainVerified,
		})
		.from(organizations)
		.where(eq(organizations.id, organizationId))
		.limit(1);
	return organization?.customDomain && organization.domainVerified !== null
		? organization.customDomain.toLowerCase()
		: null;
}

export async function getLinkPreviewAccessKey(
	videoId: Video.VideoId,
): Promise<string> {
	const [[video], { sharedSpaces, sharedOrganizations }] = await Promise.all([
		db()
			.select({
				public: videos.public,
				hasPassword: sql`${videos.password} IS NOT NULL`.mapWith(Boolean),
				allowedEmailDomain: organizations.allowedEmailDomain,
			})
			.from(videos)
			.leftJoin(organizations, eq(videos.orgId, organizations.id))
			.where(eq(videos.id, videoId))
			.limit(1),
		getSharedSpacesForVideo(videoId),
	]);
	const organizationIds = new Set<string>(
		sharedOrganizations.map(({ id }) => id),
	);
	return linkPreviewAccessKey({
		public: video?.public ?? false,
		hasPassword: video?.hasPassword ?? true,
		allowedEmailDomain: video?.allowedEmailDomain ?? null,
		spaces: sharedSpaces
			.filter((space) => !organizationIds.has(space.id))
			.map((space) => ({
				id: space.id,
				hasPassword: Boolean(space.hasPassword),
			})),
		organizationIds: [...organizationIds],
	});
}

/**
 * Whether a Cap's owner can have their link preview served. Like the call to
 * action and custom branding, it pauses while they don't have Cap Pro; the
 * saved preview comes back if they subscribe again.
 */
export async function ownerServesLinkPreview(
	ownerId: User.UserId,
): Promise<boolean> {
	const [owner] = await db()
		.select({
			stripeSubscriptionStatus: users.stripeSubscriptionStatus,
			thirdPartyStripeSubscriptionId: users.thirdPartyStripeSubscriptionId,
		})
		.from(users)
		.where(eq(users.id, ownerId))
		.limit(1);
	return userIsPro(owner ?? null);
}

export async function getShareLinkPreviewMetadata({
	videoId,
	ownerId,
	organizationId,
	metadata,
	webUrl,
}: {
	videoId: Video.VideoId;
	ownerId: User.UserId;
	organizationId: Organisation.OrganisationId;
	metadata: unknown;
	webUrl: string;
}): Promise<{
	linkPreview: ShareVideoLinkPreview | null;
	canonicalShareUrl: string | null;
}> {
	const saved = readLinkPreview(metadata, videoId);
	const [domain, serves] = await Promise.all([
		organizationShareDomain(organizationId).catch((error) => {
			console.error("Failed to resolve the share link's custom domain", error);
			return null;
		}),
		saved
			? ownerServesLinkPreview(ownerId).catch((error) => {
					console.error(
						"Failed to check the owner's plan for link previews",
						error,
					);
					return false;
				})
			: false,
	]);
	const stored = serves ? saved : null;
	const accessKey = stored?.image
		? await getLinkPreviewAccessKey(videoId).catch((error) => {
				console.error(
					"Failed to read a Cap's access for its link preview",
					error,
				);
				return null;
			})
		: null;

	return {
		linkPreview: stored
			? {
					title: stored.title ?? null,
					description: stored.description ?? null,
					image:
						stored.image && accessKey !== null
							? {
									url: new URL(
										linkPreviewImagePath(videoId, stored.image, accessKey),
										webUrl,
									).toString(),
									width: stored.image.width,
									height: stored.image.height,
									type: stored.image.contentType,
								}
							: null,
				}
			: null,
		canonicalShareUrl: domain ? shareLinkUrl(videoId, domain) : null,
	};
}
