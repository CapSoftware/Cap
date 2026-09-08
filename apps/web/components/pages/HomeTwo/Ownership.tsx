"use client";

import { classNames } from "@cap/utils/helpers";
import { Server } from "lucide-react";
import Image from "next/image";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { CapLogoMark } from "./demo/capIcons";
import { Eyebrow } from "./Eyebrow";
import { Scaled } from "./scenes/engine";
import {
	BAND,
	BODY_TEXT,
	EYEBROW,
	grainBg,
	H_SECTION,
	MODE_THEME,
	type ModeKey,
} from "./theme";
import { useInView, usePageVisible, useReducedMotion } from "./visibility";

const QUOTE = {
	name: "Steven Tey",
	handle: "Founder, Dub.co",
	image: "/testimonials/steven_tey.jpg",
	content:
		"Cap is one of my favorite pieces of software I've used in the recent years. Best part is you get to own your data since they're fully open-source + via their S3 integration.",
};

type Destination = {
	key: string;
	name: string;
	label: string;
	detail: string;
	mode: ModeKey;
	icon: ReactNode;
};

const DESTINATIONS: Destination[] = [
	{
		key: "cloud",
		name: "Cap Cloud",
		label: "Cap Cloud",
		detail: "Zero setup. Encrypted, and shareable the second you stop.",
		mode: "instant",
		icon: <CapLogoMark className="size-6" />,
	},
	{
		key: "s3",
		name: "Your own S3 bucket",
		label: "Your S3 bucket",
		detail: "Any S3 compatible bucket, in any region you choose.",
		mode: "studio",
		icon: (
			<span className="grid size-6 place-items-center rounded-[6px] bg-[#111111] text-[10px] font-semibold text-white">
				S3
			</span>
		),
	},
	{
		key: "drive",
		name: "Google Drive",
		label: "Google Drive",
		detail: "Recordings land in a Drive folder you pick.",
		mode: "screenshot",
		icon: (
			<Image
				src="/logos/google-drive.svg"
				alt=""
				width={24}
				height={24}
				className="size-6"
			/>
		),
	},
	{
		key: "self",
		name: "Self hosted",
		label: "Self hosted",
		detail: "Run the whole platform on your own infrastructure.",
		mode: "share",
		icon: <Server className="size-5 text-[#111111]" />,
	},
];

const PROOF = [
	{
		label: "Open source",
		body: "Every line is on GitHub. Audit it, fork it, or contribute the feature you need.",
	},
	{
		label: "SOC 2 Type II · ISO 27001",
		body: "Independently audited controls behind Cap Cloud.",
	},
	{
		label: "HIPAA compliant",
		body: "Signed BAAs for organizations handling PHI.",
	},
	{
		label: "No lock in",
		body: "Recordings are plain video files. Take them anywhere, any time.",
	},
];

const DIAGRAM = { w: 560, h: 340 };
const SOURCE = { x: 168, y: DIAGRAM.h / 2 };
const NODE = { x: 372, w: 176, h: 56, gap: 22 };
const nodeY = (i: number) =>
	(DIAGRAM.h - (NODE.h * 4 + NODE.gap * 3)) / 2 + i * (NODE.h + NODE.gap);
const routePath = (i: number) => {
	const cy = nodeY(i) + NODE.h / 2;
	const mid = (SOURCE.x + NODE.x) / 2;
	return `M ${SOURCE.x} ${SOURCE.y} C ${mid} ${SOURCE.y}, ${mid} ${cy}, ${NODE.x} ${cy}`;
};

const ROUTE_CSS = `
	@keyframes ht-route-packet {
		from { offset-distance: 0%; opacity: 0; }
		8% { opacity: 1; }
		92% { opacity: 1; }
		to { offset-distance: 100%; opacity: 0; }
	}
	@keyframes ht-route-dash {
		to { stroke-dashoffset: -28; }
	}
	@keyframes ht-route-land {
		0% { box-shadow: 0 0 0 0 var(--ht-glow); }
		100% { box-shadow: 0 0 0 14px transparent; }
	}
`;

const StorageRoute = ({
	active,
	playing,
}: {
	active: number;
	playing: boolean;
}) => {
	const theme = MODE_THEME[DESTINATIONS[active]?.mode ?? "instant"];
	const animationPlayState = playing ? "running" : "paused";
	return (
		<Scaled w={DIAGRAM.w} h={DIAGRAM.h} className="mx-auto">
			<style>{ROUTE_CSS}</style>
			<svg
				aria-hidden="true"
				viewBox={`0 0 ${DIAGRAM.w} ${DIAGRAM.h}`}
				className="absolute inset-0 h-full w-full"
			>
				{DESTINATIONS.map((destination, i) => (
					<path
						key={destination.key}
						d={routePath(i)}
						fill="none"
						stroke={i === active ? theme.glyph : "rgba(17,17,17,0.14)"}
						strokeWidth={i === active ? 2 : 1.5}
						strokeDasharray={i === active ? "8 6" : undefined}
						strokeLinecap="round"
						className="transition-[stroke] duration-500"
						style={
							i === active
								? {
										animationName: "ht-route-dash",
										animationDuration: "1.1s",
										animationTimingFunction: "linear",
										animationIterationCount: "infinite",
										animationPlayState,
									}
								: undefined
						}
					/>
				))}
			</svg>

			{[0, 1].map((packet) => (
				<span
					key={packet}
					className="pointer-events-none absolute left-0 top-0 size-3 rounded-full"
					style={{
						background: theme.glyph,
						boxShadow: `0 0 0 4px ${theme.chip}`,
						offsetPath: `path("${routePath(active)}")`,
						offsetRotate: "0deg",
						animationName: "ht-route-packet",
						animationDuration: "2.2s",
						animationTimingFunction: "linear",
						animationDelay: `${packet * 1.1}s`,
						animationIterationCount: "infinite",
						animationPlayState,
					}}
				/>
			))}

			<div
				className="absolute flex w-[150px] -translate-x-full -translate-y-1/2 flex-col gap-2 rounded-[14px] bg-white p-2.5"
				style={{
					left: SOURCE.x - 6,
					top: SOURCE.y,
					boxShadow:
						"0 0 0 1px rgba(17,17,17,0.06), 0 20px 40px -24px rgba(17,17,17,0.5)",
				}}
			>
				<div
					className="relative h-[68px] overflow-hidden rounded-[9px]"
					style={{
						background: "linear-gradient(135deg,#71a3f5 0%,#b7d4fa 100%)",
					}}
				>
					<span className="absolute inset-x-4 inset-y-3 rounded-[5px] bg-white/95 shadow-[0_8px_20px_-10px_rgba(16,24,40,0.5)]">
						<span className="absolute left-2 top-2 h-[3px] w-10 rounded-full bg-[rgba(17,17,17,0.35)]" />
						<span className="absolute left-2 top-[15px] h-[3px] w-16 rounded-full bg-[rgba(17,17,17,0.12)]" />
					</span>
					<span className="absolute bottom-2 left-2 size-4 rounded-full bg-[#111111] ring-2 ring-white/70" />
				</div>
				<div className="flex items-center gap-2 px-0.5">
					<CapLogoMark className="size-4 shrink-0" />
					<span className="min-w-0 flex-1 leading-tight">
						<span className="block truncate text-[12px] font-medium text-[#111111]">
							team-update.cap
						</span>
						<span className="block text-[10.5px] text-[rgba(17,17,17,0.5)]">
							4K · 1.2 GB
						</span>
					</span>
				</div>
			</div>

			{DESTINATIONS.map((destination, i) => {
				const on = i === active;
				const tone = MODE_THEME[destination.mode];
				return (
					<div
						key={destination.key}
						className={classNames(
							"absolute flex items-center gap-3 rounded-[12px] px-3 transition-[background-color,box-shadow,transform] duration-500",
							on ? "bg-white" : "bg-white/60",
						)}
						style={
							{
								left: NODE.x,
								top: nodeY(i),
								width: NODE.w,
								height: NODE.h,
								"--ht-glow": tone.pill,
								boxShadow: on
									? `0 0 0 1.5px ${tone.accent}, 0 18px 36px -22px rgba(17,17,17,0.5)`
									: "0 0 0 1px rgba(17,17,17,0.06)",
								animationName: on ? "ht-route-land" : "none",
								animationDuration: "2.2s",
								animationTimingFunction: "ease-out",
								animationIterationCount: "infinite",
								animationPlayState,
							} as React.CSSProperties
						}
					>
						<span
							className="grid size-9 shrink-0 place-items-center rounded-[9px]"
							style={{ background: on ? tone.chip : "#F1F4F8" }}
						>
							{destination.icon}
						</span>
						<span
							className={classNames(
								"truncate text-[13px] font-medium transition-colors duration-300",
								on ? "text-[#111111]" : "text-[rgba(17,17,17,0.6)]",
							)}
						>
							{destination.label}
						</span>
					</div>
				);
			})}
		</Scaled>
	);
};

export const Ownership = () => {
	const [active, setActive] = useState(0);
	const [pinned, setPinned] = useState(false);
	const cardRef = useRef<HTMLDivElement | null>(null);
	const inView = useInView(cardRef);
	const pageVisible = usePageVisible();
	const reducedMotion = useReducedMotion();
	const playing = inView && pageVisible && !reducedMotion;

	useEffect(() => {
		if (!playing || pinned) return;
		const timer = setInterval(
			() => setActive((current) => (current + 1) % DESTINATIONS.length),
			3200,
		);
		return () => clearInterval(timer);
	}, [playing, pinned]);

	useEffect(() => {
		if (!pinned) return;
		const release = setTimeout(() => setPinned(false), 9000);
		return () => clearTimeout(release);
	}, [pinned]);

	const choose = (i: number) => {
		setActive(i);
		setPinned(true);
	};

	return (
		<section className="px-5 py-20 lg:py-28">
			<div className="mx-auto max-w-[1200px]">
				<div className="mx-auto flex max-w-[760px] flex-col items-center text-center">
					<Eyebrow accent={MODE_THEME.studio.accent}>Open source</Eyebrow>
					<h2
						className={`${H_SECTION} mt-6 text-balance text-[clamp(38px,5vw,56px)]`}
					>
						Your recordings. Actually yours.
					</h2>
					<p
						className={`${BODY_TEXT} mt-6 max-w-[600px] text-balance text-[16.5px] leading-[1.5] text-[rgba(17,17,17,0.78)] sm:text-[17.5px]`}
					>
						Cap is open source, and every recording goes exactly where you say.
						Use Cap Cloud, point it at your own bucket or Drive, or self host
						the whole thing.
					</p>
				</div>

				<div
					ref={cardRef}
					className="mt-14 grid gap-4 rounded-[24px] p-3 lg:grid-cols-[1.3fr_1fr] lg:p-4"
					style={grainBg(BAND)}
				>
					<div className="flex items-center rounded-[16px] bg-[#F8FAFC] px-6 py-8 shadow-[0_0_0_1px_rgba(17,17,17,0.04)] lg:px-10">
						<StorageRoute active={active} playing={playing} />
					</div>

					<div className="flex flex-col gap-2">
						{DESTINATIONS.map((destination, i) => {
							const on = i === active;
							const tone = MODE_THEME[destination.mode];
							return (
								<button
									key={destination.key}
									type="button"
									aria-pressed={on}
									onClick={() => choose(i)}
									className={classNames(
										"flex flex-1 items-start gap-3.5 rounded-[14px] px-4 py-4 text-left transition-[background-color,box-shadow] duration-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#111111]",
										on
											? "bg-white shadow-[0_0_0_1px_rgba(17,17,17,0.06),0_18px_36px_-26px_rgba(17,17,17,0.45)]"
											: "hover:bg-white/50",
									)}
								>
									<span
										className="mt-[3px] inline-block size-[7px] shrink-0 transition-colors duration-300"
										style={{
											background: on ? tone.accent : "rgba(17,17,17,0.18)",
										}}
									/>
									<span className="min-w-0">
										<span
											className={classNames(
												"block text-[16px] font-medium transition-colors duration-300",
												on ? "text-[#111111]" : "text-[rgba(17,17,17,0.55)]",
											)}
										>
											{destination.name}
										</span>
										<span
											className={classNames(
												BODY_TEXT,
												"mt-1 block text-[14.5px] leading-[1.45] transition-colors duration-300",
												on
													? "text-[rgba(17,17,17,0.72)]"
													: "text-[rgba(17,17,17,0.4)]",
											)}
										>
											{destination.detail}
										</span>
									</span>
								</button>
							);
						})}
					</div>
				</div>

				<div className="mt-4 grid gap-4 lg:grid-cols-[1.3fr_1fr]">
					<figure className="flex flex-col justify-center rounded-[20px] bg-white p-8 shadow-[0_0_0_1px_rgba(17,17,17,0.05)] lg:p-10">
						<blockquote
							className={`${BODY_TEXT} text-balance text-[clamp(19px,1.9vw,24px)] leading-[1.4] text-[#111111]`}
						>
							&ldquo;{QUOTE.content}&rdquo;
						</blockquote>
						<figcaption className="mt-7 flex flex-wrap items-center gap-2">
							<span className="inline-flex items-center gap-2 rounded-full bg-[#EDF1F6] py-1.5 pl-1.5 pr-4">
								<Image
									src={QUOTE.image}
									alt=""
									width={28}
									height={28}
									className="size-7 rounded-full object-cover"
								/>
								<span className="text-[13.5px] font-medium text-[#111111]">
									{QUOTE.name}
								</span>
							</span>
							<span className="rounded-full bg-[#EDF1F6] px-4 py-2 text-[13.5px] text-[rgba(17,17,17,0.55)]">
								{QUOTE.handle}
							</span>
						</figcaption>
					</figure>

					<ul
						className="grid grid-cols-1 gap-px overflow-hidden rounded-[20px] sm:grid-cols-2"
						style={grainBg(BAND)}
					>
						{PROOF.map((item) => (
							<li key={item.label} className="flex flex-col gap-2 p-6">
								<p
									className={classNames(
										EYEBROW,
										"flex items-center gap-2 text-[11px] text-[#111111]",
									)}
								>
									<span
										aria-hidden="true"
										className="inline-block size-[7px]"
										style={{ background: MODE_THEME.studio.accent }}
									/>
									{item.label}
								</p>
								<p
									className={`${BODY_TEXT} text-[14.5px] leading-[1.45] text-[rgba(17,17,17,0.72)]`}
								>
									{item.body}
								</p>
							</li>
						))}
					</ul>
				</div>
			</div>
		</section>
	);
};
