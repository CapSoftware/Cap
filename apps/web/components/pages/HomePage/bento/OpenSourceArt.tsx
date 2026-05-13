"use client";

import {
	animate,
	motion,
	useMotionValue,
	useReducedMotion,
} from "framer-motion";
import { Github, Star } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

const ROWS = 7;
const COLS = 14;
const START_STARS = 9842;
const END_STARS = 10347;
const FILL_CLASSES = [
	"bg-emerald-200",
	"bg-emerald-400",
	"bg-emerald-500",
	"bg-emerald-600",
] as const;

const AVATAR_GRADIENTS = [
	"from-violet-400 to-blue-500",
	"from-pink-400 to-rose-500",
	"from-amber-400 to-orange-500",
];

function deterministicFill(
	row: number,
	col: number,
): (typeof FILL_CLASSES)[number] {
	const hash = (row * 31 + col * 17 + row * col * 7) % FILL_CLASSES.length;
	return FILL_CLASSES[hash] ?? FILL_CLASSES[0];
}

function deterministicActive(row: number, col: number): boolean {
	const hash = (row * 13 + col * 29 + (row + col) * 3) % 10;
	return hash > 2;
}

function formatStars(n: number): string {
	if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
	return String(n);
}

interface CellData {
	id: string;
	row: number;
	col: number;
	active: boolean;
	fill: (typeof FILL_CLASSES)[number];
}

interface ArtProps {
	className?: string;
}

const OpenSourceArt = ({ className }: ArtProps) => {
	const shouldReduceMotion = useReducedMotion();
	const [step, setStep] = useState(shouldReduceMotion ? COLS : 0);
	const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
	const starCount = useMotionValue(START_STARS);
	const [displayStars, setDisplayStars] = useState(START_STARS);

	const cellPattern = useMemo<CellData[][]>(() => {
		return Array.from({ length: ROWS }, (_, r) =>
			Array.from({ length: COLS }, (_, c) => ({
				id: `cell-${r}-${c}`,
				row: r,
				col: c,
				active: deterministicActive(r, c),
				fill: deterministicFill(r, c),
			})),
		);
	}, []);

	useEffect(() => {
		if (shouldReduceMotion) return;

		const unsubscribe = starCount.on("change", (v) => {
			setDisplayStars(Math.round(v));
		});

		return unsubscribe;
	}, [starCount, shouldReduceMotion]);

	useEffect(() => {
		if (shouldReduceMotion) return;

		const runStarAnimation = () => {
			starCount.set(START_STARS);
			animate(starCount, END_STARS, { duration: 4, ease: "easeOut" });
		};

		runStarAnimation();
		const starInterval = setInterval(runStarAnimation, 6000);

		return () => clearInterval(starInterval);
	}, [starCount, shouldReduceMotion]);

	useEffect(() => {
		if (shouldReduceMotion) return;

		const STEP_INTERVAL = 150;
		const HOLD_STEPS = 8;

		intervalRef.current = setInterval(() => {
			setStep((prev) => {
				if (prev >= COLS + HOLD_STEPS) return 0;
				return prev + 1;
			});
		}, STEP_INTERVAL);

		return () => {
			if (intervalRef.current) clearInterval(intervalRef.current);
		};
	}, [shouldReduceMotion]);

	return (
		<div className={`flex flex-col gap-3 p-4 select-none ${className ?? ""}`}>
			<div className="flex items-center gap-2">
				<Github className="w-4 h-4 text-gray-12 shrink-0" />
				<span className="text-gray-10 text-[11px] font-mono truncate flex-1">
					github.com/CapSoftware/Cap
				</span>
				<div className="flex items-center gap-1 shrink-0">
					<Star className="w-3.5 h-3.5 text-yellow-400 fill-current" />
					<span className="text-gray-12 text-[12px] font-semibold tabular-nums">
						{formatStars(shouldReduceMotion ? END_STARS : displayStars)}
					</span>
				</div>
			</div>

			<div
				className="grid gap-[3px]"
				style={{
					gridTemplateColumns: `repeat(${COLS}, minmax(0, 1fr))`,
					gridTemplateRows: `repeat(${ROWS}, minmax(0, 1fr))`,
				}}
			>
				{cellPattern.map((rowArr) =>
					rowArr.map((cell) => {
						const revealed = cell.col < step;
						const isActive = cell.active && revealed;

						if (shouldReduceMotion) {
							return (
								<div
									key={cell.id}
									className={`rounded-[2px] aspect-square ${cell.active ? cell.fill : "bg-gray-3"}`}
								/>
							);
						}

						return (
							<motion.div
								key={cell.id}
								className={`rounded-[2px] aspect-square ${isActive ? cell.fill : "bg-gray-3"}`}
								animate={
									isActive
										? { opacity: 1, scale: 1 }
										: { opacity: revealed ? 1 : 0.4, scale: revealed ? 1 : 0.8 }
								}
								initial={{ opacity: 0.4, scale: 0.8 }}
								transition={{
									duration: 0.25,
									delay: isActive ? cell.row * 0.015 : 0,
									ease: "easeOut",
								}}
							/>
						);
					}),
				)}
			</div>

			<div className="flex items-center gap-2 mt-auto">
				<div className="flex items-center">
					{AVATAR_GRADIENTS.map((grad, i) => (
						<div
							key={grad}
							className={`w-5 h-5 rounded-full bg-gradient-to-br ${grad} border-2 border-gray-1 shrink-0`}
							style={{ marginLeft: i === 0 ? 0 : -6 }}
						/>
					))}
				</div>
				<span className="text-gray-9 text-[11px]">
					Active contributors this week
				</span>
			</div>
		</div>
	);
};

export default OpenSourceArt;
