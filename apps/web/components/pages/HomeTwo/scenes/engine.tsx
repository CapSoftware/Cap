"use client";

import { classNames } from "@cap/utils/helpers";
import Image from "next/image";
import {
	type ComponentType,
	type ReactNode,
	type RefObject,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import { MacCursor } from "../cursors";
import { MenuBar } from "../demo/MacDesktop";
import { SceneMediaProvider, useSceneMedia } from "../demo/media";
import { htGeist } from "../fonts";
import { usePageVisible } from "../visibility";
import type { Chapter } from "./catalog";

export const STAGE = { w: 680, h: 510, bar: 28 } as const;
export const LAYER = { w: STAGE.w, h: STAGE.h - STAGE.bar } as const;

export type { Chapter } from "./catalog";

export type SceneProps = {
	chapter: number;
	playing: boolean;
	onChapterEnd?: () => void;
	progressRef?: RefObject<HTMLSpanElement | null>;
	staticT?: number;
};

export type SceneModule = {
	Scene: ComponentType<SceneProps>;
	chapters: Chapter[];
	poster: number;
};

export const noop = () => {};

export const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

export const easeInOut = (f: number) =>
	f < 0.5 ? 4 * f * f * f : 1 - (-2 * f + 2) ** 3 / 2;

export const easeOut = (f: number) => 1 - (1 - f) ** 3;

export const span = (t: number, from: number, to: number) =>
	clamp01((t - from) / (to - from));

export const lerp = (a: number, b: number, f: number) => a + (b - a) * f;

export const clockText = (ms: number) => {
	const s = Math.max(0, Math.floor(ms / 1000));
	return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

export const typed = (text: string, t: number, from: number, cps = 28) =>
	text.slice(0, Math.max(0, Math.floor(((t - from) / 1000) * cps)));

export const useSceneState = <S,>(initial: S) => {
	const [state, setState] = useState(initial);
	const keyRef = useRef("");
	const set = useRef((next: S) => {
		const key = JSON.stringify(next);
		if (key === keyRef.current) return;
		keyRef.current = key;
		setState(next);
	}).current;
	return [state, set] as const;
};

export const useVideo = (
	playing: boolean,
	ref: RefObject<HTMLVideoElement | null>,
) => {
	const { still } = useSceneMedia();
	const pageVisible = usePageVisible();
	useEffect(() => {
		const video = ref.current;
		if (!video || still) return;
		if (playing && pageVisible) {
			video.play().catch(noop);
			return;
		}
		video.pause();
		const nudge = () => {
			if (video.currentTime === 0) video.currentTime = 0.1;
		};
		if (video.readyState >= 1) nudge();
		else video.addEventListener("loadedmetadata", nudge, { once: true });
		return () => video.removeEventListener("loadedmetadata", nudge);
	}, [playing, ref, still, pageVisible]);
};

export const LazyMount = ({
	w,
	h,
	rootMargin = "800px 0px",
	grow,
	className,
	children,
}: {
	w: number;
	h: number;
	rootMargin?: string;
	grow?: boolean;
	className?: string;
	children: ReactNode;
}) => {
	const boxRef = useRef<HTMLDivElement | null>(null);
	const [mounted, setMounted] = useState(false);

	useEffect(() => {
		const el = boxRef.current;
		if (!el || mounted) return;
		const io = new IntersectionObserver(
			([entry]) => {
				if (entry?.isIntersecting) setMounted(true);
			},
			{ rootMargin },
		);
		io.observe(el);
		return () => io.disconnect();
	}, [mounted, rootMargin]);

	return (
		<div
			ref={boxRef}
			className={classNames("w-full", className)}
			style={
				mounted
					? undefined
					: { maxWidth: grow ? undefined : w, aspectRatio: `${w} / ${h}` }
			}
		>
			{mounted ? children : null}
		</div>
	);
};

export { useInView, useReducedMotion } from "../visibility";

type Tick = (t: number, seek: boolean) => void;

export const useSceneClock = ({
	chapters,
	chapter,
	playing,
	staticT,
	onChapterEnd,
	progressRef,
	tick,
}: SceneProps & { chapters: Chapter[]; tick: Tick }) => {
	const pageVisible = usePageVisible();
	const tRef = useRef(staticT ?? chapters[chapter]?.start ?? 0);
	const startedRef = useRef(false);
	const tickRef = useRef(tick);
	tickRef.current = tick;
	const endRef = useRef(onChapterEnd);
	endRef.current = onChapterEnd;

	useEffect(() => {
		if (staticT === undefined) return;
		tRef.current = staticT;
		tickRef.current(staticT, true);
		const settle = setTimeout(() => tickRef.current(staticT, true), 700);
		return () => clearTimeout(settle);
	}, [staticT]);

	useEffect(() => {
		if (staticT !== undefined) return;
		const current = chapters[chapter];
		if (!current) return;
		tRef.current = startedRef.current ? current.start : current.pose;
		tickRef.current(tRef.current, true);
	}, [chapter, chapters, staticT]);

	useEffect(() => {
		if (staticT !== undefined || !playing || !pageVisible) return;
		const current = chapters[chapter];
		if (!current) return;
		if (!startedRef.current) {
			startedRef.current = true;
			tRef.current = current.start;
			tickRef.current(current.start, true);
		}
		let raf = 0;
		let last = performance.now();
		const paint = (fraction: number) => {
			const bar = progressRef?.current;
			if (bar) bar.style.transform = `scaleX(${fraction})`;
		};
		const frame = (now: number) => {
			const dt = Math.min(48, now - last);
			last = now;
			const t = tRef.current + dt;
			if (t >= current.end) {
				tRef.current = current.end;
				tickRef.current(current.end, false);
				paint(1);
				endRef.current?.();
				return;
			}
			tRef.current = t;
			tickRef.current(t, false);
			paint((t - current.start) / (current.end - current.start));
			raf = requestAnimationFrame(frame);
		};
		raf = requestAnimationFrame(frame);
		return () => cancelAnimationFrame(raf);
	}, [playing, chapter, chapters, staticT, progressRef, pageVisible]);
};

export const restartAnimation = (el: HTMLElement | null, animation: string) => {
	if (!el) return;
	el.style.animation = "none";
	void el.offsetWidth;
	el.style.animation = animation;
};

export const quantize = (value: number, steps = 20) =>
	Math.round(value * steps) / steps;

export type Way = {
	t: number;
	x?: number;
	y?: number;
	at?: string;
	dx?: number;
	dy?: number;
	click?: boolean;
};

type Point = { x: number; y: number };

const anchorCenter = (root: HTMLElement, name: string): Point | null => {
	const el = root.querySelector<HTMLElement>(
		`[data-demo-anchor="${name}"], [data-scene-anchor="${name}"]`,
	);
	if (!el) return null;
	const rootRect = root.getBoundingClientRect();
	const scale = rootRect.width / LAYER.w || 1;
	const rect = el.getBoundingClientRect();
	return {
		x: (rect.left - rootRect.left + rect.width / 2) / scale,
		y: (rect.top - rootRect.top + rect.height / 2) / scale,
	};
};

export const useCursor = (root: RefObject<HTMLDivElement | null>) => {
	const elRef = useRef<HTMLDivElement | null>(null);
	const ringRef = useRef<HTMLSpanElement | null>(null);
	const prevRef = useRef(-1);
	const cache = useRef(new Map<string, { point: Point; settled: boolean }>());

	const resolve = (way: Way, settle = false): Point => {
		if (way.at) {
			let hit = cache.current.get(way.at);
			if ((!hit || (settle && !hit.settled)) && root.current) {
				const measured = anchorCenter(root.current, way.at);
				if (measured) {
					hit = { point: measured, settled: settle };
					cache.current.set(way.at, hit);
				}
			}
			if (hit) {
				return {
					x: hit.point.x + (way.dx ?? 0),
					y: hit.point.y + (way.dy ?? 0),
				};
			}
		}
		return { x: way.x ?? 0, y: way.y ?? 0 };
	};

	const positionAt = (path: Way[], t: number): Point => {
		const first = path[0];
		if (!first) return { x: 0, y: 0 };
		if (t <= first.t) return resolve(first);
		for (let i = 1; i < path.length; i++) {
			const a = path[i - 1];
			const b = path[i];
			if (!a || !b) break;
			if (t <= b.t) {
				const progress = span(t, a.t, b.t);
				const from = resolve(a);
				const to = resolve(b, progress > 0.5);
				const f = easeInOut(progress);
				return { x: lerp(from.x, to.x, f), y: lerp(from.y, to.y, f) };
			}
		}
		return resolve(path[path.length - 1] ?? first, true);
	};

	const tick = (path: Way[], t: number, seek: boolean) => {
		if (seek) {
			prevRef.current = t - 1;
			cache.current.clear();
		}
		const pos = positionAt(path, t);
		const el = elRef.current;
		if (el) el.style.transform = `translate3d(${pos.x}px, ${pos.y}px, 0)`;
		const clicked =
			!seek && path.some((w) => w.click && w.t > prevRef.current && w.t <= t);
		if (clicked)
			restartAnimation(ringRef.current, "ht-scene-ripple 520ms ease-out");
		prevRef.current = t;
	};

	const Cursor = (
		<div
			ref={elRef}
			className="pointer-events-none absolute left-0 top-0 z-[60] will-change-transform"
		>
			<span
				ref={ringRef}
				className="absolute -left-4 -top-4 size-8 rounded-full opacity-0"
				style={{ border: "2px solid rgba(0,144,255,0.9)" }}
			/>
			<span
				className="absolute -left-[4px] -top-[3px] block"
				style={{ filter: "drop-shadow(0 1.5px 1.5px rgba(0,0,0,0.6))" }}
			>
				<MacCursor className="h-[27px] w-auto" />
			</span>
		</div>
	);

	return { tick, Cursor };
};

export const SCENE_CSS = `
	@keyframes ht-scene-ripple {
		0% { transform: scale(0.35); opacity: 0.9; }
		100% { transform: scale(1.6); opacity: 0; }
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
	@keyframes ht-scene-pop {
		0% { transform: translateY(6px) scale(0.6); opacity: 0; }
		60% { transform: translateY(-10px) scale(1.15); opacity: 1; }
		100% { transform: translateY(-26px) scale(1); opacity: 0; }
	}
`;

export const Scaled = ({
	w,
	h,
	className,
	style,
	inert: isInert,
	grow,
	children,
}: {
	w: number;
	h: number;
	className?: string;
	style?: React.CSSProperties;
	inert?: boolean;
	grow?: boolean;
	children: ReactNode;
}) => {
	const boxRef = useRef<HTMLDivElement | null>(null);
	const [scale, setScale] = useState<number | null>(null);

	useLayoutEffect(() => {
		const box = boxRef.current;
		if (!box) return;
		const measure = () =>
			setScale(grow ? box.clientWidth / w : Math.min(1, box.clientWidth / w));
		measure();
		const ro = new ResizeObserver(measure);
		ro.observe(box);
		return () => ro.disconnect();
	}, [w, grow]);

	const s = scale ?? 1;
	return (
		<div
			ref={boxRef}
			aria-hidden="true"
			inert={isInert}
			className={classNames(
				"relative w-full select-none transition-opacity duration-500",
				scale === null ? "opacity-0" : "opacity-100",
				isInert && "pointer-events-none",
				className,
			)}
			style={{
				...style,
				maxWidth: grow ? undefined : w,
				aspectRatio: `${w} / ${h}`,
			}}
		>
			<div
				className="absolute left-0 top-0"
				style={{
					width: w,
					height: h,
					transform: `scale(${s})`,
					transformOrigin: "top left",
				}}
			>
				{children}
			</div>
		</div>
	);
};

export const Fit = ({
	w,
	h,
	className,
	still,
	grow,
	children,
}: {
	w: number;
	h: number;
	className?: string;
	still?: boolean;
	grow?: boolean;
	children: ReactNode;
}) => (
	<SceneMediaProvider value={{ still: Boolean(still) }}>
		<Scaled
			w={w}
			h={h}
			inert
			grow={grow}
			className={classNames(htGeist.variable, className)}
			style={{
				fontFamily:
					"var(--font-ht-geist), 'Geist Sans', -apple-system, system-ui, sans-serif",
				fontWeight: 500,
			}}
		>
			{children}
		</Scaled>
	</SceneMediaProvider>
);

export const Stage = ({
	wallpaper,
	recording,
	layerRef,
	children,
}: {
	wallpaper: string;
	recording?: boolean;
	layerRef?: RefObject<HTMLDivElement | null>;
	children: ReactNode;
}) => (
	<div
		className="relative overflow-hidden rounded-[14px] bg-black"
		style={{ width: STAGE.w, height: STAGE.h }}
	>
		<style>{SCENE_CSS}</style>
		<Image
			src={wallpaper}
			alt=""
			fill
			sizes="680px"
			draggable={false}
			className="object-cover"
		/>
		<MenuBar recording={Boolean(recording)} onSwitchOs={noop} />
		<div
			ref={layerRef}
			className="absolute left-0"
			style={{ top: STAGE.bar, width: LAYER.w, height: LAYER.h }}
		>
			{children}
		</div>
	</div>
);

export const Reveal = ({
	show,
	from = "translateY(8px) scale(0.98)",
	className,
	style,
	children,
}: {
	show: boolean;
	from?: string;
	className?: string;
	style?: React.CSSProperties;
	children: ReactNode;
}) => (
	<div
		className={classNames(
			"absolute transition-[opacity,transform] duration-[420ms] ease-[cubic-bezier(0.16,1,0.3,1)]",
			show ? "opacity-100" : "opacity-0",
			className,
		)}
		style={{ ...style, transform: show ? "none" : from }}
	>
		{children}
	</div>
);
