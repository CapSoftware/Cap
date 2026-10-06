// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CameraPreviewWindow } from "@/app/(org)/dashboard/caps/components/web-recorder-dialog/CameraPreviewWindow";

vi.mock("@cap/ui", () => ({ LoadingSpinner: () => null }));

describe("camera preview acquisition", () => {
	let root: Root;
	let container: HTMLDivElement;
	let acquire: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
		acquire = vi.fn();
		Object.defineProperty(navigator, "mediaDevices", {
			value: { getUserMedia: acquire },
			configurable: true,
		});
		container = document.createElement("div");
		document.body.append(container);
		root = createRoot(container);
	});

	afterEach(async () => {
		await act(async () => root.unmount());
		container.remove();
		vi.unstubAllGlobals();
	});

	it("stops a stream that resolves after the preview has closed", async () => {
		let resolve: (stream: MediaStream) => void = () => {};
		acquire.mockReturnValue(
			new Promise<MediaStream>((done) => {
				resolve = done;
			}),
		);
		await act(async () =>
			root.render(
				createElement(CameraPreviewWindow, {
					cameraId: "camera-1",
					onClose: vi.fn(),
				}),
			),
		);
		await act(async () => root.render(null));
		const stop = vi.fn();
		await act(async () =>
			resolve({ getTracks: () => [{ stop }] } as unknown as MediaStream),
		);
		expect(stop).toHaveBeenCalledOnce();
	});

	it("does not replace the current camera with a late previous acquisition", async () => {
		let resolveFirst: (stream: MediaStream) => void = () => {};
		const firstStop = vi.fn();
		const secondStop = vi.fn();
		const secondStream = {
			getTracks: () => [{ stop: secondStop }],
		} as unknown as MediaStream;
		acquire.mockReturnValueOnce(
			new Promise<MediaStream>((done) => {
				resolveFirst = done;
			}),
		);
		acquire.mockResolvedValueOnce(secondStream);
		await act(async () =>
			root.render(
				createElement(CameraPreviewWindow, {
					cameraId: "camera-1",
					onClose: vi.fn(),
				}),
			),
		);
		await act(async () =>
			root.render(
				createElement(CameraPreviewWindow, {
					cameraId: "camera-2",
					onClose: vi.fn(),
				}),
			),
		);
		await act(async () =>
			resolveFirst({
				getTracks: () => [{ stop: firstStop }],
			} as unknown as MediaStream),
		);
		expect(firstStop).toHaveBeenCalledOnce();
		expect(secondStop).not.toHaveBeenCalled();
		expect(document.querySelector("video")?.srcObject).toBe(secondStream);
		await act(async () => root.render(null));
		expect(secondStop).toHaveBeenCalledOnce();
	});
});
