// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useVoiceRecorder } from "@/app/s/[videoId]/_components/timeline/recording/useVoiceRecorder";

const mocks = vi.hoisted(() => ({
	mic: vi.fn(),
	mixer: vi.fn(),
	decode: vi.fn(),
}));
vi.mock("@cap/recorder-core/capture-streams", () => ({
	acquireMicStream: mocks.mic,
	createAudioMixer: mocks.mixer,
}));
vi.mock(
	"@/app/s/[videoId]/_components/timeline/recording/compute-waveform-peaks",
	async (importOriginal) => ({
		...(await importOriginal<
			typeof import("@/app/s/[videoId]/_components/timeline/recording/compute-waveform-peaks")
		>()),
		decodeToPeaks: mocks.decode,
	}),
);
function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}
class Track {
	readyState = "live";
	stop = vi.fn(() => {
		this.readyState = "ended";
	});
	getSettings() {
		return { deviceId: "microphone" };
	}
}
class Stream {
	constructor(readonly track = new Track()) {}
	getTracks() {
		return [this.track];
	}
	getAudioTracks() {
		return [this.track];
	}
}
class Recorder {
	static isTypeSupported = () => true;
	state: RecordingState = "inactive";
	mimeType = "audio/webm";
	ondataavailable: ((event: BlobEvent) => void) | null = null;
	onstop: ((event: Event) => void) | null = null;
	onerror: ((event: Event) => void) | null = null;
	start() {
		this.state = "recording";
	}
	stop() {
		this.state = "inactive";
		queueMicrotask(() => {
			const event = new Event("dataavailable");
			Object.defineProperty(event, "data", {
				value: new Blob(["audio"], { type: "audio/webm" }),
			});
			this.ondataavailable?.(event as BlobEvent);
			this.onstop?.(new Event("stop"));
		});
	}
}
let root: Root;
let container: HTMLDivElement;
let mounted: boolean;
let recorder: ReturnType<typeof useVoiceRecorder>;
const onFinish = vi.fn();
function mixer(stream = new Stream()) {
	return {
		context: {},
		stream,
		close: vi.fn(async () => {}),
		setMicStream: vi.fn(),
	};
}
beforeEach(async () => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	vi.stubGlobal("MediaRecorder", Recorder);
	onFinish.mockReset();
	mocks.mic.mockReset().mockImplementation(async () => new Stream());
	mocks.mixer.mockReset().mockImplementation(async () => mixer());
	mocks.decode.mockReset().mockResolvedValue([0.25, 1]);
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
	mounted = true;
	function Harness() {
		recorder = useVoiceRecorder({ onFinish, selectedMicId: null });
		return null;
	}
	await act(async () => root.render(createElement(Harness)));
});
afterEach(async () => {
	if (mounted) await unmount();
	container.remove();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});
async function unmount() {
	await act(async () => root.unmount());
	mounted = false;
}
async function beginDecoding() {
	const decode = deferred<number[] | undefined>();
	mocks.decode.mockReturnValueOnce(decode.promise);
	await act(async () => recorder.start());
	let stopping!: Promise<void>;
	await act(async () => {
		stopping = recorder.stop();
	});
	expect(mocks.decode).toHaveBeenCalledTimes(1);
	return { decode, stopping };
}

it.each(["cancel", "unmount"])(
	"does not finish a voice note after %s during waveform decoding",
	async (action) => {
		const { decode, stopping } = await beginDecoding();
		if (action === "cancel") await act(async () => recorder.cancel());
		else await unmount();
		await act(async () => {
			decode.resolve([1]);
			await stopping;
		});
		expect(onFinish).not.toHaveBeenCalled();
	},
);

it("does not finish an old take or reset the replacement while decoding completes", async () => {
	const { decode, stopping } = await beginDecoding();
	await act(async () => recorder.cancel());
	await act(async () => recorder.start());
	expect(recorder.phase).toBe("recording");
	await act(async () => {
		decode.resolve([1]);
		await stopping;
	});
	expect(onFinish).not.toHaveBeenCalled();
	expect(recorder.phase).toBe("recording");
});

it("does not close the replacement microphone when an abandoned mixer finishes", async () => {
	const pendingMixer = deferred<ReturnType<typeof mixer>>();
	const abandoned = mixer();
	const replacement = mixer();
	const firstMic = new Stream();
	const nextMic = new Stream();
	mocks.mic.mockResolvedValueOnce(firstMic).mockResolvedValueOnce(nextMic);
	mocks.mixer
		.mockReturnValueOnce(pendingMixer.promise)
		.mockResolvedValueOnce(replacement);
	let starting!: Promise<void>;
	await act(async () => {
		starting = recorder.start();
	});
	await act(async () => recorder.cancel());
	await act(async () => recorder.start());
	await act(async () => {
		pendingMixer.resolve(abandoned);
		await starting;
	});
	expect(abandoned.close).toHaveBeenCalled();
	expect(firstMic.track.stop).toHaveBeenCalled();
	expect(nextMic.track.stop).not.toHaveBeenCalled();
	expect(replacement.close).not.toHaveBeenCalled();
	expect(recorder.phase).toBe("recording");
});

it("still finishes a current recording with the decoded waveform", async () => {
	await act(async () => recorder.start());
	await act(async () => recorder.stop());
	expect(onFinish).toHaveBeenCalledTimes(1);
	expect(onFinish).toHaveBeenCalledWith(
		expect.objectContaining({
			mime: "audio/webm",
			waveform: [0.25, 1],
			blob: expect.objectContaining({ size: 5 }),
		}),
	);
	expect(recorder.phase).toBe("idle");
});

it("releases a microphone granted after startup was cancelled", async () => {
	const pendingMic = deferred<Stream>();
	const stream = new Stream();
	mocks.mic.mockReturnValueOnce(pendingMic.promise);
	let starting!: Promise<void>;
	await act(async () => {
		starting = recorder.start();
	});
	await act(async () => recorder.cancel());
	await act(async () => {
		pendingMic.resolve(stream);
		await starting;
	});
	expect(stream.track.stop).toHaveBeenCalled();
	expect(mocks.mixer).not.toHaveBeenCalled();
	expect(onFinish).not.toHaveBeenCalled();
	expect(recorder.phase).toBe("idle");
});
