"use client";

import type { ImageUpload } from "@cap/web-domain";
import clsx from "clsx";
import { motion } from "motion/react";
import { memo, type ReactNode } from "react";
import { SignedImageUrl } from "@/components/SignedImageUrl";
import { NODE_SIZE } from "./timeline-constants";

export type BranchGlyph = "text" | "emoji" | "video" | "audio";

interface BranchAnchorProps {
	left: string;
	stem: number;
	delay: number;
	reduceMotion: boolean;
	children: ReactNode;
}

/**
 * Zero-width post at a point in time: a hairline growing down off the anchor
 * line with the node parked on the end of it. Shared by single nodes and
 * clusters so both hang at exactly the same depth.
 */
export function BranchAnchor({
	left,
	stem,
	delay,
	reduceMotion,
	children,
}: BranchAnchorProps) {
	return (
		<motion.div
			// top 0 is the anchor line: the ruler hairline across the top of the
			// comments surface, so stems drop off the ruler rather than the strip.
			className="pointer-events-none absolute top-0 z-30 w-0"
			style={{ left, transformOrigin: "top" }}
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
				className="absolute top-0 left-0 w-px -translate-x-1/2 bg-gradient-to-b from-gray-7 to-transparent"
				style={{ height: Math.max(0, stem - NODE_SIZE / 2) }}
			/>
			{children}
		</motion.div>
	);
}

// The pseudo-element grows the hit area to ~46px on touch screens (the visual
// node is 30px, under the 44px guideline) without touching the layout; hit
// tests on a pseudo-element resolve to the button itself, so node-targeted
// delegation (`closest("[data-comment-id]")`) still works.
export const NODE_BASE_CLASS =
	"pointer-events-auto absolute left-0 flex -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full transition-shadow focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-9 data-[active]:ring-2 data-[active]:ring-blue-9 [@media(pointer:coarse)]:before:content-[''] [@media(pointer:coarse)]:before:absolute [@media(pointer:coarse)]:before:-inset-2 [@media(pointer:coarse)]:before:rounded-full";

interface TimelineBranchProps {
	id: string;
	/** Padded-calc `left`, computed once per layout pass. */
	left: string;
	stem: number;
	glyph: BranchGlyph;
	/** Emoji glyph, or the first line of a text comment for the label. */
	content: string;
	avatarUrl: ImageUpload.ImageUrl | null;
	authorName: string;
	timeLabel: string;
	sending: boolean;
	delay: number;
	reduceMotion: boolean;
	/** Dropped under reduced motion so nothing morphs into the card. */
	morphId?: string;
}

/**
 * One comment on the rail. Everything it receives is a primitive, so the memo
 * actually holds and a hover somewhere else in the band re-renders nothing.
 */
export const TimelineBranch = memo(function TimelineBranch({
	id,
	left,
	stem,
	glyph,
	content,
	avatarUrl,
	authorName,
	timeLabel,
	sending,
	delay,
	reduceMotion,
	morphId,
}: TimelineBranchProps) {
	const label =
		glyph === "emoji"
			? `Reaction ${content} by ${authorName} at ${timeLabel}`
			: `Comment by ${authorName} at ${timeLabel}`;

	return (
		<BranchAnchor
			left={left}
			stem={stem}
			delay={delay}
			reduceMotion={reduceMotion}
		>
			<button
				type="button"
				data-comment-id={id}
				data-timeline-node=""
				aria-label={label}
				title={label}
				className={clsx(
					NODE_BASE_CLASS,
					glyph === "emoji"
						? "text-[22px] leading-none"
						: "shadow-[0_1px_3px_rgba(18,22,31,0.10)]",
					glyph === "audio" ? "bg-blue-9 text-white" : null,
					glyph === "text" || glyph === "video"
						? "bg-white text-gray-12 ring-1 ring-gray-5"
						: null,
					sending && "opacity-50",
				)}
				style={{ top: stem, width: NODE_SIZE, height: NODE_SIZE }}
			>
				<BranchGlyphContent
					glyph={glyph}
					content={content}
					avatarUrl={avatarUrl}
					authorName={authorName}
					morphId={reduceMotion ? undefined : morphId}
				/>
			</button>
		</BranchAnchor>
	);
});

function BranchGlyphContent({
	glyph,
	content,
	avatarUrl,
	authorName,
	morphId,
}: {
	glyph: BranchGlyph;
	content: string;
	avatarUrl: ImageUpload.ImageUrl | null;
	authorName: string;
	morphId?: string;
}) {
	if (glyph === "emoji") {
		return (
			<span aria-hidden className="font-emoji">
				{content}
			</span>
		);
	}

	if (glyph === "video") {
		return <PlayGlyph />;
	}

	if (glyph === "audio") {
		return <MicGlyph />;
	}

	// The avatar, not the ring, carries the morph: when the card opens the ring
	// stays put on the rail so the branch never looks like it vanished.
	return (
		<motion.span
			layoutId={morphId}
			className="block overflow-hidden rounded-full size-[26px]"
		>
			<SignedImageUrl
				image={avatarUrl}
				name={authorName}
				className="size-full"
				letterClass="text-[11px] font-medium"
			/>
		</motion.span>
	);
}

/** Inline rather than an icon-pack import: two paths, no tree-shaking bet. */
export const PlayGlyph = () => (
	<svg viewBox="0 0 12 12" className="size-4 fill-current" aria-hidden>
		<title>Video comment</title>
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
