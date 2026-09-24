import { afterEach, expect, test, vi } from "vitest";
import { startEditorClipCapture } from "../../lib/editor-clip-recorder";

const capture = vi.hoisted(() => ({
	display: vi.fn(),
	camera: vi.fn(),
	mic: vi.fn(),
	mix: vi.fn(),
	spoolCreate: vi.fn(),
}));

vi.mock("@cap/recorder-core/capture-streams", () => ({
	acquireDisplayStream: capture.display,
	acquireCameraStream: capture.camera,
	acquireMicStream: capture.mic,
	createAudioMixer: capture.mix,
}));
vi.mock("@cap/recorder-core/recorder-utils", () => ({
	selectRecordingPipelineFromSupport: (hasAudio: boolean) => ({
		mimeType: hasAudio ? "video/webm;codecs=vp8,opus" : "video/webm;codecs=vp8",
	}),
}));
vi.mock("@cap/recorder-core/recording-spool", () => ({
	RecordingSpool: { create: capture.spoolCreate },
}));

class FakeTrack extends EventTarget {
	readonly stop = vi.fn();
	readyState: MediaStreamTrackState = "live";
	constructor(readonly kind: "video" | "audio") {
		super();
	}
}

class FakeStream {
	constructor(readonly tracks: FakeTrack[]) {}
	getTracks() {
		return this.tracks;
	}
	getVideoTracks() {
		return this.tracks.filter((track) => track.kind === "video");
	}
	getAudioTracks() {
		return this.tracks.filter((track) => track.kind === "audio");
	}
}

class FakeRecorder extends EventTarget {
	static instances: FakeRecorder[] = [];
	static failCameraStart = false;
	static isTypeSupported = vi.fn(() => true);
	state: RecordingState = "inactive";
	readonly stopCalled = vi.fn();
	constructor(
		readonly stream: FakeStream,
		readonly options: { mimeType: string },
	) {
		super();
		FakeRecorder.instances.push(this);
	}
	start() {
		if (
			FakeRecorder.failCameraStart &&
			this.stream.getVideoTracks()[0]?.kind === "video" &&
			this.stream.tracks.length === 1 &&
			FakeRecorder.instances.length === 2
		) {
			throw new Error("Camera encoder failed");
		}
		this.state = "recording";
		this.dispatchEvent(new Event("start"));
	}
	stop() {
		this.stopCalled();
		if (this.state === "inactive") throw new Error("Already stopped");
		this.state = "inactive";
		const content =
			FakeRecorder.instances.indexOf(this) === 0 ? "screen" : "camera";
		const dataEvent = new Event("dataavailable") as Event & { data: Blob };
		dataEvent.data = new Blob([content], { type: this.options.mimeType });
		this.dispatchEvent(dataEvent);
		this.dispatchEvent(new Event("stop"));
	}
	pause() {
		this.state = "paused";
	}
	resume() {
		this.state = "recording";
	}
}

function setup() {
	FakeRecorder.instances = [];
	FakeRecorder.failCameraStart = false;
	vi.stubGlobal("MediaStream", FakeStream);
	vi.stubGlobal("MediaRecorder", FakeRecorder);
	vi.stubGlobal("navigator", {
		mediaDevices: { getDisplayMedia: vi.fn(), getUserMedia: vi.fn() },
	});
	const screenTrack = new FakeTrack("video");
	const cameraTrack = new FakeTrack("video");
	const micTrack = new FakeTrack("audio");
	const audioOutputTrack = new FakeTrack("audio");
	const screen = new FakeStream([screenTrack]);
	const camera = new FakeStream([cameraTrack]);
	const mic = new FakeStream([micTrack]);
	capture.display.mockResolvedValue(screen);
	capture.camera.mockResolvedValue(camera);
	capture.mic.mockResolvedValue(mic);
	const close = vi.fn(async () => undefined);
	capture.mix.mockResolvedValue({
		stream: new FakeStream([audioOutputTrack]),
		close,
	});
	const spools: Array<{
		chunks: Blob[];
		dispose: ReturnType<typeof vi.fn>;
	}> = [];
	capture.spoolCreate.mockImplementation(
		async (options: { mimeType: string }) => {
			const chunks: Blob[] = [];
			const dispose = vi.fn(async () => undefined);
			const spool = {
				chunks,
				dispose,
				appendChunk: vi.fn(async (chunk: Blob) => {
					chunks.push(chunk);
				}),
				flush: vi.fn(async () => undefined),
				toBlob: vi.fn(async () => new Blob(chunks, { type: options.mimeType })),
				recoverBlob: vi.fn(
					async () => new Blob(chunks, { type: options.mimeType }),
				),
			};
			spools.push(spool);
			return spool;
		},
	);
	return { screenTrack, cameraTrack, micTrack, close, spools };
}

afterEach(() => {
	vi.unstubAllGlobals();
	vi.clearAllMocks();
});

test("screen and webcam become distinct saved clips with screen-only audio", async () => {
	const { screenTrack, cameraTrack, micTrack, close, spools } = setup();
	const session = await startEditorClipCapture({
		cameraEnabled: true,
		micEnabled: true,
		systemAudioEnabled: false,
	});
	expect(FakeRecorder.instances).toHaveLength(2);
	expect(FakeRecorder.instances[0]?.stream.getVideoTracks()).toEqual([
		screenTrack,
	]);
	expect(FakeRecorder.instances[0]?.stream.getAudioTracks()).toHaveLength(1);
	expect(FakeRecorder.instances[1]?.stream.getVideoTracks()).toEqual([
		cameraTrack,
	]);
	expect(FakeRecorder.instances[1]?.stream.getAudioTracks()).toHaveLength(0);
	session.pause();
	expect(FakeRecorder.instances.map((recorder) => recorder.state)).toEqual([
		"paused",
		"paused",
	]);
	session.resume();
	const captured = await session.stop();
	expect(await captured.display.text()).toBe("screen");
	expect(await captured.camera?.text()).toBe("camera");
	expect(captured.display.name).toMatch(/-screen\.webm$/);
	expect(captured.camera?.name).toMatch(/-camera\.webm$/);
	expect(captured.cameraOffsetMs).toBeGreaterThanOrEqual(0);
	expect(screenTrack.stop).toHaveBeenCalled();
	expect(cameraTrack.stop).toHaveBeenCalled();
	expect(micTrack.stop).toHaveBeenCalled();
	expect(close).toHaveBeenCalled();
	expect(spools.every((spool) => spool.dispose.mock.calls.length === 0)).toBe(
		true,
	);
	await session.release();
	expect(spools.every((spool) => spool.dispose.mock.calls.length === 1)).toBe(
		true,
	);
});

test("camera encoder startup failure stops the active screen capture", async () => {
	const { screenTrack, cameraTrack, micTrack, close, spools } = setup();
	FakeRecorder.failCameraStart = true;
	await expect(
		startEditorClipCapture({
			cameraEnabled: true,
			micEnabled: true,
			systemAudioEnabled: false,
		}),
	).rejects.toThrow("Camera encoder failed");
	expect(FakeRecorder.instances[0]?.stopCalled).toHaveBeenCalledOnce();
	expect(screenTrack.stop).toHaveBeenCalled();
	expect(cameraTrack.stop).toHaveBeenCalled();
	expect(micTrack.stop).toHaveBeenCalled();
	expect(close).toHaveBeenCalled();
	expect(spools.every((spool) => spool.dispose.mock.calls.length === 1)).toBe(
		true,
	);
});

test("screen capture ending during camera permission never starts an encoder", async () => {
	const { screenTrack, cameraTrack } = setup();
	capture.camera.mockImplementation(async () => {
		screenTrack.readyState = "ended";
		return new FakeStream([cameraTrack]);
	});
	await expect(
		startEditorClipCapture({
			cameraEnabled: true,
			micEnabled: false,
			systemAudioEnabled: false,
		}),
	).rejects.toThrow("Screen sharing ended before recording started");
	expect(FakeRecorder.instances).toHaveLength(0);
	expect(screenTrack.stop).toHaveBeenCalled();
	expect(cameraTrack.stop).toHaveBeenCalled();
});

test("closing the editor during camera permission stops tracks before encoders start", async () => {
	const { screenTrack, cameraTrack } = setup();
	const controller = new AbortController();
	capture.camera.mockImplementation(async () => {
		controller.abort();
		return new FakeStream([cameraTrack]);
	});
	await expect(
		startEditorClipCapture({
			cameraEnabled: true,
			micEnabled: false,
			systemAudioEnabled: false,
			signal: controller.signal,
		}),
	).rejects.toThrow("Editor clip capture was canceled");
	expect(FakeRecorder.instances).toHaveLength(0);
	expect(screenTrack.stop).toHaveBeenCalled();
	expect(cameraTrack.stop).toHaveBeenCalled();
	expect(capture.spoolCreate).not.toHaveBeenCalled();
});

test("a browser encoder error stops both tracks and keeps a downloadable backup", async () => {
	const { screenTrack, cameraTrack, spools } = setup();
	const onError = vi.fn();
	const session = await startEditorClipCapture({
		cameraEnabled: true,
		micEnabled: false,
		systemAudioEnabled: false,
		onError,
	});
	const event = new Event("error") as Event & { error: Error };
	event.error = new Error("Screen encoder failed");
	FakeRecorder.instances[0]?.dispatchEvent(event);
	await expect(session.stop()).rejects.toThrow("Screen encoder failed");
	expect(onError).toHaveBeenCalledWith(event.error);
	expect(screenTrack.stop).toHaveBeenCalled();
	expect(cameraTrack.stop).toHaveBeenCalled();
	const backup = await session.recover();
	expect(await backup?.display.text()).toBe("screen");
	expect(await backup?.camera?.text()).toBe("camera");
	expect(spools.every((spool) => spool.dispose.mock.calls.length === 0)).toBe(
		true,
	);
	await session.release();
});
