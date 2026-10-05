import { db } from "@cap/database";
import { organizations, users } from "@cap/database/schema";
import { userIsPro } from "@cap/utils";
import type { Organisation, User } from "@cap/web-domain";
import { eq } from "drizzle-orm";
import { shareLinkUrl } from "./share-link";
import { linkPreviewImagePath, readLinkPreview } from "./share-link-preview";
import type { ShareVideoLinkPreview } from "./share-video-metadata";

/** The verified custom domain of the organization a Cap belongs to. */
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

/**
 * The parts of a share page's metadata the owner controls. A failed lookup
 * falls back to the defaults: no overrides, canonical on the visited host.
 */
export async function getShareLinkPreviewMetadata({
	videoId,
	ownerId,
	organizationId,
	metadata,
	webUrl,
}: {
	videoId: string;
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

	return {
		linkPreview: stored
			? {
					title: stored.title ?? null,
					description: stored.description ?? null,
					image: stored.image
						? {
								url: new URL(
									linkPreviewImagePath(videoId, stored.image),
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
