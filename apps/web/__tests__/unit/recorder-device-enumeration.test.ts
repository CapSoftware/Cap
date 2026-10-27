// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useCameraDevices } from "@/app/(org)/dashboard/caps/components/web-recorder-dialog/useCameraDevices";
import { useMicrophoneDevices } from "@/app/(org)/dashboard/caps/components/web-recorder-dialog/useMicrophoneDevices";

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}
const device = (kind: MediaDeviceKind, deviceId: string) => ({
	kind,
	deviceId,
	groupId: "",
	label: deviceId,
	toJSON: () => ({}),
});
const cases = [
	{ name: "camera", kind: "videoinput" as const, useDevices: useCameraDevices },
	{
		name: "microphone",
		kind: "audioinput" as const,
		useDevices: useMicrophoneDevices,
	},
];
describe.each(cases)("$name enumeration", ({ kind, useDevices }) => {
	let root: Root;
	let container: HTMLDivElement;
	let devices: ReturnType<typeof useCameraDevices>;
	let media: EventTarget & { enumerateDevices: ReturnType<typeof vi.fn> };
	function Harness({ open }: { open: boolean }) {
		devices = useDevices(open);
		return null;
	}
	beforeEach(() => {
		vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
		media = Object.assign(new EventTarget(), { enumerateDevices: vi.fn() });
		vi.stubGlobal("navigator", { mediaDevices: media });
		container = document.createElement("div");
		document.body.append(container);
		root = createRoot(container);
	});
	afterEach(async () => {
		await act(async () => root.unmount());
		container.remove();
		vi.unstubAllGlobals();
	});
	it("keeps the most recent device-change result when an older query resolves last", async () => {
		const first = deferred<MediaDeviceInfo[]>();
		const second = deferred<MediaDeviceInfo[]>();
		media.enumerateDevices
			.mockReturnValueOnce(first.promise)
			.mockReturnValueOnce(second.promise);
		await act(async () => root.render(createElement(Harness, { open: true })));
		await act(async () => media.dispatchEvent(new Event("devicechange")));
		await act(async () => second.resolve([device(kind, "new")]));
		await act(async () => first.resolve([device(kind, "old")]));
		expect(devices.devices.map((item) => item.deviceId)).toEqual(["new"]);
	});
	it("keeps the refreshed list when a pre-permission query resolves afterward", async () => {
		const beforePermission = deferred<MediaDeviceInfo[]>();
		const afterPermission = deferred<MediaDeviceInfo[]>();
		media.enumerateDevices
			.mockReturnValueOnce(beforePermission.promise)
			.mockReturnValueOnce(afterPermission.promise);
		await act(async () => root.render(createElement(Harness, { open: true })));
		let refreshed!: Promise<void>;
		await act(async () => {
			refreshed = devices.refresh();
		});
		await act(async () => {
			afterPermission.resolve([device(kind, "granted")]);
			await refreshed;
		});
		await act(async () => beforePermission.resolve([device(kind, "")]));
		expect(devices.devices.map((item) => item.deviceId)).toEqual(["granted"]);
	});
	it("does not publish a pending enumeration after the dialog closes", async () => {
		const pending = deferred<MediaDeviceInfo[]>();
		media.enumerateDevices.mockReturnValueOnce(pending.promise);
		await act(async () => root.render(createElement(Harness, { open: true })));
		await act(async () => root.render(createElement(Harness, { open: false })));
		await act(async () => pending.resolve([device(kind, "old")]));
		expect(devices.devices).toEqual([]);
	});
	it("filters placeholders and other device kinds and removes its listener on close", async () => {
		media.enumerateDevices.mockResolvedValue([
			device(kind, "device"),
			device(kind, " "),
			device(kind === "audioinput" ? "videoinput" : "audioinput", "other"),
		]);
		await act(async () => root.render(createElement(Harness, { open: true })));
		expect(devices.devices.map((item) => item.deviceId)).toEqual(["device"]);
		await act(async () => root.render(createElement(Harness, { open: false })));
		await act(async () => media.dispatchEvent(new Event("devicechange")));
		expect(media.enumerateDevices).toHaveBeenCalledTimes(1);
	});
});
