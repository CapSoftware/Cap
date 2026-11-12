import { beforeEach, describe, expect, it, vi } from "vitest";

const context = vi.hoisted(() => ({
	fake: null as null | {
		db: unknown;
		rows: (table: object) => Record<string, unknown>[];
		seed: (
			table: object,
			row: Record<string, unknown>,
		) => Record<string, unknown>;
		failNextCommit: () => void;
		reset: () => void;
	},
	ledgerIds: 0,
}));

vi.mock("@cap/database", async () => {
	const schema = await import("@cap/database/schema");
	const { createFakeDatabase } = await import("./developer-transcript-fake-db");
	const fake = createFakeDatabase(
		new Map<object, () => Record<string, unknown>>([
			[
				schema.developerTranscripts,
				() => ({
					status: "processing",
					deletedAt: null,
					text: null,
					resultKey: null,
					durationSeconds: null,
					reservedMicroCredits: 0,
					billedMicroCredits: 0,
					errorCode: null,
				}),
			],
		]),
	);
	context.fake = fake;
	return { db: () => fake.db };
});

vi.mock("@cap/database/helpers", () => ({
	nanoId: () => {
		context.ledgerIds += 1;
		return `ledger-${context.ledgerIds}`;
	},
	nanoIdLength: 15,
}));

import {
	developerCreditAccounts,
	developerCreditTransactions,
	developerTranscripts,
} from "@cap/database/schema";
import { debitDeveloperUsage } from "@/lib/developer-credits";
import {
	getAvailableTranscriptBalance,
	hasMinimumTranscriptBalance,
	reserveTranscriptCredits,
	settleTranscript,
} from "@/lib/developer-transcript-billing";

const ONE_HOUR = 3600;

const fake = () => {
	if (!context.fake) throw new Error("Fake database is not ready");
	return context.fake;
};

const account = () => fake().rows(developerCreditAccounts)[0];
const ledger = () => fake().rows(developerCreditTransactions);
const transcript = (id = "tr-1") =>
	fake()
		.rows(developerTranscripts)
		.find((row) => row.id === id);

const addTranscript = (id: string, overrides: Record<string, unknown> = {}) =>
	fake().seed(developerTranscripts, { id, appId: "app-1", ...overrides });

const settle = (durationSeconds = ONE_HOUR, transcriptId = "tr-1") =>
	settleTranscript({
		transcriptId,
		durationSeconds,
		language: "en",
		text: "hello world",
		wordCount: 2,
		resultKey: `developer/app-1/transcripts/${transcriptId}/result.json`,
	});

beforeEach(() => {
	fake().reset();
	context.ledgerIds = 0;
	fake().seed(developerCreditAccounts, {
		id: "account-1",
		appId: "app-1",
		balanceMicroCredits: 50_000,
	});
	addTranscript("tr-1");
});

describe("transcript settlement", () => {
	it("debits the measured cost once and completes the transcript", async () => {
		const result = await settle();

		expect(result).toEqual({
			state: "complete",
			chargedMicroCredits: 10_000,
			alreadySettled: false,
		});
		expect(account()?.balanceMicroCredits).toBe(40_000);
		expect(ledger()).toHaveLength(1);
		expect(ledger()[0]).toMatchObject({
			accountId: "account-1",
			type: "transcription",
			amountMicroCredits: -10_000,
			balanceAfterMicroCredits: 40_000,
			referenceId: "tr-1",
			referenceType: "developer_transcript",
			metadata: { durationSeconds: ONE_HOUR, billedSeconds: ONE_HOUR },
		});
		expect(transcript()).toMatchObject({
			status: "complete",
			text: "hello world",
			billedMicroCredits: 10_000,
			reservedMicroCredits: 0,
			durationSeconds: ONE_HOUR,
		});
	});

	it("does not charge again when the settle step is retried", async () => {
		await settle();
		const retry = await settle();

		expect(retry).toEqual({
			state: "complete",
			chargedMicroCredits: 0,
			alreadySettled: true,
		});
		expect(account()?.balanceMicroCredits).toBe(40_000);
		expect(ledger()).toHaveLength(1);
	});

	it("charges once when two settle attempts overlap", async () => {
		const results = await Promise.all([settle(), settle(), settle()]);

		expect(
			results.filter((result) => result.state === "complete"),
		).toHaveLength(3);
		expect(
			results.reduce(
				(sum, result) =>
					sum + (result.state === "complete" ? result.chargedMicroCredits : 0),
				0,
			),
		).toBe(10_000);
		expect(account()?.balanceMicroCredits).toBe(40_000);
		expect(ledger()).toHaveLength(1);
	});

	it("charges exactly once when the first attempt fails before commit", async () => {
		fake().failNextCommit();
		await expect(settle()).rejects.toThrow("connection lost before commit");
		expect(account()?.balanceMicroCredits).toBe(50_000);
		expect(ledger()).toHaveLength(0);
		expect(transcript()?.status).toBe("processing");

		const retry = await settle();
		expect(retry.state).toBe("complete");
		expect(account()?.balanceMicroCredits).toBe(40_000);
		expect(ledger()).toHaveLength(1);
	});

	it("does not debit again when a ledger row already covers the transcript", async () => {
		fake().seed(developerCreditTransactions, {
			id: "ledger-existing",
			accountId: "account-1",
			type: "transcription",
			amountMicroCredits: -10_000,
			referenceId: "tr-1",
			referenceType: "developer_transcript",
		});

		const result = await settle();

		expect(result).toEqual({
			state: "complete",
			chargedMicroCredits: 0,
			alreadySettled: false,
		});
		expect(account()?.balanceMicroCredits).toBe(50_000);
		expect(ledger()).toHaveLength(1);
		expect(transcript()?.status).toBe("complete");
	});

	it("keeps charges for different transcripts separate", async () => {
		addTranscript("tr-2");
		await settle(ONE_HOUR, "tr-1");
		await settle(1800, "tr-2");

		expect(account()?.balanceMicroCredits).toBe(35_000);
		expect(
			ledger().map((row) => [row.referenceId, row.amountMicroCredits]),
		).toEqual([
			["tr-1", -10_000],
			["tr-2", -5_000],
		]);
	});

	it("bills the measured length, pro-rated by the second", async () => {
		const result = await settle(90);
		expect(result).toMatchObject({ chargedMicroCredits: 250 });
		expect(ledger()[0]).toMatchObject({
			amountMicroCredits: -250,
			metadata: { durationSeconds: 90, billedSeconds: 90 },
		});
	});

	it("withholds the text and charges nothing when the balance ran out", async () => {
		const current = account();
		if (current) current.balanceMicroCredits = 9_999;

		const result = await settle();

		expect(result).toEqual({ state: "insufficient_credits" });
		expect(account()?.balanceMicroCredits).toBe(9_999);
		expect(ledger()).toHaveLength(0);
		expect(transcript()).toMatchObject({
			status: "error",
			errorCode: "insufficient_credits",
			text: null,
			resultKey: null,
			billedMicroCredits: 0,
			reservedMicroCredits: 0,
		});
	});

	it("spends a balance that exactly covers the cost", async () => {
		const current = account();
		if (current) current.balanceMicroCredits = 10_000;
		const result = await settle();
		expect(result.state).toBe("complete");
		expect(account()?.balanceMicroCredits).toBe(0);
	});

	it("fails without charging when the app has no credit account", async () => {
		fake().rows(developerCreditAccounts).length = 0;
		const result = await settle();
		expect(result).toEqual({ state: "insufficient_credits" });
		expect(ledger()).toHaveLength(0);
		expect(transcript()?.status).toBe("error");
	});

	it("does not charge for a transcript deleted while it ran", async () => {
		const current = transcript();
		if (current) current.deletedAt = new Date();
		const result = await settle();
		expect(result).toEqual({ state: "skipped", reason: "deleted" });
		expect(account()?.balanceMicroCredits).toBe(50_000);
		expect(ledger()).toHaveLength(0);
	});

	it("does not charge for a transcript that already failed or timed out", async () => {
		const current = transcript();
		if (current) current.status = "error";
		const result = await settle();
		expect(result).toEqual({ state: "skipped", reason: "not_processing" });
		expect(ledger()).toHaveLength(0);
		expect(transcript()?.text).toBeNull();
	});

	it("skips a transcript that no longer exists", async () => {
		fake().rows(developerTranscripts).length = 0;
		expect(await settle()).toEqual({ state: "skipped", reason: "missing" });
		expect(ledger()).toHaveLength(0);
	});
});

describe("transcript holds", () => {
	const reserve = (transcriptId: string, durationSeconds: number) =>
		reserveTranscriptCredits({ transcriptId, durationSeconds });

	it("holds the cost and records the measured length without charging", async () => {
		const result = await reserve("tr-1", ONE_HOUR);

		expect(result).toEqual({ state: "reserved", reservedMicroCredits: 10_000 });
		expect(transcript()).toMatchObject({
			reservedMicroCredits: 10_000,
			durationSeconds: ONE_HOUR,
			status: "processing",
		});
		expect(account()?.balanceMicroCredits).toBe(50_000);
		expect(ledger()).toHaveLength(0);
		expect(await getAvailableTranscriptBalance("app-1")).toBe(40_000);
	});

	it("refuses a transcript the held balance cannot cover", async () => {
		addTranscript("tr-2");
		await reserve("tr-1", 4 * ONE_HOUR);

		expect(await reserve("tr-2", 2 * ONE_HOUR)).toEqual({
			state: "insufficient_credits",
		});
		expect(transcript("tr-2")?.reservedMicroCredits).toBe(0);
		expect(await reserve("tr-2", ONE_HOUR)).toEqual({
			state: "reserved",
			reservedMicroCredits: 10_000,
		});
	});

	it("never holds more than the balance when jobs start together", async () => {
		const current = account();
		if (current) current.balanceMicroCredits = 1_000;
		const ids = ["tr-1", "tr-2", "tr-3", "tr-4", "tr-5"];
		for (const id of ids.slice(1)) addTranscript(id);

		const results = await Promise.all(ids.map((id) => reserve(id, 144)));

		expect(
			results.filter((result) => result.state === "reserved"),
		).toHaveLength(2);
		expect(
			results.filter((result) => result.state === "insufficient_credits"),
		).toHaveLength(3);
		expect(
			fake()
				.rows(developerTranscripts)
				.reduce((sum, row) => sum + Number(row.reservedMicroCredits), 0),
		).toBe(800);
	});

	it("can be repeated without holding twice", async () => {
		await reserve("tr-1", 5 * ONE_HOUR);
		expect(await reserve("tr-1", 5 * ONE_HOUR)).toEqual({
			state: "reserved",
			reservedMicroCredits: 50_000,
		});
		expect(await getAvailableTranscriptBalance("app-1")).toBe(0);
	});

	it("releases the hold when the transcript fails or completes", async () => {
		addTranscript("tr-2");
		await reserve("tr-1", 5 * ONE_HOUR);
		expect((await reserve("tr-2", ONE_HOUR)).state).toBe(
			"insufficient_credits",
		);

		const first = transcript("tr-1");
		if (first) first.status = "error";
		expect((await reserve("tr-2", ONE_HOUR)).state).toBe("reserved");

		await settle(ONE_HOUR, "tr-2");
		expect(await getAvailableTranscriptBalance("app-1")).toBe(40_000);
	});

	it("ignores holds from other apps", async () => {
		fake().seed(developerTranscripts, {
			id: "tr-other",
			appId: "app-2",
			reservedMicroCredits: 50_000,
		});
		expect((await reserve("tr-1", 5 * ONE_HOUR)).state).toBe("reserved");
	});

	it("does not hold for a deleted or finished transcript", async () => {
		const current = transcript();
		if (current) current.deletedAt = new Date();
		expect(await reserve("tr-1", ONE_HOUR)).toEqual({ state: "skipped" });

		addTranscript("tr-2", { status: "complete" });
		expect(await reserve("tr-2", ONE_HOUR)).toEqual({ state: "skipped" });
		expect(await reserve("tr-missing", ONE_HOUR)).toEqual({ state: "skipped" });
	});

	it("refuses when the app has no credit account", async () => {
		fake().rows(developerCreditAccounts).length = 0;
		expect(await reserve("tr-1", 60)).toEqual({
			state: "insufficient_credits",
		});
		expect(await getAvailableTranscriptBalance("app-1")).toBeNull();
	});
});

describe("holds and other usage", () => {
	const reserve = (transcriptId: string, durationSeconds: number) =>
		reserveTranscriptCredits({ transcriptId, durationSeconds });
	const otherUsage = (microCredits: number, referenceId: string) =>
		(
			fake().db as {
				transaction: <T>(run: (tx: never) => Promise<T>) => Promise<T>;
			}
		).transaction((tx) =>
			debitDeveloperUsage(tx, {
				appId: "app-1",
				microCredits,
				type: "video_create",
				referenceId,
				referenceType: "developer_video",
			}),
		);
	const setBalance = (value: number) => {
		const current = account();
		if (current) current.balanceMicroCredits = value;
	};

	it("does not let other usage spend credits held for a running transcript", async () => {
		setBalance(12_000);
		await reserve("tr-1", ONE_HOUR);

		expect(await otherUsage(5_000, "video-1")).toEqual({
			state: "insufficient",
		});
		expect(account()?.balanceMicroCredits).toBe(12_000);
		expect(await otherUsage(2_000, "video-2")).toMatchObject({
			state: "debited",
			balanceAfter: 10_000,
		});

		expect(await settle()).toMatchObject({
			state: "complete",
			chargedMicroCredits: 10_000,
		});
		expect(account()?.balanceMicroCredits).toBe(0);
	});

	it("settles a held transcript even when other usage raced it", async () => {
		setBalance(20_000);
		await reserve("tr-1", ONE_HOUR);

		const [settled, ...videos] = await Promise.all([
			settle(),
			...Array.from({ length: 6 }, (_, index) =>
				otherUsage(5_000, `video-${index}`),
			),
		]);

		expect(settled).toMatchObject({ state: "complete" });
		expect(videos.filter((video) => video.state === "debited")).toHaveLength(2);
		expect(account()?.balanceMicroCredits).toBe(0);
		expect(transcript()).toMatchObject({
			status: "complete",
			billedMicroCredits: 10_000,
		});
	});

	it("frees held credits for other usage once the transcript is settled or failed", async () => {
		setBalance(12_000);
		await reserve("tr-1", ONE_HOUR);
		expect((await otherUsage(5_000, "video-1")).state).toBe("insufficient");

		const current = transcript();
		if (current) current.status = "error";
		expect((await otherUsage(5_000, "video-1")).state).toBe("debited");
	});

	it("does not count its own hold against its settle", async () => {
		setBalance(10_000);
		await reserve("tr-1", ONE_HOUR);
		expect((await settle()).state).toBe("complete");
	});

	it("still counts other transcripts' holds against a settle", async () => {
		addTranscript("tr-2");
		setBalance(15_000);
		await reserve("tr-2", ONE_HOUR);

		expect(await settle(ONE_HOUR, "tr-1")).toEqual({
			state: "insufficient_credits",
		});
		expect(account()?.balanceMicroCredits).toBe(15_000);
		expect((await settle(ONE_HOUR, "tr-2")).state).toBe("complete");
	});

	it("never charges more than was held", async () => {
		await reserve("tr-1", ONE_HOUR);

		expect(await settle(2 * ONE_HOUR)).toMatchObject({
			state: "complete",
			chargedMicroCredits: 10_000,
		});
		expect(transcript()).toMatchObject({
			billedMicroCredits: 10_000,
			reservedMicroCredits: 0,
		});
		expect(ledger()[0]).toMatchObject({ amountMicroCredits: -10_000 });
		expect(account()?.balanceMicroCredits).toBe(40_000);
	});

	it("charges the measured cost when it is below the hold", async () => {
		await reserve("tr-1", ONE_HOUR);
		expect(await settle(1800)).toMatchObject({ chargedMicroCredits: 5_000 });
		expect(account()?.balanceMicroCredits).toBe(45_000);
	});

	it("ignores holds on deleted transcripts and other apps", async () => {
		setBalance(10_000);
		addTranscript("tr-deleted", {
			reservedMicroCredits: 9_000,
			deletedAt: new Date(),
		});
		fake().seed(developerTranscripts, {
			id: "tr-other-app",
			appId: "app-2",
			reservedMicroCredits: 9_000,
		});
		expect((await otherUsage(10_000, "video-1")).state).toBe("debited");
	});
});

describe("minimum balance to start", () => {
	it("needs the minimum after holds are taken off", async () => {
		const current = account();
		if (current) current.balanceMicroCredits = 1_000;
		expect(await hasMinimumTranscriptBalance("app-1")).toBe(true);

		if (current) current.balanceMicroCredits = 999;
		expect(await hasMinimumTranscriptBalance("app-1")).toBe(false);

		if (current) current.balanceMicroCredits = 10_500;
		await reserveTranscriptCredits({
			transcriptId: "tr-1",
			durationSeconds: ONE_HOUR,
		});
		expect(await hasMinimumTranscriptBalance("app-1")).toBe(false);
	});

	it("refuses an app without a credit account", async () => {
		fake().rows(developerCreditAccounts).length = 0;
		expect(await hasMinimumTranscriptBalance("app-1")).toBe(false);
	});
});
