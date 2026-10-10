import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const env = vi.hoisted(() => ({
	value: {} as Record<string, string | undefined>,
}));
const saves = vi.hoisted(() => ({
	finalize: vi.fn(async () => "published" as const),
	fail: vi.fn(async () => undefined),
	clearRecording: vi.fn(async () => undefined),
	finalizeExport: vi.fn(async () => "ready" as const),
	failExport: vi.fn(async () => null),
}));

vi.mock("@cap/env", () => ({ serverEnv: () => env.value }));
vi.mock("@/lib/render-farm-save", () => ({
	finalizeRenderFarmSave: saves.finalize,
	finalizeRenderFarmExport: saves.finalizeExport,
	failRenderFarmExport: saves.failExport,
}));
vi.mock("@/lib/render-farm-records", () => ({
	failRenderFarmSave: saves.fail,
	clearRecordingRender: saves.clearRecording,
}));

import { POST } from "@/app/api/render-farm/callback/route";
import {
	publishedRenderFarmUpdate,
	renderSaveStatusFromMetadata,
} from "@/lib/render-farm-status";

const save = {
	version: 1 as const,
	exportId: "export-1",
	jobId: "job-1",
	status: "rendering" as const,
	startedAt: "2026-09-26T00:00:00.000Z",
	outputKey: "owner/video/.recording/render/export-1/result.mp4",
	hlsPrefix: "owner/video/.recording/render/export-1/hls",
};
const output = {
	width: 1920,
	height: 1080,
	fps: 30,
	durationSeconds: 20,
	bytes: 1234,
};

describe("publishedRenderFarmUpdate", () => {
	const video = {
		source: { type: "webMP4" as const, outputKey: "old.mp4" },
		metadata: {
			renderFarmSave: save,
			summary: "old summary",
			chapters: [{ title: "Intro", start: 0 }],
			webEditorAudioDefault: {
				enabledByDefault: true,
				isolation: "light" as const,
			},
		},
	};

	it("switches the source to the render and clears stale AI output", () => {
		const update = publishedRenderFarmUpdate(
			video,
			"job-1",
			output,
			new Date("2026-09-26T01:00:00.000Z"),
		);
		expect(update?.source).toEqual({
			type: "webMP4",
			outputKey: save.outputKey,
		});
		expect(update).toMatchObject({
			duration: 20,
			width: 1920,
			height: 1080,
			fps: 30,
			transcriptionStatus: null,
		});
		expect(update?.metadata.summary).toBeUndefined();
		expect(update?.metadata.chapters).toBeUndefined();
		expect(update?.metadata.webEditorAudioDefault).toEqual(
			video.metadata.webEditorAudioDefault,
		);
		expect(update?.metadata.renderFarmSave).toMatchObject({
			status: "published",
			publishedAt: "2026-09-26T01:00:00.000Z",
		});
	});

	it("keeps transcript and AI output for a render of the untouched recording", () => {
		const update = publishedRenderFarmUpdate(
			{
				...video,
				metadata: {
					...video.metadata,
					renderFarmSave: { ...save, trigger: "recording" as const },
				},
			},
			"job-1",
			output,
			new Date("2026-09-26T01:00:00.000Z"),
		);
		expect(update?.source.outputKey).toBe(save.outputKey);
		expect(update?.metadata.summary).toBe("old summary");
		expect(update?.metadata.chapters).toEqual(video.metadata.chapters);
		expect(update).not.toHaveProperty("transcriptionStatus");
	});

	it("ignores superseded, repeated or invalid results", () => {
		const now = new Date();
		expect(publishedRenderFarmUpdate(video, "job-0", output, now)).toBeNull();
		expect(
			publishedRenderFarmUpdate(
				{
					...video,
					metadata: { renderFarmSave: { ...save, status: "published" } },
				},
				"job-1",
				output,
				now,
			),
		).toBeNull();
		expect(
			publishedRenderFarmUpdate(video, "job-1", { ...output, bytes: 0 }, now),
		).toBeNull();
		expect(
			publishedRenderFarmUpdate(
				{ ...video, source: { type: "MediaConvert" } } as never,
				"job-1",
				output,
				now,
			),
		).toBeNull();
	});
});

describe("renderSaveStatusFromMetadata", () => {
	it("settles published and failed saves without asking the farm", () => {
		expect(renderSaveStatusFromMetadata(undefined)?.state).toBe("idle");
		expect(
			renderSaveStatusFromMetadata({ ...save, status: "published" }),
		).toMatchObject({ state: "ready", progress: 1 });
		expect(
			renderSaveStatusFromMetadata({ ...save, status: "error", error: "x" }),
		).toMatchObject({ state: "error", error: "x" });
		expect(renderSaveStatusFromMetadata(save)).toBeNull();
	});
});

describe("render farm callback route", () => {
	const post = (body: string, signature?: string) =>
		POST(
			new Request("https://cap.test/api/render-farm/callback", {
				method: "POST",
				headers: signature ? { "x-render-farm-signature": signature } : {},
				body,
			}),
		);
	const sign = (body: string) =>
		`sha256=${createHmac("sha256", "callback-secret").update(body).digest("hex")}`;

	beforeEach(() => {
		env.value = {
			RENDER_FARM_URL: "https://farm.test",
			RENDER_FARM_TOKEN: "token",
			RENDER_FARM_CALLBACK_SECRET: "callback-secret",
		};
		for (const mock of Object.values(saves)) mock.mockClear();
	});

	it("is unavailable until the farm is configured", async () => {
		env.value = {};
		expect((await post("{}", sign("{}"))).status).toBe(503);
	});

	it("rejects unsigned or tampered callbacks", async () => {
		const body = JSON.stringify({
			id: "job-1",
			reference: "video",
			status: "ready",
		});
		expect((await post(body)).status).toBe(401);
		expect((await post(body, sign(`${body}x`))).status).toBe(401);
		expect(saves.finalize).not.toHaveBeenCalled();
	});

	it("publishes ready exports and records failures", async () => {
		const ready = JSON.stringify({
			id: "job-1",
			reference: "video",
			status: "ready",
			width: 1920,
			height: 1080,
			fps: 30,
			durationSeconds: 20,
			bytes: 1234,
		});
		expect((await post(ready, sign(ready))).status).toBe(200);
		expect(saves.finalize).toHaveBeenCalledWith("video", "job-1", output);
		const failed = JSON.stringify({
			id: "job-2",
			reference: "video",
			status: "error",
			error: "gpu fell over",
		});
		expect((await post(failed, sign(failed))).status).toBe(200);
		expect(saves.fail).toHaveBeenCalledWith(
			"video",
			{ jobId: "job-2" },
			"gpu fell over",
		);
	});

	it("routes background exports and recording renders by reference kind", async () => {
		const ready = JSON.stringify({
			id: "job-3",
			reference: "export:video",
			status: "ready",
			width: 1920,
			height: 1080,
			fps: 30,
			durationSeconds: 20,
			bytes: 1234,
		});
		expect((await post(ready, sign(ready))).status).toBe(200);
		expect(saves.finalizeExport).toHaveBeenCalledWith("video", "job-3", output);
		expect(saves.finalize).not.toHaveBeenCalled();

		const exportFailed = JSON.stringify({
			id: "job-4",
			reference: "export:video",
			status: "error",
			error: "out of disk",
		});
		expect((await post(exportFailed, sign(exportFailed))).status).toBe(200);
		expect(saves.failExport).toHaveBeenCalledWith(
			"video",
			"job-4",
			"out of disk",
		);

		const recordingReady = JSON.stringify({
			id: "job-5",
			reference: "recording:video",
			status: "ready",
			width: 1920,
			height: 1080,
			fps: 30,
			durationSeconds: 20,
			bytes: 1234,
		});
		expect((await post(recordingReady, sign(recordingReady))).status).toBe(200);
		expect(saves.finalize).toHaveBeenCalledWith("video", "job-5", output);

		const recordingFailed = JSON.stringify({
			id: "job-6",
			reference: "recording:video",
			status: "error",
		});
		expect((await post(recordingFailed, sign(recordingFailed))).status).toBe(
			200,
		);
		expect(saves.clearRecording).toHaveBeenCalledWith("video", {
			jobId: "job-6",
		});
		expect(saves.fail).not.toHaveBeenCalled();
	});

	it("rejects references it cannot route", async () => {
		const body = JSON.stringify({
			id: "job-7",
			reference: "thumbnail:video",
			status: "ready",
		});
		expect((await post(body, sign(body))).status).toBe(400);
		expect(saves.finalize).not.toHaveBeenCalled();
	});

	it("asks the farm to retry when publishing fails", async () => {
		saves.finalize.mockRejectedValueOnce(new Error("db down"));
		const ready = JSON.stringify({
			id: "job-1",
			reference: "video",
			status: "ready",
		});
		expect((await post(ready, sign(ready))).status).toBe(503);
	});
});
