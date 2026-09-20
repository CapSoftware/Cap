import { expect, test } from "bun:test";
import { Store, setEditorStoreNamespace } from "./tauri-store";

test("Studio Sound persists partial isolation updates across reloads and failed saves", async () => {
	setEditorStoreNamespace("studio-sound-store-test");
	const store = await Store.load("store");
	const originalFetch = globalThis.fetch;
	let saved = { enabledByDefault: true, isolation: "balanced" };
	let failSave = false;
	globalThis.fetch = async (_input, options) => {
		if (options?.method === "PUT") {
			if (failSave) return new Response(null, { status: 503 });
			saved = JSON.parse(String(options.body));
		}
		return Response.json(saved);
	};
	try {
		expect(await store.get("audio_enhancement")).toEqual(saved);
		await store.set("audio_enhancement", {
			enabledByDefault: false,
			isolation: "strong",
		});
		await store.reload();
		expect(await store.get("audio_enhancement")).toEqual({
			enabledByDefault: false,
			isolation: "strong",
		});
		await store.set("audio_enhancement", { isolation: "light" });
		expect(saved).toEqual({ enabledByDefault: false, isolation: "light" });
		failSave = true;
		await expect(
			store.set("audio_enhancement", {
				enabledByDefault: true,
				isolation: "light",
			}),
		).rejects.toThrow();
		expect(await store.get("audio_enhancement")).toEqual({
			enabledByDefault: false,
			isolation: "light",
		});
	} finally {
		globalThis.fetch = originalFetch;
	}
});
