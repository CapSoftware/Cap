// @vitest-environment jsdom

import { act } from "react";
import type { createRoot, Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WebcamSettings } from "../shared/types";

const preview = vi.hoisted(() => ({
	connect:
		vi.fn<
			(
				settings: WebcamSettings,
				sessionId: string,
			) => Promise<{
				peer: RTCPeerConnection;
				stream: MediaStream;
			}>
		>(),
	root: null as Root | null,
}));

vi.mock("../shared/camera-preview-connection", () => ({
	connectCameraPreview: preview.connect,
}));

vi.mock("react-dom/client", async (importOriginal) => {
	const original = await importOriginal<{ createRoot: typeof createRoot }>();
	return {
		...original,
		createRoot: (...args: Parameters<typeof original.createRoot>) => {
			preview.root = original.createRoot(...args);
			return preview.root;
		},
	};
});

class PreviewTrack extends EventTarget {
	muted = false;
	stop = vi.fn();
}

class PreviewPeer extends EventTarget {
	connectionState: RTCPeerConnectionState = "connected";
	close = vi.fn(() => {
		this.connectionState = "closed";
	});
}

const settings: WebcamSettings = {
	enabled: true,
	deviceId: "camera-1",
	position: "bottom-left",
	size: 230,
	shape: "round",
	mirror: false,
};

let host: HTMLDivElement;
let listener: ((message: unknown) => void) | undefined;
let connections: Array<{ peer: PreviewPeer; track: PreviewTrack }>;

const sendSettings = async (updates: Partial<WebcamSettings> = {}) => {
	await act(async () => {
		listener?.({
			source: "cap-extension-overlay",
			token: "preview-test",
			type: "settings",
			settings: { ...settings, ...updates },
		});
	});
};

beforeEach(async () => {
	vi.resetModules();
	vi.useFakeTimers();
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	vi.stubGlobal("chrome", {
		runtime: {
			sendMessage: vi.fn((_message, callback) => callback({ ok: true })),
			onMessage: {
				addListener: (next: typeof listener) => {
					listener = next;
				},
				removeListener: () => {
					listener = undefined;
				},
			},
		},
	});
	vi.stubGlobal("navigator", {
		userAgent: navigator.userAgent,
		mediaDevices: { enumerateDevices: vi.fn(async () => []) },
	});
	vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
	window.location.hash = "preview-test";
	host = document.createElement("div");
	host.id = "root";
	document.body.append(host);
	connections = [];
	preview.connect.mockReset();
	preview.connect.mockImplementation(async () => {
		const peer = new PreviewPeer();
		const track = new PreviewTrack();
		connections.push({ peer, track });
		return {
			peer: peer as unknown as RTCPeerConnection,
			stream: {
				getTracks: () => [track],
				getVideoTracks: () => [track],
			} as unknown as MediaStream,
		};
	});
	await act(async () => {
		await import("./camera-preview");
	});
	await sendSettings();
	expect(preview.connect).toHaveBeenCalledTimes(1);
});

afterEach(() => {
	act(() => preview.root?.unmount());
	preview.root = null;
	host.remove();
	vi.clearAllTimers();
	vi.useRealTimers();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe("camera preview recovery", () => {
	it("recovers a lost track without a settings change", async () => {
		await act(async () => {
			connections[0].track.dispatchEvent(new Event("ended"));
		});
		expect(preview.connect).toHaveBeenCalledTimes(2);
	});

	it.each<Partial<WebcamSettings>>([
		{ mirror: true },
		{ size: 300 },
		{ shape: "square" },
		{ position: "top-right" },
	])("recovers a lost track after appearance changes %j", async (updates) => {
		const first = connections[0];
		await sendSettings(updates);
		expect(preview.connect).toHaveBeenCalledTimes(1);
		expect(host.querySelector("video")?.dataset.mirror).toBe(
			updates.mirror ? "true" : "false",
		);
		await act(async () => {
			first.track.dispatchEvent(new Event("ended"));
		});
		expect(preview.connect).toHaveBeenCalledTimes(2);
	});

	it("recovers a failed peer after a mirror change", async () => {
		const first = connections[0];
		await sendSettings({ mirror: true });
		await act(async () => {
			first.peer.connectionState = "failed";
			first.peer.dispatchEvent(new Event("connectionstatechange"));
		});
		expect(preview.connect).toHaveBeenCalledTimes(2);
	});

	it.each(["mute", "disconnect"])(
		"preserves the grace period for %s after a mirror change",
		async (failure) => {
			const first = connections[0];
			await sendSettings({ mirror: true });
			await act(async () => {
				if (failure === "mute") {
					first.track.muted = true;
					first.track.dispatchEvent(new Event("mute"));
				} else {
					first.peer.connectionState = "disconnected";
					first.peer.dispatchEvent(new Event("connectionstatechange"));
				}
				await vi.advanceTimersByTimeAsync(1999);
			});
			expect(preview.connect).toHaveBeenCalledTimes(1);
			await act(async () => {
				await vi.advanceTimersByTimeAsync(1);
			});
			expect(preview.connect).toHaveBeenCalledTimes(2);
		},
	);

	it("retains a pending connection through an appearance change", async () => {
		let resolveConnection:
			| ((connection: Awaited<ReturnType<typeof preview.connect>>) => void)
			| undefined;
		preview.connect.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					resolveConnection = resolve;
				}),
		);
		await sendSettings({ deviceId: "camera-2" });
		await sendSettings({ deviceId: "camera-2", mirror: true });
		expect(preview.connect).toHaveBeenCalledTimes(2);
		const peer = new PreviewPeer();
		const track = new PreviewTrack();
		const stream = {
			getTracks: () => [track],
			getVideoTracks: () => [track],
		} as unknown as MediaStream;
		await act(async () => {
			resolveConnection?.({
				peer: peer as unknown as RTCPeerConnection,
				stream,
			});
		});
		expect(peer.close).not.toHaveBeenCalled();
		expect(host.querySelector("video")?.srcObject).toBe(stream);
		await act(async () => {
			track.dispatchEvent(new Event("ended"));
		});
		expect(preview.connect).toHaveBeenCalledTimes(3);
	});

	it("replaces the connection when the camera changes and stops it when disabled", async () => {
		const first = connections[0];
		await sendSettings({ deviceId: "camera-2" });
		expect(preview.connect).toHaveBeenCalledTimes(2);
		expect(first.peer.close).toHaveBeenCalled();
		expect(first.track.stop).toHaveBeenCalled();
		const second = connections[1];
		await sendSettings({ enabled: false });
		expect(second.peer.close).toHaveBeenCalled();
		expect(second.track.stop).toHaveBeenCalled();
		await act(async () => {
			first.track.dispatchEvent(new Event("ended"));
			second.track.dispatchEvent(new Event("ended"));
		});
		expect(preview.connect).toHaveBeenCalledTimes(2);
	});
});
