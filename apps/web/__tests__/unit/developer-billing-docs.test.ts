import fs from "node:fs";
import path from "node:path";
import { compileMDX } from "next-mdx-remote/rsc";
import { describe, expect, it, vi } from "vitest";

vi.mock("@cap/database", () => ({ db: () => ({}) }));
vi.mock("@cap/database/helpers", () => ({
	nanoId: () => "id",
	nanoIdLength: 15,
}));
vi.mock("@cap/env", () => ({
	buildEnv: { NEXT_PUBLIC_IS_CAP: "true" },
	serverEnv: () => ({ WEB_URL: "https://cap.so" }),
}));
vi.mock("@cap/utils", () => ({ stripe: () => ({}) }));
vi.mock("@cap/database/emails/config", () => ({ sendEmail: vi.fn() }));
vi.mock("@cap/database/emails/infra-out-of-credit", () => ({
	InfraOutOfCredit: () => null,
}));
vi.mock("@cap/database/emails/infra-top-up-failed", () => ({
	InfraTopUpFailed: () => null,
}));
vi.mock("@/lib/developer-credits-product", () => ({
	developerCreditsProductId: () => "prod_test",
}));

import {
	dailyStorageMicroCredits,
	emptyStorageMinutes,
	MICRO_CREDITS_PER_DOLLAR,
	monthlyStorageMicroCredits,
	SPEECH_DOLLARS_PER_HOUR,
	SPEECH_MICRO_CREDITS_PER_HOUR,
	STORAGE_BILLING_DAYS_PER_MONTH,
	transcriptionBilledSeconds,
	transcriptionMicroCredits,
	UPLOAD_ADMISSION_DAYS,
	uploadAdmissionMicroCredits,
} from "@/lib/developer-pricing";
import {
	TRANSCRIPT_FULL_HOLD_MICRO_CREDITS,
	transcriptHoldForSourceBytes,
} from "@/lib/developer-transcript-hold";
import { TRANSCRIPT_MIN_START_BALANCE_MICRO_CREDITS } from "@/lib/developer-transcripts";
import {
	AUTO_TOP_UP_MAX_AMOUNT_CENTS,
	AUTO_TOP_UP_MAX_THRESHOLD_MICRO_CREDITS,
	AUTO_TOP_UP_MIN_AMOUNT_CENTS,
	AUTO_TOP_UP_MIN_THRESHOLD_MICRO_CREDITS,
} from "@/lib/infra-auto-top-up";
import { LEDGER_PAGE_SIZE } from "@/lib/infra-ledger";
import {
	INFRA_RESOLUTION_TIERS,
	INFRA_STORAGE_DOLLARS_PER_1000_MINUTES_PER_MONTH,
	INFRA_TIER_MAX_PIXELS,
	type InfraResolutionTier,
} from "@/lib/infra-pricing";
import { PRO_MONTHLY_CREDIT_DOLLARS } from "@/lib/infra-pro-credit";
import {
	INFRA_GRACE_DAYS,
	uploadAdmission,
	uploadAdmissionError,
} from "@/lib/infra-standing";
import { TOP_UP_MAX_CENTS, TOP_UP_MIN_CENTS } from "@/lib/infra-top-up";
import {
	creditDollars,
	formatCharge,
	formatCredits,
	formatNeed,
	signedCreditDollars,
} from "@/lib/infra-usage";
import { extractHeadings, getDocBySlug } from "@/utils/docs";
import { docsConfig } from "../../app/(docs)/docs/docs-config";

const billing = getDocBySlug("api/billing")?.content ?? "";
const rest = getDocBySlug("api/rest-api")?.content ?? "";

const wholeDollars = (cents: number) =>
	`$${(cents / 100).toLocaleString("en-US")}`;

const jsonAfter = (doc: string, heading: string) => {
	const section = doc.slice(doc.indexOf(heading));
	const block = /```json\n([\s\S]*?)\n```/.exec(section)?.[1];
	if (!block) throw new Error(`No JSON example after ${heading}`);
	return JSON.parse(block);
};

const tableRows = (doc: string, heading: string) => {
	const section = doc.slice(doc.indexOf(heading));
	const lines = section.split("\n");
	const start = lines.findIndex((line) => line.startsWith("|"));
	const rows: string[][] = [];
	for (const line of lines.slice(start)) {
		if (!line.startsWith("|")) break;
		rows.push(
			line
				.slice(1, -1)
				.split("|")
				.map((cell) => cell.trim()),
		);
	}
	return rows.slice(2);
};

describe("the Billing page", () => {
	it("is in the sidebar beside the REST API and linked from it", () => {
		const group = docsConfig.sidebar.find(
			(section) => section.title === "API & Developers",
		);
		expect(group?.items.map((item) => item.slug)).toEqual([
			"api/get-started",
			"api/rest-api",
			"api/billing",
			"api/webhooks",
		]);
		expect(rest).toContain("](/docs/api/billing)");
		expect(billing).toContain("](/docs/api/rest-api)");
	});

	it("compiles as MDX and links only to headings that exist", async () => {
		const doc = getDocBySlug("api/billing");
		expect(doc?.metadata.title).toBe("Billing");
		expect(doc?.metadata.summary).toBeTruthy();
		await expect(
			compileMDX({ source: billing, components: {} }),
		).resolves.toBeDefined();
		await expect(
			compileMDX({ source: rest, components: {} }),
		).resolves.toBeDefined();

		const anchors = new Map([
			["/docs/api/rest-api", extractHeadings(rest).map((h) => h.slug)],
			["/docs/api/billing", extractHeadings(billing).map((h) => h.slug)],
		]);
		const links = [
			...billing.matchAll(/\]\((\/docs\/api\/rest-api)#([\w-]+)\)/g),
			...rest.matchAll(/\]\((\/docs\/api\/billing)#([\w-]+)\)/g),
			...rest.matchAll(/\]\((\/docs\/api\/rest-api)#(list-[\w-]+)\)/g),
		];
		expect(links.length).toBeGreaterThan(0);
		for (const [, page, anchor] of links) {
			expect(anchors.get(page ?? ""), `${page}#${anchor}`).toContain(anchor);
		}
	});

	it("quotes the storage and speech rates the pricing module charges", () => {
		const names: Record<InfraResolutionTier, string> = {
			"1080p": "Storage, up to 1080p",
			"1440p": "Storage, 1440p",
			"2160p": "Storage, 4K (2160p)",
		};
		for (const tier of INFRA_RESOLUTION_TIERS) {
			const price = `$${INFRA_STORAGE_DOLLARS_PER_1000_MINUTES_PER_MONTH[tier].toFixed(2)}`;
			expect(billing).toContain(
				`| ${names[tier]} | ${price} per 1,000 minutes per month | Once a day |`,
			);
			expect(rest).toContain(`| ${price} |`);
		}
		expect(billing).toContain(
			`| Speech to text | $${SPEECH_DOLLARS_PER_HOUR.toFixed(2)} per audio hour | When a transcript completes |`,
		);
		expect(billing).toContain(
			`which is ${SPEECH_MICRO_CREDITS_PER_HOUR.toLocaleString("en-US")} micro-credits`,
		);
		expect(billing).toContain(
			`${MICRO_CREDITS_PER_DOLLAR.toLocaleString("en-US")} micro-credits are one dollar`,
		);
		expect(billing).toContain(
			`| \`1080p\` | up to ${INFRA_TIER_MAX_PIXELS["1080p"].toLocaleString("en-US")} |`,
		);
		expect(billing).toContain(
			`| \`1440p\` | up to ${INFRA_TIER_MAX_PIXELS["1440p"].toLocaleString("en-US")} |`,
		);
	});

	it("works every storage example out from the pricing functions", () => {
		const tiers: Record<string, InfraResolutionTier> = {
			"1080p": "1080p",
			"1440p": "1440p",
			"4K": "2160p",
		};
		const rows = tableRows(billing, "### The daily charge");
		expect(rows).toHaveLength(3);
		for (const [stored, perMonth, perDay, needed] of rows) {
			const match = /^([\d,]+) minutes at (\S+)$/.exec(stored ?? "");
			expect(match, stored).not.toBeNull();
			const tier = tiers[match?.[2] ?? ""];
			expect(tier, stored).toBeDefined();
			if (!tier) continue;
			const minutes = {
				...emptyStorageMinutes(),
				[tier]: Number(match?.[1]?.replaceAll(",", "")),
			};
			const monthly = monthlyStorageMicroCredits(minutes);

			expect(perMonth).toBe(formatCharge(monthly));
			expect(perDay).toBe(formatCharge(dailyStorageMicroCredits(minutes)));
			expect(needed).toBe(formatNeed(uploadAdmissionMicroCredits(monthly)));
		}
		expect(billing).toContain(
			`A month is counted as ${STORAGE_BILLING_DAYS_PER_MONTH} days`,
		);
		expect(billing).toContain(
			`covers ${UPLOAD_ADMISSION_DAYS} days of storage`,
		);
		expect(rest).toContain(`covers ${UPLOAD_ADMISSION_DAYS} days of storage`);
	});

	it("works every speech example out from the pricing functions", () => {
		const rows = tableRows(billing, "## Speech to text");
		expect(rows).toHaveLength(5);
		for (const [audio, billedAs, cost] of rows) {
			const match = /^([\d.,]+) (seconds?|hours?)$/.exec(audio ?? "");
			expect(match, audio).not.toBeNull();
			const seconds =
				Number(match?.[1]?.replaceAll(",", "")) *
				(match?.[2]?.startsWith("hour") ? 3600 : 1);
			const billed = transcriptionBilledSeconds(seconds);

			expect(billedAs).toBe(
				`${billed.toLocaleString("en-US")} ${billed === 1 ? "second" : "seconds"}`,
			);
			expect(cost).toBe(formatCharge(transcriptionMicroCredits(seconds)));
		}
	});

	it("states the hold the way the hold is sized", () => {
		const min = formatNeed(TRANSCRIPT_MIN_START_BALANCE_MICRO_CREDITS);
		const full = formatNeed(TRANSCRIPT_FULL_HOLD_MICRO_CREDITS);

		expect(transcriptHoldForSourceBytes(179_999)).toBe(
			TRANSCRIPT_MIN_START_BALANCE_MICRO_CREDITS,
		);
		expect(transcriptHoldForSourceBytes(180_001)).toBeGreaterThan(
			TRANSCRIPT_MIN_START_BALANCE_MICRO_CREDITS,
		);
		expect(transcriptHoldForSourceBytes(7_200_000)).toBe(
			TRANSCRIPT_FULL_HOLD_MICRO_CREDITS,
		);
		expect(transcriptHoldForSourceBytes(7_199_000)).toBeLessThan(
			TRANSCRIPT_FULL_HOLD_MICRO_CREDITS,
		);
		expect(transcriptHoldForSourceBytes(null)).toBe(
			TRANSCRIPT_FULL_HOLD_MICRO_CREDITS,
		);
		const sentence = `A file under 180 KB holds ${min}, a file of 7.2 MB or more holds the full ${full}, and a URL that does not report its size holds ${full}.`;
		expect(billing).toContain(sentence);
		expect(rest).toContain(
			`a file under 180 KB holds ${min}, a file of 7.2 MB or more holds the full ${full}`,
		);
		expect(billing).toContain(
			`Starting a transcript needs an available balance of at least ${min}.`,
		);
	});

	it("states the limits the code enforces", () => {
		expect(billing).toContain(
			`One purchase is from ${wholeDollars(TOP_UP_MIN_CENTS)} to ${wholeDollars(TOP_UP_MAX_CENTS)}`,
		);
		expect(billing).toContain(
			`Cap Pro includes $${PRO_MONTHLY_CREDIT_DOLLARS} of credit every month`,
		);
		expect(billing).toContain(
			`The amount you set, from ${wholeDollars(AUTO_TOP_UP_MIN_AMOUNT_CENTS)} to ${wholeDollars(AUTO_TOP_UP_MAX_AMOUNT_CENTS)}.`,
		);
		expect(billing).toContain(
			`The threshold is from ${formatCredits(AUTO_TOP_UP_MIN_THRESHOLD_MICRO_CREDITS).replace(".00", "")} to ${formatCredits(AUTO_TOP_UP_MAX_THRESHOLD_MICRO_CREDITS).replace(".00", "")}.`,
		);
		expect(billing).toContain(
			`${INFRA_GRACE_DAYS} days after the app first fell short`,
		);
		expect(billing).toContain(`${LEDGER_PAGE_SIZE} to a page`);
		expect(billing).toContain(
			`reads ${formatCredits(2_999_901)} and never $30.00`,
		);
	});

	it("gives the times the daily job is scheduled for", () => {
		const { crons } = JSON.parse(
			fs.readFileSync(path.join(process.cwd(), "vercel.json"), "utf8"),
		) as { crons: { path: string; schedule: string }[] };
		const schedule = crons.find(
			(cron) => cron.path === "/api/cron/developer-storage",
		)?.schedule;

		expect(schedule).toBe("41 */6 * * *");
		const times = "at 00:41, 06:41, 12:41 and 18:41 UTC";
		expect(billing.split(times)).toHaveLength(3);
	});

	it("leaves the open policy questions and uncharged prices out", () => {
		for (const word of [
			"refund",
			"refunds",
			"refunded",
			"expire",
			"expires",
			"expiry",
			"tax",
			"taxes",
			"vat",
			"invoice",
			"invoices",
			"receipt",
			"receipts",
			"delivery",
			"watched",
		]) {
			expect(billing, word).not.toMatch(new RegExp(`\\b${word}\\b`, "i"));
		}
		expect(billing).not.toContain(String.fromCodePoint(0x2014));
		expect(rest).not.toMatch(/\bdelivery\b|\bwatched\b/i);
	});
});

describe("examples in the REST API reference", () => {
	it("prices the transcript example by the rule it states", () => {
		const { data } = jsonAfter(rest, "#### Get Transcript");

		expect(data.durationSeconds).toBe(754.2);
		expect(transcriptionBilledSeconds(data.durationSeconds)).toBe(754);
		expect(data.costMicroCredits).toBe(
			transcriptionMicroCredits(data.durationSeconds),
		);
		expect(data.costMicroCredits).toBe(2094);
		expect(data.costDollars).toBe(
			data.costMicroCredits / MICRO_CREDITS_PER_DOLLAR,
		);
		expect(rest).toContain(
			"754.2 seconds, billed as 754 seconds: 754 × 10,000 ÷ 3,600 is 2,094.4, so it costs 2,094 micro-credits",
		);
		expect(rest).not.toContain("2097");
	});

	it("writes the upload refusal example the way the API words it", () => {
		const body = jsonAfter(rest, "The `402` body says how much is needed:");
		const refusal = uploadAdmissionError(
			uploadAdmission({
				balanceMicroCredits: body.balanceMicroCredits,
				standing: { state: "active", pausesAt: null },
				lastOwedMicroCredits: 0,
				usage: {
					monthlyMicroCredits:
						(body.requiredMicroCredits * STORAGE_BILLING_DAYS_PER_MONTH) /
						UPLOAD_ADMISSION_DAYS,
				},
			}),
		);

		expect(body).toEqual(refusal);
		expect(body.message).toContain(
			`needs ${formatNeed(body.requiredMicroCredits)} of credit`,
		);
		expect(body.message).toContain(
			`The balance is ${formatCredits(body.balanceMicroCredits)}, so add at least ${formatNeed(body.shortfallMicroCredits)}.`,
		);
		expect(body.balanceMicroCredits + body.shortfallMicroCredits).toBe(
			body.requiredMicroCredits,
		);
	});

	it("keeps the usage example consistent with the pricing functions", () => {
		const { data } = jsonAfter(rest, "### Get Usage");
		const monthly = monthlyStorageMicroCredits(data.storage.minutesByTier);

		expect(data.balanceDollars).toBe(creditDollars(data.balanceMicroCredits));
		expect(data.storage.monthlyMicroCredits).toBe(Math.round(monthly));
		expect(data.storage.dailyMicroCredits).toBe(
			dailyStorageMicroCredits(data.storage.minutesByTier),
		);
		expect(data.upload.requiredMicroCredits).toBe(
			uploadAdmissionMicroCredits(monthly),
		);
		expect(
			Object.values(
				data.storage.minutesByTier as Record<string, number>,
			).reduce((sum, minutes) => sum + minutes, 0),
		).toBe(data.totalDurationMinutes);
		expect(data.rates.storageDollarsPer1000MinutesPerMonth).toEqual(
			INFRA_STORAGE_DOLLARS_PER_1000_MINUTES_PER_MONTH,
		);
		expect(data.rates.speechDollarsPerHour).toBe(SPEECH_DOLLARS_PER_HOUR);
		expect(data.rates.uploadAdmissionDays).toBe(UPLOAD_ADMISSION_DAYS);
		expect(rest).toContain(
			`2,999,901 micro-credits is \`"${creditDollars(2_999_901)}"\``,
		);
	});

	it("keeps the transactions example adding up", () => {
		const { data, pagination } = jsonAfter(rest, "### List Transactions");

		expect(pagination).toEqual({ limit: 2, offset: 0, hasMore: false });
		for (const entry of data) {
			expect(entry.amountDollars).toBe(
				signedCreditDollars(entry.amountMicroCredits),
			);
			expect(entry.balanceAfterDollars).toBe(
				creditDollars(entry.balanceAfterMicroCredits),
			);
		}
		expect(data[0].balanceAfterMicroCredits - data[0].amountMicroCredits).toBe(
			data[1].balanceAfterMicroCredits,
		);
		expect(-data[0].amountMicroCredits).toBe(transcriptionMicroCredits(754.2));
	});
});
