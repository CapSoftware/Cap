// @vitest-environment jsdom

import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useDeviceAccessRequest } from "@/app/(org)/dashboard/caps/components/web-recorder-dialog/useDeviceAccessRequest";

vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));

const camera = { deviceId: "camera-1", kind: "videoinput" } as MediaDeviceInfo;

type Controls = {
	request: (kinds: { video: boolean; audio: boolean }) => Promise<void>;
	listCameras: () => void;
};

const Harness = ({
	open,
	onCameraGranted,
	controls,
}: {
	open: boolean;
	onCameraGranted: (deviceId: string) => void;
	controls: Controls;
}) => {
	const [cameras, setCameras] = useState<MediaDeviceInfo[]>([]);
	const { requestAccess } = useDeviceAccessRequest({
		open,
		availableCameras: cameras,
		availableMics: [],
		refreshDevices: async () => {},
		onCameraGranted,
		onMicGranted: vi.fn(),
	});
	controls.request = requestAccess;
	controls.listCameras = () => setCameras([camera]);
	return null;
};

describe("device access requests", () => {
	let root: Root;
	let container: HTMLDivElement;
	let grant: (stream: MediaStream) => void;
	const stop = vi.fn();
	const stream = { getTracks: () => [{ stop }] } as unknown as MediaStream;

	beforeEach(() => {
		vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
		Object.defineProperty(navigator, "mediaDevices", {
			value: {
				getUserMedia: vi.fn(
					() =>
						new Promise<MediaStream>((resolve) => {
							grant = resolve;
						}),
				),
			},
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

	const render = (
		open: boolean,
		onCameraGranted: (deviceId: string) => void,
		controls: Controls,
	) =>
		act(async () =>
			root.render(createElement(Harness, { open, onCameraGranted, controls })),
		);

	it("switches the camera on once a grant lists it", async () => {
		const onCameraGranted = vi.fn();
		const controls = {} as Controls;
		await render(true, onCameraGranted, controls);
		let pending: Promise<void> = Promise.resolve();
		await act(async () => {
			pending = controls.request({ video: true, audio: false });
		});
		await act(async () => {
			grant(stream);
			await pending;
		});
		await act(async () => controls.listCameras());
		expect(onCameraGranted).toHaveBeenCalledWith("camera-1");
	});

	it("ignores a grant that arrives after the recorder closed", async () => {
		const onCameraGranted = vi.fn();
		const controls = {} as Controls;
		await render(true, onCameraGranted, controls);
		let pending: Promise<void> = Promise.resolve();
		await act(async () => {
			pending = controls.request({ video: true, audio: false });
		});
		await render(false, onCameraGranted, controls);
		await act(async () => {
			grant(stream);
			await pending;
		});
		await act(async () => controls.listCameras());
		expect(onCameraGranted).not.toHaveBeenCalled();
		expect(stop).toHaveBeenCalled();
	});

	it("ignores a grant from an earlier visit after reopening", async () => {
		const onCameraGranted = vi.fn();
		const controls = {} as Controls;
		await render(true, onCameraGranted, controls);
		let pending: Promise<void> = Promise.resolve();
		await act(async () => {
			pending = controls.request({ video: true, audio: false });
		});
		await render(false, onCameraGranted, controls);
		await render(true, onCameraGranted, controls);
		await act(async () => {
			grant(stream);
			await pending;
		});
		await act(async () => controls.listCameras());
		expect(onCameraGranted).not.toHaveBeenCalled();
	});
});
