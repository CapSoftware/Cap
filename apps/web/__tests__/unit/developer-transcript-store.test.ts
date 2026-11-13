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
	developerCreditTransactions,
	developerTranscripts,
	users,
} from "@cap/database/schema";
import {
	createTranscriptFromUrl,
	createTranscriptUpload,
	deleteTranscript,
	expireStaleTranscripts,
	getTranscript,
	isTranscriptIdempotencyKey,
	listConsoleTranscripts,
	listTranscripts,
	startTranscriptUpload,
	transcriptIdForIdempotencyKey,
	validateTranscriptOptions,
} from "@/lib/developer-transcript-store";
import {
	transcriptHasNoSpeech,
	transcriptUploadExpiry,
} from "@/lib/developer-transcripts";
import { isBlockedS3Endpoint } from "@/lib/s3-endpoint-policy";

const URL_A = "https://media.example.com/standup.mp3";
const URL_B = "https://media.example.com/other.mp3";

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

describe("preview access", () => {
	it("refuses to spend credits for an owner outside the preview", async () => {
		const fromUrlResult = await createTranscriptFromUrl(
			"app-outside-preview",
			{ url: URL_A },
			guards,
		);
		const uploadResult = await createTranscriptUpload("app-outside-preview", {
			fileName: "a.mp3",
			contentLength: 1024,
		});

		for (const result of [fromUrlResult, uploadResult]) {
			expect(result).toMatchObject({
				ok: false,
				status: 403,
				code: "infra_not_available",
			});
		}
		expect(transcripts()).toHaveLength(0);
		expect(context.start).not.toHaveBeenCalled();
		expect(context.presigned).toHaveLength(0);
	});

	it("refuses to start an upload once the owner leaves the preview", async () => {
		const created = await createTranscriptUpload("app-1", {
			fileName: "a.mp3",
			contentLength: 1024,
		});
		if (!created.ok) throw new Error("create failed");
		context.objectSize = 1024;
		const app = fake()
			.rows(developerApps)
			.find((row) => row.id === "app-1");
		if (app) app.ownerId = "owner-9";

		expect(
			await startTranscriptUpload("app-1", created.transcript.id),
		).toMatchObject({ ok: false, status: 403 });
		expect(context.start).not.toHaveBeenCalled();
	});

	it("is open to every account on a self-hosted install", async () => {
		context.hosted = false;
		const result = await createTranscriptFromUrl(
			"app-outside-preview",
			{ url: URL_A },
			guards,
		);
		expect(result.ok).toBe(true);
	});
});

describe("creating a transcript from a URL", () => {
	it("stores a queued transcript and starts it once", async () => {
		const result = await fromUrl();

		expect(result.ok).toBe(true);
		expect(transcripts()).toHaveLength(1);
		expect(transcripts()[0]).toMatchObject({
			id: "generated-1",
			appId: "app-1",
			status: "queued",
			sourceType: "url",
			sourceUrl: URL_A,
			name: "standup",
			s3Key: "developer/_uploads/app-1/t-generated-1",
		});
		expect(transcripts()[0]?.startedAt).toBeInstanceOf(Date);
		expect(context.start).toHaveBeenCalledTimes(1);
		expect(context.start).toHaveBeenCalledWith(
			"developer-transcribe-workflow",
			[{ transcriptId: "generated-1", runId: transcripts()[0]?.runId }],
		);
		expect(transcripts()[0]?.runId).toEqual(expect.any(String));
	});

	it.each([
		["http://127.0.0.1/a.mp3", "url_not_public"],
		["http://localhost/a.mp3", "url_not_public"],
		["http://169.254.169.254/latest/meta-data/", "url_not_public"],
		["http://10.1.2.3/a.mp3", "url_not_public"],
		["http://[::1]/a.mp3", "url_not_public"],
		["https://rebind.example.com/a.mp3", "url_not_public"],
		["https://unresolvable.example.com/a.mp3", "url_not_public"],
		["file:///etc/passwd", "invalid_url"],
		["ftp://media.example.com/a.mp3", "invalid_url"],
		["https://user:pass@media.example.com/a.mp3", "invalid_url"],
		["https://media.example.com:8443/a.mp3", "invalid_url"],
		["not a url", "invalid_url"],
		["", "invalid_url"],
		[`https://media.example.com/${"a".repeat(2100)}`, "invalid_url"],
	])("refuses %s without storing or starting anything", async (url, code) => {
		const result = await fromUrl(url);

		expect(result).toMatchObject({ ok: false, status: 400, code });
		expect(transcripts()).toHaveLength(0);
		expect(context.start).not.toHaveBeenCalled();
	});

	it("answers 402 below the minimum balance", async () => {
		setBalance(999);
		const result = await fromUrl();

		expect(result).toMatchObject({
			ok: false,
			status: 402,
			code: "insufficient_credits",
		});
		expect(transcripts()).toHaveLength(0);
		expect(context.start).not.toHaveBeenCalled();
	});

	it("says how much to add below the minimum balance", async () => {
		setBalance(400);
		expect(await fromUrl()).toMatchObject({
			ok: false,
			status: 402,
			code: "insufficient_credits",
			message:
				"Starting a transcript needs $0.01 of available credit. Add at least $0.01.",
		});
	});

	it("answers 402 with the amount to add when the app is not in good standing", async () => {
		const SHORT_SINCE = new Date(Date.now() - 60 * 60 * 1000).toISOString();
		setBalance(2_500);
		fake().seed(developerCreditTransactions, {
			id: "charge-1",
			accountId: "account-1",
			type: "storage_daily",
			amountMicroCredits: 0,
			balanceAfterMicroCredits: 0,
			referenceId: "2026-11-10",
			referenceType: "storage_day",
			metadata: {
				snapshotDate: "2026-11-10",
				owedMicroCredits: 4_000,
				chargedMicroCredits: 0,
				shortSince: SHORT_SINCE,
			},
		});

		const result = await fromUrl();

		expect(result).toMatchObject({
			ok: false,
			status: 402,
			code: "out_of_credit",
			message:
				"This app is out of credit, so new transcripts are blocked. Add at least $0.02 to start transcripts again.",
		});
		expect(transcripts()).toHaveLength(0);
		expect(context.start).not.toHaveBeenCalled();

		setBalance(4_000);
		expect((await fromUrl()).ok).toBe(true);
	});

	it("still refuses an app whose grace period has run out", async () => {
		const SHORT_SINCE = new Date(
			Date.now() - 8 * 24 * 60 * 60 * 1000,
		).toISOString();
		setBalance(3_999);
		fake().seed(developerCreditTransactions, {
			id: "charge-1",
			accountId: "account-1",
			type: "storage_daily",
			amountMicroCredits: 0,
			balanceAfterMicroCredits: 0,
			referenceId: "2026-11-10",
			referenceType: "storage_day",
			metadata: {
				snapshotDate: "2026-11-10",
				owedMicroCredits: 4_000,
				chargedMicroCredits: 0,
				shortSince: SHORT_SINCE,
			},
		});

		expect(await fromUrl()).toMatchObject({
			ok: false,
			status: 402,
			code: "out_of_credit",
		});
	});

	it("answers 402 when running transcripts already hold the balance", async () => {
		setBalance(10_500);
		fake().seed(developerTranscripts, {
			id: "running",
			appId: "app-1",
			status: "processing",
			sourceType: "url",
			reservedMicroCredits: 10_000,
		});

		expect(await fromUrl()).toMatchObject({ ok: false, status: 402 });
	});

	it("answers 402 for an app without a credit account", async () => {
		expect(
			await fromUrl(URL_A, undefined, "app-without-credits"),
		).toMatchObject({
			ok: false,
			status: 402,
		});
	});

	it("answers 503 when speech is not configured", async () => {
		context.speechConfigured = false;
		const result = await fromUrl();

		expect(result).toMatchObject({
			ok: false,
			status: 503,
			code: "speech_unavailable",
		});
		expect(transcripts()).toHaveLength(0);
	});

	it("returns the same transcript for a repeated idempotency key", async () => {
		const first = await fromUrl(URL_A, "retry-key-0001");
		const second = await fromUrl(URL_A, "retry-key-0001");

		expect(first.ok && second.ok && first.transcript.id).toBe(
			second.ok && second.transcript.id,
		);
		expect(transcripts()).toHaveLength(1);
		expect(context.start).toHaveBeenCalledTimes(1);
	});

	it("starts once when the same request arrives twice at once", async () => {
		const results = await Promise.all([
			fromUrl(URL_A, "retry-key-0001"),
			fromUrl(URL_A, "retry-key-0001"),
			fromUrl(URL_A, "retry-key-0001"),
		]);

		expect(results.every((result) => result.ok)).toBe(true);
		expect(transcripts()).toHaveLength(1);
		expect(context.start).toHaveBeenCalledTimes(1);
	});

	it("still returns a repeated request after the balance is spent", async () => {
		await fromUrl(URL_A, "retry-key-0001");
		setBalance(0);

		const replay = await fromUrl(URL_A, "retry-key-0001");
		expect(replay.ok).toBe(true);
		expect(context.start).toHaveBeenCalledTimes(1);
	});

	it("rejects an idempotency key reused for a different URL", async () => {
		await fromUrl(URL_A, "retry-key-0001");
		const result = await fromUrl(URL_B, "retry-key-0001");

		expect(result).toMatchObject({
			ok: false,
			status: 409,
			code: "idempotency_conflict",
		});
		expect(transcripts()).toHaveLength(1);
		expect(context.start).toHaveBeenCalledTimes(1);
	});

	it.each([
		["name", { name: "Renamed" }],
		["language", { language: "de" }],
		["userId", { userId: "user-2" }],
		["metadata", { metadata: { episode: 8 } }],
	])(
		"refuses a replay with a different %s and names it",
		async (field, change) => {
			const original = {
				url: URL_A,
				name: "Standup",
				language: "en",
				userId: "user-1",
				metadata: { episode: 7, show: "daily" },
				idempotencyKey: "retry-key-0001",
			};
			const first = await createTranscriptFromUrl("app-1", original, guards);
			if (!first.ok) throw new Error("create failed");

			const replay = await createTranscriptFromUrl(
				"app-1",
				{ ...original, ...change },
				guards,
			);

			expect(replay).toMatchObject({
				ok: false,
				status: 409,
				code: "idempotency_conflict",
				message: `Idempotency key was already used with a different ${field}`,
			});
			expect(transcripts()).toHaveLength(1);
			expect(transcripts()[0]).toMatchObject({
				name: "Standup",
				requestedLanguage: "en",
				externalUserId: "user-1",
			});
			expect(context.start).toHaveBeenCalledTimes(1);
		},
	);

	it("accepts a replay that sends the same request, whatever the key order of its metadata", async () => {
		const original = {
			url: URL_A,
			name: " Standup ",
			language: "en",
			userId: "user-1",
			metadata: { show: "daily", nested: { b: 2, a: 1 }, episode: 7 },
			idempotencyKey: "retry-key-0001",
		};
		const first = await createTranscriptFromUrl("app-1", original, guards);
		const replay = await createTranscriptFromUrl(
			"app-1",
			{
				...original,
				name: "Standup",
				metadata: { episode: 7, nested: { a: 1, b: 2 }, show: "daily" },
			},
			guards,
		);

		if (!first.ok || !replay.ok) throw new Error("replay refused");
		expect(replay.transcript.id).toBe(first.transcript.id);
		expect(transcripts()).toHaveLength(1);
	});

	describe("two creates with one key that both miss the first lookup", () => {
		const original = {
			url: URL_A,
			name: "Standup",
			language: "en",
			userId: "user-1",
			metadata: { episode: 7 },
			idempotencyKey: "race-key-0001",
		};
		const racing = async (loser: Record<string, unknown>) => {
			const winners: Awaited<ReturnType<typeof createTranscriptFromUrl>>[] = [];
			const lost = await createTranscriptFromUrl(
				"app-1",
				{ ...original, ...loser },
				{
					isBlocked: async (url) => {
						if (winners.length === 0) {
							winners.push(
								await createTranscriptFromUrl("app-1", original, guards),
							);
						}
						return guards.isBlocked(url);
					},
				},
			);
			const [winner] = winners;
			if (!winner) throw new Error("The winner never ran");
			return { winner, lost };
		};

		it.each([
			["name", { name: "Renamed" }],
			["language", { language: "de" }],
			["userId", { userId: "user-2" }],
			["metadata", { metadata: { episode: 8 } }],
			["url", { url: URL_B }],
		])("refuses the loser when its %s differs", async (field, change) => {
			const { winner, lost } = await racing(change);

			expect(winner).toMatchObject({ ok: true });
			expect(lost).toMatchObject({
				ok: false,
				status: 409,
				code: "idempotency_conflict",
				message: `Idempotency key was already used with a different ${field}`,
			});
			expect(transcripts()).toHaveLength(1);
			expect(transcripts()[0]).toMatchObject({
				name: "Standup",
				requestedLanguage: "en",
				externalUserId: "user-1",
				metadata: { episode: 7 },
				sourceUrl: URL_A,
			});
			expect(context.start).toHaveBeenCalledTimes(1);
		});

		it("returns the winner's transcript to a loser that sent the same request", async () => {
			const { winner, lost } = await racing({});

			if (!winner.ok || !lost.ok) throw new Error("refused");
			expect(lost.transcript.id).toBe(winner.transcript.id);
			expect(transcripts()).toHaveLength(1);
			expect(context.start).toHaveBeenCalledTimes(1);
		});

		it("refuses a loser whose winner was already deleted", async () => {
			let done = false;
			const lost = await createTranscriptFromUrl("app-1", original, {
				isBlocked: async (url) => {
					if (!done) {
						done = true;
						const first = await createTranscriptFromUrl(
							"app-1",
							original,
							guards,
						);
						if (!first.ok) throw new Error("create failed");
						await deleteTranscript("app-1", first.transcript.id);
					}
					return guards.isBlocked(url);
				},
			});

			expect(lost).toMatchObject({
				ok: false,
				status: 409,
				message: "Idempotency key belongs to a transcript that was deleted",
			});
			expect(context.start).toHaveBeenCalledTimes(1);
		});

		it("lets exactly one of several different requests sent together through", async () => {
			const results = await Promise.all(
				["Alpha", "Beta", "Gamma", "Delta"].map((name) =>
					createTranscriptFromUrl("app-1", { ...original, name }, guards),
				),
			);

			const accepted = results.filter((result) => result.ok);
			expect(accepted).toHaveLength(1);
			for (const result of results) {
				if (result.ok) continue;
				expect(result).toMatchObject({
					status: 409,
					message: "Idempotency key was already used with a different name",
				});
			}
			expect(transcripts()).toHaveLength(1);
			const winner = accepted[0];
			expect(winner?.ok && winner.transcript.name).toBe(transcripts()[0]?.name);
			expect(context.start).toHaveBeenCalledTimes(1);
		});
	});

	it("names the URL when a key is reused for a different one", async () => {
		await fromUrl(URL_A, "retry-key-0001");
		expect(await fromUrl(URL_B, "retry-key-0001")).toMatchObject({
			status: 409,
			code: "idempotency_conflict",
			message: "Idempotency key was already used with a different url",
		});
	});

	it("lists the supported codes when the language is not one of them", async () => {
		const result = await createTranscriptFromUrl(
			"app-1",
			{ url: URL_A, language: "en-US" },
			guards,
		);
		expect(result).toMatchObject({
			ok: false,
			status: 400,
			code: "invalid_language",
		});
		if (result.ok) throw new Error("accepted");
		expect(result.hint).toContain('"auto"');
		expect(result.hint).toContain("en, es, fr, de");
		expect(result.hint).toContain("he");
	});

	it("rejects an idempotency key whose transcript was deleted", async () => {
		const created = await fromUrl(URL_A, "retry-key-0001");
		if (!created.ok) throw new Error("create failed");
		await deleteTranscript("app-1", created.transcript.id);

		expect(await fromUrl(URL_A, "retry-key-0001")).toMatchObject({
			ok: false,
			status: 409,
			code: "idempotency_conflict",
		});
		expect(context.start).toHaveBeenCalledTimes(1);
	});

	it("keeps the same key separate between apps", async () => {
		fake().seed(developerCreditAccounts, {
			id: "account-2",
			appId: "app-2",
			balanceMicroCredits: 100_000,
		});
		const first = await fromUrl(URL_A, "retry-key-0001", "app-1");
		const second = await fromUrl(URL_A, "retry-key-0001", "app-2");

		expect(first.ok && second.ok).toBe(true);
		expect(transcriptIdForIdempotencyKey("app-1", "retry-key-0001")).not.toBe(
			transcriptIdForIdempotencyKey("app-2", "retry-key-0001"),
		);
		expect(transcripts()).toHaveLength(2);
	});

	it("leaves nothing behind when the job cannot be started", async () => {
		context.start.mockRejectedValueOnce(new Error("queue unavailable"));
		const failed = await fromUrl(URL_A, "retry-key-0001");

		expect(failed).toMatchObject({ ok: false, status: 503 });
		expect(transcripts()).toHaveLength(0);

		const retried = await fromUrl(URL_A, "retry-key-0001");
		expect(retried.ok).toBe(true);
		expect(transcripts()).toHaveLength(1);
		expect(context.start).toHaveBeenCalledTimes(2);
	});
});

describe("creating a transcript from an upload", () => {
	const upload = (contentLength = 1024, idempotencyKey?: string) =>
		createTranscriptUpload("app-1", {
			fileName: "weekly sync.m4a",
			contentLength,
			idempotencyKey,
		});

	it("waits for the file and does not start anything yet", async () => {
		const result = await upload();
		if (!result.ok) throw new Error("create failed");

		expect(result.transcript).toMatchObject({
			status: "uploading",
			sourceType: "upload",
			name: "weekly sync",
			sourceBytes: 1024,
		});
		expect(result.upload).toMatchObject({
			method: "PUT",
			headers: { "Content-Length": "1024" },
		});
		expect(context.presigned).toEqual([
			{
				key: "developer/_uploads/app-1/t-generated-1",
				contentLength: 1024,
			},
		]);
		expect(context.start).not.toHaveBeenCalled();
	});

	it.each([0, -1, 1.5, Number.NaN, 2 * 1024 * 1024 * 1024 + 1])(
		"rejects the size %s",
		async (contentLength) => {
			expect(await upload(contentLength)).toMatchObject({
				ok: false,
				status: 400,
				code: "invalid_content_length",
			});
			expect(transcripts()).toHaveLength(0);
		},
	);

	it("accepts a file of exactly 2 GB", async () => {
		expect((await upload(2 * 1024 * 1024 * 1024)).ok).toBe(true);
	});

	it("answers 402 below the minimum balance", async () => {
		setBalance(0);
		expect(await upload()).toMatchObject({ ok: false, status: 402 });
		expect(context.presigned).toHaveLength(0);
	});

	it("re-issues the upload URL for a repeated idempotency key", async () => {
		const first = await upload(1024, "upload-key-0001");
		const second = await upload(1024, "upload-key-0001");

		expect(first.ok && second.ok && first.transcript.id).toBe(
			second.ok && second.transcript.id,
		);
		expect(transcripts()).toHaveLength(1);
		expect(second.ok && second.upload?.url).not.toBe(
			first.ok && first.upload?.url,
		);
	});

	it.each([
		["name", { name: "Renamed" }],
		["name", { fileName: "other.mp3" }],
		["language", { language: "auto" }],
		["userId", { userId: "user-2" }],
		["metadata", { metadata: { a: 2 } }],
	])("refuses an upload replay with a different %s", async (field, change) => {
		const original = {
			fileName: "standup.mp3",
			contentLength: 2048,
			language: "en",
			userId: "user-1",
			metadata: { a: 1 },
			idempotencyKey: "upload-key-0001",
		};
		const first = await createTranscriptUpload("app-1", original);
		if (!first.ok) throw new Error("create failed");

		expect(
			await createTranscriptUpload("app-1", { ...original, ...change }),
		).toMatchObject({
			ok: false,
			status: 409,
			code: "idempotency_conflict",
			message: `Idempotency key was already used with a different ${field}`,
		});
		expect(transcripts()).toHaveLength(1);
	});

	it("moves the upload expiry forward when a replay issues a new URL", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		try {
			vi.setSystemTime(new Date("2026-11-12T14:28:41.400Z"));
			const first = await upload(1024, "upload-key-0002");
			if (!first.ok || !first.upload) throw new Error("create failed");
			expect(first.upload.expiresAt).toBe("2026-11-12T15:28:41.000Z");
			expect(transcriptUploadExpiry(first.transcript).toISOString()).toBe(
				first.upload.expiresAt,
			);

			vi.setSystemTime(new Date("2026-11-12T15:40:00.000Z"));
			const again = await upload(1024, "upload-key-0002");
			if (!again.ok || !again.upload) throw new Error("replay failed");
			expect(again.upload.expiresAt).toBe("2026-11-12T16:40:00.000Z");
			expect(again.upload.url).not.toBe(first.upload.url);

			const stored = await getTranscript("app-1", first.transcript.id);
			if (!stored) throw new Error("missing");
			expect(transcriptUploadExpiry(stored).toISOString()).toBe(
				"2026-11-12T16:40:00.000Z",
			);
		} finally {
			vi.useRealTimers();
		}
	});

	it("leaves the upload expiry alone when a new URL cannot be issued", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		try {
			vi.setSystemTime(new Date("2026-11-12T14:28:41.400Z"));
			const first = await upload(1024, "upload-key-0004");
			if (!first.ok || !first.upload) throw new Error("create failed");

			vi.setSystemTime(new Date("2026-11-12T15:10:00.000Z"));
			context.failSigning = true;
			await expect(upload(1024, "upload-key-0004")).rejects.toThrow(
				"signing unavailable",
			);

			const stored = await getTranscript("app-1", first.transcript.id);
			if (!stored) throw new Error("missing");
			expect(transcriptUploadExpiry(stored).toISOString()).toBe(
				first.upload.expiresAt,
			);
		} finally {
			vi.useRealTimers();
		}
	});

	it("tells a caller whose upload URL expired how to get a new one", async () => {
		const created = await upload(1024, "upload-key-0003");
		if (!created.ok) throw new Error("create failed");

		const started = await startTranscriptUpload("app-1", created.transcript.id);

		expect(started).toMatchObject({
			ok: false,
			status: 409,
			code: "upload_not_found",
		});
		if (started.ok) throw new Error("started");
		expect(started.hint).toContain(
			"repeat the create request with the same Idempotency-Key",
		);
	});

	it("rejects an idempotency key reused for a different file size", async () => {
		await upload(1024, "upload-key-0001");
		expect(await upload(2048, "upload-key-0001")).toMatchObject({
			ok: false,
			status: 409,
			code: "idempotency_conflict",
		});
	});

	it("returns no upload URL once the transcript has started", async () => {
		const created = await upload(1024, "upload-key-0001");
		if (!created.ok) throw new Error("create failed");
		context.objectSize = 1024;
		await startTranscriptUpload("app-1", created.transcript.id);

		const replay = await upload(1024, "upload-key-0001");
		expect(replay.ok && replay.upload).toBeNull();
		expect(replay.ok && replay.transcript.status).toBe("queued");
	});
});

describe("starting an uploaded transcript", () => {
	const created = async () => {
		const result = await createTranscriptUpload("app-1", {
			fileName: "a.mp3",
			contentLength: 1024,
		});
		if (!result.ok) throw new Error("create failed");
		return result.transcript.id;
	};

	it("refuses to start before the file exists", async () => {
		const id = await created();
		expect(await startTranscriptUpload("app-1", id)).toMatchObject({
			ok: false,
			status: 409,
			code: "upload_not_found",
		});
		expect(context.start).not.toHaveBeenCalled();
		expect(transcripts()[0]?.status).toBe("uploading");
	});

	it("uses the stored size, not the size the client declared", async () => {
		const id = await created();
		context.objectSize = 4096;
		const result = await startTranscriptUpload("app-1", id);

		expect(result.ok && result.transcript.status).toBe("queued");
		expect(transcripts()[0]?.sourceBytes).toBe(4096);
		expect(context.start).toHaveBeenCalledTimes(1);
	});

	it("rejects and removes a stored file over 2 GB", async () => {
		const id = await created();
		context.objectSize = 2 * 1024 * 1024 * 1024 + 1;

		expect(await startTranscriptUpload("app-1", id)).toMatchObject({
			ok: false,
			status: 400,
			code: "file_too_large",
		});
		expect(context.deleted).toEqual([`developer/_uploads/app-1/t-${id}`]);
		expect(context.start).not.toHaveBeenCalled();
	});

	it("starts once however many times it is called", async () => {
		const id = await created();
		context.objectSize = 1024;
		await Promise.all([
			startTranscriptUpload("app-1", id),
			startTranscriptUpload("app-1", id),
		]);
		await startTranscriptUpload("app-1", id);

		expect(context.start).toHaveBeenCalledTimes(1);
	});

	it("answers 402 when the balance was spent before starting", async () => {
		const id = await created();
		context.objectSize = 1024;
		setBalance(0);

		expect(await startTranscriptUpload("app-1", id)).toMatchObject({
			ok: false,
			status: 402,
		});
		expect(context.start).not.toHaveBeenCalled();
	});

	it("can be retried after the job could not be started", async () => {
		const id = await created();
		context.objectSize = 1024;
		context.start.mockRejectedValueOnce(new Error("queue unavailable"));

		expect(await startTranscriptUpload("app-1", id)).toMatchObject({
			ok: false,
			status: 503,
		});
		expect(transcripts()[0]).toMatchObject({
			status: "uploading",
			startedAt: null,
		});
		expect((await startTranscriptUpload("app-1", id)).ok).toBe(true);
	});

	it("does not start another app's transcript", async () => {
		const id = await created();
		context.objectSize = 1024;
		expect(await startTranscriptUpload("app-2", id)).toMatchObject({
			ok: false,
			status: 404,
		});
		expect(context.start).not.toHaveBeenCalled();
	});
});

describe("reading and listing", () => {
	const seed = (id: string, overrides: Record<string, unknown> = {}) =>
		fake().seed(developerTranscripts, {
			id,
			appId: "app-1",
			status: "complete",
			sourceType: "upload",
			text: `text of ${id}`,
			...overrides,
		});

	it("never returns another app's transcript", async () => {
		seed("tr-1");
		expect((await getTranscript("app-1", "tr-1"))?.id).toBe("tr-1");
		expect(await getTranscript("app-2", "tr-1")).toBeNull();
	});

	it("lists newest first, a page at a time, without the text", async () => {
		for (const id of ["tr-1", "tr-2", "tr-3", "tr-4", "tr-5"]) seed(id);
		seed("tr-other", { appId: "app-2" });
		seed("tr-deleted", { deletedAt: new Date() });

		const first = await listTranscripts("app-1", { limit: 2 });
		expect(first.transcripts.map((row) => row.id)).toEqual(["tr-5", "tr-4"]);
		expect(first.hasMore).toBe(true);
		expect(first.transcripts[0]).not.toHaveProperty("text");

		const second = await listTranscripts("app-1", { limit: 2, offset: 2 });
		expect(second.transcripts.map((row) => row.id)).toEqual(["tr-3", "tr-2"]);
		expect(second.hasMore).toBe(true);

		const last = await listTranscripts("app-1", { limit: 2, offset: 4 });
		expect(last.transcripts.map((row) => row.id)).toEqual(["tr-1"]);
		expect(last.hasMore).toBe(false);
	});

	it("reports no more pages when the page is exactly full", async () => {
		seed("tr-1");
		seed("tr-2");
		const page = await listTranscripts("app-1", { limit: 2 });
		expect(page.transcripts).toHaveLength(2);
		expect(page.hasMore).toBe(false);
	});

	it("does not call an older transcript silent when it has text but no word count", async () => {
		seed("tr-old-text", { status: "complete", wordCount: 0, text: "hello" });
		seed("tr-silent", { status: "complete", wordCount: 0, text: "" });
		seed("tr-never-set", { status: "complete", wordCount: 0, text: null });

		const { transcripts: listed } = await listTranscripts("app-1", {
			limit: 10,
		});
		const silent = Object.fromEntries(
			listed.map((row) => [row.id, transcriptHasNoSpeech(row)]),
		);

		expect(silent).toEqual({
			"tr-old-text": false,
			"tr-silent": true,
			"tr-never-set": true,
		});
		expect(listed.every((row) => !("text" in row))).toBe(true);

		const { transcripts: shown } = await listConsoleTranscripts("app-1", 10);
		expect(
			Object.fromEntries(
				shown.map((row) => [row.id, transcriptHasNoSpeech(row)]),
			),
		).toEqual({
			"tr-old-text": false,
			"tr-silent": true,
			"tr-never-set": true,
		});
		expect(shown.every((row) => !("text" in row))).toBe(true);
	});

	it("pages by cursor without skipping or repeating", async () => {
		const sameInstant = new Date("2026-11-11T12:00:00.000Z");
		for (const id of ["tr-a", "tr-b", "tr-c"]) {
			seed(id, { createdAt: sameInstant });
		}
		seed("tr-old", { createdAt: new Date("2026-11-10T12:00:00.000Z") });

		const seen: string[] = [];
		let cursor: { createdAt: Date; id: string } | null = null;
		for (let page = 0; page < 10; page++) {
			const result = await listTranscripts("app-1", { limit: 1, cursor });
			const row = result.transcripts[0];
			if (!row) break;
			seen.push(row.id);
			cursor = { createdAt: row.createdAt as Date, id: row.id };
			if (!result.hasMore) break;
		}

		expect(seen).toEqual(["tr-c", "tr-b", "tr-a", "tr-old"]);
	});

	it("filters by user and by status", async () => {
		seed("tr-1", { externalUserId: "user-1" });
		seed("tr-2", { externalUserId: "user-2", status: "error" });
		seed("tr-3", { externalUserId: "user-1", status: "processing" });

		const byUser = await listTranscripts("app-1", {
			limit: 10,
			userId: "user-1",
		});
		expect(byUser.transcripts.map((row) => row.id)).toEqual(["tr-3", "tr-1"]);

		const byStatus = await listTranscripts("app-1", {
			limit: 10,
			status: "error",
		});
		expect(byStatus.transcripts.map((row) => row.id)).toEqual(["tr-2"]);
	});

	it("never treats an empty user filter as no filter", async () => {
		seed("tr-1", { externalUserId: "user-1" });
		seed("tr-2", { externalUserId: null });

		const empty = await listTranscripts("app-1", { limit: 10, userId: "" });
		expect(empty.transcripts).toEqual([]);

		for (const userId of [null, undefined]) {
			const all = await listTranscripts("app-1", { limit: 10, userId });
			expect(all.transcripts.map((row) => row.id).sort()).toEqual([
				"tr-1",
				"tr-2",
			]);
		}
	});
});

describe("deleting", () => {
	it("removes the text and stored files and hides the transcript", async () => {
		fake().seed(developerTranscripts, {
			id: "tr-1",
			appId: "app-1",
			status: "complete",
			sourceType: "upload",
			text: "secret words",
		});

		expect(await deleteTranscript("app-1", "tr-1")).toEqual({ ok: true });
		expect(transcripts()[0]?.text).toBeNull();
		expect(transcripts()[0]?.deletedAt).toBeInstanceOf(Date);
		expect(context.deleted).toEqual([
			"developer/_uploads/app-1/t-tr-1",
			"developer/app-1/transcripts/tr-1/audio.mp3",
			"developer/app-1/transcripts/tr-1/result.json",
		]);
		expect(await getTranscript("app-1", "tr-1")).toBeNull();
		expect(await deleteTranscript("app-1", "tr-1")).toMatchObject({
			ok: false,
			status: 404,
		});
	});

	it("does not delete another app's transcript", async () => {
		fake().seed(developerTranscripts, {
			id: "tr-1",
			appId: "app-1",
			status: "complete",
			sourceType: "upload",
			text: "secret words",
		});

		expect(await deleteTranscript("app-2", "tr-1")).toMatchObject({
			ok: false,
			status: 404,
		});
		expect(transcripts()[0]?.text).toBe("secret words");
		expect(context.deleted).toEqual([]);
	});
});

describe("expiring stale transcripts", () => {
	const at = (iso: string) => new Date(iso);
	const seed = (id: string, status: string, updatedAt: string) =>
		fake().seed(developerTranscripts, {
			id,
			appId: "app-1",
			status,
			sourceType: "upload",
			queuedAt: status === "uploading" ? null : at(updatedAt),
			createdAt: at(updatedAt),
			updatedAt: at(updatedAt),
		});

	it("leaves an upload alone when its URL was renewed while cleanup ran", async () => {
		seed("first-old-upload", "uploading", "2026-11-10T09:00:00Z");
		seed("renewed-upload", "uploading", "2026-11-10T09:00:00Z");
		const now = at("2026-11-11T10:00:00Z");
		context.onDelete = async () => {
			const renewed = transcripts().find((row) => row.id === "renewed-upload");
			if (renewed) renewed.updatedAt = now;
		};

		const result = await expireStaleTranscripts(now);

		expect(result).toEqual({ expired: 1, redispatched: 0 });
		const byId = Object.fromEntries(
			transcripts().map((row) => [row.id, [row.status, row.errorCode]]),
		);
		expect(byId).toEqual({
			"first-old-upload": ["error", "upload_expired"],
			"renewed-upload": ["uploading", null],
		});
		expect(context.deleted.some((key) => key.includes("renewed-upload"))).toBe(
			false,
		);
	});

	it("fails uploads never sent and jobs that never finished", async () => {
		seed("old-upload", "uploading", "2026-11-10T09:00:00Z");
		seed("new-upload", "uploading", "2026-11-11T09:00:00Z");
		seed("stuck-job", "processing", "2026-11-11T03:00:00Z");
		seed("stuck-queue", "queued", "2026-11-11T03:00:00Z");
		seed("live-job", "processing", "2026-11-11T09:30:00Z");
		seed("done", "complete", "2026-11-01T00:00:00Z");

		const result = await expireStaleTranscripts(at("2026-11-11T10:00:00Z"));

		expect(result).toEqual({ expired: 3, redispatched: 0 });
		const byId = Object.fromEntries(
			transcripts().map((row) => [row.id, [row.status, row.errorCode]]),
		);
		expect(byId).toEqual({
			"old-upload": ["error", "upload_expired"],
			"new-upload": ["uploading", null],
			"stuck-job": ["error", "timed_out"],
			"stuck-queue": ["error", "timed_out"],
			"live-job": ["processing", null],
			done: ["complete", null],
		});
		expect(context.deleted).toContain("developer/_uploads/app-1/t-old-upload");
		expect(context.deleted).not.toContain(
			"developer/app-1/transcripts/done/result.json",
		);
	});
});

describe("a transcript that timed out", () => {
	it("releases its hold and charges nothing", async () => {
		setBalance(50_000);
		const stuck = fake().seed(developerTranscripts, {
			id: "stuck-held",
			appId: "app-1",
			status: "processing",
			sourceType: "upload",
			durationSeconds: 3_600,
			reservedMicroCredits: 10_000,
			queuedAt: new Date("2026-11-11T03:00:00Z"),
			createdAt: new Date("2026-11-11T03:00:00Z"),
			updatedAt: new Date("2026-11-11T03:00:00Z"),
		});

		await expireStaleTranscripts(new Date("2026-11-11T10:00:00Z"));

		expect(stuck).toMatchObject({
			status: "error",
			errorCode: "timed_out",
			reservedMicroCredits: 0,
		});
		expect(fake().rows(developerCreditTransactions)).toHaveLength(0);
		expect(fake().rows(developerCreditAccounts)[0]?.balanceMicroCredits).toBe(
			50_000,
		);
	});
});

describe("recovering a job that was claimed but never started", () => {
	const minutesAgo = (minutes: number) =>
		new Date(Date.now() - minutes * 60 * 1000);
	const seedQueued = (id: string, startedAt: Date, sourceType = "upload") =>
		fake().seed(developerTranscripts, {
			id,
			appId: "app-1",
			status: "queued",
			sourceType,
			sourceUrl: sourceType === "url" ? URL_A : null,
			name: sourceType === "url" ? "standup" : "Untitled",
			runId: "run-first",
			queuedAt: startedAt,
			startedAt,
			createdAt: startedAt,
			updatedAt: startedAt,
		});

	it("starts it again when start is called after the claim went stale", async () => {
		seedQueued("stale", minutesAgo(10));
		const result = await startTranscriptUpload("app-1", "stale");

		expect(result.ok).toBe(true);
		expect(context.start).toHaveBeenCalledTimes(1);
		const row = transcripts().find((transcript) => transcript.id === "stale");
		expect(row?.runId).toEqual(expect.any(String));
		expect(row?.runId).not.toBe("run-first");
		expect(context.start).toHaveBeenCalledWith(
			"developer-transcribe-workflow",
			[{ transcriptId: "stale", runId: row?.runId }],
		);
	});

	it("leaves a freshly claimed job alone", async () => {
		seedQueued("fresh", minutesAgo(1));
		await startTranscriptUpload("app-1", "fresh");
		expect(context.start).not.toHaveBeenCalled();
	});

	it("starts it again when the same URL request is repeated", async () => {
		const key = "retry-key-0001";
		seedQueued(
			transcriptIdForIdempotencyKey("app-1", key),
			minutesAgo(10),
			"url",
		);

		const replay = await fromUrl(URL_A, key);
		expect(replay.ok).toBe(true);
		expect(transcripts()).toHaveLength(1);
		expect(context.start).toHaveBeenCalledTimes(1);

		await fromUrl(URL_A, key);
		expect(context.start).toHaveBeenCalledTimes(1);
	});

	it("is picked up by the cleanup job, once", async () => {
		seedQueued("stale", minutesAgo(10));
		seedQueued("fresh", minutesAgo(1));
		fake().seed(developerTranscripts, {
			id: "running",
			appId: "app-1",
			status: "processing",
			sourceType: "upload",
			startedAt: minutesAgo(10),
			createdAt: minutesAgo(10),
			updatedAt: minutesAgo(10),
		});

		expect(await expireStaleTranscripts()).toEqual({
			expired: 0,
			redispatched: 1,
		});
		expect(await expireStaleTranscripts()).toEqual({
			expired: 0,
			redispatched: 0,
		});
		expect(context.start).toHaveBeenCalledTimes(1);
	});
});

describe("queue expiry", () => {
	const hoursAgo = (hours: number) =>
		new Date(Date.now() - hours * 60 * 60 * 1000);

	it("counts from when a job was queued, not from when the upload was created", async () => {
		fake().seed(developerTranscripts, {
			id: "late-start",
			appId: "app-1",
			status: "queued",
			sourceType: "upload",
			createdAt: hoursAgo(7),
			updatedAt: new Date(),
			queuedAt: new Date(),
			startedAt: new Date(),
		});
		fake().seed(developerTranscripts, {
			id: "long-queued",
			appId: "app-1",
			status: "queued",
			sourceType: "upload",
			createdAt: hoursAgo(7),
			updatedAt: new Date(),
			queuedAt: hoursAgo(7),
			startedAt: new Date(),
		});

		await expireStaleTranscripts();

		const status = (id: string) =>
			transcripts().find((row) => row.id === id)?.status;
		expect(status("late-start")).toBe("queued");
		expect(status("long-queued")).toBe("error");
	});

	it("records the first queue time once and keeps it across restarts", async () => {
		const created = await createTranscriptUpload("app-1", {
			fileName: "a.mp3",
			contentLength: 1024,
		});
		if (!created.ok) throw new Error("create failed");
		expect(transcripts()[0]?.queuedAt).toBeNull();

		context.objectSize = 1024;
		await startTranscriptUpload("app-1", created.transcript.id);
		const firstQueued = transcripts()[0]?.queuedAt;
		expect(firstQueued).toBeInstanceOf(Date);

		const row = transcripts()[0];
		if (row) row.startedAt = new Date(Date.now() - 10 * 60 * 1000);
		await startTranscriptUpload("app-1", created.transcript.id);
		expect(context.start).toHaveBeenCalledTimes(2);
		expect(transcripts()[0]?.queuedAt).toBe(firstQueued);
	});

	it("forgets the queue time when the first start could not be launched", async () => {
		const created = await createTranscriptUpload("app-1", {
			fileName: "a.mp3",
			contentLength: 1024,
		});
		if (!created.ok) throw new Error("create failed");
		context.objectSize = 1024;
		context.start.mockRejectedValueOnce(new Error("queue unavailable"));

		await startTranscriptUpload("app-1", created.transcript.id);
		expect(transcripts()[0]).toMatchObject({
			status: "uploading",
			queuedAt: null,
			startedAt: null,
		});
	});
});

describe("input validation", () => {
	it("accepts and normalises valid options", () => {
		expect(
			validateTranscriptOptions({
				name: "  Standup  ",
				language: "en",
				userId: " user-1 ",
				metadata: { team: "core" },
			}),
		).toEqual({
			ok: true,
			name: "Standup",
			requestedLanguage: "en",
			externalUserId: "user-1",
			metadata: { team: "core" },
		});
		expect(validateTranscriptOptions({})).toMatchObject({
			ok: true,
			name: null,
			requestedLanguage: null,
			externalUserId: null,
			metadata: null,
		});
	});

	it.each([
		[{ name: "n".repeat(256) }, "invalid_name"],
		[{ language: "klingon" }, "invalid_language"],
		[{ userId: "u".repeat(256) }, "invalid_user_id"],
		[{ metadata: ["a"] }, "invalid_metadata"],
		[{ metadata: "text" }, "invalid_metadata"],
		[{ metadata: { blob: "x".repeat(9000) } }, "invalid_metadata"],
	])("rejects %j", (input, code) => {
		expect(validateTranscriptOptions(input)).toMatchObject({
			ok: false,
			status: 400,
			code,
		});
	});

	it("bounds idempotency keys", () => {
		expect(isTranscriptIdempotencyKey("retry-key-0001")).toBe(true);
		expect(isTranscriptIdempotencyKey("short")).toBe(false);
		expect(isTranscriptIdempotencyKey("has spaces in it")).toBe(false);
		expect(isTranscriptIdempotencyKey("k".repeat(129))).toBe(false);
		expect(isTranscriptIdempotencyKey(undefined)).toBe(false);
	});
});
