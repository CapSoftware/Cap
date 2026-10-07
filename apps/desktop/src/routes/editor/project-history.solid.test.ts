import { createRoot } from "solid-js";
import { createStore } from "solid-js/store";
import { describe, expect, it } from "vitest";
import { createStoreHistory } from "./project-history";

function setup() {
	return createRoot((dispose) => {
		const [state, setState] = createStore({ aspect: "9:16", zooms: 0 });
		const history = createStoreHistory(state, setState);
		history.canUndo();
		return { state, setState, history, dispose };
	});
}

const pointer = (type: string, pointerId: number, buttons = 0) =>
	window.dispatchEvent(Object.assign(new Event(type), { pointerId, buttons }));

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

const edit = (ctx: ReturnType<typeof setup>, change: () => void) => {
	change();
	ctx.history.canUndo();
};

describe("project history", () => {
	it("undoes one edit at a time", () => {
		const ctx = setup();
		edit(ctx, () => ctx.setState("aspect", "16:9"));
		edit(ctx, () => ctx.setState("zooms", 1));
		edit(ctx, () => ctx.setState("zooms", 2));

		ctx.history.undo();
		expect(ctx.state).toEqual({ aspect: "16:9", zooms: 1 });
		ctx.history.undo();
		expect(ctx.state).toEqual({ aspect: "16:9", zooms: 0 });
		ctx.history.redo();
		expect(ctx.state).toEqual({ aspect: "16:9", zooms: 1 });
		ctx.dispose();
	});

	it("keeps the current edits redoable when a pause was leaked", () => {
		const ctx = setup();
		edit(ctx, () => ctx.setState("aspect", "16:9"));
		ctx.history.pause();
		edit(ctx, () => ctx.setState("zooms", 5));

		ctx.history.undo();
		expect(ctx.state).toEqual({ aspect: "16:9", zooms: 0 });
		ctx.history.redo();
		expect(ctx.state).toEqual({ aspect: "16:9", zooms: 5 });
		ctx.dispose();
	});

	it("ends pauses taken during a pointer press when the press ends", async () => {
		const ctx = setup();
		window.dispatchEvent(new Event("pointerdown"));
		ctx.history.pause();
		edit(ctx, () => ctx.setState("zooms", 1));
		window.dispatchEvent(new Event("pointerup"));
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(ctx.history.isPaused()).toBe(false);

		edit(ctx, () => ctx.setState("zooms", 2));
		ctx.history.undo();
		expect(ctx.state.zooms).toBe(1);
		ctx.dispose();
	});

	it("keeps resume idempotent", () => {
		const ctx = setup();
		const resumeA = ctx.history.pause();
		const resumeB = ctx.history.pause();
		resumeA();
		resumeA();
		expect(ctx.history.isPaused()).toBe(true);
		resumeB();
		expect(ctx.history.isPaused()).toBe(false);
		ctx.dispose();
	});

	it("keeps a pointer pause until every pointer is released", async () => {
		const ctx = setup();
		pointer("pointerdown", 1, 1);
		ctx.history.pause();
		pointer("pointerdown", 2, 1);
		expect(ctx.history.isPaused()).toBe(true);
		pointer("pointerup", 2);
		await tick();
		expect(ctx.history.isPaused()).toBe(true);
		pointer("pointerup", 1);
		await tick();
		expect(ctx.history.isPaused()).toBe(false);
		ctx.dispose();
	});

	it("ends a pointer pause whose release happened outside the window", async () => {
		const ctx = setup();
		pointer("pointerdown", 1, 1);
		ctx.history.pause();
		pointer("pointermove", 1, 0);
		await tick();
		expect(ctx.history.isPaused()).toBe(false);
		ctx.dispose();
	});

	it("ignores buttonless moves from other pointers during a drag", async () => {
		const ctx = setup();
		pointer("pointerdown", 7, 1);
		ctx.history.pause();
		pointer("pointermove", 1, 0);
		await tick();
		expect(ctx.history.isPaused()).toBe(true);
		pointer("pointerup", 7);
		await tick();
		expect(ctx.history.isPaused()).toBe(false);
		ctx.dispose();
	});

	it("only offers undo during a pause once something changed", () => {
		const ctx = setup();
		ctx.history.pause();
		expect(ctx.history.canUndo()).toBe(false);
		ctx.setState("zooms", 3);
		expect(ctx.history.canUndo()).toBe(true);
		ctx.dispose();
	});
});
