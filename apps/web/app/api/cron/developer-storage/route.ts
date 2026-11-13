import { timingSafeEqual } from "node:crypto";
import { db } from "@cap/database";
import {
	developerApps,
	developerCreditAccounts,
	developerCreditTransactions,
} from "@cap/database/schema";
import { and, asc, eq, gt, inArray, isNull } from "drizzle-orm";
import { after, NextResponse } from "next/server";
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
const DAY_MS = 24 * 60 * 60 * 1000;
const GRACE_MS = INFRA_GRACE_DAYS * DAY_MS;

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

function readSweep(url: URL, now: Date): Sweep | null {
	const date = url.searchParams.get("date");
	const afterId = url.searchParams.get("after");
	const hop = url.searchParams.get("hop");
	if (date === null && afterId === null && hop === null) {
		return { date: utcDateKey(now), after: null, hop: 0 };
	}
	if (date === null || hop === null || !HOP_PATTERN.test(hop)) return null;
	const hopNumber = Number(hop);
	if (hopNumber < 1 || hopNumber > MAX_STORAGE_HOPS) return null;
	if (afterId !== null && !ACCOUNT_ID_PATTERN.test(afterId)) return null;
	const today = utcDateKey(now);
	const yesterday = utcDateKey(new Date(now.getTime() - DAY_MS));
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
				if (error instanceof Error && error.name === "TimeoutError") return;
				console.error("[developer-storage] Continuation not started", {
					error,
					...next,
				});
			}),
	);
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
	const sweep = readSweep(new URL(request.url), now);
	if (!sweep) {
		return NextResponse.json(
			{ error: "Invalid continuation" },
			{ status: 400 },
		);
	}
	const { date, hop } = sweep;
	const outOfTime = (untilMs: number) => Date.now() - startedAt >= untilMs;

	const topUpsBefore =
		hop === 0
			? await runDueAutoTopUps(now, {
					until: startedAt + TOP_UPS_BEFORE_UNTIL_MS,
				})
			: null;

	let processed = 0;
	let short = 0;
	let complete = false;
	let cursor = sweep.after;

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

		let resumeAt: number | null = null;
		for (let i = 0; i < pending.length; i += BATCH_SIZE) {
			if (outOfTime(STORAGE_UNTIL_MS)) {
				resumeAt = i;
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
						dateKey: date,
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

		if (resumeAt !== null) {
			const firstUnattempted = pending[resumeAt];
			const position = firstUnattempted ? page.indexOf(firstUnattempted) : -1;
			cursor = position > 0 ? (page[position - 1]?.id ?? cursor) : cursor;
			break;
		}

		complete = page.length < PAGE_SIZE;
		cursor = lastAccount.id;
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
		autoTopUps,
	});
}
