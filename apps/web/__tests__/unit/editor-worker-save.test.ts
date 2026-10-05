import { beforeEach, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	rows: [] as unknown[],
	worker: null as unknown,
	fail: vi.fn(async () => undefined),
	attach: vi.fn(async () => true),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/render-farm-start", () => ({
	canSaveEditorVideo: () => true,
	workerSaveSettings: () => ({}),
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
vi.mock("@cap/env", () => ({
	serverEnv: () => ({ MEDIA_SERVER_WEBHOOK_SECRET: "worker-secret" }),
}));
vi.mock("@cap/web-backend", () => ({ Storage: {} }));
vi.mock("@/lib/server", async () => {
	const { Effect } = await import("effect");
	return {
		runPromise: (effect: unknown) => Effect.runPromise(effect as never),
	};
});
vi.mock("@/lib/editor-session", async () => {
	const { Effect } = await import("effect");
	return {
		loadEligibleEditorVideo: vi.fn(),
		verifyOwnedEditorSession: vi.fn(),
		requestMediaEditor: (path: string) =>
			Effect.succeed(
				mocks.worker === "gone"
					? new Response(null, { status: 404 })
					: Response.json({ path, ...(mocks.worker as object) }),
			),
	};
});
vi.mock("@/lib/render-farm-records", () => ({
	attachRenderFarmJob: mocks.attach,
	changeRenderFarmExports: vi.fn(),
	clearRecordingRender: vi.fn(),
	failRenderFarmSave: mocks.fail,
	recordRenderFarmSave: vi.fn(),
	withdrawRenderFarmSave: vi.fn(),
}));

import { POST as callback } from "@/app/api/editor/worker-saves/callback/route";
import {
	parseWorkerSaveState,
	workerSaveCallbackUrl,
	workerSaveOutput,
	workerSaveProgress,
} from "@/lib/editor-worker-save";
import { refreshRenderFarmSave } from "@/lib/render-farm-save";

const published = {
	status: "published",
	progress: { rendered_count: 300, total_frames: 300 },
	size: 4096,
	mediaMetadata: { duration: 10, width: 1920, height: 1080, fps: 30 },
	error: null,
};

const save = (jobId = "worker:job-1") => ({
	version: 1,
	exportId: "save-1",
	jobId,
	status: "rendering",
	startedAt: new Date(Date.now() - 10 * 60_000).toISOString(),
	outputKey: "owner/video/.recording/render/save-1/result.mp4",
	hlsPrefix: "owner/video/.recording/render/save-1/hls",
	worker: { sessionPath: "/editor/sessions/worker-1" },
});

beforeEach(() => {
	mocks.rows = [];
	mocks.worker = null;
	mocks.fail.mockClear();
	mocks.attach.mockClear();
});

test("a worker Save's state maps to the farm's output and progress", () => {
	const state = parseWorkerSaveState(published);
	expect(state && workerSaveOutput(state)).toEqual({
		width: 1920,
		height: 1080,
		fps: 30,
		durationSeconds: 10,
		bytes: 4096,
	});
	const rendering = parseWorkerSaveState({
		status: "rendering",
		progress: { rendered_count: 150, total_frames: 300 },
	});
	expect(rendering && workerSaveProgress(rendering)).toBeCloseTo(0.45);
	expect(rendering && workerSaveOutput(rendering)).toBeNull();
	expect(parseWorkerSaveState({ status: "done" })).toBeNull();
	expect(
		workerSaveCallbackUrl("https://cap-preview.vercel.app", "bypass"),
	).toBe(
		"https://cap-preview.vercel.app/api/editor/worker-saves/callback?x-vercel-protection-bypass=bypass",
	);
	expect(workerSaveCallbackUrl("https://cap.so", "bypass")).toBe(
		"https://cap.so/api/editor/worker-saves/callback",
	);
});

test("a polled worker Save that has uploaded is published like a farm render", async () => {
	mocks.worker = published;
	// Publishing reads the row, here one the callback already published.
	mocks.rows = [
		{
			id: "video",
			metadata: { renderFarmSave: { ...save(), status: "published" } },
		},
	];
	const status = await refreshRenderFarmSave({
		id: "video",
		fps: 30,
		metadata: { renderFarmSave: save() },
	} as never);
	expect(status.state).toBe("ready");
	expect(mocks.rows).toHaveLength(0);
});

test("a worker Save the worker no longer knows fails with a plain message", async () => {
	mocks.worker = "gone";
	const status = await refreshRenderFarmSave({
		id: "video",
		fps: 30,
		metadata: { renderFarmSave: save() },
	} as never);
	expect(status.state).toBe("error");
	expect(status.error).toBe(
		"This save couldn't finish. Try again, or use Download.",
	);
	expect(mocks.fail).toHaveBeenCalledWith(
		"video",
		{ jobId: "worker:job-1" },
		"This save couldn't finish. Try again, or use Download.",
	);
});

test("the worker Save callback needs the worker secret and ignores replaced Saves", async () => {
	const post = (body: unknown, secret?: string) =>
		callback(
			new Request("https://cap.so/api/editor/worker-saves/callback", {
				method: "POST",
				headers: secret ? { "x-media-server-secret": secret } : {},
				body: JSON.stringify(body),
			}),
		);
	const report = {
		...published,
		videoId: "video",
		saveId: "save-1",
		exportId: "job-1",
	};
	expect((await post(report)).status).toBe(401);
	expect((await post(report, "wrong")).status).toBe(401);
	mocks.rows = [{ metadata: { renderFarmSave: save("worker:other") } }];
	expect((await post(report, "worker-secret")).status).toBe(409);
	mocks.rows = [{ metadata: { renderFarmSave: save("") } }];
	expect(
		(await post({ ...report, status: "error" }, "worker-secret")).status,
	).toBe(200);
	expect(mocks.attach).toHaveBeenCalledWith("video", "save-1", "worker:job-1");
	expect(mocks.fail).toHaveBeenCalledWith(
		"video",
		{ jobId: "worker:job-1" },
		"This save couldn't finish. Try again, or use Download.",
	);
});
