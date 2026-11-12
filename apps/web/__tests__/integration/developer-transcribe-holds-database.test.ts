import { randomUUID } from "node:crypto";
import {
	developerApps,
	developerCreditAccounts,
	developerCreditTransactions,
	developerTranscripts,
} from "@cap/database/schema";
import { User } from "@cap/web-domain";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
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
	objects: new Map<string, Uint8Array>(),
	sourceSizes: new Map<string, number>(),
	audioSeconds: new Map<string, number>(),
	extracting: 0,
	maxExtracting: 0,
	extractions: [] as string[],
	sleeps: 0,
	sleepSeconds: 0,
	sourceReads: 0,
	noSpeech: false,
	speechCalls: 0,
}));

vi.mock("@cap/database", () => ({
	db: () => {
		if (!fixture.database) throw new Error("Test database is not connected.");
		return fixture.database;
	},
}));
vi.mock("@cap/env", () => ({
	buildEnv: { NEXT_PUBLIC_IS_CAP: "true" },
	serverEnv: () => ({}),
	NODE_ENV: "production",
}));
vi.mock("workflow", () => ({
	sleep: async (duration: string | number) => {
		fixture.sleeps += 1;
		fixture.sleepSeconds += Number.parseInt(String(duration), 10);
		await new Promise((resolve) => setTimeout(resolve, 15));
	},
	FatalError: class FatalError extends Error {},
	RetryableError: class RetryableError extends Error {},
}));
vi.mock("@/lib/developer-transcript-storage", () => ({
	developerObjectSize: async (key: string) =>
		fixture.sourceSizes.get(key) ?? fixture.objects.get(key)?.length ?? null,
	developerObjectUrl: async (key: string) => `http://storage.test/${key}`,
	getDeveloperObjectText: async (key: string) => {
		const bytes = fixture.objects.get(key);
		return bytes ? new TextDecoder().decode(bytes) : null;
	},
	putDeveloperObject: async (key: string, body: string | Uint8Array) => {
		fixture.objects.set(
			key,
			typeof body === "string" ? new TextEncoder().encode(body) : body,
		);
	},
	putDeveloperObjectFile: async () => {},
	putDeveloperObjectStream: async () => {},
	deleteDeveloperObjects: async (keys: string[]) => {
		for (const key of keys) fixture.objects.delete(key);
	},
}));
vi.mock("@/lib/media-container", () => ({
	urlIsSelfContainedMedia: async () => {
		fixture.sourceReads += 1;
		return true;
	},
}));
vi.mock("@/lib/storage-fetch", () => ({
	fetchStorageUrl: async (url: string) => {
		const bytes = fixture.objects.get(url.slice("http://storage.test/".length));
		return bytes
			? new Response(bytes.slice(), { status: 200 })
			: new Response(null, { status: 404 });
	},
}));
vi.mock("@/lib/mp3-duration", () => ({
	measureMp3DurationSeconds: (audio: Buffer) => audio.readDoubleBE(0),
}));
vi.mock("@/lib/developer-transcript-audio", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("@/lib/developer-transcript-audio")
	>()),
	extractTranscriptAudioBytes: async (sourceUrl: string, limit: number) => {
		const id = sourceUrl.split("/t-").pop() ?? "";
		fixture.extractions.push(id);
		fixture.extracting += 1;
		fixture.maxExtracting = Math.max(fixture.maxExtracting, fixture.extracting);
		await new Promise((resolve) => setTimeout(resolve, 40));
		fixture.extracting -= 1;
		const seconds = fixture.audioSeconds.get(id) ?? 0;
		if (seconds > limit) {
			return { state: "over_limit" as const, reportedSeconds: seconds };
		}
		const audio = Buffer.alloc(64);
		audio.writeDoubleBE(seconds, 0);
		return { state: "ok" as const, audio };
	},
}));
vi.mock("@/lib/developer-transcript-speech", () => ({
	parseTranscriptLanguage: () => "auto",
	transcribeSpeech: async () => {
		fixture.speechCalls += 1;
		await new Promise((resolve) => setTimeout(resolve, 20));
		if (fixture.noSpeech) return { state: "no_speech" as const };
		return {
			state: "ok" as const,
			text: "hello world",
			words: [
				{ text: "hello", start: 0, end: 400, confidence: 0.9 },
				{ text: "world", start: 450, end: 900, confidence: 0.9 },
			],
			language: "en",
			durationSeconds: 1,
		};
	},
}));

const { transcriptionMicroCredits } = await import("@/lib/developer-pricing");
const { developerTranscribeWorkflow } = await import(
	"@/workflows/developer-transcribe"
);

const databaseUrl = process.env.CAP_INFRA_SPEECH_TEST_DATABASE_URL;

const database = () => {
	if (!fixture.database) throw new Error("Test database is not connected.");
	return fixture.database;
};

const id = () => randomUUID().replaceAll("-", "").slice(0, 15);

const FULL_HOLD = 40_000;
const BIG_FILE = 10_000_000;

async function makeApp(balanceMicroCredits: number) {
	const appId = id();
	const ownerId = User.UserId.make(id());
	await database().insert(developerApps).values({
		id: appId,
		ownerId,
		name: "Hold fixture",
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

async function queueUpload(appId: string, bytes: number, audioSeconds: number) {
	const transcriptId = id();
	await database()
		.insert(developerTranscripts)
		.values({
			id: transcriptId,
			appId,
			status: "queued",
			runId: `run-${transcriptId}`,
			sourceType: "upload",
			sourceBytes: bytes,
			queuedAt: new Date(),
		});
	fixture.sourceSizes.set(
		`developer/_uploads/${appId}/t-${transcriptId}`,
		bytes,
	);
	fixture.audioSeconds.set(transcriptId, audioSeconds);
	return transcriptId;
}

const run = (transcriptId: string) =>
	developerTranscribeWorkflow({ transcriptId, runId: `run-${transcriptId}` });

const balanceOf = async (appId: string) => {
	const [account] = await database()
		.select({ balance: developerCreditAccounts.balanceMicroCredits })
		.from(developerCreditAccounts)
		.where(eq(developerCreditAccounts.appId, appId));
	return account?.balance ?? null;
};

const heldBy = async (appId: string) => {
	const [row] = await database()
		.select({
			total: sql<
				string | number
			>`COALESCE(SUM(${developerTranscripts.reservedMicroCredits}), 0)`,
		})
		.from(developerTranscripts)
		.where(
			and(
				eq(developerTranscripts.appId, appId),
				eq(developerTranscripts.status, "processing"),
				isNull(developerTranscripts.deletedAt),
			),
		);
	return Number(row?.total ?? 0);
};

const rowsOf = (ids: string[]) =>
	database()
		.select({
			id: developerTranscripts.id,
			status: developerTranscripts.status,
			errorCode: developerTranscripts.errorCode,
			reserved: developerTranscripts.reservedMicroCredits,
			billed: developerTranscripts.billedMicroCredits,
		})
		.from(developerTranscripts)
		.where(inArray(developerTranscripts.id, ids));

const ledgerCount = async (appId: string) => {
	const rows = await database()
		.select({ id: developerCreditTransactions.id })
		.from(developerCreditTransactions)
		.innerJoin(
			developerCreditAccounts,
			eq(developerCreditTransactions.accountId, developerCreditAccounts.id),
		)
		.where(eq(developerCreditAccounts.appId, appId));
	return rows.length;
};

async function watchingHolds<T>(appId: string, work: () => Promise<T>) {
	let peak = 0;
	let watching = true;
	const watcher = (async () => {
		while (watching) {
			peak = Math.max(peak, await heldBy(appId));
			await new Promise((resolve) => setTimeout(resolve, 2));
		}
	})();
	try {
		return { result: await work(), peak: () => peak };
	} finally {
		watching = false;
		await watcher;
	}
}

describe.skipIf(!databaseUrl)("transcript holds on a real database", () => {
	let pool: Pool | undefined;

	beforeAll(async () => {
		if (!databaseUrl) throw new Error("Missing isolated test database URL.");
		const url = new URL(databaseUrl);
		if (
			url.protocol !== "mysql:" ||
			!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
			!/^\/cap_speech_[a-z0-9_]+$/.test(url.pathname)
		) {
			throw new Error("Hold tests require a session-scoped local database.");
		}
		pool = createPool({ uri: databaseUrl, connectionLimit: 24 });
		fixture.database = drizzle(pool);
		await database().select().from(developerTranscripts).limit(1);
	});

	afterAll(async () => {
		await pool?.end();
		fixture.database = undefined;
	});

	beforeEach(() => {
		fixture.objects = new Map();
		fixture.sourceSizes = new Map();
		fixture.audioSeconds = new Map();
		fixture.extracting = 0;
		fixture.maxExtracting = 0;
		fixture.extractions = [];
		fixture.sleeps = 0;
		fixture.sleepSeconds = 0;
		fixture.sourceReads = 0;
		fixture.noSpeech = false;
		fixture.speechCalls = 0;
	});

	it("bills audio with no speech once each when transcripts and repeat deliveries race", async () => {
		fixture.noSpeech = true;
		const balance = 3 * FULL_HOLD;
		const appId = await makeApp(balance);
		const ids = await Promise.all(
			Array.from({ length: 8 }, () => queueUpload(appId, BIG_FILE, 600)),
		);
		const cost = transcriptionMicroCredits(600);

		const { peak } = await watchingHolds(appId, () =>
			Promise.all([...ids, ...ids, ...ids].map(run)),
		);
		await Promise.all(ids.map(run));

		const rows = await database()
			.select({
				status: developerTranscripts.status,
				text: developerTranscripts.text,
				wordCount: developerTranscripts.wordCount,
				billed: developerTranscripts.billedMicroCredits,
				reserved: developerTranscripts.reservedMicroCredits,
				errorCode: developerTranscripts.errorCode,
			})
			.from(developerTranscripts)
			.where(inArray(developerTranscripts.id, ids));
		expect(rows).toEqual(
			Array.from({ length: 8 }, () => ({
				status: "complete",
				text: "",
				wordCount: 0,
				billed: cost,
				reserved: 0,
				errorCode: null,
			})),
		);
		expect(fixture.speechCalls).toBeGreaterThanOrEqual(8);
		expect(peak()).toBeLessThanOrEqual(balance);
		expect(await ledgerCount(appId)).toBe(8);
		expect(await balanceOf(appId)).toBe(balance - 8 * cost);
		expect(await heldBy(appId)).toBe(0);
	});

	it("never holds more than the balance when transcripts start together, and completes them all", async () => {
		for (let round = 0; round < 3; round++) {
			fixture.extractions = [];
			fixture.maxExtracting = 0;
			fixture.sleeps = 0;
			const balance = 2 * FULL_HOLD + 20_000;
			const appId = await makeApp(balance);
			const ids = await Promise.all(
				Array.from({ length: 12 }, () => queueUpload(appId, BIG_FILE, 60)),
			);

			const { peak } = await watchingHolds(appId, () =>
				Promise.all(ids.map(run)),
			);

			const rows = await rowsOf(ids);
			expect(rows.map((row) => row.status)).toEqual(
				Array.from({ length: 12 }, () => "complete"),
			);
			expect(rows.every((row) => row.reserved === 0)).toBe(true);
			expect(peak()).toBeGreaterThanOrEqual(FULL_HOLD);
			expect(peak()).toBeLessThanOrEqual(balance);
			expect(fixture.maxExtracting).toBeLessThanOrEqual(2);
			expect(fixture.extractions).toHaveLength(12);
			expect(fixture.sleeps).toBeGreaterThan(0);
			expect(await balanceOf(appId)).toBe(
				balance - 12 * transcriptionMicroCredits(60),
			);
			expect(await ledgerCount(appId)).toBe(12);
			expect(await heldBy(appId)).toBe(0);
		}
	});

	it("runs as many at once as their holds allow when the files are small", async () => {
		const balance = 20_000;
		const appId = await makeApp(balance);
		const ids = await Promise.all(
			Array.from({ length: 12 }, () => queueUpload(appId, 1_000_000, 30)),
		);

		const { peak } = await watchingHolds(appId, () =>
			Promise.all(ids.map(run)),
		);

		const rows = await rowsOf(ids);
		expect(rows.every((row) => row.status === "complete")).toBe(true);
		expect(peak()).toBeLessThanOrEqual(balance);
		expect(fixture.maxExtracting).toBeLessThanOrEqual(3);
		expect(await balanceOf(appId)).toBe(
			balance - 12 * transcriptionMicroCredits(30),
		);
	});

	it("does no work at all for an app that cannot cover one hold", async () => {
		const appId = await makeApp(1_000);
		const ids = await Promise.all(
			Array.from({ length: 6 }, () => queueUpload(appId, BIG_FILE, 3 * 3600)),
		);

		await Promise.all(ids.map(run));

		const rows = await rowsOf(ids);
		expect(rows.map((row) => row.errorCode)).toEqual(
			Array.from({ length: 6 }, () => "insufficient_credits"),
		);
		expect(fixture.extractions).toEqual([]);
		expect(fixture.sourceReads).toBe(0);
		expect(fixture.sleeps).toBe(0);
		expect(await balanceOf(appId)).toBe(1_000);
		expect(await ledgerCount(appId)).toBe(0);
		expect(await heldBy(appId)).toBe(0);
	});

	it("stops charging at the balance when the real total does not fit, and never goes negative", async () => {
		for (let round = 0; round < 3; round++) {
			fixture.extractions = [];
			const hold = transcriptionMicroCredits(2_000);
			const cost = transcriptionMicroCredits(1_900);
			const balance = 2 * hold + 500;
			const appId = await makeApp(balance);
			const ids = await Promise.all(
				Array.from({ length: 5 }, () => queueUpload(appId, 1_000_000, 1_900)),
			);

			const { peak } = await watchingHolds(appId, () =>
				Promise.all(ids.map(run)),
			);

			const rows = await rowsOf(ids);
			const complete = rows.filter((row) => row.status === "complete");
			const refused = rows.filter(
				(row) => row.errorCode === "insufficient_credits",
			);
			expect(complete).toHaveLength(2);
			expect(refused).toHaveLength(3);
			expect(fixture.extractions).toHaveLength(2);
			expect(peak()).toBeLessThanOrEqual(balance);
			expect(await balanceOf(appId)).toBe(balance - 2 * cost);
			expect(await heldBy(appId)).toBe(0);
		}
	});

	it("lets one go first when every running transcript needs a bigger hold at once", async () => {
		const each = transcriptionMicroCredits(720);
		const appId = await makeApp(2 * each + 500);
		const ids = await Promise.all(
			Array.from({ length: 4 }, () => queueUpload(appId, 150_000, 720)),
		);

		const { peak } = await watchingHolds(appId, () =>
			Promise.all(ids.map((transcriptId) => run(transcriptId))),
		);

		const rows = await rowsOf(ids);
		expect(peak()).toBeLessThanOrEqual(2 * each + 500);
		expect(rows.filter((row) => row.status === "complete")).toHaveLength(2);
		expect(
			rows.filter((row) => row.errorCode === "insufficient_credits"),
		).toHaveLength(2);
		expect(fixture.sleepSeconds).toBeLessThan(15 * 60);
		expect(await balanceOf(appId)).toBe(500);
		expect(await heldBy(appId)).toBe(0);
	});

	it("raises a hold for audio longer than the file size suggests only while the balance covers it", async () => {
		const appId = await makeApp(FULL_HOLD + 1_000);
		const sparse = await queueUpload(appId, 100_000, 3 * 3600);
		const second = await queueUpload(appId, 100_000, 3 * 3600);

		await Promise.all([run(sparse), run(second)]);

		const rows = await rowsOf([sparse, second]);
		expect(rows.filter((row) => row.status === "complete")).toHaveLength(1);
		expect(
			rows.filter((row) => row.errorCode === "insufficient_credits"),
		).toHaveLength(1);
		expect(await balanceOf(appId)).toBe(
			FULL_HOLD + 1_000 - transcriptionMicroCredits(3 * 3600),
		);
		expect(await heldBy(appId)).toBe(0);
	});
});
