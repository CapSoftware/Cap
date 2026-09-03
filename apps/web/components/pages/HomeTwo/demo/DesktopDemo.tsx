"use client";

import { classNames } from "@cap/utils/helpers";
import { useDetectPlatform } from "hooks/useDetectPlatform";
import { MousePointerClick, RotateCcw } from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import {
	memo,
	useCallback,
	useEffect,
	useLayoutEffect,
	useMemo,
	useReducer,
	useRef,
	useState,
} from "react";
import { PlatformCursor } from "../cursors";
import {
	BTN_PRIMARY,
	BTN_SECONDARY,
	CARD_BG,
	grainBg,
	MODE_THEME,
	type ModeTheme,
} from "../theme";
import { useInView, usePageVisible } from "../visibility";
import { CapEditorWindow, type EditorUi } from "./CapEditorWindow";
import {
	CapRecorderWindow,
	type RecorderMode,
	type RecorderUi,
} from "./CapRecorderWindow";
import { CapShareWindow } from "./CapShareWindow";
import {
	CameraWindow,
	LinkNotification,
	RecordingToolbar,
	TargetOverlayPanel,
} from "./CapSurfaces";
import { CapClapperboard, CapFilmCut, CapInstant } from "./capIcons";
import { ContentWindow, DesktopFiles, Dock, MenuBar } from "./MacDesktop";
import { type DemoPlatform, DemoPlatformProvider } from "./platform";
import { WinDesktopFiles, WinTaskbar } from "./WindowsShell";

const MemoizedEditorWindow = memo(CapEditorWindow);
const MemoizedShareWindow = memo(CapShareWindow);
const MemoizedContentWindow = memo(ContentWindow);

/**
 * The interactive "see how it works" demo: a macOS desktop inside a laptop
 * mockup, with the real Cap windows recreated 1:1 — and this time the
 * visitor drives. Every control in the story is a live button: pick Instant
 * mode, choose the display, start and stop a real (fake) recording, open the
 * link notification, flip to Studio, turn the camera on, restyle the editor
 * background, hit Export. A guide bubble explains each step, a pulsing
 * beacon + spotlight mark the next click, and "i" hotspots open short
 * explainers on the parts worth poking at. Off-script clicks that would
 * break the story get a friendly nudge; harmless ones (camera toggle,
 * pausing the recording, any wallpaper, reactions) just work.
 */

/* ------------------------------------------------------------ stage layout -- */

const STAGE_W = 1360;

/**
 * The laptop is one fixed logical canvas, uniformly scaled to fit. The
 * screen is 1360×850; windows live in a 1360×794 layer under the 28px
 * menu bar so the POS coordinates below stay screen-relative.
 */
const LAPTOP = {
	w: 1470,
	h: 920,
	bodyX: 33,
	bodyW: 1404,
	bodyH: 894,
	screenX: 55,
	screenY: 22,
	screenW: 1360,
	screenH: 850,
	baseY: 894,
	baseH: 26,
};

const POS = {
	content: { left: 80, top: 58, width: 760, height: 560 },
	recorder: { left: 906, top: 96 },
	camera: { left: 1040, top: 474 },
	toolbar: { left: (STAGE_W - 296) / 2, top: 646 },
	overlay: { left: (STAGE_W - 416) / 2, top: 388 },
	notification: { left: STAGE_W - 344 - 18, top: 14 },
	share: { left: (STAGE_W - 720) / 2, top: 40, width: 720, height: 622 },
	editor: { left: (STAGE_W - 1080) / 2, top: 14, width: 1080, height: 678 },
};

/**
 * Windows toasts rise from the bottom right, above the taskbar, where macOS
 * banners drop in at the top right. Layer space, so the 28px the windows
 * layer is already offset by is taken out.
 */
const WIN_NOTIFICATION_TOP = LAPTOP.screenH - 28 - 48 - 16 - 112;

/** Idle "attract" state: the recorder sits centred, like the app just opened. */
const IDLE_RECORDER = { left: (STAGE_W - 330) / 2, top: 185 };

const clamp = (v: number, lo: number, hi: number) =>
	Math.min(hi, Math.max(lo, v));

const formatClock = (totalSeconds: number) => {
	const s = Math.max(0, Math.floor(totalSeconds));
	return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

/* ------------------------------------------------------------------- state -- */

type Stage =
	| "recorder"
	| "overlay"
	| "recording"
	| "shared"
	| "editor"
	| "done";

type DemoState = {
	/** Current tour step; TOTAL_STEPS means the demo is finished. */
	step: number;
	stage: Stage;
	mode: RecorderMode;
	displaySelected: boolean;
	cameraOn: boolean;
	notification: boolean;
	shareVisible: boolean;
	comment: boolean;
	bgIndex: number;
	paused: boolean;
	editorPlaying: boolean;
	/** Story history, so free play can never strand the tour. */
	r1Started: boolean;
	r1Stopped: boolean;
	shareSeen: boolean;
	r2Started: boolean;
	r2Stopped: boolean;
	swatched: boolean;
	interacted: boolean;
	/** Bumped when a click lands somewhere the story can't go yet. */
	nudge: number;
};

type Action =
	| { type: "mode"; mode: RecorderMode }
	| { type: "display" }
	| { type: "closeOverlay" }
	| { type: "start" }
	| { type: "stop" }
	| { type: "togglePause" }
	| { type: "openShare" }
	| { type: "commentIn" }
	| { type: "continue" }
	| { type: "toggleCamera" }
	| { type: "swatch"; index: number }
	| { type: "export" }
	| { type: "toggleEditorPlay" }
	| { type: "jump"; phase: number }
	| { type: "skip" }
	| { type: "replay" }
	| { type: "miss" };

const TOTAL_STEPS = 13;

/** Per-step "you're done" checks; free play can satisfy several at once. */
const STEP_DONE: ((s: DemoState) => boolean)[] = [
	(s) => s.mode === "instant",
	(s) => s.displaySelected,
	(s) => s.r1Started,
	(s) => s.r1Stopped,
	(s) => s.shareVisible,
	(s) => s.shareSeen,
	(s) => s.mode === "studio",
	(s) => s.cameraOn,
	(s) => s.displaySelected,
	(s) => s.r2Started,
	(s) => s.r2Stopped,
	(s) => s.swatched,
	() => false, // export jumps straight to done
];

const advance = (s: DemoState): DemoState => {
	let step = s.step;
	while (step < TOTAL_STEPS && STEP_DONE[step]?.(s)) step++;
	return step === s.step ? s : { ...s, step };
};

const INITIAL: DemoState = {
	step: 0,
	stage: "recorder",
	mode: "studio",
	displaySelected: false,
	cameraOn: false,
	notification: false,
	shareVisible: false,
	comment: false,
	bgIndex: 0,
	paused: false,
	editorPlaying: false,
	r1Started: false,
	r1Stopped: false,
	shareSeen: false,
	r2Started: false,
	r2Stopped: false,
	swatched: false,
	interacted: false,
	nudge: 0,
};

/** Entry states for the phase pills. */
const PHASE_STATES: DemoState[] = [
	INITIAL,
	{
		...INITIAL,
		step: 6,
		mode: "instant",
		r1Started: true,
		r1Stopped: true,
		shareSeen: true,
		interacted: true,
	},
	{
		...INITIAL,
		step: 11,
		stage: "editor",
		mode: "studio",
		cameraOn: true,
		r1Started: true,
		r1Stopped: true,
		shareSeen: true,
		r2Started: true,
		r2Stopped: true,
		editorPlaying: true,
		interacted: true,
	},
];

const miss = (s: DemoState): DemoState => ({
	...s,
	nudge: s.nudge + 1,
	interacted: true,
});

const reducer = (s: DemoState, a: Action): DemoState => {
	switch (a.type) {
		case "mode": {
			if (s.stage !== "recorder" && s.stage !== "overlay") return miss(s);
			if (a.mode === s.mode) return s;
			// Keep the story sound: Instant belongs to the first act, Studio to
			// the second. Early flips get a nudge instead of a broken narrative.
			const allowed = a.mode === "instant" ? s.step < 6 : s.step >= 6;
			if (!allowed) return miss(s);
			return advance({ ...s, mode: a.mode, interacted: true });
		}
		case "display": {
			if (s.stage === "overlay") return s;
			if (s.stage !== "recorder") return miss(s);
			return advance({
				...s,
				displaySelected: true,
				stage: "overlay",
				interacted: true,
			});
		}
		case "closeOverlay": {
			if (s.stage !== "overlay") return s;
			return {
				...s,
				stage: "recorder",
				displaySelected: false,
				step: Math.min(s.step, s.r1Stopped ? 8 : 1),
				interacted: true,
			};
		}
		case "start": {
			if (s.stage !== "overlay") return s;
			if (s.step !== 2 && s.step !== 9) return miss(s);
			const second = s.r1Stopped;
			return advance({
				...s,
				stage: "recording",
				paused: false,
				r1Started: s.r1Started || !second,
				r2Started: s.r2Started || second,
				interacted: true,
			});
		}
		case "stop": {
			if (s.stage !== "recording") return s;
			if (s.mode === "instant") {
				return advance({
					...s,
					stage: "shared",
					notification: true,
					r1Stopped: true,
					displaySelected: false,
					paused: false,
					interacted: true,
				});
			}
			return advance({
				...s,
				stage: "editor",
				r2Stopped: true,
				displaySelected: false,
				paused: false,
				editorPlaying: true,
				interacted: true,
			});
		}
		case "togglePause":
			return s.stage === "recording"
				? { ...s, paused: !s.paused, interacted: true }
				: s;
		case "openShare":
			if (!s.notification) return s;
			return advance({
				...s,
				shareVisible: true,
				notification: false,
				interacted: true,
			});
		case "commentIn":
			return { ...s, comment: true };
		case "continue":
			return advance({
				...s,
				shareSeen: true,
				shareVisible: false,
				comment: false,
				stage: "recorder",
				interacted: true,
			});
		case "toggleCamera": {
			if (s.stage !== "recorder" && s.stage !== "overlay") return miss(s);
			return advance({ ...s, cameraOn: !s.cameraOn, interacted: true });
		}
		case "swatch":
			if (s.stage !== "editor") return s;
			return advance({
				...s,
				bgIndex: a.index,
				swatched: true,
				interacted: true,
			});
		case "export":
			if (s.stage !== "editor") return s;
			return {
				...s,
				stage: "done",
				step: TOTAL_STEPS,
				swatched: true,
				interacted: true,
			};
		case "toggleEditorPlay":
			return s.stage === "editor" || s.stage === "done"
				? { ...s, editorPlaying: !s.editorPlaying, interacted: true }
				: s;
		case "jump":
			return PHASE_STATES[a.phase] ?? INITIAL;
		case "skip":
			return {
				...(PHASE_STATES[2] ?? INITIAL),
				stage: "done",
				step: TOTAL_STEPS,
				swatched: true,
			};
		case "replay":
			return INITIAL;
		case "miss":
			return miss(s);
	}
};

/* -------------------------------------------------------------------- tour -- */

type TourStep = {
	text: string;
	/** Objective target: the spotlight + beacon land on this anchor. */
	anchor?: string;
	/** Spotlight padding around the target, content px. */
	pad?: number;
	/** Skip the dim for free-play moments (recording). */
	dim?: boolean;
	/** Bubble centre, screen-space; parked beside the action, never on it. */
	bx: number;
	by: number;
	/** Steps with no natural click get an explicit continue button. */
	continueLabel?: string;
};

// biome-ignore format: keep one step per line
const TOUR: TourStep[] = [
	{ text: "Select Instant Mode to record and share a video.", anchor: "mode-instant", bx: 640, by: 420 },
	{ text: "Click Display to record the whole screen.", anchor: "target-display", bx: 620, by: 480 },
	{ text: "Click Start Recording.", anchor: "overlay-start", bx: 360, by: 645 },
	{ text: "Cap uploads while you record. Click Stop to finish.", anchor: "toolbar-stop", dim: false, bx: 400, by: 550 },
	{ text: "Cap copies a share link when you stop. Click the notification to open the video.", anchor: "notification", bx: 800, by: 170 },
	{ text: "Viewers can watch, comment, and react in their browser.", anchor: "share-window", pad: 6, bx: 1180, by: 400, continueLabel: "Try Studio Mode" },
	{ text: "Select Studio Mode to edit a recording before sharing it.", anchor: "mode-studio", bx: 640, by: 420 },
	{ text: "Turn on the camera to record yourself alongside your screen.", anchor: "row-camera", bx: 600, by: 645 },
	{ text: "Click Display to select your screen.", anchor: "target-display", bx: 620, by: 480 },
	{ text: "Studio saves the recording on your computer. Click Start Recording.", anchor: "overlay-start", bx: 360, by: 645 },
	{ text: "Click Stop to open your recording in the editor.", anchor: "toolbar-stop", dim: false, bx: 400, by: 550 },
	{ text: "Choose a wallpaper to change the video's background.", anchor: "editor-swatches", bx: 620, by: 620 },
	{ text: "Click Export to finish the demo. In Cap, you can save a video file or share a link.", anchor: "editor-export", bx: 860, by: 230 },
];

/** "i" hotspots: extra info for the curious, separate from the tour. */
type InfoSpot = {
	key: string;
	anchor: string;
	title: string;
	text: string;
	/** Dot position as a fraction of the anchor rect. */
	fx: number;
	fy: number;
	side: "above" | "below" | "left" | "right";
	when: (s: DemoState) => boolean;
};

const onDesktop = (s: DemoState) =>
	s.stage === "recorder" || s.stage === "overlay";

// biome-ignore format: keep one spot per line
const INFO_SPOTS: InfoSpot[] = [
	{ key: "modes", anchor: "mode-info", title: "Recording modes", text: "Use Instant for quick video sharing, Studio for editing recordings, or Screenshot for still images.", fx: 0.5, fy: 0.5, side: "below", when: onDesktop },
	{ key: "mic", anchor: "row-mic", title: "Audio tracks", text: "Studio saves your microphone and system audio separately so you can adjust their volume in the editor.", fx: 1, fy: 0, side: "below", when: onDesktop },
	{ key: "camera", anchor: "camera-window", title: "Camera preview", text: "See your camera while recording. Studio saves it separately so you can adjust its size and position later.", fx: 0.85, fy: 0.1, side: "left", when: (s) => s.cameraOn && (onDesktop(s) || s.stage === "recording") },
	{ key: "tools", anchor: "toolbar-tools", title: "Recording controls", text: "Pause and resume from the toolbar. Try the pause button.", fx: 1, fy: 0, side: "above", when: (s) => s.stage === "recording" },
	{ key: "reactions", anchor: "share-reactions", title: "Comments and reactions", text: "Viewers can leave feedback at a specific point in the video. Click an emoji to add a reaction.", fx: 1, fy: 0.2, side: "above", when: (s) => s.shareVisible },
	{ key: "tracks", anchor: "editor-timeline", title: "Separate tracks", text: "Studio records your screen, camera, and audio separately, so you can edit them after recording.", fx: 0.5, fy: 0.06, side: "below", when: (s) => s.stage === "editor" },
];

/* ---------------------------------------------------------------- captions -- */

type Caption = {
	key: string;
	theme: ModeTheme;
	chip: string;
	Icon: React.ComponentType<{
		className?: string;
		style?: React.CSSProperties;
	}>;
};

const CAPTIONS: [Caption, Caption, Caption] = [
	{
		key: "instant",
		theme: MODE_THEME.instant,
		chip: "Instant Mode",
		Icon: CapInstant,
	},
	{
		key: "studio",
		theme: MODE_THEME.studio,
		chip: "Studio Mode",
		Icon: CapFilmCut,
	},
	{
		key: "editor",
		theme: MODE_THEME.share,
		chip: "The Editor",
		Icon: CapClapperboard,
	},
];

const phaseOf = (step: number) => (step >= 11 ? 2 : step >= 6 ? 1 : 0);

/** Where each phase starts, for the progress bar's chapter ticks. */
const PHASE_TICKS = [6 / TOTAL_STEPS, 11 / TOTAL_STEPS];

type Mark = { x: number; y: number; w: number; h: number };

/* --------------------------------------------------------------- component -- */

export const DesktopDemo = ({
	startRequested = false,
}: {
	startRequested?: boolean;
}) => {
	const frameBoxRef = useRef<HTMLDivElement | null>(null);
	const inView = useInView(frameBoxRef, "0px");
	const pageVisible = usePageVisible();
	const active = inView && pageVisible;
	const screenRef = useRef<HTMLDivElement | null>(null);
	const timerRef = useRef<HTMLSpanElement | null>(null);
	const contentScrollRef = useRef<HTMLDivElement | null>(null);
	const editorTimeRef = useRef<HTMLSpanElement | null>(null);
	const playheadRef = useRef<HTMLDivElement | null>(null);
	const cameraVideoRef = useRef<HTMLVideoElement | null>(null);
	const shareVideoRef = useRef<HTMLVideoElement | null>(null);
	const editorVideoRef = useRef<HTMLVideoElement | null>(null);
	const editorCamRef = useRef<HTMLVideoElement | null>(null);
	const typedRef = useRef<HTMLSpanElement | null>(null);
	const clockRef = useRef({ accum: 0, last: 0 });
	const playOffsetRef = useRef(0);
	const marksSigRef = useRef("");

	/** Null until the first fit: the laptop stays invisible so it can't paint
	    at a guessed size and visibly re-scale once measured. */
	const [scale, setScale] = useState<number | null>(null);
	const [state, dispatch] = useReducer(reducer, INITIAL);
	const [marks, setMarks] = useState<Record<string, Mark>>({});
	const [openSpot, setOpenSpot] = useState<string | null>(null);
	/** Attract mode: the tour only begins once the visitor opts in. */
	const [idle, setIdle] = useState(true);

	/** The demo dresses as the visitor's own OS. Everything but Windows (and
	    the first paint, before detection resolves) gets the macOS shell, the
	    same default the download button uses. Clicking the Apple glyph in the
	    menu bar (or Start on the taskbar) switches shells by hand, which is
	    how anyone sees the other platform. */
	const { platform } = useDetectPlatform();
	const [osOverride, setOsOverride] = useState<DemoPlatform | null>(null);
	const demoPlatform: DemoPlatform =
		osOverride ?? (platform === "windows" ? "windows" : "macos");
	const isWindows = demoPlatform === "windows";
	const switchOs = useCallback(
		() => setOsOverride(isWindows ? "macos" : "windows"),
		[isWindows],
	);

	const startDemo = useCallback(() => setIdle(false), []);
	useEffect(() => {
		if (startRequested) setIdle(false);
	}, [startRequested]);

	/* The hero's "See how Cap works" hands the visitor straight into the tour. */
	useEffect(() => {
		const onStart = () => setIdle(false);
		window.addEventListener("ht-demo-start", onStart);
		return () => window.removeEventListener("ht-demo-start", onStart);
	}, []);

	const send = useCallback((action: Action) => {
		setOpenSpot(null);
		dispatch(action);
	}, []);
	const chooseWallpaper = useCallback(
		(index: number) => send({ type: "swatch", index }),
		[send],
	);
	const exportRecording = useCallback(() => send({ type: "export" }), [send]);
	const toggleEditorPlayback = useCallback(
		() => send({ type: "toggleEditorPlay" }),
		[send],
	);

	/* Fit the laptop into the space above the controls strip. Layout effect,
	   so the very first paint already uses the measured scale. */
	useLayoutEffect(() => {
		const box = frameBoxRef.current;
		if (!box) return;
		const fitLaptop = () => {
			const r = box.getBoundingClientRect();
			// Slightly undersized (×0.95, capped): the laptop should read as an
			// object on the page, not a takeover, but without leaving a dead band
			// between it and the hero above.
			setScale(
				Math.min(
					0.82,
					0.95 * Math.min(r.width / LAPTOP.w, r.height / LAPTOP.h),
				),
			);
		};
		fitLaptop();
		const ro = new ResizeObserver(fitLaptop);
		ro.observe(box);
		return () => ro.disconnect();
	}, []);

	/* Resolve the anchors the current state cares about (the objective + the
	   visible info spots) into screen-space rects. Re-measured a few times
	   after every state change so entrance transitions settle. */
	const stepDef = state.step < TOTAL_STEPS ? TOUR[state.step] : undefined;
	const visibleSpots = useMemo(
		() => INFO_SPOTS.filter((spot) => spot.when(state)),
		[state],
	);

	// biome-ignore lint/correctness/useExhaustiveDependencies: scale/idle/demoPlatform re-trigger measurement after the laptop refits, the recorder slides home, or the shell swaps
	useEffect(() => {
		const wanted = [
			...(stepDef?.anchor ? [stepDef.anchor] : []),
			...visibleSpots.map((spot) => spot.anchor),
		];
		const measure = () => {
			const screen = screenRef.current;
			if (!screen) return;
			const rect = screen.getBoundingClientRect();
			if (rect.width < 10) return;
			const s = rect.width / LAPTOP.screenW;
			const next: Record<string, Mark> = {};
			for (const anchor of wanted) {
				const el = screen.querySelector<HTMLElement>(
					`[data-demo-anchor="${anchor}"]`,
				);
				if (!el) continue;
				const r = el.getBoundingClientRect();
				next[anchor] = {
					x: (r.left - rect.left) / s,
					y: (r.top - rect.top) / s,
					w: r.width / s,
					h: r.height / s,
				};
			}
			const sig = JSON.stringify(next);
			if (sig !== marksSigRef.current) {
				marksSigRef.current = sig;
				setMarks(next);
			}
		};
		measure();
		if (idle) return;
		const t1 = setTimeout(measure, 300);
		const t2 = setTimeout(measure, 700);
		return () => {
			clearTimeout(t1);
			clearTimeout(t2);
		};
	}, [stepDef, visibleSpots, scale, idle, demoPlatform]);

	/* Press record and it is recording: no 3-2-1. Every fresh take starts from
	   a zeroed clock with the recorded window scrolled back to the top. Keyed
	   on the stage alone, so pause and resume never reset it. */
	useEffect(() => {
		if (state.stage !== "recording") return;
		clockRef.current = { accum: 0, last: 0 };
		if (timerRef.current) timerRef.current.textContent = "0:00";
		if (contentScrollRef.current)
			contentScrollRef.current.style.transform = "translate3d(0, 0, 0)";
	}, [state.stage]);

	/* The recording clock: real elapsed time in the toolbar, and the recorded
	   window slowly "does some work" underneath. */
	useEffect(() => {
		if (state.stage !== "recording" || state.paused) return;
		clockRef.current.last = performance.now();
		return () => {
			const c = clockRef.current;
			c.accum += performance.now() - c.last;
			c.last = 0;
		};
	}, [state.stage, state.paused]);

	useEffect(() => {
		if (state.stage !== "recording" || !active) return;
		const paint = () => {
			const c = clockRef.current;
			const elapsed = c.accum + (state.paused ? 0 : performance.now() - c.last);
			const secs = elapsed / 1000;
			const text = formatClock(secs);
			if (timerRef.current && timerRef.current.textContent !== text)
				timerRef.current.textContent = text;
			if (contentScrollRef.current)
				contentScrollRef.current.style.transform = `translate3d(0, ${-Math.min(
					240,
					secs * 14,
				)}px, 0)`;
		};
		paint();
		if (state.paused) return;
		const id = setInterval(paint, 200);
		return () => clearInterval(id);
	}, [state.stage, state.paused, active]);

	const restartClock = useCallback(() => {
		clockRef.current = { accum: 0, last: performance.now() };
		if (timerRef.current) timerRef.current.textContent = "0:00";
	}, []);

	/* Sofia's comment lands a beat after the share page opens. */
	useEffect(() => {
		if (!state.shareVisible) return;
		const id = setTimeout(() => dispatch({ type: "commentIn" }), 1400);
		return () => clearTimeout(id);
	}, [state.shareVisible]);

	/* Editor playback: playhead + timecode loop while playing. */
	useEffect(() => {
		const playing =
			(state.stage === "editor" || state.stage === "done") &&
			state.editorPlaying &&
			active;
		if (!playing) return;
		let raf = 0;
		const t0 = performance.now();
		const offset = playOffsetRef.current;
		const loop = (ts: number) => {
			const frac = (((ts - t0) / 1000 + offset) % 20) / 20;
			if (playheadRef.current)
				playheadRef.current.style.transform = `translate3d(${frac * 720}px, 0, 0)`;
			if (editorTimeRef.current) {
				const secs = frac * 19;
				const frames = Math.floor((secs % 1) * 30);
				const text = `${formatClock(secs)}.${String(frames).padStart(2, "0")}`;
				if (editorTimeRef.current.textContent !== text)
					editorTimeRef.current.textContent = text;
			}
			raf = requestAnimationFrame(loop);
		};
		raf = requestAnimationFrame(loop);
		return () => {
			playOffsetRef.current = ((performance.now() - t0) / 1000 + offset) % 20;
			cancelAnimationFrame(raf);
		};
	}, [state.stage, state.editorPlaying, active]);

	/* Type the guide text in on every step change (and on nudges, which
	   re-pop the card). */
	// biome-ignore lint/correctness/useExhaustiveDependencies: a nudge remounts the keyed card, so the typed node must refill
	useEffect(() => {
		if (idle) return;
		const text = TOUR[state.step]?.text;
		const typed = typedRef.current;
		if (!text || !typed) return;
		let i = 0;
		typed.textContent = "▍";
		const id = setInterval(() => {
			i += 2;
			if (i >= text.length) {
				typed.textContent = text;
				clearInterval(id);
			} else {
				typed.textContent = `${text.slice(0, i)}▍`;
			}
		}, 16);
		return () => clearInterval(id);
	}, [state.step, state.nudge, idle]);

	/* Videos follow the discrete state. */
	const cameraWindowVisible =
		state.cameraOn && (onDesktop(state) || state.stage === "recording");
	const editorVisible = state.stage === "editor" || state.stage === "done";
	const editorUi = useMemo<EditorUi>(
		() => ({
			visible: editorVisible,
			bgIndex: state.bgIndex,
			playing: state.editorPlaying,
		}),
		[editorVisible, state.bgIndex, state.editorPlaying],
	);
	useEffect(() => {
		const sync = (video: HTMLVideoElement | null, shouldPlay: boolean) => {
			if (!video) return;
			if (shouldPlay && active) {
				if (video.paused) video.play().catch(() => {});
			} else if (!video.paused) {
				video.pause();
			}
		};
		sync(cameraVideoRef.current, cameraWindowVisible);
		sync(shareVideoRef.current, state.shareVisible);
		sync(editorVideoRef.current, editorUi.visible && editorUi.playing);
		sync(editorCamRef.current, editorUi.visible && editorUi.playing);
	}, [
		cameraWindowVisible,
		state.shareVisible,
		editorUi.visible,
		editorUi.playing,
		active,
	]);

	/* Derived scene. */
	const recorderUi: RecorderUi = {
		visible: onDesktop(state),
		mode: state.mode,
		displaySelected: state.displaySelected,
		cameraOn: state.cameraOn,
	};
	const overlayVisible = state.stage === "overlay";
	const toolbarVisible = state.stage === "recording";
	const phase = phaseOf(state.step);
	const caption = CAPTIONS[phase];

	/* Spotlight + beacon geometry for the current objective. */
	const objectiveMark = stepDef?.anchor ? marks[stepDef.anchor] : undefined;
	const pad = stepDef?.pad ?? 10;
	const dimmed = Boolean(
		!idle &&
			objectiveMark &&
			stepDef &&
			stepDef.dim !== false &&
			state.stage !== "done",
	);
	/* The notification step is the one place the two shells disagree on where
	   the action happens, so its bubble follows the toast to the bottom. */
	const notificationStep = stepDef?.anchor === "notification";
	const bubbleX = isWindows && notificationStep ? 700 : (stepDef?.bx ?? 0);
	const bubbleY = isWindows && notificationStep ? 620 : (stepDef?.by ?? 0);

	const beaconVisible = Boolean(
		!idle &&
			objectiveMark &&
			stepDef &&
			!stepDef.continueLabel &&
			state.stage !== "done",
	);

	/* Until measured, lay out at a placeholder scale behind opacity 0. */
	const fitScale = scale ?? 0.6;
	const laptopStyle = useMemo<React.CSSProperties>(
		() => ({ width: LAPTOP.w * fitScale, height: LAPTOP.h * fitScale }),
		[fitScale],
	);
	const laptopInnerStyle = useMemo<React.CSSProperties>(
		() => ({
			width: LAPTOP.w,
			height: LAPTOP.h,
			transform: `scale(${fitScale})`,
			transformOrigin: "top left",
			fontFamily:
				"var(--font-ht-geist), 'Geist Sans', -apple-system, system-ui, sans-serif",
		}),
		[fitScale],
	);

	return (
		<DemoPlatformProvider value={demoPlatform}>
			<div
				data-demo-active={active}
				className="ht-interactive-demo relative flex h-[100svh] max-h-[860px] min-h-[660px] flex-col items-center px-5 pb-4 pt-6 lg:px-8"
			>
				<style>{`
				@keyframes ht-caption-in {
					from { opacity: 0; transform: translateY(8px); }
					to { opacity: 1; transform: translateY(0); }
				}
				@keyframes ht-demo-wiggle {
					0%, 100% { translate: 0 0; }
					25% { translate: -5px 0; }
					55% { translate: 4px 0; }
					80% { translate: -2px 0; }
				}
				@keyframes ht-demo-mic {
					0% { transform: translateX(-70%); }
					15% { transform: translateX(-42%); }
					30% { transform: translateX(-60%); }
					45% { transform: translateX(-30%); }
					60% { transform: translateX(-55%); }
					75% { transform: translateX(-38%); }
					100% { transform: translateX(-70%); }
				}
				.ht-demo-mic-meter { animation: ht-demo-mic 1.6s ease-in-out infinite; }
				.ht-interactive-demo[data-demo-active="false"] .ht-demo-mic-meter,
				.ht-interactive-demo[data-demo-active="false"] .ht-demo-loop {
					animation-play-state: paused;
				}
				@keyframes ht-demo-pulse {
					0% { box-shadow: 0 0 0 0 rgba(0,144,255,0.55); }
					70%, 100% { box-shadow: 0 0 0 12px rgba(0,144,255,0); }
				}
				@keyframes ht-cursor-drift {
					0%, 100% { transform: translate3d(0, 0, 0); }
					50% { transform: translate3d(-14px, -10px, 0); }
				}
			`}</style>

				{/* Laptop */}
				<div
					ref={frameBoxRef}
					className="relative flex min-h-0 w-full flex-1 items-center justify-center"
				>
					{/* Phase-coloured glow grounding the laptop on the band. */}
					<div
						aria-hidden="true"
						className={classNames(
							"absolute left-1/2 top-1/2 h-[58%] w-[62%] -translate-x-1/2 -translate-y-1/2 rounded-full blur-3xl transition-[background-color,opacity] duration-700",
							scale === null ? "opacity-0" : "opacity-[0.55]",
						)}
						style={{ background: caption.theme.pill }}
					/>

					<div
						className={classNames(
							"relative transition-opacity duration-500",
							scale === null ? "opacity-0" : "opacity-100",
						)}
						style={laptopStyle}
					>
						<div style={laptopInnerStyle}>
							{/* Lid / bezel */}
							<div
								aria-hidden="true"
								className="absolute"
								style={{
									left: LAPTOP.bodyX,
									top: 0,
									width: LAPTOP.bodyW,
									height: LAPTOP.bodyH,
									borderRadius: 30,
									background: "linear-gradient(180deg, #2b2d33 0%, #101114 8%)",
									boxShadow:
										"inset 0 0 0 1px rgba(255,255,255,0.09), 0 40px 90px -30px rgba(17,17,17,0.45), 0 12px 30px -12px rgba(17,17,17,0.3)",
								}}
							/>

							{/* Screen */}
							<div
								ref={screenRef}
								className="absolute overflow-hidden"
								style={{
									left: LAPTOP.screenX,
									top: LAPTOP.screenY,
									width: LAPTOP.screenW,
									height: LAPTOP.screenH,
									borderRadius: 14,
									background: "#000",
								}}
							>
								{/* Wallpaper: one of the city paintings Cap Desktop ships. */}
								<Image
									src="/backgrounds/sf.webp"
									alt=""
									fill
									sizes="1360px"
									draggable={false}
									className="object-cover"
								/>

								{/* Desktop chrome */}
								{isWindows ? (
									<>
										<WinDesktopFiles />
										<WinTaskbar
											recording={state.stage === "recording"}
											onSwitchOs={switchOs}
										/>
									</>
								) : (
									<>
										<MenuBar
											recording={state.stage === "recording"}
											onSwitchOs={switchOs}
										/>
										<DesktopFiles />
										<Dock />
									</>
								)}

								{/* Target-select highlight around "the screen" */}
								<div
									className={classNames(
										"pointer-events-none absolute inset-0 z-20 rounded-[14px] transition-opacity duration-300",
										overlayVisible ? "opacity-100" : "opacity-0",
									)}
									style={{
										boxShadow:
											"inset 0 0 0 3px rgba(5,136,240,0.9), inset 0 0 80px rgba(5,136,240,0.18)",
										background: "rgba(17,24,39,0.10)",
									}}
								/>

								{/* Windows layer, below the menu bar. */}
								<div
									inert={idle || state.stage === "done"}
									className="absolute left-0 top-7"
									style={{ width: STAGE_W, height: LAPTOP.screenH - 28 }}
								>
									<div
										className={classNames(
											"absolute transition-opacity duration-500",
											idle ? "opacity-0" : "opacity-100",
										)}
										style={{ left: POS.content.left, top: POS.content.top }}
									>
										<MemoizedContentWindow
											width={POS.content.width}
											height={POS.content.height}
											scrollRef={contentScrollRef}
										/>
									</div>

									<div
										className="absolute"
										style={{ left: POS.share.left, top: POS.share.top }}
									>
										<MemoizedShareWindow
											visible={state.shareVisible}
											width={POS.share.width}
											height={POS.share.height}
											commentVisible={state.comment}
											videoRef={shareVideoRef}
										/>
									</div>

									<div
										className="absolute transition-[left,top] duration-500 ease-[cubic-bezier(0.4,0,0.2,1)]"
										style={idle ? IDLE_RECORDER : POS.recorder}
									>
										<CapRecorderWindow
											ui={recorderUi}
											onMode={(mode) => send({ type: "mode", mode })}
											onSelectDisplay={() => send({ type: "display" })}
											onToggleCamera={() => send({ type: "toggleCamera" })}
											onMiss={() => send({ type: "miss" })}
										/>
									</div>

									<div
										className="absolute"
										style={{ left: POS.camera.left, top: POS.camera.top }}
									>
										<CameraWindow
											visible={cameraWindowVisible}
											videoRef={cameraVideoRef}
										/>
									</div>

									<div
										className="absolute z-10"
										style={{ left: POS.editor.left, top: POS.editor.top }}
									>
										<MemoizedEditorWindow
											ui={editorUi}
											width={POS.editor.width}
											height={POS.editor.height}
											videoRef={editorVideoRef}
											camVideoRef={editorCamRef}
											playheadRef={playheadRef}
											timeRef={editorTimeRef}
											onSwatch={chooseWallpaper}
											onExport={exportRecording}
											onTogglePlay={toggleEditorPlayback}
										/>
									</div>

									<div
										className="absolute z-20"
										style={{ left: POS.overlay.left, top: POS.overlay.top }}
									>
										<TargetOverlayPanel
											visible={overlayVisible}
											mode={state.mode}
											cameraOn={state.cameraOn}
											onStart={() => send({ type: "start" })}
											onClose={() => send({ type: "closeOverlay" })}
										/>
									</div>

									<div
										className="absolute z-20"
										style={{ left: POS.toolbar.left, top: POS.toolbar.top }}
									>
										<RecordingToolbar
											visible={toolbarVisible}
											paused={state.paused}
											timerRef={timerRef}
											onStop={() => send({ type: "stop" })}
											onTogglePause={() => send({ type: "togglePause" })}
											onRestart={restartClock}
											onMiss={() => send({ type: "miss" })}
										/>
									</div>

									<div
										className="absolute z-30"
										style={{
											left: POS.notification.left,
											top: isWindows
												? WIN_NOTIFICATION_TOP
												: POS.notification.top,
										}}
									>
										<LinkNotification
											visible={state.notification}
											onOpen={() => send({ type: "openShare" })}
										/>
									</div>
								</div>

								{/* Spotlight: a soft dim with a bright cutout gliding to the
							    next objective. Pointer-events-free, so it guides without
							    locking anything. */}
								<div
									aria-hidden="true"
									className="pointer-events-none absolute left-0 top-0 z-30 rounded-[14px] transition-[transform,width,height,box-shadow] duration-500 ease-[cubic-bezier(0.4,0,0.2,1)]"
									style={{
										transform: `translate3d(${(objectiveMark?.x ?? 0) - pad}px, ${
											(objectiveMark?.y ?? 0) - pad
										}px, 0)`,
										width: (objectiveMark?.w ?? LAPTOP.screenW) + pad * 2,
										height: (objectiveMark?.h ?? LAPTOP.screenH) + pad * 2,
										boxShadow: dimmed
											? "0 0 24px 9999px rgba(9,12,20,0.5)"
											: "0 0 24px 9999px rgba(9,12,20,0)",
									}}
								/>

								{/* Beacon: a pulsing ring hugging the objective's edge, so the
							    control itself stays fully visible. */}
								{beaconVisible && objectiveMark ? (
									<div
										aria-hidden="true"
										className="ht-demo-loop pointer-events-none absolute left-0 top-0 z-[35] border-2 border-[#0090ff] transition-[transform,width,height] duration-500 ease-[cubic-bezier(0.4,0,0.2,1)] [animation:ht-demo-pulse_1.8s_ease-out_infinite]"
										style={{
											transform: `translate3d(${objectiveMark.x - 5}px, ${
												objectiveMark.y - 5
											}px, 0)`,
											width: objectiveMark.w + 10,
											height: objectiveMark.h + 10,
											borderRadius: Math.min(
												18,
												(Math.min(objectiveMark.w, objectiveMark.h) + 10) / 2,
											),
										}}
									/>
								) : null}

								{/* "i" hotspots: more info, on demand. */}
								{idle
									? null
									: visibleSpots.map((spot) => {
											const mark = marks[spot.anchor];
											if (!mark) return null;
											const x = mark.x + mark.w * spot.fx;
											const y = mark.y + mark.h * spot.fy;
											const open = openSpot === spot.key;
											return (
												<div
													key={spot.key}
													className="absolute z-[35]"
													style={{ left: x, top: y }}
												>
													<button
														type="button"
														aria-label={`About: ${spot.title}`}
														aria-expanded={open}
														onClick={() =>
															setOpenSpot((prev) =>
																prev === spot.key ? null : spot.key,
															)
														}
														className={classNames(
															"absolute -left-[11px] -top-[11px] flex size-[22px] cursor-pointer items-center justify-center rounded-full text-[12px] font-semibold italic shadow-[0_2px_10px_rgba(17,17,17,0.35)] transition-transform duration-150 hover:scale-110",
															open
																? "bg-[#111111] text-white"
																: "bg-white text-[#111111]",
														)}
														style={{
															border: "1.5px solid rgba(17,17,17,0.35)",
															fontFamily: "Georgia, serif",
														}}
													>
														i
													</button>
													{open ? (
														<div
															className="absolute w-[240px] animate-[ht-caption-in_200ms_ease-out] rounded-xl px-3.5 py-3 shadow-[0_16px_40px_-8px_rgba(17,17,17,0.5)]"
															style={{
																background: "#202020",
																color: "#fcfcfc",
																...(spot.side === "below" && {
																	left: -120,
																	top: 20,
																}),
																...(spot.side === "above" && {
																	left: -120,
																	bottom: 20,
																}),
																...(spot.side === "left" && {
																	right: 20,
																	top: -12,
																}),
																...(spot.side === "right" && {
																	left: 20,
																	top: -12,
																}),
															}}
														>
															<p className="text-[13px] font-semibold">
																{spot.title}
															</p>
															<p className="mt-1 text-[12px] leading-snug text-[rgba(255,255,255,0.75)]">
																{spot.text}
															</p>
														</div>
													) : null}
												</div>
											);
										})}

								{/* The guide bubble: numbered, typed-in, parked beside the
							    action. Wrong-turn clicks re-pop it with a wiggle. */}
								{!idle && stepDef && state.stage !== "done" ? (
									<div
										className="absolute left-0 top-0 z-40 transition-transform duration-500 ease-[cubic-bezier(0.4,0,0.2,1)]"
										style={{
											transform: `translate3d(${clamp(bubbleX, 200, 1160)}px, ${clamp(
												bubbleY,
												80,
												780,
											)}px, 0)`,
										}}
									>
										<div className="-translate-x-1/2 -translate-y-1/2">
											<div
												key={`${state.step}:${state.nudge}`}
												className={classNames(
													"relative w-max max-w-[330px] rounded-[16px] px-4 pb-3.5 pt-5 shadow-[0_20px_50px_-12px_rgba(17,17,17,0.55)]",
													state.nudge > 0
														? "animate-[ht-caption-in_300ms_ease-out,ht-demo-wiggle_400ms_ease-out]"
														: "animate-[ht-caption-in_300ms_ease-out]",
												)}
												style={{
													...grainBg(CARD_BG),
													fontFamily:
														"var(--font-ht-sans), ui-sans-serif, system-ui, sans-serif",
												}}
											>
												{/* Mode attachment */}
												<span
													className="absolute -top-3.5 left-4 flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[12px] font-semibold shadow-[0_2px_8px_rgba(17,17,17,0.18)]"
													style={{
														background: caption.theme.chip,
														color: caption.theme.glyph,
													}}
												>
													<caption.Icon className="h-3 w-auto" />
													{caption.chip}
												</span>
												<div className="flex items-start gap-3">
													<span
														className="flex size-8 shrink-0 items-center justify-center rounded-full text-[15px] font-semibold text-[#111111]"
														style={{ background: caption.theme.pill }}
													>
														{state.step + 1}
													</span>
													<div className="min-w-0">
														<p className="relative mt-1 text-[19px] font-medium leading-snug tracking-[-0.01em] text-[#111111]">
															<span className="invisible">{stepDef.text}</span>
															<span
																ref={typedRef}
																className="absolute inset-0"
																aria-hidden="true"
															/>
															<span className="sr-only">{stepDef.text}</span>
														</p>
														{stepDef.continueLabel ? (
															<button
																type="button"
																onClick={() => send({ type: "continue" })}
																className="mt-3 flex h-9 cursor-pointer items-center gap-1.5 rounded-full bg-[#111111] px-4 text-[14px] font-medium text-white transition-colors duration-150 hover:bg-[#2b2b2b]"
															>
																{stepDef.continueLabel}
																<span aria-hidden="true">→</span>
															</button>
														) : null}
													</div>
												</div>
											</div>
										</div>
									</div>
								) : null}

								{/* Idle state: an oversized cursor resting on the app, so the
							    screen reads as clickable before the tour chrome exists. */}
								<div
									aria-hidden="true"
									className={classNames(
										"pointer-events-none absolute z-[45] transition-opacity duration-500",
										idle ? "opacity-100" : "opacity-0",
									)}
									style={{ left: 792, top: 468 }}
								>
									<PlatformCursor
										platform={demoPlatform}
										className="ht-demo-loop w-[62px] drop-shadow-[0_10px_18px_rgba(17,17,17,0.35)] [animation:ht-cursor-drift_5s_ease-in-out_infinite]"
									/>
								</div>

								{/* Restart, parked bottom-left of the screen once the tour runs. */}
								<button
									type="button"
									inert={idle}
									onClick={() => send({ type: "replay" })}
									className={classNames(
										"absolute bottom-4 left-4 z-[45] flex h-[44px] cursor-pointer items-center gap-2 rounded-full bg-black/55 px-5 text-[17px] font-medium text-white backdrop-blur-md transition-[opacity,background-color] duration-300 hover:bg-black/75 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70",
										idle ? "pointer-events-none opacity-0" : "opacity-100",
									)}
								>
									<RotateCcw className="size-[16px]" />
									Restart demo
								</button>

								{/* Idle hover overlay: dim the screen and offer the two ways
								    in. It stops short of the OS bar so the Apple glyph (or
								    Start) can still switch shells before the tour begins. */}
								{idle ? (
									<div
										className={classNames(
											"group absolute inset-x-0 z-[65]",
											isWindows ? "bottom-12 top-0" : "bottom-0 top-7",
										)}
									>
										<button
											type="button"
											aria-label="Start the interactive demo"
											onClick={startDemo}
											className="absolute inset-0 h-full w-full cursor-pointer bg-[rgba(9,12,20,0)] transition-colors duration-300 group-focus-within:bg-[rgba(9,12,20,0.55)] group-hover:bg-[rgba(9,12,20,0.55)]"
										/>
										<div className="pointer-events-none absolute inset-0 flex translate-y-3 flex-col items-center justify-center gap-5 opacity-0 transition-all duration-300 group-focus-within:translate-y-0 group-focus-within:opacity-100 group-hover:translate-y-0 group-hover:opacity-100">
											<button
												type="button"
												onClick={startDemo}
												className="pointer-events-auto flex h-[76px] cursor-pointer items-center gap-3.5 rounded-full bg-white px-12 text-[26px] font-medium text-[#111111] shadow-[0_28px_70px_-18px_rgba(9,12,20,0.65)] transition-transform duration-200 hover:scale-[1.04] focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-[#0090ff]"
											>
												<MousePointerClick className="size-[26px]" />
												Start interactive demo
											</button>
											<button
												type="button"
												onClick={(event) => {
													event.stopPropagation();
													document
														.getElementById("workflow")
														?.scrollIntoView({ behavior: "smooth" });
												}}
												className="pointer-events-auto flex h-[56px] cursor-pointer items-center gap-2 rounded-full border border-white/40 bg-black/30 px-9 text-[20px] font-medium text-white backdrop-blur-md transition-colors duration-200 hover:bg-black/50 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-white/70"
											>
												Learn more
												<span aria-hidden="true">↓</span>
											</button>
										</div>
									</div>
								) : null}

								{/* Finish card. */}
								{state.stage === "done" ? (
									<div className="absolute inset-0 z-50 flex items-center justify-center bg-[rgba(9,12,20,0.5)]">
										<div
											className="w-[520px] animate-[ht-caption-in_300ms_ease-out] rounded-[20px] px-10 pb-9 pt-10 text-center shadow-[0_30px_80px_-20px_rgba(17,17,17,0.6)]"
											style={{
												...grainBg(CARD_BG),
												fontFamily:
													"var(--font-ht-sans), ui-sans-serif, system-ui, sans-serif",
											}}
										>
											<span
												className="mx-auto flex w-fit items-center gap-1.5 rounded-full px-3 py-1.5 text-[13px] font-semibold"
												style={{
													background: caption.theme.chip,
													color: caption.theme.glyph,
												}}
											>
												<CapClapperboard className="h-3.5 w-auto" />
												Demo complete
											</span>
											<h3 className="mt-5 text-[40px] font-normal leading-[1.04] tracking-[-0.03em] text-[#111111]">
												Try Cap for yourself
											</h3>
											<p className="mx-auto mt-3 max-w-[380px] text-[16px] leading-normal text-[rgba(17,17,17,0.7)]">
												Download Cap for macOS or Windows to record, edit, and
												share your screen.
											</p>
											<div className="mt-7 flex items-center justify-center gap-3">
												<Link href="/download" className={BTN_PRIMARY}>
													Download Cap free
												</Link>
												<button
													type="button"
													onClick={() => send({ type: "replay" })}
													className={classNames(
														BTN_SECONDARY,
														"cursor-pointer",
													)}
												>
													Replay the demo
												</button>
											</div>
										</div>
									</div>
								) : null}

								{/* Camera notch: a MacBook tell, so the Windows shell gets a
								    plain lid instead. */}
								{isWindows ? null : (
									<div className="pointer-events-none absolute left-1/2 top-0 z-[60] h-[24px] w-[196px] -translate-x-1/2 rounded-b-[10px] bg-black" />
								)}
							</div>

							{/* Base / deck */}
							<div
								aria-hidden="true"
								className="absolute"
								style={{
									left: 0,
									top: LAPTOP.baseY,
									width: LAPTOP.w,
									height: LAPTOP.baseH,
									borderRadius: "0 0 18px 18px",
									background:
										"linear-gradient(180deg, #eceef2 0%, #cdd1d8 45%, #9aa0aa 100%)",
									boxShadow:
										"inset 0 1px 0 rgba(255,255,255,0.85), 0 18px 40px -18px rgba(17,17,17,0.5)",
								}}
							>
								{/* Thumb groove */}
								<div
									className="absolute left-1/2 top-0 h-[10px] w-[220px] -translate-x-1/2 rounded-b-[12px]"
									style={{
										background:
											"linear-gradient(180deg, #aab0b9 0%, #d5d9df 100%)",
									}}
								/>
							</div>
						</div>
					</div>
				</div>

				{/* Controls: phase pills, tour progress, skip. Hidden until the tour starts. */}
				<div
					inert={idle}
					className={classNames(
						"relative z-10 mt-3 flex flex-wrap items-center justify-center gap-x-4 gap-y-2 transition-opacity duration-500",
						idle ? "pointer-events-none opacity-0" : "opacity-100",
					)}
				>
					<div className="flex items-center gap-1">
						{CAPTIONS.map((c, i) => (
							<button
								key={c.key}
								type="button"
								onClick={() => send({ type: "jump", phase: i })}
								aria-label={`Jump to ${c.chip}`}
								aria-current={i === phase ? "true" : undefined}
								className={classNames(
									"flex h-9 cursor-pointer items-center gap-1.5 rounded-full px-3 text-[13px] font-medium transition-colors duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#111111]",
									i === phase
										? "text-[#111111]"
										: "text-[rgba(17,17,17,0.45)] hover:bg-[#EDF1F6] hover:text-[#111111]",
								)}
								style={i === phase ? { background: c.theme.pill } : undefined}
							>
								<c.Icon className="h-3 w-auto" />
								{c.chip}
							</button>
						))}
					</div>
					<div
						className="relative h-1.5 w-48 overflow-hidden rounded-full"
						style={{ background: "rgba(17,17,17,0.12)" }}
						aria-hidden="true"
					>
						<div
							className="absolute inset-y-0 left-0 rounded-full transition-[width] duration-500"
							style={{
								background: "#111111",
								width: `${(Math.min(state.step, TOTAL_STEPS) / TOTAL_STEPS) * 100}%`,
							}}
						/>
						{PHASE_TICKS.map((t) => (
							<span
								key={t}
								className="absolute inset-y-0 w-[3px] bg-[#F8FAFC]"
								style={{ left: `${t * 100}%` }}
							/>
						))}
					</div>
					<span className="text-[12px] font-medium tabular-nums text-[rgba(17,17,17,0.45)]">
						{Math.min(state.step + 1, TOTAL_STEPS)} / {TOTAL_STEPS}
					</span>
					<button
						type="button"
						onClick={() => send({ type: "skip" })}
						className="flex h-8 cursor-pointer items-center gap-1 rounded-full px-2.5 text-[13px] font-medium text-[rgba(17,17,17,0.45)] transition-colors duration-200 hover:bg-[#EDF1F6] hover:text-[#111111] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#111111]"
					>
						Skip demo
					</button>
				</div>
			</div>
		</DemoPlatformProvider>
	);
};
