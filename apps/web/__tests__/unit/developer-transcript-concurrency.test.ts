import { beforeEach, describe, expect, it, vi } from "vitest";

const context = vi.hoisted(() => ({
	fake: null as null | {
		db: unknown;
		rows: (table: object) => Record<string, unknown>[];
		seed: (
			table: object,
			row: Record<string, unknown>,
		) => Record<string, unknown>;
		reset: () => void;
	},
	ids: 0,
	speechConfigured: true,
	hosted: true,
	start: vi.fn(),
	objectSize: null as number | null,
	deleted: [] as string[],
	presigned: [] as { key: string; contentLength: number }[],
	failSigning: false,
	onDelete: null as null | (() => Promise<void>),
}));

vi.mock("@cap/database", async () => {
	const schema = await import("@cap/database/schema");
	const { createFakeDatabase } = await import("./developer-transcript-fake-db");
	const fake = createFakeDatabase(
		new Map<object, () => Record<string, unknown>>([
			[
				schema.developerTranscripts,
				() => ({
					externalUserId: null,
					name: "Untitled",
					sourceUrl: null,
					resultKey: null,
					sourceBytes: null,
					durationSeconds: null,
					requestedLanguage: null,
					language: null,
					text: null,
					wordCount: null,
					reservedMicroCredits: 0,
					billedMicroCredits: 0,
					errorCode: null,
					errorMessage: null,
					metadata: null,
					runId: null,
					queuedAt: null,
					startedAt: null,
					completedAt: null,
					deletedAt: null,
				}),
			],
		]),
	);
	context.fake = fake;
	return { db: () => fake.db };
});

vi.mock("@cap/database/helpers", () => ({
	nanoId: () => {
		context.ids += 1;
		return `generated-${context.ids}`;
	},
	nanoIdLength: 15,
}));

vi.mock("@cap/env", () => ({
	buildEnv: { NEXT_PUBLIC_IS_CAP: "true" },
	NODE_ENV: "production",
}));

vi.mock("@/lib/infra-access", () => ({
	canUseInfra: (email: string | null | undefined) =>
		!context.hosted || email === "richie@cap.so",
}));

vi.mock("workflow/api", () => ({ start: context.start }));

vi.mock("@/workflows/developer-transcribe", () => ({
	developerTranscribeWorkflow: "developer-transcribe-workflow",
}));

vi.mock("@/lib/developer-transcript-speech", () => ({
	isSpeechConfigured: () => context.speechConfigured,
	parseTranscriptLanguage: (value: string | null | undefined) => {
		if (!value || value === "auto") return "auto";
		return ["en", "de"].includes(value) ? value : null;
	},
}));

vi.mock("@/lib/developer-transcript-storage", () => ({
	presignDeveloperUpload: async (key: string, contentLength: number) => {
		if (context.failSigning) throw new Error("signing unavailable");
		context.presigned.push({ key, contentLength });
		return `https://storage.example/${key}?signed=${context.presigned.length}`;
	},
	developerObjectSize: async () => context.objectSize,
	getDeveloperObjectText: async () => null,
	deleteDeveloperObjects: async (keys: string[]) => {
		context.deleted.push(...keys);
		const hook = context.onDelete;
		context.onDelete = null;
		await hook?.();
	},
}));

import {
	developerApps,
	developerCreditAccounts,
	developerTranscripts,
	users,
} from "@cap/database/schema";
import {
	createTranscriptFromUrl,
	createTranscriptUpload,
	deleteTranscript,
	startTranscriptUpload,
} from "@/lib/developer-transcript-store";
import { TRANSCRIPT_MAX_CONCURRENT } from "@/lib/developer-transcripts";
import { isBlockedS3Endpoint } from "@/lib/s3-endpoint-policy";

const URL_A = "https://media.example.com/standup.mp3";

const dns =
	(table: Record<string, string[]>) =>
	(url: string): Promise<boolean> =>
		isBlockedS3Endpoint(url, async (hostname) => table[hostname] ?? []);

const guards = {
	isBlocked: dns({
		"media.example.com": ["93.184.216.34"],
		"rebind.example.com": ["10.0.0.9"],
	}),
};

const fake = () => {
	if (!context.fake) throw new Error("Fake database is not ready");
	return context.fake;
};

const transcripts = () => fake().rows(developerTranscripts);
const setBalance = (balanceMicroCredits: number) => {
	const account = fake().rows(developerCreditAccounts)[0];
	if (account) account.balanceMicroCredits = balanceMicroCredits;
};

const fromUrl = (url = URL_A, idempotencyKey?: string, appId = "app-1") =>
	createTranscriptFromUrl(appId, { url, idempotencyKey }, guards);

beforeEach(() => {
	fake().reset();
	context.ids = 0;
	context.speechConfigured = true;
	context.hosted = true;
	context.start.mockReset();
	context.start.mockResolvedValue(undefined);
	context.objectSize = null;
	context.deleted = [];
	context.presigned = [];
	context.failSigning = false;
	context.onDelete = null;
	fake().seed(developerCreditAccounts, {
		id: "account-1",
		appId: "app-1",
		balanceMicroCredits: 100_000,
	});
	fake().seed(users, { id: "owner-1", email: "richie@cap.so" });
	fake().seed(users, { id: "owner-9", email: "someone@example.com" });
	for (const id of ["app-1", "app-2", "app-without-credits"]) {
		fake().seed(developerApps, { id, ownerId: "owner-1", deletedAt: null });
	}
	fake().seed(developerApps, {
		id: "app-outside-preview",
		ownerId: "owner-9",
		deletedAt: null,
	});
	fake().seed(developerCreditAccounts, {
		id: "account-9",
		appId: "app-outside-preview",
		balanceMicroCredits: 100_000,
	});
});

const CEILING = {
	ok: false,
	status: 429,
	code: "too_many_transcripts",
	message: "This app already has 20 transcripts queued or processing",
};

const seedRunning = (
	count: number,
	row: Record<string, unknown> = {},
	prefix = "running",
) => {
	for (let index = 0; index < count; index++) {
		fake().seed(developerTranscripts, {
			id: `${prefix}-${index}`,
			appId: "app-1",
			status: "processing",
			sourceType: "upload",
			...row,
		});
	}
};

const waitingUpload = async () => {
	const created = await createTranscriptUpload("app-1", {
		fileName: "a.mp3",
		contentLength: 1024,
	});
	if (!created.ok) throw new Error("create failed");
	context.objectSize = 1024;
	return created.transcript.id;
};

describe("the ceiling on transcripts running at once", () => {
	it("is 20", () => {
		expect(TRANSCRIPT_MAX_CONCURRENT).toBe(20);
	});

	it("refuses a URL transcript once 20 are queued or processing, without storing or starting it", async () => {
		seedRunning(12);
		seedRunning(8, { status: "queued" }, "queued");

		const result = await fromUrl();

		expect(result).toMatchObject(CEILING);
		expect(transcripts()).toHaveLength(20);
		expect(context.start).not.toHaveBeenCalled();
	});

	it("admits the twentieth and refuses the twenty-first", async () => {
		seedRunning(19);

		expect((await fromUrl()).ok).toBe(true);
		expect(await fromUrl(URL_A)).toMatchObject(CEILING);
		expect(context.start).toHaveBeenCalledTimes(1);
	});

	it("admits exactly 20 of 30 created at the same moment", async () => {
		const results = await Promise.all(
			Array.from({ length: 30 }, (_, index) =>
				fromUrl(`https://media.example.com/clip-${index}.mp3`),
			),
		);

		expect(results.filter((result) => result.ok)).toHaveLength(20);
		expect(
			results.filter((result) => !result.ok && result.status === 429),
		).toHaveLength(10);
		expect(transcripts()).toHaveLength(20);
		expect(context.start).toHaveBeenCalledTimes(20);
	});

	it("does not count finished, failed, waiting or other apps' transcripts", async () => {
		seedRunning(30, { status: "complete" }, "complete");
		seedRunning(30, { status: "error" }, "error");
		seedRunning(30, { status: "uploading" }, "uploading");
		seedRunning(30, { appId: "app-2" }, "other");

		expect((await fromUrl()).ok).toBe(true);
	});

	it("frees a slot when a queued transcript is deleted, and keeps it for one deleted while processing", async () => {
		seedRunning(20, { status: "queued" }, "queued");
		expect(await fromUrl()).toMatchObject(CEILING);

		await deleteTranscript("app-1", "queued-0");
		expect((await fromUrl()).ok).toBe(true);

		fake().reset();
		fake().seed(developerCreditAccounts, {
			id: "account-1",
			appId: "app-1",
			balanceMicroCredits: 100_000,
		});
		fake().seed(users, { id: "owner-1", email: "richie@cap.so" });
		fake().seed(developerApps, {
			id: "app-1",
			ownerId: "owner-1",
			deletedAt: null,
		});
		seedRunning(20);
		await deleteTranscript("app-1", "running-0");
		expect(await fromUrl()).toMatchObject(CEILING);
	});

	it("frees a slot when a transcript finishes or fails", async () => {
		seedRunning(20);
		expect(await fromUrl()).toMatchObject(CEILING);

		const first = transcripts().find((row) => row.id === "running-0");
		if (first) first.status = "complete";
		expect((await fromUrl()).ok).toBe(true);

		const second = transcripts().find((row) => row.id === "running-1");
		if (second) second.status = "error";
		expect((await fromUrl(URL_A)).ok).toBe(true);
	});

	it("still returns the same transcript for a repeated request at the ceiling", async () => {
		seedRunning(19);
		const first = await fromUrl(URL_A, "retry-key-1");
		if (!first.ok) throw new Error("create failed");

		const again = await fromUrl(URL_A, "retry-key-1");

		expect(again).toMatchObject({
			ok: true,
			transcript: { id: first.transcript.id },
		});
		expect(context.start).toHaveBeenCalledTimes(1);
	});

	it("lets a file be created at the ceiling but refuses to start it", async () => {
		seedRunning(20);

		const id = await waitingUpload();
		const refused = await startTranscriptUpload("app-1", id);

		expect(refused).toMatchObject(CEILING);
		expect(transcripts().find((row) => row.id === id)).toMatchObject({
			status: "uploading",
			runId: null,
			startedAt: null,
		});
		expect(context.start).not.toHaveBeenCalled();

		const running = transcripts().find((row) => row.id === "running-0");
		if (running) running.status = "complete";
		expect((await startTranscriptUpload("app-1", id)).ok).toBe(true);
		expect(context.start).toHaveBeenCalledTimes(1);
	});

	it("starts exactly as many uploads as there are slots when they are started together", async () => {
		seedRunning(17);
		const ids = [];
		for (let index = 0; index < 6; index++) ids.push(await waitingUpload());

		const results = await Promise.all(
			ids.map((id) => startTranscriptUpload("app-1", id)),
		);

		expect(results.filter((result) => result.ok)).toHaveLength(3);
		expect(
			results.filter((result) => !result.ok && result.status === 429),
		).toHaveLength(3);
		expect(context.start).toHaveBeenCalledTimes(3);
	});

	it("returns a transcript that already started unchanged at the ceiling", async () => {
		seedRunning(19);
		const id = await waitingUpload();
		expect((await startTranscriptUpload("app-1", id)).ok).toBe(true);

		expect(await startTranscriptUpload("app-1", id)).toMatchObject({
			ok: true,
			transcript: { id, status: "queued" },
		});
	});

	it("answers the credit refusal before the ceiling", async () => {
		seedRunning(20);
		setBalance(0);

		expect(await fromUrl()).toMatchObject({ ok: false, status: 402 });
	});

	it("admits both copies of a repeated request that race each other at the last slot", async () => {
		seedRunning(19);

		const [first, second] = await Promise.all([
			fromUrl(URL_A, "race-key-01"),
			fromUrl(URL_A, "race-key-01"),
		]);

		expect(first.ok && second.ok).toBe(true);
		if (!first.ok || !second.ok) throw new Error("create failed");
		expect(second.transcript.id).toBe(first.transcript.id);
		expect(transcripts()).toHaveLength(20);
		expect(context.start).toHaveBeenCalledTimes(1);
	});

	it("still refuses a different request that races for the last slot", async () => {
		seedRunning(19);

		const results = await Promise.all([
			fromUrl(URL_A, "race-key-01"),
			fromUrl(URL_A, "race-key-02"),
		]);

		expect(results.filter((result) => result.ok)).toHaveLength(1);
		expect(results.filter((result) => !result.ok)).toEqual([
			expect.objectContaining(CEILING),
		]);
	});

	it("answers both copies of a start sent twice at the last slot, and starts it once", async () => {
		seedRunning(19);
		const id = await waitingUpload();

		const results = await Promise.all([
			startTranscriptUpload("app-1", id),
			startTranscriptUpload("app-1", id),
		]);

		expect(results.every((result) => result.ok)).toBe(true);
		expect(context.start).toHaveBeenCalledTimes(1);
	});
});
