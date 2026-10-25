"use client";

import { clamp01, Loop, lerp, seg, TONES } from "./kit";
import { INVOICE, InvoicePage } from "./subjects";

export const CANVAS = { w: 640, h: 520 } as const;

const INK = "#F43F5E";

const WIN = { x: 55, y: 96, scale: 0.78 } as const;

const CROP = { x: 364, y: 277, w: 304, h: 133 } as const;

const PAD = 34;
const IMG = { x: 84, y: 172, w: 472 } as const;
const SCALE_OUT = IMG.w / CROP.w;
const IMG_H = CROP.h * SCALE_OUT;
const CARD = {
	x: IMG.x - PAD,
	y: IMG.y - PAD,
	w: IMG.w + PAD * 2,
	h: IMG_H + PAD * 2,
};

const at = (px: number, py: number) => ({
	x: IMG.x + (px - CROP.x) * SCALE_OUT,
	y: IMG.y + (py - CROP.y) * SCALE_OUT,
});

const SEL = {
	x: WIN.x + CROP.x * WIN.scale,
	y: WIN.y + CROP.y * WIN.scale,
	w: CROP.w * WIN.scale,
	h: CROP.h * WIN.scale,
};

type Pt = { x: number; y: number };

/**
 * A marker arrow built from its geometry: a curved shaft that stops at the
 * base of the head, and a head aimed along the curve's tangent at the tip,
 * so the two always meet cleanly whatever the angle.
 */
const Arrow = ({
	from,
	ctrl,
	to,
	k,
	width = 5,
	head = 17,
}: {
	from: Pt;
	ctrl: Pt;
	to: Pt;
	k: number;
	width?: number;
	head?: number;
}) => {
	const dx = to.x - ctrl.x;
	const dy = to.y - ctrl.y;
	const len = Math.hypot(dx, dy) || 1;
	const ux = dx / len;
	const uy = dy / len;
	const base = { x: to.x - ux * head, y: to.y - uy * head };
	const wing = head * 0.62;
	const left = { x: base.x - uy * wing, y: base.y + ux * wing };
	const right = { x: base.x + uy * wing, y: base.y - ux * wing };
	const shaft = Math.min(1, k / 0.82);
	const tip = seg(k, 0.8, 1);
	return (
		<g>
			<path
				d={`M ${from.x} ${from.y} Q ${ctrl.x} ${ctrl.y} ${base.x} ${base.y}`}
				fill="none"
				stroke={INK}
				strokeWidth={width}
				strokeLinecap="round"
				pathLength={1}
				strokeDasharray={1}
				strokeDashoffset={1 - shaft}
			/>
			<path
				d={`M ${to.x} ${to.y} L ${left.x} ${left.y} L ${right.x} ${right.y} Z`}
				fill={INK}
				stroke={INK}
				strokeWidth={2.5}
				strokeLinejoin="round"
				style={{
					opacity: tip > 0 ? 1 : 0,
					transform: `scale(${0.4 + tip * 0.6})`,
					transformOrigin: `${to.x}px ${to.y}px`,
				}}
			/>
		</g>
	);
};

const Box = ({
	x,
	y,
	w,
	h,
	k,
}: {
	x: number;
	y: number;
	w: number;
	h: number;
	k: number;
}) => (
	<rect
		x={x}
		y={y}
		width={w}
		height={h}
		rx={10}
		fill="none"
		stroke={INK}
		strokeWidth={4}
		strokeLinecap="round"
		pathLength={1}
		strokeDasharray={1}
		strokeDashoffset={1 - k}
	/>
);

const Handle = ({ x, y }: Pt) => (
	<span
		className="absolute size-[9px] -translate-x-1/2 -translate-y-1/2 rounded-full border-[1.5px] border-white bg-[#2563EB] shadow-[0_1px_2px_rgba(0,0,0,0.3)]"
		style={{ left: x, top: y }}
	/>
);

const Crosshair = ({ x, y }: Pt) => (
	<svg
		aria-hidden="true"
		className="absolute z-30 -translate-x-1/2 -translate-y-1/2"
		style={{ left: x, top: y }}
		width={23}
		height={23}
		viewBox="0 0 23 23"
	>
		<path d="M11.5 0v23M0 11.5h23" stroke="#FFFFFF" strokeWidth={3.5} />
		<path d="M11.5 0v23M0 11.5h23" stroke="#111111" strokeWidth={1.5} />
	</svg>
);

const TOOLS = [
	{
		key: "box",
		d: "M5 5h14v14H5z",
	},
	{
		key: "arrow",
		d: "M6 18 18 6M9 6h9v9",
	},
	{
		key: "text",
		d: "M6 6h12M12 6v13",
	},
	{
		key: "blur",
		d: "M4 4h16v16H4zM4 12h16M12 4v16M4 4h8v8H4zM12 12h8v8h-8z",
	},
] as const;

const Toolbar = ({ active, k }: { active: string | null; k: number }) => (
	<div
		className="absolute flex -translate-x-1/2 items-center gap-1 rounded-[14px] bg-white p-1.5 shadow-[0_0_0_1px_rgba(17,17,17,0.07),0_12px_28px_-12px_rgba(17,24,39,0.35)]"
		style={{
			left: CANVAS.w / 2,
			top: CARD.y - 64,
			opacity: k,
			transform: `translate(-50%, ${(1 - k) * 8}px)`,
		}}
	>
		{TOOLS.map((tool) => {
			const on = tool.key === active;
			return (
				<span
					key={tool.key}
					className="grid size-9 place-items-center rounded-[10px] transition-colors duration-200"
					style={{
						background: on ? "#FFE4E8" : "transparent",
						color: on ? INK : "#5B6069",
					}}
				>
					<svg
						aria-hidden="true"
						viewBox="0 0 24 24"
						className="size-[18px]"
						fill="none"
						stroke="currentColor"
						strokeWidth={2}
						strokeLinecap="round"
						strokeLinejoin="round"
					>
						<path d={tool.d} />
					</svg>
				</span>
			);
		})}
		<span className="mx-1 h-5 w-px bg-[#E5E7EB]" />
		<span className="size-5 rounded-full" style={{ background: INK }} />
		<span className="ml-1 mr-1.5 text-[13px] text-[#1C1D21]">Copy</span>
	</div>
);

const LABEL = "Ready to send";

const ScreenshotView = ({ t }: { t: number; playing: boolean }) => {
	const drag = seg(t, 450, 1350);
	const flash = t > 1420 && t < 1760 ? 1 - (t - 1420) / 340 : 0;
	const lift = seg(t, 1600, 2500);
	const tools = seg(t, 2400, 2750);
	const boxK = seg(t, 2900, 3450);
	const arrowK = clamp01((t - 3600) / 650);
	const typed = LABEL.slice(0, Math.max(0, Math.floor((t - 4400) / 55)));
	const toast = seg(t, 5300, 5600) * (1 - seg(t, 7000, 7300));
	const active =
		t > 2800 && t < 3500
			? "box"
			: t > 3500 && t < 4350
				? "arrow"
				: t > 4350 && t < 5300
					? "text"
					: null;

	const crop = {
		x: lerp(SEL.x, IMG.x, lift),
		y: lerp(SEL.y, IMG.y, lift),
		w: lerp(SEL.w, IMG.w, lift),
		h: lerp(SEL.h, IMG_H, lift),
	};
	const scale = crop.w / CROP.w;
	const card = {
		x: lerp(crop.x, CARD.x, lift),
		y: lerp(crop.y, CARD.y, lift),
		w: lerp(crop.w, CARD.w, lift),
		h: lerp(crop.h, CARD.h, lift),
	};

	const selW = SEL.w * drag;
	const selH = SEL.h * drag;
	const capturing = drag > 0 && t < 1600;

	const total = { a: at(564, 276), b: at(660, 307) };
	const tail = at(394, 318);
	const tip = at(515, 378);
	const ctrl = at(404, 390);
	const label = at(376, 284);

	return (
		<div className="absolute inset-0 overflow-hidden">
			<div
				className="absolute overflow-hidden rounded-[10px] shadow-[0_0_0_1px_rgba(0,0,0,0.08),0_18px_44px_-20px_rgba(17,24,39,0.45)]"
				style={{
					left: WIN.x,
					top: WIN.y,
					width: INVOICE.w * WIN.scale,
					height: INVOICE.h * WIN.scale,
					opacity: 1 - lift,
				}}
			>
				<div
					style={{
						width: INVOICE.w,
						height: INVOICE.h,
						transform: `scale(${WIN.scale})`,
						transformOrigin: "top left",
					}}
				>
					<InvoicePage />
				</div>
			</div>

			{capturing ? (
				<>
					<div
						className="absolute inset-0 bg-[rgba(17,17,17,0.16)]"
						style={{
							clipPath: `polygon(0 0, 100% 0, 100% 100%, 0 100%, 0 ${SEL.y}px, ${SEL.x}px ${SEL.y}px, ${SEL.x}px ${SEL.y + selH}px, ${SEL.x + selW}px ${SEL.y + selH}px, ${SEL.x + selW}px ${SEL.y}px, 0 ${SEL.y}px)`,
						}}
					/>
					<div
						className="absolute border border-white shadow-[0_0_0_1px_rgba(37,99,235,0.6)]"
						style={{ left: SEL.x, top: SEL.y, width: selW, height: selH }}
					/>
					{drag >= 1 ? (
						<>
							<Handle x={SEL.x} y={SEL.y} />
							<Handle x={SEL.x + SEL.w} y={SEL.y} />
							<Handle x={SEL.x} y={SEL.y + SEL.h} />
							<Handle x={SEL.x + SEL.w} y={SEL.y + SEL.h} />
						</>
					) : null}
					<div
						className="absolute whitespace-nowrap rounded-[6px] bg-[rgba(17,17,17,0.86)] px-2 py-[3px] text-[11.5px] tabular-nums text-white"
						style={{
							left: SEL.x + selW,
							top: SEL.y + selH + 12,
							transform: "translateX(-100%)",
						}}
					>
						{Math.round((selW / WIN.scale) * 2)} ×{" "}
						{Math.round((selH / WIN.scale) * 2)}
					</div>
					<Crosshair x={SEL.x + selW} y={SEL.y + selH} />
				</>
			) : null}
			{t < 450 ? <Crosshair x={SEL.x} y={SEL.y} /> : null}

			<div
				className="absolute overflow-hidden"
				style={{
					left: card.x,
					top: card.y,
					width: card.w,
					height: card.h,
					borderRadius: 18 * lift,
					opacity: lift,
					background:
						"radial-gradient(120% 140% at 0% 0%, #A7F3D0 0%, transparent 55%), radial-gradient(120% 140% at 100% 100%, #93C5FD 0%, transparent 55%), linear-gradient(135deg, #6EE7B7 0%, #60A5FA 100%)",
					boxShadow: `0 ${30 * lift}px ${60 * lift}px -30px rgba(17,24,39,0.45)`,
				}}
			/>

			{t >= 1420 ? (
				<div
					className="absolute overflow-hidden bg-white"
					style={{
						left: crop.x,
						top: crop.y,
						width: crop.w,
						height: crop.h,
						borderRadius: lerp(2, 12, lift),
						boxShadow: `0 ${10 * lift}px ${30 * lift}px -12px rgba(17,24,39,${0.4 * lift})`,
					}}
				>
					<div
						style={{
							width: INVOICE.w,
							height: INVOICE.h,
							transform: `scale(${scale}) translate(${-CROP.x}px, ${-CROP.y}px)`,
							transformOrigin: "top left",
						}}
					>
						<InvoicePage />
					</div>
				</div>
			) : null}

			<Toolbar active={active} k={tools} />

			<svg
				aria-hidden="true"
				className="pointer-events-none absolute inset-0"
				width={CANVAS.w}
				height={CANVAS.h}
			>
				{boxK > 0 ? (
					<Box
						x={total.a.x}
						y={total.a.y}
						w={total.b.x - total.a.x}
						h={total.b.y - total.a.y}
						k={boxK}
					/>
				) : null}
				{arrowK > 0 ? (
					<Arrow from={tail} ctrl={ctrl} to={tip} k={arrowK} />
				) : null}
			</svg>

			{typed ? (
				<div
					className="absolute text-[19px] font-bold tracking-[-0.01em]"
					style={{ left: label.x, top: label.y, color: INK }}
				>
					{typed}
					{typed.length < LABEL.length ? (
						<span className="ml-0.5 inline-block h-[18px] w-[2px] translate-y-[3px] bg-current" />
					) : null}
				</div>
			) : null}

			<div
				className="absolute inset-0 bg-white"
				style={{ opacity: flash * 0.85 }}
			/>

			<div
				className="absolute left-1/2 flex items-center gap-2.5 rounded-full bg-[#111111] py-1.5 pl-1.5 pr-4 text-[14px] text-white shadow-[0_12px_30px_-12px_rgba(0,0,0,0.5)]"
				style={{
					top: CARD.y + CARD.h + 26,
					opacity: toast,
					transform: `translate(-50%, ${(1 - toast) * 10}px)`,
				}}
			>
				<span className="grid size-6 place-items-center rounded-full bg-[#22C55E]">
					<svg aria-hidden="true" viewBox="0 0 16 16" className="size-3.5">
						<path
							d="M3.5 8.5l3 3 6-7"
							fill="none"
							stroke="#FFFFFF"
							strokeWidth={2.2}
							strokeLinecap="round"
							strokeLinejoin="round"
						/>
					</svg>
				</span>
				Copied to clipboard
			</div>
		</div>
	);
};

export const ScreenshotStage = () => (
	<Loop
		View={ScreenshotView}
		duration={7600}
		pose={6200}
		canvas={CANVAS}
		tone={TONES.screenshot}
	/>
);
