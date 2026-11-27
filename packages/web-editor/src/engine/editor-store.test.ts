import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, expect, test } from "vitest";
import { EditorStore, setEditorStoreNamespace } from "./editor-store";

type AudioEnhancement = {
	enabledByDefault: boolean;
	isolation: string;
};

let saved: AudioEnhancement = { enabledByDefault: true, isolation: "balanced" };
let failSave = false;
let server: Server;
let previousLocation: PropertyDescriptor | undefined;

beforeAll(async () => {
	server = createServer((request, response) => {
		if (request.url !== "/api/editor/preferences/studio-sound") {
			response.writeHead(404).end();
			return;
		}
		let body = "";
		request.on("data", (chunk) => {
			body += chunk;
		});
		request.on("end", () => {
			if (request.method === "PUT") {
				if (failSave) {
					response.writeHead(503).end();
					return;
				}
				saved = JSON.parse(body);
			}
			response.writeHead(200, { "Content-Type": "application/json" });
			response.end(JSON.stringify(saved));
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as AddressInfo;
	previousLocation = Object.getOwnPropertyDescriptor(globalThis, "location");
	Object.defineProperty(globalThis, "location", {
		configurable: true,
		value: new URL(`http://127.0.0.1:${port}/editor/`),
	});
});

afterAll(async () => {
	if (previousLocation)
		Object.defineProperty(globalThis, "location", previousLocation);
	else Reflect.deleteProperty(globalThis, "location");
	await new Promise<void>((resolve) => server.close(() => resolve()));
});

test("Studio Sound persists partial isolation updates across reloads and failed saves", async () => {
	setEditorStoreNamespace("studio-sound-store-test");
	const store = await EditorStore.load("store");
	expect(await store.get<AudioEnhancement>("audio_enhancement")).toEqual(saved);
	await store.set("audio_enhancement", {
		enabledByDefault: false,
		isolation: "strong",
	});
	await store.reload();
	expect(await store.get<AudioEnhancement>("audio_enhancement")).toEqual({
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
	expect(await store.get<AudioEnhancement>("audio_enhancement")).toEqual({
		enabledByDefault: false,
		isolation: "light",
	});
});
