import { afterEach, describe, expect, it, vi } from "vitest";
import {
	acquireDisplayStream,
	cameraVideoConstraints,
	createAudioMixer,
	getCaptureErrorMessage,
	micAudioConstraints,
} from "../src/capture-streams";

const domError = (name: string) => new DOMException(name, name);

const stubDisplayMedia = (
	impl: (options: DisplayMediaStreamOptions) => Promise<unknown>,
) => {
	const getDisplayMedia = vi.fn(impl);
	vi.stubGlobal("navigator", { mediaDevices: { getDisplayMedia } });
	return getDisplayMedia;
};

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("constraint builders", () => {
	it("uses exact deviceId when a device is chosen", () => {
		expect(cameraVideoConstraints("cam-1").deviceId).toEqual({
			exact: "cam-1",
		});
		expect(micAudioConstraints("mic-1").deviceId).toEqual({ exact: "mic-1" });
	});

	it("omits deviceId for the system default", () => {
		expect(cameraVideoConstraints(null).deviceId).toBeUndefined();
		expect(micAudioConstraints(undefined).deviceId).toBeUndefined();
		expect(micAudioConstraints(null).echoCancellation).toBe(true);
	});
});

describe("acquireDisplayStream", () => {
	it("passes surface preferences and system audio on the first attempt", async () => {
		const stream = { id: "display" };
		const getDisplayMedia = stubDisplayMedia(async () => stream);

		await expect(
			acquireDisplayStream({ mode: "fullscreen", systemAudioEnabled: true }),
		).resolves.toBe(stream);

		expect(getDisplayMedia).toHaveBeenCalledTimes(1);
		const options = getDisplayMedia.mock.calls[0]?.[0] as Record<
			string,
			unknown
		>;
		expect(options.monitorTypeSurfaces).toBe("include");
		expect(options.systemAudio).toBe("include");
		expect(options.preferCurrentTab).toBe(false);
		expect((options.video as Record<string, unknown>).displaySurface).toBe(
			"monitor",
		);
		expect(options.audio).toEqual({
			echoCancellation: false,
			autoGainControl: false,
			noiseSuppression: false,
		});
	});

	it("shows the generic picker when no mode is given", async () => {
		const getDisplayMedia = stubDisplayMedia(async () => ({ id: "display" }));

		await acquireDisplayStream({ systemAudioEnabled: true });

		expect(getDisplayMedia).toHaveBeenCalledTimes(1);
		const options = getDisplayMedia.mock.calls[0]?.[0] as Record<
			string,
			unknown
		>;
		expect(options.monitorTypeSurfaces).toBeUndefined();
		expect(
			(options.video as Record<string, unknown>).displaySurface,
		).toBeUndefined();
		expect(options.systemAudio).toBe("include");
	});

	it("requests no audio at all when system audio is off", async () => {
		const getDisplayMedia = stubDisplayMedia(async () => ({ id: "display" }));

		await acquireDisplayStream({ mode: "window", systemAudioEnabled: false });

		const options = getDisplayMedia.mock.calls[0]?.[0] as Record<
			string,
			unknown
		>;
		expect(options.audio).toBe(false);
		expect("systemAudio" in options).toBe(false);
	});

	it("retries without preferences, then without audio, firing the fallback once", async () => {
		const stream = { id: "display" };
		const onSystemAudioFallback = vi.fn();
		const getDisplayMedia = stubDisplayMedia(async () => {
			if (getDisplayMedia.mock.calls.length <= 2) {
				throw domError("NotSupportedError");
			}
			return stream;
		});

		await expect(
			acquireDisplayStream({
				mode: "tab",
				systemAudioEnabled: true,
				onSystemAudioFallback,
			}),
		).resolves.toBe(stream);

		expect(getDisplayMedia).toHaveBeenCalledTimes(3);
		expect(onSystemAudioFallback).toHaveBeenCalledTimes(1);
		const finalOptions = getDisplayMedia.mock.calls[2]?.[0] as Record<
			string,
			unknown
		>;
		expect(finalOptions.audio).toBe(false);
	});

	it("rethrows the original error when the no-audio preferred retry also fails", async () => {
		const original = domError("NotReadableError");
		const onSystemAudioFallback = vi.fn();
		const getDisplayMedia = stubDisplayMedia(async () => {
			if (getDisplayMedia.mock.calls.length === 1) throw original;
			throw domError("NotReadableError");
		});

		await expect(
			acquireDisplayStream({
				mode: "fullscreen",
				systemAudioEnabled: true,
				onSystemAudioFallback,
			}),
		).rejects.toBe(original);

		expect(getDisplayMedia).toHaveBeenCalledTimes(2);
		expect(onSystemAudioFallback).toHaveBeenCalledTimes(1);
	});

	it("rethrows user cancellation immediately with no retries", async () => {
		const getDisplayMedia = stubDisplayMedia(async () => {
			throw domError("NotAllowedError");
		});

		await expect(
			acquireDisplayStream({ mode: "fullscreen", systemAudioEnabled: true }),
		).rejects.toMatchObject({ name: "NotAllowedError" });

		expect(getDisplayMedia).toHaveBeenCalledTimes(1);
	});
});

describe("createAudioMixer", () => {
	class FakeNode {
		connections: unknown[] = [];
		connect(target: unknown) {
			this.connections.push(target);
		}
		disconnect() {
			this.connections = [];
		}
	}

	class FakeCompressor extends FakeNode {
		threshold = { value: 0 };
		knee = { value: 0 };
		ratio = { value: 0 };
		attack = { value: 0 };
		release = { value: 0 };
	}

	const makeContext = () => {
		const destination = Object.assign(new FakeNode(), {
			stream: { id: "mixed", getAudioTracks: () => [{ id: "mixed-track" }] },
		});
		const sources: FakeNode[] = [];
		const context = {
			state: "running",
			resume: vi.fn(async () => {}),
			close: vi.fn(async () => {}),
			createMediaStreamDestination: () => destination,
			createDynamicsCompressor: () => new FakeCompressor(),
			createMediaStreamSource: vi.fn(() => {
				const node = new FakeNode();
				sources.push(node);
				return node;
			}),
		};
		return { context, destination, sources };
	};

	const micStream = (id: string) =>
		({ getAudioTracks: () => [{ id }] }) as unknown as MediaStream;

	it("connects the mic and swaps it live without changing the output stream", async () => {
		const { context, sources } = makeContext();
		vi.stubGlobal(
			"AudioContext",
			vi.fn(() => context),
		);

		const mixer = await createAudioMixer({ micStream: micStream("mic-a") });
		const outputBefore = mixer.stream;
		expect(context.createMediaStreamSource).toHaveBeenCalledTimes(1);
		expect(sources[0]?.connections).toHaveLength(1);

		mixer.setMicStream(micStream("mic-b"));
		expect(sources[0]?.connections).toHaveLength(0);
		expect(context.createMediaStreamSource).toHaveBeenCalledTimes(2);
		expect(sources[1]?.connections).toHaveLength(1);
		expect(mixer.stream).toBe(outputBefore);

		mixer.setMicStream(null);
		expect(sources[1]?.connections).toHaveLength(0);

		await mixer.close();
		expect(context.close).toHaveBeenCalledTimes(1);
	});

	it("mixes system audio tracks alongside the mic", async () => {
		const { context } = makeContext();
		vi.stubGlobal(
			"AudioContext",
			vi.fn(() => context),
		);
		vi.stubGlobal(
			"MediaStream",
			vi.fn((tracks: unknown[]) => ({ tracks })),
		);

		await createAudioMixer({
			systemAudioTracks: [{ id: "sys" } as unknown as MediaStreamTrack],
			micStream: micStream("mic-a"),
		});

		expect(context.createMediaStreamSource).toHaveBeenCalledTimes(2);
	});

	it("resumes a suspended context before wiring the graph", async () => {
		const { context } = makeContext();
		context.state = "suspended";
		vi.stubGlobal(
			"AudioContext",
			vi.fn(() => context),
		);

		await createAudioMixer({ micStream: micStream("mic-a") });
		expect(context.resume).toHaveBeenCalledTimes(1);
	});
});

describe("getCaptureErrorMessage", () => {
	it("distinguishes camera and display permission errors", () => {
		expect(
			getCaptureErrorMessage(domError("NotAllowedError"), "camera"),
		).toContain("Camera access");
		expect(
			getCaptureErrorMessage(domError("NotAllowedError"), "display"),
		).toContain("Screen sharing");
	});

	it("maps busy devices to the NotReadable guidance", () => {
		expect(
			getCaptureErrorMessage(domError("NotReadableError"), "camera"),
		).toContain("couldn't start the selected camera");
	});

	it("falls back to the generic message for unknown errors", () => {
		expect(getCaptureErrorMessage(new Error("boom"), "display")).toContain(
			"Could not start recording",
		);
	});
});
