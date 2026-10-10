import { Effect } from "effect";
import { expect, test, vi } from "vitest";
import { requestMediaEditor } from "../lib/editor-session";
import {
	editorWorkerForRequest,
	editorWorkerIdFromSessionId,
	orderedEditorWorkers,
	parseEditorWorkerPool,
} from "../lib/editor-worker-routing";

const uuid = "00000000-0000-4000-8000-000000000001";
const pool = JSON.stringify([
	{ id: "east", url: "https://editor-east.internal:3000" },
	{ id: "west", url: "https://editor-west.internal:3000" },
]);

const workerEnvironment = vi.hoisted(() => ({
	MEDIA_SERVER_WEBHOOK_SECRET: "private-worker-secret",
	CAP_WEB_EDITOR_WORKER_URL: "https://editor.example",
	CAP_WEB_EDITOR_WORKER_POOL: undefined as string | undefined,
}));

vi.mock("@cap/env", async (importOriginal) => ({
	...(await importOriginal<typeof import("@cap/env")>()),
	serverEnv: () => workerEnvironment,
}));

test("a single legacy worker keeps UUID session routing", () => {
	const workers = parseEditorWorkerPool(undefined, "http://127.0.0.1:3000");
	expect(workers).toEqual([{ id: "", origin: "http://127.0.0.1:3000" }]);
	expect(parseEditorWorkerPool(undefined, "http://localhost:3000")).toEqual([
		{ id: "", origin: "http://localhost:3000" },
	]);
	expect(parseEditorWorkerPool(undefined, "http://[::1]:3000")).toEqual([
		{ id: "", origin: "http://[::1]:3000" },
	]);
	expect(
		editorWorkerForRequest(workers, `/editor/sessions/${uuid}/instance`),
	).toEqual(workers[0]);
	expect(editorWorkerIdFromSessionId(uuid)).toBe("");
});

test("named sessions stay pinned to their own worker", () => {
	const workers = parseEditorWorkerPool(pool, undefined);
	expect(
		editorWorkerForRequest(
			workers,
			`/editor/sessions/west.${uuid}/exports/job`,
		),
	).toEqual(workers[1]);
	expect(
		editorWorkerForRequest(workers, `/editor/preparations/east.${uuid}`),
	).toEqual(workers[0]);
	expect(
		editorWorkerForRequest(workers, `/editor/sessions/${uuid}/instance`),
	).toBeNull();
	expect(editorWorkerForRequest(workers, "/editor/preparations")).toBeNull();
	expect(
		editorWorkerForRequest(workers, "/editor/preparations", "west"),
	).toEqual(workers[1]);
});

test("worker preference is stable while all workers remain candidates", () => {
	const workers = parseEditorWorkerPool(pool, undefined);
	const first = orderedEditorWorkers(workers, "video-1");
	expect(first.map((worker) => worker.id).sort()).toEqual(["east", "west"]);
	expect(orderedEditorWorkers([...workers].reverse(), "video-1")).toEqual(
		first,
	);
});

test("a pool cannot use one replicated service URL for two live workers", () => {
	expect(() =>
		parseEditorWorkerPool(
			JSON.stringify([
				{ id: "east", url: "https://editor.internal" },
				{ id: "west", url: "https://editor.internal" },
			]),
			undefined,
		),
	).toThrow("Duplicate editor worker pool entry");
	expect(() =>
		parseEditorWorkerPool(
			JSON.stringify([{ id: "east", url: "https://editor.internal/path" }]),
			undefined,
		),
	).toThrow("Invalid editor worker origin");
});

test("remote HTTP worker origins cannot receive the worker secret", async () => {
	const fetchWorker = vi.fn();
	vi.stubGlobal("fetch", fetchWorker);
	try {
		for (const url of [
			"http://editor.example:3000",
			"http://localhost.example:3000",
			"http://192.168.1.10:3000",
		]) {
			workerEnvironment.CAP_WEB_EDITOR_WORKER_URL = url;
			await expect(
				Effect.runPromise(requestMediaEditor("/editor/preparations")),
			).rejects.toBeDefined();
		}
		workerEnvironment.CAP_WEB_EDITOR_WORKER_URL = "https://editor.example";
		workerEnvironment.CAP_WEB_EDITOR_WORKER_POOL = JSON.stringify([
			{ id: "east", url: "http://editor.internal:3000" },
		]);
		await expect(
			Effect.runPromise(requestMediaEditor("/editor/preparations")),
		).rejects.toBeDefined();
		expect(fetchWorker).not.toHaveBeenCalled();
	} finally {
		workerEnvironment.CAP_WEB_EDITOR_WORKER_POOL = undefined;
		workerEnvironment.CAP_WEB_EDITOR_WORKER_URL = "https://editor.example";
		vi.unstubAllGlobals();
	}
});

test("HTTPS worker calls reject redirects before forwarding the secret", async () => {
	const fetchWorker = vi.fn().mockResolvedValue(Response.json({ ready: true }));
	vi.stubGlobal("fetch", fetchWorker);
	try {
		await Effect.runPromise(
			requestMediaEditor("/editor/preparations", { redirect: "follow" }),
		);
		expect(fetchWorker).toHaveBeenCalledOnce();
		expect(fetchWorker.mock.calls[0]?.[0]).toBe(
			"https://editor.example/editor/preparations",
		);
		const request = fetchWorker.mock.calls[0]?.[1] as RequestInit;
		expect(request.redirect).toBe("error");
		expect(new Headers(request.headers).get("x-media-server-secret")).toBe(
			"private-worker-secret",
		);
	} finally {
		vi.unstubAllGlobals();
	}
});
