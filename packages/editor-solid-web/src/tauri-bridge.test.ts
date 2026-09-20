import { expect, test } from "bun:test";
import { $PROXY } from "solid-js";
import { createStore, produce } from "solid-js/store";
import { EditorCaptionCacheMemo } from "./caption-cache-memo";
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

test("late plan replies cannot reopen paid caption controls", async () => {
	const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
	const browserWindow = Object.assign(new EventTarget(), {
		capWebEditorCaptionsEnabled: true,
	});
	Object.defineProperty(globalThis, "window", {
		configurable: true,
		value: browserWindow,
	});
	let planEvents = 0;
	browserWindow.addEventListener("cap-web-editor-captions-plan", () => {
		planEvents++;
	});
	const channel = new MessageChannel();
	const transport = new PortEditorTransport(channel.port1);
	const requestIds: number[] = [];
	channel.port2.onmessage = (event: MessageEvent<unknown>) => {
		const request = event.data as { id: number };
		requestIds.push(request.id);
	};
	channel.port2.start();
	try {
		const first = transport.invoke("checkUpgradedAndUpdate", []);
		const second = transport.invoke("checkUpgradedAndUpdate", []);
		await Bun.sleep(0);
		expect(requestIds).toHaveLength(2);
		channel.port2.postMessage({
			kind: "result",
			id: requestIds[1],
			value: false,
		});
		expect(await second).toBe(false);
		expect(browserWindow.capWebEditorCaptionsEnabled).toBe(false);
		channel.port2.postMessage({
			kind: "result",
			id: requestIds[0],
			value: true,
		});
		expect(await first).toBe(true);
		expect(browserWindow.capWebEditorCaptionsEnabled).toBe(false);
		expect(planEvents).toBe(1);
	} finally {
		transport.dispose();
		channel.port2.close();
		if (previousWindow)
			Object.defineProperty(globalThis, "window", previousWindow);
		else Reflect.deleteProperty(globalThis, "window");
	}
});

test("Free preview updates and saves omit paid captions but keep video edits", async () => {
	const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
	Object.defineProperty(globalThis, "window", {
		configurable: true,
		value: { capWebEditorCaptionsEnabled: false },
	});
	const channel = new MessageChannel();
	const transport = new PortEditorTransport(channel.port1);
	const requests: Array<{ name: string; args: unknown[] }> = [];
	channel.port2.onmessage = (event: MessageEvent<unknown>) => {
		const request = event.data as {
			id: number;
			name: string;
			args: unknown[];
		};
		requests.push({ name: request.name, args: request.args });
		channel.port2.postMessage({ kind: "result", id: request.id, value: null });
	};
	channel.port2.start();
	const source = {
		camera: { mirror: true },
		captions: {
			segments: [{ id: "word", text: "Paid" }],
			settings: { enabled: true, exportWithSubtitles: true },
		},
		timeline: {
			segments: [{ start: 2, end: 8 }],
			captionSegments: [{ id: "word" }],
		},
	};
	try {
		await transport.invoke("updateProjectConfigInMemory", [
			source,
			null,
			null,
			null,
		]);
		await transport.invoke("setProjectConfig", [source]);
		for (const request of requests) {
			expect(request.args[0]).toMatchObject({
				camera: { mirror: true },
				captions: {
					segments: [],
					settings: { enabled: false, exportWithSubtitles: false },
				},
				timeline: { segments: [{ start: 2, end: 8 }], captionSegments: [] },
			});
		}
		expect(source.captions.segments).toHaveLength(1);
		expect(requests.map((request) => request.name)).toEqual([
			"updateProjectConfigInMemory",
			"setProjectConfig",
		]);
		expect(requests[1]?.args[1]).toBe(true);
	} finally {
		transport.dispose();
		channel.port2.close();
		if (previousWindow)
			Object.defineProperty(globalThis, "window", previousWindow);
		else Reflect.deleteProperty(globalThis, "window");
	}
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

function longCaptionSegments(count: number) {
	return Array.from({ length: count }, (_, index) => ({
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
}

test("two-hour captions cross the port once and reuse their payload during camera edits", async () => {
	const channel = new MessageChannel();
	const transport = new PortEditorTransport(channel.port1);
	const segments = longCaptionSegments(3_000);
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

test("browser Solid caption cache reuses camera and style edits but invalidates caption words", async () => {
	const segments = longCaptionSegments(800);
	const [project, setProject] = createStore({
		captions: { segments },
		timeline: {
			captionSegments: segments.map((segment) => ({
				...segment,
				words: segment.words.map((word) => ({ ...word })),
			})),
			styleSegments: [{ opacity: 1 }],
		},
		camera: { mirror: false },
	});
	if (!($PROXY in project.captions.segments)) return;
	const cache = new EditorCaptionCacheMemo();
	try {
		const first = cache.get(project);
		const firstValue = await first;
		if (!firstValue) throw new Error("Long caption cache was unavailable");
		setProject("camera", "mirror", true);
		setProject("timeline", "styleSegments", 0, "opacity", 0.5);
		expect(cache.get(project)).toBe(first);
		setProject("captions", "segments", 0, "words", 0, "text", "changed");
		const sourceEdit = cache.get(project);
		expect(sourceEdit).not.toBe(first);
		const sourceValue = await sourceEdit;
		expect(sourceValue?.ref).not.toBe(firstValue.ref);
		setProject("timeline", "captionSegments", 0, "words", 0, "text", "edited");
		const trackEdit = cache.get(project);
		expect(trackEdit).not.toBe(sourceEdit);
		const trackValue = await trackEdit;
		expect(trackValue?.ref).not.toBe(sourceValue?.ref);
		const template = segments[0];
		if (!template) throw new Error("Caption fixture was empty");
		setProject(
			produce((draft) => {
				draft.captions.segments.push({ ...template, id: "added-caption" });
			}),
		);
		const addedCaption = cache.get(project);
		expect(addedCaption).not.toBe(trackEdit);
		expect((await addedCaption)?.ref).not.toBe(trackValue?.ref);
		cache.dispose();
		expect(cache.get(project)).not.toBe(addedCaption);
	} finally {
		cache.dispose();
	}
});

test("mutable non-Solid caption arrays are rehashed after word edits", async () => {
	const segments = longCaptionSegments(800);
	const project = {
		captions: { segments },
		timeline: { captionSegments: segments },
	};
	const cache = new EditorCaptionCacheMemo();
	try {
		const first = cache.get(project);
		const firstValue = await first;
		if (!firstValue) throw new Error("Long caption cache was unavailable");
		segments[0].words[0].text = "changed";
		const second = cache.get(project);
		expect(second).not.toBe(first);
		expect((await second)?.ref).not.toBe(firstValue.ref);
	} finally {
		cache.dispose();
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
