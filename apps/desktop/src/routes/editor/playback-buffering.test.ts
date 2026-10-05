import { createRoot } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("solid-js", () => vi.importActual("solid-js/dist/solid.js"));

type Module = typeof import("./playback-buffering");

async function load(): Promise<Module> {
	vi.resetModules();
	return import("./playback-buffering");
}

/// Mounts an editor's player the way Player.tsx takes a loading-screen press.
function mountPlayer(module: Module) {
	const taken: boolean[] = [];
	const dispose = createRoot((dispose) => {
		module.onPlayRequest((playing) => taken.push(playing));
		return dispose;
	});
	return { taken, dispose };
}

describe("play requests from the loading screen", () => {
	beforeEach(() => {
		vi.stubGlobal("window", new EventTarget());
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("hands a press made while loading to the editor once it mounts", async () => {
		const module = await load();
		module.requestPlayWhenReady(true);
		const player = mountPlayer(module);
		expect(player.taken).toEqual([true]);
		player.dispose();
	});

	it("forgets a press when its editor attempt ends before a player takes it", async () => {
		const module = await load();
		const shownPress = () =>
			createRoot((dispose) => {
				const value = module.createPlayRequested()();
				dispose();
				return value;
			});
		module.requestPlayWhenReady(true);
		expect(shownPress()).toBe(true);
		// The attempt fails or is torn down before its player mounts.
		module.clearPlayRequest();
		// The retry's loading screen shows Play, not a press still waiting...
		expect(shownPress()).toBe(false);
		// ...and its player doesn't start playing on its own.
		const player = mountPlayer(module);
		expect(player.taken).toEqual([]);
		player.dispose();
	});

	it("still takes a press made after the attempt was cleared", async () => {
		const module = await load();
		module.requestPlayWhenReady(true);
		module.clearPlayRequest();
		module.requestPlayWhenReady(true);
		const player = mountPlayer(module);
		expect(player.taken).toEqual([true]);
		player.dispose();
	});
});
