import { afterEach, beforeEach, expect, test, vi } from "vitest";

const state = vi.hoisted(() => ({
	afters: [] as Promise<unknown>[],
	sources: [] as string[],
	direct: "started" as string | Error,
	workflowStarts: 0,
	cleared: 0,
}));

vi.mock("@cap/database", () => ({
	db: () => ({
		select: () => ({
			from: () => ({
				innerJoin: () => ({
					leftJoin: () => ({
						where: async () => [
							{
								video: {
									id: "video",
									ownerId: "owner",
									isScreenshot: false,
									source: { type: "webMP4" },
									duration: 10,
									metadata: {
										editorSources: {
											version: 1,
											display: { key: "k", size: 1 },
										},
									},
								},
								owner: { email: "owner@cap.so" },
								uploadPhase: null,
							},
						],
					}),
				}),
			}),
		}),
	}),
}));
vi.mock("@cap/database/schema", () => ({
	users: {},
	videos: {},
	videoUploads: {},
}));
vi.mock("@cap/utils", () => ({ userIsPro: () => true }));
vi.mock("drizzle-orm", () => ({ eq: () => ({}) }));
vi.mock("next/server", () => ({
	after: (task: () => Promise<unknown>) => {
		state.afters.push(task());
	},
}));
vi.mock("workflow/api", () => ({
	start: async () => {
		state.workflowStarts++;
	},
}));
vi.mock("@/lib/render-farm", () => ({
	renderFarmConfig: () => ({ callbackSecret: "secret" }),
	renderFarmKeys: () => ({ outputKey: "out", hlsPrefix: "hls" }),
}));
vi.mock("@/lib/render-farm-records", () => ({
	recordPendingRecordingRender: async () => true,
	clearRecordingRender: async () => {
		state.cleared++;
	},
}));
vi.mock("@/lib/web-studio-rollout", () => ({
	isWebStudioEnabledForEmail: () => true,
}));
vi.mock("@/lib/render-recording-workflow", () => ({
	renderRecordingWorkflow: () => undefined,
}));
vi.mock("@/lib/render-recording-start", () => ({
	recordingSourcesState: async () => state.sources.shift() ?? "ready",
	startRecordingRenderDirectly: async () => {
		if (state.direct instanceof Error) throw state.direct;
		return state.direct;
	},
}));

const { startRecordingRender } = await import("@/lib/render-recording");

async function run() {
	expect(await startRecordingRender("video" as never, "https://cap.test")).toBe(
		true,
	);
	await Promise.all(state.afters);
}

beforeEach(() => {
	state.afters = [];
	state.sources = [];
	state.direct = "started";
	state.workflowStarts = 0;
	state.cleared = 0;
	vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
});

test("a recording whose sources are in starts from the upload, without the workflow", async () => {
	await run();
	expect(state.workflowStarts).toBe(0);
});

test("a source landing a moment later is waited for", async () => {
	state.sources = ["waiting", "waiting", "ready"];
	await run();
	expect(state.workflowStarts).toBe(0);
});

test("a recording only an editor worker can prepare goes to the workflow", async () => {
	state.direct = "unsupported";
	await run();
	expect(state.workflowStarts).toBe(1);
});

test("a failed inline start hands over to the workflow", async () => {
	state.direct = new Error("farm unreachable");
	await run();
	expect(state.workflowStarts).toBe(1);
	expect(state.cleared).toBe(0);
});

test("sources still uploading after the wait go to the workflow", async () => {
	vi.useFakeTimers();
	state.sources = Array.from({ length: 1000 }, () => "waiting");
	const started = startRecordingRender("video" as never, "https://cap.test");
	await vi.advanceTimersByTimeAsync(6_000);
	expect(await started).toBe(true);
	await vi.advanceTimersByTimeAsync(6_000);
	await Promise.all(state.afters);
	expect(state.workflowStarts).toBe(1);
});

test("a replaced render starts nothing", async () => {
	state.sources = ["superseded"];
	await run();
	expect(state.workflowStarts).toBe(0);
});
