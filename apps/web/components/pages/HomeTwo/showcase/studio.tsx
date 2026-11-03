"use client";

import {
	Captions,
	EyeOff,
	Image as ImageIcon,
	Video,
	ZoomIn,
} from "lucide-react";
import { type CSSProperties, type ReactNode, useRef } from "react";
import { copyOf, STUDIO_COPY } from "./copy";
import { CANVAS, lerp, type Scene, Showcase, seg, TONES } from "./kit";
import {
	AUTO_ZOOM,
	CLICK,
	CURSOR_SPRING,
	clickShrink,
	rawPath,
	sampleAt,
	simulate,
	snapToEdges,
	ZOOM_SPRING,
} from "./physics";
import {
	Cursor,
	FrameChip,
	INVOICE,
	INVOICE_SPOTS,
	InvoicePage,
	thumbOf,
	WALLPAPERS,
	Wallpaper,
	Webcam,
} from "./subjects";

const FRAME = { w: 744, h: 465 } as const;
const FRAME_LEFT = (CANVAS.w - FRAME.w) / 2;
const FRAME_TOP = 36;

const Frame = ({
	children,
	style,
}: {
	children: ReactNode;
	style?: CSSProperties;
}) => (
	<div
		className="absolute overflow-hidden rounded-[16px] shadow-[0_0_0_1px_rgba(17,17,17,0.08),0_24px_60px_-28px_rgba(17,17,17,0.35)]"
		style={{
			left: FRAME_LEFT,
			top: FRAME_TOP,
			width: FRAME.w,
			height: FRAME.h,
			...style,
		}}
	>
		{children}
	</div>
);

const fitRecording = (pad: number) => {
	const scale = Math.min(
		(FRAME.w - pad * 2) / INVOICE.w,
		(FRAME.h - pad * 2) / INVOICE.h,
	);
	const w = INVOICE.w * scale;
	const h = INVOICE.h * scale;
	return {
		scale,
		left: (FRAME.w - w) / 2,
		top: (FRAME.h - h) / 2,
		w,
		h,
	};
};

const Recording = ({
	pad,
	radius = 10,
	shadow = 1,
	children,
	page,
}: {
	pad: number;
	radius?: number;
	shadow?: number;
	children?: ReactNode;
	page?: ReactNode;
}) => {
	const box = fitRecording(pad);
	return (
		<div
			className="absolute overflow-hidden"
			style={{
				left: box.left,
				top: box.top,
				width: box.w,
				height: box.h,
				borderRadius: radius,
				boxShadow: `0 ${18 * shadow}px ${44 * shadow}px -16px rgba(0,0,0,${0.45 * shadow})`,
			}}
		>
			<div
				style={{
					width: INVOICE.w,
					height: INVOICE.h,
					transform: `scale(${box.scale})`,
					transformOrigin: "top left",
				}}
			>
				{page ?? <InvoicePage />}
			</div>
			{children}
		</div>
	);
};

const toFrame = (pad: number, x: number, y: number) => {
	const box = fitRecording(pad);
	return { x: box.left + x * box.scale, y: box.top + y * box.scale };
};

// Zoom, played the way an exported Cap plays it: the raw mouse path is
// smoothed by the cursor spring, a click opens an auto zoom segment 300 ms
// before it and closes it 2.5 s after, and the zoom amount and centre chase
// their targets on the editor's screen movement spring. Only the recording
// grows; the background stays put.
const ZOOM_PAD = 44;
const CLICK_AT = 1350;
const ZOOM_MS = 6800;
const ZOOM_SEGMENT = {
	start: CLICK_AT - AUTO_ZOOM.preMs,
	end: CLICK_AT + AUTO_ZOOM.postMs,
};
const SEND_CENTER = {
	x: INVOICE_SPOTS.send.x + INVOICE_SPOTS.send.w / 2 + 8,
	y: INVOICE_SPOTS.send.y + INVOICE_SPOTS.send.h / 2 + 2,
};
const mouse = rawPath([
	{ at: 0, x: 318, y: 214, hold: 250 },
	{ at: 1150, x: SEND_CENTER.x, y: SEND_CENTER.y, hold: 900 },
	{ at: 2900, x: 606, y: 292, hold: 1700 },
	{ at: 5700, x: 318, y: 214 },
]);
const CURSOR_SAMPLES = simulate(mouse, ZOOM_MS, CURSOR_SPRING);

const ZOOM_SAMPLES = (() => {
	let held = [0.5, 0.5];
	return simulate(
		(ms) => {
			const inside = ms >= ZOOM_SEGMENT.start && ms <= ZOOM_SEGMENT.end;
			if (inside) {
				const [mx = 0, my = 0] = sampleAt(CURSOR_SAMPLES, ms);
				held = [snapToEdges(mx / INVOICE.w), snapToEdges(my / INVOICE.h)];
				return [AUTO_ZOOM.amount, held[0] ?? 0.5, held[1] ?? 0.5];
			}
			return [1, held[0] ?? 0.5, held[1] ?? 0.5];
		},
		ZOOM_MS,
		ZOOM_SPRING,
	);
})();

const ZoomView = ({ t }: { t: number; playing: boolean }) => {
	const box = fitRecording(ZOOM_PAD);
	const [amount = 1, cx = 0.5, cy = 0.5] = sampleAt(ZOOM_SAMPLES, t);
	const [mx = 0, my = 0] = sampleAt(CURSOR_SAMPLES, t);
	const a = Math.max(1, amount);
	// SegmentBounds::from_amount_center: scale the display about its origin,
	// then slide it so the centre maps across the travel range.
	const w = box.w * a;
	const h = box.h * a;
	const left = box.left + cx * (1 - a) * box.w;
	const top = box.top + cy * (1 - a) * box.h;
	const sent = t > CLICK_AT + CLICK.ms ? 1 : 0;
	const pressed = t > CLICK_AT && t < CLICK_AT + CLICK.ms ? 1 : 0;
	return (
		<Frame>
			<Wallpaper src={WALLPAPERS.rome} />
			<div
				className="absolute overflow-hidden"
				style={{
					left,
					top,
					width: w,
					height: h,
					borderRadius: 10,
					boxShadow: "0 18px 44px -16px rgba(0,0,0,0.45)",
				}}
			>
				<div
					style={{
						width: INVOICE.w,
						height: INVOICE.h,
						transform: `scale(${box.scale * a})`,
						transformOrigin: "top left",
					}}
				>
					<InvoicePage sent={sent} press={pressed} />
				</div>
			</div>
			<Cursor
				x={left + (mx / INVOICE.w) * w}
				y={top + (my / INVOICE.h) * h}
				size={22 * a * clickShrink(t, CLICK_AT)}
			/>
			<FrameChip
				className="left-4 top-4 tabular-nums transition-opacity duration-300"
				style={{ opacity: a > 1.03 ? 1 : 0 }}
			>
				Auto zoom {a.toFixed(1)}x
			</FrameChip>
		</Frame>
	);
};

type Rect = { x: number; y: number; w: number; h: number; r: number };

type Layout = {
	name: string;
	screen: Rect;
	screenOpacity: number;
	camera: Rect;
	cameraOpacity: number;
};

const PAD = 40;
const SCREEN_FULL: Rect = {
	x: PAD,
	y: PAD,
	w: FRAME.w - PAD * 2,
	h: FRAME.h - PAD * 2,
	r: 10,
};

const LAYOUTS: Layout[] = [
	{
		name: "Screen and camera",
		screen: SCREEN_FULL,
		screenOpacity: 1,
		camera: { x: FRAME.w - 196, y: FRAME.h - 196, w: 164, h: 164, r: 82 },
		cameraOpacity: 1,
	},
	{
		name: "Split screen",
		screen: { x: 28, y: 92, w: 432, h: 281, r: 10 },
		screenOpacity: 1,
		camera: { x: 476, y: 92, w: 240, h: 281, r: 14 },
		cameraOpacity: 1,
	},
	{
		name: "Camera only",
		screen: { x: 28, y: 92, w: 432, h: 281, r: 10 },
		screenOpacity: 0,
		camera: { x: 0, y: 0, w: FRAME.w, h: FRAME.h, r: 0 },
		cameraOpacity: 1,
	},
	{
		name: "Screen only",
		screen: SCREEN_FULL,
		screenOpacity: 1,
		camera: { x: FRAME.w - 120, y: FRAME.h - 120, w: 80, h: 80, r: 40 },
		cameraOpacity: 0,
	},
];

const STEP = 2300;
const MORPH = 650;

const layoutAt = (t: number) =>
	Math.min(LAYOUTS.length - 1, Math.floor(t / STEP));

const MORPH_EASE = `${MORPH}ms cubic-bezier(0.65,0,0.35,1)`;
const morph = (props: string[]) =>
	props.map((prop) => `${prop} ${MORPH_EASE}`).join(", ");
const BOX = ["left", "top", "width", "height", "border-radius", "opacity"];

const ScenesView = ({
	t,
	playing,
	pick,
}: {
	t: number;
	playing: boolean;
	pick: number | null;
}) => {
	const layout = (LAYOUTS[pick ?? layoutAt(t)] ?? LAYOUTS[0]) as Layout;
	const { screen, camera } = layout;
	return (
		<Frame>
			<Wallpaper src={WALLPAPERS.santorini} />
			<div
				className="absolute overflow-hidden shadow-[0_18px_44px_-16px_rgba(0,0,0,0.45)]"
				style={{
					left: screen.x,
					top: screen.y,
					width: screen.w,
					height: screen.h,
					borderRadius: screen.r,
					opacity: layout.screenOpacity,
					transition: morph(BOX),
				}}
			>
				<div
					style={{
						width: INVOICE.w,
						height: INVOICE.h,
						transform: `scale(${screen.w / INVOICE.w})`,
						transformOrigin: "top left",
						transition: morph(["transform"]),
					}}
				>
					<InvoicePage />
				</div>
			</div>
			<Webcam
				playing={playing}
				className="absolute shadow-[0_18px_44px_-16px_rgba(0,0,0,0.5)]"
				style={{
					left: camera.x,
					top: camera.y,
					width: camera.w,
					height: camera.h,
					borderRadius: camera.r,
					opacity: layout.cameraOpacity,
					transition: morph(BOX),
				}}
			/>
			<FrameChip key={layout.name} className="ht-fade-in left-4 top-4">
				{layout.name}
			</FrameChip>
		</Frame>
	);
};

const LayoutGlyph = ({ kind }: { kind: number }) => (
	<svg aria-hidden="true" viewBox="0 0 24 18" className="h-[15px] w-5">
		<rect
			x="1"
			y="1"
			width="22"
			height="16"
			rx="3"
			fill="none"
			stroke="currentColor"
			strokeWidth="1.5"
		/>
		{kind === 0 ? (
			<>
				<rect
					x="4"
					y="4"
					width="11"
					height="8"
					rx="1"
					fill="currentColor"
					opacity="0.35"
				/>
				<circle cx="17.5" cy="12.5" r="2.6" fill="currentColor" />
			</>
		) : null}
		{kind === 1 ? (
			<>
				<rect
					x="3.5"
					y="5"
					width="9"
					height="8"
					rx="1"
					fill="currentColor"
					opacity="0.35"
				/>
				<rect
					x="14"
					y="5"
					width="6.5"
					height="8"
					rx="1.2"
					fill="currentColor"
				/>
			</>
		) : null}
		{kind === 2 ? <circle cx="12" cy="8" r="4" fill="currentColor" /> : null}
		{kind === 3 ? (
			<rect
				x="4"
				y="4"
				width="16"
				height="10"
				rx="1"
				fill="currentColor"
				opacity="0.35"
			/>
		) : null}
	</svg>
);

const LINES = [
	"So this is the new invoice flow.",
	"Pick the client,",
	"add your line items,",
	"and hit send.",
];
const WORD_MS = 300;
const LINE_GAP = 350;

const timeline = (() => {
	let at = 400;
	return LINES.map((line) => {
		const words = line.split(" ").map((word) => {
			const start = at;
			at += WORD_MS;
			return { word, start };
		});
		at += LINE_GAP;
		return words;
	});
})();
const CAPTIONS_END = (timeline.at(-1)?.at(-1)?.start ?? 0) + 1600;

const CaptionsView = ({ t, playing }: { t: number; playing: boolean }) => {
	const lineIndex = Math.max(
		0,
		timeline.findLastIndex((line) => (line[0]?.start ?? 0) <= t),
	);
	const line = (timeline[lineIndex] ?? []).filter(({ start }) => t >= start);
	return (
		<Frame>
			<Wallpaper src={WALLPAPERS.miami} />
			<Recording pad={40} />
			<Webcam
				playing={playing}
				className="absolute shadow-[0_18px_44px_-16px_rgba(0,0,0,0.5)]"
				style={{
					right: 56,
					top: 56,
					width: 112,
					height: 112,
					borderRadius: 56,
				}}
			/>
			<div className="absolute inset-x-0 bottom-[22px] flex justify-center">
				<div
					key={lineIndex}
					className="ht-fade-in flex rounded-[8px] bg-[rgba(0,0,0,0.9)] px-3 py-1.5 text-[19px] font-bold leading-[1.25] text-white"
				>
					{line.map(({ word, start }) => {
						const k = Math.min(1, Math.max(0, (t - start) / 250));
						const bounce = k < 1 ? 1 + Math.sin(k * Math.PI) * 0.12 : 1;
						return (
							<span
								key={`${word}-${start}`}
								className="inline-block px-[2.5px]"
								style={{
									opacity: k,
									transform: `translateY(${(1 - k) * 4}px) scale(${bounce})`,
								}}
							>
								{word}
							</span>
						);
					})}
				</div>
			</div>
		</Frame>
	);
};

type MaskMode = "Blur" | "Pixelate" | "Highlight";
const MASK_MODES: MaskMode[] = ["Blur", "Pixelate", "Highlight"];

const Mosaic = ({ w, h }: { w: number; h: number }) => {
	const size = 8;
	const cols = Math.ceil(w / size);
	const rows = Math.ceil(h / size);
	const tones = ["#C9CDD4", "#E3E6EA", "#AEB3BC", "#D6D9DE", "#9CA2AC"];
	return (
		<div className="absolute inset-0 flex flex-wrap">
			{Array.from({ length: rows * cols }, (_, n) => ({
				id: `cell-${n}`,
				tone: tones[(((n * 2654435761) >>> 0) % 97) % tones.length],
			})).map((cell) => (
				<span
					key={cell.id}
					style={{
						width: size,
						height: size,
						background: cell.tone,
					}}
				/>
			))}
		</div>
	);
};

const BlurView = ({ t }: { t: number; playing: boolean }) => {
	const pad = 28;
	const box = fitRecording(pad);
	const email = INVOICE_SPOTS.email;
	const draw = seg(t, 500, 1400);
	const modeIndex = t < 3200 ? 0 : t < 5200 ? 1 : 2;
	const mode = MASK_MODES[modeIndex] ?? "Blur";
	const blurAmount = seg(t, 1400, 1900) * 7;
	const x = box.left + (email.x - 6) * box.scale;
	const y = box.top + (email.y - 6) * box.scale;
	const fullW = (email.w + 12) * box.scale;
	const h = (email.h + 12) * box.scale;
	const w = fullW * draw;
	const pickerX = x + fullW / 2;
	const cursorStart = toFrame(pad, email.x - 4, email.y - 4);
	const cursorEnd = toFrame(pad, email.x + email.w + 6, email.y + email.h + 6);
	const cursorK = seg(t, 400, 1400);
	const cursorAway = seg(t, 1600, 2400);
	const privacy: CSSProperties =
		mode === "Blur" ? { filter: `blur(${blurAmount}px)` } : {};
	return (
		<Frame>
			<Wallpaper src={WALLPAPERS.london} />
			<Recording pad={pad} page={<InvoicePage emailStyle={privacy} />} />
			{mode === "Pixelate" ? (
				<div
					className="absolute overflow-hidden rounded-[4px]"
					style={{ left: x, top: y, width: fullW, height: h }}
				>
					<Mosaic w={fullW} h={h} />
				</div>
			) : null}
			{mode === "Highlight" ? (
				<div
					className="absolute rounded-[6px]"
					style={{
						left: x,
						top: y,
						width: fullW,
						height: h,
						boxShadow: "0 0 0 2000px rgba(10,12,16,0.55)",
					}}
				/>
			) : null}
			{draw > 0 ? (
				<div
					className="absolute rounded-[6px] border-[1.5px] border-[#FF4766]"
					style={{ left: x, top: y, width: w, height: h }}
				/>
			) : null}
			<div
				className="absolute flex -translate-x-1/2 gap-0.5 rounded-full bg-white p-1 text-[13px] shadow-[0_8px_24px_-8px_rgba(0,0,0,0.35),0_0_0_1px_rgba(0,0,0,0.06)] transition-opacity duration-300"
				style={{
					left: pickerX,
					top: y + h + 12,
					opacity: draw >= 1 ? 1 : 0,
				}}
			>
				{MASK_MODES.map((item) => (
					<span
						key={item}
						className="rounded-full px-3 py-1 transition-colors duration-200"
						style={{
							background: item === mode ? "#111111" : "transparent",
							color: item === mode ? "#FFFFFF" : "#555A63",
						}}
					>
						{item}
					</span>
				))}
			</div>
			<Cursor
				x={lerp(
					lerp(cursorStart.x, cursorEnd.x, cursorK),
					cursorEnd.x + 60,
					cursorAway,
				)}
				y={lerp(
					lerp(cursorStart.y, cursorEnd.y, cursorK),
					cursorEnd.y + 90,
					cursorAway,
				)}
				size={24}
				opacity={1 - cursorAway}
			/>
		</Frame>
	);
};

const SWATCHES = [
	WALLPAPERS.rome,
	WALLPAPERS.santorini,
	"linear-gradient(135deg,#C3DCF8 0%,#DACBF9 55%,#F6D9EC 100%)",
	"#1C1D21",
	WALLPAPERS.monaco,
];

const SWATCH_NAMES = [
	"Rome",
	"Santorini",
	"Soft gradient",
	"Charcoal",
	"Monaco",
];

const swatchBg = (value: string): CSSProperties =>
	value.startsWith("/")
		? {
				backgroundImage: `url(${value})`,
				backgroundSize: "cover",
				backgroundPosition: "center",
			}
		: { background: value };

const BG_FIRST = 1900;
const BG_EACH = 1300;
const backgroundAt = (t: number) =>
	t < BG_FIRST
		? 0
		: Math.min(SWATCHES.length - 1, Math.floor((t - BG_FIRST) / BG_EACH) + 1);

const BackgroundView = ({
	t,
	pick,
}: {
	t: number;
	playing: boolean;
	pick: number | null;
}) => {
	const grow = pick === null ? seg(t, 600, 1700) : 1;
	const pad = lerp(0, 48, grow);
	const index = pick ?? backgroundAt(t);
	// Only fetch a wallpaper once it has been shown, then keep it for the fade.
	const seen = useRef(new Set<number>());
	seen.current.add(index);
	return (
		<Frame style={{ background: "#F7F7F8" }}>
			{SWATCHES.map((swatch, n) =>
				seen.current.has(n) ? (
					<div
						key={swatch}
						className="absolute inset-0 transition-opacity duration-500"
						style={{ ...swatchBg(swatch), opacity: n === index ? grow : 0 }}
					/>
				) : null,
			)}
			<Recording pad={pad} radius={lerp(0, 12, grow)} shadow={grow} />
		</Frame>
	);
};

const SCENES: Scene[] = [
	{
		key: "zoom",
		label: copyOf(STUDIO_COPY, "zoom").label,
		icon: <ZoomIn />,
		lead: copyOf(STUDIO_COPY, "zoom").lead,
		body: copyOf(STUDIO_COPY, "zoom").body,
		duration: ZOOM_MS,
		pose: 2600,
		View: ZoomView,
	},
	{
		key: "layouts",
		label: copyOf(STUDIO_COPY, "layouts").label,
		icon: <Video />,
		picker: {
			options: LAYOUTS.map((layout, i) => ({
				key: layout.name,
				label: layout.name,
				icon: <LayoutGlyph kind={i} />,
			})),
			at: layoutAt,
		},
		lead: copyOf(STUDIO_COPY, "layouts").lead,
		body: copyOf(STUDIO_COPY, "layouts").body,
		duration: STEP * LAYOUTS.length,
		pose: STEP + MORPH,
		View: ScenesView,
	},
	{
		key: "captions",
		label: copyOf(STUDIO_COPY, "captions").label,
		icon: <Captions />,
		lead: copyOf(STUDIO_COPY, "captions").lead,
		body: copyOf(STUDIO_COPY, "captions").body,
		duration: CAPTIONS_END,
		pose: 2400,
		View: CaptionsView,
	},
	{
		key: "blur",
		label: copyOf(STUDIO_COPY, "blur").label,
		icon: <EyeOff />,
		lead: copyOf(STUDIO_COPY, "blur").lead,
		body: copyOf(STUDIO_COPY, "blur").body,
		duration: 7200,
		pose: 2600,
		View: BlurView,
	},
	{
		key: "background",
		label: copyOf(STUDIO_COPY, "background").label,
		icon: <ImageIcon />,
		picker: {
			options: SWATCHES.map((swatch, i) => ({
				key: swatch,
				label: SWATCH_NAMES[i] ?? "Background",
				icon: (
					<span
						className="block size-full rounded-full"
						style={swatchBg(swatch.startsWith("/") ? thumbOf(swatch) : swatch)}
					/>
				),
			})),
			at: backgroundAt,
			swatches: true,
		},
		lead: copyOf(STUDIO_COPY, "background").lead,
		body: copyOf(STUDIO_COPY, "background").body,
		duration: BG_FIRST + BG_EACH * 4 + 900,
		pose: 3400,
		View: BackgroundView,
	},
];

export const StudioStage = () => (
	<Showcase scenes={SCENES} tone={TONES.studio} />
);
