"use client";

import { classNames } from "@cap/utils/helpers";
import Image from "next/image";
import { useRef } from "react";
import { BAND, GRAIN } from "./theme";
import { useInView, usePageVisible } from "./visibility";

const ART = {
	cumulusA: { src: "/backgrounds/clouds/cumulus-a.webp", w: 896, h: 387 },
	cumulusB: { src: "/backgrounds/clouds/cumulus-b.webp", w: 760, h: 360 },
	tuft: { src: "/backgrounds/clouds/tuft-a.webp", w: 600, h: 300 },
	bank: { src: "/backgrounds/clouds/bank-a.webp", w: 864, h: 241 },
	wisp: { src: "/backgrounds/clouds/wisp-a.webp", w: 860, h: 203 },
} as const;

type Art = keyof typeof ART;

type CloudSpec = {
	art: Art;
	top: string;
	width: number;
	opacity: number;
	drift: number;
	offset: number;
	bob: number;
	near?: boolean;
};

const CLOUDS: CloudSpec[] = [
	{
		art: "wisp",
		top: "4%",
		width: 300,
		opacity: 0.62,
		drift: 280,
		offset: -100,
		bob: 19,
	},
	{
		art: "tuft",
		top: "2%",
		width: 210,
		opacity: 0.62,
		drift: 250,
		offset: -210,
		bob: 23,
	},
	{
		art: "bank",
		top: "11%",
		width: 340,
		opacity: 0.6,
		drift: 300,
		offset: -40,
		bob: 20,
	},
	{
		art: "cumulusB",
		top: "19%",
		width: 380,
		opacity: 0.86,
		drift: 210,
		offset: -150,
		bob: 21,
	},
	{
		art: "tuft",
		top: "31%",
		width: 300,
		opacity: 0.82,
		drift: 220,
		offset: -30,
		bob: 25,
	},
	{
		art: "cumulusA",
		top: "43%",
		width: 560,
		opacity: 0.97,
		drift: 175,
		offset: -115,
		bob: 27,
		near: true,
	},
	{
		art: "bank",
		top: "56%",
		width: 540,
		opacity: 0.94,
		drift: 185,
		offset: -60,
		bob: 29,
		near: true,
	},
	{
		art: "wisp",
		top: "63%",
		width: 430,
		opacity: 0.82,
		drift: 230,
		offset: -190,
		bob: 24,
	},
];

const Cloud = ({ spec }: { spec: CloudSpec }) => {
	const art = ART[spec.art];
	const height = Math.round((art.h / art.w) * spec.width);
	return (
		<div
			className="ht-cloud"
			style={{
				top: spec.top,
				width: spec.width,
				height,
				opacity: spec.opacity,
				animationDuration: `${spec.drift}s`,
				animationDelay: `${spec.offset}s`,
			}}
		>
			<Image
				src={art.src}
				alt=""
				width={spec.width}
				height={height}
				unoptimized
				draggable={false}
				priority={spec.near}
				loading="eager"
				fetchPriority={spec.near ? "high" : "low"}
				className="ht-cloud-bob block select-none"
				style={{ animationDuration: `${spec.bob}s` }}
			/>
		</div>
	);
};

const SKY = [
	"radial-gradient(36% 32% at 70% 2%, rgba(255,224,192,0.8) 0%, rgba(255,224,192,0) 70%)",
	"radial-gradient(80% 42% at 50% 74%, rgba(255,240,224,0.5) 0%, rgba(255,240,224,0) 72%)",
	`linear-gradient(180deg, #C8DDF6 0%, #D9E7F8 34%, #E6EDF6 66%, ${BAND} 100%)`,
].join(",");

export const HeroSky = ({ className }: { className?: string }) => {
	const rootRef = useRef<HTMLDivElement | null>(null);
	const inView = useInView(rootRef, "0px");
	const pageVisible = usePageVisible();
	const drifting = inView && pageVisible;
	return (
		<div
			ref={rootRef}
			aria-hidden="true"
			className={classNames(
				"pointer-events-none absolute inset-0 overflow-hidden",
				className ?? "rounded-t-[24px]",
				drifting ? "" : "ht-sky-idle",
			)}
			style={{
				backgroundColor: BAND,
				backgroundImage: SKY,
			}}
		>
			<style href="ht-hero-sky" precedence="default">
				{CSS}
			</style>
			<div className="ht-cloud-track">
				{CLOUDS.map((spec) => (
					<Cloud key={`${spec.art}-${spec.top}`} spec={spec} />
				))}
			</div>
			<div
				className="absolute inset-0"
				style={{ backgroundImage: GRAIN, backgroundSize: "200px 200px" }}
			/>
		</div>
	);
};

const CSS = `
.ht-cloud-track {
	position: absolute;
	inset: 0;
	-webkit-mask-image: linear-gradient(180deg, #000 0%, #000 62%, rgba(0,0,0,0) 96%);
	mask-image: linear-gradient(180deg, #000 0%, #000 62%, rgba(0,0,0,0) 96%);
}
.ht-cloud {
	position: absolute;
	left: 0;
	will-change: transform;
	animation-name: ht-cloud-drift;
	animation-timing-function: linear;
	animation-iteration-count: infinite;
}
.ht-cloud-bob {
	animation-name: ht-cloud-bob;
	animation-timing-function: ease-in-out;
	animation-iteration-count: infinite;
	animation-direction: alternate;
}
@keyframes ht-cloud-drift {
	from { transform: translate3d(-100%, 0, 0); }
	to { transform: translate3d(100vw, 0, 0); }
}
@keyframes ht-cloud-bob {
	from { transform: translate3d(0, -5px, 0); }
	to { transform: translate3d(0, 5px, 0); }
}
.ht-sky-idle .ht-cloud, .ht-sky-idle .ht-cloud-bob { animation-play-state: paused; }
@media (prefers-reduced-motion: reduce) {
	.ht-cloud, .ht-cloud-bob { animation-play-state: paused; }
}
`;
