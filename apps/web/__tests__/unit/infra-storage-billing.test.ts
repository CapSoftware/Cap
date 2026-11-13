import { beforeEach, describe, expect, it, vi } from "vitest";

const holder = vi.hoisted(() => ({ db: null as unknown, ids: 0 }));

vi.mock("@cap/database", () => ({ db: () => holder.db }));
vi.mock("@cap/database/helpers", () => ({
	nanoId: () => `row-${++holder.ids}`,
	nanoIdLength: 15,
}));

import {
	advanceDays,
	dateKey,
	fakeDb,
	ledger,
	resetLedger,
	storageRows,
} from "./infra-billing-fake-db";

holder.db = fakeDb;

import {
	storageUsage,
	uploadAdmissionMicroCredits,
} from "@/lib/developer-pricing";
import { admitDeveloperVideoUpload } from "@/lib/developer-video-charge";
import { availableBalance } from "@/lib/infra-balance";
import {
	getInfraAppStanding,
	getInfraBilling,
	getInfraUploadAdmission,
} from "@/lib/infra-standing";
import { getAppStorageUsage } from "@/lib/infra-storage";
import { chargeStorageDay } from "@/lib/infra-storage-billing";

const DAY_MS = 24 * 60 * 60 * 1000;

const store = () => {
	ledger.videos = [
		{ appId: "app-1", width: 1280, height: 720, seconds: 60, count: 1 },
		{ appId: "app-1", width: 2560, height: 1440, seconds: 600, count: 1 },
		{ appId: "app-1", width: 3840, height: 2160, seconds: 600, count: 1 },
	];
};

const charge = async () =>
	chargeStorageDay({
		appId: "app-1",
		accountId: "account-1",
		usage: await getAppStorageUsage("app-1"),
		dateKey: dateKey(),
		now: new Date(ledger.now),
	});

const credit = (microCredits: number) => {
	ledger.account.balanceMicroCredits += microCredits;
	ledger.rows.push({
		id: `credit-${ledger.rows.length}`,
		accountId: "account-1",
		type: "topup",
		amountMicroCredits: microCredits,
		balanceAfterMicroCredits: ledger.account.balanceMicroCredits,
		referenceId: `pi_${ledger.rows.length}`,
		referenceType: "stripe_payment_intent",
		createdAt: new Date(ledger.now),
	});
};

const billing = () => getInfraBilling("app-1", undefined, new Date(ledger.now));
const standing = () => billing().then((result) => result.standing);
const admission = () => billing().then((result) => result.admission);

beforeEach(() => {
	resetLedger();
	store();
});

describe("daily storage charge", () => {
	it("charges each video at its tier and writes one ledger row and snapshot", async () => {
		ledger.account.balanceMicroCredits = 1_000_000;

		const result = await charge();

		expect(result).toMatchObject({
			state: "billed",
			owedMicroCredits: 144,
			chargedMicroCredits: 144,
			shortSince: null,
			fellShort: false,
		});
		expect(ledger.account.balanceMicroCredits).toBe(999_856);
		expect(ledger.rows).toEqual([
			expect.objectContaining({
				type: "storage_daily",
				amountMicroCredits: -144,
				balanceAfterMicroCredits: 999_856,
				referenceId: "2026-11-11",
				referenceType: "storage_day",
				metadata: expect.objectContaining({
					owedMicroCredits: 144,
					chargedMicroCredits: 144,
					shortSince: null,
					minutesByTier: { "1080p": 1, "1440p": 10, "2160p": 10 },
					videoCount: 3,
				}),
			}),
		]);
		expect(ledger.snapshots).toEqual([
			{
				snapshotDate: "2026-11-11",
				totalDurationMinutes: 21,
				videoCount: 3,
				microCreditsCharged: 144,
				processedAt: ledger.now,
			},
		]);
	});

	it("leaves credit held for a running transcript alone", async () => {
		ledger.account.balanceMicroCredits = 10_100;
		ledger.heldMicroCredits = 10_000;

		const result = await charge();

		expect(result).toMatchObject({
			state: "billed",
			owedMicroCredits: 144,
			chargedMicroCredits: 100,
			balanceMicroCredits: 10_000,
			fellShort: true,
		});
		expect(ledger.account.balanceMicroCredits).toBe(10_000);
		expect(storageRows()).toEqual([
			expect.objectContaining({
				amountMicroCredits: -100,
				balanceAfterMicroCredits: 10_000,
			}),
		]);
	});

	it("takes nothing when the whole balance is held, then charges in full once the hold is released", async () => {
		ledger.account.balanceMicroCredits = 10_000;
		ledger.heldMicroCredits = 10_000;

		expect(await charge()).toMatchObject({
			state: "billed",
			chargedMicroCredits: 0,
			fellShort: true,
		});
		expect(ledger.account.balanceMicroCredits).toBe(10_000);
		expect((await standing()).state).toBe("grace");

		ledger.heldMicroCredits = 0;
		expect((await standing()).state).toBe("active");
		advanceDays(1);
		expect(await charge()).toMatchObject({
			state: "billed",
			chargedMicroCredits: 144,
			shortSince: null,
		});
		expect(ledger.account.balanceMicroCredits).toBe(9_856);
	});

	it("charges once per day however often it runs", async () => {
		ledger.account.balanceMicroCredits = 1_000_000;

		await charge();
		const again = await charge();
		const thirdTime = await charge();

		expect(again).toEqual({ state: "skipped" });
		expect(thirdTime).toEqual({ state: "skipped" });
		expect(storageRows()).toHaveLength(1);
		expect(ledger.account.balanceMicroCredits).toBe(999_856);
	});

	it("charges again the next day", async () => {
		ledger.account.balanceMicroCredits = 1_000_000;

		await charge();
		advanceDays(1);
		await charge();

		expect(storageRows().map((row) => row.referenceId)).toEqual([
			"2026-11-11",
			"2026-11-12",
		]);
		expect(ledger.account.balanceMicroCredits).toBe(999_712);
	});

	it("takes exactly what is there on a short day and records when it fell short", async () => {
		ledger.account.balanceMicroCredits = 50;

		const result = await charge();

		expect(result).toMatchObject({
			state: "billed",
			owedMicroCredits: 144,
			chargedMicroCredits: 50,
			balanceMicroCredits: 0,
			fellShort: true,
		});
		expect(ledger.account.balanceMicroCredits).toBe(0);
		expect(storageRows()[0]).toMatchObject({
			amountMicroCredits: -50,
			balanceAfterMicroCredits: 0,
			metadata: expect.objectContaining({
				owedMicroCredits: 144,
				chargedMicroCredits: 50,
				shortSince: ledger.now.toISOString(),
			}),
		});
		expect(ledger.snapshots[0]?.microCreditsCharged).toBe(50);
	});

	it("records a short day at zero balance, then adds no ledger rows while unpaid", async () => {
		const first = await charge();
		expect(first).toMatchObject({ state: "billed", chargedMicroCredits: 0 });
		expect(storageRows()).toHaveLength(1);
		expect(storageRows()[0]?.amountMicroCredits).toBe(0);
		const shortSince = new Date(ledger.now);

		for (let day = 0; day < 3; day++) {
			advanceDays(1);
			expect(await charge()).toEqual({ state: "unpaid", shortSince });
		}

		expect(storageRows()).toHaveLength(1);
		expect(ledger.account.balanceMicroCredits).toBe(0);
		expect(ledger.snapshots).toHaveLength(4);
		expect(ledger.snapshots.at(-1)?.microCreditsCharged).toBe(0);
	});

	it("does not bill an app that stores nothing", async () => {
		ledger.videos = [];
		ledger.account.balanceMicroCredits = 1_000_000;

		expect(await charge()).toEqual({ state: "skipped" });
		expect(ledger.rows).toHaveLength(0);
		expect(ledger.snapshots).toHaveLength(0);
	});

	it("skips an app with no credit account", async () => {
		ledger.account.exists = false;

		expect(await charge()).toEqual({ state: "skipped" });
		expect(ledger.rows).toHaveLength(0);
	});
});

describe("a day the previous storage job already charged", () => {
	const oldRow = () => ({
		id: "old-job-row",
		accountId: "account-1",
		type: "storage_daily",
		amountMicroCredits: -26,
		balanceAfterMicroCredits: 999_974,
		referenceId: null,
		referenceType: "manual",
		metadata: {
			snapshotDate: dateKey(),
			totalDurationMinutes: 10,
			videoCount: 5,
		},
		createdAt: new Date(ledger.now.getTime() - 60 * 60 * 1000),
	});
	const oldSnapshot = () => ({
		snapshotDate: dateKey(),
		totalDurationMinutes: 10,
		videoCount: 5,
		microCreditsCharged: 26,
		processedAt: new Date(ledger.now.getTime() - 60 * 60 * 1000),
	});

	beforeEach(() => {
		ledger.account.balanceMicroCredits = 999_974;
	});

	it("is skipped, and its snapshot is left alone", async () => {
		ledger.rows = [oldRow()];
		ledger.snapshots = [oldSnapshot()];

		expect(await charge()).toEqual({ state: "skipped" });
		expect(ledger.account.balanceMicroCredits).toBe(999_974);
		expect(ledger.rows).toHaveLength(1);
		expect(ledger.snapshots).toEqual([oldSnapshot()]);
	});

	it("is skipped on the completed snapshot alone", async () => {
		ledger.snapshots = [oldSnapshot()];

		expect(await charge()).toEqual({ state: "skipped" });
		expect(ledger.rows).toHaveLength(0);
	});

	it("is skipped on the old ledger row alone", async () => {
		ledger.rows = [oldRow()];

		expect(await charge()).toEqual({ state: "skipped" });
		expect(ledger.rows).toHaveLength(1);
		expect(ledger.snapshots).toHaveLength(0);
	});

	it("is charged again the next day, in the new form", async () => {
		ledger.rows = [oldRow()];
		ledger.snapshots = [oldSnapshot()];
		advanceDays(1);

		expect(await charge()).toMatchObject({
			state: "billed",
			chargedMicroCredits: 144,
		});
		expect(storageRows().at(-1)?.referenceType).toBe("storage_day");
	});

	it("leaves standing active: an old row was never short", async () => {
		ledger.rows = [oldRow()];
		ledger.account.balanceMicroCredits = 0;

		expect(await standing()).toEqual({ state: "active", pausesAt: null });
	});
});

describe("admission prices a video the way the storage job will", () => {
	const capped = {
		appId: "app-1",
		videoId: "video-new",
		durationSeconds: 3600,
		width: 3840,
		height: 2160,
		maxResolutionTier: "1080p",
	};

	beforeEach(() => {
		ledger.videos = [];
	});

	it("requires exactly 7 days of what the job charges for the same row", async () => {
		ledger.account.balanceMicroCredits = 1_000_000;
		ledger.videos = [
			{
				appId: "app-1",
				width: capped.width,
				height: capped.height,
				seconds: capped.durationSeconds,
				count: 1,
				status: "ready",
				maxResolutionTier: capped.maxResolutionTier,
			},
		];
		const jobUsage = await getAppStorageUsage("app-1");
		ledger.videos = [];

		const admission = await admitDeveloperVideoUpload(capped);

		expect(jobUsage.minutesByTier).toEqual({
			"1080p": 60,
			"1440p": 0,
			"2160p": 0,
		});
		expect(admission.requiredMicroCredits).toBe(
			uploadAdmissionMicroCredits(jobUsage.monthlyMicroCredits),
		);
		expect(admission.requiredMicroCredits).toBe(1190);
	});

	it("admits a 4K source capped at 1080p on a balance that covers 1080p storage, and refuses one that does not", async () => {
		ledger.account.balanceMicroCredits = 1190;
		expect((await admitDeveloperVideoUpload(capped)).allowed).toBe(true);

		ledger.account.balanceMicroCredits = 1189;
		expect(await admitDeveloperVideoUpload(capped)).toMatchObject({
			allowed: false,
			reason: "insufficient_credits",
			shortfallMicroCredits: 1,
		});
	});

	it("needs 4K credit when the video is allowed to be stored at 4K", async () => {
		ledger.account.balanceMicroCredits = 1190;

		expect(
			await admitDeveloperVideoUpload({
				...capped,
				maxResolutionTier: "2160p",
			}),
		).toMatchObject({ allowed: false, requiredMicroCredits: 3920 });
	});
});

describe("standing through the ledger", () => {
	it("goes active, grace, paused and back to active", async () => {
		ledger.account.balanceMicroCredits = 200;
		await charge();
		expect(await standing()).toEqual({ state: "active", pausesAt: null });

		advanceDays(1);
		await charge();
		const shortSince = new Date(ledger.now);
		const pausesAt = new Date(shortSince.getTime() + 7 * DAY_MS);
		expect(ledger.account.balanceMicroCredits).toBe(0);
		expect(await standing()).toEqual({ state: "grace", pausesAt });

		advanceDays(6);
		await charge();
		expect(await standing()).toEqual({ state: "grace", pausesAt });

		advanceDays(1);
		await charge();
		expect(await standing()).toEqual({ state: "paused", pausesAt });
		expect((await admission()).reason).toBe("out_of_credit");

		credit(500_000);
		expect(await standing()).toEqual({ state: "active", pausesAt: null });
		expect((await admission()).allowed).toBe(true);
	});

	it("forgives the unpaid days and resumes at one day's charge after a top-up", async () => {
		await charge();
		advanceDays(1);
		await charge();
		advanceDays(1);
		await charge();
		advanceDays(8);

		credit(500_000);
		const result = await charge();

		expect(result).toMatchObject({
			state: "billed",
			chargedMicroCredits: 144,
			shortSince: null,
		});
		expect(ledger.account.balanceMicroCredits).toBe(500_000 - 144);
		expect(storageRows()).toHaveLength(2);
	});

	it("charges today once after a top-up that follows an unpaid run the same day", async () => {
		await charge();
		advanceDays(1);
		expect(await charge()).toMatchObject({ state: "unpaid" });
		expect(ledger.snapshots.at(-1)?.microCreditsCharged).toBe(0);

		credit(500_000);
		const afterTopUp = await charge();

		expect(afterTopUp).toMatchObject({
			state: "billed",
			chargedMicroCredits: 144,
			shortSince: null,
		});
		expect(ledger.account.balanceMicroCredits).toBe(500_000 - 144);
		expect(ledger.snapshots.at(-1)?.microCreditsCharged).toBe(144);

		expect(await charge()).toEqual({ state: "skipped" });
		expect(ledger.account.balanceMicroCredits).toBe(500_000 - 144);
		expect(storageRows()).toHaveLength(2);
	});

	it("starts a new grace period if it falls short again after being restored", async () => {
		await charge();
		const firstShort = new Date(ledger.now);
		advanceDays(3);
		credit(200);
		advanceDays(1);
		const paid = await charge();
		expect(paid).toMatchObject({ chargedMicroCredits: 144, shortSince: null });

		advanceDays(1);
		const short = await charge();

		expect(short).toMatchObject({ chargedMicroCredits: 56, fellShort: true });
		expect(
			short.state === "billed" && short.shortSince?.getTime(),
		).toBeGreaterThan(firstShort.getTime());
	});

	it("treats a credit smaller than the unpaid day as still short and takes it", async () => {
		await charge();
		const shortSince = new Date(ledger.now);
		advanceDays(1);
		credit(100);
		expect((await standing()).state).toBe("grace");

		const result = await charge();

		expect(result).toMatchObject({
			state: "billed",
			chargedMicroCredits: 100,
			fellShort: false,
			shortSince,
		});
		expect(ledger.account.balanceMicroCredits).toBe(0);
	});

	it("clears the short state once the app stores nothing that costs anything", async () => {
		await charge();
		advanceDays(8);
		expect((await standing()).state).toBe("paused");

		ledger.videos = [];
		advanceDays(1);
		const result = await charge();

		expect(result).toMatchObject({
			state: "billed",
			owedMicroCredits: 0,
			chargedMicroCredits: 0,
			shortSince: null,
		});
		expect(await standing()).toEqual({ state: "active", pausesAt: null });
		advanceDays(1);
		expect(await charge()).toEqual({ state: "skipped" });
	});

	it("is active for an app with no credit account, and refuses its uploads", async () => {
		ledger.account.exists = false;

		expect(await getInfraAppStanding("app-none")).toEqual({
			state: "active",
			pausesAt: null,
		});
		expect(await getInfraUploadAdmission("app-1")).toMatchObject({
			allowed: false,
			reason: "no_account",
		});
	});
});

describe("which videos are billed after the pipeline measures them", () => {
	const group = (
		status: string,
		width: number,
		height: number,
		seconds: number,
		extra: { videoId?: string; maxResolutionTier?: string | null } = {},
	) => ({ appId: "app-1", width, height, seconds, count: 1, status, ...extra });

	beforeEach(() => {
		ledger.videos = [
			group("ready", 1280, 720, 60),
			group("ready", 3840, 2160, 600, { maxResolutionTier: "1080p" }),
			group("processing", 3840, 2160, 600, { videoId: "video-1" }),
			group("uploading", 1920, 1080, 6000),
			group("errored", 1920, 1080, 6000),
		];
	});

	it("charges storage for ready videos only, at the lower of the measured tier and the max tier", async () => {
		ledger.account.balanceMicroCredits = 1_000_000;

		const usage = await getAppStorageUsage("app-1");
		const result = await charge();

		expect(usage.minutesByTier).toEqual({
			"1080p": 11,
			"1440p": 0,
			"2160p": 0,
		});
		expect(usage.videoCount).toBe(2);
		expect(result).toMatchObject({ state: "billed", chargedMicroCredits: 31 });
	});

	it("counts a still-processing video toward upload admission but not the storage charge", async () => {
		ledger.account.balanceMicroCredits = 1_000_000;

		const { usage } = await billing();

		expect(usage.minutesByTier).toEqual({
			"1080p": 11,
			"1440p": 0,
			"2160p": 10,
		});
		expect((await getAppStorageUsage("app-1")).minutesByTier["2160p"]).toBe(0);
	});

	it("leaves a video out of its own check when its measured length is admitted", async () => {
		ledger.account.balanceMicroCredits = 1_000_000;
		const measured = {
			durationSeconds: 660,
			width: 3840,
			height: 2160,
			tier: "2160p" as const,
		};

		const own = await getInfraUploadAdmission("app-1", measured, undefined, {
			excludeVideoId: "video-1",
		});
		const doubled = await getInfraUploadAdmission("app-1", measured);

		expect(own.requiredMicroCredits).toBe(
			Math.ceil(((11 * 85 + 11 * 280) * 7) / 30),
		);
		expect(doubled.requiredMicroCredits).toBe(
			Math.ceil(((11 * 85 + 21 * 280) * 7) / 30),
		);
	});
});

describe("available balance", () => {
	it("is the account balance less credit held for running transcripts, and nothing for an app with no account", async () => {
		ledger.account.balanceMicroCredits = 1234;
		expect(await availableBalance("app-1")).toBe(1234);

		ledger.heldMicroCredits = 1000;
		expect(await availableBalance("app-1")).toBe(234);

		ledger.account.exists = false;
		expect(await availableBalance("app-1")).toBe(null);
	});
});

describe("upload admission against what is stored", () => {
	it("counts the video being admitted on top of what is stored", async () => {
		const stored = await getAppStorageUsage("app-1");
		const withNew = await getAppStorageUsage("app-1", {
			durationSeconds: 6000,
			width: 3840,
			height: 2160,
			tier: "2160p",
		});

		expect(stored.monthlyMicroCredits).toBe(4335);
		expect(withNew.monthlyMicroCredits).toBe(4335 + 28_000);
		expect(withNew.videoCount).toBe(4);

		ledger.account.balanceMicroCredits = 1012;
		expect((await getInfraUploadAdmission("app-1")).allowed).toBe(true);
		const refused = await getInfraUploadAdmission("app-1", {
			durationSeconds: 6000,
			width: 3840,
			height: 2160,
			tier: "2160p",
		});
		expect(refused).toMatchObject({
			allowed: false,
			reason: "insufficient_credits",
			requiredMicroCredits: 7545,
			shortfallMicroCredits: 6533,
		});
	});

	it("matches the pure storage math", async () => {
		expect(await getAppStorageUsage("app-1")).toEqual(
			storageUsage([
				{
					video: {
						durationSeconds: 60,
						width: 1280,
						height: 720,
						tier: "1080p",
					},
					count: 1,
				},
				{
					video: {
						durationSeconds: 600,
						width: 2560,
						height: 1440,
						tier: "1440p",
					},
					count: 1,
				},
				{
					video: {
						durationSeconds: 600,
						width: 3840,
						height: 2160,
						tier: "2160p",
					},
					count: 1,
				},
			]),
		);
	});
});
