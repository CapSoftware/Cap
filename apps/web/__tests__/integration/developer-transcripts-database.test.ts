import { randomUUID } from "node:crypto";
import {
	developerApps,
	developerCreditAccounts,
	developerCreditTransactions,
	developerTranscripts,
	developerVideos,
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
	copies: [] as string[],
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
	developerObjectUrl: async (key: string) => `https://internal.example/${key}`,
	copyDeveloperObject: async (_from: string, to: string) => {
		fixture.copies.push(to);
	},
	getDeveloperObjectText: async () => null,
	deleteDeveloperObjects: async () => {},
}));
vi.mock("@/workflows/process-developer-video", () => ({
	processDeveloperVideoWorkflow: "developer-video-workflow",
}));
vi.mock("@/lib/media-client", () => ({
	isMediaServerConfigured: () => false,
}));
vi.mock("@/lib/media-container", () => ({
	urlIsSelfContainedMedia: async () => true,
}));
vi.mock("@/lib/developer-video-storage", () => ({}));
vi.mock("@/lib/server", () => ({ runPromise: async () => undefined }));
vi.mock("@cap/web-backend", () => ({
	provideOptionalAuth: <T>(effect: T) => effect,
	S3Buckets: {},
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
const { completeDeveloperVideoUpload, createDeveloperVideoUpload } =
	await import("@/lib/developer-video-upload");
const { getSpeechUsage } = await import("@/lib/developer-transcript-usage");
const { transcriptUploadExpiry } = await import("@/lib/developer-transcripts");
const { availableBalance } = await import("@/lib/infra-balance");
const { getInfraAppStanding, getInfraUploadAdmission } = await import(
	"@/lib/infra-standing"
);
const { getAppStorageUsage } = await import("@/lib/infra-storage");
const { chargeStorageDay } = await import("@/lib/infra-storage-billing");
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

const accountOf = async (appId: string) => {
	const [account] = await database()
		.select({ id: developerCreditAccounts.id })
		.from(developerCreditAccounts)
		.where(eq(developerCreditAccounts.appId, appId));
	if (!account) throw new Error("Fixture app has no credit account.");
	return account.id;
};

const setBalance = (appId: string, balanceMicroCredits: number) =>
	database()
		.update(developerCreditAccounts)
		.set({ balanceMicroCredits })
		.where(eq(developerCreditAccounts.appId, appId));

async function makeStoredVideo(
	appId: string,
	overrides: Partial<typeof developerVideos.$inferInsert> = {},
) {
	const videoId = id();
	await database()
		.insert(developerVideos)
		.values({
			id: videoId,
			appId,
			name: "Stored fixture",
			status: "ready",
			duration: 7200,
			width: 1920,
			height: 1080,
			maxResolutionTier: "1080p",
			...overrides,
		});
	return videoId;
}

const videoOf = async (videoId: string) => {
	const [video] = await database()
		.select()
		.from(developerVideos)
		.where(eq(developerVideos.id, videoId));
	return video;
};

const chargeStorage = async (appId: string, day: string) =>
	chargeStorageDay({
		appId,
		accountId: await accountOf(appId),
		usage: await getAppStorageUsage(appId),
		dateKey: day,
		now: new Date(),
	});

const videoStarts = () =>
	fixture.start.mock.calls.filter(
		([workflow]) => workflow === "developer-video-workflow",
	);

const STORAGE_DAY_OF_TWO_HOURS = 340;
const ADMISSION_FOR_TWO_HOURS = 2_380;

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
		fixture.copies = [];
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

	it("filters by the exact bytes of the user ID", async () => {
		const appId = await makeApp(100_000);
		const alice = await makeTranscript(appId, { externalUserId: "alice" });
		await makeTranscript(appId, { externalUserId: "bob" });
		await makeTranscript(appId, { externalUserId: null });

		const listedFor = async (userId: string) =>
			(await listTranscripts(appId, { limit: 10, userId })).transcripts.map(
				(row) => row.id,
			);

		expect(await listedFor("alice")).toEqual([alice]);
		for (const other of [
			"ALICE",
			"Alice",
			"àlice",
			"Alicé",
			"alice ",
			"alic",
			"",
		]) {
			expect([other, await listedFor(other)]).toEqual([other, []]);
		}
	});

	it("keeps user IDs that differ only by case or accent apart", async () => {
		const appId = await makeApp(100_000);
		const ids = ["k9Xq", "K9xQ", "k9xq", "élan", "elan"];
		const created = new Map<string, string>();
		for (const userId of ids) {
			created.set(
				userId,
				await makeTranscript(appId, { externalUserId: userId }),
			);
		}

		for (const userId of ids) {
			const { transcripts, hasMore } = await listTranscripts(appId, {
				limit: 1,
				userId,
			});
			expect(transcripts.map((row) => row.id)).toEqual([created.get(userId)]);
			expect(hasMore).toBe(false);
		}
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

	it("takes credit held for a running transcript out of the shared balance and upload admission", async () => {
		const appId = await makeApp(ADMISSION_FOR_TWO_HOURS + 10_000);
		await makeStoredVideo(appId);
		const transcriptId = await makeTranscript(appId);

		expect(await availableBalance(appId)).toBe(
			ADMISSION_FOR_TWO_HOURS + 10_000,
		);
		expect((await getInfraUploadAdmission(appId)).allowed).toBe(true);

		await reserveTranscriptCredits({ transcriptId, durationSeconds: 3601 });

		expect(await availableBalance(appId)).toBe(ADMISSION_FOR_TWO_HOURS - 2);
		expect(await getInfraUploadAdmission(appId)).toMatchObject({
			allowed: false,
			reason: "insufficient_credits",
			balanceMicroCredits: ADMISSION_FOR_TWO_HOURS - 2,
			requiredMicroCredits: ADMISSION_FOR_TWO_HOURS,
			shortfallMicroCredits: 2,
		});

		await settle(transcriptId, 3601);
		expect(await availableBalance(appId)).toBe(ADMISSION_FOR_TWO_HOURS - 2);
		expect(await balanceOf(appId)).toBe(ADMISSION_FOR_TWO_HOURS - 2);
	});

	it("leaves held credit alone in the daily storage charge, and the held transcript still settles", async () => {
		const appId = await makeApp(10_100);
		await makeStoredVideo(appId);
		const transcriptId = await makeTranscript(appId);
		await reserveTranscriptCredits({ transcriptId, durationSeconds: 3600 });

		expect(await chargeStorage(appId, "2026-11-10")).toMatchObject({
			state: "billed",
			owedMicroCredits: STORAGE_DAY_OF_TWO_HOURS,
			chargedMicroCredits: 100,
			balanceMicroCredits: 10_000,
			fellShort: true,
		});
		expect(await balanceOf(appId)).toBe(10_000);

		expect(await settle(transcriptId, 3600)).toMatchObject({
			state: "complete",
			chargedMicroCredits: 10_000,
		});
		expect(await balanceOf(appId)).toBe(0);
	});

	it("never lets the storage charge and a settle racing each other overdraw or fail the settle", async () => {
		for (let round = 0; round < 6; round++) {
			const appId = await makeApp(10_200);
			await makeStoredVideo(appId);
			const transcriptId = await makeTranscript(appId);
			await reserveTranscriptCredits({ transcriptId, durationSeconds: 3600 });

			const [settled, charged] = await Promise.all([
				settle(transcriptId, 3600),
				chargeStorage(appId, "2026-11-10"),
			]);

			expect(settled).toMatchObject({
				state: "complete",
				chargedMicroCredits: 10_000,
			});
			expect(charged).toMatchObject({
				state: "billed",
				chargedMicroCredits: 200,
			});
			expect(await balanceOf(appId)).toBe(0);
		}
	});

	it("refuses a new transcript for an app that is out of credit and says how much to add", async () => {
		const appId = await makeApp(100);
		await makeStoredVideo(appId);
		expect(await chargeStorage(appId, "2026-11-10")).toMatchObject({
			state: "billed",
			chargedMicroCredits: 100,
			fellShort: true,
		});
		expect((await getInfraAppStanding(appId)).state).toBe("grace");
		await setBalance(appId, 1_200);
		expect((await getInfraAppStanding(appId)).state).toBe("active");
		await setBalance(appId, 150);

		expect(
			await createTranscriptFromUrl(appId, { url: URL_A }, guards),
		).toMatchObject({
			ok: false,
			status: 402,
			code: "out_of_credit",
			message:
				"This app is out of credit, so new transcripts are blocked. Add at least $0.01 to start transcripts again.",
		});
		const upload = await createTranscriptUpload(appId, {
			fileName: "standup.mp3",
			contentLength: 1_000,
		});
		expect(upload).toMatchObject({ ok: false, status: 402 });
		expect(fixture.start).not.toHaveBeenCalled();

		await setBalance(appId, 1_000);
		expect(
			(await createTranscriptFromUrl(appId, { url: URL_A }, guards)).ok,
		).toBe(true);
	});

	it("creates an agent video with a playback id and admits it without charging", async () => {
		const appId = await makeApp(ADMISSION_FOR_TWO_HOURS);
		const created = await createDeveloperVideoUpload(appId, {
			fileName: "demo.mp4",
			contentLength: 5_000_000,
		});
		if (!created.ok) throw new Error("create failed");
		expect(await videoOf(created.video.id)).toMatchObject({
			status: "uploading",
			playbackId: created.video.playbackId,
			maxResolutionTier: "1080p",
			duration: null,
		});
		expect(created.video.playbackId).toMatch(/^[A-Za-z0-9_-]{24}$/);

		fixture.objectSize = 5_000_000;
		const completed = await completeDeveloperVideoUpload(
			appId,
			created.video.id,
			{ durationSeconds: 7200, width: 3840, height: 2160, fps: 30 },
		);

		expect(completed).toMatchObject({
			ok: true,
			video: {
				status: "processing",
				playbackId: created.video.playbackId,
				durationSeconds: 5_000,
				width: 3840,
				height: 2160,
			},
		});
		const stored = await videoOf(created.video.id);
		expect(stored?.s3Key).toBe(fixture.copies[0]);
		expect(stored?.processing?.encodeId).toBeTruthy();
		expect(videoStarts()).toHaveLength(1);
		expect(await balanceOf(appId)).toBe(ADMISSION_FOR_TWO_HOURS);
		expect(await ledgerOf(appId)).toHaveLength(0);
	});

	it("admits a 4K agent upload at the capped price and refuses one the balance cannot store", async () => {
		const appId = await makeApp(ADMISSION_FOR_TWO_HOURS - 1);
		const created = await createDeveloperVideoUpload(appId, {
			fileName: "demo.mp4",
			contentLength: 20_000_000,
		});
		if (!created.ok) throw new Error("create failed");
		fixture.objectSize = 20_000_000;
		const complete = () =>
			completeDeveloperVideoUpload(appId, created.video.id, {
				durationSeconds: 7200,
				width: 3840,
				height: 2160,
			});

		expect(await complete()).toMatchObject({
			ok: false,
			status: 402,
			code: "insufficient_credits",
			shortfallMicroCredits: 1,
		});
		expect(await videoOf(created.video.id)).toMatchObject({
			status: "uploading",
			duration: null,
			processing: null,
		});
		expect(videoStarts()).toHaveLength(0);

		await setBalance(appId, ADMISSION_FOR_TWO_HOURS);
		expect(await complete()).toMatchObject({
			ok: true,
			video: { status: "processing", durationSeconds: 7200 },
		});
		expect(videoStarts()).toHaveLength(1);
		expect(await balanceOf(appId)).toBe(ADMISSION_FOR_TWO_HOURS);
	});

	it("records an agent upload once and starts it once when completions race", async () => {
		for (let round = 0; round < 6; round++) {
			fixture.start.mockClear();
			fixture.copies = [];
			const appId = await makeApp(100_000);
			const created = await createDeveloperVideoUpload(appId, {
				fileName: "demo.mp4",
				contentLength: 1_000_000,
			});
			if (!created.ok) throw new Error("create failed");
			fixture.objectSize = 1_000_000;

			const results = await Promise.all(
				Array.from({ length: 8 }, (_, index) =>
					completeDeveloperVideoUpload(appId, created.video.id, {
						durationSeconds: 60 + index,
					}),
				),
			);

			const stored = await videoOf(created.video.id);
			expect(results.some((result) => result.ok)).toBe(true);
			for (const result of results) {
				if (result.ok) {
					expect(result.video.durationSeconds).toBe(stored?.duration);
				} else {
					expect(result).toMatchObject({
						status: 409,
						code: "completion_in_progress",
					});
				}
			}
			expect(videoStarts()).toHaveLength(1);
			expect(fixture.copies).toContain(stored?.s3Key);
			expect(stored?.status).toBe("processing");
			expect(await balanceOf(appId)).toBe(100_000);
			expect(await ledgerOf(appId)).toHaveLength(0);
		}
	});

	it("reports speech usage that matches the ledger, by UTC month, with holds and without failures", async () => {
		const appId = await makeApp(100_000);
		const now = new Date();
		const monthStart = new Date(
			Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1),
		);

		const first = await makeTranscript(appId);
		const second = await makeTranscript(appId);
		await settle(first, 1800.07);
		await settle(second, 300.096);
		const deleted = await makeTranscript(appId);
		await settle(deleted, 60);
		await deleteTranscript(appId, deleted);

		const failed = await makeTranscript(appId);
		await failTranscriptRun(failed, "run-none", "no_audio_track", "x");
		await database()
			.update(developerTranscripts)
			.set({ status: "error", durationSeconds: 7200 })
			.where(eq(developerTranscripts.id, failed));

		await makeTranscript(appId, {
			status: "complete",
			durationSeconds: 3600,
			billedMicroCredits: 10_000,
			completedAt: new Date(monthStart.getTime() - 1000),
		});
		await makeTranscript(appId, {
			status: "complete",
			durationSeconds: 36,
			billedMicroCredits: 100,
			completedAt: monthStart,
		});

		const running = await makeTranscript(appId);
		await reserveTranscriptCredits({
			transcriptId: running,
			durationSeconds: 3600,
		});

		const usage = await getSpeechUsage(appId, now);
		const ledger = await ledgerOf(appId);
		const charged = ledger
			.filter((row) => row.type === "transcription")
			.reduce((total, row) => total - row.amount, 0);

		expect(charged).toBe(5_000 + 833 + 166);
		expect(usage.speech).toMatchObject({
			periodStart: monthStart.toISOString(),
			microCredits: charged + 100,
			transcripts: 4,
		});
		expect(usage.speech.seconds).toBeCloseTo(1800.07 + 300.096 + 60 + 36, 2);
		expect(usage.heldMicroCredits).toBe(10_000);
		expect(usage.availableMicroCredits).toBe(100_000 - charged - 10_000);
		expect(await balanceOf(appId)).toBe(100_000 - charged);

		const lastMonth = await getSpeechUsage(
			appId,
			new Date(monthStart.getTime() - 1000),
		);
		expect(lastMonth.speech.transcripts).toBe(5);
		expect(lastMonth.speech.seconds).toBeCloseTo(
			3600 + 1800.07 + 300.096 + 60 + 36,
			2,
		);
		expect(lastMonth.speech.microCredits).toBe(charged + 100 + 10_000);
	});

	it("refuses a replay with different fields and re-issues the upload URL with a later expiry", async () => {
		const appId = await makeApp(100_000);
		const request = {
			fileName: "standup.mp3",
			contentLength: 2048,
			userId: "user-1",
			metadata: { show: "daily", episode: 7 },
			idempotencyKey: `key-${id()}`,
		};
		const created = await createTranscriptUpload(appId, request);
		if (!created.ok || !created.upload) throw new Error("create failed");

		expect(
			await createTranscriptUpload(appId, { ...request, userId: "user-2" }),
		).toMatchObject({
			ok: false,
			status: 409,
			code: "idempotency_conflict",
			message: "Idempotency key was already used with a different userId",
		});
		expect(
			await createTranscriptUpload(appId, {
				...request,
				metadata: { episode: 8, show: "daily" },
			}),
		).toMatchObject({ ok: false, status: 409 });

		await database()
			.update(developerTranscripts)
			.set({ updatedAt: new Date(Date.now() - 2 * 60 * 60 * 1000) })
			.where(eq(developerTranscripts.id, created.transcript.id));
		const stale = await getTranscript(appId, created.transcript.id);
		if (!stale) throw new Error("missing");
		expect(transcriptUploadExpiry(stale).getTime()).toBeLessThan(Date.now());

		const again = await createTranscriptUpload(appId, {
			...request,
			metadata: { episode: 7, show: "daily" },
		});
		if (!again.ok || !again.upload) throw new Error("replay failed");
		expect(again.transcript.id).toBe(created.transcript.id);
		const fresh = await getTranscript(appId, created.transcript.id);
		if (!fresh) throw new Error("missing");
		expect(transcriptUploadExpiry(fresh).toISOString()).toBe(
			again.upload.expiresAt,
		);
		expect(new Date(again.upload.expiresAt).getTime()).toBeGreaterThan(
			Date.now() + 59 * 60 * 1000,
		);
	});

	it("never reports more available than balance minus holds while a transcript settles", async () => {
		const seen = new Set<number>();
		for (let round = 0; round < 12; round++) {
			const appId = await makeApp(50_000);
			const transcriptId = await makeTranscript(appId);
			await reserveTranscriptCredits({ transcriptId, durationSeconds: 3600 });

			const usages: Awaited<ReturnType<typeof getSpeechUsage>>[] = [];
			let settling = true;
			const readers = Array.from({ length: 6 }, async () => {
				while (settling) usages.push(await getSpeechUsage(appId));
				usages.push(await getSpeechUsage(appId));
			});
			await new Promise((resolve) => setTimeout(resolve, 5));
			const settled = await settle(transcriptId, 3600);
			settling = false;
			await Promise.all(readers);

			expect(settled).toMatchObject({
				state: "complete",
				chargedMicroCredits: 10_000,
			});
			for (const usage of usages) {
				expect(usage.availableMicroCredits).toBe(
					usage.balanceMicroCredits - usage.heldMicroCredits,
				);
				expect(usage.availableMicroCredits).toBe(40_000);
				expect([
					[50_000, 10_000],
					[40_000, 0],
				]).toContainEqual([usage.balanceMicroCredits, usage.heldMicroCredits]);
				seen.add(usage.balanceMicroCredits);
			}
			expect(await getSpeechUsage(appId)).toMatchObject({
				balanceMicroCredits: 40_000,
				heldMicroCredits: 0,
				availableMicroCredits: 40_000,
			});
		}
		expect([...seen].sort()).toEqual([40_000, 50_000]);
	});
});
