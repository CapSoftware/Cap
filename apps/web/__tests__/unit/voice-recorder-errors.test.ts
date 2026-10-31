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
	static last: Recorder;
	static stopError = false;
	static startError: Error | null = null;
	static pendingStops: Array<() => void> | null = null;
	constructor() {
		Recorder.last = this;
	}
	state: RecordingState = "inactive";
	mimeType = "audio/webm";
	ondataavailable: ((event: BlobEvent) => void) | null = null;
	onstop: ((event: Event) => void) | null = null;
	onerror: ((event: Event) => void) | null = null;
	start() {
		if (Recorder.startError) throw Recorder.startError;
		this.state = "recording";
	}
	stop() {
		this.state = "inactive";
		const finish = () => {
			if (Recorder.stopError) {
				const error = new Event("error");
				Object.defineProperty(error, "target", { value: this });
				Object.defineProperty(error, "error", {
					value: new Error("Encoder failed"),
				});
				this.onerror?.(error);
			}
			const event = new Event("dataavailable");
			Object.defineProperty(event, "target", { value: this });
			Object.defineProperty(event, "data", {
				value: new Blob(["audio"], { type: "audio/webm" }),
			});
			this.ondataavailable?.(event as BlobEvent);
			const stopped = new Event("stop");
			Object.defineProperty(stopped, "target", { value: this });
			this.onstop?.(stopped);
		};
		if (Recorder.pendingStops) Recorder.pendingStops.push(finish);
		else queueMicrotask(finish);
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
	Recorder.startError = null;
	Recorder.stopError = false;
	Recorder.pendingStops = null;
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

function browserStops(error: boolean) {
	const target = Recorder.last;
	if (error) {
		const event = new Event("error");
		Object.defineProperty(event, "target", { value: target });
		Object.defineProperty(event, "error", {
			value: new Error("Encoder failed"),
		});
		target.onerror?.(event);
	}
	target.state = "inactive";
	const stopped = new Event("stop");
	Object.defineProperty(stopped, "target", { value: target });
	target.onstop?.(stopped);
}

it.each([true, false])(
	"releases voice capture after an unexpected browser stop (error: %s)",
	async (error) => {
		const mic = new Stream();
		const activeMixer = mixer();
		mocks.mic.mockResolvedValueOnce(mic);
		mocks.mixer.mockResolvedValueOnce(activeMixer);
		await act(async () => recorder.start());
		expect(recorder.phase).toBe("recording");
		await act(async () => browserStops(error));
		expect(mic.track.stop).toHaveBeenCalled();
		expect(activeMixer.close).toHaveBeenCalled();
		expect(recorder.phase).toBe("error");
		expect(onFinish).not.toHaveBeenCalled();
	},
);

it("reports a voice encoder error received while stopping", async () => {
	const mic = new Stream();
	mocks.mic.mockResolvedValueOnce(mic);
	await act(async () => recorder.start());
	Recorder.stopError = true;
	await act(async () => recorder.stop());
	expect(mic.track.stop).toHaveBeenCalled();
	expect(recorder.phase).toBe("error");
	expect(onFinish).not.toHaveBeenCalled();
});
