import { createRoot } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Module = typeof import("./playback-buffering");

async function load(): Promise<Module> {
	vi.resetModules();
	return import("./playback-buffering");
}

function mountPlayer(module: Module) {
	const taken: boolean[] = [];
	const dispose = createRoot((dispose) => {
		module.onPlayRequest((playing) => taken.push(playing));
		return dispose;
	});
	return { taken, dispose };
}

describe("play requests from the loading screen", () => {
	let previousWindow: PropertyDescriptor | undefined;
	beforeEach(() => {
		previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
		Object.defineProperty(globalThis, "window", {
			configurable: true,
			value: new EventTarget(),
		});
	});

	afterEach(() => {
		if (previousWindow)
			Object.defineProperty(globalThis, "window", previousWindow);
		else Reflect.deleteProperty(globalThis, "window");
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
		module.requestPlayWhenReady(true);
		module.clearPlayRequest();
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
