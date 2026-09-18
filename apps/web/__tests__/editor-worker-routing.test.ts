import { expect, test } from "vitest";
import {
	editorWorkerForRequest,
	editorWorkerIdFromSessionId,
	orderedEditorWorkers,
	parseEditorWorkerPool,
} from "../lib/editor-worker-routing";

const uuid = "00000000-0000-4000-8000-000000000001";
const pool = JSON.stringify([
	{ id: "east", url: "http://editor-east.internal:3000" },
	{ id: "west", url: "http://editor-west.internal:3000" },
]);

test("a single legacy worker keeps UUID session routing", () => {
	const workers = parseEditorWorkerPool(undefined, "http://127.0.0.1:3000");
	expect(workers).toEqual([{ id: "", origin: "http://127.0.0.1:3000" }]);
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
				{ id: "east", url: "http://editor.internal" },
				{ id: "west", url: "http://editor.internal" },
			]),
			undefined,
		),
	).toThrow("Duplicate editor worker pool entry");
	expect(() =>
		parseEditorWorkerPool(
			JSON.stringify([{ id: "east", url: "http://editor.internal/path" }]),
			undefined,
		),
	).toThrow("Invalid editor worker origin");
});
