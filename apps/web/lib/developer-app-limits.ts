import type { db } from "@cap/database";
import { developerApps, users } from "@cap/database/schema";
import type { User } from "@cap/web-domain";
import { and, count, eq, isNull } from "drizzle-orm";
import { isRateLimited, RATE_LIMIT_IDS } from "@/lib/rate-limit";

export const DEVELOPER_APP_LIMIT = 25;
export const DEVELOPER_APP_LIMIT_MESSAGE = `You can have up to ${DEVELOPER_APP_LIMIT} apps. Delete one you no longer use, or contact us.`;
export const DEVELOPER_APP_RATE_MESSAGE =
	"You are creating apps too quickly. Try again in an hour.";
export const DEVELOPER_KEY_ROTATION_RATE_MESSAGE =
	"You are rotating keys too quickly. Try again in an hour.";

export {
	DEVELOPER_APP_NAME_MAX_LENGTH,
	developerAppEnvironment,
	developerAppLogoUrl,
	developerAppName,
} from "@/lib/developer-app-rules";

export function developerAppCreationLimited(
	userId: User.UserId,
	headers?: Headers,
) {
	return isRateLimited(RATE_LIMIT_IDS.DEVELOPER_APP_CREATE, {
		key: `developer-app-create:${userId}`,
		...(headers ? { headers } : {}),
	});
}

export function developerKeyRotationLimited(
	userId: User.UserId,
	headers?: Headers,
) {
	return isRateLimited(RATE_LIMIT_IDS.DEVELOPER_KEY_ROTATE, {
		key: `developer-key-rotate:${userId}`,
		...(headers ? { headers } : {}),
	});
}

type Transaction = Parameters<
	Parameters<ReturnType<typeof db>["transaction"]>[0]
>[0];

export async function reserveDeveloperAppSlot(
	tx: Pick<Transaction, "select">,
	ownerId: User.UserId,
) {
	await tx
		.select({ id: users.id })
		.from(users)
		.where(eq(users.id, ownerId))
		.limit(1)
		.for("update");

	const [live] = await tx
		.select({ total: count() })
		.from(developerApps)
		.where(
			and(eq(developerApps.ownerId, ownerId), isNull(developerApps.deletedAt)),
		);

	return Number(live?.total ?? 0) < DEVELOPER_APP_LIMIT;
}
