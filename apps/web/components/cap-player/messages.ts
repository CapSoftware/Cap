export const MESSAGE_TYPE = "cap-player";
export const TIMEUPDATE_GAP_MS = 240;

export type PlayerEventName =
	| "ready"
	| "play"
	| "pause"
	| "ended"
	| "timeupdate"
	| "qualitychange"
	| "error";

export type PlayerCommand =
	| { command: "play" | "pause" | "mute" | "unmute" }
	| { command: "seek"; time: number }
	| { command: "setQuality"; quality: string };

const SIMPLE_COMMANDS = new Set(["play", "pause", "mute", "unmute"]);
const QUALITY_PATTERN = /^(auto|4k|\d{3,4}p?)$/i;
const MAX_SEEK_SECONDS = 1_000_000;

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

export const parseCommand = (data: unknown): PlayerCommand | null => {
	if (!isRecord(data) || data.type !== MESSAGE_TYPE) return null;
	const { command } = data;
	if (typeof command !== "string") return null;
	if (SIMPLE_COMMANDS.has(command)) {
		return { command } as PlayerCommand;
	}
	if (command === "seek") {
		const { time } = data;
		return typeof time === "number" &&
			Number.isFinite(time) &&
			time >= 0 &&
			time <= MAX_SEEK_SECONDS
			? { command, time }
			: null;
	}
	if (command === "setQuality") {
		const { quality } = data;
		const text =
			typeof quality === "number" ? String(quality) : (quality ?? "");
		return typeof text === "string" && QUALITY_PATTERN.test(text)
			? { command, quality: text.toLowerCase() }
			: null;
	}
	return null;
};

// "1080", "1080p" and a level labelled "1080p" are the same quality, and so
// are "4k", "2160" and "2160p".
export const qualityKey = (label: string) => {
	const key = label.toLowerCase().replace(/p$/, "");
	return key === "4k" ? "2160" : key;
};

export const createThrottle = (gapMs: number) => {
	let last = Number.NEGATIVE_INFINITY;
	return (now: number) => {
		if (now - last < gapMs) return false;
		last = now;
		return true;
	};
};

const roundTime = (seconds: number) =>
	Number.isFinite(seconds) ? Math.round(seconds * 1000) / 1000 : 0;

export const playerEvent = (
	event: PlayerEventName,
	video: Pick<
		HTMLVideoElement,
		"currentTime" | "duration" | "paused" | "muted"
	>,
	extra?: Record<string, string | boolean>,
) => ({
	type: MESSAGE_TYPE,
	event,
	currentTime: roundTime(video.currentTime),
	duration: roundTime(video.duration),
	paused: video.paused,
	muted: video.muted,
	...extra,
});

export interface MessageTarget {
	parent: { postMessage: (message: unknown, targetOrigin: string) => void };
	addEventListener: (
		type: "message",
		listener: (event: MessageEvent) => void,
	) => void;
	removeEventListener: (
		type: "message",
		listener: (event: MessageEvent) => void,
	) => void;
}

// Events go to any embedding page: they carry only the playback state, never
// the video's links. Commands are taken only from the embedding page's window,
// whatever its origin, and only in the shapes parseCommand allows.
export const connectMessages = (
	target: MessageTarget,
	video: HTMLVideoElement,
	setQuality: (quality: string) => void,
) => {
	const send = (
		event: PlayerEventName,
		extra?: Record<string, string | boolean>,
	) => target.parent.postMessage(playerEvent(event, video, extra), "*");
	const throttle = createThrottle(TIMEUPDATE_GAP_MS);
	// A parent may seek on ready, before the duration is known. The time is
	// kept until the metadata arrives rather than clamped to nothing.
	let pendingSeek: number | null = null;
	const knownDuration = () =>
		Number.isFinite(video.duration) && video.duration > 0
			? video.duration
			: null;
	const seek = (time: number) => {
		const end = knownDuration();
		pendingSeek = end === null ? time : null;
		if (end !== null) video.currentTime = Math.min(end, time);
	};
	const seekWhenKnown = () => {
		if (pendingSeek !== null && knownDuration() !== null) seek(pendingSeek);
	};

	const onMessage = (message: MessageEvent) => {
		if (message.source !== target.parent) return;
		const parsed = parseCommand(message.data);
		if (!parsed) return;
		if (parsed.command === "play") {
			void video.play().catch((error: unknown) => {
				if (error instanceof Error && error.name === "NotAllowedError") {
					send("error", { code: "play_refused" });
				}
			});
		} else if (parsed.command === "pause") video.pause();
		else if (parsed.command === "mute") video.muted = true;
		else if (parsed.command === "unmute") video.muted = false;
		else if (parsed.command === "seek") seek(parsed.time);
		else if (parsed.command === "setQuality") setQuality(parsed.quality);
	};

	const relayed: [string, () => void][] = [
		["loadedmetadata", seekWhenKnown],
		["durationchange", seekWhenKnown],
		["play", () => send("play")],
		["pause", () => send("pause")],
		["ended", () => send("ended")],
		[
			"timeupdate",
			() => {
				if (throttle(performance.now())) send("timeupdate");
			},
		],
	];
	for (const [name, handler] of relayed) video.addEventListener(name, handler);
	target.addEventListener("message", onMessage);
	send("ready");

	return {
		send,
		stop: () => {
			for (const [name, handler] of relayed) {
				video.removeEventListener(name, handler);
			}
			target.removeEventListener("message", onMessage);
		},
	};
};
