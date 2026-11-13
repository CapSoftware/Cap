import { timingSafeEqual } from "node:crypto";
import { db } from "@cap/database";
import {
	developerApps,
	developerCreditAccounts,
	developerCreditTransactions,
} from "@cap/database/schema";
import { and, asc, eq, gt, inArray, isNull } from "drizzle-orm";
import { NextResponse } from "next/server";
import { runDueAutoTopUps } from "@/lib/infra-auto-top-up";
import { sendInfraOutOfCreditEmail } from "@/lib/infra-billing-emails";
import {
	INFRA_GRACE_DAYS,
	latestStorageCharges,
	STORAGE_DAY_REFERENCE_TYPE,
} from "@/lib/infra-standing";
import { getStorageUsageByApp } from "@/lib/infra-storage";
import { chargeStorageDay } from "@/lib/infra-storage-billing";
import { utcDateKey } from "@/lib/infra-usage";

const BATCH_SIZE = 10;
const PAGE_SIZE = 200;
const GRACE_MS = INFRA_GRACE_DAYS * 24 * 60 * 60 * 1000;

// The function is stopped at maxDuration. Each phase stops taking new work
// once its share of that is used, so a run that cannot finish still answers
// and the next run carries on: an account already charged for the day is
// skipped, so nothing is charged twice.
const TOP_UPS_BEFORE_UNTIL_MS = 60_000;
const STORAGE_UNTIL_MS = 200_000;
const TOP_UPS_AFTER_UNTIL_MS = 240_000;

export const maxDuration = 300;

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

	const startedAt = Date.now();
	const now = new Date(startedAt);
	const today = utcDateKey(now);
	const outOfTime = (untilMs: number) => Date.now() - startedAt >= untilMs;

	const topUpsBefore = await runDueAutoTopUps(now, {
		until: startedAt + TOP_UPS_BEFORE_UNTIL_MS,
	});

	let processed = 0;
	let short = 0;
	let complete = false;
	let cursor: string | null = null;

	while (!complete && !outOfTime(STORAGE_UNTIL_MS)) {
		const page: { id: string; appId: string }[] = await db()
			.select({
				id: developerCreditAccounts.id,
				appId: developerCreditAccounts.appId,
			})
			.from(developerCreditAccounts)
			.where(cursor ? gt(developerCreditAccounts.id, cursor) : undefined)
			.orderBy(asc(developerCreditAccounts.id))
			.limit(PAGE_SIZE);
		const lastAccount = page.at(-1);
		if (!lastAccount) {
			complete = true;
			break;
		}
		const liveApps = await db()
			.select({ id: developerApps.id })
			.from(developerApps)
			.where(
				and(
					inArray(
						developerApps.id,
						page.map((account) => account.appId),
					),
					isNull(developerApps.deletedAt),
				),
			);
		const liveAppIds = new Set(liveApps.map((app) => app.id));
		const accounts = page.filter((account) => liveAppIds.has(account.appId));

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
		const lastCharges = await latestStorageCharges(
			db(),
			pending
				.filter(
					(account) =>
						(usageByApp.get(account.appId)?.dailyMicroCredits ?? 1) <= 0,
				)
				.map((account) => account.id),
		);

		let cutOff = false;
		for (let i = 0; i < pending.length; i += BATCH_SIZE) {
			if (outOfTime(STORAGE_UNTIL_MS)) {
				cutOff = true;
				break;
			}
			const results = await Promise.allSettled(
				pending.slice(i, i + BATCH_SIZE).map(async (account) => {
					const usage = usageByApp.get(account.appId);
					if (!usage) return null;
					if (
						usage.dailyMicroCredits <= 0 &&
						!lastCharges.get(account.id)?.shortSince
					) {
						return null;
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
		if (cutOff) break;

		complete = page.length < PAGE_SIZE;
		cursor = lastAccount.id;
	}

	const topUpsAfter = await runDueAutoTopUps(now, {
		until: startedAt + TOP_UPS_AFTER_UNTIL_MS,
	});
	const autoTopUps = {
		attempted: topUpsBefore.attempted + topUpsAfter.attempted,
		succeeded: topUpsBefore.succeeded + topUpsAfter.succeeded,
		failed: topUpsBefore.failed + topUpsAfter.failed,
	};

	return NextResponse.json({
		success: true,
		date: today,
		complete,
		appsProcessed: processed,
		appsShort: short,
		autoTopUps,
	});
}
