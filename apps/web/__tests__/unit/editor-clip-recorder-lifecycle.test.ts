// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type {
	EditorClipCapture,
	EditorClipCaptureOptions,
	EditorClipCaptureSession,
} from "@/lib/editor-clip-recorder";

const capture = vi.hoisted(() => ({ start: vi.fn() }));

vi.mock("@/lib/editor-clip-recorder", () => ({
	startEditorClipCapture: capture.start,
}));

import { EditorClipRecorder } from "@/app/s/[videoId]/edit/studio/EditorClipRecorder";

let root: Root | null;
let container: HTMLDivElement;

function session(): EditorClipCaptureSession {
	return {
		cameraPreviewStream: null,
		stop: vi.fn(async () => ({
			display: new File(["screen"], "screen.webm"),
			camera: null,
			cameraOffsetMs: 0,
		})),
		recover: vi.fn(async () => null),
		pause: vi.fn(),
		resume: vi.fn(),
		discard: vi.fn(async () => undefined),
		release: vi.fn(async () => undefined),
	};
}

beforeEach(() => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
});

afterEach(async () => {
	if (root) await act(async () => root?.unmount());
	container.remove();
	capture.start.mockReset();
	vi.unstubAllGlobals();
});

async function renderRecorder(onCaptured = vi.fn(async () => undefined)) {
	await act(async () => {
		root?.render(
			createElement(EditorClipRecorder, {
				onCaptured,
				onClose: vi.fn(),
			}),
		);
	});
	return onCaptured;
}

async function startRecorder() {
	const button = [...container.querySelectorAll("button")].find(
		(candidate) => candidate.textContent === "Start recording",
	);
	expect(button).toBeDefined();
	await act(async () => button?.click());
}

test("closing the editor during screen permission stops a late capture", async () => {
	let resolveSession: ((value: EditorClipCaptureSession) => void) | undefined;
	capture.start.mockImplementation(
		() =>
			new Promise<EditorClipCaptureSession>((resolve) => {
				resolveSession = resolve;
			}),
	);
	const onCaptured = await renderRecorder();
	await startRecorder();
	const captured = session();
	await act(async () => root?.unmount());
	root = null;
	const options = capture.start.mock.calls[0]?.[0] as
		| EditorClipCaptureOptions
		| undefined;
	expect(options?.signal?.aborted).toBe(true);
	await act(async () => resolveSession?.(captured));
	expect(captured.stop).toHaveBeenCalledOnce();
	expect(captured.release).not.toHaveBeenCalled();
	expect(onCaptured).not.toHaveBeenCalled();
});

test("closing the editor during recording stops the active two-track session", async () => {
	const captured = session();
	capture.start.mockResolvedValue(captured);
	const onCaptured = await renderRecorder();
	await startRecorder();
	expect(container.textContent).toContain("Recording");
	await act(async () => root?.unmount());
	root = null;
	expect(captured.stop).toHaveBeenCalledOnce();
	expect(captured.release).not.toHaveBeenCalled();
	expect(onCaptured).not.toHaveBeenCalled();
});

test("a recording that finishes after the editor closes is not imported", async () => {
	let resolveClip: ((value: EditorClipCapture) => void) | undefined;
	const pendingStop = new Promise<EditorClipCapture>((resolve) => {
		resolveClip = resolve;
	});
	const captured = session();
	captured.stop = vi.fn(() => pendingStop);
	capture.start.mockResolvedValue(captured);
	const onCaptured = await renderRecorder();
	await startRecorder();
	const stopButton = [...container.querySelectorAll("button")].find(
		(candidate) => candidate.textContent === "Stop and add clip",
	);
	expect(stopButton).toBeDefined();
	await act(async () => stopButton?.click());
	await act(async () => root?.unmount());
	root = null;
	await act(async () =>
		resolveClip?.({
			display: new File(["screen"], "screen.webm"),
			camera: null,
			cameraOffsetMs: 0,
		}),
	);
	expect(onCaptured).not.toHaveBeenCalled();
	expect(captured.release).not.toHaveBeenCalled();
});
