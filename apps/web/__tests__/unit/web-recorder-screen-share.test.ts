// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useScreenShare } from "@/app/(org)/dashboard/caps/components/web-recorder-dialog/useScreenShare";

vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));
vi.mock("@cap/recorder-core/recorder-utils", () => ({
	detectRecordingModeFromTrack: () => "fullscreen",
}));

type Share = ReturnType<typeof useScreenShare>;

const Harness = ({
	open,
	acquire,
	onRender,
}: {
	open: boolean;
	acquire: () => Promise<MediaStream>;
	onRender: (share: Share) => void;
}) => {
	onRender(useScreenShare({ open, acquire }));
	return null;
};

const fakeStream = () => {
	const stop = vi.fn();
	const track = { stop, addEventListener: vi.fn(), readyState: "live" };
	const stream = {
		getTracks: () => [track],
		getVideoTracks: () => [track],
	} as unknown as MediaStream;
	return { stream, stop };
};

describe("screen sharing across recorder visits", () => {
	let root: Root;
	let container: HTMLDivElement;
	let share: Share;
	let resolvePicker: (stream: MediaStream) => void;
	const acquire = () =>
		new Promise<MediaStream>((resolve) => {
			resolvePicker = resolve;
		});
	const render = (open: boolean) =>
		act(async () =>
			root.render(
				createElement(Harness, {
					open,
					acquire,
					onRender: (next) => {
						share = next;
					},
				}),
			),
		);

	beforeEach(() => {
		vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
		container = document.createElement("div");
		document.body.append(container);
		root = createRoot(container);
	});

	afterEach(async () => {
		await act(async () => root.unmount());
		container.remove();
		vi.unstubAllGlobals();
	});

	it("keeps a capture picked while the recorder is open", async () => {
		await render(true);
		const { stream, stop } = fakeStream();
		let shared: Promise<boolean> = Promise.resolve(false);
		await act(async () => {
			shared = share.shareScreen();
		});
		await act(async () => {
			resolvePicker(stream);
			expect(await shared).toBe(true);
		});
		expect(share.sharedScreen?.stream).toBe(stream);
		expect(stop).not.toHaveBeenCalled();
	});

	it("stops a capture picked after the recorder closed", async () => {
		await render(true);
		const { stream, stop } = fakeStream();
		let shared: Promise<boolean> = Promise.resolve(true);
		await act(async () => {
			shared = share.shareScreen();
		});
		await render(false);
		await act(async () => {
			resolvePicker(stream);
			expect(await shared).toBe(false);
		});
		expect(stop).toHaveBeenCalled();
		expect(share.sharedScreen).toBeNull();
		expect(share.sharedScreenRef.current).toBeNull();
		expect(share.sharePending).toBe(false);
	});

	it("doesn't hand an earlier visit's capture to a reopened recorder", async () => {
		await render(true);
		const { stream, stop } = fakeStream();
		let shared: Promise<boolean> = Promise.resolve(true);
		await act(async () => {
			shared = share.shareScreen();
		});
		await render(false);
		await render(true);
		await act(async () => {
			resolvePicker(stream);
			expect(await shared).toBe(false);
		});
		expect(stop).toHaveBeenCalled();
		expect(share.sharedScreen).toBeNull();
		expect(share.takeSharedDisplayStream()).toBeNull();
	});

	it("stops a capture picked after the recorder unmounted", async () => {
		await render(true);
		const { stream, stop } = fakeStream();
		let shared: Promise<boolean> = Promise.resolve(true);
		await act(async () => {
			shared = share.shareScreen();
		});
		await act(async () => root.unmount());
		resolvePicker(stream);
		expect(await shared).toBe(false);
		expect(stop).toHaveBeenCalled();
		root = createRoot(container);
	});
});
