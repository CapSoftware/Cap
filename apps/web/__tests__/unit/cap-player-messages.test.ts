import { afterEach, describe, expect, it, vi } from "vitest";
import {
	connectMessages,
	createThrottle,
	type MessageTarget,
	parseCommand,
	qualityKey,
	TIMEUPDATE_GAP_MS,
} from "@/components/cap-player/messages";

class FakeVideo extends EventTarget {
	currentTime = 0;
	duration = 30;
	paused = true;
	muted = false;
	plays = 0;
	refuse = false;
	currentSrc = "blob:attached";

	getAttribute() {
		return null;
	}

	play() {
		this.plays++;
		if (this.refuse) {
			const error = new Error("refused");
			error.name = "NotAllowedError";
			return Promise.reject(error);
		}
		this.paused = false;
		return Promise.resolve();
	}

	pause() {
		this.paused = true;
	}
}

const embedded = (
	options: { seekDuringSwitch?: (time: number) => boolean } = {},
) => {
	const posted: { message: Record<string, unknown>; origin: string }[] = [];
	const parent = {
		postMessage: (message: unknown, origin: string) => {
			posted.push({ message: message as Record<string, unknown>, origin });
		},
	};
	const view = new EventTarget();
	const target = Object.assign(view, { parent }) as unknown as MessageTarget;
	const video = new FakeVideo();
	const setQuality = vi.fn();
	const connection = connectMessages(
		target,
		video as unknown as HTMLVideoElement,
		{ setQuality, seekDuringSwitch: options.seekDuringSwitch },
	);
	const command = (data: unknown, source: unknown = parent) =>
		view.dispatchEvent(
			Object.assign(new Event("message"), { data, source }) as MessageEvent,
		);
	const events = () => posted.map(({ message }) => message.event);
	return { posted, video, setQuality, connection, command, events, parent };
};

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

describe("parseCommand", () => {
	it.each([
		[{ type: "cap-player", command: "play" }, { command: "play" }],
		[{ type: "cap-player", command: "pause" }, { command: "pause" }],
		[{ type: "cap-player", command: "mute" }, { command: "mute" }],
		[{ type: "cap-player", command: "unmute" }, { command: "unmute" }],
		[
			{ type: "cap-player", command: "seek", time: 12.5 },
			{ command: "seek", time: 12.5 },
		],
		[
			{ type: "cap-player", command: "seek", time: 0 },
			{ command: "seek", time: 0 },
		],
		[
			{ type: "cap-player", command: "setQuality", quality: "720p" },
			{ command: "setQuality", quality: "720p" },
		],
		[
			{ type: "cap-player", command: "setQuality", quality: 1080 },
			{ command: "setQuality", quality: "1080" },
		],
		[
			{ type: "cap-player", command: "setQuality", quality: "Auto" },
			{ command: "setQuality", quality: "auto" },
		],
		[
			{ type: "cap-player", command: "setQuality", quality: "4K" },
			{ command: "setQuality", quality: "4k" },
		],
	])("accepts %j", (data, parsed) => {
		expect(parseCommand(data)).toEqual(parsed);
	});

	it.each([
		null,
		undefined,
		"play",
		42,
		[],
		["cap-player", "play"],
		{ command: "play" },
		{ type: "other", command: "play" },
		{ type: "cap-player" },
		{ type: "cap-player", command: "PLAY" },
		{ type: "cap-player", command: "destroy" },
		{ type: "cap-player", command: "__proto__" },
		{ type: "cap-player", command: "toString" },
		{ type: "cap-player", command: { toString: (): string => "play" } },
		{ type: "cap-player", command: "seek" },
		{ type: "cap-player", command: "seek", time: "12" },
		{ type: "cap-player", command: "seek", time: -1 },
		{ type: "cap-player", command: "seek", time: Number.NaN },
		{ type: "cap-player", command: "seek", time: Number.POSITIVE_INFINITY },
		{ type: "cap-player", command: "seek", time: 1e12 },
		{ type: "cap-player", command: "setQuality" },
		{ type: "cap-player", command: "setQuality", quality: "" },
		{ type: "cap-player", command: "setQuality", quality: "best" },
		{ type: "cap-player", command: "setQuality", quality: "720p;x" },
		{
			type: "cap-player",
			command: "setQuality",
			quality: "<img src=x onerror=alert(1)>",
		},
		{ type: "cap-player", command: "setQuality", quality: { label: "720p" } },
		{ type: "cap-player", command: "setQuality", quality: 1.5 },
	])("refuses %j", (data) => {
		expect(parseCommand(data)).toBeNull();
	});
});

describe("qualityKey", () => {
	it("treats the ways of naming one quality as the same", () => {
		expect(qualityKey("1080p")).toBe(qualityKey("1080"));
		expect(qualityKey("4K")).toBe(qualityKey("2160p"));
		expect(qualityKey("4k")).toBe(qualityKey("2160"));
		expect(qualityKey("720p")).not.toBe(qualityKey("1080p"));
	});
});

describe("createThrottle", () => {
	it("lets at most one event through in each gap", () => {
		const pass = createThrottle(TIMEUPDATE_GAP_MS);
		const passed = [0, 50, 100, 239, 240, 300, 480, 481, 1000].filter(pass);

		expect(passed).toEqual([0, 240, 480, 1000]);
	});

	it("allows about four a second for events every frame", () => {
		const pass = createThrottle(TIMEUPDATE_GAP_MS);
		const frames = Array.from({ length: 60 }, (_, index) => index * 16.7);

		expect(frames.filter(pass)).toEqual([0, 250.5, 501, 751.5]);
	});
});

describe("connectMessages", () => {
	it("says it is ready, to any origin, with the playback state only", () => {
		const { posted } = embedded();

		expect(posted).toEqual([
			{
				message: {
					type: "cap-player",
					event: "ready",
					currentTime: 0,
					duration: 30,
					paused: true,
					muted: false,
				},
				origin: "*",
			},
		]);
	});

	it("passes on play, pause and ended", () => {
		const { video, events } = embedded();

		video.dispatchEvent(new Event("play"));
		video.dispatchEvent(new Event("pause"));
		video.dispatchEvent(new Event("ended"));

		expect(events()).toEqual(["ready", "play", "pause", "ended"]);
	});

	it("passes on time updates at most about four times a second", () => {
		let now = 0;
		vi.stubGlobal("performance", { now: () => now });
		const { video, posted } = embedded();

		for (let frame = 0; frame < 60; frame++) {
			now = frame * 16.7;
			video.currentTime = now / 1000;
			video.dispatchEvent(new Event("timeupdate"));
		}

		const updates = posted.filter(
			({ message }) => message.event === "timeupdate",
		);
		expect(updates).toHaveLength(4);
		expect(updates[1]?.message.currentTime).toBe(0.251);
	});

	it("reports a duration that is not known yet as zero", () => {
		const { video, connection, posted } = embedded();
		video.duration = Number.NaN;

		connection.send("qualitychange", { quality: "720p", auto: true });

		expect(posted.at(-1)?.message).toMatchObject({
			event: "qualitychange",
			duration: 0,
			quality: "720p",
			auto: true,
		});
	});

	it("follows commands from the embedding page", async () => {
		const { video, command, setQuality } = embedded();

		command({ type: "cap-player", command: "play" });
		await Promise.resolve();
		expect(video.paused).toBe(false);

		command({ type: "cap-player", command: "pause" });
		expect(video.paused).toBe(true);

		command({ type: "cap-player", command: "mute" });
		expect(video.muted).toBe(true);
		command({ type: "cap-player", command: "unmute" });
		expect(video.muted).toBe(false);

		command({ type: "cap-player", command: "seek", time: 12 });
		expect(video.currentTime).toBe(12);
		command({ type: "cap-player", command: "seek", time: 999 });
		expect(video.currentTime).toBe(30);

		command({ type: "cap-player", command: "setQuality", quality: "720p" });
		expect(setQuality).toHaveBeenCalledWith("720p");
	});

	it("keeps a seek sent before the duration is known until the metadata arrives", () => {
		const { video, command } = embedded();
		video.duration = Number.NaN;

		command({ type: "cap-player", command: "seek", time: 12 });
		expect(video.currentTime).toBe(0);

		video.duration = 30;
		video.dispatchEvent(new Event("loadedmetadata"));
		expect(video.currentTime).toBe(12);

		video.currentTime = 20;
		video.dispatchEvent(new Event("durationchange"));
		expect(video.currentTime).toBe(20);
	});

	it("keeps only the last early seek, and drops it once a seek lands", () => {
		const { video, command } = embedded();
		video.duration = Number.NaN;

		command({ type: "cap-player", command: "seek", time: 12 });
		command({ type: "cap-player", command: "seek", time: 50 });
		video.duration = 30;
		video.dispatchEvent(new Event("durationchange"));

		expect(video.currentTime).toBe(30);
	});

	it("holds a play sent before the source is attached until it is", async () => {
		const { video, command, events } = embedded();
		video.currentSrc = "";

		command({ type: "cap-player", command: "play" });
		await Promise.resolve();
		expect(video.plays).toBe(0);

		video.currentSrc = "blob:attached";
		video.dispatchEvent(new Event("loadedmetadata"));
		await Promise.resolve();

		expect(video.plays).toBe(1);
		expect(video.paused).toBe(false);
		expect(events()).toEqual(["ready"]);
	});

	it("drops a held play when a pause follows it", async () => {
		const { video, command } = embedded();
		video.currentSrc = "";

		command({ type: "cap-player", command: "play" });
		command({ type: "cap-player", command: "pause" });
		video.currentSrc = "blob:attached";
		video.dispatchEvent(new Event("loadedmetadata"));
		await Promise.resolve();

		expect(video.plays).toBe(0);
	});

	it("hands a seek to a quality switch that is loading", () => {
		const seekDuringSwitch = vi.fn(() => true);
		const { video, command } = embedded({ seekDuringSwitch });
		video.duration = Number.NaN;

		command({ type: "cap-player", command: "seek", time: 8 });
		video.duration = 30;
		video.dispatchEvent(new Event("loadedmetadata"));

		expect(seekDuringSwitch).toHaveBeenCalledWith(8);
		expect(video.currentTime).toBe(0);
	});

	it("ignores messages from any window but the embedding page", async () => {
		const { video, command } = embedded();

		command({ type: "cap-player", command: "play" }, null);
		command({ type: "cap-player", command: "play" }, {});
		await Promise.resolve();

		expect(video.plays).toBe(0);
	});

	it("ignores malformed commands", () => {
		const { video, command, setQuality, posted } = embedded();

		command({ type: "cap-player", command: "seek", time: "1e3" });
		command({ type: "cap-player", command: "setQuality", quality: "x" });
		command("play");

		expect(video.currentTime).toBe(0);
		expect(setQuality).not.toHaveBeenCalled();
		expect(posted).toHaveLength(1);
	});

	it("reports a play the browser refuses", async () => {
		const { video, command, posted } = embedded();
		video.refuse = true;

		command({ type: "cap-player", command: "play" });
		await vi.waitFor(() => expect(posted).toHaveLength(2));

		expect(posted[1]?.message).toMatchObject({
			event: "error",
			code: "play_refused",
		});
	});

	it("does not report a play that a pause interrupted", async () => {
		const { video, command, posted } = embedded();
		video.play = () => {
			const error = new Error("interrupted");
			error.name = "AbortError";
			return Promise.reject(error);
		};

		command({ type: "cap-player", command: "play" });
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(posted).toHaveLength(1);
	});

	it("stops listening and passing events on once stopped", async () => {
		const { video, command, connection, posted } = embedded();

		connection.stop();
		video.dispatchEvent(new Event("play"));
		command({ type: "cap-player", command: "play" });
		await Promise.resolve();

		expect(posted).toHaveLength(1);
		expect(video.plays).toBe(0);
	});
});
