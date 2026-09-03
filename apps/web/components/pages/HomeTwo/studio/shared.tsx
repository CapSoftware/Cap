"use client";

import { classNames } from "@cap/utils/helpers";
import Image from "next/image";
import {
	type ComponentType,
	type CSSProperties,
	type ReactNode,
	useEffect,
	useRef,
} from "react";
import { ContentWindow } from "../demo/MacDesktop";
import { useVideoAttrs, VIDEO_POSTERS } from "../demo/media";
import { useVideo } from "../scenes/engine";
import { useReducedMotion } from "../visibility";

export type StudioCard = {
	key: string;
	title: string;
	body: string;
	span?: 1 | 2;
	Visual: ComponentType<{ playing: boolean }>;
};

export const CANVAS = { w: 600, h: 375 } as const;

export const useLoop = ({
	duration,
	playing,
	pose,
	tick,
}: {
	duration: number;
	playing: boolean;
	pose: number;
	tick: (t: number, seek: boolean) => void;
}) => {
	const tRef = useRef(0);
	const tickRef = useRef(tick);
	tickRef.current = tick;
	const reduced = useReducedMotion();

	useEffect(() => {
		if (reduced) {
			tickRef.current(pose, true);
			return;
		}
		if (!playing) return;
		let raf = 0;
		let last = performance.now();
		let seek = true;
		const frame = (now: number) => {
			const dt = Math.min(48, now - last);
			last = now;
			const next = tRef.current + dt;
			if (next >= duration) seek = true;
			tRef.current = next % duration;
			tickRef.current(tRef.current, seek);
			seek = false;
			raf = requestAnimationFrame(frame);
		};
		raf = requestAnimationFrame(frame);
		return () => cancelAnimationFrame(raf);
	}, [playing, reduced, duration, pose]);
};

export const CanvasStage = ({
	wallpaper = "/backgrounds/monaco.webp",
	className,
	style,
	children,
}: {
	wallpaper?: string;
	className?: string;
	style?: CSSProperties;
	children: ReactNode;
}) => (
	<div
		className={classNames(
			"relative overflow-hidden rounded-[12px] bg-black",
			className,
		)}
		style={{ width: CANVAS.w, height: CANVAS.h, ...style }}
	>
		<Image
			src={wallpaper}
			alt=""
			fill
			sizes="600px"
			draggable={false}
			className="object-cover"
		/>
		{children}
	</div>
);

export const RECORDED = {
	left: 120,
	top: 62,
	width: 360,
	height: 250,
} as const;

export const RecordedWindow = ({
	left = RECORDED.left,
	top = RECORDED.top,
	width = RECORDED.width,
	height = RECORDED.height,
	className,
	style,
}: {
	left?: number;
	top?: number;
	width?: number;
	height?: number;
	className?: string;
	style?: CSSProperties;
}) => {
	const scrollRef = useRef<HTMLDivElement | null>(null);
	return (
		<div
			className={classNames("absolute", className)}
			style={{ left, top, width, height, ...style }}
		>
			<ContentWindow width={width} height={height} scrollRef={scrollRef} />
		</div>
	);
};

export const CameraBubble = ({
	playing,
	size = 96,
	left = 24,
	top = CANVAS.h - 24 - 96,
	className,
	style,
}: {
	playing: boolean;
	size?: number;
	left?: number;
	top?: number;
	className?: string;
	style?: CSSProperties;
}) => {
	const ref = useRef<HTMLVideoElement | null>(null);
	const attrs = useVideoAttrs(VIDEO_POSTERS.webcam);
	useVideo(playing, ref);
	return (
		<div
			className={classNames(
				"absolute overflow-hidden rounded-full bg-[#111111]",
				className,
			)}
			style={{
				left,
				top,
				width: size,
				height: size,
				boxShadow: "0 10px 26px rgba(0,0,0,0.35)",
				...style,
			}}
		>
			<video
				ref={ref}
				className="h-full w-full object-cover"
				src="/videos/home-two/webcam.mp4"
				muted
				loop
				playsInline
				{...attrs}
			/>
		</div>
	);
};

export const Chip = ({
	children,
	className,
	style,
}: {
	children: ReactNode;
	className?: string;
	style?: CSSProperties;
}) => (
	<span
		className={classNames(
			"inline-flex h-7 items-center gap-1.5 rounded-lg px-2.5 text-[12px] font-medium",
			className,
		)}
		style={{
			background: "#fcfcfc",
			color: "#202020",
			border: "1px solid rgba(0,0,0,0.08)",
			boxShadow: "0 8px 20px -10px rgba(16,24,40,0.45)",
			...style,
		}}
	>
		{children}
	</span>
);
