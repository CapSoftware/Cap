"use client";

import { classNames } from "@cap/utils/helpers";
import { Check, MoveUpRight, Square, Type } from "lucide-react";
import { useRef } from "react";
import { CapLogoMark } from "../demo/capIcons";
import { ContentWindow } from "../demo/MacDesktop";
import { SCENE_META } from "./catalog";
import {
	easeOut,
	lerp,
	Reveal,
	type SceneModule,
	type SceneProps,
	Stage,
	span,
	useCursor,
	useSceneClock,
	useSceneState,
	type Way,
} from "./engine";

const CHAPTERS = SCENE_META.screenshot.chapters;

const WALLPAPER = "/backgrounds/london.webp";

const POS = {
	content: { left: 120, top: 44, width: 440, height: 330 },
	result: { left: 130, top: 60, width: 420, height: 300 },
	notification: { left: 322, top: 10 },
	toolbar: { left: 130 + (420 - 196) / 2, top: 374 },
};

const MARQUEE = {
	x0: 112,
	y0: 36,
	x1: 568,
	y1: 382,
};

const DRAG = { start: 300, end: 1600 };
const ARROW = { from: { x: 300, y: 150 }, to: { x: 410, y: 215 } };
const DRAW = { start: 7100, end: 8100 };

const PATH: Way[] = [
	{ t: 0, x: MARQUEE.x0, y: MARQUEE.y0 },
	{ t: DRAG.start, x: MARQUEE.x0, y: MARQUEE.y0 },
	{ t: DRAG.end, x: MARQUEE.x1, y: MARQUEE.y1 },
	{ t: 1700, x: MARQUEE.x1, y: MARQUEE.y1 },
	{ t: 2800, x: 610, y: 430 },
	{ t: 4600, x: 610, y: 430 },
	{ t: 5700, at: "annotate-arrow" },
	{ t: 6000, at: "annotate-arrow" },
	{ t: 6200, at: "annotate-arrow", click: true },
	{ t: 7000, x: ARROW.from.x, y: ARROW.from.y },
	{ t: DRAW.start, x: ARROW.from.x, y: ARROW.from.y },
	{ t: DRAW.end, x: ARROW.to.x, y: ARROW.to.y },
	{ t: 8300, x: ARROW.to.x, y: ARROW.to.y },
	{ t: 9200, at: "annotate-done" },
	{ t: 9300, at: "annotate-done", click: true },
	{ t: 10200, x: 600, y: 440 },
	{ t: 12000, x: 600, y: 440 },
];

const uiAt = (t: number) => ({
	marquee: t >= DRAG.start && t < 1750,
	flash: t >= 1700 && t < 2050,
	result: t >= 2050,
	captured: t >= 2900 && t < 6000,
	toolbar: t >= 6050,
	arrowTool: t >= 6200,
	drawing: t >= DRAW.start,
	copied: t >= 9400,
});

const Notification = ({ show, title }: { show: boolean; title: string }) => (
	<Reveal
		show={show}
		from="translateX(24px)"
		className="z-40"
		style={POS.notification}
	>
		<div
			className="flex w-[344px] items-center gap-3 rounded-2xl p-3"
			style={{
				background: "rgba(245,245,245,0.92)",
				border: "1px solid rgba(0,0,0,0.06)",
				boxShadow: "0 12px 32px rgba(0,0,0,0.22), 0 2px 8px rgba(0,0,0,0.1)",
			}}
		>
			<CapLogoMark className="size-9 shrink-0" />
			<span className="min-w-0 flex-1 leading-tight">
				<p
					className="truncate text-[13px] font-semibold"
					style={{ color: "#1d1d1f" }}
				>
					{title}
				</p>
				<p className="truncate text-[13px]" style={{ color: "#48484a" }}>
					Copied to clipboard
				</p>
			</span>
			<span className="self-start text-[11px]" style={{ color: "#86868b" }}>
				now
			</span>
		</div>
	</Reveal>
);

export const ScreenshotScene = (props: SceneProps) => {
	const layerRef = useRef<HTMLDivElement | null>(null);
	const scrollRef = useRef<HTMLDivElement | null>(null);
	const resultScrollRef = useRef<HTMLDivElement | null>(null);
	const marqueeRef = useRef<HTMLDivElement | null>(null);
	const sizeRef = useRef<HTMLSpanElement | null>(null);
	const arrowRef = useRef<SVGSVGElement | null>(null);
	const [ui, setUi] = useSceneState(uiAt(0));
	const cursor = useCursor(layerRef);

	useSceneClock({
		...props,
		chapters: CHAPTERS,
		tick: (t, seek) => {
			setUi(uiAt(t));
			const drag = easeOut(span(t, DRAG.start, DRAG.end));
			const width = lerp(0, MARQUEE.x1 - MARQUEE.x0, drag);
			const height = lerp(0, MARQUEE.y1 - MARQUEE.y0, drag);
			if (marqueeRef.current) {
				marqueeRef.current.style.width = `${width}px`;
				marqueeRef.current.style.height = `${height}px`;
			}
			if (sizeRef.current) {
				sizeRef.current.textContent = `${Math.round(width)} × ${Math.round(
					height,
				)}`;
			}
			if (arrowRef.current) {
				const draw = span(t, DRAW.start, DRAW.end);
				const x = lerp(ARROW.from.x, ARROW.to.x, draw);
				const y = lerp(ARROW.from.y, ARROW.to.y, draw);
				const line = arrowRef.current.querySelector("line");
				const head = arrowRef.current.querySelector("polygon");
				line?.setAttribute("x2", String(x));
				line?.setAttribute("y2", String(y));
				const angle =
					(Math.atan2(y - ARROW.from.y, x - ARROW.from.x) * 180) / Math.PI;
				head?.setAttribute(
					"transform",
					`translate(${x} ${y}) rotate(${angle})`,
				);
				arrowRef.current.style.opacity = t >= DRAW.start ? "1" : "0";
			}
			cursor.tick(PATH, t, seek);
		},
	});

	return (
		<Stage wallpaper={WALLPAPER} layerRef={layerRef}>
			<div
				className="absolute transition-opacity duration-500"
				style={{
					left: POS.content.left,
					top: POS.content.top,
					opacity: ui.result ? 0.35 : 1,
				}}
			>
				<ContentWindow
					width={POS.content.width}
					height={POS.content.height}
					scrollRef={scrollRef}
				/>
			</div>

			<div
				ref={marqueeRef}
				className="pointer-events-none absolute z-20 rounded-[4px] transition-opacity duration-150"
				style={{
					left: MARQUEE.x0,
					top: MARQUEE.y0,
					width: 0,
					height: 0,
					opacity: ui.marquee ? 1 : 0,
					border: "1.5px dashed rgba(255,255,255,0.95)",
					boxShadow:
						"0 0 0 1px rgba(0,144,255,0.9), 0 0 0 9999px rgba(9,12,20,0.42)",
				}}
			>
				<span
					ref={sizeRef}
					className="absolute -bottom-7 right-0 rounded-md px-2 py-1 text-[11px] font-medium tabular-nums text-white"
					style={{ background: "rgba(32,32,32,0.9)" }}
				/>
			</div>

			<div
				className="pointer-events-none absolute inset-0 z-30 bg-white transition-opacity duration-300"
				style={{ opacity: ui.flash ? 0.8 : 0 }}
			/>

			<Reveal
				show={ui.result}
				from="translateY(10px) scale(0.92)"
				className="z-20"
				style={{
					left: POS.result.left,
					top: POS.result.top,
					width: POS.result.width,
					height: POS.result.height,
				}}
			>
				<div
					className="relative h-full w-full overflow-hidden rounded-[12px]"
					style={{
						backgroundImage: `url(${WALLPAPER})`,
						backgroundSize: "cover",
						backgroundPosition: "center",
						boxShadow:
							"0 30px 70px -20px rgba(16,24,40,0.55), 0 0 0 1px rgba(0,0,0,0.08)",
					}}
				>
					<div className="absolute" style={{ left: 50, top: 36 }}>
						<ContentWindow
							width={319}
							height={228}
							scrollRef={resultScrollRef}
						/>
					</div>
					<svg
						ref={arrowRef}
						aria-hidden="true"
						className="absolute inset-0 opacity-0"
						viewBox={`${POS.result.left} ${POS.result.top} ${POS.result.width} ${POS.result.height}`}
						width={POS.result.width}
						height={POS.result.height}
					>
						<line
							x1={ARROW.from.x}
							y1={ARROW.from.y}
							x2={ARROW.from.x}
							y2={ARROW.from.y}
							stroke="#ff4766"
							strokeWidth="4"
							strokeLinecap="round"
						/>
						<polygon
							points="0,0 -14,-7 -14,7"
							fill="#ff4766"
							transform={`translate(${ARROW.from.x} ${ARROW.from.y})`}
						/>
					</svg>
				</div>
			</Reveal>

			<Reveal
				show={ui.toolbar}
				from="translateY(10px)"
				className="z-30"
				style={POS.toolbar}
			>
				<div
					className="flex items-center gap-1 rounded-full border p-1.5"
					style={{
						background: "#fcfcfc",
						borderColor: "#e0e0e0",
						boxShadow: "0 8px 24px -8px rgba(16,24,40,0.28)",
					}}
				>
					{[
						{ Icon: MoveUpRight, anchor: "annotate-arrow" },
						{ Icon: Square, anchor: "annotate-square" },
						{ Icon: Type, anchor: "annotate-text" },
					].map(({ Icon, anchor }, i) => (
						<span
							key={anchor}
							data-scene-anchor={anchor}
							className={classNames(
								"grid size-8 place-items-center rounded-full transition-colors duration-200",
								i === 0 && ui.arrowTool
									? "bg-[#e6f4fe] text-[#0d74ce]"
									: "text-[#646464]",
							)}
						>
							<Icon className="size-3.5" />
						</span>
					))}
					<span className="mx-1 h-4 w-px" style={{ background: "#e0e0e0" }} />
					<span
						data-scene-anchor="annotate-done"
						className={classNames(
							"grid size-8 place-items-center rounded-full transition-colors duration-200",
							ui.copied ? "bg-[#dff3e9] text-[#0f7a58]" : "text-[#0f7a58]",
						)}
					>
						<Check className="size-4" strokeWidth={3} />
					</span>
				</div>
			</Reveal>

			<Notification show={ui.captured} title="Screenshot captured" />
			<Notification show={ui.copied} title="Annotation saved" />
			{cursor.Cursor}
		</Stage>
	);
};

export const SCREENSHOT: SceneModule = {
	Scene: ScreenshotScene,
	chapters: CHAPTERS,
	poster: SCENE_META.screenshot.poster,
};
