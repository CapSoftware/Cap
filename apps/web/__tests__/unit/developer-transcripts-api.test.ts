import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	keyRows: [] as { appId: string }[],
	store: {
		createTranscriptFromUrl: vi.fn(),
		createTranscriptUpload: vi.fn(),
		startTranscriptUpload: vi.fn(),
		getTranscript: vi.fn(),
		getTranscriptResult: vi.fn(),
		listTranscripts: vi.fn(),
		deleteTranscript: vi.fn(),
	},
}));

vi.mock("@cap/database", () => {
	const chain = {
		select: () => chain,
		from: () => chain,
		innerJoin: () => chain,
		leftJoin: () => chain,
		where: () => chain,
		limit: async () => mocks.keyRows,
		update: () => chain,
		set: () => chain,
		catch: () => chain,
	};
	return { db: () => chain };
});

vi.mock("@cap/database/auth/session", () => ({ getCurrentUser: vi.fn() }));
vi.mock("@cap/database/auth/domain-utils", () => ({
	isBlockedAccountEmail: () => false,
}));
vi.mock("@cap/database/auth/request-site", () => ({
	isCrossSiteCookieWrite: () => false,
}));
vi.mock("@cap/env", () => ({
	buildEnv: { NEXT_PUBLIC_WEB_URL: "https://cap.so" },
}));
vi.mock("@/lib/developer-key-hash", () => ({
	hashKey: async (key: string) => `hash:${key}`,
}));
vi.mock("@/lib/developer-transcript-store", () => ({
	...mocks.store,
	isTranscriptIdempotencyKey: (value: string | undefined | null) =>
		typeof value === "string" &&
		value.length >= 8 &&
		value.length <= 128 &&
		/^[A-Za-z0-9._-]+$/.test(value),
}));

import { app } from "@/app/api/developer/v1/[...route]/transcripts";

const SECRET = { Authorization: "Bearer csk_valid_key" };

const transcript = (overrides: Record<string, unknown> = {}) => ({
	id: "tr-1",
	appId: "app-1",
	externalUserId: null,
	name: "Standup",
	status: "queued",
	sourceType: "url",
	sourceUrl: "https://media.example.com/a.mp3",
	s3Key: "developer/app-1/transcripts/tr-1/source",
	resultKey: null,
	sourceBytes: null,
	durationSeconds: null,
	requestedLanguage: null,
	language: null,
	text: null,
	wordCount: null,
	billedMicroCredits: 0,
	errorCode: null,
	errorMessage: null,
	metadata: null,
	runId: null,
	queuedAt: null,
	startedAt: null,
	completedAt: null,
	deletedAt: null,
	createdAt: new Date("2026-11-11T10:00:00Z"),
	updatedAt: new Date("2026-11-11T10:00:00Z"),
	...overrides,
});

const post = (path: string, body: unknown, headers: Record<string, string>) =>
	app.request(path, {
		method: "POST",
		headers: { "Content-Type": "application/json", ...headers },
		body: JSON.stringify(body),
	});

describe("developer transcripts API", () => {
	beforeEach(() => {
		mocks.keyRows = [{ appId: "app-1" }];
		for (const mock of Object.values(mocks.store)) mock.mockReset();
	});

	describe("authentication", () => {
		it.each([
			["no key", {}],
			["a public key", { Authorization: "Bearer cpk_public_key" }],
			["an agent token", { Authorization: "Bearer cap_cli_token" }],
			["a malformed header", { Authorization: "csk_valid_key" }],
		])("rejects %s before touching transcripts", async (_label, headers) => {
			for (const [method, path] of [
				["GET", "/"],
				["GET", "/tr-1"],
				["DELETE", "/tr-1"],
				["POST", "/tr-1/start"],
			] as const) {
				const response = await app.request(path, { method, headers });
				expect(response.status).toBe(401);
				expect(await response.json()).toMatchObject({
					code: "invalid_secret_key",
				});
			}
			const created = await post("/", { url: "https://a.example/a" }, headers);
			expect(created.status).toBe(401);
			for (const mock of Object.values(mocks.store)) {
				expect(mock).not.toHaveBeenCalled();
			}
		});

		it("rejects a revoked or unknown secret key", async () => {
			mocks.keyRows = [];
			const response = await app.request("/", { headers: SECRET });
			expect(response.status).toBe(401);
			expect(mocks.store.listTranscripts).not.toHaveBeenCalled();
		});

		it("scopes every call to the app that owns the key", async () => {
			mocks.keyRows = [{ appId: "app-from-key" }];
			mocks.store.getTranscript.mockResolvedValue(null);
			mocks.store.deleteTranscript.mockResolvedValue({
				ok: false,
				status: 404,
				code: "transcript_not_found",
				message: "Transcript not found",
				hint: "",
			});
			expect((await app.request("/tr-other", { headers: SECRET })).status).toBe(
				404,
			);
			expect(
				(await app.request("/tr-other", { method: "DELETE", headers: SECRET }))
					.status,
			).toBe(404);
			expect(mocks.store.getTranscript).toHaveBeenCalledWith(
				"app-from-key",
				"tr-other",
			);
			expect(mocks.store.deleteTranscript).toHaveBeenCalledWith(
				"app-from-key",
				"tr-other",
			);
		});
	});

	describe("pagination", () => {
		beforeEach(() => {
			mocks.store.listTranscripts.mockResolvedValue({
				transcripts: [transcript()],
				hasMore: true,
			});
		});

		it("uses the default page and reports whether more exist", async () => {
			const response = await app.request("/", { headers: SECRET });
			expect(response.status).toBe(200);
			const body = await response.json();
			expect(body.pagination).toEqual({ limit: 50, offset: 0, hasMore: true });
			expect(body.data).toHaveLength(1);
			expect(body.data[0]).not.toHaveProperty("text");
			expect(mocks.store.listTranscripts).toHaveBeenCalledWith("app-1", {
				limit: 50,
				offset: 0,
				userId: null,
				status: null,
			});
		});

		it("caps the limit and passes filters through", async () => {
			await app.request("/?limit=500&offset=20&userId=user-9&status=complete", {
				headers: SECRET,
			});
			expect(mocks.store.listTranscripts).toHaveBeenCalledWith("app-1", {
				limit: 100,
				offset: 20,
				userId: "user-9",
				status: "complete",
			});
		});

		it("falls back to defaults for unusable numbers", async () => {
			await app.request("/?limit=-3&offset=abc", { headers: SECRET });
			expect(mocks.store.listTranscripts).toHaveBeenCalledWith(
				"app-1",
				expect.objectContaining({ limit: 50, offset: 0 }),
			);
		});

		it("rejects an unknown status filter", async () => {
			const response = await app.request("/?status=done", { headers: SECRET });
			expect(response.status).toBe(400);
			expect(await response.json()).toMatchObject({ code: "invalid_status" });
			expect(mocks.store.listTranscripts).not.toHaveBeenCalled();
		});
	});

	describe("creating", () => {
		it("answers 402 when the balance cannot cover the minimum", async () => {
			mocks.store.createTranscriptFromUrl.mockResolvedValue({
				ok: false,
				status: 402,
				code: "insufficient_credits",
				message: "Insufficient credits",
				hint: "Add credits",
			});
			const response = await post(
				"/",
				{ url: "https://media.example.com/a.mp3" },
				SECRET,
			);
			expect(response.status).toBe(402);
			expect(await response.json()).toMatchObject({
				code: "insufficient_credits",
				error: "Insufficient credits",
			});
		});

		it("passes the URL, options and idempotency key to the store", async () => {
			mocks.store.createTranscriptFromUrl.mockResolvedValue({
				ok: true,
				transcript: transcript(),
			});
			const response = await post(
				"/",
				{
					url: "https://media.example.com/a.mp3",
					language: "en",
					userId: "user-1",
					durationSeconds: 1,
				},
				{ ...SECRET, "Idempotency-Key": "retry-key-1" },
			);
			expect(response.status).toBe(200);
			expect(mocks.store.createTranscriptFromUrl).toHaveBeenCalledWith(
				"app-1",
				{
					url: "https://media.example.com/a.mp3",
					language: "en",
					userId: "user-1",
					idempotencyKey: "retry-key-1",
				},
			);
			const body = await response.json();
			expect(body.data).toMatchObject({ id: "tr-1", status: "queued" });
			expect(JSON.stringify(body)).not.toContain("s3Key");
		});

		it("rejects a malformed idempotency key", async () => {
			const response = await post(
				"/",
				{ url: "https://media.example.com/a.mp3" },
				{ ...SECRET, "Idempotency-Key": "bad key!" },
			);
			expect(response.status).toBe(400);
			expect(mocks.store.createTranscriptFromUrl).not.toHaveBeenCalled();
		});

		it.each([
			[{}],
			[{ url: "" }],
			[{ url: 42 }],
			[{ url: "https://a.example/a", name: "n".repeat(256) }],
			[{ url: "https://a.example/a", metadata: "text" }],
		])("rejects the invalid URL body %j", async (body) => {
			const response = await post("/", body, SECRET);
			expect(response.status).toBe(400);
			expect(mocks.store.createTranscriptFromUrl).not.toHaveBeenCalled();
		});

		it.each([
			[{}],
			[{ contentLength: 0 }],
			[{ contentLength: -1 }],
			[{ contentLength: 1.5 }],
			[{ contentLength: "100" }],
		])("rejects the invalid upload body %j", async (body) => {
			const response = await post("/uploads", body, SECRET);
			expect(response.status).toBe(400);
			expect(mocks.store.createTranscriptUpload).not.toHaveBeenCalled();
		});

		it("returns the upload target for a file transcript", async () => {
			mocks.store.createTranscriptUpload.mockResolvedValue({
				ok: true,
				transcript: transcript({ status: "uploading", sourceType: "upload" }),
				upload: {
					method: "PUT",
					url: "https://storage.example/signed",
					headers: { "Content-Length": "1024" },
					expiresAt: "2026-11-11T11:00:00.000Z",
				},
			});
			const response = await post(
				"/uploads",
				{ fileName: "a.mp3", contentLength: 1024 },
				SECRET,
			);
			expect(response.status).toBe(200);
			const body = await response.json();
			expect(body.data.status).toBe("uploading");
			expect(body.data.upload.method).toBe("PUT");
		});

		it("surfaces a start that has no uploaded file", async () => {
			mocks.store.startTranscriptUpload.mockResolvedValue({
				ok: false,
				status: 409,
				code: "upload_not_found",
				message: "The file has not been uploaded yet",
				hint: "PUT the file",
			});
			const response = await app.request("/tr-1/start", {
				method: "POST",
				headers: SECRET,
			});
			expect(response.status).toBe(409);
			expect(await response.json()).toMatchObject({ code: "upload_not_found" });
		});
	});

	describe("reading", () => {
		it("returns text only once the transcript is complete", async () => {
			mocks.store.getTranscript.mockResolvedValue(
				transcript({ status: "processing", text: "partial" }),
			);
			const pending = await (
				await app.request("/tr-1", { headers: SECRET })
			).json();
			expect(pending.data.text).toBeNull();

			mocks.store.getTranscript.mockResolvedValue(
				transcript({
					status: "complete",
					text: "hello world",
					durationSeconds: 3600,
					billedMicroCredits: 10_000,
				}),
			);
			const done = await (
				await app.request("/tr-1", { headers: SECRET })
			).json();
			expect(done.data).toMatchObject({
				text: "hello world",
				costMicroCredits: 10_000,
				costDollars: 0.1,
			});
			expect(done.data).not.toHaveProperty("words");
			expect(mocks.store.getTranscriptResult).not.toHaveBeenCalled();
		});

		it("loads word timings only when asked", async () => {
			mocks.store.getTranscript.mockResolvedValue(
				transcript({ status: "complete", text: "hello" }),
			);
			mocks.store.getTranscriptResult.mockResolvedValue({
				words: [{ text: "hello", start: 0, end: 0.4, confidence: 0.9 }],
				segments: [{ text: "hello", start: 0, end: 0.4 }],
			});
			const body = await (
				await app.request("/tr-1?include=words", { headers: SECRET })
			).json();
			expect(body.data.words).toHaveLength(1);
			expect(body.data).not.toHaveProperty("segments");
		});
	});
});
