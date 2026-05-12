import * as Db from "@cap/database/schema";
import { userIsPro } from "@cap/utils";
import { type User, Video } from "@cap/web-domain";
import { and, count, eq, gte, isNull, lt, ne, or } from "drizzle-orm";
import type { DbClient } from "./Database.ts";

export const FREE_SHAREABLE_LINK_LIMIT = 30;
export const FREE_SHAREABLE_LINK_MAX_DURATION_SECONDS = 300;

type Transaction = Parameters<Parameters<DbClient["transaction"]>[0]>[0];
type QueryClient = DbClient | Transaction;

export type ShareableLinkUsageSnapshot = Video.ShareableLinkUsage;

export function getShareableLinkPeriod(now = new Date()) {
	const year = now.getUTCFullYear();
	const month = now.getUTCMonth();
	const periodStart = new Date(Date.UTC(year, month, 1));
	const periodEnd = new Date(Date.UTC(year, month + 1, 1));

	return {
		periodStart,
		periodEnd,
		resetAt: periodEnd.toISOString(),
	};
}

export function toShareableLinkUsageSnapshot(
	used: number,
	resetAt: string,
): ShareableLinkUsageSnapshot {
	const normalizedUsed = Math.max(0, used);

	return {
		used: normalizedUsed,
		limit: FREE_SHAREABLE_LINK_LIMIT,
		remaining: Math.max(0, FREE_SHAREABLE_LINK_LIMIT - normalizedUsed),
		resetAt,
		maxDurationSeconds: FREE_SHAREABLE_LINK_MAX_DURATION_SECONDS,
	};
}

export function getShareableLinkUsageLimitError({
	used,
	resetAt,
	durationSeconds,
}: {
	used: number;
	resetAt: string;
	durationSeconds?: number | null;
}) {
	const usage = toShareableLinkUsageSnapshot(used, resetAt);

	if (
		durationSeconds != null &&
		durationSeconds > FREE_SHAREABLE_LINK_MAX_DURATION_SECONDS
	) {
		return new Video.ShareableLinkUsageLimitError({
			reason: "duration_limit",
			usage,
		});
	}

	if (used >= FREE_SHAREABLE_LINK_LIMIT) {
		return new Video.ShareableLinkUsageLimitError({
			reason: "shareable_link_limit",
			usage,
		});
	}

	return null;
}

export function isShareableLinkUsageLimitError(
	error: unknown,
): error is Video.ShareableLinkUsageLimitError {
	if (
		typeof error === "object" &&
		error !== null &&
		"_tag" in error &&
		error._tag === "ShareableLinkUsageLimitError"
	) {
		return true;
	}

	if (error instanceof Error) {
		return isShareableLinkUsageLimitError((error as { cause?: unknown }).cause);
	}

	return false;
}

export function getShareableLinkLimitResponse(
	error: Video.ShareableLinkUsageLimitError,
) {
	return {
		error: "upgrade_required",
		reason: error.reason,
		usage: error.usage,
	};
}

async function countCurrentPeriodShareableLinks(
	client: QueryClient,
	userId: User.UserId,
	periodStart: Date,
	periodEnd: Date,
) {
	const [row] = await client
		.select({ value: count() })
		.from(Db.videos)
		.leftJoin(Db.videoUploads, eq(Db.videoUploads.videoId, Db.videos.id))
		.where(
			and(
				eq(Db.videos.ownerId, userId),
				eq(Db.videos.isScreenshot, false),
				or(isNull(Db.videoUploads.videoId), ne(Db.videoUploads.phase, "error")),
				gte(Db.videos.createdAt, periodStart),
				lt(Db.videos.createdAt, periodEnd),
			),
		);

	return row?.value ?? 0;
}

export async function getShareableLinkUsage(
	client: QueryClient,
	userId: User.UserId,
	now = new Date(),
): Promise<ShareableLinkUsageSnapshot> {
	const { periodStart, periodEnd, resetAt } = getShareableLinkPeriod(now);
	const used = await countCurrentPeriodShareableLinks(
		client,
		userId,
		periodStart,
		periodEnd,
	);

	return toShareableLinkUsageSnapshot(used, resetAt);
}

async function assertCanCreateShareableLink({
	tx,
	userId,
	durationSeconds,
	now,
}: {
	tx: Transaction;
	userId: User.UserId;
	durationSeconds?: number | null;
	now: Date;
}) {
	const [owner] = await tx
		.select({
			id: Db.users.id,
			stripeSubscriptionStatus: Db.users.stripeSubscriptionStatus,
			thirdPartyStripeSubscriptionId: Db.users.thirdPartyStripeSubscriptionId,
		})
		.from(Db.users)
		.where(eq(Db.users.id, userId))
		.for("update");

	if (!owner) throw new Error("User not found");
	if (userIsPro(owner)) return;

	const { periodStart, periodEnd, resetAt } = getShareableLinkPeriod(now);
	const used = await countCurrentPeriodShareableLinks(
		tx,
		userId,
		periodStart,
		periodEnd,
	);
	const limitError = getShareableLinkUsageLimitError({
		used,
		resetAt,
		durationSeconds,
	});

	if (limitError) throw limitError;
}

export async function createVideoWithShareableLinkQuota<T>({
	client,
	ownerId,
	isScreenshot = false,
	durationSeconds,
	now = new Date(),
	create,
}: {
	client: DbClient;
	ownerId: User.UserId;
	isScreenshot?: boolean;
	durationSeconds?: number | null;
	now?: Date;
	create: (tx: Transaction) => Promise<T>;
}) {
	return client.transaction(async (tx) => {
		if (!isScreenshot)
			await assertCanCreateShareableLink({
				tx,
				userId: ownerId,
				durationSeconds,
				now,
			});

		return create(tx);
	});
}

export async function assertShareableLinkDurationAllowed({
	client,
	ownerId,
	isScreenshot = false,
	durationSeconds,
	now = new Date(),
}: {
	client: DbClient;
	ownerId: User.UserId;
	isScreenshot?: boolean;
	durationSeconds?: number | null;
	now?: Date;
}) {
	if (
		isScreenshot ||
		durationSeconds == null ||
		durationSeconds <= FREE_SHAREABLE_LINK_MAX_DURATION_SECONDS
	) {
		return;
	}

	const [owner] = await client
		.select({
			id: Db.users.id,
			stripeSubscriptionStatus: Db.users.stripeSubscriptionStatus,
			thirdPartyStripeSubscriptionId: Db.users.thirdPartyStripeSubscriptionId,
		})
		.from(Db.users)
		.where(eq(Db.users.id, ownerId));

	if (!owner || userIsPro(owner)) return;

	const usage = await getShareableLinkUsage(client, ownerId, now);

	throw new Video.ShareableLinkUsageLimitError({
		reason: "duration_limit",
		usage,
	});
}

export async function markShareableLinkUploadRejected(
	client: QueryClient,
	videoId: Video.VideoId,
) {
	await client
		.update(Db.videoUploads)
		.set({
			phase: "error",
			processingError: "Video exceeds free plan duration limit",
			processingMessage: "Upgrade required",
			updatedAt: new Date(),
		})
		.where(eq(Db.videoUploads.videoId, videoId));
}
