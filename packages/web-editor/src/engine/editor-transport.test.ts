import { createStore } from "solid-js/store";
import { afterEach, beforeEach, expect, test } from "vitest";
import { imageAssetPath } from "../app/routes/editor/images";
import {
	browserEditorPreviewConfig,
	setBrowserEditorPreviewConfig,
	setBrowserEditorVideoId,
} from "./browser-frame-socket";
import {
	commands,
	EditorChannel,
	events,
	listenEditorEvent,
} from "./editor-api";
import { resolveEditorAssetUrl, setEditorAssetBase } from "./editor-asset-url";
import {
	editorTransport,
	PortEditorTransport,
	setEditorTransport,
} from "./editor-transport";
import { closeEditor, onEditorCloseRequested } from "./editor-window";

type Request = { id: number; kind: string; name: string; args: unknown[] };

const session = { videoId: "video", sessionId: "browser-video" };
let previousWindow: PropertyDescriptor | undefined;
let browserWindow: EventTarget & { capWebEditorCaptionsEnabled?: boolean };

beforeEach(() => {
	previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
	browserWindow = Object.assign(new EventTarget(), {
		capWebEditorCaptionsEnabled: true,
	});
	Object.defineProperty(globalThis, "window", {
		configurable: true,
		value: browserWindow,
	});
	setBrowserEditorVideoId("video");
});

afterEach(() => {
	setEditorTransport(null);
	setBrowserEditorVideoId(null);
	if (previousWindow)
		Object.defineProperty(globalThis, "window", previousWindow);
	else Reflect.deleteProperty(globalThis, "window");
});

function connect(
	reply: (request: Request, port: MessagePort) => void = (request, port) =>
		port.postMessage({ kind: "result", id: request.id, value: null }),
) {
	const channel = new MessageChannel();
	const transport = new PortEditorTransport(channel.port1, session);
	const requests: Request[] = [];
	let notify: (() => void) | null = null;
	channel.port2.onmessage = (event: MessageEvent<Request>) => {
		requests.push(event.data);
		notify?.();
		reply(event.data, channel.port2);
	};
	channel.port2.start();
	setEditorTransport(transport);
	const nextRequest = (count: number) =>
		new Promise<void>((resolve) => {
			if (requests.length >= count) return resolve();
			notify = () => {
				if (requests.length >= count) {
					notify = null;
					resolve();
				}
			};
		});
	return { transport, host: channel.port2, requests, nextRequest };
}

test("host commands and events cross the editor port with their wire names", async () => {
	const { host, requests } = connect((request, port) =>
		port.postMessage({
			kind: "result",
			id: request.id,
			value: request.name === "checkUpgradedAndUpdate" ? true : null,
		}),
	);
	expect(await commands.checkUpgradedAndUpdate()).toBe(true);
	await commands.setPrettyName("A useful title");
	await commands.openUpgrade();
	const layout = new Promise<unknown>((resolve) => {
		void events.frameLayoutEvent.once(({ payload }) => resolve(payload));
	});
	host.postMessage({
		kind: "event",
		name: "frameLayoutEvent",
		payload: { progress: 0.5 },
	});
	expect(await layout).toEqual({ progress: 0.5 });
	expect(
		requests.map(({ kind, name, args }) => ({ kind, name, args })),
	).toEqual([
		{ kind: "invoke", name: "checkUpgradedAndUpdate", args: [] },
		{ kind: "invoke", name: "setPrettyName", args: ["A useful title"] },
		{ kind: "invoke", name: "showWindow", args: ["Upgrade"] },
	]);
});

test("playback commands drive the browser preview without crossing the port", async () => {
	const { requests } = connect();
	await commands.startPlayback(30, { x: 1920, y: 1080 });
	await commands.stopPlayback();
	await commands.seekTo(90);
	await commands.cancelExportEstimates();
	expect(requests).toEqual([]);
});

test("a save landing after newer edits leaves the browser preview on them", async () => {
	const saves: Array<() => void> = [];
	let saveRequested: () => void = () => undefined;
	const requested = new Promise<void>((resolve) => {
		saveRequested = resolve;
	});
	const { transport } = connect((request, port) => {
		saves.push(() =>
			port.postMessage({ kind: "result", id: request.id, value: null }),
		);
		saveRequested();
	});
	const saved = { timeline: { segments: [{ start: 0, end: 4 }] } };
	const newer = {
		timeline: {
			segments: [
				{ start: 0, end: 2 },
				{ start: 2, end: 4 },
			],
		},
	};
	await transport.invoke("updateProjectConfigInMemory", [
		saved,
		null,
		null,
		null,
	]);
	const save = transport.invoke("setProjectConfig", [saved]);
	await transport.invoke("updateProjectConfigInMemory", [
		newer,
		null,
		null,
		null,
	]);
	await requested;
	saves[0]?.();
	await save;
	expect(browserEditorPreviewConfig()).toEqual(newer);
});

test("a save seeds a browser preview that has no config yet", async () => {
	const { transport } = connect();
	await setBrowserEditorPreviewConfig(null);
	const saved = { timeline: { segments: [{ start: 0, end: 4 }] } };
	await transport.invoke("setProjectConfig", [saved]);
	expect(browserEditorPreviewConfig()).toEqual(saved);
});

test("closing the editor port rejects unfinished commands", async () => {
	const { transport, nextRequest } = connect(() => undefined);
	const unfinished = transport.invoke("setPrettyName", ["Unfinished title"]);
	await nextRequest(1);
	transport.dispose();
	await expect(unfinished).rejects.toThrow("Editor bridge is closed");
});

test("late plan replies cannot reopen paid caption controls", async () => {
	let planEvents = 0;
	browserWindow.addEventListener("cap-web-editor-captions-plan", () => {
		planEvents++;
	});
	const { transport, host, requests, nextRequest } = connect(() => undefined);
	const first = transport.invoke("checkUpgradedAndUpdate", []);
	const second = transport.invoke("checkUpgradedAndUpdate", []);
	await nextRequest(2);
	host.postMessage({ kind: "result", id: requests[1]?.id, value: false });
	expect(await second).toBe(false);
	expect(browserWindow.capWebEditorCaptionsEnabled).toBe(false);
	host.postMessage({ kind: "result", id: requests[0]?.id, value: true });
	expect(await first).toBe(true);
	expect(browserWindow.capWebEditorCaptionsEnabled).toBe(false);
	expect(planEvents).toBe(1);
});

test("host plan updates supersede pending iframe plan replies", async () => {
	browserWindow.capWebEditorCaptionsEnabled = false;
	let planEvents = 0;
	const planChanged = new Promise<void>((resolve) => {
		browserWindow.addEventListener("cap-web-editor-captions-plan", () => {
			planEvents++;
			resolve();
		});
	});
	const { transport, host, requests, nextRequest } = connect(() => undefined);
	const pending = transport.invoke("checkUpgradedAndUpdate", []);
	await nextRequest(1);
	host.postMessage({ kind: "event", name: "editorCaptionPlan", payload: true });
	await planChanged;
	expect(browserWindow.capWebEditorCaptionsEnabled).toBe(true);
	host.postMessage({ kind: "result", id: requests[0]?.id, value: false });
	expect(await pending).toBe(false);
	expect(browserWindow.capWebEditorCaptionsEnabled).toBe(true);
	expect(planEvents).toBe(1);
});

test("Free preview updates and saves omit paid captions but keep video edits", async () => {
	browserWindow.capWebEditorCaptionsEnabled = false;
	const { transport, requests } = connect();
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
	const stripped = {
		camera: { mirror: true },
		captions: {
			segments: [],
			settings: { enabled: false, exportWithSubtitles: false },
		},
		timeline: { segments: [{ start: 2, end: 8 }], captionSegments: [] },
	};
	await transport.invoke("updateProjectConfigInMemory", [
		source,
		null,
		null,
		null,
	]);
	expect(browserEditorPreviewConfig()).toMatchObject(stripped);
	await transport.invoke("setProjectConfig", [source]);
	expect(requests.map((request) => request.name)).toEqual(["setProjectConfig"]);
	expect(requests[0]?.args[0]).toMatchObject(stripped);
	expect(requests[0]?.args[1]).toBe(true);
	expect(source.captions.segments).toHaveLength(1);
});

test("reactive Solid project values are serialized before crossing the port", async () => {
	const { transport, requests } = connect();
	const [project] = createStore({ background: { padding: 12 } });
	await expect(transport.invoke("setProjectConfig", [project])).resolves.toBe(
		null,
	);
	expect(requests[0]?.args).toEqual([{ background: { padding: 12 } }]);
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

test("two-hour captions cross the port once and reuse their payload on later saves", async () => {
	let rejectCompactSave = false;
	const { transport, requests } = connect((request, port) => {
		const config = request.args[0] as Record<string, unknown>;
		if (rejectCompactSave && "webCaptionRef" in config) {
			rejectCompactSave = false;
			port.postMessage({
				kind: "error",
				id: request.id,
				error: "Caption payload cache is unavailable",
			});
			return;
		}
		port.postMessage({ kind: "result", id: request.id, value: null });
	});
	const segments = longCaptionSegments(3_000);
	const project = {
		captions: { sourceTimed: true, segments },
		timeline: { captionSegments: segments },
		camera: { mirror: false },
	};
	const cameraEdit = { ...project, camera: { mirror: true } };
	await transport.invoke("setProjectConfig", [project]);
	await transport.invoke("setProjectConfig", [cameraEdit]);
	const full = requests[0]?.args[0] as Record<string, unknown>;
	const reused = requests[1]?.args[0] as Record<string, unknown>;
	expect(JSON.stringify(full).length).toBeGreaterThan(512 * 1024);
	expect(JSON.stringify(reused).length).toBeLessThan(
		JSON.stringify(full).length / 20,
	);
	expect(reused.webCaptionRef).toHaveLength(64);
	rejectCompactSave = true;
	await transport.invoke("setProjectConfig", [cameraEdit]);
	expect(requests[2]?.args[0]).toHaveProperty("webCaptionRef");
	expect(requests[3]?.args[0]).not.toHaveProperty("webCaptionRef");
});

test("Save upload progress reaches its callback and releases its channel", async () => {
	const progress: Array<{ rendered_count: number; total_frames: number }> = [];
	const callback = new EditorChannel<{
		rendered_count: number;
		total_frames: number;
	}>((value) => progress.push(value));
	const { host } = connect((request, port) => {
		expect(request.args[2]).toBe(`__CHANNEL__:${callback.id}`);
		port.postMessage({
			kind: "channel",
			id: callback.id,
			value: { rendered_count: 2, total_frames: 3 },
		});
		port.postMessage({ kind: "result", id: request.id, value: "screen.mp4" });
	});
	await expect(
		editorTransport().invoke("tauri:webEditorPublishRendered", [
			new Blob([new Uint8Array([0])], { type: "video/mp4" }),
			{ duration: 1, width: 1920, height: 1080, fps: 30 },
			callback,
		]),
	).resolves.toBe("screen.mp4");
	expect(progress).toEqual([{ rendered_count: 2, total_frames: 3 }]);
	const delivered = new Promise<void>((resolve) => {
		listenEditorEvent("settled", () => resolve());
	});
	host.postMessage({
		kind: "channel",
		id: callback.id,
		value: { rendered_count: 3, total_frames: 3 },
	});
	host.postMessage({ kind: "event", name: "settled", payload: null });
	await delivered;
	expect(progress).toHaveLength(1);
});

test("closing the web editor waits for the editor's save handler", async () => {
	const { requests } = connect();
	const steps: string[] = [];
	const unlisten = onEditorCloseRequested(async (event) => {
		event.preventDefault();
		await Promise.resolve();
		steps.push("saved");
		await closeEditor();
	});
	try {
		await closeEditor();
		expect(steps).toEqual(["saved"]);
		expect(requests.map((request) => [request.kind, request.name])).toEqual([
			["emit", "editor-close-approved"],
		]);
	} finally {
		unlisten();
	}
});

test("a failed web editor save keeps the editor open and allows retry", async () => {
	const { requests } = connect();
	let saveSucceeds = false;
	let attempts = 0;
	const unlisten = onEditorCloseRequested(async (event) => {
		event.preventDefault();
		attempts++;
		if (saveSucceeds) await closeEditor();
	});
	try {
		await closeEditor();
		expect(attempts).toBe(1);
		expect(requests).toEqual([]);
		saveSucceeds = true;
		await closeEditor();
		expect(attempts).toBe(2);
		expect(requests.map((request) => request.name)).toEqual([
			"editor-close-approved",
		]);
	} finally {
		unlisten();
	}
});

test("an image chosen in the browser reaches the host as a timeline asset", async () => {
	const imported = {
		path: "content/images/22222222-2222-4222-8222-222222222222.png",
		name: "logo",
		width: 120,
		height: 80,
	};
	const file = new File([new Uint8Array([1, 2, 3, 4])], "logo.png", {
		type: "image/png",
	});
	const { requests } = connect((request, port) =>
		port.postMessage({ kind: "result", id: request.id, value: imported }),
	);
	const asset = await commands.importEditorImage(file);
	expect(asset).toEqual(imported);
	expect(requests[0]?.name).toBe("importEditorImage");
	expect(requests[0]?.args[0]).toBeInstanceOf(File);
	expect((requests[0]?.args[0] as File).name).toBe("logo.png");
	const fullPath = imageAssetPath(
		"cap-web-editor://session/session",
		asset.path,
	);
	setEditorAssetBase("/api/editor/sessions/session/file?videoId=video");
	try {
		expect(resolveEditorAssetUrl(fullPath ?? "")).toBe(
			`/api/editor/sessions/session/file?videoId=video&path=${encodeURIComponent(fullPath ?? "")}`,
		);
	} finally {
		setEditorAssetBase("");
	}
});
