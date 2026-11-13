import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	connect,
	eventually,
	expectNoSecrets,
	type Session,
	tempFiles,
} from "./harness";
import { type StubApi, startStubApi } from "./stub-api";

let stub: StubApi;
let session: Session;
let files: Awaited<ReturnType<typeof tempFiles>>;
const billing = () => `${stub.url}/dashboard/infra/app_stub/billing`;

beforeEach(async () => {
	stub = await startStubApi();
	session = await connect(stub);
	files = await tempFiles();
});

afterEach(async () => {
	expectNoSecrets(stub, session.output);
	await session.close();
	await stub.close();
	await files.remove();
});

const EM_DASH = String.fromCharCode(0x2014);

const TOOL_KINDS: Record<string, "read" | "write" | "delete"> = {
	videos_upload: "write",
	videos_import: "write",
	videos_get: "read",
	videos_wait: "read",
	videos_list: "read",
	videos_delete: "delete",
	transcripts_create: "write",
	transcripts_get: "read",
	transcripts_wait: "read",
	transcripts_text: "read",
	transcripts_list: "read",
	transcripts_delete: "delete",
	account_usage: "read",
	account_transactions: "read",
	docs_read: "read",
};

describe("tool list", () => {
	it("lists every tool with honest annotations", async () => {
		const { tools } = await session.client.listTools();
		expect(tools.map((tool) => tool.name).sort()).toEqual(
			Object.keys(TOOL_KINDS).sort(),
		);
		for (const tool of tools) {
			const kind = TOOL_KINDS[tool.name];
			expect(tool.annotations?.readOnlyHint, tool.name).toBe(kind === "read");
			expect(tool.annotations?.destructiveHint, tool.name).toBe(
				kind === "delete",
			);
			expect(tool.outputSchema, tool.name).toBeUndefined();
			expect(tool.description, tool.name).not.toContain(EM_DASH);
			expect(tool.inputSchema.type).toBe("object");
		}
	});

	it("says what costs money", async () => {
		const { tools } = await session.client.listTools();
		const description = (name: string) =>
			tools.find((tool) => tool.name === name)?.description ?? "";
		expect(description("videos_upload")).toMatch(
			/Stored video is billed by its length and resolution tier: one month when it becomes ready, then daily/,
		);
		expect(description("transcripts_create")).toMatch(/billed per audio hour/);
		expect(description("videos_delete")).toMatch(/cannot be undone/);
		expect(description("transcripts_delete")).toMatch(/cannot be undone/);
		for (const [name, kind] of Object.entries(TOOL_KINDS)) {
			if (kind === "read") expect(description(name)).toMatch(/Free to call/);
		}
	});

	it("explains the journey in the server instructions", () => {
		const instructions = session.client.getInstructions() ?? "";
		expect(instructions).toMatch(/videos_upload/);
		expect(instructions).toMatch(/transcripts_wait/);
		expect(instructions).toMatch(/addCreditAt/);
	});
});

describe("videos", () => {
	it("uploads, waits for the links, lists and deletes", async () => {
		const file = await files.write("Launch demo.mp4", 3000);
		const uploaded = await session.call("videos_upload", {
			path: file.path,
			userId: "user_42",
			metadata: { campaign: "launch" },
		});
		expect(uploaded.isError).toBe(false);
		const videoId = String(uploaded.body.videoId);
		const video = stub.videos.get(videoId);
		expect(uploaded.body).toMatchObject({
			status: "processing",
			bytes: 3000,
			playbackId: video?.playbackId,
			shareUrl: `${stub.url}/dev/${video?.playbackId}`,
			embedUrl: `${stub.url}/dev/${video?.playbackId}/embed`,
		});
		expect(video?.name).toBe("Launch demo");
		expect(video?.externalUserId).toBe("user_42");
		expect(video?.metadata).toEqual({ campaign: "launch" });
		expect(video?.file?.equals(file.content)).toBe(true);
		expect(stub.calls("POST", "/initiate")[0]?.body).toMatchObject({
			contentType: "video/mp4",
			contentLength: 3000,
		});

		const waited = await session.call("videos_wait", { videoId });
		expect(waited.isError).toBe(false);
		const base = `${stub.url}/api/developer/playback/${video?.playbackId}`;
		expect(waited.body).toMatchObject({
			videoId,
			status: "ready",
			duration: 1,
			playbackId: video?.playbackId,
			hlsUrl: `${base}/master.m3u8`,
			mp4Url: `${base}/video.mp4`,
			posterUrl: `${base}/poster.jpg`,
			shareUrl: `${stub.url}/dev/${video?.playbackId}`,
			embedUrl: `${stub.url}/dev/${video?.playbackId}/embed`,
		});
		expect(waited.body.timedOut).toBeUndefined();

		const found = await session.call("videos_get", { videoId });
		expect(found.body).toMatchObject({
			id: videoId,
			name: "Launch demo",
			status: "ready",
			userId: "user_42",
			metadata: { campaign: "launch" },
			mp4Url: `${base}/video.mp4`,
		});
		expect(found.body.addedInALaterRelease).toBeUndefined();
		expect(found.body.appId).toBeUndefined();

		const listed = await session.call("videos_list", { userId: "user_42" });
		expect(listed.body).toEqual({
			videos: [
				{
					id: videoId,
					name: "Launch demo",
					status: "ready",
					duration: 1,
					durationSeconds: 1,
					userId: "user_42",
					createdAt: video?.createdAt,
					shareUrl: `${stub.url}/dev/${video?.playbackId}`,
				},
			],
			limit: 50,
			offset: 0,
			nextOffset: null,
		});
		const others = await session.call("videos_list", { userId: "nobody" });
		expect(others.body.videos).toEqual([]);

		const deleted = await session.call("videos_delete", { videoId });
		expect(deleted.body).toEqual({ videoId, deleted: true });
		const gone = await session.call("videos_get", { videoId });
		expect(gone.isError).toBe(true);
		expect(gone.body.error).toEqual({
			code: "video_not_found",
			message: "Video not found",
			hint: "Check the video ID and that it belongs to this app. Deleted videos are not returned.",
			status: 404,
		});
	});

	it("pages a list by limit and offset", async () => {
		for (const name of ["a.mp4", "b.mp4", "c.mp4"]) {
			const file = await files.write(name, 10);
			await session.call("videos_upload", { path: file.path });
		}
		const first = await session.call("videos_list", { limit: 2 });
		expect(first.body).toMatchObject({ limit: 2, offset: 0, nextOffset: 2 });
		expect((first.body.videos as unknown[]).length).toBe(2);
		const second = await session.call("videos_list", { limit: 2, offset: 2 });
		expect(second.body).toMatchObject({ offset: 2, nextOffset: null });
		expect((second.body.videos as unknown[]).length).toBe(1);
	});

	it("pages a list from an API that sends no paging information", async () => {
		stub.state.videoListPagination = false;
		for (const name of ["a.mp4", "b.mp4", "c.mp4", "d.mp4"]) {
			const file = await files.write(name, 10);
			await session.call("videos_upload", { path: file.path });
		}
		const first = await session.call("videos_list", { limit: 2 });
		expect(first.body.nextOffset).toBe(2);
		const second = await session.call("videos_list", { limit: 2, offset: 2 });
		expect(second.body.nextOffset).toBe(4);
		const third = await session.call("videos_list", { limit: 2, offset: 4 });
		expect(third.body).toMatchObject({ videos: [], nextOffset: null });
	});

	it("reports a video that failed to encode", async () => {
		stub.state.videoOutcome = "errored";
		const file = await files.write("broken.mov", 100);
		const uploaded = await session.call("videos_upload", { path: file.path });
		const waited = await session.call("videos_wait", {
			videoId: uploaded.body.videoId,
		});
		expect(waited.isError).toBe(false);
		expect(waited.body).toMatchObject({
			status: "errored",
			errorReason: "The file is not a video",
			hlsUrl: null,
		});
		expect(stub.calls("POST", "/initiate")[0]?.body).toMatchObject({
			contentType: "video/quicktime",
		});
	});

	it("refuses a path it cannot upload before calling Cap", async () => {
		const missing = await session.call("videos_upload", {
			path: "/nonexistent/video.mp4",
		});
		expect(missing.body.error).toMatchObject({ code: "file_not_found" });
		const relative = await session.call("videos_upload", {
			path: "video.mp4",
		});
		expect(relative.body.error).toMatchObject({ code: "path_not_absolute" });
		expect(stub.requests).toHaveLength(0);
	});
});

describe("transcripts", () => {
	it("creates from a link, waits, reads text and timings, lists and deletes", async () => {
		const created = await session.call("transcripts_create", {
			url: "https://files.example.com/standup.mp3?X-Amz-Signature=abcdef0123456789&expires=1",
			userId: "user_42",
			language: "en",
			idempotencyKey: "standup-2026-11-11",
		});
		expect(created.isError).toBe(false);
		const transcriptId = String(created.body.id);
		expect(created.body).toMatchObject({
			status: "queued",
			source: { type: "url", url: "https://files.example.com/standup.mp3" },
			userId: "user_42",
		});
		expect(created.text).not.toContain("abcdef0123456789");
		expect(stub.transcripts.get(transcriptId)?.idempotencyKey).toBe(
			"standup-2026-11-11",
		);

		const waited = await session.call("transcripts_wait", { transcriptId });
		expect(waited.body).toMatchObject({
			id: transcriptId,
			status: "complete",
			durationSeconds: 754.2,
			wordCount: 7,
			costDollars: 0.02094,
			error: null,
		});
		expect(waited.body.text).toBeUndefined();

		const text = await session.call("transcripts_text", { transcriptId });
		expect(text.body).toEqual({
			id: transcriptId,
			status: "complete",
			text: "Morning everyone. Quick update from my side.",
		});

		const plain = await session.call("transcripts_get", { transcriptId });
		expect(plain.body.text).toBe(
			"Morning everyone. Quick update from my side.",
		);
		expect(plain.body.words).toBeUndefined();
		expect(plain.body.addedInALaterRelease).toBeUndefined();
		const timed = await session.call("transcripts_get", {
			transcriptId,
			words: true,
			segments: true,
		});
		expect(timed.body.words).toEqual([
			{ text: "Morning", start: 0, end: 0.4, confidence: 0.9 },
		]);
		expect(timed.body.segments).toEqual([
			{ text: "Morning everyone.", start: 0, end: 1.1 },
		]);
		expect(
			stub.calls("GET", `/transcripts/${transcriptId}`).at(-1)?.query,
		).toEqual({ include: "words,segments" });

		const listed = await session.call("transcripts_list", {
			status: "complete",
			userId: "user_42",
		});
		expect(listed.body).toMatchObject({
			limit: 50,
			offset: 0,
			nextOffset: null,
		});
		const rows = listed.body.transcripts as Record<string, unknown>[];
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({ id: transcriptId, status: "complete" });
		expect(rows[0]?.text).toBeUndefined();

		const deleted = await session.call("transcripts_delete", { transcriptId });
		expect(deleted.body).toEqual({ transcriptId, deleted: true });
		const gone = await session.call("transcripts_text", { transcriptId });
		expect(gone.body.error).toMatchObject({
			code: "transcript_not_found",
			status: 404,
		});
	});

	it("creates from a local file with one exact-length upload", async () => {
		const file = await files.write("standup.m4a", 70_000);
		const created = await session.call("transcripts_create", {
			path: file.path,
			name: "Standup",
		});
		expect(created.isError).toBe(false);
		const transcriptId = String(created.body.id);
		expect(created.body).toMatchObject({
			status: "queued",
			name: "Standup",
			source: { type: "upload", url: null },
		});
		expect(stub.transcripts.get(transcriptId)?.file?.equals(file.content)).toBe(
			true,
		);
		const put = stub.calls("PUT", `/storage/transcripts/${transcriptId}`)[0];
		expect(put?.headers["content-length"]).toBe("70000");
		expect(put?.headers["transfer-encoding"]).toBeUndefined();
		expect(put?.headers.authorization).toBeUndefined();
		expect(stub.calls("POST", "/transcripts/uploads")[0]?.body).toMatchObject({
			fileName: "standup.m4a",
			contentLength: 70_000,
		});

		const waited = await session.call("transcripts_wait", { transcriptId });
		expect(waited.body.status).toBe("complete");
	});

	it("creates from a stored video through its MP4 link", async () => {
		const file = await files.write("Interview.mp4", 500);
		const uploaded = await session.call("videos_upload", { path: file.path });
		const videoId = String(uploaded.body.videoId);

		const early = await session.call("transcripts_create", { videoId });
		expect(early.isError).toBe(true);
		expect(early.body).toMatchObject({
			error: { code: "video_not_ready" },
			videoId,
			videoStatus: "processing",
		});
		expect(stub.calls("POST", "/transcripts")).toHaveLength(0);

		await session.call("videos_wait", { videoId });
		const created = await session.call("transcripts_create", {
			videoId,
			metadata: { team: "sales" },
		});
		expect(created.isError).toBe(false);
		const playbackId = stub.videos.get(videoId)?.playbackId;
		expect(stub.calls("POST", "/transcripts")[0]?.body).toEqual({
			url: `${stub.url}/api/developer/playback/${playbackId}/video.mp4`,
			name: "Interview",
			metadata: { team: "sales", videoId },
		});
		expect(created.body.metadata).toEqual({ team: "sales", videoId });
	});

	it("asks for exactly one source", async () => {
		const none = await session.call("transcripts_create", {});
		expect(none.body.error).toMatchObject({ code: "invalid_source" });
		const both = await session.call("transcripts_create", {
			url: "https://files.example.com/a.mp3",
			videoId: "abc",
		});
		expect(both.body.error).toMatchObject({ code: "invalid_source" });
		expect(stub.requests).toHaveLength(0);
	});

	it("announces the transcript id when the call is cancelled midway", async () => {
		const file = await files.write("standup.wav", 2000);
		stub.state.hang = (request) =>
			request.method === "POST" && request.path.endsWith("/start");
		const controller = new AbortController();
		const pending = session
			.call(
				"transcripts_create",
				{ path: file.path },
				{ signal: controller.signal },
			)
			.catch((error: unknown) => error);
		await eventually(() => stub.calls("POST", "/start").length > 0);
		controller.abort();
		await pending;
		const transcriptId = [...stub.transcripts.keys()][0];
		await eventually(() =>
			session.events.some(
				(event) => event.event === "transcripts_create_cancelled",
			),
		);
		expect(session.events).toContainEqual({
			event: "transcript_created",
			transcriptId,
		});
		expect(
			session.events.find(
				(event) => event.event === "transcripts_create_cancelled",
			),
		).toMatchObject({ code: "cancelled", transcriptId });
	});
});

describe("account", () => {
	it("returns usage with fields added after this server was written", async () => {
		const usage = await session.call("account_usage");
		expect(usage.body).toMatchObject({
			balanceDollars: "5.00",
			standing: { state: "active", pausesAt: null },
			upload: { allowed: true },
			storage: { dailyMicroCredits: 247 },
			rates: { speechDollarsPerHour: 0.1 },
			availableMicroCredits: 460000,
			heldMicroCredits: 40000,
			speech: { seconds: 2262, microCredits: 6283, transcripts: 3 },
		});
	});

	it("lists the ledger trimmed to what an agent reads", async () => {
		const ledger = await session.call("account_transactions", { limit: 2 });
		expect(ledger.body).toMatchObject({ limit: 2, offset: 0, nextOffset: 2 });
		const rows = ledger.body.transactions as Record<string, unknown>[];
		expect(rows).toHaveLength(2);
		expect(Object.keys(rows[0] ?? {})).toEqual([
			"id",
			"type",
			"description",
			"note",
			"amountDollars",
			"balanceAfterDollars",
			"referenceType",
			"referenceId",
			"createdAt",
		]);
		const rest = await session.call("account_transactions", {
			limit: 2,
			offset: 2,
		});
		expect(rest.body.nextOffset).toBeNull();
	});
});

describe("out of credit", () => {
	it.each(["out_of_credit", "insufficient_credits"] as const)(
		"says so with the console link when an upload answers %s",
		async (code) => {
			stub.state.credit = code;
			const file = await files.write("demo.mp4", 100);
			const refused = await session.call("videos_upload", { path: file.path });
			expect(refused.isError).toBe(true);
			expect(refused.body).toMatchObject({
				error: {
					code,
					status: 402,
					balanceMicroCredits: 5000,
					requiredMicroCredits: 19834,
					shortfallMicroCredits: 14834,
				},
				addCreditAt: billing(),
			});
			expect(refused.body.credit).toMatch(
				/^Out of credit\. Add credit in the Cap Infra console at /,
			);
			expect(refused.body.credit).toContain(billing());
			expect(stub.videos.size).toBe(0);
		},
	);

	it("says so when a transcript is refused", async () => {
		stub.state.credit = "insufficient_credits";
		const refused = await session.call("transcripts_create", {
			url: "https://files.example.com/a.mp3",
		});
		expect(refused.body).toMatchObject({
			error: {
				code: "insufficient_credits",
				message: "The balance is $0.05, so add at least $0.14834.",
				hint: "Add credits, then send the request again.",
				status: 402,
			},
			addCreditAt: billing(),
		});
		expect(refused.body.credit).toMatch(/^Out of credit\./);
	});

	it("says so when the upload finishes and the balance no longer covers it", async () => {
		const file = await files.write("demo.mp4", 3000);
		const original = stub.state.hang;
		stub.state.hang = (request) => {
			if (request.path.endsWith("/complete")) {
				stub.state.credit = "insufficient_credits";
			}
			return original?.(request) ?? false;
		};
		const refused = await session.call("videos_upload", { path: file.path });
		const videoId = [...stub.videos.keys()][0];
		expect(refused.body).toMatchObject({
			error: { code: "insufficient_credits", status: 402 },
			addCreditAt: billing(),
			videoId,
			videoStatus: "uploading",
		});
		expect(stub.videos.get(String(videoId))?.aborted).toBe(1);
	});

	it("links the console root when the server does not say which app the key is for", async () => {
		stub.state.credit = "insufficient_credits";
		stub.state.usageAppId = null;
		const refused = await session.call("transcripts_create", {
			url: "https://files.example.com/a.mp3",
		});
		expect(refused.body.addCreditAt).toBe(`${stub.url}/dashboard/infra`);
		expect(refused.body.credit).toContain(`${stub.url}/dashboard/infra `);
	});

	it("asks which app the key is for once, however many calls are refused", async () => {
		stub.state.credit = "insufficient_credits";
		for (let round = 0; round < 3; round++) {
			const refused = await session.call("transcripts_create", {
				url: "https://files.example.com/a.mp3",
			});
			expect(refused.body.addCreditAt).toBe(billing());
		}
		expect(stub.calls("GET", "/usage")).toHaveLength(1);
	});

	it("asks nothing extra when nothing is refused", async () => {
		await session.call("transcripts_create", {
			url: "https://files.example.com/a.mp3",
		});
		expect(stub.calls("GET", "/usage")).toHaveLength(0);
	});

	it("points at the console when a transcript ends without credit", async () => {
		stub.state.transcriptOutcome = "insufficient_credits";
		const created = await session.call("transcripts_create", {
			url: "https://files.example.com/a.mp3",
		});
		const waited = await session.call("transcripts_wait", {
			transcriptId: created.body.id,
		});
		expect(waited.isError).toBe(false);
		expect(waited.body).toMatchObject({
			status: "error",
			error: { code: "insufficient_credits" },
			addCreditAt: billing(),
		});
	});
});

describe("errors", () => {
	it("passes the code, message and hint of the API through", async () => {
		const bad = await connect({
			...stub,
			secretKey: "csk_wrongwrongwrongwrong",
		});
		const refused = await bad.call("account_usage");
		expect(refused.isError).toBe(true);
		expect(refused.body).toEqual({
			error: {
				code: "invalid_secret_key",
				message: "Invalid secret key",
				hint: "Send Authorization: Bearer csk_... with a secret key from https://cap.so/dashboard/infra.",
				status: 401,
			},
		});
		expect(refused.text).not.toContain("csk_wrong");
		await bad.close();
	});

	it("rejects arguments the tool does not take a value for", async () => {
		const refused = await session.client.callTool({
			name: "videos_list",
			arguments: { limit: 500 },
		});
		expect(refused.isError).toBe(true);
		expect(stub.requests).toHaveLength(0);
	});
});
