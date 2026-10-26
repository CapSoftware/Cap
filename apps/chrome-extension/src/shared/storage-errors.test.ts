import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	clearAuth,
	clearAuthError,
	FAILED_RECORDINGS_KEY,
	type FailedRecording,
	loadFailedRecordings,
	loadSharedRecordingState,
	saveAuth,
	saveSharedRecordingState,
	upsertFailedRecording,
} from "./storage";

const runtime: { lastError?: { message?: string } } = {};

function storageArea() {
	const data = new Map<string, unknown>();
	const failures: Partial<
		Record<"get" | "set" | "remove", { message?: string }>
	> = {};
	function complete(operation: "get" | "set" | "remove", callback: () => void) {
		queueMicrotask(() => {
			runtime.lastError = failures[operation];
			delete failures[operation];
			try {
				callback();
			} finally {
				delete runtime.lastError;
			}
		});
	}
	return {
		data,
		failures,
		get: vi.fn(
			(keys: string[], callback: (items: Record<string, unknown>) => void) => {
				complete("get", () =>
					callback(
						runtime.lastError
							? {}
							: Object.fromEntries(keys.map((key) => [key, data.get(key)])),
					),
				);
			},
		),
		set: vi.fn((items: Record<string, unknown>, callback: () => void) => {
			complete("set", () => {
				if (!runtime.lastError)
					for (const [key, value] of Object.entries(items))
						data.set(key, value);
				callback();
			});
		}),
		remove: vi.fn((keys: string[] | string, callback: () => void) => {
			complete("remove", () => {
				if (!runtime.lastError)
					for (const key of typeof keys === "string" ? [keys] : keys)
						data.delete(key);
				callback();
			});
		}),
	};
}

let local: ReturnType<typeof storageArea>;
let session: ReturnType<typeof storageArea>;

beforeEach(() => {
	local = storageArea();
	session = storageArea();
	vi.stubGlobal("chrome", { runtime, storage: { local, session } });
});
afterEach(() => vi.unstubAllGlobals());

const recording = (sessionId: string): FailedRecording => ({
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
	createdAt: 1000,
	message: null,
});

describe("Chrome storage callback errors", () => {
	it.each([
		["local", "get", () => loadFailedRecordings()],
		["local", "set", () => saveAuth({ authApiKey: "key", userId: "user" })],
		["local", "remove", () => clearAuth()],
		["session", "get", () => loadSharedRecordingState()],
		[
			"session",
			"set",
			() =>
				saveSharedRecordingState({
					status: { phase: "idle" },
					plan: null,
					updatedAt: 1,
				}),
		],
		["session", "remove", () => clearAuthError()],
	] as const)(
		"rejects %s.%s while lastError is available in the callback",
		async (area, operation, run) => {
			const storage = area === "local" ? local : session;
			storage.failures[operation] = { message: "Storage unavailable" };
			await expect(run()).rejects.toThrow("Storage unavailable");
			expect(runtime.lastError).toBeUndefined();
		},
	);

	it("rejects an error without a message instead of treating it as success", async () => {
		local.failures.get = {};
		await expect(loadFailedRecordings()).rejects.toThrow(
			"Chrome storage operation failed",
		);
	});

	it("does not overwrite stored recordings when a read fails during an update", async () => {
		local.data.set(FAILED_RECORDINGS_KEY, [recording("older")]);
		local.failures.get = { message: "Read failed" };
		await expect(upsertFailedRecording(recording("new"))).rejects.toThrow(
			"Read failed",
		);
		expect(local.set).not.toHaveBeenCalled();
		expect(await loadFailedRecordings()).toEqual([recording("older")]);
	});

	it("rejects a quota failure and allows the next queued recording update", async () => {
		local.data.set(FAILED_RECORDINGS_KEY, [recording("older")]);
		local.failures.set = { message: "QUOTA_BYTES quota exceeded" };
		const rejected = expect(
			upsertFailedRecording(recording("failed")),
		).rejects.toThrow("QUOTA_BYTES");
		const next = upsertFailedRecording(recording("next"));
		await rejected;
		await next;
		expect(
			(await loadFailedRecordings()).map((entry) => entry.sessionId).sort(),
		).toEqual(["next", "older"]);
	});

	it("does not report recordings as dropped until the replacement list is persisted", async () => {
		const existing = Array.from({ length: 5 }, (_, index) =>
			recording(`old-${index}`),
		);
		local.data.set(FAILED_RECORDINGS_KEY, existing);
		local.failures.set = { message: "QUOTA_BYTES quota exceeded" };
		const reclaim = vi.fn();
		const persist = upsertFailedRecording({
			...recording("new"),
			createdAt: 2000,
		}).then(({ dropped }) => {
			for (const entry of dropped) reclaim(entry.sessionId);
		});
		await expect(persist).rejects.toThrow("QUOTA_BYTES");
		expect(reclaim).not.toHaveBeenCalled();
		expect(await loadFailedRecordings()).toEqual(existing);
	});
});
