import { afterEach, describe, expect, it, vi } from "vitest";
import { VoiceRecorder } from "../src/voice";

describe("voice recorder", () => {
	const saved = {
		recorder: (globalThis as { MediaRecorder?: unknown }).MediaRecorder,
		devices: navigator.mediaDevices,
	};
	afterEach(() => {
		(globalThis as { MediaRecorder?: unknown }).MediaRecorder = saved.recorder;
		Object.defineProperty(navigator, "mediaDevices", {
			value: saved.devices,
			configurable: true,
		});
	});

	it("releases the microphone when cancelled during the permission prompt", async () => {
		const stop = vi.fn();
		let grant: (stream: MediaStream) => void = () => {};
		(globalThis as { MediaRecorder?: unknown }).MediaRecorder = Object.assign(
			vi.fn(),
			{ isTypeSupported: () => true },
		);
		Object.defineProperty(navigator, "mediaDevices", {
			value: {
				getUserMedia: () =>
					new Promise<MediaStream>((resolve) => {
						grant = resolve;
					}),
			},
			configurable: true,
		});
		const recorder = new VoiceRecorder();
		const starting = recorder.start();
		recorder.cancel();
		grant({ getTracks: () => [{ stop }] } as unknown as MediaStream);
		await expect(starting).rejects.toThrow();
		expect(stop).toHaveBeenCalledOnce();
		expect(globalThis.MediaRecorder).not.toHaveBeenCalled();
	});
});
