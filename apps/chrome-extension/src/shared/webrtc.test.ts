import { afterEach, describe, expect, it, vi } from "vitest";
import { waitForIceGatheringComplete } from "./webrtc";

const createPeer = (iceGatheringState: RTCIceGatheringState) => {
	const peer = new EventTarget();
	Object.defineProperty(peer, "iceGatheringState", {
		configurable: true,
		value: iceGatheringState,
		writable: true,
	});
	return peer as RTCPeerConnection;
};

afterEach(() => {
	vi.useRealTimers();
});

describe("waitForIceGatheringComplete", () => {
	it("resolves immediately after ICE gathering has completed", async () => {
		const peer = createPeer("complete");
		const addEventListener = vi.spyOn(peer, "addEventListener");

		await expect(waitForIceGatheringComplete(peer)).resolves.toBeUndefined();
		expect(addEventListener).not.toHaveBeenCalled();
	});

	it("resolves when ICE gathering reports completion", async () => {
		vi.useFakeTimers();
		const peer = createPeer("gathering");
		const pending = waitForIceGatheringComplete(peer);
		Object.defineProperty(peer, "iceGatheringState", { value: "complete" });
		peer.dispatchEvent(new Event("icegatheringstatechange"));

		await expect(pending).resolves.toBeUndefined();
		expect(vi.getTimerCount()).toBe(0);
	});

	it("continues with gathered candidates when ICE never completes", async () => {
		vi.useFakeTimers();
		const peer = createPeer("gathering");
		const removeEventListener = vi.spyOn(peer, "removeEventListener");
		const pending = waitForIceGatheringComplete(peer, 50);

		await vi.advanceTimersByTimeAsync(50);

		await expect(pending).resolves.toBeUndefined();
		expect(removeEventListener).toHaveBeenCalledWith(
			"icegatheringstatechange",
			expect.any(Function),
		);
	});
});
