import { timingSafeEqual } from "node:crypto";
import { db } from "@cap/database";
import {
	developerApps,
	developerCreditAccounts,
	developerCreditTransactions,
} from "@cap/database/schema";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { NextResponse } from "next/server";
import { runDueAutoTopUps } from "@/lib/infra-auto-top-up";
import { sendInfraOutOfCreditEmail } from "@/lib/infra-billing-emails";
import {
	INFRA_GRACE_DAYS,
	latestStorageCharge,
	STORAGE_DAY_REFERENCE_TYPE,
} from "@/lib/infra-standing";
import { getStorageUsageByApp } from "@/lib/infra-storage";
import { chargeStorageDay } from "@/lib/infra-storage-billing";
import { utcDateKey } from "@/lib/infra-usage";

const BATCH_SIZE = 10;
const GRACE_MS = INFRA_GRACE_DAYS * 24 * 60 * 60 * 1000;

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

	const now = new Date();
	const today = utcDateKey(now);

	const accounts = await db()
		.select({
			id: developerCreditAccounts.id,
			appId: developerCreditAccounts.appId,
		})
		.from(developerCreditAccounts)
		.innerJoin(
			developerApps,
			eq(developerCreditAccounts.appId, developerApps.id),
		)
		.where(isNull(developerApps.deletedAt));

	const topUpsBefore = await runDueAutoTopUps(now);

	let processed = 0;
	let short = 0;

	if (accounts.length > 0) {
		const billedToday = await db()
			.select({ accountId: developerCreditTransactions.accountId })
			.from(developerCreditTransactions)
			.where(
				and(
					inArray(
						developerCreditTransactions.accountId,
						accounts.map((account) => account.id),
					),
					eq(developerCreditTransactions.referenceId, today),
					eq(
						developerCreditTransactions.referenceType,
						STORAGE_DAY_REFERENCE_TYPE,
					),
				),
			);
		const billedAccounts = new Set(billedToday.map((row) => row.accountId));
		const pending = accounts.filter(
			(account) => !billedAccounts.has(account.id),
		);
		const usageByApp = await getStorageUsageByApp(
			pending.map((account) => account.appId),
		);

		for (let i = 0; i < pending.length; i += BATCH_SIZE) {
			const results = await Promise.allSettled(
				pending.slice(i, i + BATCH_SIZE).map(async (account) => {
					const usage = usageByApp.get(account.appId);
					if (!usage) return null;
					if (usage.dailyMicroCredits <= 0) {
						const lastCharge = await latestStorageCharge(db(), account.id);
						if (!lastCharge?.shortSince) return null;
					}
					const result = await chargeStorageDay({
						appId: account.appId,
						accountId: account.id,
						usage,
						dateKey: today,
						now,
					});
					if (
						result.state === "billed" &&
						result.fellShort &&
						result.shortSince
					) {
						await sendInfraOutOfCreditEmail({
							accountId: account.id,
							shortSince: result.shortSince,
							pausesAt: new Date(result.shortSince.getTime() + GRACE_MS),
						});
					}
					return result;
				}),
			);

			for (const result of results) {
				if (result.status === "rejected") {
					console.error("Failed to process app in cron:", result.reason);
				} else if (result.value?.state === "billed") {
					processed++;
					if (result.value.shortSince) short++;
				} else if (result.value?.state === "unpaid") {
					short++;
				}
			}
		}
	}

	const topUpsAfter = await runDueAutoTopUps(now);
	const autoTopUps = {
		attempted: topUpsBefore.attempted + topUpsAfter.attempted,
		succeeded: topUpsBefore.succeeded + topUpsAfter.succeeded,
		failed: topUpsBefore.failed + topUpsAfter.failed,
	};

	return NextResponse.json({
		success: true,
		date: today,
		appsProcessed: processed,
		appsShort: short,
		autoTopUps,
	});
}
