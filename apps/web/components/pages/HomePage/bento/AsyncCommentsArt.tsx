"use client";

import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { useEffect, useRef, useState } from "react";

interface ArtProps {
	className?: string;
}

const CYCLE_MS = 5000;

const MARKERS = [
	{
		pct: 0.25,
		name: "Sarah M",
		text: "Love this approach 🔥",
		emoji: "❤️",
		color: "from-pink-400 to-rose-500",
		yOffset: -110,
	},
	{
		pct: 0.55,
		name: "Jamie L",
		text: "Can we extract this into a hook?",
		emoji: "🔥",
		color: "from-violet-400 to-purple-500",
		yOffset: -80,
	},
	{
		pct: 0.8,
		name: "Alex K",
		text: "Shipped! 🚀",
		emoji: "👏",
		color: "from-blue-400 to-cyan-500",
		yOffset: -100,
	},
];

const WAVEFORM = Array.from({ length: 48 }, (_, i) => {
	const base =
		Math.sin(i * 0.7) * 0.4 +
		Math.sin(i * 1.3) * 0.3 +
		Math.sin(i * 2.1) * 0.2 +
		0.1;
	return { id: `wb${i}`, height: Math.max(0.08, Math.min(1, Math.abs(base))) };
});

interface CommentBubbleProps {
	name: string;
	text: string;
	emoji: string;
	color: string;
	yOffset: number;
}

function CommentBubble({
	name,
	text,
	emoji,
	color,
	yOffset,
}: CommentBubbleProps) {
	return (
		<motion.div
			initial={{ opacity: 0, scale: 0.7, y: 10 }}
			animate={{ opacity: 1, scale: 1, y: 0 }}
			exit={{ opacity: 0, scale: 0.85, y: -6 }}
			transition={{ type: "spring", stiffness: 420, damping: 28 }}
			style={{ bottom: `calc(28px + ${-yOffset}px)` }}
			className="absolute flex items-start gap-1.5 pointer-events-none"
		>
			<div
				className={`w-6 h-6 rounded-full bg-gradient-to-br ${color} flex-shrink-0 mt-0.5`}
			/>
			<div className="bg-gray-2 border border-gray-5 rounded-xl px-2.5 py-1.5 shadow-sm max-w-[180px]">
				<p className="text-[10px] font-semibold text-gray-12 leading-tight">
					{name}
				</p>
				<p className="text-[10px] text-gray-10 leading-snug mt-0.5">{text}</p>
			</div>
			<FloatingEmoji emoji={emoji} />
		</motion.div>
	);
}

function FloatingEmoji({ emoji }: { emoji: string }) {
	return (
		<motion.span
			initial={{ opacity: 1, y: 0 }}
			animate={{ opacity: 0, y: -30 }}
			transition={{ duration: 1.4, ease: "easeOut", delay: 0.3 }}
			className="text-sm absolute -top-5 -right-2 pointer-events-none select-none"
		>
			{emoji}
		</motion.span>
	);
}

const AsyncCommentsArt = ({ className }: ArtProps) => {
	const prefersReduced = useReducedMotion();
	const [progress, setProgress] = useState(0);
	const [cycle, setCycle] = useState(0);
	const [commentCount, setCommentCount] = useState(3);
	const [reactionCount, setReactionCount] = useState(12);
	const rafRef = useRef<number | null>(null);
	const startRef = useRef<number | null>(null);

	useEffect(() => {
		if (prefersReduced) return;

		function tick(ts: number) {
			if (startRef.current === null) startRef.current = ts;
			const elapsed = ts - startRef.current;
			const p = Math.min(elapsed / CYCLE_MS, 1);
			setProgress(p);
			if (p < 1) {
				rafRef.current = requestAnimationFrame(tick);
			} else {
				setTimeout(() => {
					startRef.current = null;
					setProgress(0);
					setCycle((c) => c + 1);
					setCommentCount((c) => c + Math.floor(Math.random() * 2));
					setReactionCount((r) => r + Math.floor(Math.random() * 4 + 1));
					rafRef.current = requestAnimationFrame(tick);
				}, 400);
			}
		}

		rafRef.current = requestAnimationFrame(tick);
		return () => {
			if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
		};
	}, [prefersReduced]);

	const visibleMarkers = MARKERS.filter(
		(m) => prefersReduced || progress >= m.pct,
	);

	return (
		<div
			className={`relative w-full h-full overflow-hidden select-none ${className ?? ""}`}
		>
			<div className="absolute top-3 left-3 flex items-center gap-1.5">
				<span className="text-[11px] text-gray-10 font-medium tabular-nums">
					{commentCount} comments • {reactionCount} reactions
				</span>
			</div>

			<div className="absolute bottom-0 left-0 right-0 h-[28px] bg-gray-2 border-t border-gray-5 flex items-end px-3 gap-[2px]">
				{WAVEFORM.map((bar) => (
					<div
						key={bar.id}
						className="flex-1 rounded-sm bg-gray-5"
						style={{ height: `${Math.round(bar.height * 18)}px` }}
					/>
				))}

				{MARKERS.map((m) => (
					<div
						key={m.pct}
						className="absolute bottom-[28px] w-[1px] h-2 bg-blue-500 opacity-60"
						style={{ left: `${m.pct * 100}%` }}
					/>
				))}

				<motion.div
					className="absolute bottom-0 flex flex-col items-center pointer-events-none"
					style={{ left: prefersReduced ? "50%" : `${progress * 100}%` }}
				>
					<div className="w-2 h-2 rounded-full bg-blue-500 -mb-px" />
					<div
						className="w-[2px] bg-blue-500 rounded-full"
						style={{ height: "28px" }}
					/>
				</motion.div>
			</div>

			<div className="absolute bottom-[28px] left-0 right-0">
				<AnimatePresence mode="sync">
					{visibleMarkers.map((m) => (
						<div
							key={`${cycle}-${m.pct}`}
							className="absolute"
							style={{ left: `calc(${m.pct * 100}% - 12px)` }}
						>
							<CommentBubble
								name={m.name}
								text={m.text}
								emoji={m.emoji}
								color={m.color}
								yOffset={m.yOffset}
							/>
						</div>
					))}
				</AnimatePresence>
			</div>
		</div>
	);
};

export default AsyncCommentsArt;
