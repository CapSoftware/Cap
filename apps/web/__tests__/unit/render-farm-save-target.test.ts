import { afterEach, beforeEach, expect, test, vi } from "vitest";

const env = vi.hoisted(() => ({
	value: {} as Record<string, string | undefined>,
}));

vi.mock("@cap/env", () => ({ serverEnv: () => env.value }));

const farm = {
	RENDER_FARM_URL: "https://render.example",
	RENDER_FARM_TOKEN: "token",
	RENDER_FARM_CALLBACK_SECRET: "secret",
};
const prepare = { version: 1, defaultConfig: { audio: {} }, music: [] };

async function startModule() {
	vi.resetModules();
	return import("@/lib/render-farm-start");
}

beforeEach(() => {
	env.value = {};
});

afterEach(() => vi.unstubAllGlobals());

test("Save can't use the farm when it is not configured", async () => {
	const health = vi.fn(async () =>
		Response.json({ ok: true, workers: 3, prepare }),
	);
	vi.stubGlobal("fetch", health);
	const { renderFarmSaveUnavailable } = await startModule();
	expect(await renderFarmSaveUnavailable()).toBe(
		"The render farm is not configured",
	);
	expect(health).not.toHaveBeenCalled();
	env.value = { ...farm, RENDER_FARM_CALLBACK_SECRET: undefined };
	expect(await (await startModule()).renderFarmSaveUnavailable()).toBe(
		"The render farm is not configured",
	);
});

test("Save uses the farm only when it reports workers and prepares projects", async () => {
	env.value = { ...farm };
	const health = vi.fn(async (_url: string, init?: RequestInit) => {
		expect(new Headers(init?.headers).get("authorization")).toBe(
			"Bearer token",
		);
		return Response.json({ ok: true, workers: 3, prepare });
	});
	vi.stubGlobal("fetch", health);
	expect(await (await startModule()).renderFarmSaveUnavailable()).toBeNull();
	expect(health).toHaveBeenCalledWith(
		"https://render.example/health",
		expect.anything(),
	);

	vi.stubGlobal(
		"fetch",
		vi.fn(async () => Response.json({ ok: true, workers: 3 })),
	);
	expect(await (await startModule()).renderFarmSaveUnavailable()).toBe(
		"The render farm can't prepare projects",
	);

	vi.stubGlobal(
		"fetch",
		vi.fn(async () => Response.json({ ok: true, workers: 0, prepare })),
	);
	expect(await (await startModule()).renderFarmSaveUnavailable()).toBe(
		"The render farm is not responding",
	);

	vi.stubGlobal(
		"fetch",
		vi.fn(async () => {
			throw new TypeError("fetch failed");
		}),
	);
	expect(await (await startModule()).renderFarmSaveUnavailable()).toBe(
		"The render farm is not responding",
	);
});

test("Save renders in the browser whenever the farm can't take it", async () => {
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => Response.json({ ok: true, workers: 0 })),
	);
	env.value = { ...farm };
	expect(await (await startModule()).editorSaveRenderer(true)).toEqual({
		renderer: "browser",
		reason: "The render farm is not responding",
	});
	env.value = {};
	expect(await (await startModule()).editorSaveRenderer(true)).toEqual({
		renderer: "browser",
		reason: "The render farm is not configured",
	});
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => Response.json({ ok: true, workers: 2, prepare })),
	);
	env.value = { ...farm };
	expect(await (await startModule()).editorSaveRenderer(false)).toEqual({
		renderer: "browser",
		reason: "The render farm can't prepare this project",
	});
	expect(await (await startModule()).editorSaveRenderer(true)).toEqual({
		renderer: "farm",
		reason: null,
	});
});
