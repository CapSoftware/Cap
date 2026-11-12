import { randomUUID } from "node:crypto";
import {
	developerApps,
	developerCreditAccounts,
	developerCreditTransactions,
	developerTranscripts,
} from "@cap/database/schema";
import { User } from "@cap/web-domain";
import { and, eq } from "drizzle-orm";
import { drizzle, type MySql2Database } from "drizzle-orm/mysql2";
import { createPool, type Pool } from "mysql2/promise";
import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";

const fixture = vi.hoisted(() => ({
	database: undefined as MySql2Database | undefined,
	start: vi.fn(),
	objectSize: null as number | null,
}));

vi.mock("@cap/database", () => ({
	db: () => {
		if (!fixture.database) throw new Error("Test database is not connected.");
		return fixture.database;
	},
}));
vi.mock("@cap/env", () => ({
	buildEnv: { NEXT_PUBLIC_IS_CAP: "true" },
	NODE_ENV: "production",
}));
vi.mock("@/lib/infra-access", () => ({ canUseInfra: () => true }));
vi.mock("workflow/api", () => ({ start: fixture.start }));
vi.mock("@/workflows/developer-transcribe", () => ({
	developerTranscribeWorkflow: "developer-transcribe-workflow",
}));
vi.mock("@/lib/developer-transcript-speech", () => ({
	isSpeechConfigured: () => true,
	parseTranscriptLanguage: (value: string | null | undefined) =>
		!value || value === "auto" ? "auto" : value === "en" ? "en" : null,
}));
vi.mock("@/lib/developer-transcript-storage", () => ({
	presignDeveloperUpload: async (key: string) =>
		`https://storage.example/${key}`,
	developerObjectSize: async () => fixture.objectSize,
	getDeveloperObjectText: async () => null,
	deleteDeveloperObjects: async () => {},
}));

const { debitDeveloperUsage } = await import("@/lib/developer-credits");
const {
	getAvailableTranscriptBalance,
	reserveTranscriptCredits,
	settleTranscript,
} = await import("@/lib/developer-transcript-billing");
const { claimTranscriptRun, failTranscriptRun } = await import(
	"@/lib/developer-transcript-run"
);
const {
	createTranscriptFromUrl,
	createTranscriptUpload,
	deleteTranscript,
	expireStaleTranscripts,
	getTranscript,
	listTranscripts,
	startTranscriptUpload,
} = await import("@/lib/developer-transcript-store");

const databaseUrl = process.env.CAP_INFRA_SPEECH_TEST_DATABASE_URL;

const database = () => {
	if (!fixture.database) throw new Error("Test database is not connected.");
	return fixture.database;
};

const id = () => randomUUID().replaceAll("-", "").slice(0, 15);

const guards = { isBlocked: async () => false };
const URL_A = "https://media.example.com/standup.mp3";

async function makeApp(balanceMicroCredits: number) {
	const appId = id();
	const ownerId = User.UserId.make(id());
	await database().insert(developerApps).values({
		id: appId,
		ownerId,
		name: "Transcript fixture",
		environment: "development",
	});
	await database().insert(developerCreditAccounts).values({
		id: id(),
		appId,
		ownerId,
		balanceMicroCredits,
	});
	return appId;
}

async function makeTranscript(
	appId: string,
	overrides: Partial<typeof developerTranscripts.$inferInsert> = {},
) {
	const transcriptId = id();
	await database()
		.insert(developerTranscripts)
		.values({
			id: transcriptId,
			appId,
			status: "processing",
			sourceType: "upload",
			...overrides,
		});
	return transcriptId;
}

const balanceOf = async (appId: string) => {
	const [account] = await database()
		.select({ balance: developerCreditAccounts.balanceMicroCredits })
		.from(developerCreditAccounts)
		.where(eq(developerCreditAccounts.appId, appId));
	return account?.balance ?? null;
};

const ledgerOf = async (appId: string) =>
	database()
		.select({
			type: developerCreditTransactions.type,
			amount: developerCreditTransactions.amountMicroCredits,
			balanceAfter: developerCreditTransactions.balanceAfterMicroCredits,
			referenceId: developerCreditTransactions.referenceId,
			referenceType: developerCreditTransactions.referenceType,
		})
		.from(developerCreditTransactions)
		.innerJoin(
			developerCreditAccounts,
			eq(developerCreditTransactions.accountId, developerCreditAccounts.id),
		)
		.where(eq(developerCreditAccounts.appId, appId));

const settle = (transcriptId: string, durationSeconds: number) =>
	settleTranscript({
		transcriptId,
		durationSeconds,
		language: "en",
		text: "hello world",
		wordCount: 2,
		resultKey: `developer/fixture/transcripts/${transcriptId}/result.json`,
	});

describe.skipIf(!databaseUrl)("developer transcripts database", () => {
	let pool: Pool | undefined;

	beforeAll(async () => {
		if (!databaseUrl) throw new Error("Missing isolated test database URL.");
		const url = new URL(databaseUrl);
		if (
			url.protocol !== "mysql:" ||
			!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
			!/^\/cap_speech_[a-z0-9_]+$/.test(url.pathname)
		) {
			throw new Error(
				"Transcript tests require a session-scoped local database.",
			);
		}
		pool = createPool({ uri: databaseUrl, connectionLimit: 16 });
		fixture.database = drizzle(pool);
		await database().select().from(developerTranscripts).limit(1);
	});

	afterAll(async () => {
		await pool?.end();
		fixture.database = undefined;
	});

	beforeEach(() => {
		fixture.start.mockReset();
		fixture.start.mockResolvedValue(undefined);
		fixture.objectSize = null;
	});

	it("charges a transcript exactly once when settle attempts race", async () => {
		const appId = await makeApp(50_000);
		const transcriptId = await makeTranscript(appId);

		const results = await Promise.all(
			Array.from({ length: 8 }, () => settle(transcriptId, 3600)),
		);

		expect(results.every((result) => result.state === "complete")).toBe(true);
		expect(
			results.reduce(
				(sum, result) =>
					sum + (result.state === "complete" ? result.chargedMicroCredits : 0),
				0,
			),
		).toBe(10_000);
		expect(await balanceOf(appId)).toBe(40_000);
		expect(await ledgerOf(appId)).toEqual([
			{
				type: "transcription",
				amount: -10_000,
				balanceAfter: 40_000,
				referenceId: transcriptId,
				referenceType: "developer_transcript",
			},
		]);
		const stored = await getTranscript(appId, transcriptId);
		expect(stored).toMatchObject({
			status: "complete",
			text: "hello world",
			billedMicroCredits: 10_000,
			reservedMicroCredits: 0,
			durationSeconds: 3600,
		});
	});

	it("never holds more than the balance when transcripts start together", async () => {
		const appId = await makeApp(1_000);
		const transcriptIds = await Promise.all(
			Array.from({ length: 10 }, () => makeTranscript(appId)),
		);

		const results = await Promise.all(
			transcriptIds.map((transcriptId) =>
				reserveTranscriptCredits({ transcriptId, durationSeconds: 144 }),
			),
		);

		expect(
			results.filter((result) => result.state === "reserved"),
		).toHaveLength(2);
		expect(
			results.filter((result) => result.state === "insufficient_credits"),
		).toHaveLength(8);
		expect(await getAvailableTranscriptBalance(appId)).toBe(200);
		expect(await balanceOf(appId)).toBe(1_000);
		expect(await ledgerOf(appId)).toEqual([]);
	});

	it("never spends more than the balance when settles and other usage race", async () => {
		const appId = await makeApp(25_000);
		const transcriptIds = await Promise.all(
			Array.from({ length: 6 }, () => makeTranscript(appId)),
		);

		const settles = transcriptIds.map((transcriptId) =>
			settle(transcriptId, 3600),
		);
		const otherUsage = Array.from({ length: 4 }, (_, index) =>
			database().transaction((tx) =>
				debitDeveloperUsage(tx, {
					appId,
					microCredits: 5_000,
					type: "video_create",
					referenceId: `video-${index}-${appId}`,
					referenceType: "developer_video",
				}),
			),
		);
		const [settled, debited] = await Promise.all([
			Promise.all(settles),
			Promise.all(otherUsage),
		]);

		const balance = await balanceOf(appId);
		const ledger = await ledgerOf(appId);
		const spent = ledger.reduce((sum, row) => sum - row.amount, 0);
		expect(balance).not.toBeNull();
		expect(balance).toBeGreaterThanOrEqual(0);
		expect(spent).toBe(25_000 - (balance ?? 0));
		expect(spent).toBeLessThanOrEqual(25_000);

		const completed = settled.filter((result) => result.state === "complete");
		const refused = settled.filter(
			(result) => result.state === "insufficient_credits",
		);
		expect(completed.length + refused.length).toBe(6);
		expect(ledger.filter((row) => row.type === "transcription")).toHaveLength(
			completed.length,
		);
		expect(ledger.filter((row) => row.type === "video_create")).toHaveLength(
			debited.filter((result) => result.state === "debited").length,
		);

		for (const [index, transcriptId] of transcriptIds.entries()) {
			const stored = await getTranscript(appId, transcriptId);
			if (settled[index]?.state === "complete") {
				expect(stored).toMatchObject({
					status: "complete",
					text: "hello world",
				});
			} else {
				expect(stored).toMatchObject({
					status: "error",
					errorCode: "insufficient_credits",
					text: null,
					billedMicroCredits: 0,
				});
			}
		}
	});

	it("never lets racing video debits make a held transcript's settle fail", async () => {
		for (let round = 0; round < 8; round++) {
			const appId = await makeApp(20_000);
			const transcriptId = await makeTranscript(appId);
			expect(
				await reserveTranscriptCredits({ transcriptId, durationSeconds: 3600 }),
			).toEqual({ state: "reserved", reservedMicroCredits: 10_000 });

			const videoDebits = Array.from({ length: 8 }, (_, index) =>
				database().transaction((tx) =>
					debitDeveloperUsage(tx, {
						appId,
						microCredits: 5_000,
						type: "video_create",
						referenceId: `video-${index}-${appId}`,
						referenceType: "developer_video",
					}),
				),
			);
			const [settled, debited] = await Promise.all([
				settle(transcriptId, 3600),
				Promise.all(videoDebits),
			]);

			expect(settled).toEqual({
				state: "complete",
				chargedMicroCredits: 10_000,
				alreadySettled: false,
			});
			expect(
				debited.filter((result) => result.state === "debited"),
			).toHaveLength(2);
			expect(
				debited.filter((result) => result.state === "insufficient"),
			).toHaveLength(6);
			expect(await balanceOf(appId)).toBe(0);
			expect(await getTranscript(appId, transcriptId)).toMatchObject({
				status: "complete",
				billedMicroCredits: 10_000,
				reservedMicroCredits: 0,
			});
		}
	});

	it("never charges a transcript more than its hold", async () => {
		const appId = await makeApp(50_000);
		const transcriptId = await makeTranscript(appId);
		await reserveTranscriptCredits({ transcriptId, durationSeconds: 3600 });

		expect(await settle(transcriptId, 7200)).toMatchObject({
			state: "complete",
			chargedMicroCredits: 10_000,
		});
		expect(await balanceOf(appId)).toBe(40_000);
	});

	it("withholds the text and charges nothing when the balance ran out", async () => {
		const appId = await makeApp(9_999);
		const transcriptId = await makeTranscript(appId);

		expect(await settle(transcriptId, 3600)).toEqual({
			state: "insufficient_credits",
		});
		expect(await balanceOf(appId)).toBe(9_999);
		expect(await ledgerOf(appId)).toEqual([]);
		expect(await getTranscript(appId, transcriptId)).toMatchObject({
			status: "error",
			errorCode: "insufficient_credits",
			text: null,
		});
	});

	it("creates one transcript and starts one job for a repeated request", async () => {
		const appId = await makeApp(100_000);
		const idempotencyKey = `retry-${id()}`;

		const results = await Promise.all(
			Array.from({ length: 6 }, () =>
				createTranscriptFromUrl(appId, { url: URL_A, idempotencyKey }, guards),
			),
		);

		expect(results.every((result) => result.ok)).toBe(true);
		expect(
			new Set(results.map((result) => result.ok && result.transcript.id)).size,
		).toBe(1);
		const { transcripts } = await listTranscripts(appId, { limit: 10 });
		expect(transcripts).toHaveLength(1);
		expect(transcripts[0]).toMatchObject({
			status: "queued",
			sourceUrl: URL_A,
		});
		expect(fixture.start).toHaveBeenCalledTimes(1);

		expect(
			await createTranscriptFromUrl(
				appId,
				{ url: "https://media.example.com/other.mp3", idempotencyKey },
				guards,
			),
		).toMatchObject({ ok: false, status: 409 });
	});

	it("refuses to start below the minimum and when holds use the balance", async () => {
		const empty = await makeApp(999);
		expect(
			await createTranscriptFromUrl(empty, { url: URL_A }, guards),
		).toMatchObject({ ok: false, status: 402 });

		const held = await makeApp(10_500);
		const running = await makeTranscript(held);
		expect(
			(
				await reserveTranscriptCredits({
					transcriptId: running,
					durationSeconds: 3600,
				})
			).state,
		).toBe("reserved");
		expect(
			await createTranscriptFromUrl(held, { url: URL_A }, guards),
		).toMatchObject({ ok: false, status: 402 });
		expect(fixture.start).not.toHaveBeenCalled();
	});

	it("starts an uploaded transcript once and scopes it to its app", async () => {
		const appId = await makeApp(100_000);
		const other = await makeApp(100_000);
		const created = await createTranscriptUpload(appId, {
			fileName: "weekly.m4a",
			contentLength: 2048,
		});
		if (!created.ok) throw new Error("create failed");
		const transcriptId = created.transcript.id;

		expect(await startTranscriptUpload(appId, transcriptId)).toMatchObject({
			ok: false,
			status: 409,
			code: "upload_not_found",
		});

		fixture.objectSize = 4096;
		expect(await startTranscriptUpload(other, transcriptId)).toMatchObject({
			ok: false,
			status: 404,
		});
		const started = await Promise.all(
			Array.from({ length: 5 }, () =>
				startTranscriptUpload(appId, transcriptId),
			),
		);
		expect(started.every((result) => result.ok)).toBe(true);
		expect(fixture.start).toHaveBeenCalledTimes(1);
		expect(await getTranscript(appId, transcriptId)).toMatchObject({
			status: "queued",
			sourceBytes: 4096,
		});
		expect(await getTranscript(other, transcriptId)).toBeNull();
	});

	it("pages newest first by offset and by cursor across equal timestamps", async () => {
		const appId = await makeApp(0);
		const sameInstant = new Date("2026-11-11T12:00:00.000Z");
		const older = new Date("2026-11-10T12:00:00.000Z");
		const ids = ["a", "b", "c", "d"].map(
			(suffix) => `${id().slice(0, 13)}_${suffix}`,
		);
		for (const transcriptId of ids.slice(0, 3)) {
			await database().insert(developerTranscripts).values({
				id: transcriptId,
				appId,
				status: "complete",
				sourceType: "upload",
				text: "x",
				createdAt: sameInstant,
			});
		}
		await database()
			.insert(developerTranscripts)
			.values({
				id: ids[3] as string,
				appId,
				status: "complete",
				sourceType: "upload",
				externalUserId: "user-1",
				createdAt: older,
			});
		const expected = [...ids.slice(0, 3)]
			.sort()
			.reverse()
			.concat(ids[3] as string);

		const byOffset: string[] = [];
		for (let offset = 0; ; offset += 2) {
			const page = await listTranscripts(appId, { limit: 2, offset });
			byOffset.push(...page.transcripts.map((row) => row.id));
			if (!page.hasMore) break;
		}
		expect(byOffset).toEqual(expected);

		const byCursor: string[] = [];
		let cursor: { createdAt: Date; id: string } | null = null;
		for (let page = 0; page < 10; page++) {
			const result = await listTranscripts(appId, { limit: 1, cursor });
			const row = result.transcripts[0];
			if (!row) break;
			byCursor.push(row.id);
			cursor = { createdAt: row.createdAt, id: row.id };
			if (!result.hasMore) break;
		}
		expect(byCursor).toEqual(expected);

		expect(
			(
				await listTranscripts(appId, { limit: 10, userId: "user-1" })
			).transcripts.map((row) => row.id),
		).toEqual([ids[3]]);
		expect(byOffset.length).toBe(4);
	});

	it("stores a long transcript and removes it on delete", async () => {
		const appId = await makeApp(100_000);
		const other = await makeApp(0);
		const transcriptId = await makeTranscript(appId, {
			metadata: { team: "core", nested: { ok: true } },
		});
		const longText = "Speech to text keeps every word. ".repeat(12_000);

		const result = await settleTranscript({
			transcriptId,
			durationSeconds: 4 * 3600,
			language: "en",
			text: longText,
			wordCount: 72_000,
			resultKey: `developer/${appId}/transcripts/${transcriptId}/result.json`,
		});
		expect(result).toMatchObject({
			state: "complete",
			chargedMicroCredits: 40_000,
		});

		const stored = await getTranscript(appId, transcriptId);
		expect(stored?.text).toBe(longText);
		expect(stored?.metadata).toEqual({ team: "core", nested: { ok: true } });

		expect(await deleteTranscript(other, transcriptId)).toMatchObject({
			ok: false,
			status: 404,
		});
		expect(await deleteTranscript(appId, transcriptId)).toEqual({ ok: true });
		expect(await getTranscript(appId, transcriptId)).toBeNull();
		const [row] = await database()
			.select({ text: developerTranscripts.text })
			.from(developerTranscripts)
			.where(
				and(
					eq(developerTranscripts.id, transcriptId),
					eq(developerTranscripts.appId, appId),
				),
			);
		expect(row?.text).toBeNull();
		expect(await balanceOf(appId)).toBe(60_000);
	});

	it("lets exactly one run claim a transcript and only that run fail it", async () => {
		const appId = await makeApp(10_000);
		const transcriptId = await makeTranscript(appId, {
			status: "queued",
			runId: "run-current",
		});
		const runs = ["run-old-1", "run-old-2", "run-current", "run-old-3"];

		const claims = await Promise.all(
			[...runs, ...runs].map((runId) =>
				claimTranscriptRun(transcriptId, runId),
			),
		);
		expect(claims).toEqual(
			[...runs, ...runs].map((runId) => runId === "run-current"),
		);

		expect(
			(await failTranscriptRun(transcriptId, "run-old-1", "timed_out", "x"))
				.failed,
		).toBe(false);
		expect(await getTranscript(appId, transcriptId)).toMatchObject({
			status: "processing",
			errorCode: null,
		});
		expect(
			(await failTranscriptRun(transcriptId, "run-current", "no_speech", "x"))
				.failed,
		).toBe(true);
		expect(await getTranscript(appId, transcriptId)).toMatchObject({
			status: "error",
			errorCode: "no_speech",
		});
	});

	it("expires only stale unfinished transcripts", async () => {
		const appId = await makeApp(0);
		const now = new Date();
		const hoursAgo = (hours: number) =>
			new Date(now.getTime() - hours * 60 * 60 * 1000);
		const seed = (
			status: "uploading" | "processing" | "complete",
			age: number,
		) => makeTranscript(appId, { status, updatedAt: hoursAgo(age) });

		const oldUpload = await seed("uploading", 30);
		const newUpload = await seed("uploading", 2);
		const stuckJob = await seed("processing", 8);
		const liveJob = await seed("processing", 1);
		const done = await seed("complete", 400);

		await expireStaleTranscripts(now);

		const statusOf = async (transcriptId: string) => {
			const stored = await getTranscript(appId, transcriptId);
			return [stored?.status, stored?.errorCode];
		};
		expect(await statusOf(oldUpload)).toEqual(["error", "upload_expired"]);
		expect(await statusOf(newUpload)).toEqual(["uploading", null]);
		expect(await statusOf(stuckJob)).toEqual(["error", "timed_out"]);
		expect(await statusOf(liveJob)).toEqual(["processing", null]);
		expect(await statusOf(done)).toEqual(["complete", null]);
	});
});
