"use client";

import { useRef } from "react";
import { easeInOut, lerp, span, useSceneState } from "../../scenes/engine";
import { CANVAS, Ground, HUE, mix, RecordedWindow, useLoop } from "../shared";

const DARK = {
	card: "#1b1b1e",
	line: "rgba(255,255,255,0.08)",
	text1: "#f4f4f5",
	text2: "#9a9aa3",
	ctl: "rgba(255,255,255,0.06)",
	accent: "#0a84ff",
} as const;

const DURATION = 9000;
const MOVES = [
	{
		name: "Glide across",
		helper: "Move smoothly across the details",
		from: 0,
		to: 3000,
	},
	{
		name: "Unfold",
		helper: "Reveal your screen with a gentle tilt",
		from: 3000,
		to: 6000,
	},
	{
		name: "Pull back",
		helper: "Pull out to show the bigger picture",
		from: 6000,
		to: DURATION,
	},
] as const;

const WIN_SCALE = 0.85;
const WIN = {
	w: 360 * WIN_SCALE,
	h: 250 * WIN_SCALE,
	left: (CANVAS.w - 360 * WIN_SCALE) / 2,
	top: 30,
} as const;
const S = 1.3;
const ROW = { left: 24, top: 272, gap: 10 } as const;
const ROW_W = (CANVAS.w - ROW.left * 2) / S;
const CARD_W = (ROW_W - ROW.gap * 2) / 3;

type Pose = { ry: number; rx: number; tx: number; s: number };

const poseAt = (t: number): Pose => {
	if (t < 3000) {
		const f = easeInOut(span(t, 0, 3000));
		return { ry: lerp(-16, 16, f), rx: 0, tx: lerp(-26, 26, f), s: 1 };
	}
	if (t < 6000) {
		const f = easeInOut(span(t, 3000, 6000));
		const arc = Math.sin(f * Math.PI);
		return {
			ry: lerp(16, 0, f),
			rx: arc * 24,
			tx: lerp(26, 0, f),
			s: lerp(1, 0.97, arc),
		};
	}
	if (t < 8300) {
		const f = easeInOut(span(t, 6000, 8300));
		return {
			ry: lerp(0, -8, f),
			rx: lerp(0, 9, f),
			tx: lerp(0, -10, f),
			s: lerp(1, 0.8, f),
		};
	}
	const f = easeInOut(span(t, 8300, DURATION));
	return {
		ry: lerp(-8, -16, f),
		rx: lerp(9, 0, f),
		tx: lerp(-10, -26, f),
		s: lerp(0.8, 1, f),
	};
};

const moveAt = (t: number) =>
	MOVES.find((move) => t >= move.from && t < move.to)?.name ?? MOVES[0].name;

export const Visual = ({ playing }: { playing: boolean }) => {
	const groupRef = useRef<HTMLDivElement | null>(null);
	const sideRef = useRef<HTMLDivElement | null>(null);
	const topRef = useRef<HTMLDivElement | null>(null);
	const floorRef = useRef<HTMLDivElement | null>(null);
	const [ui, setUi] = useSceneState({ move: moveAt(0) });

	useLoop({
		duration: DURATION,
		playing,
		pose: 700,
		tick: (t) => {
			setUi({ move: moveAt(t) });
			const pose = poseAt(t);
			const tilt = Math.min(1, Math.abs(pose.ry) / 24);
			const lean = Math.min(1, Math.abs(pose.rx) / 24);
			if (groupRef.current) {
				groupRef.current.style.transform = `translateX(${pose.tx}px) scale(${pose.s}) rotateY(${pose.ry}deg) rotateX(${pose.rx}deg)`;
			}
			if (sideRef.current) {
				sideRef.current.style.opacity = `${tilt * 0.55}`;
				sideRef.current.style.background =
					pose.ry > 0
						? "linear-gradient(to right, rgba(9,12,20,0) 35%, rgba(9,12,20,0.8))"
						: "linear-gradient(to left, rgba(9,12,20,0) 35%, rgba(9,12,20,0.8))";
			}
			if (topRef.current) {
				topRef.current.style.opacity = `${lean * 0.5}`;
			}
			if (floorRef.current) {
				floorRef.current.style.transform = `translateX(${pose.tx * 1.15}px) scaleX(${0.7 + pose.s * 0.4}) scaleY(${pose.s})`;
				floorRef.current.style.opacity = `${0.5 + tilt * 0.3}`;
			}
		},
	});

	return (
		<Ground tone="dark">
			<div
				className="pointer-events-none absolute inset-0"
				style={{
					background:
						"radial-gradient(60% 52% at 50% 42%, rgba(99,102,241,0.16), rgba(99,102,241,0) 70%)",
				}}
			/>
			<div
				ref={floorRef}
				className="pointer-events-none absolute rounded-full"
				style={{
					left: WIN.left + 30,
					top: WIN.top + WIN.h + 4,
					width: WIN.w - 60,
					height: 30,
					background: `radial-gradient(50% 50% at 50% 50%, ${mix(HUE.threeD, 45, "transparent")}, rgba(99,102,241,0))`,
					filter: "blur(10px)",
					opacity: 0.5,
				}}
			/>
			<div
				className="absolute inset-0"
				style={{ perspective: 900, perspectiveOrigin: "50% 42%" }}
			>
				<div
					ref={groupRef}
					className="absolute inset-0 will-change-transform"
					style={{ transformStyle: "preserve-3d" }}
				>
					<RecordedWindow left={WIN.left} top={WIN.top} scale={WIN_SCALE} />
					<div
						ref={sideRef}
						className="pointer-events-none absolute rounded-[10px]"
						style={{
							left: WIN.left,
							top: WIN.top,
							width: WIN.w,
							height: WIN.h,
							opacity: 0,
						}}
					/>
					<div
						ref={topRef}
						className="pointer-events-none absolute rounded-[10px]"
						style={{
							left: WIN.left,
							top: WIN.top,
							width: WIN.w,
							height: WIN.h,
							opacity: 0,
							background:
								"linear-gradient(to bottom, rgba(9,12,20,0.7), rgba(9,12,20,0) 55%)",
						}}
					/>
				</div>
			</div>

			<div
				className="absolute flex"
				style={{
					left: ROW.left,
					top: ROW.top,
					width: ROW_W,
					gap: ROW.gap,
					transform: `scale(${S})`,
					transformOrigin: "top left",
				}}
			>
				{MOVES.map((move) => {
					const active = ui.move === move.name;
					return (
						<div
							key={move.name}
							className="flex flex-col gap-1 rounded-xl px-3 py-2.5 transition-[box-shadow,background-color] duration-300"
							style={{
								width: CARD_W,
								background: DARK.card,
								boxShadow: active
									? `inset 0 0 0 1.5px ${DARK.accent}`
									: `inset 0 0 0 1px ${DARK.line}`,
							}}
						>
							<span
								className="whitespace-nowrap text-[12px] font-medium"
								style={{ color: DARK.text1 }}
							>
								{move.name}
							</span>
							<span
								className="text-[10.5px] leading-[1.3]"
								style={{ color: DARK.text2 }}
							>
								{move.helper}
							</span>
						</div>
					);
				})}
			</div>
		</Ground>
	);
};
