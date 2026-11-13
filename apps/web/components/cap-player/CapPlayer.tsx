"use client";

import {
	type CSSProperties,
	type KeyboardEvent as ReactKeyboardEvent,
	type ReactNode,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import styles from "./player.module.css";
import {
	type Attachment,
	AUTO_LEVEL,
	attachSource,
	type CapPlayerLevel,
	type CapPlayerSource,
	resolutionLabel,
} from "./source";

export { resolutionLabel } from "./source";

export type CapPlayerControl =
	| "volume"
	| "time"
	| "speed"
	| "quality"
	| "pip"
	| "fullscreen";

export interface CapPlayerProps {
	source: CapPlayerSource;
	title: string;
	poster?: string;
	aspectRatio?: string;
	autoPlay?: boolean;
	muted?: boolean;
	loop?: boolean;
	controls?: boolean;
	startAt?: number;
	focusOnMount?: boolean;
	accentColor?: string;
	hideControls?: readonly CapPlayerControl[];
	speeds?: readonly number[];
	className?: string;
	style?: CSSProperties;
	onFirstPlay?: () => void;
	onEnded?: () => void;
	onQualityChange?: (quality: { auto: boolean; label: string }) => void;
}

const IDLE_AFTER_MS = 2200;
const SEEK_STEP_SECONDS = 5;
const SEEK_JUMP_SECONDS = 10;
const VOLUME_STEP = 0.05;
const VOLUME_KEY = "cap-player-volume";
const DEFAULT_SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2] as const;
const MENU_CLEARANCE = 64;
const MENU_MIN_HEIGHT = 76;
const HOVER_INTENT_MS = 100;
const PLAYS = '[data-action="toggle"], [data-action="surface"]';
const NO_CONTROLS: readonly CapPlayerControl[] = [];

type MenuName = "speed" | "quality";

export const clock = (seconds: number) => {
	const whole = Math.max(0, Math.floor(seconds));
	const hours = Math.floor(whole / 3600);
	const minutes = Math.floor((whole % 3600) / 60);
	const tail = String(whole % 60).padStart(2, "0");
	return hours > 0
		? `${hours}:${String(minutes).padStart(2, "0")}:${tail}`
		: `${minutes}:${tail}`;
};

export const speedLabel = (speed: number) => `${speed}×`;

const clamp = (value: number) => Math.min(1, Math.max(0, value));

const readStoredVolume = () => {
	try {
		const stored = JSON.parse(localStorage.getItem(VOLUME_KEY) ?? "null");
		if (stored && typeof stored.volume === "number") {
			return { volume: clamp(stored.volume), muted: stored.muted === true };
		}
	} catch {}
	return null;
};

type FullscreenVideo = HTMLVideoElement & {
	webkitEnterFullscreen?: () => void;
};

const Icon = ({ children }: { children: ReactNode }) => (
	<svg viewBox="0 0 16 16" aria-hidden="true">
		{children}
	</svg>
);

const STROKE = {
	fill: "none",
	stroke: "currentColor",
	strokeWidth: 1.3,
	strokeLinecap: "round",
	strokeLinejoin: "round",
} as const;

const PLAY_PATH =
	"M4.5 2.6v10.8a.6.6 0 0 0 .92.5l8.3-5.4a.6.6 0 0 0 0-1L5.42 2.1a.6.6 0 0 0-.92.5Z";

const PlayIcon = () => (
	<Icon>
		<path d={PLAY_PATH} />
	</Icon>
);

const PauseIcon = () => (
	<Icon>
		<rect x="3.5" y="2.5" width="3.2" height="11" rx="0.8" />
		<rect x="9.3" y="2.5" width="3.2" height="11" rx="0.8" />
	</Icon>
);

const VolumeIcon = ({ level }: { level: "muted" | "low" | "high" }) => (
	<Icon>
		<path d="M7.6 2.7 4.4 5.4H2.6a.6.6 0 0 0-.6.6v4a.6.6 0 0 0 .6.6h1.8l3.2 2.7a.5.5 0 0 0 .8-.4V3.1a.5.5 0 0 0-.8-.4Z" />
		{level === "muted" ? (
			<path d="m10.6 6.2 3.6 3.6m0-3.6-3.6 3.6" {...STROKE} />
		) : (
			<path
				d={
					level === "low"
						? "M10.6 5.6a3.4 3.4 0 0 1 0 4.8"
						: "M10.6 5.6a3.4 3.4 0 0 1 0 4.8m1.7-6.5a5.8 5.8 0 0 1 0 8.2"
				}
				{...STROKE}
			/>
		)}
	</Icon>
);

const FullscreenIcon = ({ active }: { active: boolean }) => (
	<Icon>
		<path
			d={
				active
					? "M6 2.5V6H2.5M10 2.5V6h3.5M6 13.5V10H2.5m7.5 3.5V10h3.5"
					: "M2.5 6V2.5H6m4 0h3.5V6m0 4v3.5H10m-4 0H2.5V10"
			}
			{...STROKE}
		/>
	</Icon>
);

const PipIcon = () => (
	<Icon>
		<rect x="1.8" y="3" width="12.4" height="10" rx="1.6" {...STROKE} />
		<rect x="8.2" y="8" width="4.4" height="3.4" rx="0.7" />
	</Icon>
);

const CheckIcon = () => (
	<Icon>
		<path d="m3.5 8.4 3 3 6-6.6" {...STROKE} strokeWidth={1.5} />
	</Icon>
);

interface MenuItem {
	value: number;
	label: string;
	hint?: string;
	checked: boolean;
}

const Menu = ({
	label,
	items,
	onPick,
	onClose,
}: {
	label: string;
	items: readonly MenuItem[];
	onPick: (value: number) => void;
	onClose: () => void;
}) => {
	const ref = useRef<HTMLDivElement>(null);

	useLayoutEffect(() => {
		const menu = ref.current;
		if (!menu) return;
		const player = menu.closest<HTMLElement>("[data-idle]");
		if (player) {
			const room = player.clientHeight - MENU_CLEARANCE;
			menu.style.maxHeight = `${Math.max(MENU_MIN_HEIGHT, room)}px`;
		}
		const first =
			menu.querySelector<HTMLButtonElement>('[aria-checked="true"]') ??
			menu.querySelector<HTMLButtonElement>("button");
		first?.focus({ preventScroll: true });
		first?.scrollIntoView({ block: "nearest" });
	}, []);

	const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
		const buttons = [
			...(ref.current?.querySelectorAll<HTMLButtonElement>("button") ?? []),
		];
		const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
		const last = buttons.length - 1;
		let next = -1;
		if (event.key === "ArrowDown") next = at >= last ? 0 : at + 1;
		else if (event.key === "ArrowUp") next = at <= 0 ? last : at - 1;
		else if (event.key === "Home") next = 0;
		else if (event.key === "End") next = last;
		else if (event.key === "Escape" || event.key === "Tab") onClose();
		else return;
		event.preventDefault();
		buttons[next]?.focus({ preventScroll: true });
		buttons[next]?.scrollIntoView({ block: "nearest" });
	};

	return (
		<div
			ref={ref}
			role="menu"
			aria-label={label}
			className={styles.menu}
			onKeyDown={onKeyDown}
		>
			{items.map((item) => (
				<button
					key={item.value}
					type="button"
					role="menuitemradio"
					aria-checked={item.checked}
					className={styles.item}
					onClick={() => onPick(item.value)}
				>
					<span>{item.label}</span>
					{item.hint ? <span className={styles.hint}>{item.hint}</span> : null}
					<CheckIcon />
				</button>
			))}
		</div>
	);
};

export const CapPlayer = ({
	source,
	title,
	poster,
	aspectRatio = "16 / 9",
	autoPlay = false,
	muted: startMuted = false,
	loop = false,
	controls = true,
	startAt = 0,
	focusOnMount = false,
	accentColor,
	hideControls = NO_CONTROLS,
	speeds = DEFAULT_SPEEDS,
	className,
	style,
	onFirstPlay,
	onEnded,
	onQualityChange,
}: CapPlayerProps) => {
	const rootRef = useRef<HTMLDivElement>(null);
	const videoRef = useRef<HTMLVideoElement>(null);
	const trackRef = useRef<HTMLDivElement>(null);
	const playedRef = useRef<HTMLDivElement>(null);
	const bufferedRef = useRef<HTMLDivElement>(null);
	const thumbRef = useRef<HTMLDivElement>(null);
	const tipRef = useRef<HTMLDivElement>(null);
	const timeRef = useRef<HTMLSpanElement>(null);
	const playRef = useRef<HTMLButtonElement>(null);
	const coverRef = useRef<HTMLButtonElement>(null);
	const volumeRef = useRef<HTMLDivElement>(null);
	const volumeFillRef = useRef<HTMLDivElement>(null);
	const attachmentRef = useRef<Attachment | null>(null);
	const menuDismissedAt = useRef(-1);
	const levelsRef = useRef<readonly CapPlayerLevel[]>([]);
	const live = useRef({ onFirstPlay, onEnded, speeds });
	live.current = { onFirstPlay, onEnded, speeds };

	const [playing, setPlaying] = useState(false);
	const [started, setStarted] = useState(autoPlay);
	const [sound, setSound] = useState<"muted" | "low" | "high">(
		startMuted ? "muted" : "high",
	);
	const [fullscreen, setFullscreen] = useState(false);
	const [failed, setFailed] = useState(false);
	const [speed, setSpeed] = useState(1);
	const [resolution, setResolution] = useState("");
	const [levels, setLevels] = useState<readonly CapPlayerLevel[]>([]);
	const [picked, setPicked] = useState(AUTO_LEVEL);
	const [menu, setMenu] = useState<MenuName | null>(null);
	const [pip, setPip] = useState({ supported: false, active: false });

	levelsRef.current = levels;
	useLayoutEffect(() => {
		if (levels.length > 0) videoRef.current?.dispatchEvent(new Event("resize"));
	}, [levels]);

	const { hls, mp4 } = source;
	const shows = (control: CapPlayerControl) => !hideControls.includes(control);

	useLayoutEffect(() => {
		const video = videoRef.current;
		if (!video) return;
		setFailed(false);
		setLevels([]);
		setPicked(AUTO_LEVEL);
		const attachment = attachSource(
			video,
			{ hls, mp4 },
			{
				autoPlay,
				startAt,
				onFatal: () => setFailed(true),
				onLevels: setLevels,
			},
		);
		attachmentRef.current = attachment;
		return () => {
			attachmentRef.current = null;
			attachment.stop();
		};
	}, [hls, mp4, autoPlay, startAt]);

	useLayoutEffect(() => {
		if (videoRef.current) videoRef.current.muted = startMuted;
	}, [startMuted]);

	useLayoutEffect(() => {
		if (!focusOnMount) return;
		const target = controls ? playRef.current : coverRef.current;
		target?.focus({ preventScroll: true });
	}, [focusOnMount, controls]);

	const showsTime = !hideControls.includes("time");
	useLayoutEffect(() => {
		if (showsTime) videoRef.current?.dispatchEvent(new Event("timeupdate"));
	}, [showsTime]);

	const showsVolume = !hideControls.includes("volume");
	useLayoutEffect(() => {
		if (showsVolume) videoRef.current?.dispatchEvent(new Event("volumechange"));
	}, [showsVolume]);

	useEffect(() => {
		if (!menu) return;
		const onPointerDown = (event: PointerEvent) => {
			const anchor =
				event.target instanceof Element &&
				event.target.closest(`[data-menu-anchor="${menu}"]`);
			if (anchor) return;
			menuDismissedAt.current = event.timeStamp;
			setMenu(null);
		};
		document.addEventListener("pointerdown", onPointerDown, true);
		return () =>
			document.removeEventListener("pointerdown", onPointerDown, true);
	}, [menu]);

	useEffect(() => {
		const root = rootRef.current;
		const video = videoRef.current;
		const track = trackRef.current;
		if (!root || !video || !track) return;

		let frame = 0;
		let idleTimer = 0;
		let waitTimer = 0;
		let intentTimer = 0;
		let shownText = "";
		let shownOn: HTMLSpanElement | null = null;
		let scrubbing = false;
		let resumeAfterScrub = false;
		let settingVolume = false;
		let hasStarted = false;
		let tapWasIdle = false;
		let tapClosedMenu = false;
		let pointerType = "mouse";

		const duration = () =>
			Number.isFinite(video.duration) ? video.duration : 0;

		const paint = () => {
			const total = duration();
			const now = video.currentTime;
			const played = total > 0 ? Math.min(1, now / total) : 0;
			if (playedRef.current) {
				playedRef.current.style.transform = `scaleX(${played})`;
			}
			if (thumbRef.current) {
				thumbRef.current.style.transform = `translateX(${played * 100}%)`;
			}
			let ahead = 0;
			for (let i = 0; i < video.buffered.length; i++) {
				if (video.buffered.start(i) <= now + 0.25) {
					ahead = Math.max(ahead, video.buffered.end(i));
				}
			}
			if (bufferedRef.current) {
				bufferedRef.current.style.transform = `scaleX(${
					total > 0 ? Math.min(1, ahead / total) : 0
				})`;
			}
			const text = `${clock(now)} / ${clock(Math.round(total))}`;
			if (text !== shownText || timeRef.current !== shownOn) {
				shownText = text;
				shownOn = timeRef.current;
				if (shownOn) shownOn.textContent = text;
				track.setAttribute("aria-valuenow", String(Math.floor(now)));
				track.setAttribute("aria-valuemax", String(Math.round(total)));
				track.setAttribute(
					"aria-valuetext",
					`${clock(now)} of ${clock(Math.round(total))}`,
				);
			}
		};

		const loop = () => {
			paint();
			frame = video.paused && !scrubbing ? 0 : requestAnimationFrame(loop);
		};

		const startLoop = () => {
			if (!frame) frame = requestAnimationFrame(loop);
		};

		const wake = () => {
			root.dataset.idle = "false";
			window.clearTimeout(idleTimer);
			idleTimer = window.setTimeout(() => {
				if (video.paused || scrubbing || settingVolume) return;
				if (root.dataset.menu || root.querySelector(":focus-visible")) return;
				root.dataset.idle = "true";
			}, IDLE_AFTER_MS);
		};

		const setWaiting = (waiting: boolean) => {
			window.clearTimeout(waitTimer);
			if (!waiting) {
				root.dataset.waiting = "false";
				return;
			}
			waitTimer = window.setTimeout(() => {
				root.dataset.waiting = "true";
			}, 250);
		};

		const toggle = () => {
			if (video.paused || video.ended) {
				void video.play().catch(() => undefined);
			} else {
				video.pause();
			}
		};

		const seekTo = (seconds: number) => {
			const total = duration();
			if (total <= 0) return;
			video.currentTime = Math.min(total, Math.max(0, seconds));
			paint();
		};

		const storeVolume = () => {
			try {
				localStorage.setItem(
					VOLUME_KEY,
					JSON.stringify({ volume: video.volume, muted: video.muted }),
				);
			} catch {}
		};

		const setVolume = (volume: number) => {
			video.volume = clamp(volume);
			video.muted = video.volume === 0;
			storeVolume();
		};

		const toggleMute = () => {
			video.muted = !video.muted;
			if (!video.muted && video.volume === 0) video.volume = 0.5;
			storeVolume();
		};

		const stepSpeed = (direction: number) => {
			const list = live.current.speeds;
			const at = list.indexOf(video.playbackRate);
			const next = list[(at === -1 ? list.indexOf(1) : at) + direction];
			if (next) video.playbackRate = next;
		};

		const toggleFullscreen = () => {
			if (document.fullscreenElement) {
				void document.exitFullscreen();
				return;
			}
			if (root.requestFullscreen) {
				void root.requestFullscreen().catch(() => undefined);
				return;
			}
			(video as FullscreenVideo).webkitEnterFullscreen?.();
		};

		const togglePip = () => {
			if (document.pictureInPictureElement) {
				void document.exitPictureInPicture().catch(() => undefined);
			} else {
				void video.requestPictureInPicture().catch(() => undefined);
			}
		};

		const onPlay = () => {
			setPlaying(true);
			startLoop();
			wake();
			if (!hasStarted) {
				hasStarted = true;
				setStarted(true);
				live.current.onFirstPlay?.();
			}
		};
		const onPause = () => {
			setPlaying(false);
			root.dataset.idle = "false";
			paint();
		};
		const onEnded = () => {
			root.dataset.idle = "false";
			live.current.onEnded?.();
		};
		const onVolume = () => {
			const silent = video.muted || video.volume === 0;
			setSound(silent ? "muted" : video.volume < 0.5 ? "low" : "high");
			if (volumeFillRef.current) {
				volumeFillRef.current.style.transform = `scaleX(${
					silent ? 0 : video.volume
				})`;
			}
			volumeRef.current?.setAttribute(
				"aria-valuenow",
				String(silent ? 0 : Math.round(video.volume * 100)),
			);
		};
		const onResize = () =>
			setResolution(
				levelsRef.current.find(
					(level) =>
						level.width === video.videoWidth &&
						level.height === video.videoHeight,
				)?.label ?? resolutionLabel(video.videoWidth, video.videoHeight),
			);
		const onRate = () => setSpeed(video.playbackRate);
		const onWaiting = () => setWaiting(true);
		const onReady = () => setWaiting(false);
		const onFullscreen = () =>
			setFullscreen(document.fullscreenElement === root);
		const onPip = () =>
			setPip({
				supported: true,
				active: document.pictureInPictureElement === video,
			});

		const fractionAt = (element: HTMLElement, clientX: number) => {
			const box = element.getBoundingClientRect();
			return box.width > 0 ? clamp((clientX - box.left) / box.width) : 0;
		};

		const showTip = (clientX: number) => {
			const tip = tipRef.current;
			const total = duration();
			if (!tip || total <= 0) return;
			const box = track.getBoundingClientRect();
			const fraction = fractionAt(track, clientX);
			const half = total >= 3600 ? 30 : 22;
			const x = Math.min(
				box.width - half,
				Math.max(half, fraction * box.width),
			);
			tip.textContent = clock(fraction * total);
			tip.style.transform = `translateX(${x}px) translateX(-50%)`;
			track.dataset.hover = "true";
		};

		const onTrackDown = (event: PointerEvent) => {
			if (event.button !== 0) return;
			scrubbing = true;
			resumeAfterScrub = !video.paused;
			video.pause();
			track.setPointerCapture(event.pointerId);
			track.dataset.scrubbing = "true";
			seekTo(fractionAt(track, event.clientX) * duration());
			showTip(event.clientX);
			startLoop();
		};
		const onTrackMove = (event: PointerEvent) => {
			if (scrubbing) seekTo(fractionAt(track, event.clientX) * duration());
			if (scrubbing || event.pointerType === "mouse") showTip(event.clientX);
		};
		const onTrackUp = (event: PointerEvent) => {
			if (!scrubbing) return;
			scrubbing = false;
			track.dataset.scrubbing = "false";
			if (event.pointerType !== "mouse") track.dataset.hover = "false";
			track.releasePointerCapture(event.pointerId);
			if (resumeAfterScrub) void video.play().catch(() => undefined);
			wake();
		};
		const onTrackLeave = () => {
			if (!scrubbing) track.dataset.hover = "false";
		};

		const volumeTrackFor = (event: PointerEvent) => {
			const volumeTrack = volumeRef.current;
			return volumeTrack &&
				event.target instanceof Node &&
				volumeTrack.contains(event.target)
				? volumeTrack
				: null;
		};
		const onVolumeDown = (event: PointerEvent) => {
			const volumeTrack = volumeTrackFor(event);
			if (event.button !== 0 || !volumeTrack) return;
			settingVolume = true;
			volumeTrack.setPointerCapture(event.pointerId);
			setVolume(fractionAt(volumeTrack, event.clientX));
		};
		const onVolumeMove = (event: PointerEvent) => {
			const volumeTrack = volumeTrackFor(event);
			if (settingVolume && volumeTrack) {
				setVolume(fractionAt(volumeTrack, event.clientX));
			}
		};
		const onVolumeUp = (event: PointerEvent) => {
			if (!settingVolume) return;
			settingVolume = false;
			volumeTrackFor(event)?.releasePointerCapture(event.pointerId);
			wake();
		};

		const onKey = (event: KeyboardEvent) => {
			if (event.metaKey || event.ctrlKey || event.altKey) return;
			const target = event.target instanceof Element ? event.target : null;
			if (target?.closest('[role="menu"]')) return;
			const onButton = target instanceof HTMLButtonElement;
			const onVolumeSlider = target !== null && target === volumeRef.current;
			const key = event.key.toLowerCase();
			const level = video.muted ? 0 : video.volume;
			if (key === " " || key === "k") {
				if (key === " " && onButton) return;
				toggle();
			} else if (key === "arrowleft" || key === "arrowright") {
				const direction = key === "arrowleft" ? -1 : 1;
				if (onVolumeSlider) setVolume(level + direction * VOLUME_STEP);
				else seekTo(video.currentTime + direction * SEEK_STEP_SECONDS);
			} else if (key === "arrowup") {
				setVolume(level + VOLUME_STEP);
			} else if (key === "arrowdown") {
				setVolume(level - VOLUME_STEP);
			} else if (key === "j") {
				seekTo(video.currentTime - SEEK_JUMP_SECONDS);
			} else if (key === "l") {
				seekTo(video.currentTime + SEEK_JUMP_SECONDS);
			} else if (key === "home") {
				seekTo(0);
			} else if (key === "end") {
				seekTo(duration());
			} else if (key >= "0" && key <= "9" && key.length === 1) {
				seekTo((duration() * Number(key)) / 10);
			} else if (key === "m") {
				toggleMute();
			} else if (key === "f") {
				toggleFullscreen();
			} else if (key === ">") {
				stepSpeed(1);
			} else if (key === "<") {
				stepSpeed(-1);
			} else {
				return;
			}
			event.preventDefault();
			wake();
		};

		const onPointerDown = (event: PointerEvent) => {
			pointerType = event.pointerType;
			tapWasIdle = root.dataset.idle === "true";
			tapClosedMenu = menuDismissedAt.current === event.timeStamp;
			wake();
		};

		// Loading may start a moment before the click that plays: when the
		// mouse rests on a play button, or is pressed anywhere that plays. A
		// mouse that only crosses the player must not start a download.
		const onIntent = (event: PointerEvent) => {
			window.clearTimeout(intentTimer);
			if (event.pointerType !== "mouse") return;
			if (!(event.target instanceof Element)) return;
			if (event.type === "pointerdown") {
				if (event.button !== 0) return;
				if (event.target.closest(PLAYS)) attachmentRef.current?.warm();
			} else if (
				event.type === "pointerover" &&
				event.target.closest('button[data-action="toggle"]')
			) {
				intentTimer = window.setTimeout(
					() => attachmentRef.current?.warm(),
					HOVER_INTENT_MS,
				);
			}
		};

		const onAction = (event: Event) => {
			const target = event.target;
			if (!(target instanceof Element)) return;
			const action =
				target.closest<HTMLElement>("[data-action]")?.dataset.action;
			if (action === "surface") {
				if (tapClosedMenu || (pointerType === "touch" && tapWasIdle)) return;
				toggle();
			} else if (action === "toggle") toggle();
			else if (action === "mute") toggleMute();
			else if (action === "fullscreen") toggleFullscreen();
			else if (action === "pip") togglePip();
		};

		const onDoubleClick = (event: MouseEvent) => {
			if (event.target === video && pointerType === "mouse") toggleFullscreen();
		};

		const videoEvents: [string, () => void][] = [
			["play", onPlay],
			["pause", onPause],
			["emptied", onPause],
			["ended", onEnded],
			["volumechange", onVolume],
			["ratechange", onRate],
			["resize", onResize],
			["loadedmetadata", onResize],
			["loadedmetadata", paint],
			["durationchange", paint],
			["progress", paint],
			["seeked", paint],
			["timeupdate", paint],
			["waiting", onWaiting],
			["playing", onReady],
			["canplay", onReady],
			["seeked", onReady],
			["enterpictureinpicture", onPip],
			["leavepictureinpicture", onPip],
		];
		for (const [name, handler] of videoEvents) {
			video.addEventListener(name, handler);
		}
		const trackEvents: [string, (event: PointerEvent) => void][] = [
			["pointerdown", onTrackDown],
			["pointermove", onTrackMove],
			["pointerup", onTrackUp],
			["pointercancel", onTrackUp],
			["pointerleave", onTrackLeave],
		];
		for (const [name, handler] of trackEvents) {
			track.addEventListener(name, handler as EventListener);
		}
		const volumeEvents: [string, (event: PointerEvent) => void][] = [
			["pointerdown", onVolumeDown],
			["pointermove", onVolumeMove],
			["pointerup", onVolumeUp],
			["pointercancel", onVolumeUp],
		];
		for (const [name, handler] of volumeEvents) {
			root.addEventListener(name, handler as EventListener);
		}
		root.addEventListener("keydown", onKey);
		root.addEventListener("pointerover", onIntent);
		root.addEventListener("pointerleave", onIntent);
		root.addEventListener("pointerdown", onIntent);
		root.addEventListener("click", onAction);
		root.addEventListener("dblclick", onDoubleClick);
		root.addEventListener("pointerdown", onPointerDown, true);
		root.addEventListener("pointermove", wake);
		root.addEventListener("focusin", wake);
		document.addEventListener("fullscreenchange", onFullscreen);

		const stored = readStoredVolume();
		if (stored && !video.muted) {
			video.volume = stored.volume;
			video.muted = stored.muted;
		}
		if (
			document.pictureInPictureEnabled &&
			typeof video.requestPictureInPicture === "function"
		) {
			onPip();
		}
		onVolume();
		onResize();
		onRate();
		paint();
		if (!video.paused) onPlay();

		return () => {
			cancelAnimationFrame(frame);
			window.clearTimeout(idleTimer);
			window.clearTimeout(waitTimer);
			window.clearTimeout(intentTimer);
			for (const [name, handler] of videoEvents) {
				video.removeEventListener(name, handler);
			}
			for (const [name, handler] of trackEvents) {
				track.removeEventListener(name, handler as EventListener);
			}
			for (const [name, handler] of volumeEvents) {
				root.removeEventListener(name, handler as EventListener);
			}
			root.removeEventListener("keydown", onKey);
			root.removeEventListener("pointerover", onIntent);
			root.removeEventListener("pointerleave", onIntent);
			root.removeEventListener("pointerdown", onIntent);
			root.removeEventListener("click", onAction);
			root.removeEventListener("dblclick", onDoubleClick);
			root.removeEventListener("pointerdown", onPointerDown, true);
			root.removeEventListener("pointermove", wake);
			root.removeEventListener("focusin", wake);
			document.removeEventListener("fullscreenchange", onFullscreen);
		};
	}, []);

	const closeMenu = (name: MenuName) => {
		setMenu(null);
		rootRef.current
			?.querySelector<HTMLButtonElement>(
				`[data-menu-anchor="${name}"] > button`,
			)
			?.focus({ preventScroll: true });
	};

	const pickSpeed = (value: number) => {
		if (videoRef.current) videoRef.current.playbackRate = value;
		closeMenu("speed");
	};

	const pickQuality = (value: number) => {
		attachmentRef.current?.setLevel(value);
		setPicked(value);
		closeMenu("quality");
		onQualityChange?.({
			auto: value === AUTO_LEVEL,
			label: levels.find((level) => level.index === value)?.label ?? resolution,
		});
	};

	const qualityItems: MenuItem[] = [
		{
			value: AUTO_LEVEL,
			label: "Auto",
			hint: picked === AUTO_LEVEL ? resolution : undefined,
			checked: picked === AUTO_LEVEL,
		},
		...levels.map((level) => ({
			value: level.index,
			label: level.label,
			checked: picked === level.index,
		})),
	];

	const speedItems: MenuItem[] = speeds.map((value) => ({
		value,
		label: value === 1 ? "Normal" : speedLabel(value),
		checked: value === speed,
	}));

	const canPickQuality = levels.length > 1;
	const pickedLabel = levels.find((level) => level.index === picked)?.label;
	const quality = pickedLabel ?? resolution;

	return (
		<div
			ref={rootRef}
			className={`${styles.player} ${className ?? ""}`}
			style={
				{
					"--cap-player-ratio": aspectRatio,
					...(accentColor ? { "--cap-player-accent": accentColor } : null),
					...style,
				} as CSSProperties
			}
			data-playing={playing}
			data-started={started}
			data-controls={controls}
			data-idle="false"
			data-waiting="false"
			data-menu={menu ?? undefined}
		>
			<video
				ref={videoRef}
				className={styles.video}
				poster={poster}
				preload="none"
				loop={loop}
				playsInline
				data-action="surface"
				aria-label={title}
			>
				<track kind="captions" />
			</video>
			<div className={styles.spinner} aria-hidden="true" />
			{failed ? (
				<p className={styles.failed} role="alert">
					This video could not be played.
				</p>
			) : null}
			{controls || failed ? null : (
				<button
					type="button"
					ref={coverRef}
					className={styles.cover}
					data-action="toggle"
					aria-label={playing ? "Pause" : "Play"}
				>
					{playing ? <PauseIcon /> : <PlayIcon />}
				</button>
			)}
			{!controls || started || failed ? null : (
				<button
					type="button"
					className={styles.start}
					data-action="toggle"
					tabIndex={-1}
					aria-hidden="true"
				>
					<PlayIcon />
				</button>
			)}
			<div className={styles.chrome}>
				<div
					ref={trackRef}
					className={styles.track}
					role="slider"
					tabIndex={0}
					aria-label="Seek"
					aria-valuemin={0}
					aria-valuemax={0}
					aria-valuenow={0}
				>
					<div className={styles.rail}>
						<div ref={bufferedRef} className={styles.buffered} />
						<div ref={playedRef} className={styles.played} />
					</div>
					<div ref={thumbRef} className={styles.travel}>
						<div className={styles.thumb} />
					</div>
					<div ref={tipRef} className={styles.tip} aria-hidden="true" />
				</div>
				<div className={styles.row}>
					<button
						ref={playRef}
						type="button"
						className={styles.control}
						data-action="toggle"
						aria-label={playing ? "Pause" : "Play"}
					>
						{playing ? <PauseIcon /> : <PlayIcon />}
					</button>
					{shows("volume") ? (
						<div className={styles.volume}>
							<button
								type="button"
								className={styles.control}
								data-action="mute"
								aria-label={sound === "muted" ? "Unmute" : "Mute"}
							>
								<VolumeIcon level={sound} />
							</button>
							<div
								ref={volumeRef}
								className={styles.volumeTrack}
								role="slider"
								tabIndex={0}
								aria-label="Volume"
								aria-valuemin={0}
								aria-valuemax={100}
								aria-valuenow={100}
							>
								<div className={styles.volumeRail}>
									<div ref={volumeFillRef} className={styles.volumeFill} />
								</div>
							</div>
						</div>
					) : null}
					{shows("time") ? (
						<span ref={timeRef} className={styles.time}>
							0:00 / 0:00
						</span>
					) : null}
					<span className={styles.spacer} />
					{shows("speed") ? (
						<div className={styles.anchor} data-menu-anchor="speed">
							<button
								type="button"
								className={`${styles.control} ${styles.text} ${styles.optional}`}
								aria-haspopup="menu"
								aria-expanded={menu === "speed"}
								aria-label={`Playback speed, ${speed === 1 ? "normal" : speedLabel(speed)}`}
								onClick={() => setMenu(menu === "speed" ? null : "speed")}
							>
								{speedLabel(speed)}
							</button>
							{menu === "speed" ? (
								<Menu
									label="Playback speed"
									items={speedItems}
									onPick={pickSpeed}
									onClose={() => closeMenu("speed")}
								/>
							) : null}
						</div>
					) : null}
					{shows("quality") && resolution ? (
						canPickQuality ? (
							<div className={styles.anchor} data-menu-anchor="quality">
								<button
									type="button"
									className={`${styles.control} ${styles.text}`}
									aria-haspopup="menu"
									aria-expanded={menu === "quality"}
									aria-label={`Quality, ${picked === AUTO_LEVEL ? "auto, " : ""}${quality}`}
									onClick={() => setMenu(menu === "quality" ? null : "quality")}
								>
									{quality}
								</button>
								{menu === "quality" ? (
									<Menu
										label="Quality"
										items={qualityItems}
										onPick={pickQuality}
										onClose={() => closeMenu("quality")}
									/>
								) : null}
							</div>
						) : (
							<span className={styles.quality}>{resolution}</span>
						)
					) : null}
					{shows("pip") && pip.supported ? (
						<button
							type="button"
							className={`${styles.control} ${styles.optional}`}
							data-action="pip"
							aria-label={
								pip.active ? "Exit picture in picture" : "Picture in picture"
							}
						>
							<PipIcon />
						</button>
					) : null}
					{shows("fullscreen") ? (
						<button
							type="button"
							className={styles.control}
							data-action="fullscreen"
							aria-label={fullscreen ? "Exit full screen" : "Full screen"}
						>
							<FullscreenIcon active={fullscreen} />
						</button>
					) : null}
				</div>
			</div>
		</div>
	);
};
