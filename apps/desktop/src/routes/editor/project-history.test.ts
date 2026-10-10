// @vitest-environment jsdom

import { createRoot } from "solid-js";
import { createStore } from "solid-js/store";
import { describe, expect, it, vi } from "vitest";
import type { EditorProjectConfiguration } from "./context";
import { createStoreHistory, withEditorTimeline } from "./project-history";

vi.mock("solid-js", () => vi.importActual("solid-js/dist/solid.js"));
vi.mock("solid-js/store", () =>
	vi.importActual("solid-js/store/dist/store.js"),
);
vi.mock("solid-js/web", () => vi.importActual("solid-js/web/dist/web.js"));

type Project = { title: string; clips: { start: number; end: number }[] };

function setup() {
	return createRoot((dispose) => {
		const [project, setProject] = createStore<Project>({
			title: "first",
			clips: [{ start: 0, end: 10 }],
		});
		const history = createStoreHistory(project, setProject);
		return { project, setProject, history, dispose };
	});
}

describe("editor project history", () => {
	it("starts with nothing to undo", () => {
		const { history, dispose } = setup();
		expect(history.canUndo()).toBe(false);
		expect(history.canRedo()).toBe(false);
		dispose();
	});

	it("records nothing for a pause that changed nothing", () => {
		const { history, dispose } = setup();
		const resume = history.pause();
		resume();
		expect(history.canUndo()).toBe(false);
		dispose();
	});

	it("records one step for everything written while paused", () => {
		const { project, setProject, history, dispose } = setup();
		const resume = history.pause();
		setProject("clips", 0, "end", 8);
		setProject("clips", 0, "end", 6);
		resume();
		expect(history.canUndo()).toBe(true);
		history.undo();
		expect(project.clips[0]?.end).toBe(10);
		expect(history.canUndo()).toBe(false);
		expect(history.canRedo()).toBe(true);
		history.redo();
		expect(project.clips[0]?.end).toBe(6);
		dispose();
	});

	it("records a step per change and ignores writes of the same value", () => {
		const { project, setProject, history, dispose } = setup();
		setProject("title", "second");
		setProject("clips", [{ start: 0, end: 10 }]);
		history.undo();
		expect(project.title).toBe("first");
		expect(history.canUndo()).toBe(false);
		dispose();
	});

	it("keeps undoing correctly after an undo followed by a new edit", () => {
		const { project, setProject, history, dispose } = setup();
		setProject("title", "second");
		history.undo();
		setProject("title", "third");
		expect(history.canRedo()).toBe(false);
		history.undo();
		expect(project.title).toBe("first");
		expect(history.canUndo()).toBe(false);
		dispose();
	});

	it("records the same edit again after undoing it", () => {
		const { project, setProject, history, dispose } = setup();
		setProject("title", "second");
		history.undo();
		setProject("title", "second");
		expect(history.canRedo()).toBe(false);
		history.undo();
		expect(project.title).toBe("first");
		expect(history.canUndo()).toBe(false);
		dispose();
	});
});

describe("opening a never-edited project", () => {
	const base = {} as EditorProjectConfiguration;

	it("gets the whole recording as one clip before any history exists", () => {
		const project = withEditorTimeline({ ...base, timeline: null }, 12.5);
		expect(project.timeline?.segments).toEqual([
			{ timescale: 1, start: 0, end: 12.5 },
		]);
		expect(project.timeline?.zoomSegments).toEqual([]);
		expect(project.timeline?.transitions).toEqual([]);
	});

	it("keeps an existing timeline and fills only missing tracks", () => {
		const segments = [{ timescale: 1, start: 2, end: 4 }];
		const project = withEditorTimeline(
			{
				...base,
				timeline: {
					segments,
					zoomSegments: [],
				} as unknown as EditorProjectConfiguration["timeline"],
			},
			30,
		);
		expect(project.timeline?.segments).toBe(segments);
		expect(project.timeline?.textSegments).toEqual([]);
		expect(project.timeline?.camera3dSegments).toEqual([]);
	});
});
