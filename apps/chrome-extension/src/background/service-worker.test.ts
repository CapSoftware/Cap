import type { VideoId } from "@cap/recorder-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AUTH_KEY } from "../shared/storage";
import { RECORDING_STATE_KEY } from "../shared/storage-keys";
import type {
	BootstrapData,
	ExtensionAuth,
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
		remove: (keys: string | string[], callback: () => void) => {
			for (const key of typeof keys === "string" ? [keys] : keys) {
				delete stored[key];
			}
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
		identity: {
			getRedirectURL: () => "https://test.chromiumapp.org/",
			launchWebAuthFlow: vi.fn(),
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

const deferred = <T>() => {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
};

describe("bootstrap account ownership", () => {
	const cacheKey = "cap-extension-bootstrap-cache";
	const oldAuth: ExtensionAuth = {
		authApiKey: "old-fixture-key",
		userId: "old-account",
	};
	const oldBootstrap: BootstrapData = {
		user: {
			id: "old-account" as BootstrapData["user"]["id"],
			email: "old@example.invalid",
		},
		organization: {
			id: "old-organization" as BootstrapData["organization"]["id"],
			name: "Old organization",
		},
		plan: { isPro: false, maxRecordingSeconds: 300 },
	};
	let requests: ReturnType<typeof vi.fn<typeof fetch>>;

	const send = (type: "bootstrap" | "auth-start" | "auth-revoke") =>
		new Promise<ServiceWorkerResponse>((resolve) => {
			onMessage({ target: "service-worker", type }, {}, resolve);
		});

	const signIn = async (auth: ExtensionAuth) => {
		expect(await send("auth-start")).toMatchObject({ ok: true });
		const call = vi.mocked(chrome.identity.launchWebAuthFlow).mock.calls[0];
		if (!call?.[1]) throw new Error("No pending sign-in");
		const state = new URL(call[0].url).searchParams.get("state");
		const fragment = new URLSearchParams({
			state: state ?? "",
			...auth,
		});
		call[1](`https://test.chromiumapp.org/#${fragment}`);
		await vi.waitFor(() => expect(stored[AUTH_KEY]).toEqual(auth));
	};

	beforeEach(() => {
		stored[AUTH_KEY] = oldAuth;
		stored[cacheKey] = { bootstrap: oldBootstrap, cachedAt: Date.now() };
		vi.mocked(chrome.runtime.getContexts).mockImplementation(
			(_filter, callback) => callback([]),
		);
		requests = vi.fn<typeof fetch>();
		requests.mockImplementation(async () => Response.json({ success: true }));
		vi.stubGlobal("fetch", requests);
	});

	it("does not restore a signed-out account when a background refresh finishes", async () => {
		const stale = deferred<Response>();
		requests.mockImplementation(async (url) =>
			String(url).endsWith("/bootstrap")
				? stale.promise
				: Response.json({ success: true }),
		);
		expect(await send("bootstrap")).toMatchObject({
			ok: true,
			bootstrap: oldBootstrap,
		});
		expect(await send("auth-revoke")).toMatchObject({ ok: true, auth: null });

		stale.resolve(Response.json(oldBootstrap));
		await new Promise<void>((resolve) => setImmediate(resolve));

		expect(stored[AUTH_KEY]).toBeUndefined();
		expect(stored[cacheKey]).toBeUndefined();
		expect(await send("bootstrap")).toMatchObject({ ok: true, auth: null });
	});

	it.each(["old-account", "new-account"])(
		"starts a fresh request after signing in as %s and ignores the old response",
		async (userId) => {
			const stale = deferred<Response>();
			const fresh = deferred<Response>();
			const newAuth = { authApiKey: "new-fixture-key", userId };
			const newBootstrap: BootstrapData = {
				user: {
					id: userId as BootstrapData["user"]["id"],
					email: "new@example.invalid",
				},
				organization: {
					id: "new-organization" as BootstrapData["organization"]["id"],
					name: "New organization",
				},
				plan: { isPro: true, maxRecordingSeconds: null },
			};
			requests.mockImplementation(async (url, options) => {
				if (!String(url).endsWith("/bootstrap")) {
					return Response.json({ success: true });
				}
				return new Headers(options?.headers).get("Authorization") ===
					`Bearer ${oldAuth.authApiKey}`
					? stale.promise
					: fresh.promise;
			});
			await send("bootstrap");
			await signIn(newAuth);
			await vi.waitFor(() =>
				expect(requests).toHaveBeenCalledWith(
					expect.stringContaining("/bootstrap"),
					expect.objectContaining({
						headers: expect.objectContaining({
							Authorization: `Bearer ${newAuth.authApiKey}`,
						}),
					}),
				),
			);
			expect(stored[cacheKey]).toBeUndefined();
			fresh.resolve(Response.json(newBootstrap));
			await vi.waitFor(() =>
				expect(stored[cacheKey]).toMatchObject({ bootstrap: newBootstrap }),
			);
			stale.resolve(Response.json(oldBootstrap));
			await new Promise<void>((resolve) => setImmediate(resolve));

			expect(await send("bootstrap")).toMatchObject({
				ok: true,
				auth: newAuth,
				bootstrap: newBootstrap,
			});
			expect(stored[cacheKey]).toMatchObject({ bootstrap: newBootstrap });
		},
	);

	it("discards an initial fetch that finishes after sign-out", async () => {
		delete stored[cacheKey];
		const stale = deferred<Response>();
		requests.mockImplementation(async (url) =>
			String(url).endsWith("/bootstrap")
				? stale.promise
				: Response.json({ success: true }),
		);
		const loading = send("bootstrap");
		await vi.waitFor(() => expect(requests).toHaveBeenCalledTimes(1));
		await send("auth-revoke");
		stale.resolve(Response.json(oldBootstrap));

		expect(await loading).toMatchObject({ ok: false });
		expect(stored[cacheKey]).toBeUndefined();
	});

	it("ignores another account's persisted cache after a worker restart", async () => {
		stored[AUTH_KEY] = { ...oldAuth, userId: "new-account" };
		const newBootstrap: BootstrapData = {
			...oldBootstrap,
			user: {
				id: "new-account" as BootstrapData["user"]["id"],
				email: "new@example.invalid",
			},
			plan: { isPro: true, maxRecordingSeconds: null },
		};
		requests.mockImplementation(async () => Response.json(newBootstrap));

		expect(await send("bootstrap")).toMatchObject({
			ok: true,
			bootstrap: newBootstrap,
		});
	});
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
