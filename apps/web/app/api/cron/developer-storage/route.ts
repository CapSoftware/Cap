import { timingSafeEqual } from "node:crypto";
import { db } from "@cap/database";
import {
	developerApps,
	developerCreditAccounts,
	developerCreditTransactions,
	developerDailyStorageSnapshots,
} from "@cap/database/schema";
import { and, asc, eq, gt, inArray, isNotNull, isNull, lt } from "drizzle-orm";
import { after, NextResponse } from "next/server";
import type { StorageUsage } from "@/lib/developer-pricing";
import { runDueAutoTopUps } from "@/lib/infra-auto-top-up";
import { sendInfraOutOfCreditEmail } from "@/lib/infra-billing-emails";
import {
	INFRA_GRACE_DAYS,
	latestStorageCharge,
	latestStorageCharges,
	restoredSinceCharge,
	STORAGE_DAY_REFERENCE_TYPE,
	type StorageCharge,
} from "@/lib/infra-standing";
import { getStorageUsageByApp } from "@/lib/infra-storage";
import {
	chargeStorageDay,
	recordStorageDayVisits,
} from "@/lib/infra-storage-billing";
import {
	chargeMissedFirstMonths,
	firstMonthShortfallsSince,
	openFirstMonthShortfalls,
} from "@/lib/infra-storage-minimum";
import { utcDateKey } from "@/lib/infra-usage";

const BATCH_SIZE = 10;
const PAGE_SIZE = 200;
const DAY_MS = 24 * 60 * 60 * 1000;
const GRACE_MS = INFRA_GRACE_DAYS * DAY_MS;
const FIRST_MONTH_NOTICE_LOOKBACK_MS = DAY_MS;

const TOP_UPS_BEFORE_UNTIL_MS = 60_000;
const STORAGE_UNTIL_MS = 200_000;
const TOP_UPS_AFTER_UNTIL_MS = 240_000;

export const MAX_STORAGE_HOPS = 24;
const HANDOFF_TIMEOUT_MS = 10_000;

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const ACCOUNT_ID_PATTERN = /^[0-9A-Za-z_-]{1,64}$/;
const HOP_PATTERN = /^\d{1,3}$/;

export const maxDuration = 300;

type Sweep = { date: string; after: string | null; hop: number };

function readSweep(url: URL, today: string, yesterday: string): Sweep | null {
	const date = url.searchParams.get("date");
	const afterId = url.searchParams.get("after");
	const hop = url.searchParams.get("hop");
	if (date === null && afterId === null && hop === null) {
		return { date: yesterday, after: null, hop: 0 };
	}
	if (date === null || hop === null || !HOP_PATTERN.test(hop)) return null;
	const hopNumber = Number(hop);
	if (hopNumber < 1 || hopNumber > MAX_STORAGE_HOPS) return null;
	if (afterId !== null && !ACCOUNT_ID_PATTERN.test(afterId)) return null;
	if (!DATE_PATTERN.test(date) || (date !== today && date !== yesterday)) {
		return null;
	}
	return { date, after: afterId, hop: hopNumber };
}

function continueSweep(request: Request, authorization: string, next: Sweep) {
	const url = new URL(request.url);
	url.search = "";
	url.searchParams.set("date", next.date);
	if (next.after) url.searchParams.set("after", next.after);
	url.searchParams.set("hop", String(next.hop));
	after(
		fetch(url, {
			headers: { authorization },
			signal: AbortSignal.timeout(HANDOFF_TIMEOUT_MS),
		})
			.then((response) => {
				if (!response.ok) {
					console.error("[developer-storage] Continuation refused", {
						status: response.status,
						...next,
					});
				}
			})
			.catch((error: unknown) => {
				if (error instanceof Error && error.name === "TimeoutError") {
					console.info(
						"[developer-storage] Continuation still running at handoff",
						next,
					);
					return;
				}
				console.error("[developer-storage] Continuation not started", {
					error,
					...next,
				});
			}),
	);
}

async function sendFirstMonthNotices(
	accounts: readonly { id: string }[],
	now: Date,
) {
	const shortfalls = await firstMonthShortfallsSince(
		accounts.map((account) => account.id),
		new Date(now.getTime() - FIRST_MONTH_NOTICE_LOOKBACK_MS),
	);
	for (const accountId of shortfalls.keys()) {
		const charge = await latestStorageCharge(db(), accountId);
		if (
			!charge?.shortSince ||
			(await restoredSinceCharge(db(), accountId, charge))
		) {
			continue;
		}
		await sendInfraOutOfCreditEmail({
			accountId,
			shortSince: charge.shortSince,
			pausesAt: new Date(charge.shortSince.getTime() + GRACE_MS),
		});
	}
}

type DateSweep = {
	complete: boolean;
	cursor: string | null;
	processed: number;
	short: number;
};

async function sweepDate({
	date,
	from,
	finishing,
	now,
	outOfTime,
}: {
	date: string;
	from: string | null;
	finishing: boolean;
	now: Date;
	outOfTime: () => boolean;
}): Promise<DateSweep> {
	let processed = 0;
	let short = 0;
	let cursor = from;
	const dayStart = new Date(`${date}T00:00:00.000Z`);
	const dayEnd = finishing ? new Date(dayStart.getTime() + DAY_MS) : null;
	const dailyCharge = {
		dailyChargeAt: dayStart,
		...(dayEnd ? { createdBefore: dayEnd } : {}),
	};

	while (!outOfTime()) {
		const page: { id: string; appId: string; createdAt: Date }[] = await db()
			.select({
				id: developerCreditAccounts.id,
				appId: developerCreditAccounts.appId,
				createdAt: developerCreditAccounts.createdAt,
			})
			.from(developerCreditAccounts)
			.where(cursor ? gt(developerCreditAccounts.id, cursor) : undefined)
			.orderBy(asc(developerCreditAccounts.id))
			.limit(PAGE_SIZE);
		const lastAccount = page.at(-1);
		if (!lastAccount) return { complete: true, cursor, processed, short };
		const existing = dayEnd
			? page.filter(
					(account) => new Date(account.createdAt).getTime() < dayEnd.getTime(),
				)
			: page;
		const liveApps =
			existing.length > 0
				? await db()
						.select({ id: developerApps.id })
						.from(developerApps)
						.where(
							and(
								inArray(
									developerApps.id,
									existing.map((account) => account.appId),
								),
								isNull(developerApps.deletedAt),
								dayEnd ? lt(developerApps.createdAt, dayEnd) : undefined,
							),
						)
				: [];
		const liveAppIds = new Set(liveApps.map((app) => app.id));
		const accounts = existing.filter((account) =>
			liveAppIds.has(account.appId),
		);

		const billedToday =
			accounts.length > 0
				? await db()
						.select({ accountId: developerCreditTransactions.accountId })
						.from(developerCreditTransactions)
						.where(
							and(
								inArray(
									developerCreditTransactions.accountId,
									accounts.map((account) => account.id),
								),
								eq(developerCreditTransactions.referenceId, date),
								eq(
									developerCreditTransactions.referenceType,
									STORAGE_DAY_REFERENCE_TYPE,
								),
							),
						)
				: [];
		const billedAccounts = new Set(billedToday.map((row) => row.accountId));
		const unbilled = accounts.filter(
			(account) => !billedAccounts.has(account.id),
		);
		const settledApps =
			unbilled.length > 0
				? await db()
						.select({ appId: developerDailyStorageSnapshots.appId })
						.from(developerDailyStorageSnapshots)
						.where(
							and(
								inArray(
									developerDailyStorageSnapshots.appId,
									unbilled.map((account) => account.appId),
								),
								eq(developerDailyStorageSnapshots.snapshotDate, date),
								isNotNull(developerDailyStorageSnapshots.processedAt),
							),
						)
				: [];
		const settledAppIds = new Set(settledApps.map((row) => row.appId));
		const pending = finishing
			? unbilled.filter((account) => !settledAppIds.has(account.appId))
			: unbilled;
		const visitedWithoutSnapshot: string[] = [];
		const recordVisits = () =>
			recordStorageDayVisits({
				appIds: visitedWithoutSnapshot.filter(
					(appId) => !settledAppIds.has(appId),
				),
				dateKey: date,
				now,
			});
		const appIds = pending.map((account) => account.appId);
		const usageByApp =
			pending.length === 0
				? new Map<string, StorageUsage>()
				: await getStorageUsageByApp(appIds, undefined, undefined, dailyCharge);
		const idleAccountIds = pending
			.filter(
				(account) =>
					(usageByApp.get(account.appId)?.dailyMicroCredits ?? 1) <= 0,
			)
			.map((account) => account.id);
		const [lastCharges, openFirstMonths] =
			idleAccountIds.length > 0
				? await Promise.all([
						latestStorageCharges(db(), idleAccountIds),
						openFirstMonthShortfalls(idleAccountIds),
					])
				: [new Map<string, StorageCharge>(), new Set<string>()];

		for (let i = 0; i < pending.length; i += BATCH_SIZE) {
			if (outOfTime()) {
				await recordVisits();
				const firstUnattempted = pending[i];
				const position = firstUnattempted ? page.indexOf(firstUnattempted) : -1;
				return {
					complete: false,
					cursor: position > 0 ? (page[position - 1]?.id ?? cursor) : cursor,
					processed,
					short,
				};
			}
			const results = await Promise.allSettled(
				pending.slice(i, i + BATCH_SIZE).map(async (account) => {
					const usage = usageByApp.get(account.appId);
					if (!usage) return null;
					if (
						usage.dailyMicroCredits <= 0 &&
						!lastCharges.get(account.id)?.shortSince &&
						!openFirstMonths.has(account.id)
					) {
						return null;
					}
					const result = await chargeStorageDay({
						appId: account.appId,
						accountId: account.id,
						usage,
						measure: async (tx) =>
							(
								await getStorageUsageByApp(
									[account.appId],
									undefined,
									tx,
									dailyCharge,
								)
							).get(account.appId) ?? usage,
						dateKey: date,
						now,
						retryUnpaid: !finishing,
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

			results.forEach((result, index) => {
				const appId = pending[i + index]?.appId;
				if (
					appId &&
					result.status === "fulfilled" &&
					(!result.value || result.value.state === "skipped")
				) {
					visitedWithoutSnapshot.push(appId);
				}
			});
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

		await recordVisits();
		if (!finishing) await sendFirstMonthNotices(accounts, now);
		cursor = lastAccount.id;
		if (page.length < PAGE_SIZE) {
			return { complete: true, cursor, processed, short };
		}
	}
	return { complete: false, cursor, processed, short };
}

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
	const yesterday = utcDateKey(new Date(startedAt - DAY_MS));
	const sweep = readSweep(new URL(request.url), today, yesterday);
	if (!sweep) {
		return NextResponse.json(
			{ error: "Invalid continuation" },
			{ status: 400 },
		);
	}
	const { hop } = sweep;
	const outOfTime = () => Date.now() - startedAt >= STORAGE_UNTIL_MS;

	const topUpsBefore =
		hop === 0
			? await runDueAutoTopUps(now, {
					until: startedAt + TOP_UPS_BEFORE_UNTIL_MS,
				})
			: null;

	const firstMonths = hop === 0 ? await chargeMissedFirstMonths(now) : null;

	const dates = sweep.date === today ? [today] : [sweep.date, today];
	let date = sweep.date;
	let cursor = sweep.after;
	let complete = false;
	let processed = 0;
	let short = 0;
	for (const [index, sweepingDate] of dates.entries()) {
		date = sweepingDate;
		const result = await sweepDate({
			date,
			from: index === 0 ? sweep.after : null,
			finishing: date !== today,
			now,
			outOfTime,
		});
		processed += result.processed;
		short += result.short;
		cursor = result.cursor;
		complete = result.complete;
		if (!complete) break;
	}

	let continued = false;
	if (!complete) {
		if (hop < MAX_STORAGE_HOPS) {
			continueSweep(request, authHeader, {
				date,
				after: cursor,
				hop: hop + 1,
			});
			continued = true;
		} else {
			console.error("[developer-storage] Sweep stopped at the hop limit", {
				date,
				after: cursor,
				hop,
			});
		}
	}

	const topUpsAfter = continued
		? null
		: await runDueAutoTopUps(now, {
				until: startedAt + TOP_UPS_AFTER_UNTIL_MS,
			});
	const autoTopUps = {
		attempted: (topUpsBefore?.attempted ?? 0) + (topUpsAfter?.attempted ?? 0),
		succeeded: (topUpsBefore?.succeeded ?? 0) + (topUpsAfter?.succeeded ?? 0),
		failed: (topUpsBefore?.failed ?? 0) + (topUpsAfter?.failed ?? 0),
	};

	return NextResponse.json({
		success: true,
		date,
		complete,
		continued,
		hop,
		appsProcessed: processed,
		appsShort: short,
		firstMonths,
		autoTopUps,
	});
}
