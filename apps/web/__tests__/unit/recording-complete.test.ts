import { MySqlDialect } from "drizzle-orm/mysql-core";
import type { Context, Next } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	rows: [] as unknown[][],
	userId: "owner" as string | null,
	where: vi.fn(),
	queue: vi.fn(),
	verify: vi.fn(),
	validate: vi.fn(),
}));

vi.mock("@cap/database", () => ({
	db: () => ({
		select: () => ({ from: () => ({ where: mocks.where }) }),
	}),
}));
vi.mock("@cap/database/schema", () => ({
	videos: { id: "id", ownerId: "ownerId" },
	videoUploads: { videoId: "videoId", phase: "phase" },
	videoProcessingJobs: { videoId: "videoId" },
}));
vi.mock("@cap/web-domain", () => ({
	Video: { VideoId: { make: (id: string) => id } },
}));
vi.mock("@/app/api/utils", () => ({
	withAuth: async (context: Context, next: Next) => {
		if (!mocks.userId) return context.json({ error: "Unauthorized" }, 401);
		context.set("user", { id: mocks.userId });
		await next();
	},
}));
vi.mock("@/lib/desktop-segments-finalization", () => ({
	queueDesktopSegmentsFinalization: mocks.queue,
}));
vi.mock("@/lib/desktop-recording-upload-status", () => ({
	verifyDesktopRecordingUpload: mocks.verify,
	validateDesktopRecordingRequest: mocks.validate,
}));

import { app } from "@/app/api/upload/[...route]/recording-complete";
import {
	DesktopRecordingSourceBlockedError,
	SourceCommitPendingError,
} from "@/lib/desktop-recording-jobs";

const verification = {
	version: 1,
	artifact: { kind: "segments", manifestSha256: "a".repeat(64) },
	requiredAudio: true,
};

async function request(body: unknown = { videoId: "recording", verification }) {
	return app.request("/", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
}

function setSource(type: "desktopMP4" | "desktopSegments" | "local") {
	mocks.rows[0] = [{ id: "recording", ownerId: "owner", source: { type } }];
}

describe("recording completion acknowledgement", () => {
	beforeEach(() => {
		mocks.rows = [[], []];
		setSource("desktopMP4");
		mocks.userId = "owner";
		mocks.where.mockImplementation(async () => mocks.rows.shift() ?? []);
		mocks.queue.mockReset().mockResolvedValue("queued");
		mocks.verify.mockReset().mockResolvedValue(null);
		mocks.validate.mockReset().mockResolvedValue(undefined);
		vi.spyOn(console, "error").mockImplementation(() => undefined);
	});

	it.each([false, true])(
		"returns a retryable non-2xx until the source is secured (proof: %s)",
		async (hasProof) => {
			mocks.queue.mockRejectedValueOnce(new SourceCommitPendingError());
			const response = await request({
				videoId: "recording",
				...(hasProof ? { verification } : {}),
			});
			expect(response.status).toBe(503);
			expect(response.headers.get("Retry-After")).toBe("5");
			expect(await response.json()).toMatchObject({
				success: false,
				status: "source-commit-pending",
			});
			expect(mocks.queue).toHaveBeenCalledWith({
				videoId: "recording",
				userId: "owner",
				verification: hasProof ? verification : undefined,
			});
		},
	);

	it.each([
		["processing", false],
		["processing", true],
		["error", false],
		["error", true],
		["complete", false],
		["complete", true],
	])(
		"does not acknowledge from an old %s upload row (proof: %s)",
		async (phase, hasProof) => {
			mocks.rows[1] = [{ videoId: "recording", phase }];
			mocks.queue.mockRejectedValueOnce(new SourceCommitPendingError());
			const response = await request({
				videoId: "recording",
				...(hasProof ? { verification } : {}),
			});
			expect(response.status).toBe(503);
			expect(mocks.queue).toHaveBeenCalledOnce();
		},
	);

	it("waits for the source queue before acknowledging a legacy client", async () => {
		let release: (() => void) | undefined;
		const committed = new Promise<void>((resolve) => {
			release = resolve;
		});
		mocks.queue.mockImplementation(async () => {
			await committed;
			return "queued";
		});
		let settled = false;
		const pending = request({ videoId: "recording" }).then((response) => {
			settled = true;
			return response;
		});
		await vi.waitFor(() => expect(mocks.queue).toHaveBeenCalledOnce());
		expect(settled).toBe(false);
		if (!release) throw new Error("Missing source commit resolver");
		release();
		const response = await pending;
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ success: true, status: "queued" });
		expect(mocks.verify).not.toHaveBeenCalled();
	});

	it("attaches a late proof even when the earlier upload row says processing", async () => {
		setSource("desktopSegments");
		mocks.rows[1] = [{ videoId: "recording", phase: "processing" }];
		mocks.queue.mockResolvedValueOnce("already-processing");
		const response = await request();
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			success: true,
			status: "already-processing",
		});
		expect(mocks.validate).toHaveBeenCalledOnce();
		expect(mocks.queue).toHaveBeenCalledWith({
			videoId: "recording",
			userId: "owner",
			verification,
		});
		expect(mocks.verify).not.toHaveBeenCalled();
	});

	it("retries processing after an old worker error when the source is secured", async () => {
		mocks.rows[1] = [{ videoId: "recording", phase: "error" }];
		const response = await request({ videoId: "recording" });
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ success: true, status: "queued" });
		expect(mocks.queue).toHaveBeenCalledOnce();
	});

	it.each([false, true])(
		"requests retransmission only for a confirmed blocked source (proof: %s)",
		async (hasProof) => {
			mocks.queue.mockRejectedValueOnce(
				new DesktopRecordingSourceBlockedError(
					"source-missing",
					"The final video segment is missing",
				),
			);
			const response = await request({
				videoId: "recording",
				...(hasProof ? { verification } : {}),
			});
			expect(response.status).toBe(409);
			expect(response.headers.get("Retry-After")).toBeNull();
			expect(await response.json()).toEqual({
				success: false,
				status: "reupload-required",
				code: "source-missing",
				error: "The final video segment is missing",
			});
		},
	);

	it("keeps local data when required-track validation is unavailable", async () => {
		setSource("desktopSegments");
		mocks.validate.mockRejectedValueOnce(new Error("Storage unavailable"));
		const response = await request();
		expect(response.status).toBe(503);
		expect(response.headers.get("Retry-After")).toBe("5");
		expect(await response.json()).toMatchObject({
			success: false,
			error: expect.stringContaining("retain the local recording"),
		});
		expect(mocks.queue).not.toHaveBeenCalled();
	});

	it("returns an existing verified receipt without starting another job", async () => {
		const receipt = {
			version: 1,
			videoId: "recording",
			artifact: verification.artifact,
			fileSize: 4096,
			duration: 5,
			hasAudio: true,
			fullDecode: true,
		};
		mocks.verify.mockResolvedValueOnce(receipt);
		const response = await request();
		expect(await response.json()).toEqual({
			success: true,
			status: "verified",
			verification: receipt,
		});
		expect(mocks.validate).not.toHaveBeenCalled();
		expect(mocks.queue).not.toHaveBeenCalled();
	});

	it("looks up the video using the authenticated owner, not a supplied owner", async () => {
		mocks.rows[0] = [];
		const response = await request({
			videoId: "recording",
			ownerId: "somebody-else",
			verification,
		});
		expect(response.status).toBe(404);
		const [condition] = mocks.where.mock.calls[0] ?? [];
		if (!condition) throw new Error("Missing owned-video query");
		expect(new MySqlDialect().sqlToQuery(condition).params).toEqual([
			"id",
			"recording",
			"ownerId",
			"owner",
		]);
		expect(mocks.queue).not.toHaveBeenCalled();
	});

	it("rejects unauthenticated and non-desktop requests before queueing", async () => {
		mocks.userId = null;
		expect((await request()).status).toBe(401);
		expect(mocks.where).not.toHaveBeenCalled();
		mocks.userId = "owner";
		setSource("local");
		expect((await request()).status).toBe(400);
		expect(mocks.queue).not.toHaveBeenCalled();
	});

	it.each([
		{},
		{ videoId: 123 },
		{ videoId: "recording", verification: null },
		{ videoId: "recording", verification: { ...verification, version: 2 } },
		{
			videoId: "recording",
			verification: { ...verification, artifact: { kind: "segments" } },
		},
		{
			videoId: "recording",
			verification: { ...verification, requiredAudio: "true" },
		},
	])("does not downgrade malformed completion proof %#", async (body) => {
		expect((await request(body)).status).toBe(400);
		expect(mocks.where).not.toHaveBeenCalled();
		expect(mocks.queue).not.toHaveBeenCalled();
	});
});
