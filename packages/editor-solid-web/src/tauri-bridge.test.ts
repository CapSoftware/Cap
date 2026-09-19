import { expect, test } from "bun:test";
import { createStore } from "solid-js/store";
import {
	commands,
	events,
	PortEditorTransport,
	setEditorTransport,
} from "./tauri-bridge";
import { Channel } from "./tauri-core";
import { Store, setEditorStoreNamespace } from "./tauri-store";
import { setEditorFrameSocketCredential } from "./websocket";

test("desktop commands and events cross the editor port", async () => {
	const channel = new MessageChannel();
	const transport = new PortEditorTransport(channel.port1);
	setEditorTransport(transport);
	const requests: string[] = [];
	channel.port2.onmessage = (event: MessageEvent<unknown>) => {
		const message = event.data as Record<string, unknown>;
		requests.push(String(message.name));
		channel.port2.postMessage({
			kind: "result",
			id: message.id,
			value: message.name === "getEditorProjectPath" ? "project.cap" : null,
		});
	};
	channel.port2.start();
	try {
		expect(await commands.getEditorProjectPath()).toBe("project.cap");
		const playhead = new Promise<number>((resolve) => {
			void events.editorStateChanged.once(({ payload }) =>
				resolve(payload.playhead_position),
			);
		});
		channel.port2.postMessage({
			kind: "event",
			name: "editorStateChanged",
			payload: { playhead_position: 1800 },
		});
		expect(await playhead).toBe(1800);
		await events.renderFrameEvent.emit({
			frame_number: 1800,
			fps: 30,
			resolution_base: { x: 960, y: 540 },
		});
		expect(requests).toEqual(["getEditorProjectPath", "renderFrameEvent"]);
	} finally {
		setEditorTransport(null);
		channel.port2.close();
	}
});

test("closing the editor port rejects unfinished commands", async () => {
	const channel = new MessageChannel();
	const transport = new PortEditorTransport(channel.port1);
	const unfinished = transport.invoke("getEditorMeta", []);
	transport.dispose();
	await expect(unfinished).rejects.toThrow("Editor bridge is closed");
	channel.port2.close();
});

test("crop frames cross the editor port as compact JPEG bytes", async () => {
	const channel = new MessageChannel();
	const transport = new PortEditorTransport(channel.port1);
	let valid = true;
	const requests: Array<{ name: string; args: unknown[] }> = [];
	channel.port2.onmessage = (event: MessageEvent<unknown>) => {
		const request = event.data as { id: number; name: string; args: unknown[] };
		requests.push({ name: request.name, args: request.args });
		channel.port2.postMessage({
			kind: "result",
			id: request.id,
			value: { jpegBase64: valid ? "/9j/2Q==" : "bm90IGEganBlZw==" },
		});
	};
	channel.port2.start();
	try {
		expect(
			await transport.invoke("performHapticFeedback", ["alignment", null]),
		).toBeNull();
		expect(requests).toEqual([]);
		const jpeg = await transport.invoke("getDisplayFrameForCropping", [60]);
		expect(jpeg).toBeInstanceOf(Uint8Array);
		expect(Array.from(jpeg as Uint8Array)).toEqual([255, 216, 255, 217]);
		await Bun.sleep(0);
		valid = false;
		await expect(
			transport.invoke("getDisplayFrameForCropping", [60]),
		).rejects.toThrow("Crop frame response is not a JPEG");
		expect(requests).toEqual([
			{ name: "getDisplayFrameForCropping", args: [60] },
			{ name: "getDisplayFrameForCropping", args: [60] },
		]);
	} finally {
		transport.dispose();
		channel.port2.close();
	}
});

test("reactive Solid project values are serialized before crossing the port", async () => {
	const channel = new MessageChannel();
	const transport = new PortEditorTransport(channel.port1);
	const [project] = createStore({ background: { padding: 12 } });
	channel.port2.onmessage = (event: MessageEvent<unknown>) => {
		const message = event.data as { id: number; args: unknown[] };
		expect(message.args).toEqual([{ background: { padding: 12 } }]);
		channel.port2.postMessage({ kind: "result", id: message.id, value: null });
	};
	channel.port2.start();
	try {
		await expect(transport.invoke("setProjectConfig", [project])).resolves.toBe(
			null,
		);
	} finally {
		transport.dispose();
		channel.port2.close();
	}
});

test("two-hour captions cross the port once and reuse their payload during camera edits", async () => {
	const channel = new MessageChannel();
	const transport = new PortEditorTransport(channel.port1);
	const segments = Array.from({ length: 3_000 }, (_, index) => ({
		id: `segment-${index}`,
		text: "A useful recording process",
		start: index * 2.4,
		end: index * 2.4 + 2.2,
		words: Array.from({ length: 6 }, (_, wordIndex) => ({
			text: "recording",
			start: index * 2.4 + wordIndex * 0.4,
			end: index * 2.4 + wordIndex * 0.4 + 0.3,
		})),
	}));
	const project = {
		captions: { sourceTimed: true, segments },
		timeline: { captionSegments: segments },
		camera: { mirror: false },
	};
	const requests: Array<{ name: string; args: unknown[] }> = [];
	let rejectCompactSave = false;
	channel.port2.onmessage = (event: MessageEvent<unknown>) => {
		const message = event.data as {
			id: number;
			name: string;
			args: unknown[];
		};
		requests.push({ name: message.name, args: message.args });
		const config = message.args[0] as Record<string, unknown>;
		if (
			rejectCompactSave &&
			message.name === "setProjectConfig" &&
			"webCaptionRef" in config
		) {
			rejectCompactSave = false;
			channel.port2.postMessage({
				kind: "error",
				id: message.id,
				error: "Caption payload cache is unavailable",
			});
			return;
		}
		channel.port2.postMessage({ kind: "result", id: message.id, value: null });
	};
	channel.port2.start();
	try {
		const cameraEdit = { ...project, camera: { mirror: true } };
		await transport.invoke("updateProjectConfigInMemory", [
			project,
			null,
			null,
			null,
		]);
		await transport.invoke("updateProjectConfigInMemory", [
			cameraEdit,
			null,
			null,
			null,
		]);
		await transport.invoke("setProjectConfig", [project]);
		await transport.invoke("setProjectConfig", [cameraEdit]);
		const full = requests[0]?.args[0] as Record<string, unknown>;
		const reusedPreview = requests[1]?.args[0] as Record<string, unknown>;
		const reusedSave = requests[3]?.args[0] as Record<string, unknown>;
		expect(JSON.stringify(full).length).toBeGreaterThan(512 * 1024);
		expect(JSON.stringify(reusedPreview).length).toBeLessThan(
			JSON.stringify(full).length / 20,
		);
		expect(reusedPreview.webCaptionRef).toHaveLength(64);
		expect(reusedSave.webCaptionRef).toBe(reusedPreview.webCaptionRef);
		rejectCompactSave = true;
		await transport.invoke("setProjectConfig", [cameraEdit]);
		expect(requests[4]?.args[0]).toHaveProperty("webCaptionRef");
		expect(requests[5]?.args[0]).not.toHaveProperty("webCaptionRef");
	} finally {
		transport.dispose();
		channel.port2.close();
	}
});

test("export progress reaches the desktop callback and releases its channel", async () => {
	const channel = new MessageChannel();
	const transport = new PortEditorTransport(channel.port1);
	const progress: Array<{ rendered_count: number; total_frames: number }> = [];
	const callback = new Channel<{
		rendered_count: number;
		total_frames: number;
	}>((value) => progress.push(value));
	channel.port2.onmessage = (event: MessageEvent<unknown>) => {
		const request = event.data as { id: number; args: unknown[] };
		expect(request.args[1]).toBe(`__CHANNEL__:${callback.id}`);
		channel.port2.postMessage({
			kind: "channel",
			id: callback.id,
			value: { rendered_count: 2, total_frames: 3 },
		});
		channel.port2.postMessage({
			kind: "result",
			id: request.id,
			value: "screen.mp4",
		});
	};
	channel.port2.start();
	try {
		await expect(
			transport.invoke("exportVideoToFile", [
				"project.cap",
				callback,
				{ format: "Mp4" },
				"screen.mp4",
				"mp4",
			]),
		).resolves.toBe("screen.mp4");
		expect(progress).toEqual([{ rendered_count: 2, total_frames: 3 }]);
		channel.port2.postMessage({
			kind: "channel",
			id: callback.id,
			value: { rendered_count: 3, total_frames: 3 },
		});
		await Bun.sleep(0);
		expect(progress).toHaveLength(1);
	} finally {
		transport.dispose();
		channel.port2.close();
	}
});

test("an editor instance installs its fresh frame ticket before returning the desktop shape", async () => {
	const channel = new MessageChannel();
	const transport = new PortEditorTransport(channel.port1);
	let valid = true;
	channel.port2.onmessage = (event: MessageEvent<unknown>) => {
		const request = event.data as { id: number };
		channel.port2.postMessage({
			kind: "result",
			id: request.id,
			value: valid
				? {
						instanceId: "fixture",
						framesSocketUrl:
							"wss://editor.cap.so/editor/sessions/fixture/frames",
						frameSocketTicket: "a".repeat(43),
					}
				: {
						instanceId: "fixture",
						framesSocketUrl:
							"wss://editor.cap.so/editor/sessions/fixture/frames",
					},
		});
	};
	channel.port2.start();
	try {
		await expect(transport.invoke("createEditorInstance", [])).resolves.toEqual(
			{
				instanceId: "fixture",
				framesSocketUrl: "wss://editor.cap.so/editor/sessions/fixture/frames",
			},
		);
		valid = false;
		await expect(transport.invoke("createEditorInstance", [])).rejects.toThrow(
			"Editor frame socket ticket is missing",
		);
	} finally {
		transport.dispose();
		channel.port2.close();
		setEditorFrameSocketCredential(null);
	}
});

test("auto zoom uses the same saved default zoom amount as the desktop editor", async () => {
	const previousStorage = globalThis.localStorage;
	const saved = new Map<string, string>();
	Object.defineProperty(globalThis, "localStorage", {
		configurable: true,
		value: {
			getItem: (key: string) => saved.get(key) ?? null,
			setItem: (key: string, value: string) => saved.set(key, value),
			removeItem: (key: string) => saved.delete(key),
		},
	});
	setEditorStoreNamespace("auto-zoom-fixture");
	const channel = new MessageChannel();
	const transport = new PortEditorTransport(channel.port1);
	let sentArgs: unknown[] = [];
	let receivedArgs = false;
	channel.port2.onmessage = (event: MessageEvent<unknown>) => {
		const message = event.data as { id: number; args: unknown[] };
		sentArgs = message.args;
		receivedArgs = true;
		channel.port2.postMessage({ kind: "result", id: message.id, value: [] });
	};
	channel.port2.start();
	try {
		await (await Store.load("store")).set("general_settings", {
			defaultZoomAmount: 1.8,
		});
		await transport.invoke("generateZoomSegmentsFromClicks", []);
		expect(receivedArgs).toBe(true);
		expect(sentArgs).toEqual([1.8]);
	} finally {
		transport.dispose();
		channel.port2.close();
		setEditorStoreNamespace("anonymous");
		if (previousStorage === undefined) {
			Reflect.deleteProperty(globalThis, "localStorage");
		} else {
			Object.defineProperty(globalThis, "localStorage", {
				configurable: true,
				value: previousStorage,
			});
		}
	}
});
