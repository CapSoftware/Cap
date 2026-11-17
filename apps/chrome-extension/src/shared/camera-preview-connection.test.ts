import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { connectCameraPreview } from "./camera-preview-connection";
import { sendServiceWorkerMessage } from "./runtime";
import type { WebcamSettings } from "./types";

vi.mock("./runtime", () => ({ sendServiceWorkerMessage: vi.fn() }));

const settings: WebcamSettings = {
	enabled: true,
	deviceId: null,
	position: "bottom-left",
	size: 200,
	shape: "round",
	mirror: true,
};

let failedStage: string | null = null;
let failure = new Error("Negotiation failed");

class Peer extends EventTarget {
	static latest: Peer;
	iceGatheringState = "complete";
	connectionState = "new";
	localDescription = { type: "offer", sdp: "local" };
	addTransceiver = vi.fn();
	createOffer = vi.fn(async () => {
		if (failedStage === "offer") throw failure;
		return this.localDescription;
	});
	setLocalDescription = vi.fn(async () => {
		if (failedStage === "local description") throw failure;
	});
	setRemoteDescription = vi.fn(async () => {});
	close = vi.fn(() => {
		this.connectionState = "closed";
	});
	constructor() {
		super();
		Peer.latest = this;
	}
	track(stream: MediaStream) {
		const event = new Event("track");
		Object.defineProperty(event, "streams", { value: [stream] });
		this.dispatchEvent(event);
	}
}

const flush = async () => {
	for (let i = 0; i < 8; i++) await Promise.resolve();
};

beforeEach(() => {
	failedStage = null;
	vi.useFakeTimers();
	vi.stubGlobal("RTCPeerConnection", Peer);
	vi.stubGlobal("window", globalThis);
	vi.mocked(sendServiceWorkerMessage).mockReset();
	vi.mocked(sendServiceWorkerMessage).mockResolvedValue({
		ok: true,
		answer: { type: "answer", sdp: "remote" },
	});
});

afterEach(() => {
	vi.clearAllTimers();
	vi.useRealTimers();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe("camera preview connection ownership", () => {
	it.each(["offer", "local description", "messaging", "remote description"])(
		"closes the peer and cancels its waiter after %s fails",
		async (stage) => {
			failure = new Error(`${stage} failed`);
			failedStage = stage;
			const starting = connectCameraPreview(settings, "session").catch(
				(error: unknown) => error,
			);
			const peer = Peer.latest;
			const remove = vi.spyOn(peer, "removeEventListener");
			if (stage === "messaging")
				vi.mocked(sendServiceWorkerMessage).mockRejectedValueOnce(failure);
			if (stage === "remote description")
				peer.setRemoteDescription.mockRejectedValueOnce(failure);
			expect(await starting).toBe(failure);
			expect(peer.close).toHaveBeenCalledTimes(1);
			expect(vi.getTimerCount()).toBe(0);
			expect(remove).toHaveBeenCalledWith("track", expect.any(Function));
			expect(remove).toHaveBeenCalledWith(
				"connectionstatechange",
				expect.any(Function),
			);
		},
	);

	it.each(["rejected", "missing answer"])(
		"cleans up after a %s response",
		async (outcome) => {
			vi.mocked(sendServiceWorkerMessage).mockResolvedValueOnce(
				outcome === "rejected"
					? { ok: false, error: "Camera busy" }
					: { ok: true },
			);
			await expect(connectCameraPreview(settings, "session")).rejects.toThrow(
				outcome === "rejected"
					? "Camera busy"
					: "Camera preview did not return an answer.",
			);
			expect(Peer.latest.close).toHaveBeenCalledTimes(1);
			expect(vi.getTimerCount()).toBe(0);
		},
	);

	it("closes a peer when no track arrives before the timeout", async () => {
		const starting = connectCameraPreview(settings, "session").catch(
			(error: unknown) => error,
		);
		await flush();
		await vi.advanceTimersByTimeAsync(10_000);
		expect(await starting).toMatchObject({
			message: "Camera preview timed out.",
		});
		expect(Peer.latest.close).toHaveBeenCalledTimes(1);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("releases an early track when applying the answer fails", async () => {
		const stop = vi.fn();
		const stream = { getTracks: () => [{ stop }] } as unknown as MediaStream;
		const starting = connectCameraPreview(settings, "session").catch(
			(error: unknown) => error,
		);
		const failure = new Error("Invalid answer");
		Peer.latest.setRemoteDescription.mockImplementationOnce(async () => {
			Peer.latest.track(stream);
			throw failure;
		});
		expect(await starting).toBe(failure);
		expect(stop).toHaveBeenCalledTimes(1);
		expect(Peer.latest.close).toHaveBeenCalledTimes(1);
	});

	it("closes the peer and removes listeners when the connection fails", async () => {
		const starting = connectCameraPreview(settings, "session").catch(
			(error: unknown) => error,
		);
		await flush();
		const peer = Peer.latest;
		const remove = vi.spyOn(peer, "removeEventListener");
		peer.connectionState = "failed";
		peer.dispatchEvent(new Event("connectionstatechange"));
		expect(await starting).toMatchObject({
			message: "Camera preview connection failed.",
		});
		expect(peer.close).toHaveBeenCalledTimes(1);
		expect(remove).toHaveBeenCalledWith("track", expect.any(Function));
		expect(remove).toHaveBeenCalledWith(
			"connectionstatechange",
			expect.any(Function),
		);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("preserves a setup error after the remote waiter has already timed out", async () => {
		let rejectMessage!: (error: Error) => void;
		vi.mocked(sendServiceWorkerMessage).mockReturnValueOnce(
			new Promise((_, reject) => {
				rejectMessage = reject;
			}),
		);
		const starting = connectCameraPreview(settings, "session").catch(
			(error: unknown) => error,
		);
		await flush();
		await vi.advanceTimersByTimeAsync(10_000);
		const failure = new Error("Service worker disconnected");
		rejectMessage(failure);
		expect(await starting).toBe(failure);
		expect(Peer.latest.close).toHaveBeenCalledTimes(1);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("keeps a successful peer and stream owned by the caller", async () => {
		const stop = vi.fn();
		const stream = { getTracks: () => [{ stop }] } as unknown as MediaStream;
		const starting = connectCameraPreview(settings, "session");
		await flush();
		Peer.latest.track(stream);
		await expect(starting).resolves.toEqual({ peer: Peer.latest, stream });
		expect(Peer.latest.close).not.toHaveBeenCalled();
		expect(stop).not.toHaveBeenCalled();
		expect(vi.getTimerCount()).toBe(0);
	});
});
