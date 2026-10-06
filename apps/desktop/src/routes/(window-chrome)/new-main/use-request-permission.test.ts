import { QueryClient, QueryObserver } from "@tanstack/solid-query";
import type { EventCallback } from "@tauri-apps/api/event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { devicesSnapshot } from "~/utils/devices";
import type { OSPermissionsCheck } from "~/utils/tauri";
import useRequestPermission from "./useRequestPermission";

const fixture = vi.hoisted(() => ({
	client: undefined as QueryClient | undefined,
	os: "macos",
	focusListeners: new Set<EventCallback<boolean>>(),
	destroyListeners: new Set<() => void>(),
	onFocusChanged: vi.fn(),
	onDestroyed: vi.fn(),
	isFocused: vi.fn(),
	setAlwaysOnTop: vi.fn().mockResolvedValue(undefined),
	commands: {
		requestPermission: vi.fn().mockResolvedValue(undefined),
		openPermissionSettings: vi.fn().mockResolvedValue(undefined),
		doPermissionsCheck: vi.fn(),
		getDevicesSnapshot: vi.fn(),
	},
}));

vi.mock("@tanstack/solid-query", async (importOriginal) => ({
	...(await importOriginal<typeof import("@tanstack/solid-query")>()),
	useQueryClient: () => fixture.client,
}));

vi.mock("@tauri-apps/api/window", () => ({
	getCurrentWindow: () => ({
		setAlwaysOnTop: fixture.setAlwaysOnTop,
		onFocusChanged: fixture.onFocusChanged,
		once: fixture.onDestroyed,
		isFocused: fixture.isFocused,
	}),
}));

vi.mock("@tauri-apps/plugin-os", () => ({ type: () => fixture.os }));

vi.mock("~/utils/tauri", () => ({
	commands: fixture.commands,
}));

const denied: OSPermissionsCheck = {
	screenRecording: "granted",
	accessibility: "granted",
	microphone: "denied",
	camera: "denied",
};

function focusWindow(focused: boolean) {
	for (const listener of [...fixture.focusListeners]) {
		listener({ event: "tauri://focus", id: 1, payload: focused });
	}
}

function destroyWindow() {
	for (const listener of [...fixture.destroyListeners]) listener();
}

function deferred<T>() {
	let resolve: (value: T) => void = () => {};
	let reject: (reason?: unknown) => void = () => {};
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

async function flush() {
	for (let index = 0; index < 20; index += 1) await Promise.resolve();
}

function expectListenersRemoved() {
	expect(fixture.focusListeners.size).toBe(0);
	expect(fixture.destroyListeners.size).toBe(0);
}

describe("first device permission", () => {
	beforeEach(() => {
		vi.resetAllMocks();
		fixture.os = "macos";
		fixture.isFocused.mockResolvedValue(true);
		fixture.setAlwaysOnTop.mockResolvedValue(undefined);
		fixture.commands.requestPermission.mockResolvedValue(undefined);
		fixture.commands.openPermissionSettings.mockResolvedValue(undefined);
		fixture.commands.doPermissionsCheck.mockResolvedValue(denied);
		fixture.commands.getDevicesSnapshot.mockResolvedValue({
			cameras: [],
			microphones: [],
			permissions: denied,
		});
		fixture.onFocusChanged.mockImplementation(
			async (listener: EventCallback<boolean>) => {
				fixture.focusListeners.add(listener);
				return () => fixture.focusListeners.delete(listener);
			},
		);
		fixture.onDestroyed.mockImplementation(
			async (_event: string, listener: () => void) => {
				fixture.destroyListeners.add(listener);
				return () => fixture.destroyListeners.delete(listener);
			},
		);
		fixture.client = new QueryClient();
	});

	afterEach(() => {
		destroyWindow();
		fixture.client?.clear();
	});

	it.each(["microphone", "camera"] as const)(
		"updates a disabled device query after granting %s permission",
		async (permission) => {
			const client = fixture.client;
			if (!client) throw new Error("Missing query client");
			const before: OSPermissionsCheck = {
				screenRecording: "granted",
				accessibility: "granted",
				microphone: "empty",
				camera: "empty",
			};
			const after = { ...before, [permission]: "granted" } as const;
			client.setQueryData(devicesSnapshot.queryKey, {
				cameras: [],
				microphones: [],
				permissions: before,
			});
			const observer = new QueryObserver(client, {
				...devicesSnapshot,
				enabled: false,
			});
			const unsubscribe = observer.subscribe(() => {});
			fixture.commands.doPermissionsCheck.mockResolvedValue(after);
			fixture.commands.getDevicesSnapshot.mockResolvedValue({
				cameras: [],
				microphones: permission === "microphone" ? ["Test microphone"] : [],
				permissions: after,
			});

			try {
				await useRequestPermission()(permission, "empty");
				expect(fixture.commands.getDevicesSnapshot).toHaveBeenCalledOnce();
				expect(observer.getCurrentResult().data?.permissions[permission]).toBe(
					"granted",
				);
				expect(fixture.setAlwaysOnTop.mock.calls).toEqual([[false], [true]]);
			} finally {
				unsubscribe();
				observer.destroy();
			}
		},
	);
	it("keeps Main lowered through Settings and refreshes after a real focus return", async () => {
		fixture.commands.openPermissionSettings.mockImplementation(async () => {
			expect(fixture.focusListeners.size).toBe(1);
			focusWindow(false);
		});
		await useRequestPermission()("microphone", "denied");
		expect(fixture.setAlwaysOnTop.mock.calls).toEqual([[false]]);
		expect(fixture.commands.getDevicesSnapshot).toHaveBeenCalledTimes(1);
		focusWindow(true);
		await flush();
		expect(fixture.setAlwaysOnTop.mock.calls).toEqual([[false], [true]]);
		expect(fixture.commands.getDevicesSnapshot).toHaveBeenCalledTimes(2);
		expectListenersRemoved();
	});

	it("does not count a focus event without a Settings departure as a return", async () => {
		await useRequestPermission()("camera", "denied");
		focusWindow(true);
		await flush();
		expect(fixture.setAlwaysOnTop.mock.calls).toEqual([[false]]);
		focusWindow(false);
		focusWindow(true);
		await flush();
		expect(fixture.setAlwaysOnTop.mock.calls).toEqual([[false], [true]]);
		expectListenersRemoved();
	});

	it("ignores the consent prompt's focus cycle before the Settings handoff", async () => {
		fixture.commands.requestPermission.mockImplementation(async () => {
			focusWindow(false);
			focusWindow(true);
		});
		await useRequestPermission()("microphone", "empty");
		expect(fixture.setAlwaysOnTop.mock.calls).toEqual([[false]]);
		focusWindow(false);
		focusWindow(true);
		await flush();
		expect(fixture.setAlwaysOnTop.mock.calls).toEqual([[false], [true]]);
		expectListenersRemoved();
	});

	it("remembers an entire Settings focus cycle before the command resolves", async () => {
		fixture.commands.openPermissionSettings.mockImplementation(async () => {
			focusWindow(false);
			focusWindow(true);
		});
		await useRequestPermission()("camera", "denied");
		expect(fixture.setAlwaysOnTop.mock.calls).toEqual([[false], [true]]);
		expectListenersRemoved();
	});

	it("shares listeners and waits for both concurrent permission requests", async () => {
		const answer = deferred<void>();
		fixture.commands.requestPermission.mockReturnValue(answer.promise);
		fixture.commands.openPermissionSettings.mockImplementation(async () =>
			focusWindow(false),
		);
		const request = useRequestPermission();
		const microphone = request("microphone", "empty");
		await flush();
		await useRequestPermission()("camera", "denied");
		expect(fixture.onFocusChanged).toHaveBeenCalledOnce();
		focusWindow(true);
		await flush();
		expect(fixture.setAlwaysOnTop.mock.calls).toEqual([[false], [false]]);
		fixture.commands.doPermissionsCheck.mockResolvedValue({
			...denied,
			microphone: "granted",
		});
		answer.resolve();
		await microphone;
		expect(fixture.setAlwaysOnTop.mock.calls).toEqual([
			[false],
			[false],
			[true],
		]);
		expectListenersRemoved();
	});

	it("requires a return after the newest concurrent Settings handoff", async () => {
		const answer = deferred<OSPermissionsCheck>();
		fixture.commands.doPermissionsCheck.mockReturnValueOnce(answer.promise);
		fixture.commands.openPermissionSettings.mockImplementation(async () =>
			focusWindow(false),
		);
		const first = useRequestPermission()("microphone", "denied");
		await flush();
		focusWindow(true);
		await useRequestPermission()("camera", "denied");
		answer.resolve(denied);
		await first;
		expect(fixture.setAlwaysOnTop.mock.calls).toEqual([[false], [false]]);
		focusWindow(true);
		await flush();
		expect(fixture.setAlwaysOnTop.mock.calls).toEqual([
			[false],
			[false],
			[true],
		]);
		expectListenersRemoved();
	});

	it("keeps the Settings lifetime if permission verification rejects after opening", async () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		fixture.commands.openPermissionSettings.mockImplementation(async () =>
			focusWindow(false),
		);
		fixture.commands.doPermissionsCheck.mockRejectedValueOnce(
			new Error("Permission query failed"),
		);
		await useRequestPermission()("camera", "denied");
		expect(fixture.setAlwaysOnTop.mock.calls).toEqual([[false]]);
		focusWindow(true);
		await flush();
		expect(fixture.setAlwaysOnTop.mock.calls).toEqual([[false], [true]]);
		expectListenersRemoved();
		error.mockRestore();
	});

	it("restores and releases listeners when requesting permission fails", async () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		fixture.commands.requestPermission.mockRejectedValueOnce(
			new Error("Request failed"),
		);
		await useRequestPermission()("microphone", "empty");
		expect(fixture.setAlwaysOnTop.mock.calls).toEqual([[false], [true]]);
		expectListenersRemoved();
		error.mockRestore();
	});

	it("does not raise a destroyed Main from a late focus callback or completion", async () => {
		const answer = deferred<OSPermissionsCheck>();
		fixture.commands.doPermissionsCheck.mockReturnValueOnce(answer.promise);
		const request = useRequestPermission()("microphone", "denied");
		await flush();
		const staleFocus = [...fixture.focusListeners][0];
		destroyWindow();
		answer.resolve(denied);
		await request;
		staleFocus?.({ event: "tauri://focus", id: 1, payload: false });
		staleFocus?.({ event: "tauri://focus", id: 1, payload: true });
		await flush();
		expect(fixture.setAlwaysOnTop.mock.calls).toEqual([[false]]);
		expectListenersRemoved();
	});

	it("does not let an old destroyed session raise a replacement Main", async () => {
		const firstAnswer = deferred<OSPermissionsCheck>();
		fixture.commands.doPermissionsCheck.mockReturnValueOnce(
			firstAnswer.promise,
		);
		const first = useRequestPermission()("microphone", "denied");
		await flush();
		destroyWindow();
		await useRequestPermission()("camera", "denied");
		firstAnswer.resolve(denied);
		await first;
		expect(fixture.setAlwaysOnTop.mock.calls).toEqual([[false], [false]]);
		focusWindow(false);
		focusWindow(true);
		await flush();
		expect(fixture.setAlwaysOnTop.mock.calls).toEqual([
			[false],
			[false],
			[true],
		]);
		expectListenersRemoved();
	});

	it("cancels queued restoration when a new request acquires Main", async () => {
		fixture.commands.openPermissionSettings.mockImplementation(async () =>
			focusWindow(false),
		);
		await useRequestPermission()("microphone", "denied");
		focusWindow(true);
		const next = useRequestPermission()("camera", "denied");
		await next;
		expect(fixture.setAlwaysOnTop.mock.calls).toEqual([[false], [false]]);
		focusWindow(true);
		await flush();
		expect(fixture.setAlwaysOnTop.mock.calls).toEqual([
			[false],
			[false],
			[true],
		]);
		expectListenersRemoved();
	});

	it("cleans up a late focus listener registration after destruction", async () => {
		const listenerReady = deferred<() => void>();
		const remove = vi.fn();
		fixture.onFocusChanged.mockReturnValueOnce(listenerReady.promise);
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		const request = useRequestPermission()("camera", "denied");
		await flush();
		destroyWindow();
		listenerReady.resolve(remove);
		await request;
		expect(remove).toHaveBeenCalledOnce();
		expect(fixture.commands.openPermissionSettings).not.toHaveBeenCalled();
		expect(fixture.setAlwaysOnTop).not.toHaveBeenCalled();
		expectListenersRemoved();
		error.mockRestore();
	});

	it("does not open Settings when focus listener registration fails", async () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		fixture.onFocusChanged.mockRejectedValueOnce(new Error("Listener failed"));
		await useRequestPermission()("microphone", "denied");
		expect(fixture.commands.openPermissionSettings).not.toHaveBeenCalled();
		expectListenersRemoved();
		error.mockRestore();
	});

	it("repeated Settings visits keep at most one listener pair and remove it on return", async () => {
		for (let index = 0; index < 20; index += 1) {
			await useRequestPermission()("camera", "denied");
			expect(fixture.focusListeners.size).toBe(1);
			expect(fixture.destroyListeners.size).toBe(1);
			focusWindow(false);
			focusWindow(true);
			await flush();
			expectListenersRemoved();
		}
		expect(fixture.setAlwaysOnTop).toHaveBeenCalledTimes(40);
	});

	it.each(["windows", "linux"])(
		"preserves the existing %s permission path",
		async (os) => {
			fixture.os = os;
			await useRequestPermission()("microphone", "denied");
			expect(fixture.setAlwaysOnTop.mock.calls).toEqual([[false], [true]]);
			expect(fixture.onFocusChanged).not.toHaveBeenCalled();
			expect(fixture.onDestroyed).not.toHaveBeenCalled();
		},
	);
	it("orders a new demotion after an already-issued restore before opening Settings", async () => {
		const restore = deferred<void>();
		fixture.commands.openPermissionSettings.mockImplementation(async () =>
			focusWindow(false),
		);
		await useRequestPermission()("microphone", "denied");
		fixture.setAlwaysOnTop.mockImplementationOnce(() => restore.promise);
		focusWindow(true);
		await flush();
		expect(fixture.setAlwaysOnTop.mock.calls).toEqual([[false], [true]]);
		const next = useRequestPermission()("camera", "denied");
		await flush();
		expect(fixture.commands.openPermissionSettings).toHaveBeenCalledTimes(1);
		restore.resolve();
		await next;
		expect(fixture.setAlwaysOnTop.mock.calls).toEqual([
			[false],
			[true],
			[false],
		]);
		focusWindow(true);
		await flush();
		expect(fixture.setAlwaysOnTop.mock.calls).toEqual([
			[false],
			[true],
			[false],
			[true],
		]);
		expectListenersRemoved();
	});

	it("cleans listeners if lowering Main fails before the native permission request", async () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		fixture.setAlwaysOnTop.mockRejectedValueOnce(
			new Error("Window unavailable"),
		);
		await useRequestPermission()("camera", "denied");
		expect(fixture.commands.openPermissionSettings).not.toHaveBeenCalled();
		expectListenersRemoved();
		error.mockRestore();
	});

	it("retries a failed restoration on the next focus event without adding listeners", async () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		await useRequestPermission()("camera", "denied");
		fixture.setAlwaysOnTop.mockRejectedValueOnce(
			new Error("Temporary window error"),
		);
		focusWindow(false);
		focusWindow(true);
		await flush();
		expect(fixture.focusListeners.size).toBe(1);
		focusWindow(false);
		focusWindow(true);
		await flush();
		expect(fixture.onFocusChanged).toHaveBeenCalledOnce();
		expect(fixture.setAlwaysOnTop.mock.calls).toEqual([
			[false],
			[true],
			[true],
		]);
		expectListenersRemoved();
		error.mockRestore();
	});
	it("restores after denial goes straight from the native prompt into Settings", async () => {
		fixture.commands.requestPermission.mockImplementation(async () =>
			focusWindow(false),
		);
		await useRequestPermission()("microphone", "empty");
		expect(fixture.setAlwaysOnTop.mock.calls).toEqual([[false]]);
		focusWindow(true);
		await flush();
		expect(fixture.setAlwaysOnTop.mock.calls).toEqual([[false], [true]]);
		expectListenersRemoved();
	});

	it("restores after concurrent Settings opens without a duplicate blur notification", async () => {
		const answer = deferred<OSPermissionsCheck>();
		fixture.commands.doPermissionsCheck.mockReturnValueOnce(answer.promise);
		fixture.commands.openPermissionSettings.mockImplementationOnce(async () =>
			focusWindow(false),
		);
		const first = useRequestPermission()("microphone", "denied");
		await flush();
		await useRequestPermission()("camera", "denied");
		answer.resolve(denied);
		await first;
		expect(fixture.setAlwaysOnTop.mock.calls).toEqual([[false], [false]]);
		focusWindow(true);
		await flush();
		expect(fixture.setAlwaysOnTop.mock.calls).toEqual([
			[false],
			[false],
			[true],
		]);
		expectListenersRemoved();
	});

	it("initializes an already unfocused Main without waiting for a duplicate blur", async () => {
		fixture.isFocused.mockResolvedValueOnce(false);
		await useRequestPermission()("camera", "denied");
		expect(fixture.isFocused).toHaveBeenCalledOnce();
		focusWindow(true);
		await flush();
		expect(fixture.setAlwaysOnTop.mock.calls).toEqual([[false], [true]]);
		expectListenersRemoved();
	});

	it("ignores an old unfocused snapshot after a newer focus event", async () => {
		const snapshot = deferred<boolean>();
		fixture.isFocused.mockReturnValueOnce(snapshot.promise);
		const request = useRequestPermission()("camera", "denied");
		await flush();
		focusWindow(false);
		focusWindow(true);
		snapshot.resolve(false);
		await request;
		focusWindow(true);
		await flush();
		expect(fixture.setAlwaysOnTop.mock.calls).toEqual([[false]]);
		focusWindow(false);
		focusWindow(true);
		await flush();
		expect(fixture.setAlwaysOnTop.mock.calls).toEqual([[false], [true]]);
		expectListenersRemoved();
	});

	it("preserves a newer blur event while an old focused snapshot is pending", async () => {
		const snapshot = deferred<boolean>();
		fixture.isFocused.mockReturnValueOnce(snapshot.promise);
		const request = useRequestPermission()("microphone", "denied");
		await flush();
		focusWindow(false);
		snapshot.resolve(true);
		await request;
		focusWindow(true);
		await flush();
		expect(fixture.setAlwaysOnTop.mock.calls).toEqual([[false], [true]]);
		expectListenersRemoved();
	});

	it("cleans up when the initial native focus query fails", async () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		fixture.isFocused.mockRejectedValueOnce(new Error("Focus unavailable"));
		await useRequestPermission()("camera", "denied");
		expect(fixture.commands.openPermissionSettings).not.toHaveBeenCalled();
		expectListenersRemoved();
		error.mockRestore();
	});
});
