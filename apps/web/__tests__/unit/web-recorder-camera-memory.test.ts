// @vitest-environment jsdom

import { Exit } from "effect";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	displayStream: vi.fn(),
	cameraStream: vi.fn(),
	createVideo: vi.fn(),
	deleteVideo: vi.fn(),
	initiateMultipart: vi.fn(),
	refresh: vi.fn(),
	refetchQueries: vi.fn(),
	warning: vi.fn(),
	uploaders: [] as Array<{
		subpath: string;
		handleChunk: ReturnType<typeof vi.fn>;
		finalize: ReturnType<typeof vi.fn>;
		cancel: ReturnType<typeof vi.fn>;
	}>,
	failedScreenUpload: false,
}));

vi.mock("@cap/recorder-core/capture-streams", () => ({
	acquireDisplayStream: mocks.displayStream,
	acquireCameraStream: mocks.cameraStream,
	acquireMicStream: vi.fn(),
	createAudioMixer: vi.fn(),
	getCaptureErrorMessage: (error: unknown) => String(error),
}));
vi.mock("@cap/recorder-core/recorder-utils", () => ({
	detectCapabilities: () => ({
		assessed: true,
		hasMediaRecorder: true,
		hasUserMedia: true,
		hasDisplayMedia: true,
	}),
	selectRecordingPipeline: () => ({
		mode: "streaming-webm",
		mimeType: "video/webm;codecs=vp8",
		fileExtension: "webm",
	}),
	openShareUrlInNewTab: () => false,
}));
vi.mock("@cap/recorder-core/recording-spool", () => ({
	canUseRecordingSpool: () => false,
	deleteRecoveredRecordingSpool: vi.fn(),
	RECORDING_SPOOL_HEARTBEAT_INTERVAL_MS: 10000,
	RecordingSpool: { create: vi.fn() },
}));
vi.mock("@cap/recorder-core/instant-mp4-uploader", () => ({
	initiateMultipartUpload: mocks.initiateMultipart,
	MultipartCompletionUncertainError: class extends Error {},
	InstantRecordingUploader: class {
		handleChunk = vi.fn();
		finalize: ReturnType<typeof vi.fn>;
		cancel = vi.fn(async () => undefined);
		constructor(options: { subpath: string }) {
			this.finalize = vi.fn(async () => {
				if (mocks.failedScreenUpload && options.subpath === "raw-upload.webm") {
					throw new Error("Screen upload failed");
				}
			});
			mocks.uploaders.push({
				subpath: options.subpath,
				handleChunk: this.handleChunk,
				finalize: this.finalize,
				cancel: this.cancel,
			});
		}
		getProcessingStarted() {
			return true;
		}
	},
}));
vi.mock("@/lib/EffectRuntime", () => ({
	useRpcClient: () => ({
		VideoInstantCreate: mocks.createVideo,
		VideoDelete: mocks.deleteVideo,
	}),
	useEffectMutation: ({
		mutationFn,
	}: {
		mutationFn: (variables: unknown) => Promise<unknown>;
	}) => ({ mutateAsync: mutationFn }),
}));
vi.mock("@tanstack/react-query", () => ({
	useQueryClient: () => ({ refetchQueries: mocks.refetchQueries }),
}));
vi.mock("next/navigation", () => ({
	useRouter: () => ({ refresh: mocks.refresh }),
}));
vi.mock("@/actions/video/trigger-instant-recording-processing", () => ({
	triggerInstantRecordingProcessing: vi.fn(),
}));
vi.mock("@/actions/video/upload", () => ({
	createVideoAndGetUploadUrl: vi.fn(),
}));
vi.mock("@/app/(org)/dashboard/caps/UploadingContext", () => ({
	useUploadingContext: () => ({ setUploadStatus: vi.fn() }),
}));
vi.mock("sonner", () => ({
	toast: {
		dismiss: vi.fn(),
		error: vi.fn(),
		info: vi.fn(),
		success: vi.fn(),
		warning: mocks.warning,
	},
}));
vi.mock(
	"@/app/(org)/dashboard/caps/components/web-recorder-dialog/useSurfaceDetection",
	() => ({
		useSurfaceDetection: () => ({ scheduleSurfaceDetection: vi.fn() }),
	}),
);
vi.mock(
	"@/app/(org)/dashboard/caps/components/web-recorder-dialog/recovered-recording-cache",
	() => ({
		loadRecoveredRecordingSpools: vi.fn(async () => []),
		removeRecoveredRecordingSpoolFromCache: vi.fn(),
	}),
);

import { useMediaRecorderSetup } from "@/app/(org)/dashboard/caps/components/web-recorder-dialog/useMediaRecorderSetup";
import { useWebRecorder } from "@/app/(org)/dashboard/caps/components/web-recorder-dialog/useWebRecorder";

class FakeTrack extends EventTarget {
	readonly kind = "video";
	readonly readyState = "live";
	readonly stop = vi.fn();
	getSettings() {
		return { width: 1280, height: 720, frameRate: 30 };
	}
}

class FakeStream {
	constructor(readonly tracks: FakeTrack[]) {}
	getTracks() {
		return this.tracks;
	}
	getVideoTracks() {
		return this.tracks;
	}
	getAudioTracks() {
		return [];
	}
}

class FakeRecorder extends EventTarget {
	static instances: FakeRecorder[] = [];
	state: RecordingState = "inactive";
	readonly stopCalled = vi.fn();
	ondataavailable: ((event: BlobEvent) => void) | null = null;
	onstop: (() => void) | null = null;
	onerror: ((event: Event) => void) | null = null;
	constructor(
		readonly stream: FakeStream,
		readonly options: { mimeType: string },
	) {
		super();
		FakeRecorder.instances.push(this);
	}
	start() {
		this.state = "recording";
	}
	stop() {
		if (this.state === "inactive") throw new Error("Already stopped");
		this.stopCalled();
		this.state = "inactive";
		this.emitData(new Blob(["final"], { type: this.options.mimeType }));
		this.dispatchEvent(new Event("stop"));
		this.onstop?.();
	}
	emitData(data: Blob) {
		const event = new Event("dataavailable") as BlobEvent;
		Object.defineProperty(event, "data", { value: data });
		this.dispatchEvent(event);
		this.ondataavailable?.(event);
	}
}

let root: Root;
let container: HTMLDivElement;
let latest: ReturnType<typeof useWebRecorder>;
let displayTrack: FakeTrack;
let cameraTrack: FakeTrack;

function Harness() {
	latest = useWebRecorder({
		organisationId: "organisation",
		selectedMicId: null,
		micEnabled: false,
		systemAudioEnabled: false,
		recordingMode: "fullscreen",
		selectedCameraId: "camera",
		getCameraPreviewStream: () => null,
		isProUser: true,
	});
	return null;
}

async function waitFor(assertion: () => void) {
	let lastError: unknown;
	for (let attempt = 0; attempt < 100; attempt++) {
		try {
			assertion();
			return;
		} catch (cause) {
			lastError = cause;
		}
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 10));
		});
	}
	throw lastError;
}

beforeEach(async () => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	vi.stubGlobal("MediaStream", FakeStream);
	vi.stubGlobal("MediaRecorder", FakeRecorder);
	vi.stubGlobal("URL", {
		createObjectURL: vi.fn(() => "blob:recording"),
		revokeObjectURL: vi.fn(),
	});
	FakeRecorder.instances = [];
	mocks.uploaders.length = 0;
	mocks.failedScreenUpload = false;
	mocks.warning.mockClear();
	displayTrack = new FakeTrack();
	cameraTrack = new FakeTrack();
	mocks.displayStream.mockResolvedValue(new FakeStream([displayTrack]));
	mocks.cameraStream.mockResolvedValue(new FakeStream([cameraTrack]));
	mocks.createVideo.mockResolvedValue(
		Exit.succeed({
			id: "video",
			shareUrl: "https://cap.example/s/video",
			upload: {},
		}),
	);
	mocks.deleteVideo.mockResolvedValue(Exit.succeed(undefined));
	mocks.initiateMultipart.mockResolvedValue({
		uploadId: "upload",
		provider: "s3",
	});
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
	await act(async () => root.render(createElement(Harness)));
	await act(async () => latest.startRecording());
	await waitFor(() => expect(latest.phase).toBe("recording"));
});

afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
	vi.unstubAllGlobals();
});

async function overflowCameraBackup() {
	const camera = FakeRecorder.instances[1];
	if (!camera) throw new Error("Camera recorder did not start");
	const chunk = new Blob([new Uint8Array(1024 * 1024)], {
		type: "video/webm;codecs=vp8",
	});
	await act(async () => {
		for (let second = 0; second < 257; second++) {
			camera.emitData(chunk);
		}
	});
	await waitFor(() => {
		expect(latest.phase).toMatch(/completed|error/);
	});
	return camera;
}

async function overflowScreenBackup() {
	const screen = FakeRecorder.instances[0];
	if (!screen) throw new Error("Screen recorder did not start");
	const chunk = new Blob([new Uint8Array(1024 * 1024)], {
		type: "video/webm;codecs=vp8",
	});
	await act(async () => {
		for (let second = 0; second < 257; second++) {
			screen.emitData(chunk);
		}
	});
	await waitFor(() => expect(latest.phase).toBe("completed"));
	return screen;
}

test("a long camera capture stops both clips at the memory limit and finalizes the paired upload", async () => {
	const camera = await overflowCameraBackup();
	const screen = FakeRecorder.instances[0];
	expect(screen?.stopCalled).toHaveBeenCalledOnce();
	expect(camera.stopCalled).toHaveBeenCalledOnce();
	expect(displayTrack.stop).toHaveBeenCalled();
	expect(cameraTrack.stop).toHaveBeenCalled();
	expect(latest.phase).toBe("completed");
	expect(mocks.warning).toHaveBeenCalledWith(
		"Camera memory backup reached its limit. Finishing both clips now.",
	);
	expect(mocks.uploaders.map((uploader) => uploader.subpath)).toEqual([
		"raw-upload.webm",
		"camera-upload.webm",
	]);
	expect(
		mocks.uploaders.every(
			(uploader) => uploader.finalize.mock.calls.length === 1,
		),
	).toBe(true);
	expect(
		mocks.uploaders.find(
			(uploader) => uploader.subpath === "camera-upload.webm",
		)?.handleChunk,
	).toHaveBeenCalledTimes(258);
	expect(latest.cameraErrorDownload).toBeNull();
});

test("a long screen capture stops both clips at its memory limit", async () => {
	const screen = await overflowScreenBackup();
	const camera = FakeRecorder.instances[1];
	expect(screen.stopCalled).toHaveBeenCalledOnce();
	expect(camera?.stopCalled).toHaveBeenCalledOnce();
	expect(displayTrack.stop).toHaveBeenCalled();
	expect(cameraTrack.stop).toHaveBeenCalled();
	expect(mocks.warning).toHaveBeenCalledWith(
		"Recording memory backup reached its limit. Finishing now.",
	);
	expect(
		mocks.uploaders.find((uploader) => uploader.subpath === "raw-upload.webm")
			?.handleChunk,
	).toHaveBeenCalledTimes(258);
	expect(
		mocks.uploaders.every(
			(uploader) => uploader.finalize.mock.calls.length === 1,
		),
	).toBe(true);
});

test("an upload failure before the memory limit keeps both complete recovery clips", async () => {
	mocks.failedScreenUpload = true;
	const camera = FakeRecorder.instances[1];
	if (!camera) throw new Error("Camera recorder did not start");
	const cameraChunk = new Blob(["camera body"], {
		type: "video/webm;codecs=vp8",
	});
	await act(async () => {
		camera.emitData(cameraChunk);
		await latest.stopRecording();
	});
	await waitFor(() => expect(latest.phase).toBe("error"));
	expect(latest.errorDownload).not.toBeNull();
	expect(latest.cameraErrorDownload).not.toBeNull();
	const recoveryBlobs = vi
		.mocked(URL.createObjectURL)
		.mock.calls.map(([blob]) => blob as Blob);
	expect(recoveryBlobs.map((blob) => blob.size)).toEqual([
		5,
		cameraChunk.size + 5,
	]);
});

test("an upload failure after overflow never offers a truncated camera download", async () => {
	mocks.failedScreenUpload = true;
	const camera = await overflowCameraBackup();
	expect(FakeRecorder.instances[0]?.stopCalled).toHaveBeenCalledOnce();
	expect(camera.stopCalled).toHaveBeenCalledOnce();
	expect(latest.phase).toBe("error");
	expect(latest.errorDownload).not.toBeNull();
	expect(latest.cameraErrorDownload).toBeNull();
	expect(
		mocks.uploaders.find((uploader) => uploader.subpath === "raw-upload.webm")
			?.cancel,
	).toHaveBeenCalledOnce();
});

test("screen fallback overflow remains visible after the recorder stops", async () => {
	const setupRef = {
		current: null as ReturnType<typeof useMediaRecorderSetup> | null,
	};
	function SetupHarness() {
		setupRef.current = useMediaRecorderSetup();
		return null;
	}
	const setupContainer = document.createElement("div");
	document.body.append(setupContainer);
	const setupRoot = createRoot(setupContainer);
	try {
		await act(async () => setupRoot.render(createElement(SetupHarness)));
		const setup = setupRef.current;
		if (!setup) throw new Error("Recorder setup did not mount");
		const strategy = { mode: "capped" as const, maxBytes: 5 };
		setup.setLocalRecordingStrategy(strategy);
		const data = new Event("dataavailable") as BlobEvent;
		Object.defineProperty(data, "data", { value: new Blob(["overflow"]) });
		expect(setup.onRecorderDataAvailable(data)).toBe(true);
		setup.onRecorderStop();
		expect(setup.localRecordingOverflowedRef.current).toBe(true);
		expect(
			setup.replaceLocalRecording(
				[],
				strategy,
				setup.localRecordingOverflowedRef.current,
			),
		).toBe(true);
	} finally {
		await act(async () => setupRoot.unmount());
		setupContainer.remove();
	}
});
