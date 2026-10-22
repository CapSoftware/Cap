import { beforeEach, describe, expect, it } from "vitest";
import {
	type FailedRecording,
	loadFailedRecordings,
	loadManagedApiBaseUrl,
	loadOverlayTokens,
	loadSettings,
	loadSharedRecordingState,
	loadSharedUiState,
	registerOverlayToken,
	saveSettings,
	saveSharedRecordingState,
	updateSharedUiState,
	upsertFailedRecording,
} from "./storage";

// chrome.storage resolves callbacks asynchronously, which is what lets
// concurrent read-modify-write calls interleave (both read before either
// writes). The fake reproduces that timing so the tests fail without the
// per-key write queue in storage.ts.
const createAsyncStorageArea = (
	getSetDelayMs: (writeIndex: number) => number = () => 0,
) => {
	const data = new Map<string, unknown>();
	let writeIndex = 0;
	return {
		get(keys: string[], callback: (items: Record<string, unknown>) => void) {
			const snapshot: Record<string, unknown> = {};
			for (const key of keys) {
				if (data.has(key)) snapshot[key] = data.get(key);
			}
			setTimeout(() => callback(snapshot), 0);
		},
		set(items: Record<string, unknown>, callback: () => void) {
			const delayMs = getSetDelayMs(writeIndex);
			writeIndex += 1;
			setTimeout(() => {
				for (const [key, value] of Object.entries(items)) {
					data.set(key, value);
				}
				callback();
			}, delayMs);
		},
		remove(keys: string[] | string, callback: () => void) {
			setTimeout(() => {
				for (const key of Array.isArray(keys) ? keys : [keys]) {
					data.delete(key);
				}
				callback();
			}, 0);
		},
	};
};

const failedRecording = (sessionId: string): FailedRecording => ({
	sessionId,
	videoId: null,
	shareUrl: null,
	mimeType: "video/webm",
	subpath: null,
	durationMs: 1000,
	width: null,
	height: null,
	fps: null,
	totalBytes: 1024,
	createdAt: Date.now(),
	message: null,
});

beforeEach(() => {
	(globalThis as { chrome?: unknown }).chrome = {
		storage: {
			local: createAsyncStorageArea(),
			session: createAsyncStorageArea(),
		},
	};
});

describe("storage read-modify-write serialization", () => {
	it("keeps every overlay token registered by concurrent calls", async () => {
		await Promise.all([
			registerOverlayToken("token-a"),
			registerOverlayToken("token-b"),
			registerOverlayToken("token-c"),
		]);

		const tokens = await loadOverlayTokens();
		expect(Object.keys(tokens).sort()).toEqual([
			"token-a",
			"token-b",
			"token-c",
		]);
	});

	it("applies concurrent shared UI state updates without dropping either", async () => {
		await Promise.all([
			updateSharedUiState((current) => ({
				...current,
				panelOpen: true,
				updatedAt: Date.now(),
			})),
			updateSharedUiState((current) => ({
				...current,
				readyBarDismissed: true,
				updatedAt: Date.now(),
			})),
		]);

		const state = await loadSharedUiState();
		expect(state.panelOpen).toBe(true);
		expect(state.readyBarDismissed).toBe(true);
	});

	it("keeps every failed recording upserted by concurrent calls", async () => {
		await Promise.all([
			upsertFailedRecording(failedRecording("session-a")),
			upsertFailedRecording(failedRecording("session-b")),
		]);

		const recordings = await loadFailedRecordings();
		expect(recordings.map((entry) => entry.sessionId).sort()).toEqual([
			"session-a",
			"session-b",
		]);
	});

	it("keeps the newest recording status when an earlier write is slower", async () => {
		(globalThis as { chrome?: unknown }).chrome = {
			storage: {
				local: createAsyncStorageArea(),
				session: createAsyncStorageArea((writeIndex) =>
					writeIndex === 0 ? 20 : 0,
				),
			},
		};

		await Promise.all([
			saveSharedRecordingState({
				status: { phase: "creating" },
				plan: null,
				updatedAt: 1,
			}),
			saveSharedRecordingState({
				status: { phase: "idle" },
				plan: null,
				updatedAt: 2,
			}),
		]);

		expect((await loadSharedRecordingState())?.status.phase).toBe("idle");
	});
});

const setManagedPolicy = (policy: Record<string, unknown> | null) => {
	const chromeGlobal = (globalThis as { chrome: { storage: object } }).chrome;
	chromeGlobal.storage = {
		...chromeGlobal.storage,
		managed: {
			get(_keys: string[], callback: (items: Record<string, unknown>) => void) {
				setTimeout(() => callback(policy ?? {}), 0);
			},
		},
	};
};

describe("managed apiBaseUrl policy", () => {
	it("ignores the managed area when it is unavailable", async () => {
		expect(await loadManagedApiBaseUrl()).toBeNull();
	});

	it("overrides the saved Cap URL with the managed one", async () => {
		const settings = await loadSettings();
		await saveSettings({ ...settings, apiBaseUrl: "https://user.example" });
		setManagedPolicy({ apiBaseUrl: " https://cap.corp.example/ " });

		const { apiBaseUrl } = await loadSettings();
		expect(apiBaseUrl).toBe("https://cap.corp.example");
	});

	it("applies the managed Cap URL before any settings are saved", async () => {
		setManagedPolicy({ apiBaseUrl: "https://cap.corp.example" });

		const { apiBaseUrl } = await loadSettings();
		expect(apiBaseUrl).toBe("https://cap.corp.example");
	});

	it("rejects managed values that are not http(s) URLs", async () => {
		for (const apiBaseUrl of ["not a url", "javascript:alert(1)", 42]) {
			setManagedPolicy({ apiBaseUrl });
			expect(await loadManagedApiBaseUrl()).toBeNull();
		}
	});

	it("keeps the saved Cap URL when no policy is set", async () => {
		const settings = await loadSettings();
		await saveSettings({ ...settings, apiBaseUrl: "https://user.example" });
		setManagedPolicy(null);

		expect((await loadSettings()).apiBaseUrl).toBe("https://user.example");
	});
});
