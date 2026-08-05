"use client";

import clsx from "clsx";
import { motion, useReducedMotion } from "motion/react";
import { seekKeyHandler, useSeekHandlers } from "./DemoStrip";
import type { DemoNode } from "./demo-layout";
import { clamp, DEMO_DURATION, type DemoComment, formatClock } from "./scene";

/** Node diameter, matching the product's `NODE_SIZE`. */
export const NODE_SIZE = 30;
/** Anchor line to node centre, per lane. */
export const LANE_STEM: readonly [number, number] = [26, 62];
export const MIN_NODE_GAP = 34;

export function Avatar({
	comment,
	className,
}: {
	comment: DemoComment;
	className?: string;
}) {
	return (
		<span
			className={clsx(
				"flex shrink-0 items-center justify-center rounded-full font-medium text-white",
				comment.tone,
				className ?? "size-7 text-[11px]",
			)}
		>
			{comment.initials}
		</span>
	);
}

export const PlayGlyph = () => (
	<svg viewBox="0 0 12 12" className="size-4 fill-current" aria-hidden>
		<title>Video reply</title>
		<path d="M4 2.6c0-.5.5-.8.9-.5l4 3.4c.3.3.3.7 0 1l-4 3.4c-.4.3-.9 0-.9-.5V2.6Z" />
	</svg>
);

export const MicGlyph = () => (
	<svg viewBox="0 0 12 12" className="size-4 fill-current" aria-hidden>
		<title>Voice note</title>
		<path d="M6 1.2a1.6 1.6 0 0 0-1.6 1.6v2.6a1.6 1.6 0 1 0 3.2 0V2.8A1.6 1.6 0 0 0 6 1.2Z" />
		<path d="M3 5.2a.5.5 0 0 0-1 0 4 4 0 0 0 3.5 3.97v1.13a.5.5 0 0 0 1 0V9.17A4 4 0 0 0 10 5.2a.5.5 0 0 0-1 0 3 3 0 0 1-6 0Z" />
	</svg>
);

/** What sits inside a node: avatar, emoji, or a media glyph. */
export function NodeFace({ comment }: { comment: DemoComment }) {
	if (comment.kind === "emoji") {
		return (
			<span aria-hidden className="font-emoji text-[19px] leading-none">
				{comment.text}
			</span>
		);
	}
	if (comment.kind === "voice") return <MicGlyph />;
	if (comment.kind === "video") return <PlayGlyph />;
	return <Avatar comment={comment} className="size-[26px] text-[11px]" />;
}

export function nodeClassName(comment: DemoComment, count: number) {
	if (count > 1) return "bg-white text-gray-12 ring-1 ring-gray-5";
	if (comment.kind === "emoji") return "text-[19px] leading-none";
	if (comment.kind === "voice") return "bg-blue-9 text-white";
	return "bg-white text-gray-12 ring-1 ring-gray-5";
}

/**
 * One branch: a hairline dropping off the anchor line with the node parked on
 * the end of it. Positioned by the caller in the shelf's coordinate space.
 */
export function BranchNode({
	node,
	active,
	delay = 0,
	onSelect,
	onHover,
}: {
	node: DemoNode;
	active?: boolean;
	/** Staggers the drop-in, so they arrive left to right. */
	delay?: number;
	onSelect?: () => void;
	onHover?: (hovering: boolean) => void;
}) {
	const reduceMotion = useReducedMotion() ?? false;
	const stem = LANE_STEM[node.lane];
	const { comment, count } = node;
	const label =
		count > 1
			? `${count} comments around ${formatClock(comment.t)}`
			: `${comment.author} at ${formatClock(comment.t)}`;

	return (
		<motion.div
			className="pointer-events-none absolute top-0 z-30 w-0"
			style={{
				left: `clamp(${NODE_SIZE / 2}px, ${node.percent}%, 100% - ${NODE_SIZE / 2}px)`,
				transformOrigin: "top",
			}}
			initial={
				reduceMotion ? { opacity: 0 } : { opacity: 0, scaleY: 0.4, y: -6 }
			}
			animate={reduceMotion ? { opacity: 1 } : { opacity: 1, scaleY: 1, y: 0 }}
			transition={
				reduceMotion
					? { duration: 0 }
					: { type: "spring", stiffness: 420, damping: 30, delay }
			}
		>
			<span
				aria-hidden
				className="absolute left-0 top-0 w-px -translate-x-1/2 bg-gradient-to-b from-gray-7 to-transparent"
				style={{ height: Math.max(0, stem - NODE_SIZE / 2) }}
			/>
			<button
				type="button"
				aria-label={label}
				title={label}
				onClick={onSelect}
				onPointerEnter={() => onHover?.(true)}
				onPointerLeave={() => onHover?.(false)}
				onFocus={() => onHover?.(true)}
				onBlur={() => onHover?.(false)}
				className={clsx(
					"pointer-events-auto absolute left-0 flex -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full shadow-[0_1px_3px_rgba(18,22,31,0.10)] transition-shadow focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-9",
					nodeClassName(comment, count),
					active && "ring-2 ring-blue-9",
				)}
				style={{ top: stem, width: NODE_SIZE, height: NODE_SIZE }}
			>
				{count > 1 ? (
					<span className="text-[12px] font-medium">{count}</span>
				) : (
					<NodeFace comment={comment} />
				)}
			</button>
		</motion.div>
	);
}

/** The hairline the stems hang from. */
export function AnchorLine() {
	return (
		<div aria-hidden className="absolute inset-x-0 top-0 h-px bg-gray-5" />
	);
}

/** The card a node opens: what the reader would see on hover in the product. */
export function CommentCard({
	comments,
	className,
}: {
	comments: DemoComment[];
	className?: string;
}) {
	return (
		<div
			className={clsx(
				"w-64 rounded-xl border border-gray-4 bg-white p-3 shadow-[0_8px_24px_rgba(18,22,31,0.10)] sm:w-72",
				className,
			)}
		>
			<div className="flex flex-col gap-2.5">
				{comments.map((comment) => (
					<div key={comment.id} className="flex gap-2.5">
						<Avatar comment={comment} />
						<div className="min-w-0 flex-1">
							<div className="flex items-baseline gap-1.5">
								<span className="truncate text-[13px] font-medium text-gray-12">
									{comment.author}
								</span>
								<span className="text-[11px] text-gray-10">
									{formatClock(comment.t)}
								</span>
							</div>
							<div className="mt-0.5 text-[13px] leading-snug text-gray-11">
								{comment.kind === "voice"
									? `Voice note · ${formatClock(comment.mediaDuration ?? 0)}`
									: comment.kind === "video"
										? `Video reply · ${formatClock(comment.mediaDuration ?? 0)}`
										: comment.text}
							</div>
						</div>
					</div>
				))}
			</div>
		</div>
	);
}

/** Play/pause, in either tone. */
export function TransportButton({
	playing,
	onClick,
	tone = "light",
}: {
	playing: boolean;
	onClick: () => void;
	tone?: "light" | "dark";
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			aria-label={playing ? "Pause" : "Play"}
			className={clsx(
				"flex size-8 shrink-0 items-center justify-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-9",
				tone === "dark"
					? "text-white hover:bg-white/15"
					: "text-gray-12 hover:bg-gray-3",
			)}
		>
			{playing ? (
				<svg viewBox="0 0 16 16" className="size-4 fill-current" aria-hidden>
					<title>Pause</title>
					<rect x="4" y="3" width="3" height="10" rx="1" />
					<rect x="9" y="3" width="3" height="10" rx="1" />
				</svg>
			) : (
				<svg viewBox="0 0 16 16" className="size-4 fill-current" aria-hidden>
					<title>Play</title>
					<path d="M5.5 3.3c0-.6.7-1 1.2-.6l6 4.2c.5.3.5 1 0 1.3l-6 4.2c-.5.4-1.2 0-1.2-.6V3.3Z" />
				</svg>
			)}
		</button>
	);
}

/** `0:42 / 2:48`, the readout the transport carries. */
export function Clock({
	time,
	tone = "light",
}: {
	time: number;
	tone?: "light" | "dark";
}) {
	return (
		<span
			className={clsx(
				"shrink-0 font-mono text-[12px] tabular-nums",
				tone === "dark" ? "text-white/80" : "text-gray-11",
			)}
		>
			{formatClock(time)}
			<span className={tone === "dark" ? "text-white/50" : "text-gray-9"}>
				{" / "}
				{formatClock(DEMO_DURATION)}
			</span>
		</span>
	);
}

/**
 * The seek bar every video player has: a track, a fill, a knob, and no
 * information about the recording whatsoever. Half this post is about what it
 * costs you.
 */
export function PlainSeekBar({
	time,
	onSeek,
	tone = "light",
	className,
}: {
	time: number;
	onSeek?: (time: number) => void;
	/** "dark" for a bar sitting over the video, the way classic playback does. */
	tone?: "light" | "dark";
	className?: string;
}) {
	const handlers = useSeekHandlers({ onSeek });
	const percent = clamp(time / DEMO_DURATION, 0, 1) * 100;
	const dark = tone === "dark";

	const semantics = onSeek
		? {
				role: "slider" as const,
				tabIndex: 0,
				"aria-label": "Seek",
				"aria-valuemin": 0,
				"aria-valuemax": Math.round(DEMO_DURATION),
				"aria-valuenow": Math.round(time),
				onKeyDown: seekKeyHandler(time, onSeek),
			}
		: { "aria-hidden": true };

	return (
		<div
			className={clsx(
				"relative flex h-5 w-full touch-none select-none items-center",
				onSeek && "cursor-pointer",
				className,
			)}
			{...handlers}
			{...semantics}
		>
			<div
				className={clsx(
					"relative h-1.5 w-full rounded-full",
					dark ? "bg-white/30" : "bg-gray-6",
				)}
			>
				<div
					className={clsx(
						"absolute inset-y-0 left-0 rounded-full",
						dark ? "bg-white" : "bg-gray-12",
					)}
					style={{ width: `${percent}%` }}
				/>
				<span
					className={clsx(
						"absolute top-1/2 size-3 -translate-x-1/2 -translate-y-1/2 rounded-full",
						dark ? "bg-white" : "bg-gray-12 ring-2 ring-white",
					)}
					style={{ left: `clamp(6px, ${percent}%, 100% - 6px)` }}
				/>
			</div>
		</div>
	);
}

/** The list a comment sidebar gives you: a row per comment, sorted by time. */
export function CommentRow({
	comment,
	active,
	onClick,
}: {
	comment: DemoComment;
	active?: boolean;
	onClick?: () => void;
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			className={clsx(
				"flex w-full items-start gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-9",
				active ? "bg-blue-9/10" : "hover:bg-gray-3",
			)}
		>
			<Avatar comment={comment} />
			<span className="min-w-0 flex-1">
				<span className="flex items-baseline gap-1.5">
					<span className="truncate text-[13px] font-medium text-gray-12">
						{comment.author}
					</span>
					<span className="shrink-0 rounded bg-gray-3 px-1 py-px font-mono text-[11px] text-gray-11">
						{formatClock(comment.t)}
					</span>
				</span>
				<span className="mt-0.5 block text-[13px] leading-snug text-gray-11">
					{comment.kind === "voice"
						? `Voice note · ${formatClock(comment.mediaDuration ?? 0)}`
						: comment.kind === "emoji"
							? `Reacted ${comment.text}`
							: comment.text}
				</span>
			</span>
		</button>
	);
}
