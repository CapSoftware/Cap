import type { VideoId } from "@cap/recorder-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AUTH_KEY } from "../shared/storage";
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
let holdCacheRemoval: boolean;
let completeCacheRemoval: (() => void) | null;

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
	holdCacheRemoval = false;
	completeCacheRemoval = null;
	const storage = {
		get: (_keys: string[], callback: (items: object) => void) =>
			callback({ ...stored }),
		set: (items: object, callback: () => void) => {
			Object.assign(stored, items);
			callback();
		},
		remove: (keys: string | string[], callback: () => void) => {
			const finish = () => {
				for (const key of Array.isArray(keys) ? keys : [keys]) {
					delete stored[key];
				}
				callback();
			};
			if (holdCacheRemoval && keys === "cap-extension-bootstrap-cache") {
				completeCacheRemoval = finish;
				return;
			}
			finish();
		},
		setAccessLevel: vi.fn(),
	};
	vi.stubGlobal("chrome", {
		storage: { local: storage, session: storage },
		identity: {
			getRedirectURL: () => "https://extension.chromiumapp.org/",
			launchWebAuthFlow: vi.fn(
				(options: { url: string }, callback: (url: string) => void) => {
					const state = new URL(options.url).searchParams.get("state");
					callback(
						`https://extension.chromiumapp.org/#state=${state}&authApiKey=new_key&userId=new_user`,
					);
				},
			),
		},
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

const BOOTSTRAP_CACHE_KEY = "cap-extension-bootstrap-cache";

const bootstrapFor = (account: string, maxRecordingSeconds: number) => ({
	user: { id: account, email: `${account}@cap.test` },
	organization: { id: `org_${account}`, name: account },
	plan: { isPro: maxRecordingSeconds === 0, maxRecordingSeconds },
});

const requestWorker = (type: "bootstrap" | "auth-revoke" | "auth-start") =>
	new Promise<ServiceWorkerResponse>((resolve) => {
		onMessage({ target: "service-worker", type }, {}, resolve);
	});

const resolveBootstrapContext = async () => {
	await vi.waitFor(() => expect(contextReplies).toHaveLength(1));
	answerContexts(false);
};

describe("bootstrap session ownership", () => {
	it("does not repopulate the previous account's cache after sign-out", async () => {
		stored[AUTH_KEY] = { authApiKey: "old_key", userId: "old_user" };
		stored[BOOTSTRAP_CACHE_KEY] = {
			bootstrap: bootstrapFor("old_user", 300),
			cachedAt: Date.now(),
		};
		let finishOldBootstrap!: (response: Response) => void;
		const oldBootstrapResponse = new Promise<Response>((resolve) => {
			finishOldBootstrap = resolve;
		});
		const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) =>
			init?.method === "POST"
				? Promise.resolve(Response.json({ success: true }))
				: oldBootstrapResponse,
		);
		vi.stubGlobal("fetch", fetchMock);

		const initial = requestWorker("bootstrap");
		await resolveBootstrapContext();
		expect(await initial).toMatchObject({
			ok: true,
			bootstrap: { organization: { id: "org_old_user" } },
		});

		expect(await requestWorker("auth-revoke")).toMatchObject({
			ok: true,
			auth: null,
		});
		finishOldBootstrap(Response.json(bootstrapFor("old_user", 300)));
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(stored[AUTH_KEY]).toBeUndefined();
		expect(stored[BOOTSTRAP_CACHE_KEY]).toBeUndefined();
	});

	it("does not expose old cached data during the account switch", async () => {
		stored[AUTH_KEY] = { authApiKey: "old_key", userId: "old_user" };
		stored[BOOTSTRAP_CACHE_KEY] = {
			bootstrap: bootstrapFor("old_user", 300),
			cachedAt: Date.now(),
		};
		const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
			if (init?.redirect === "manual") {
				return Promise.resolve(new Response(null, { status: 302 }));
			}
			if (init?.method === "POST") {
				return Promise.resolve(Response.json({ success: true }));
			}
			const token = new Headers(init?.headers).get("Authorization");
			return Promise.resolve(
				Response.json(
					bootstrapFor(
						token === "Bearer old_key" ? "old_user" : "new_user",
						token === "Bearer old_key" ? 300 : 0,
					),
				),
			);
		});
		vi.stubGlobal("fetch", fetchMock);
		holdCacheRemoval = true;

		expect(await requestWorker("auth-start")).toMatchObject({
			ok: true,
			authPending: true,
		});
		await vi.waitFor(() => expect(completeCacheRemoval).not.toBeNull());
		const duringSwitch = requestWorker("bootstrap");
		await resolveBootstrapContext();
		expect(await duringSwitch).toMatchObject({
			ok: true,
			auth: null,
		});
		const removeCache = completeCacheRemoval;
		if (!removeCache) throw new Error("Cache removal was not pending");
		holdCacheRemoval = false;
		removeCache();
		await vi.waitFor(() => {
			expect(stored[AUTH_KEY]).toMatchObject({ authApiKey: "new_key" });
			expect(stored[BOOTSTRAP_CACHE_KEY]).toMatchObject({
				bootstrap: { organization: { id: "org_new_user" } },
			});
		});

		const current = requestWorker("bootstrap");
		await resolveBootstrapContext();
		expect(await current).toMatchObject({
			ok: true,
			auth: { authApiKey: "new_key" },
			bootstrap: { organization: { id: "org_new_user" } },
		});
	});

	it("loads a new account while the previous account's refresh is pending", async () => {
		stored[AUTH_KEY] = { authApiKey: "old_key", userId: "old_user" };
		stored[BOOTSTRAP_CACHE_KEY] = {
			bootstrap: bootstrapFor("old_user", 300),
			cachedAt: Date.now(),
		};
		let finishOldBootstrap!: (response: Response) => void;
		const oldBootstrapResponse = new Promise<Response>((resolve) => {
			finishOldBootstrap = resolve;
		});
		const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
			if (init?.redirect === "manual") {
				return Promise.resolve(new Response(null, { status: 302 }));
			}
			if (init?.method === "POST") {
				return Promise.resolve(Response.json({ success: true }));
			}
			const token = new Headers(init?.headers).get("Authorization");
			return token === "Bearer old_key"
				? oldBootstrapResponse
				: Promise.resolve(Response.json(bootstrapFor("new_user", 0)));
		});
		vi.stubGlobal("fetch", fetchMock);

		const initial = requestWorker("bootstrap");
		await resolveBootstrapContext();
		expect(await initial).toMatchObject({
			ok: true,
			bootstrap: { organization: { id: "org_old_user" } },
		});

		expect(await requestWorker("auth-start")).toMatchObject({
			ok: true,
			authPending: true,
		});
		await vi.waitFor(() => {
			expect(stored[AUTH_KEY]).toMatchObject({
				authApiKey: "new_key",
				userId: "new_user",
			});
			expect(stored[BOOTSTRAP_CACHE_KEY]).toMatchObject({
				bootstrap: { organization: { id: "org_new_user" } },
			});
		});
		finishOldBootstrap(Response.json(bootstrapFor("old_user", 300)));
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(stored[BOOTSTRAP_CACHE_KEY]).toMatchObject({
			bootstrap: { organization: { id: "org_new_user" } },
		});
		const current = requestWorker("bootstrap");
		await resolveBootstrapContext();
		expect(await current).toMatchObject({
			ok: true,
			auth: { authApiKey: "new_key", userId: "new_user" },
			bootstrap: { organization: { id: "org_new_user" } },
		});
	});
});
