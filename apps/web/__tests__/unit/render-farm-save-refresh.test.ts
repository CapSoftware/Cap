import { beforeEach, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	rows: [] as unknown[],
	jobs: new Map<
		string,
		{ state: string; output?: unknown; progress?: number }
	>(),
}));

vi.mock("@cap/database", () => ({
	db: () => ({
		select: () => ({
			from: () => ({ where: async () => [mocks.rows.shift()] }),
		}),
	}),
}));
vi.mock("@cap/database/emails/config", () => ({ sendEmail: vi.fn() }));
vi.mock("@cap/database/emails/export-ready", () => ({ ExportReady: vi.fn() }));
vi.mock("@cap/env", () => ({ serverEnv: () => ({}) }));
vi.mock("@cap/web-backend", () => ({ Storage: {} }));
vi.mock("@/lib/server", () => ({ runPromise: vi.fn() }));
vi.mock("@/lib/desktop-recording-jobs", () => ({
	retireDesktopRecordingJobForOutputReplacement: vi.fn(),
}));
vi.mock("@/lib/desktop-reupload", () => ({
	invalidateReuploadedVideo: vi.fn(),
}));
vi.mock("@/lib/queue-video-transcription", () => ({
	queueVideoTranscription: vi.fn(),
	shouldQueueTranscriptionAfterMultipartComplete: () => false,
}));
vi.mock("@/lib/render-farm-records", () => ({
	changeRenderFarmExports: vi.fn(),
	clearRecordingRender: vi.fn(),
	failRenderFarmSave: vi.fn(),
}));
vi.mock("@/lib/render-farm", () => ({
	renderFarmConfig: () => ({}),
	renderFarmFetch: async (_config: unknown, path: string) =>
		Response.json({ path }),
	mapRenderFarmJob: ({ body }: { body: { path: string } }) =>
		mocks.jobs.get(body.path.replace("/jobs/", "")) ?? null,
}));

import { refreshRenderFarmSave } from "@/lib/render-farm-save";

const save = (jobId: string, exportId: string) => ({
	version: 1,
	exportId,
	jobId,
	status: "rendering",
	startedAt: new Date().toISOString(),
	outputKey: `owner/video/.recording/outputs/${exportId}/result.mp4`,
	hlsPrefix: `owner/video/.recording/outputs/${exportId}/hls/`,
});

const video = (renderFarmSave: ReturnType<typeof save>) => ({
	id: "video",
	fps: 30,
	metadata: { renderFarmSave },
});

beforeEach(() => {
	mocks.rows = [];
	mocks.jobs.clear();
});

test("a render replaced while it was polled reports the new save, not ready", async () => {
	const first = save("first", "export-1");
	const second = save("second", "export-2");
	mocks.jobs.set("first", {
		state: "ready",
		output: { width: 1920, height: 1080, fps: 30, frames: 300, bytes: 10 },
	});
	mocks.jobs.set("second", { state: "rendering", progress: 0.4 });
	mocks.rows = [video(second), video(second)];

	const status = await refreshRenderFarmSave(video(first) as never);

	expect(status.state).toBe("rendering");
	expect(status.exportId).toBe("export-2");
	expect(status.progress).toBe(0.4);
});
