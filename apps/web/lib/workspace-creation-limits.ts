import type { db } from "@cap/database";
import { organizations, spaces, users } from "@cap/database/schema";
import type { Organisation, User } from "@cap/web-domain";
import { and, count, eq, isNull } from "drizzle-orm";
import { isRateLimited, RATE_LIMIT_IDS } from "@/lib/rate-limit";

export const ORGANIZATION_LIMIT = 50;
export const ORGANIZATION_LIMIT_MESSAGE = `You can own up to ${ORGANIZATION_LIMIT} organizations. Delete one you no longer use, or contact us.`;
export const ORGANIZATION_RATE_MESSAGE =
	"You are creating organizations too quickly. Try again in an hour.";

export const SPACE_LIMIT = 1000;
export const SPACE_LIMIT_MESSAGE = `An organization can have up to ${SPACE_LIMIT} spaces. Delete one you no longer use, or contact us.`;
export const SPACE_RATE_MESSAGE =
	"You are creating spaces too quickly. Try again in an hour.";

type Transaction = Parameters<
	Parameters<ReturnType<typeof db>["transaction"]>[0]
>[0];

export function organizationCreationLimited(userId: User.UserId) {
	return isRateLimited(RATE_LIMIT_IDS.ORGANIZATION_CREATE, {
		key: `organization-create:${userId}`,
	});
}

export function spaceCreationLimited(userId: User.UserId) {
	return isRateLimited(RATE_LIMIT_IDS.SPACE_CREATE, {
		key: `space-create:${userId}`,
	});
}

async function ownedOrganizationCount(
	tx: Pick<Transaction, "select">,
	ownerId: User.UserId,
) {
	const [owned] = await tx
		.select({ total: count() })
		.from(organizations)
		.where(
			and(
				eq(organizations.ownerId, ownerId),
				isNull(organizations.tombstoneAt),
			),
		);
	return Number(owned?.total ?? 0);
}

export async function hasOrganizationSlot(
	tx: Pick<Transaction, "select">,
	ownerId: User.UserId,
) {
	return (await ownedOrganizationCount(tx, ownerId)) < ORGANIZATION_LIMIT;
}

export async function reserveOrganizationSlot(
	tx: Pick<Transaction, "select">,
	ownerId: User.UserId,
) {
	await tx
		.select({ id: users.id })
		.from(users)
		.where(eq(users.id, ownerId))
		.limit(1)
		.for("update");
	return hasOrganizationSlot(tx, ownerId);
}

export async function reserveSpaceSlot(
	tx: Pick<Transaction, "select">,
	organizationId: Organisation.OrganisationId,
) {
	await tx
		.select({ id: organizations.id })
		.from(organizations)
		.where(eq(organizations.id, organizationId))
		.limit(1)
		.for("update");

	const [existing] = await tx
		.select({ total: count() })
		.from(spaces)
		.where(eq(spaces.organizationId, organizationId));

	return Number(existing?.total ?? 0) < SPACE_LIMIT;
}
