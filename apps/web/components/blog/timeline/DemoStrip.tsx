"use client";

import clsx from "clsx";
import {
	memo,
	type ReactNode,
	type PointerEvent as ReactPointerEvent,
	useCallback,
	useMemo,
	useRef,
	useState,
} from "react";
import {
	filmstripTileCount,
	filmstripWindowTimes,
} from "@/app/s/[videoId]/_components/timeline/filmstrip-math";
import { MockFrame } from "./MockFrame";
import { clamp, DEMO_DURATION, speechEnergy } from "./scene";

/**
 * The strip itself: drawn frames laid end to end, the speech envelope over
 * them, a played wash and the playhead. Same geometry as the real thing (tile
 * count comes from the product's own `filmstripTileCount`), minus everything
 * that needs a video element.
 *
 * Controlled: the parent owns `time` and the visible window, and puts its own
 * chrome around the strip.
 */

/**
 * Width of an element, as a callback ref rather than a mount effect: demos
 * mount and unmount their strip when the reader flips a view, and a
 * `useEffect` that ran once against an empty ref would leave the branch layout
 * measuring zero and stacking every comment into one cluster.
 */
export function useMeasuredWidth<T extends HTMLElement>() {
	const [width, setWidth] = useState(0);
	const observer = useRef<ResizeObserver | null>(null);

	const ref = useCallback((node: T | null) => {
		observer.current?.disconnect();
		observer.current = null;
		if (!node) return;

		setWidth(node.clientWidth);
		if (typeof ResizeObserver === "undefined") return;
		const next = new ResizeObserver((entries) => {
			for (const entry of entries) setWidth(entry.contentRect.width);
		});
		next.observe(node);
		observer.current = next;
	}, []);

	return [ref, width] as const;
}

export interface DemoWindow {
	start: number;
	end: number;
}

export const FULL_WINDOW: DemoWindow = { start: 0, end: DEMO_DURATION };

export const fractionInWindow = (t: number, window: DemoWindow) => {
	const span = window.end - window.start;
	return span > 0 ? (t - window.start) / span : 0;
};

/**
 * Pointer plumbing shared by the strip and the plain seek bar: press to seek,
 * drag to scrub, and report hover to whoever wants a preview. Pointer events
 * (plus `touch-none`) cover mouse and touch in one path.
 */
export function useSeekHandlers({
	onSeek,
	onHoverTime,
	window = FULL_WINDOW,
}: {
	onSeek?: (time: number) => void;
	onHoverTime?: (time: number | null) => void;
	window?: DemoWindow;
}) {
	const scrubbing = useRef(false);

	const timeAt = useCallback(
		(clientX: number, element: HTMLElement) => {
			const rect = element.getBoundingClientRect();
			if (rect.width <= 0) return window.start;
			const fraction = clamp((clientX - rect.left) / rect.width, 0, 1);
			return window.start + fraction * (window.end - window.start);
		},
		[window],
	);

	const endScrub = (event: ReactPointerEvent<HTMLElement>) => {
		scrubbing.current = false;
		if (event.currentTarget.hasPointerCapture(event.pointerId)) {
			event.currentTarget.releasePointerCapture(event.pointerId);
		}
	};

	return {
		onPointerDown: (event: ReactPointerEvent<HTMLElement>) => {
			if (!onSeek || event.button !== 0) return;
			event.currentTarget.setPointerCapture(event.pointerId);
			scrubbing.current = true;
			onSeek(timeAt(event.clientX, event.currentTarget));
		},
		onPointerMove: (event: ReactPointerEvent<HTMLElement>) => {
			const at = timeAt(event.clientX, event.currentTarget);
			if (scrubbing.current && onSeek) onSeek(at);
			else if (event.pointerType !== "touch") onHoverTime?.(at);
		},
		onPointerUp: endScrub,
		onPointerCancel: endScrub,
		onPointerLeave: () => onHoverTime?.(null),
	};
}

export function seekKeyHandler(
	time: number,
	onSeek?: (time: number) => void,
): ((event: React.KeyboardEvent) => void) | undefined {
	if (!onSeek) return undefined;
	return (event) => {
		if (event.key === "ArrowLeft") {
			event.preventDefault();
			onSeek(clamp(time - 5, 0, DEMO_DURATION));
		}
		if (event.key === "ArrowRight") {
			event.preventDefault();
			onSeek(clamp(time + 5, 0, DEMO_DURATION));
		}
	};
}

interface DemoStripProps {
	time: number;
	window?: DemoWindow;
	onSeek?: (time: number) => void;
	/** Fires with the time under a fine pointer, and null when it leaves. */
	onHoverTime?: (time: number | null) => void;
	waveform?: boolean;
	/** Drawn frames off, so the reader sees what a bare seek bar gives them. */
	film?: boolean;
	heightClass?: string;
	className?: string;
	/** Overlays that share the strip's coordinate space (playhead, ghosts). */
	children?: ReactNode;
	label?: string;
}

export function DemoStrip({
	time,
	window = FULL_WINDOW,
	onSeek,
	onHoverTime,
	waveform = true,
	film = true,
	heightClass = "h-12 sm:h-16",
	className,
	children,
	label = "Seek",
}: DemoStripProps) {
	const [ref, width] = useMeasuredWidth<HTMLDivElement>();
	const handlers = useSeekHandlers({ onSeek, onHoverTime, window });

	const tileCount = filmstripTileCount(width);
	const progress = clamp(fractionInWindow(time, window), 0, 1) * 100;

	// A strip with nothing to seek is decoration, so it announces itself as
	// nothing at all rather than as a slider that ignores you.
	const semantics = onSeek
		? {
				role: "slider" as const,
				tabIndex: 0,
				"aria-label": label,
				"aria-valuemin": 0,
				"aria-valuemax": Math.round(DEMO_DURATION),
				"aria-valuenow": Math.round(time),
				onKeyDown: seekKeyHandler(time, onSeek),
			}
		: { "aria-hidden": true };

	return (
		<div
			ref={ref}
			className={clsx(
				"relative w-full touch-none select-none overflow-hidden bg-gray-3",
				heightClass,
				onSeek && "cursor-pointer",
				className,
			)}
			{...handlers}
			{...semantics}
		>
			{film ? (
				<FilmTiles count={tileCount} start={window.start} end={window.end} />
			) : (
				<div aria-hidden className="absolute inset-0 bg-gray-4" />
			)}

			{waveform && <Envelope start={window.start} end={window.end} />}

			<div
				aria-hidden
				className="absolute inset-0 bg-gray-12/10"
				style={{ clipPath: `inset(0 ${100 - progress}% 0 0)` }}
			/>
			<div
				aria-hidden
				className="absolute inset-x-0 bottom-0 h-[3px] bg-gray-12"
				style={{ clipPath: `inset(0 ${100 - progress}% 0 0)` }}
			/>

			{children}
		</div>
	);
}

/**
 * Memoised on the window alone: scrubbing must not redraw twenty-odd SVG
 * frames, exactly as the real strip never re-renders its tiles during playback.
 */
const FilmTiles = memo(function FilmTiles({
	count,
	start,
	end,
}: {
	count: number;
	start: number;
	end: number;
}) {
	const times = useMemo(
		() => filmstripWindowTimes(count, start, end, DEMO_DURATION),
		[count, start, end],
	);

	if (count <= 0) {
		return (
			<div aria-hidden className="absolute inset-0 animate-pulse bg-gray-4" />
		);
	}

	return (
		<>
			<div aria-hidden className="absolute inset-0 flex">
				{times.map((t, index) => (
					<div
						key={`${index}-${t.toFixed(2)}`}
						className="relative h-full min-w-0 flex-1 overflow-hidden"
					>
						<MockFrame
							time={t}
							className="absolute inset-0 size-full saturate-[.9]"
						/>
					</div>
				))}
			</div>
			<div aria-hidden className="absolute inset-0 bg-white/20" />
		</>
	);
});

/**
 * Speech energy over the window, drawn symmetrically about the middle. The real
 * timeline derives this from the transcript rather than from decoded audio;
 * this one derives it from `speechEnergy`, which is the same shape of lie.
 */
const Envelope = memo(function Envelope({
	start,
	end,
}: {
	start: number;
	end: number;
}) {
	const path = useMemo(() => {
		const samples = 240;
		const top: string[] = [];
		const bottom: string[] = [];
		for (let index = 0; index <= samples; index++) {
			const x = (index / samples) * 1000;
			const t = start + (index / samples) * (end - start);
			const amplitude = clamp(speechEnergy(t), 0, 1) * 38;
			top.push(`${x.toFixed(1)},${(50 - amplitude).toFixed(1)}`);
			bottom.push(`${x.toFixed(1)},${(50 + amplitude).toFixed(1)}`);
		}
		bottom.reverse();
		return `M${top.join("L")}L${bottom.join("L")}Z`;
	}, [start, end]);

	return (
		<svg
			aria-hidden
			viewBox="0 0 1000 100"
			preserveAspectRatio="none"
			className="absolute inset-0 size-full"
		>
			<title>Speech energy across the recording</title>
			<path d={path} fill="rgba(18,22,31,0.34)" />
		</svg>
	);
});

/** The needle, in the strip's coordinate space. */
export function DemoPlayhead({
	time,
	window = FULL_WINDOW,
}: {
	time: number;
	window?: DemoWindow;
}) {
	const fraction = fractionInWindow(time, window);
	if (fraction < -0.02 || fraction > 1.02) return null;

	return (
		<div
			aria-hidden
			className="pointer-events-none absolute inset-y-0 z-20 w-px bg-gray-12"
			style={{
				left: `clamp(1px, ${(fraction * 100).toFixed(3)}%, 100% - 1px)`,
			}}
		>
			<span className="absolute -top-px left-1/2 size-2 -translate-x-1/2 rounded-full bg-gray-12 ring-2 ring-white" />
		</div>
	);
}
