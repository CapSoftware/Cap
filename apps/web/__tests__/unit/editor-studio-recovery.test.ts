// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
	captureEditorLocalDraft,
	readEditorLocalDraft,
} from "@/lib/editor-local-draft";

const mocks = vi.hoisted(() => ({
	push: vi.fn(),
	connect: vi.fn(async () => undefined),
	dispose: vi.fn(),
}));

vi.mock("next/navigation", () => ({
	useRouter: () => ({ push: mocks.push }),
}));
vi.mock("next/dynamic", () => ({ default: () => () => null }));
vi.mock("@/app/s/[videoId]/edit/studio/EditorClipRecorder", () => ({
	EditorClipRecorder: () => null,
}));
vi.mock("@/app/s/[videoId]/edit/studio/editor-host", () => ({
	EditorHostBridge: class {
		connect = mocks.connect;
		dispose = mocks.dispose;
	},
}));

import { StudioEditorClient } from "@/app/s/[videoId]/edit/studio/StudioEditorClient";

let root: Root;
let container: HTMLDivElement;
const requests: Array<{ url: string; method: string; body: unknown }> = [];
let currentRevision: string;
let rejectNextRestore: boolean;
let preparationReady: boolean;

function browserStorage(): Storage {
	const items = new Map<string, string>();
	return {
		get length() {
			return items.size;
		},
		clear: () => items.clear(),
		getItem: (key) => items.get(key) ?? null,
		key: (index) => [...items.keys()][index] ?? null,
		removeItem: (key) => items.delete(key),
		setItem: (key, value) => items.set(key, value),
	};
}

beforeEach(() => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	Object.defineProperty(window, "localStorage", {
		configurable: true,
		value: browserStorage(),
	});
	requests.length = 0;
	currentRevision = "newer";
	rejectNextRestore = false;
	preparationReady = true;
	mocks.connect.mockClear();
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
	vi.stubGlobal(
		"fetch",
		async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input);
			const method = init?.method ?? "GET";
			const body = init?.body ? JSON.parse(String(init.body)) : null;
			requests.push({ url, method, body });
			if (url === "/api/editor/preparations" && method === "POST") {
				return Response.json(
					{ id: "preparation", status: "preparing" },
					{ status: 202 },
				);
			}
			if (
				url.startsWith("/api/editor/preparations/preparation?") &&
				method === "GET"
			) {
				return Response.json(
					preparationReady
						? { status: "ready", sessionId: "session" }
						: { status: "preparing" },
				);
			}
			if (url === "/api/editor/sessions/session/config" && method === "PUT") {
				const expectedSavedAt = (body as Record<string, unknown>)
					.expectedSavedAt;
				if (expectedSavedAt !== currentRevision)
					return new Response("Changed in another tab", { status: 409 });
				if (rejectNextRestore) {
					rejectNextRestore = false;
					currentRevision = "latest";
					return new Response("Changed again", { status: 409 });
				}
				currentRevision = "recovered";
				return Response.json({ saved: true, savedAt: currentRevision });
			}
			if (
				url === "/api/editor/sessions/session/config?videoId=video" &&
				method === "GET"
			) {
				return Response.json({ savedAt: currentRevision });
			}
			if (
				url.startsWith("/api/editor/sessions/session?") &&
				method === "DELETE"
			) {
				return Response.json({ closed: true });
			}
			throw new Error(`Unexpected editor request: ${method} ${url}`);
		},
	);
});

afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
	Reflect.deleteProperty(window, "localStorage");
	vi.unstubAllGlobals();
});

async function waitFor(assertion: () => void) {
	let lastError: unknown;
	for (let attempt = 0; attempt < 60; attempt++) {
		try {
			assertion();
			return;
		} catch (cause) {
			lastError = cause;
		}
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 10));
		});
	}
	throw lastError;
}

async function openRecoveryConflict() {
	const config = {
		camera: { mirror: true },
		background: {
			source: { type: "image", path: "content/images/fixture.png" },
		},
	};
	expect(
		captureEditorLocalDraft(
			window.localStorage,
			"owner",
			"video",
			"older",
			JSON.stringify(config),
		),
	).toBe(true);
	await act(async () => {
		root.render(
			createElement(StudioEditorClient, {
				videoId: "video",
				userId: "owner",
				captionsEnabled: true,
				savedAt: "newer",
				preparingTitle: "Paired replay",
				preparingDuration: 900,
				preparingTracks: ["display", "camera"],
			}),
		);
	});
	await waitFor(() => {
		expect(container.querySelector('[role="alert"]')?.textContent).toContain(
			"changed",
		);
	});
	return config;
}

test("a changed recording keeps the browser draft until its owner chooses recovery", async () => {
	const config = await openRecoveryConflict();
	const saves = requests.filter(
		(request) => request.url === "/api/editor/sessions/session/config",
	);
	expect(saves).toHaveLength(1);
	expect(saves[0]?.body).toEqual({
		videoId: "video",
		config,
		expectedSavedAt: "older",
	});
	expect(
		readEditorLocalDraft(window.localStorage, "owner", "video")?.config,
	).toEqual(config);
	const restore = Array.from(container.querySelectorAll("button")).find(
		(button) => button.textContent === "Restore browser edits",
	);
	if (!restore) throw new Error("Recovery choice was not shown");
	await act(async () => restore.click());
	await waitFor(() => {
		expect(
			container.querySelector('iframe[title="Cap editor"]'),
		).not.toBeNull();
	});
	expect(
		requests.filter(
			(request) => request.url === "/api/editor/sessions/session/config",
		)[1]?.body,
	).toEqual({
		videoId: "video",
		config,
		expectedSavedAt: "newer",
	});
	expect(
		requests.filter((request) => request.url.includes("/config?videoId=video")),
	).toHaveLength(1);
	expect(
		readEditorLocalDraft(window.localStorage, "owner", "video"),
	).toBeNull();
});

test("a second tab save during chosen recovery keeps the draft for another owner choice", async () => {
	const config = await openRecoveryConflict();
	rejectNextRestore = true;
	const restore = () =>
		Array.from(container.querySelectorAll("button")).find(
			(button) => button.textContent === "Restore browser edits",
		);
	const first = restore();
	if (!first) throw new Error("Recovery choice was not shown");
	await act(async () => first.click());
	await waitFor(() => {
		expect(container.querySelector('[role="alert"]')?.textContent).toContain(
			"changed again",
		);
	});
	expect(
		readEditorLocalDraft(window.localStorage, "owner", "video")?.config,
	).toEqual(config);
	expect(container.querySelector('iframe[title="Cap editor"]')).toBeNull();
	const second = restore();
	if (!second) throw new Error("Recovery choice disappeared");
	await act(async () => second.click());
	await waitFor(() => {
		expect(
			container.querySelector('iframe[title="Cap editor"]'),
		).not.toBeNull();
	});
	const saves = requests.filter(
		(request) => request.url === "/api/editor/sessions/session/config",
	);
	expect(saves.map((request) => request.body)).toEqual([
		{ videoId: "video", config, expectedSavedAt: "older" },
		{ videoId: "video", config, expectedSavedAt: "newer" },
		{ videoId: "video", config, expectedSavedAt: "latest" },
	]);
	expect(
		readEditorLocalDraft(window.localStorage, "owner", "video"),
	).toBeNull();
});

test("preparation keeps the shared editor shell open and connects once when ready", async () => {
	preparationReady = false;
	await act(async () => {
		root.render(
			createElement(StudioEditorClient, {
				videoId: "video",
				userId: "owner",
				captionsEnabled: true,
				savedAt: null,
				preparingTitle: "Paired replay",
				preparingDuration: 900,
				preparingTracks: ["display", "camera"],
			}),
		);
	});
	const iframe = container.querySelector<HTMLIFrameElement>(
		'iframe[title="Cap editor"]',
	);
	if (!iframe) throw new Error("Editor shell was not shown during preparation");
	await waitFor(() => {
		expect(
			requests.some((request) => request.url === "/api/editor/preparations"),
		).toBe(true);
	});
	const frameDocument =
		document.implementation.createHTMLDocument("Cap editor");
	Object.defineProperty(frameDocument, "URL", {
		configurable: true,
		value: "http://localhost/editor-solid/index.html",
	});
	Object.defineProperty(frameDocument, "readyState", {
		configurable: true,
		value: "complete",
	});
	Object.defineProperty(iframe, "contentDocument", {
		configurable: true,
		value: frameDocument,
	});
	const childWindow = iframe.contentWindow;
	if (!childWindow) throw new Error("Editor child window was unavailable");
	const postMessage = vi.spyOn(childWindow, "postMessage");
	await act(async () => iframe.dispatchEvent(new Event("load")));
	expect(postMessage).toHaveBeenCalledWith(
		{
			kind: "cap-editor-preparing",
			version: 1,
			title: "Paired replay",
			durationSeconds: 900,
			tracks: ["display", "camera"],
		},
		window.location.origin,
	);
	expect(mocks.connect).not.toHaveBeenCalled();
	preparationReady = true;
	await waitFor(() => {
		expect(mocks.connect).toHaveBeenCalledTimes(1);
	});
	await act(async () => iframe.dispatchEvent(new Event("load")));
	expect(mocks.connect).toHaveBeenCalledTimes(1);
});

test("a Free editor lets its owner restore non-caption edits from a Pro browser draft", async () => {
	const config = {
		camera: { mirror: true },
		captions: {
			segments: [{ id: "word", start: 0, end: 1, text: "Hello" }],
			settings: { enabled: true, exportWithSubtitles: true, font: "Geist" },
		},
		timeline: {
			segments: [{ start: 0, end: 10 }],
			captionSegments: [{ id: "word", start: 0, end: 1 }],
		},
	};
	expect(
		captureEditorLocalDraft(
			window.localStorage,
			"owner",
			"video",
			"newer",
			JSON.stringify(config),
		),
	).toBe(true);
	await act(async () => {
		root.render(
			createElement(StudioEditorClient, {
				videoId: "video",
				userId: "owner",
				captionsEnabled: false,
				savedAt: "newer",
				preparingTitle: "Paired replay",
				preparingDuration: 900,
				preparingTracks: ["display", "camera"],
			}),
		);
	});
	await waitFor(() => {
		expect(
			container.querySelector('[role="alert"]')?.textContent ?? "",
		).toContain("Cap Pro");
	});
	expect(
		requests.filter(
			(request) => request.url === "/api/editor/sessions/session/config",
		),
	).toHaveLength(0);
	expect(
		readEditorLocalDraft(window.localStorage, "owner", "video")?.config,
	).toEqual(config);
	const restore = Array.from(container.querySelectorAll("button")).find(
		(button) => button.textContent === "Restore browser edits",
	);
	if (!restore) throw new Error("Recovery choice was not shown");
	await act(async () => restore.click());
	await waitFor(() => {
		expect(
			container.querySelector('iframe[title="Cap editor"]'),
		).not.toBeNull();
	});
	expect(
		requests.filter(
			(request) => request.url === "/api/editor/sessions/session/config",
		)[0]?.body,
	).toEqual({
		videoId: "video",
		config: {
			camera: { mirror: true },
			captions: {
				segments: [],
				settings: {
					enabled: false,
					exportWithSubtitles: false,
					font: "Geist",
				},
			},
			timeline: {
				segments: [{ start: 0, end: 10 }],
				captionSegments: [],
			},
		},
		expectedSavedAt: "newer",
	});
	expect(
		readEditorLocalDraft(window.localStorage, "owner", "video"),
	).toBeNull();
});

test("a Pro editor automatically restores a caption browser draft", async () => {
	const config = {
		camera: { mirror: true },
		captions: {
			segments: [{ id: "word", start: 0, end: 1, text: "Hello" }],
			settings: { enabled: true, exportWithSubtitles: true },
		},
	};
	expect(
		captureEditorLocalDraft(
			window.localStorage,
			"owner",
			"video",
			"newer",
			JSON.stringify(config),
		),
	).toBe(true);
	await act(async () => {
		root.render(
			createElement(StudioEditorClient, {
				videoId: "video",
				userId: "owner",
				captionsEnabled: true,
				savedAt: "newer",
				preparingTitle: "Paired replay",
				preparingDuration: 900,
				preparingTracks: ["display", "camera"],
			}),
		);
	});
	await waitFor(() => {
		expect(
			requests.filter(
				(request) => request.url === "/api/editor/sessions/session/config",
			),
		).toHaveLength(1);
		expect(
			readEditorLocalDraft(window.localStorage, "owner", "video"),
		).toBeNull();
	});
	expect(
		requests.filter(
			(request) => request.url === "/api/editor/sessions/session/config",
		)[0]?.body,
	).toEqual({ videoId: "video", config, expectedSavedAt: "newer" });
	expect(
		readEditorLocalDraft(window.localStorage, "owner", "video"),
	).toBeNull();
});
