import type { Context, Next } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	rows: [] as unknown[][],
	queue: vi.fn(),
	verify: vi.fn(),
	validate: vi.fn(),
}));

vi.mock("@cap/database", () => ({
	db: () => ({
		select: () => ({
			from: () => ({ where: async () => mocks.rows.shift() ?? [] }),
		}),
	}),
}));
vi.mock("@cap/database/schema", () => ({
	videos: { id: "id", ownerId: "ownerId" },
	videoUploads: { videoId: "videoId", phase: "phase" },
}));
vi.mock("@cap/web-domain", () => ({
	Video: { VideoId: { make: (id: string) => id } },
}));
vi.mock("@/app/api/utils", () => ({
	withAuth: async (context: Context, next: Next) => {
		context.set("user", { id: "owner" });
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

const verification = {
	version: 1,
	artifact: { kind: "segments", manifestSha256: "a".repeat(64) },
	requiredAudio: true,
};

function request(verify = true) {
	return app.request("/", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			videoId: "recording",
			...(verify ? { verification } : {}),
		}),
	});
}

describe("recording completion acknowledgement", () => {
	beforeEach(() => {
		mocks.rows = [
			[{ id: "recording", ownerId: "owner", source: { type: "desktopMP4" } }],
			[],
		];
		mocks.queue.mockResolvedValue("queued");
		mocks.verify.mockResolvedValue(null);
		mocks.validate.mockResolvedValue(undefined);
	});

	it("preserves the legacy client acknowledgement without granting verified cleanup", async () => {
		const response = await request(false);
		expect(await response.json()).toEqual({
			success: true,
			status: "already-complete",
		});
		expect(mocks.queue).not.toHaveBeenCalled();
	});

	it("reconciles a legacy completed upload missing its verification receipt", async () => {
		const response = await request();
		expect(await response.json()).toEqual({ success: true, status: "queued" });
		expect(mocks.validate).toHaveBeenCalledOnce();
		expect(mocks.queue).toHaveBeenCalledWith({
			videoId: "recording",
			userId: "owner",
			verification,
		});
	});

	it("does not enqueue a second job while verification is processing", async () => {
		mocks.rows[1] = [{ videoId: "recording", phase: "processing" }];
		const response = await request();
		expect(await response.json()).toEqual({
			success: true,
			status: "already-processing",
		});
		expect(mocks.queue).not.toHaveBeenCalled();
	});

	it("queues verification after upload bytes finish but the progress row remains", async () => {
		mocks.rows[1] = [{ videoId: "recording", phase: "uploading" }];
		const response = await request();
		expect(await response.json()).toEqual({ success: true, status: "queued" });
		expect(mocks.queue).toHaveBeenCalledOnce();
	});

	it("validates required tracks before finalizing a segmented upload", async () => {
		mocks.rows[0] = [
			{
				id: "recording",
				ownerId: "owner",
				source: { type: "desktopSegments" },
			},
		];
		mocks.validate.mockRejectedValueOnce(new Error("Missing final audio"));
		const response = await request();
		expect(response.status).toBe(503);
		expect(mocks.queue).not.toHaveBeenCalled();
	});

	it("requests retransmission after a segmented upload failed verification", async () => {
		mocks.rows[0] = [
			{
				id: "recording",
				ownerId: "owner",
				source: { type: "desktopSegments" },
			},
		];
		mocks.rows[1] = [{ videoId: "recording", phase: "error" }];
		const response = await request();
		expect(response.status).toBe(409);
		expect(mocks.queue).not.toHaveBeenCalled();
	});

	it("asks for retransmission when a completed remote recording failed validation", async () => {
		mocks.rows[1] = [{ videoId: "recording", phase: "error" }];
		const response = await request();
		expect(response.status).toBe(409);
		expect(await response.json()).toEqual({
			success: false,
			status: "reupload-required",
		});
	});

	it("does not issue a ready receipt when verification or manifest validation fails", async () => {
		mocks.validate.mockRejectedValueOnce(new Error("Missing final audio"));
		const response = await request();
		expect(response.status).toBe(503);
		expect(mocks.queue).not.toHaveBeenCalled();
	});

	it("returns only the verified result for the owned recording", async () => {
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
		expect(mocks.queue).not.toHaveBeenCalled();
	});
});
