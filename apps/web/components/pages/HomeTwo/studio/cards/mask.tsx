"use client";

import { useRef } from "react";
import {
	easeOut,
	lerp,
	span,
	useCursor,
	useSceneState,
	type Way,
} from "../../scenes/engine";
import { ED, Ground, RecordedWindow, Segmented, useLoop } from "../shared";

/* Blur what is private: the mask is drawn on the canvas exactly as the
 * editor draws it (2px #202020 box, black handles), and the real choices
 * follow: Sensitive or Highlight, then the Effect, Blur or Pixelate. */

const WIN = { left: 40, top: 44, scale: 1.45 };
const MASK = {
	x: WIN.left + Math.round(72 * WIN.scale),
	y: WIN.top + Math.round(112 * WIN.scale),
	w: Math.round(268 * WIN.scale),
	h: Math.round(52 * WIN.scale),
};
const DURATION = 8200;
const DRAG = { start: 600, end: 1700 };
const BLUR_AT = 1900;
const PIXELATE_AT = 3600;
const HIGHLIGHT_AT = 5400;
const KIND = ["Sensitive", "Highlight"] as const;
const EFFECT = ["Blur", "Pixelate"] as const;
const ITEM_W = 78;
const CARD = { x: MASK.x, y: MASK.y + MASK.h + 12, pad: 8, gap: 12 };
const kindCenter = (i: number) => ({
	x: CARD.x + CARD.pad + 2 + ITEM_W * (i + 0.5),
	y: CARD.y + CARD.pad + 2 + 13,
});
const EFFECT_X = CARD.x + CARD.pad + ITEM_W * 2 + 4 + CARD.gap + 46;
const effectCenter = (i: number) => ({
	x: EFFECT_X + 2 + ITEM_W * (i + 0.5),
	y: CARD.y + CARD.pad + 2 + 13,
});

const PATH: Way[] = [
	{ t: 0, x: MASK.x - 40, y: MASK.y - 30 },
	{ t: DRAG.start, x: MASK.x, y: MASK.y },
	{ t: DRAG.end, x: MASK.x + MASK.w, y: MASK.y + MASK.h },
	{ t: BLUR_AT, x: MASK.x + MASK.w, y: MASK.y + MASK.h },
	{ t: 3400, ...effectCenter(1) },
	{ t: PIXELATE_AT, ...effectCenter(1), click: true },
	{ t: 5200, ...kindCenter(1) },
	{ t: HIGHLIGHT_AT, ...kindCenter(1), click: true },
	{ t: 6600, x: MASK.x + MASK.w + 40, y: CARD.y + 70 },
	{ t: DURATION, x: MASK.x + MASK.w + 40, y: CARD.y + 70 },
];

const PIXELS = Array.from({ length: 22 * 4 }, (_, i) => {
	const seed = Math.sin(i * 12.9898 + 4.1414) * 43758.5453;
	const v = seed - Math.floor(seed);
	const l = 62 + Math.floor(v * 30);
	return `hsl(216 22% ${l}%)`;
});

const HANDLES = [
	[0, 0],
	[0.5, 0],
	[1, 0],
	[0, 0.5],
	[1, 0.5],
	[0, 1],
	[0.5, 1],
	[1, 1],
] as const;

const uiAt = (t: number) => ({
	drawing: t >= DRAG.start && t < BLUR_AT,
	kind: t >= HIGHLIGHT_AT ? "Highlight" : t >= BLUR_AT ? "Sensitive" : null,
	effect: t >= PIXELATE_AT ? "Pixelate" : "Blur",
});

export const Visual = ({ playing }: { playing: boolean }) => {
	const rootRef = useRef<HTMLDivElement | null>(null);
	const boxRef = useRef<HTMLDivElement | null>(null);
	const [ui, setUi] = useSceneState(uiAt(0));
	const cursor = useCursor(rootRef);

	useLoop({
		duration: DURATION,
		playing,
		pose: 4400,
		tick: (t, seek) => {
			setUi(uiAt(t));
			const drag = easeOut(span(t, DRAG.start, DRAG.end));
			if (boxRef.current) {
				boxRef.current.style.width = `${lerp(0, MASK.w, drag)}px`;
				boxRef.current.style.height = `${lerp(0, MASK.h, drag)}px`;
				boxRef.current.style.opacity = t >= DRAG.start ? "1" : "0";
			}
			cursor.tick(PATH, t, seek);
		},
	});

	const applied = ui.kind !== null;
	const highlight = ui.kind === "Highlight";
	const blur = applied && !highlight && ui.effect === "Blur";
	const pixelate = applied && !highlight && ui.effect === "Pixelate";

	return (
		<div ref={rootRef} className="relative">
			<Ground tone="light">
				<RecordedWindow left={WIN.left} top={WIN.top} scale={WIN.scale} />

				<div
					ref={boxRef}
					className="pointer-events-none absolute z-20 overflow-hidden rounded-md"
					style={{
						left: MASK.x,
						top: MASK.y,
						width: 0,
						height: 0,
						opacity: 0,
						border: `2px ${applied ? "solid" : "dashed"} #202020`,
						boxShadow: highlight
							? "0 0 0 9999px rgba(9,12,20,0.5)"
							: "0 0 0 9999px rgba(9,12,20,0)",
						transition: "box-shadow 420ms ease",
					}}
				>
					<div
						className="absolute inset-0 transition-opacity duration-300"
						style={{
							opacity: blur ? 1 : 0,
							backdropFilter: "blur(10px) saturate(1.2)",
							WebkitBackdropFilter: "blur(10px) saturate(1.2)",
							background: "rgba(236,240,246,0.35)",
						}}
					/>
					<div
						className="absolute inset-0 grid transition-opacity duration-300"
						style={{
							opacity: pixelate ? 1 : 0,
							gridTemplateColumns: "repeat(22, 1fr)",
							gridTemplateRows: "repeat(4, 1fr)",
						}}
					>
						{PIXELS.map((color, i) => (
							<span key={`${i}-${color}`} style={{ background: color }} />
						))}
					</div>
				</div>

				{HANDLES.map(([fx, fy]) => (
					<span
						key={`${fx}-${fy}`}
						className="pointer-events-none absolute z-30 size-3 rounded-full border border-white transition-opacity duration-300"
						style={{
							left: MASK.x + MASK.w * fx - 6,
							top: MASK.y + MASK.h * fy - 6,
							background: "#202020",
							opacity: applied ? 1 : 0,
						}}
					/>
				))}

				<div
					className="absolute z-30 flex items-center rounded-xl transition-[opacity,transform] duration-300"
					style={{
						left: CARD.x,
						top: CARD.y,
						padding: CARD.pad,
						gap: CARD.gap,
						background: ED.card,
						boxShadow: ED.popShadow,
						opacity: applied ? 1 : 0,
						transform: applied ? "translateY(0)" : "translateY(6px)",
					}}
				>
					<Segmented options={KIND} value={ui.kind} itemWidth={ITEM_W} />
					<div className="flex items-center gap-2">
						<span
							className="text-[12px] font-medium"
							style={{ color: ED.text2 }}
						>
							Effect
						</span>
						<Segmented
							options={EFFECT}
							value={ui.effect}
							itemWidth={ITEM_W}
							disabled={highlight}
						/>
					</div>
				</div>
				{cursor.Cursor}
			</Ground>
		</div>
	);
};
