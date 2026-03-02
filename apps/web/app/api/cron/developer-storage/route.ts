import { timingSafeEqual } from "node:crypto";
import { db } from "@cap/database";
import { nanoId } from "@cap/database/helpers";
import {
	developerApps,
	developerCreditAccounts,
	developerCreditTransactions,
	developerDailyStorageSnapshots,
	developerVideos,
} from "@cap/database/schema";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { NextResponse } from "next/server";

const MICRO_CREDITS_PER_MINUTE_PER_DAY = 3.33;

export async function GET(request: Request) {
	const cronSecret = process.env.CRON_SECRET;
	if (!cronSecret) {
		return NextResponse.json(
			{ error: "Server misconfiguration" },
			{ status: 500 },
		);
	}

	const authHeader = request.headers.get("authorization");
	const expected = `Bearer ${cronSecret}`;
	if (
		!authHeader ||
		authHeader.length !== expected.length ||
		!timingSafeEqual(Buffer.from(authHeader), Buffer.from(expected))
	) {
		return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
	}

	const today = new Date().toISOString().slice(0, 10);

	const apps = await db()
		.select({ id: developerApps.id })
		.from(developerApps)
		.where(isNull(developerApps.deletedAt));

	if (apps.length === 0) {
		return NextResponse.json({
			success: true,
			date: today,
			appsProcessed: 0,
		});
	}

	const appIds = apps.map((a) => a.id);

	const existingSnapshots = await db()
		.select()
		.from(developerDailyStorageSnapshots)
		.where(
			and(
				inArray(developerDailyStorageSnapshots.appId, appIds),
				eq(developerDailyStorageSnapshots.snapshotDate, today),
			),
		);

	const snapshotsByApp = new Map(existingSnapshots.map((s) => [s.appId, s]));

	const videoStats = await db()
		.select({
			appId: developerVideos.appId,
			totalDurationMinutes: sql<number>`COALESCE(SUM(${developerVideos.duration}) / 60, 0)`,
			videoCount: sql<number>`COUNT(*)`,
		})
		.from(developerVideos)
		.where(
			and(
				inArray(developerVideos.appId, appIds),
				isNull(developerVideos.deletedAt),
			),
		)
		.groupBy(developerVideos.appId);

	const statsByApp = new Map(videoStats.map((s) => [s.appId, s]));

	const accounts = await db()
		.select()
		.from(developerCreditAccounts)
		.where(inArray(developerCreditAccounts.appId, appIds));

	const accountsByApp = new Map(accounts.map((a) => [a.appId, a]));

	let processed = 0;

	for (const app of apps) {
		const existing = snapshotsByApp.get(app.id);
		if (existing?.processedAt) continue;

		const stats = statsByApp.get(app.id);
		const totalMinutes = stats?.totalDurationMinutes ?? 0;
		const videoCount = Number(stats?.videoCount ?? 0);

		if (totalMinutes <= 0) continue;

		const microCreditsToCharge = Math.floor(
			totalMinutes * MICRO_CREDITS_PER_MINUTE_PER_DAY,
		);

		if (microCreditsToCharge <= 0) continue;

		const account = accountsByApp.get(app.id);
		if (!account) continue;

		await db().transaction(async (tx) => {
			await tx
				.update(developerCreditAccounts)
				.set({
					balanceMicroCredits: sql`${developerCreditAccounts.balanceMicroCredits} - ${microCreditsToCharge}`,
				})
				.where(
					and(
						eq(developerCreditAccounts.id, account.id),
						sql`${developerCreditAccounts.balanceMicroCredits} >= ${microCreditsToCharge}`,
					),
				);

			const [updated] = await tx
				.select({
					balanceMicroCredits: developerCreditAccounts.balanceMicroCredits,
				})
				.from(developerCreditAccounts)
				.where(eq(developerCreditAccounts.id, account.id))
				.limit(1);

			await tx.insert(developerCreditTransactions).values({
				id: nanoId(),
				accountId: account.id,
				type: "storage_daily",
				amountMicroCredits: -microCreditsToCharge,
				balanceAfterMicroCredits: updated.balanceMicroCredits,
				referenceType: "manual",
				metadata: {
					snapshotDate: today,
					totalDurationMinutes: totalMinutes,
					videoCount,
				},
			});

			const snapshotId = existing?.id ?? nanoId();
			if (existing) {
				await tx
					.update(developerDailyStorageSnapshots)
					.set({
						totalDurationMinutes: totalMinutes,
						videoCount,
						microCreditsCharged: microCreditsToCharge,
						processedAt: new Date(),
					})
					.where(eq(developerDailyStorageSnapshots.id, snapshotId));
			} else {
				await tx.insert(developerDailyStorageSnapshots).values({
					id: snapshotId,
					appId: app.id,
					snapshotDate: today,
					totalDurationMinutes: totalMinutes,
					videoCount,
					microCreditsCharged: microCreditsToCharge,
					processedAt: new Date(),
				});
			}
		});

		processed++;
	}

	return NextResponse.json({
		success: true,
		date: today,
		appsProcessed: processed,
	});
}
