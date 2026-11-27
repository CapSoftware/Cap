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

const fakeStream = (readyState: MediaStreamTrackState = "live") => {
	const stop = vi.fn();
	const track = { stop, addEventListener: vi.fn(), readyState };
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

	it("adopts a screen handed back while the recorder is open", async () => {
		await render(true);
		const { stream, stop } = fakeStream();
		let adopted = false;
		await act(async () => {
			adopted = share.returnSharedDisplayStream(stream);
		});
		expect(adopted).toBe(true);
		expect(stop).not.toHaveBeenCalled();
		expect(share.sharedScreen?.stream).toBe(stream);
		expect(share.takeSharedDisplayStream()).toBe(stream);
	});

	it("stops a screen handed back after the recorder closed", async () => {
		await render(true);
		await render(false);
		const { stream, stop } = fakeStream();
		expect(share.returnSharedDisplayStream(stream)).toBe(false);
		expect(stop).toHaveBeenCalled();
		expect(share.sharedScreen).toBeNull();
	});

	it("stops a handed back screen whose capture already ended", async () => {
		await render(true);
		const { stream, stop } = fakeStream("ended");
		expect(share.returnSharedDisplayStream(stream)).toBe(false);
		expect(stop).toHaveBeenCalled();
		expect(share.sharedScreen).toBeNull();
	});

	it("keeps a screen shared since and stops the one handed back", async () => {
		await render(true);
		const current = fakeStream();
		let shared: Promise<boolean> = Promise.resolve(false);
		await act(async () => {
			shared = share.shareScreen();
		});
		await act(async () => {
			resolvePicker(current.stream);
			await shared;
		});
		const handedBack = fakeStream();
		expect(share.returnSharedDisplayStream(handedBack.stream)).toBe(false);
		expect(handedBack.stop).toHaveBeenCalled();
		expect(current.stop).not.toHaveBeenCalled();
		expect(share.sharedScreen?.stream).toBe(current.stream);
	});

	it("stops a screen handed back after the recorder unmounted", async () => {
		await render(true);
		const returnShared = share.returnSharedDisplayStream;
		await act(async () => root.unmount());
		const { stream, stop } = fakeStream();
		expect(returnShared(stream)).toBe(false);
		expect(stop).toHaveBeenCalled();
		root = createRoot(container);
	});
});
