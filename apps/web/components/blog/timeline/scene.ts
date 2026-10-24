/**
 * The worked example the timeline post's demo runs on: one 2:48 product
 * walkthrough, seven pieces of feedback on it, and a synthetic soundtrack.
 * Nothing here talks to the network or to a real recording; the frames are
 * drawn (see `MockFrame`) and the waveform is a deterministic function of
 * time, so the demo is fully self-contained.
 */

/** Length of the fictional recording, in seconds. */
export const DEMO_DURATION = 168;

export type DemoCommentKind = "text" | "emoji" | "screen" | "camera" | "voice";

export interface DemoComment {
	id: string;
	author: string;
	/** Avatar letter; the demo has no real images to sign. */
	initials: string;
	/** Tailwind background class for the avatar. */
	tone: string;
	/** Seconds into the recording. */
	t: number;
	kind: DemoCommentKind;
	/** Comment body, the emoji for reactions, or what a recorded reply shows. */
	text: string;
	/** Media length for video/voice replies, in seconds. */
	mediaDuration?: number;
}

/**
 * One of everything the timeline can hold: text, an emoji reaction, a screen
 * reply, a voice note and a camera reply. Sam and Priya sit three seconds
 * apart on purpose, so the second lane earns its keep, while the recorded
 * replies are spread out far enough that every glyph stays visible instead of
 * folding into a cluster.
 */
export const DEMO_COMMENTS: readonly DemoComment[] = [
	{
		id: "c1",
		author: "Maya",
		initials: "M",
		tone: "bg-blue-9",
		t: 12,
		kind: "text",
		text: "Can we open on the problem rather than the dashboard?",
	},
	{
		id: "c2",
		author: "Dev",
		initials: "D",
		tone: "bg-emerald-500",
		t: 44,
		kind: "emoji",
		text: "🔥",
	},
	{
		id: "c3",
		author: "Sam",
		initials: "S",
		tone: "bg-violet-500",
		t: 72,
		kind: "text",
		text: "The logo flickers the moment the dialog opens.",
	},
	{
		id: "c4",
		author: "Priya",
		initials: "P",
		tone: "bg-amber-500",
		t: 75,
		kind: "screen",
		text: "Screen recording of the flicker in Safari",
		mediaDuration: 19,
	},
	{
		id: "c5",
		author: "Jo",
		initials: "J",
		tone: "bg-rose-500",
		t: 96,
		kind: "voice",
		text: "Voice note talking through a fix",
		mediaDuration: 14,
	},
	{
		id: "c6",
		author: "Ana",
		initials: "A",
		tone: "bg-teal-500",
		t: 124,
		kind: "camera",
		text: "Camera reply with a suggestion",
		mediaDuration: 26,
	},
	{
		id: "c7",
		author: "Alex",
		initials: "A",
		tone: "bg-sky-600",
		t: 151,
		kind: "text",
		text: "Ship it. I'll take the copy pass.",
	},
];

/**
 * When someone is talking. The holes at 1:01–1:10 and 2:09–2:18 are the dead
 * air the speech envelope makes visible.
 */
const SPEECH_SEGMENTS: readonly (readonly [number, number])[] = [
	[2, 61],
	[70, 129],
	[138, 166],
];

const hash = (n: number) => {
	const x = Math.sin(n * 12.9898 + 78.233) * 43758.5453;
	return x - Math.floor(x);
};

const isSpeaking = (t: number) =>
	SPEECH_SEGMENTS.some(([start, end]) => t >= start && t <= end);

/**
 * Loudness at a moment, 0-1. Two layers so it reads as a voice rather than as
 * noise: a slow syllable swell, and a per-50ms grain on top. Room tone under
 * the pauses, because a flat zero looks like a broken render.
 */
export function speechEnergy(t: number): number {
	const grain = hash(Math.round(t * 20));
	if (!isSpeaking(t)) return 0.04 + 0.05 * grain;

	const syllable = 0.55 + 0.45 * Math.sin(t * 2.7);
	const phrase = 0.75 + 0.25 * Math.sin(t * 0.6 + 1.2);
	return Math.min(1, 0.2 + 0.8 * syllable * phrase * (0.82 + 0.32 * grain));
}

export function formatClock(seconds: number): string {
	const safe = Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
	const mins = Math.floor(safe / 60);
	const secs = Math.floor(safe % 60);
	return `${mins}:${secs.toString().padStart(2, "0")}`;
}

export const clamp = (value: number, min: number, max: number) =>
	Math.min(max, Math.max(min, value));
