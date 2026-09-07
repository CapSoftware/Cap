"use client";

import { classNames } from "@cap/utils/helpers";
import { useRef } from "react";
import { easeOut, lerp, span, typed, useSceneState } from "../../scenes/engine";
import { Chip, ED, Ground, RecordedWindow, useLoop } from "../shared";

/* Text that animates: three of the editor's text templates play over the
 * recording with their real In animation, and the Templates grid along the
 * bottom shows which one is on. */

const WIN = { left: 120, top: 12, scale: 1 };
const DURATION = 10000;
const LOWER = { enter: 400, exit: 2900 };
const STAT = { enter: 3700, exit: 6100 };
const TYPE = { enter: 6600, exit: 9400 };
const TYPEWRITER_TEXT = "Try the new flow →";

const TEMPLATES = [
	"Title",
	"Lower Third",
	"Kicker",
	"Big Stat",
	"Quote",
	"Typewriter",
] as const;
type Template = (typeof TEMPLATES)[number];

const ROW = { left: 16, top: 282, scale: 1.2, card: 73, gap: 8 };

const activeAt = (t: number): { template: Template; anim: string } | null =>
	t >= TYPE.enter - 100 && t < TYPE.exit + 300
		? { template: "Typewriter", anim: "Typewriter" }
		: t >= STAT.enter - 100 && t < STAT.exit + 300
			? { template: "Big Stat", anim: "Pop" }
			: t >= LOWER.enter - 100 && t < LOWER.exit + 300
				? { template: "Lower Third", anim: "Slide up" }
				: null;

const Sample = ({ template }: { template: Template }) => {
	switch (template) {
		case "Title":
			return <span className="text-[16px] font-bold text-white">Title</span>;
		case "Lower Third":
			return (
				<span className="flex items-stretch gap-1.5">
					<span className="w-[2px] rounded-full bg-[#8FC1F7]" />
					<span className="whitespace-nowrap text-[10px] font-semibold leading-none text-white">
						Lower third
					</span>
				</span>
			);
		case "Kicker":
			return (
				<span className="text-[9px] font-bold uppercase tracking-[3px] text-white">
					Kicker
				</span>
			);
		case "Big Stat":
			return <span className="text-[22px] font-extrabold text-white">42%</span>;
		case "Quote":
			return (
				<span className="font-serif text-[13px] font-medium italic text-white">
					“Quote”
				</span>
			);
		case "Typewriter":
			return (
				<span className="font-mono text-[10px] text-white">
					Typewriter<span className="animate-pulse">_</span>
				</span>
			);
	}
};

const Selection = ({
	children,
	className,
	style,
	boxRef,
}: {
	children: React.ReactNode;
	className?: string;
	style?: React.CSSProperties;
	boxRef?: React.RefObject<HTMLDivElement | null>;
}) => (
	<div
		ref={boxRef}
		className={classNames("absolute z-20 rounded-md", className)}
		style={{
			border: `2px solid ${ED.accent}`,
			padding: "8px 12px",
			...style,
		}}
	>
		<span
			className="absolute left-0 rounded px-1.5 py-0.5 text-[11px] font-medium text-white"
			style={{ top: -24, background: ED.accent }}
		>
			Text
		</span>
		{[
			{ left: -7, top: -7 },
			{ right: -7, top: -7 },
			{ left: -7, bottom: -7 },
			{ right: -7, bottom: -7 },
		].map((dot) => (
			<span
				key={Object.keys(dot).join("-")}
				className="absolute size-3 rounded-full"
				style={{
					...dot,
					background: ED.accent,
					boxShadow: "0 0 0 2px #ffffff",
				}}
			/>
		))}
		{children}
	</div>
);

export const Visual = ({ playing }: { playing: boolean }) => {
	const lowerRef = useRef<HTMLDivElement | null>(null);
	const statRef = useRef<HTMLDivElement | null>(null);
	const typeRef = useRef<HTMLDivElement | null>(null);
	const typeTextRef = useRef<HTMLSpanElement | null>(null);
	const [ui, setUi] = useSceneState(activeAt(0));
	const lastRef = useRef<{ template: Template; anim: string }>({
		template: "Lower Third",
		anim: "Slide up",
	});
	if (ui) lastRef.current = ui;

	useLoop({
		duration: DURATION,
		playing,
		pose: 4800,
		tick: (t) => {
			setUi(activeAt(t));
			if (lowerRef.current) {
				const inF = easeOut(span(t, LOWER.enter, LOWER.enter + 480));
				const outF = easeOut(span(t, LOWER.exit, LOWER.exit + 360));
				lowerRef.current.style.opacity = `${inF * (1 - outF)}`;
				lowerRef.current.style.transform = `translateY(${lerp(28, 0, inF) + outF * 18}px)`;
			}
			if (statRef.current) {
				const inF = span(t, STAT.enter, STAT.enter + 520);
				const overshoot = 1 + Math.sin(inF * Math.PI) * 0.12;
				const outF = easeOut(span(t, STAT.exit, STAT.exit + 320));
				statRef.current.style.opacity = `${easeOut(inF) * (1 - outF)}`;
				statRef.current.style.transform = `translateX(-50%) scale(${lerp(0.6, 1, easeOut(inF)) * overshoot})`;
			}
			if (typeRef.current && typeTextRef.current) {
				const outF = easeOut(span(t, TYPE.exit, TYPE.exit + 300));
				typeRef.current.style.opacity = `${t >= TYPE.enter ? 1 - outF : 0}`;
				typeTextRef.current.textContent =
					t >= TYPE.enter
						? typed(TYPEWRITER_TEXT, t, TYPE.enter + 200, 22)
						: "";
			}
		},
	});

	const shown = ui ?? lastRef.current;

	return (
		<Ground tone="gradient">
			<RecordedWindow left={WIN.left} top={WIN.top} scale={WIN.scale} />
			<div
				className="pointer-events-none absolute rounded-[10px]"
				style={{
					left: WIN.left,
					top: WIN.top,
					width: 360,
					height: 250,
					background: "rgba(9,12,20,0.22)",
				}}
			/>

			<Selection
				boxRef={lowerRef}
				className="opacity-0"
				style={{ left: 138, top: 186 }}
			>
				<span className="flex items-stretch gap-3">
					<span className="w-[3px] rounded-full bg-[#8FC1F7]" />
					<span className="leading-tight [text-shadow:0_2px_12px_rgba(0,0,0,0.45)]">
						<span className="block text-[22px] font-semibold text-white">
							Sofia Chen
						</span>
						<span className="block text-[13px] font-medium text-white/85">
							Head of Product
						</span>
					</span>
				</span>
			</Selection>

			<Selection
				boxRef={statRef}
				className="left-1/2 flex -translate-x-1/2 flex-col items-center opacity-0"
				style={{ top: 78, background: "rgba(17,17,17,0.72)" }}
			>
				<span className="text-[68px] font-extrabold leading-none tracking-[-0.04em] text-white [text-shadow:0_6px_30px_rgba(0,0,0,0.45)]">
					3.2×
				</span>
				<span className="mt-2 text-[13px] font-medium uppercase tracking-[0.08em] text-white/85">
					faster onboarding
				</span>
			</Selection>

			<Selection
				boxRef={typeRef}
				className="opacity-0"
				style={{ left: 286, top: 52, background: "rgba(17,17,17,0.82)" }}
			>
				<span className="font-mono text-[17px] font-medium text-white">
					<span ref={typeTextRef} />
					<span className="ml-0.5 inline-block h-[16px] w-[2px] translate-y-[2px] animate-pulse bg-white/85" />
				</span>
			</Selection>

			<div className="absolute left-4 top-3.5 z-30">
				<Chip>In · {shown.anim}</Chip>
			</div>

			<div
				className="absolute flex"
				style={{
					left: ROW.left,
					top: ROW.top,
					gap: ROW.gap,
					transform: `scale(${ROW.scale})`,
					transformOrigin: "top left",
				}}
			>
				{TEMPLATES.map((template) => {
					const on = shown.template === template;
					return (
						<div
							key={template}
							className="relative flex h-16 shrink-0 items-center justify-center overflow-hidden rounded-lg pb-3 transition-[box-shadow] duration-300"
							style={{
								width: ROW.card,
								background: "linear-gradient(135deg,#17181c,#2a2c33)",
								boxShadow: on
									? `0 0 0 1px ${ED.accent}, 0 0 0 3px ${ED.card}, 0 0 0 4px ${ED.accent}`
									: `0 0 0 1px rgba(255,255,255,0.08)`,
							}}
						>
							<Sample template={template} />
							<span className="absolute inset-x-0 bottom-1 text-center text-[10px] text-white/50">
								{template}
							</span>
						</div>
					);
				})}
			</div>
		</Ground>
	);
};
