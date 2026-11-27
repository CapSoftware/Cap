// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { shareVideoRevision } from "@/lib/share-video-revision";
import {
	announceShareVideoUpdate,
	watchShareVideoUpdates,
} from "@/lib/share-video-updates";

function bus() {
	const channels = new Set<EventTarget & { closed: boolean }>();
	const open = () => {
		const channel = Object.assign(new EventTarget(), { closed: false });
		channels.add(channel);
		return {
			postMessage: (data: unknown) => {
				for (const other of channels)
					if (other !== channel && !other.closed)
						other.dispatchEvent(new MessageEvent("message", { data }));
			},
			close: () => {
				channel.closed = true;
				channels.delete(channel);
			},
			addEventListener: channel.addEventListener.bind(channel),
			removeEventListener: channel.removeEventListener.bind(channel),
		} as unknown as BroadcastChannel;
	};
	return { open, count: () => channels.size };
}

function statusFetch(revision: () => string | null) {
	return vi.fn(async () =>
		Response.json({ state: "idle", revision: revision() }),
	) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function setVisibility(state: "visible" | "hidden") {
	Object.defineProperty(document, "visibilityState", {
		value: state,
		configurable: true,
	});
	document.dispatchEvent(new Event("visibilitychange"));
}

describe("share video revision", () => {
	it("tells published files apart without exposing their storage key", () => {
		const first = shareVideoRevision({
			type: "webMP4",
			outputKey: "owner/video/.recording/outputs/reupload-a/result.mp4",
		});
		const second = shareVideoRevision({
			type: "webMP4",
			outputKey: "owner/video/.recording/outputs/reupload-b/result.mp4",
		});
		expect(first).toBeTypeOf("string");
		expect(first).not.toBe(second);
		expect(first).not.toContain("reupload");
		expect(
			shareVideoRevision({
				type: "webMP4",
				outputKey: "owner/video/.recording/outputs/reupload-a/result.mp4",
			}),
		).toBe(first);
		expect(shareVideoRevision({ type: "webMP4" })).not.toBe(first);
		expect(shareVideoRevision({ type: "desktopMP4" })).not.toBe(
			shareVideoRevision({ type: "webMP4" }),
		);
	});

	it("leaves sources a Save never replaces unwatched", () => {
		expect(shareVideoRevision({ type: "MediaConvert" })).toBeTruthy();
		expect(shareVideoRevision({ type: "MediaConvert" })).not.toBe(
			shareVideoRevision({ type: "webMP4" }),
		);
		expect(shareVideoRevision(null)).toBeNull();
	});
});

describe("an open share page after a Save", () => {
	const stops: (() => void)[] = [];
	const clock = { now: 0 };
	const later = () => {
		clock.now += 60_000;
	};
	afterEach(() => {
		for (const stop of stops.splice(0)) stop();
		setVisibility("visible");
	});

	it("costs nothing while nobody looks, then checks once on return", async () => {
		let now = 0;
		const fetchImpl = statusFetch(() => "new");
		const onNewer = vi.fn();
		stops.push(
			watchShareVideoUpdates({
				videoId: "video",
				revision: "old",
				onNewer,
				fetchImpl,
				now: () => now,
				open: bus().open,
			}),
		);
		await flush();
		expect(fetchImpl).not.toHaveBeenCalled();

		setVisibility("hidden");
		now = 60_000;
		setVisibility("visible");
		window.dispatchEvent(new Event("focus"));
		await flush();
		expect(fetchImpl).toHaveBeenCalledTimes(1);
		expect(fetchImpl.mock.calls[0]?.[0]).toBe(
			"/api/videos/video/render-status",
		);
		expect(onNewer).toHaveBeenCalledWith("new");

		now = 70_000;
		window.dispatchEvent(new Event("focus"));
		await flush();
		expect(fetchImpl).toHaveBeenCalledTimes(1);
	});

	it("checks a page left and returned to soon after it loaded", async () => {
		let now = 0;
		const fetchImpl = statusFetch(() => "new");
		const onNewer = vi.fn();
		stops.push(
			watchShareVideoUpdates({
				videoId: "video",
				revision: "old",
				onNewer,
				fetchImpl,
				now: () => now,
				open: bus().open,
			}),
		);
		window.dispatchEvent(new Event("focus"));
		await flush();
		expect(fetchImpl).not.toHaveBeenCalled();

		now = 5_000;
		window.dispatchEvent(new Event("blur"));
		now = 10_000;
		window.dispatchEvent(new Event("focus"));
		await flush();
		expect(fetchImpl).toHaveBeenCalledTimes(1);
		expect(onNewer).toHaveBeenCalledWith("new");

		now = 15_000;
		window.dispatchEvent(new Event("blur"));
		window.dispatchEvent(new Event("focus"));
		await flush();
		expect(fetchImpl).toHaveBeenCalledTimes(1);
	});

	it("stays put while the server still publishes the version shown", async () => {
		const fetchImpl = statusFetch(() => "same");
		const onNewer = vi.fn();
		stops.push(
			watchShareVideoUpdates({
				videoId: "video",
				revision: "same",
				onNewer,
				fetchImpl,
				now: () => clock.now,
				open: bus().open,
			}),
		);
		later();
		window.dispatchEvent(new Event("focus"));
		await flush();
		expect(fetchImpl).toHaveBeenCalledTimes(1);
		expect(onNewer).not.toHaveBeenCalled();
	});

	it("checks straight away when another tab announces a Save of this video", async () => {
		const channels = bus();
		const fetchImpl = statusFetch(() => "new");
		const onNewer = vi.fn();
		stops.push(
			watchShareVideoUpdates({
				videoId: "video",
				revision: "old",
				onNewer,
				fetchImpl,
				now: () => 0,
				open: channels.open,
			}),
		);
		announceShareVideoUpdate("another-video", channels.open);
		await flush();
		expect(fetchImpl).not.toHaveBeenCalled();

		announceShareVideoUpdate("video", channels.open);
		await flush();
		expect(fetchImpl).toHaveBeenCalledTimes(1);
		expect(onNewer).toHaveBeenCalledWith("new");
		expect(channels.count()).toBe(1);
	});

	it("looks again when a Save lands during a check that began before it", async () => {
		const channels = bus();
		let published = "old";
		let release: () => void = () => undefined;
		const fetchImpl = vi.fn(async () => {
			const revision = published;
			await new Promise<void>((resolve) => {
				release = resolve;
			});
			return Response.json({ revision });
		}) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
		const onNewer = vi.fn();
		stops.push(
			watchShareVideoUpdates({
				videoId: "video",
				revision: "old",
				onNewer,
				fetchImpl,
				now: () => clock.now,
				open: channels.open,
			}),
		);
		later();
		window.dispatchEvent(new Event("focus"));
		await flush();
		published = "new";
		announceShareVideoUpdate("video", channels.open);
		release();
		await flush();
		await flush();
		release();
		await flush();
		await flush();
		expect(fetchImpl).toHaveBeenCalledTimes(2);
		expect(onNewer).toHaveBeenCalledTimes(1);
		expect(onNewer).toHaveBeenCalledWith("new");
	});

	it("stops listening once the page moves on", async () => {
		const channels = bus();
		const fetchImpl = statusFetch(() => "new");
		const onNewer = vi.fn();
		const stop = watchShareVideoUpdates({
			videoId: "video",
			revision: "old",
			onNewer,
			fetchImpl,
			now: () => clock.now,
			open: channels.open,
		});
		stop();
		later();
		window.dispatchEvent(new Event("focus"));
		announceShareVideoUpdate("video", channels.open);
		await flush();
		expect(fetchImpl).not.toHaveBeenCalled();
		expect(channels.count()).toBe(0);
	});

	it("ignores a status it can't read", async () => {
		const fetchImpl = vi.fn(
			async () => new Response("nope", { status: 500 }),
		) as unknown as typeof fetch;
		const onNewer = vi.fn();
		stops.push(
			watchShareVideoUpdates({
				videoId: "video",
				revision: "old",
				onNewer,
				fetchImpl,
				now: () => clock.now,
				open: bus().open,
			}),
		);
		later();
		window.dispatchEvent(new Event("focus"));
		await flush();
		expect(onNewer).not.toHaveBeenCalled();
	});
});
