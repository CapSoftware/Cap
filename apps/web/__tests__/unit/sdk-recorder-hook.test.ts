// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useCapRecorder } from "../../../../packages/sdk-recorder/src/react/useCapRecorder";
import type { RecorderOptions } from "../../../../packages/sdk-recorder/src/types";

class Track {
	readyState = "live";
	onended: (() => void) | null = null;
	constructor(readonly kind: "video" | "audio") {}
	stop() {
		this.readyState = "ended";
	}
}
class Stream {
	constructor(readonly tracks: Track[]) {}
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
class Encoder {
	state = "inactive";
	ondataavailable: ((event: { data: Blob }) => void) | null = null;
	onstop: (() => void) | null = null;
	static isTypeSupported() {
		return true;
	}
	start() {
		this.state = "recording";
	}
	pause() {
		this.state = "paused";
	}
	stop() {
		this.state = "inactive";
		this.ondataavailable?.({ data: new Blob(["recording"]) });
		queueMicrotask(() => this.onstop?.());
	}
}
let current: ReturnType<typeof useCapRecorder> | undefined;
const value = () => {
	if (!current) throw new Error("Hook not mounted");
	return current;
};
function Harness(options: RecorderOptions) {
	current = useCapRecorder(options);
	return null;
}
const initial: RecorderOptions = {
	publicKey: "first-key",
	mode: "camera",
	microphone: { enabled: false },
};
let root: Root;
let container: HTMLDivElement;
let tracks: Track[];
let now: number;
let intervals: Map<number, () => void>;
const render = async (options = initial) => {
	await act(async () => root.render(createElement(Harness, options)));
};

beforeEach(() => {
	current = undefined;
	tracks = [];
	now = 1000;
	intervals = new Map();
	let nextInterval = 0;
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	vi.spyOn(Date, "now").mockImplementation(() => now);
	vi.stubGlobal("setInterval", (callback: () => void) => {
		const id = ++nextInterval;
		intervals.set(id, callback);
		return id;
	});
	vi.stubGlobal("clearInterval", (id: number) => {
		intervals.delete(id);
	});
	vi.stubGlobal("MediaRecorder", Encoder);
	vi.stubGlobal("MediaStream", Stream);
	const capture = async (constraints: MediaStreamConstraints) => {
		const track = new Track(constraints.video ? "video" : "audio");
		tracks.push(track);
		return new Stream([track]);
	};
	vi.stubGlobal("navigator", {
		mediaDevices: { getUserMedia: capture, getDisplayMedia: capture },
	});
	vi.stubGlobal("fetch", async (url: string) => {
		if (url.endsWith("/videos/create"))
			return Response.json({
				videoId: "first-video",
				shareUrl: "https://cap.test/s/first-video",
				embedUrl: "https://cap.test/embed/first-video",
			});
		if (url.endsWith("/initiate")) return Response.json({ uploadId: "upload" });
		if (url.endsWith("/presign-part"))
			return Response.json({ presignedUrl: "https://storage.test/part" });
		return new Response("{}", {
			headers: { ETag: "etag", "Content-Type": "application/json" },
		});
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
const start = async () => {
	await act(async () => value().start());
	now = 3000;
	await act(async () => {
		for (const interval of intervals.values()) interval();
	});
};

describe("SDK React recorder ownership", () => {
	it.each([
		["key", { publicKey: "second-key" }],
		["server", { apiBase: "https://other.cap.test" }],
		["user", { userId: "second-user" }],
		["camera", { camera: { enabled: true, deviceId: "second-camera" } }],
	] as const)(
		"resets capture state when the %s configuration replaces its recorder",
		async (_name, options) => {
			await render();
			await start();
			expect(value().phase).toBe("recording");
			expect(value().durationMs).toBe(2000);
			const previousTracks = [...tracks];
			await render({ ...initial, ...options });
			expect(value().phase).toBe("idle");
			expect(value().isRecording).toBe(false);
			expect(value().durationMs).toBe(0);
			expect(
				previousTracks.every((track) => track.readyState === "ended"),
			).toBe(true);
			await act(async () => value().start());
			expect(value().phase).toBe("recording");
			expect(tracks.at(-1)?.readyState).toBe("live");
		},
	);

	it("removes the completed recording's identity when a new configuration is installed", async () => {
		await render();
		await start();
		await act(async () => {
			await value().stop();
		});
		expect(value().phase).toBe("complete");
		expect(value().videoId).toBe("first-video");
		await render({ ...initial, publicKey: "second-key" });
		expect(value().phase).toBe("idle");
		expect(value().videoId).toBeNull();
		expect(value().durationMs).toBe(0);
	});

	it("retains the same capture across equivalent rerenders and limit-only changes", async () => {
		await render();
		await start();
		const before = [...tracks];
		await render({
			...initial,
			microphone: { enabled: false },
			maxDurationMs: 15000,
		});
		expect(value().phase).toBe("recording");
		expect(value().durationMs).toBe(2000);
		expect(tracks).toEqual(before);
		expect(before.every((track) => track.readyState === "live")).toBe(true);
	});
});
