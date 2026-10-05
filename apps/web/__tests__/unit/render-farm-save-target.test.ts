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
const worker = {
	CAP_WEB_EDITOR_WORKER_URL: "https://editor.example",
	MEDIA_SERVER_WEBHOOK_SECRET: "media-secret",
};

async function saveTarget() {
	vi.resetModules();
	const { renderFarmSaveUnavailable } = await import("@/lib/render-farm-start");
	return renderFarmSaveUnavailable();
}

beforeEach(() => {
	env.value = {};
});

afterEach(() => vi.unstubAllGlobals());

test("Save can't use the farm when it or an editor worker is not configured", async () => {
	const health = vi.fn(async () => Response.json({ ok: true, workers: 3 }));
	vi.stubGlobal("fetch", health);
	expect(await saveTarget()).toBe("The render farm is not configured");
	expect(health).not.toHaveBeenCalled();
	env.value = { ...farm };
	expect(await saveTarget()).toBe("No editor worker is configured");
	env.value = { ...farm, CAP_WEB_EDITOR_WORKER_POOL: "not json" };
	expect(await saveTarget()).toBe("No editor worker is configured");
});

test("Save needs no editor worker when the farm prepares projects itself", async () => {
	env.value = { ...farm };
	vi.stubGlobal(
		"fetch",
		vi.fn(async () =>
			Response.json({
				ok: true,
				workers: 3,
				prepare: { version: 1, defaultConfig: { audio: {} }, music: [] },
			}),
		),
	);
	expect(await saveTarget()).toBeNull();
});

test("Save uses the farm only while its health check reports workers", async () => {
	env.value = { ...farm, ...worker };
	const health = vi.fn(async (_url: string, init?: RequestInit) => {
		expect(new Headers(init?.headers).get("authorization")).toBe(
			"Bearer token",
		);
		return Response.json({ ok: true, workers: 3 });
	});
	vi.stubGlobal("fetch", health);
	expect(await saveTarget()).toBeNull();
	expect(health).toHaveBeenCalledWith(
		"https://render.example/health",
		expect.anything(),
	);

	vi.stubGlobal(
		"fetch",
		vi.fn(async () => Response.json({ ok: true, workers: 0 })),
	);
	expect(await saveTarget()).toBe("The render farm is not responding");

	vi.stubGlobal(
		"fetch",
		vi.fn(async () => {
			throw new TypeError("fetch failed");
		}),
	);
	expect(await saveTarget()).toBe("The render farm is not responding");
});

test("Save goes to an editor worker when the farm is down, and nowhere when neither is there", async () => {
	const target = async () => {
		vi.resetModules();
		const { editorSaveRenderer } = await import("@/lib/render-farm-start");
		return editorSaveRenderer(true);
	};
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => Response.json({ ok: true, workers: 0 })),
	);
	env.value = { ...farm, ...worker };
	expect(await target()).toEqual({
		renderer: "worker",
		reason: "The render farm is not responding",
		direct: false,
	});
	env.value = { ...farm };
	expect(await target()).toBeNull();
	env.value = { ...worker };
	expect(await target()).toEqual({
		renderer: "worker",
		reason: "The render farm is not configured",
		direct: false,
	});
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => Response.json({ ok: true, workers: 2 })),
	);
	env.value = { ...farm, ...worker };
	expect(await target()).toEqual({
		renderer: "farm",
		reason: null,
		direct: false,
	});
});
