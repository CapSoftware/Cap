import type { VideoId } from "@cap/recorder-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RECORDING_STATE_KEY } from "../shared/storage-keys";
import type {
	OffscreenResponse,
	RecordingStatus,
	ServiceWorkerResponse,
} from "../shared/types";

type MessageListener = Parameters<
	typeof chrome.runtime.onMessage.addListener
>[0];

let onMessage: MessageListener;
let stored: Record<string, unknown>;
let pollReplies: Array<(response: OffscreenResponse) => void>;
let contextReplies: Array<(contexts: object[]) => void>;

const liveStatus: RecordingStatus = {
	phase: "recording",
	startedAt: 1,
	durationMs: 1000,
	updatedAt: 1001,
};

beforeEach(async () => {
	vi.resetModules();
	stored = {};
	pollReplies = [];
	contextReplies = [];
	const storage = {
		get: (_keys: string[], callback: (items: object) => void) =>
			callback({ ...stored }),
		set: (items: object, callback: () => void) => {
			Object.assign(stored, items);
			callback();
		},
		setAccessLevel: vi.fn(),
	};
	vi.stubGlobal("chrome", {
		storage: { local: storage, session: storage },
		runtime: {
			getURL: (path: string) => `chrome-extension://test/${path}`,
			ContextType: { OFFSCREEN_DOCUMENT: "OFFSCREEN_DOCUMENT" },
			getContexts: vi.fn((_filter, callback) => {
				contextReplies.push(callback);
			}),
			sendMessage: vi.fn((_message, callback) => {
				pollReplies.push(callback);
			}),
			onMessage: {
				addListener: (listener: MessageListener) => {
					onMessage = listener;
				},
			},
			onInstalled: { addListener: vi.fn() },
		},
		action: {
			setPopup: vi.fn((_options, callback) => callback()),
			setBadgeText: vi.fn((_options, callback) => callback()),
			setTitle: vi.fn((_options, callback) => callback()),
			onClicked: { addListener: vi.fn() },
		},
		tabs: {
			query: (_query: object, callback: (tabs: object[]) => void) =>
				callback([]),
			onActivated: { addListener: vi.fn() },
			onUpdated: { addListener: vi.fn() },
			onRemoved: { addListener: vi.fn() },
		},
		windows: { onFocusChanged: { addListener: vi.fn() } },
	});
	await import("./service-worker");
});

afterEach(() => {
	vi.unstubAllGlobals();
});

const broadcast = (status: RecordingStatus) =>
	onMessage(
		{
			target: "recording-status",
			type: "recording-status-changed",
			status,
		},
		{},
		vi.fn(),
	);

const pollStatus = () =>
	new Promise<ServiceWorkerResponse>((resolve) => {
		onMessage(
			{ target: "service-worker", type: "get-recording-status" },
			{},
			resolve,
		);
	});

const answerContexts = (present: boolean) => {
	const reply = contextReplies.shift();
	if (!reply) throw new Error("No pending context query");
	reply(
		present ? [{ documentUrl: "chrome-extension://test/offscreen.html" }] : [],
	);
};

describe("recording status synchronization", () => {
	it.each(["recording", "paused", "uploading"] as const)(
		"restores %s from the offscreen document after a worker restart",
		async (phase) => {
			const currentStatus = { ...liveStatus, phase };
			const response = pollStatus();
			answerContexts(true);
			await vi.waitFor(() => expect(contextReplies).toHaveLength(1));
			answerContexts(true);
			await vi.waitFor(() => expect(pollReplies).toHaveLength(1));
			pollReplies[0]({ ok: true, status: currentStatus });

			expect(await response).toMatchObject({ ok: true, status: currentStatus });
			expect(stored[RECORDING_STATE_KEY]).toMatchObject({
				status: currentStatus,
			});
		},
	);

	it.each([
		{
			phase: "completed",
			videoId: "video" as VideoId,
			shareUrl: "https://cap.so/s/video",
		},
		{ phase: "error", message: "Upload failed", recoverable: true },
	] satisfies RecordingStatus[])(
		"preserves a newer $phase broadcast over an older poll response",
		async (nextStatus) => {
			const response = pollStatus();
			answerContexts(true);
			await vi.waitFor(() => expect(contextReplies).toHaveLength(1));
			answerContexts(true);
			await vi.waitFor(() => expect(pollReplies).toHaveLength(1));

			broadcast(nextStatus);
			pollReplies[0]({ ok: true, status: liveStatus });

			expect(await response).toMatchObject({ ok: true, status: nextStatus });
			expect(stored[RECORDING_STATE_KEY]).toMatchObject({ status: nextStatus });
			expect(chrome.action.setBadgeText).toHaveBeenLastCalledWith(
				{ text: "" },
				expect.any(Function),
			);
		},
	);

	it("preserves a recording broadcast received while checking for the offscreen document", async () => {
		const response = pollStatus();
		broadcast(liveStatus);
		answerContexts(false);

		expect(await response).toMatchObject({ ok: true, status: liveStatus });
		expect(stored[RECORDING_STATE_KEY]).toMatchObject({ status: liveStatus });
	});

	it("clears a phantom recording when its offscreen document is gone", async () => {
		broadcast(liveStatus);
		const response = pollStatus();
		answerContexts(false);

		expect(await response).toMatchObject({
			ok: true,
			status: { phase: "idle" },
		});
		expect(stored[RECORDING_STATE_KEY]).toMatchObject({
			status: { phase: "idle" },
		});
	});
});

describe("standalone side panel across windows", () => {
	type ClickListener = Parameters<
		typeof chrome.action.onClicked.addListener
	>[0];

	const newTab = (windowId: number) =>
		({
			id: windowId * 10,
			windowId,
			url: "chrome://newtab/",
		}) as chrome.tabs.Tab;

	const panelCloses = () =>
		vi
			.mocked(chrome.runtime.sendMessage)
			.mock.calls.map(
				([message]) =>
					message as { target?: string; type?: string; windowId?: number },
			)
			.filter(
				(message) =>
					message.target === "standalone-panel" && message.type === "close",
			)
			.map((message) => message.windowId);

	const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

	it("moves the recorder to the clicked window and toggles only in its own window", async () => {
		const open = vi.fn(() => Promise.resolve());
		Object.assign(chrome, { sidePanel: { open } });
		const click = vi.mocked(chrome.action.onClicked.addListener).mock
			.calls[0][0] as ClickListener;

		click(newTab(1));
		expect(open).toHaveBeenLastCalledWith({ windowId: 1 });
		await vi.waitFor(() => expect(pollReplies).toHaveLength(1));
		pollReplies[0](undefined as unknown as OffscreenResponse);
		answerContexts(false);
		await settle();

		click(newTab(2));
		expect(open).toHaveBeenLastCalledWith({ windowId: 2 });
		await vi.waitFor(() => expect(panelCloses()).toEqual([1]));

		await onMessage(
			{
				target: "service-worker",
				type: "standalone-panel-closed",
				windowId: 1,
			},
			{},
			vi.fn(),
		);
		await settle();

		click(newTab(2));
		expect(open).toHaveBeenCalledTimes(2);
		expect(panelCloses()).toEqual([1, 2]);
	});
});
