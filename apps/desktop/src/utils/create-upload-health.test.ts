import { createRoot, createSignal } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createUploadHealth } from "./create-upload-health";
import type { UploadHealthStatus } from "./upload-health";

vi.mock("solid-js", () => vi.importActual("solid-js/dist/solid.js"));

const commands = vi.hoisted(() => ({ read: vi.fn(), refresh: vi.fn() }));
vi.mock("./upload-health", () => ({
	getUploadHealthStatus: commands.read,
	refreshUploadHealthStatus: commands.refresh,
}));

const unknown: UploadHealthStatus = {
	kind: "unknown",
	uploadMbps: null,
	maxInstantResolution: null,
	checkedAtUnixMs: null,
	stale: true,
	message: "Not checked",
};
const healthy: UploadHealthStatus = {
	...unknown,
	kind: "healthy",
	uploadMbps: 24,
	maxInstantResolution: 2560,
	stale: false,
};
const slow: UploadHealthStatus = {
	...healthy,
	kind: "slow",
	uploadMbps: 2,
	maxInstantResolution: 1280,
};

function deferred<T>() {
	let resolve!: (result: T) => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<T>((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { promise, resolve, reject };
}

const cleanups: (() => void)[] = [];
function mount(user: string | null = "account-a") {
	return createRoot((dispose) => {
		cleanups.push(dispose);
		const [serverUrl, setServer] = createSignal("https://cap.example");
		const [userId, setUser] = createSignal(user);
		const [isRecording, setRecording] = createSignal(false);
		const health = createUploadHealth({ serverUrl, userId, isRecording });
		return { health, setServer, setUser, setRecording, dispose };
	});
}

beforeEach(() => {
	vi.useFakeTimers();
	commands.read.mockReset().mockResolvedValue(unknown);
	commands.refresh.mockReset().mockResolvedValue(healthy);
});
afterEach(() => {
	for (const dispose of cleanups.splice(0)) dispose();
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe("upload health lifecycle", () => {
	it("reads the cache before a delayed startup probe and refreshes periodically", async () => {
		const { health } = mount();
		await vi.advanceTimersByTimeAsync(0);
		expect(health.status()).toEqual(unknown);
		expect(commands.refresh).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(800);
		expect(health.status()).toEqual(healthy);
		expect(commands.refresh).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
		expect(commands.refresh).toHaveBeenCalledTimes(2);
	});

	it("starts promptly after sign-in even when startup was unauthenticated", async () => {
		const { setUser } = mount(null);
		await vi.advanceTimersByTimeAsync(1_000);
		expect(commands.refresh).not.toHaveBeenCalled();
		setUser("account-b");
		await vi.advanceTimersByTimeAsync(800);
		expect(commands.refresh).toHaveBeenCalledOnce();
	});

	it("does not probe during recording, then refreshes after stop", async () => {
		const { health, setRecording } = mount();
		setRecording(true);
		await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
		await health.refresh();
		expect(commands.refresh).not.toHaveBeenCalled();
		setRecording(false);
		await vi.advanceTimersByTimeAsync(999);
		expect(commands.refresh).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1);
		expect(commands.refresh).toHaveBeenCalledOnce();
	});

	it("coalesces overlapping manual and periodic refreshes", async () => {
		const pending = deferred<UploadHealthStatus>();
		commands.refresh.mockReturnValue(pending.promise);
		const { health } = mount();
		await vi.advanceTimersByTimeAsync(800);
		await health.refresh();
		await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
		expect(commands.refresh).toHaveBeenCalledOnce();
		expect(health.refreshing()).toBe(true);
		pending.resolve(healthy);
		await vi.advanceTimersByTimeAsync(0);
		expect(health.refreshing()).toBe(false);
	});

	it("queues a post-recording check while an older IPC command is settling", async () => {
		const pending = deferred<UploadHealthStatus>();
		commands.refresh
			.mockReturnValueOnce(pending.promise)
			.mockResolvedValue(slow);
		const { health, setRecording } = mount();
		await vi.advanceTimersByTimeAsync(800);
		setRecording(true);
		await vi.advanceTimersByTimeAsync(0);
		setRecording(false);
		await vi.advanceTimersByTimeAsync(1_000);
		expect(commands.refresh).toHaveBeenCalledOnce();
		pending.resolve(unknown);
		await vi.advanceTimersByTimeAsync(0);
		expect(commands.refresh).toHaveBeenCalledTimes(2);
		expect(health.status()).toEqual(slow);
	});

	it.each(["server", "account"])(
		"discards old results on a %s switch and refreshes the new context",
		async (change) => {
			const pending = deferred<UploadHealthStatus>();
			commands.refresh
				.mockReturnValueOnce(pending.promise)
				.mockResolvedValue(slow);
			const { health, setServer, setUser } = mount();
			await vi.advanceTimersByTimeAsync(800);
			if (change === "server") setServer("https://self-hosted.example");
			else setUser("account-b");
			await vi.advanceTimersByTimeAsync(800);
			expect(health.status()).toEqual(unknown);
			pending.resolve(healthy);
			await vi.advanceTimersByTimeAsync(0);
			expect(commands.refresh).toHaveBeenCalledTimes(2);
			expect(health.status()).toEqual(slow);
		},
	);

	it("does not replace a fresh result with a delayed cache read", async () => {
		const cached = deferred<UploadHealthStatus>();
		commands.read.mockReturnValue(cached.promise);
		const { health } = mount();
		await vi.advanceTimersByTimeAsync(800);
		expect(health.status()).toEqual(healthy);
		cached.resolve(slow);
		await vi.advanceTimersByTimeAsync(0);
		expect(health.status()).toEqual(healthy);
	});

	it("does not erase fresh status when an older cache read fails", async () => {
		const cached = deferred<UploadHealthStatus>();
		commands.read.mockReturnValue(cached.promise);
		const { health } = mount();
		await vi.advanceTimersByTimeAsync(800);
		cached.reject(new Error("old cache read failed"));
		await vi.advanceTimersByTimeAsync(0);
		expect(health.status()).toEqual(healthy);
	});

	it("clears prior success on command failure and allows retry", async () => {
		vi.spyOn(console, "error").mockImplementation(() => undefined);
		const { health } = mount();
		await vi.advanceTimersByTimeAsync(800);
		commands.refresh.mockRejectedValueOnce(new Error("disconnected"));
		await health.refresh();
		expect(health.status()).toBeNull();
		expect(health.refreshing()).toBe(false);
		await health.refresh();
		expect(health.status()).toEqual(healthy);
	});

	it("clears success on sign-out and does not restart a pending probe", async () => {
		const pending = deferred<UploadHealthStatus>();
		commands.refresh.mockReturnValueOnce(pending.promise);
		const { health, setUser } = mount();
		await vi.advanceTimersByTimeAsync(800);
		setUser(null);
		await vi.advanceTimersByTimeAsync(800);
		pending.resolve(healthy);
		await vi.advanceTimersByTimeAsync(0);
		expect(health.status()).toEqual(unknown);
		expect(commands.refresh).toHaveBeenCalledOnce();
	});

	it("disposal prevents timers and late results from updating the component", async () => {
		const pending = deferred<UploadHealthStatus>();
		commands.refresh.mockReturnValueOnce(pending.promise);
		const { health, dispose } = mount();
		await vi.advanceTimersByTimeAsync(800);
		dispose();
		pending.resolve(healthy);
		await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
		expect(health.status()).toEqual(unknown);
		expect(commands.refresh).toHaveBeenCalledOnce();
		expect(vi.getTimerCount()).toBe(0);
	});
});
