"use client";

import { classNames } from "@cap/utils/helpers";
import { useRef } from "react";
import { BAND } from "./theme";
import { useInView, usePageVisible } from "./visibility";

/**
 * The desktop app's welcome screen sky
 * (apps/desktop-gpui/src/onboarding_window.rs, `welcome_sky`) over the
 * landing page's clouds: light rays behind and in front of them, a sun in
 * the top right, moving film grain, and an entrance that lifts a pale wash
 * off it all.
 */

const ART = {
	cumulusA: { src: "/backgrounds/clouds/cumulus-a.webp", aspect: 387 / 896 },
	cumulusB: { src: "/backgrounds/clouds/cumulus-b.webp", aspect: 360 / 760 },
	tuft: { src: "/backgrounds/clouds/tuft-a.webp", aspect: 300 / 600 },
	bank: { src: "/backgrounds/clouds/bank-a.webp", aspect: 241 / 864 },
	wisp: { src: "/backgrounds/clouds/wisp-a.webp", aspect: 203 / 860 },
} as const;

type Art = keyof typeof ART;
/** `drift` is seconds per crossing and `offset` how far into it a cloud
 * starts, so they never line up. Far clouds sit behind the mist. */
type Cloud = {
	art: Art;
	top: string;
	width: number;
	opacity: number;
	drift: number;
	offset: number;
	far?: boolean;
};

const CLOUDS: Cloud[] = [
	{
		art: "wisp",
		top: "4%",
		width: 300,
		opacity: 0.55,
		drift: 280,
		offset: -100,
		far: true,
	},
	{
		art: "tuft",
		top: "2%",
		width: 210,
		opacity: 0.55,
		drift: 250,
		offset: -210,
		far: true,
	},
	{
		art: "bank",
		top: "11%",
		width: 340,
		opacity: 0.5,
		drift: 300,
		offset: -40,
		far: true,
	},
	{
		art: "cumulusB",
		top: "19%",
		width: 380,
		opacity: 0.86,
		drift: 210,
		offset: -150,
	},
	{
		art: "tuft",
		top: "31%",
		width: 300,
		opacity: 0.82,
		drift: 220,
		offset: -30,
	},
	{
		art: "cumulusA",
		top: "43%",
		width: 560,
		opacity: 0.97,
		drift: 175,
		offset: -115,
	},
	{
		art: "bank",
		top: "56%",
		width: 540,
		opacity: 0.94,
		drift: 185,
		offset: -60,
	},
	{
		art: "wisp",
		top: "63%",
		width: 430,
		opacity: 0.82,
		drift: 230,
		offset: -190,
	},
];

const CloudSprite = ({ cloud }: { cloud: Cloud }) => (
	// The track is the sky plus the cloud's own width, so each one crosses
	// from fully off the left edge to fully off the right.
	<div
		className="ht-cloud"
		style={{
			top: cloud.top,
			left: -cloud.width,
			width: `calc(100% + ${cloud.width}px)`,
			opacity: cloud.opacity,
			animationDuration: `${cloud.drift}s`,
			animationDelay: `${cloud.offset}s`,
		}}
	>
		{/* biome-ignore lint/performance/noImgElement: decorative art on a CSS track */}
		<img
			src={ART[cloud.art].src}
			alt=""
			width={cloud.width}
			height={Math.round(cloud.width * ART[cloud.art].aspect)}
			draggable={false}
			decoding="async"
			className="block select-none"
		/>
	</div>
);

const SKY = [
	"radial-gradient(80% 42% at 50% 74%, rgba(255,240,224,0.5) 0%, rgba(255,240,224,0) 72%)",
	`linear-gradient(180deg, #A3BFEA 0%, #C8DBF4 34%, #E2EAF5 64%, ${BAND} 92%)`,
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
				"ht-sky pointer-events-none absolute inset-0 overflow-hidden",
				className ?? "rounded-t-[24px]",
				drifting ? "" : "ht-sky-idle",
			)}
			style={{ backgroundColor: BAND, backgroundImage: SKY }}
		>
			<style href="ht-hero-sky" precedence="default">
				{CSS}
			</style>
			<div className="ht-light">
				<div className="ht-rays ht-rays-far" />
			</div>
			<div className="ht-clouds">
				{CLOUDS.filter((cloud) => cloud.far).map((cloud) => (
					<CloudSprite key={`${cloud.art}-${cloud.top}`} cloud={cloud} />
				))}
				<div className="ht-mist" />
				{CLOUDS.filter((cloud) => !cloud.far).map((cloud) => (
					<CloudSprite key={`${cloud.art}-${cloud.top}`} cloud={cloud} />
				))}
			</div>
			<div className="ht-vignette" />
			<div className="ht-light">
				<div className="ht-sun" />
				<div className="ht-rays ht-rays-near" />
			</div>
			<div className="ht-ground" />
			<div className="ht-grain" />
			<div className="ht-wash" />
		</div>
	);
};

const CSS = `
.ht-cloud {
	position: absolute;
	will-change: transform;
	animation: ht-cloud-drift linear infinite;
}
@keyframes ht-cloud-drift {
	from { transform: translate3d(0, 0, 0); }
	to { transform: translate3d(100%, 0, 0); }
}

/* Light arrives after the wash starts lifting. Clouds are already faintly
   there on the first frame and fill in: a cloud is the page's largest
   image, and one that starts fully transparent holds LCP back until its
   fade becomes visible. */
.ht-clouds, .ht-light {
	position: absolute;
	inset: 0;
	animation: ht-fade-in 2.2s cubic-bezier(0.4, 0, 0.2, 1) 0.25s both;
}
.ht-clouds { animation-name: ht-clouds-in; animation-delay: 0s; }
.ht-light { animation-duration: 2.8s; animation-delay: 0.45s; }
.ht-clouds {
	-webkit-mask-image: linear-gradient(180deg, #000 0%, #000 60%, transparent 94%);
	mask-image: linear-gradient(180deg, #000 0%, #000 60%, transparent 94%);
}
@keyframes ht-fade-in { from { opacity: 0; } to { opacity: 1; } }
@keyframes ht-clouds-in { from { opacity: 0.25; } to { opacity: 1; } }

.ht-mist {
	position: absolute;
	left: -10%;
	top: 0;
	width: 120%;
	height: 150%;
	background:
		radial-gradient(66.7% 15% at 41.7% 35%, rgba(255,255,255,0.28) 0%, rgba(244,248,253,0.12) 50%, rgba(244,248,253,0) 100%),
		radial-gradient(66.7% 15% at 62.5% 56%, rgba(255,255,255,0.22) 0%, rgba(244,248,253,0.1) 50%, rgba(244,248,253,0) 100%);
	animation: ht-mist 44s ease-in-out infinite alternate;
}
@keyframes ht-mist {
	from { transform: translate3d(-20px, 0, 0); }
	to { transform: translate3d(20px, 0, 0); }
}

/* Shafts fan down and to the left from just above the top right corner,
   baked from the welcome screen's blurred SVGs (a live SVG filter on a
   stretched background can drop its blur when Chrome re-rasterises it).
   Each layer sways and breathes on its own period so they never line up. */
.ht-rays {
	position: absolute;
	top: 0;
	bottom: 0;
	left: -40px;
	right: -40px;
	background-size: 100% 100%;
	background-repeat: no-repeat;
}
.ht-rays-far {
	background-image: url(/backgrounds/hero/rays-far.webp);
	opacity: 0.75;
	animation: ht-sway-far 16s ease-in-out infinite alternate,
		ht-breathe 10s ease-in-out infinite alternate;
}
.ht-rays-near {
	background-image: url(/backgrounds/hero/rays-near.webp);
	opacity: 0.7;
	animation: ht-sway-near 21s ease-in-out -4s infinite alternate,
		ht-breathe 13s ease-in-out -6s infinite alternate;
}
@keyframes ht-sway-far {
	from { transform: translate3d(-14px, 0, 0); }
	to { transform: translate3d(14px, 0, 0); }
}
@keyframes ht-sway-near {
	from { transform: translate3d(18px, 0, 0); }
	to { transform: translate3d(-18px, 0, 0); }
}
@keyframes ht-breathe {
	from { opacity: 0.62; }
	to { opacity: 1; }
}

.ht-sun {
	position: absolute;
	left: 84%;
	top: -6%;
	width: 75%;
	aspect-ratio: 1;
	transform: translate(-50%, -50%);
	background: radial-gradient(closest-side, rgba(255,248,236,0.95) 0%, rgba(255,227,196,0.5) 35%, rgba(255,227,196,0) 100%);
	animation: ht-sun 9s ease-in-out infinite alternate;
}
@keyframes ht-sun { from { opacity: 0.8; } to { opacity: 1; } }

/* Darkens the top corners only; the bottom has to meet the band cleanly. */
.ht-vignette {
	position: absolute;
	inset: 0;
	background: radial-gradient(75% 75% at 50% 50%, rgba(52,80,122,0) 50%, rgba(52,80,122,0.14) 100%);
	-webkit-mask-image: linear-gradient(180deg, #000 0%, #000 35%, transparent 75%);
	mask-image: linear-gradient(180deg, #000 0%, #000 35%, transparent 75%);
}
.ht-ground {
	position: absolute;
	inset: auto 0 0 0;
	height: 28%;
	background: linear-gradient(180deg, ${BAND}00 0%, ${BAND} 100%);
}

/* Film grain. Held still: a layer that changes 12 times a second keeps the
   page from ever looking finished, which pushed LCP and Speed Index out by
   seconds, and at this opacity the motion is barely visible anyway. */
.ht-grain {
	position: absolute;
	inset: 0;
	background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='260' height='260'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.8' numOctaves='2' stitchTiles='stitch'/%3E%3CfeColorMatrix type='saturate' values='0'/%3E%3CfeComponentTransfer%3E%3CfeFuncA type='linear' slope='0.12'/%3E%3C/feComponentTransfer%3E%3C/filter%3E%3Crect width='260' height='260' filter='url(%23n)'/%3E%3C/svg%3E");
	background-size: 260px 260px;
}

.ht-wash {
	position: absolute;
	inset: 0;
	background: linear-gradient(180deg, #F6F8FB 0%, #F6F8FB 60%, ${BAND} 100%);
	animation: ht-wash 1s cubic-bezier(0.4, 0, 0.2, 1) both;
}
@keyframes ht-wash { from { opacity: 1; } to { opacity: 0; } }

.ht-sky-idle *, .ht-sky-idle *::before { animation-play-state: paused; }
/* Idle pauses the drifting, never the entrance: the sky renders idle until
   hydration, and a paused fade kept the clouds invisible (and LCP waiting)
   until then. */
.ht-sky-idle .ht-clouds, .ht-sky-idle .ht-light, .ht-sky-idle .ht-wash { animation-play-state: running; }
@media (prefers-reduced-motion: reduce) {
	.ht-sky * { animation: none !important; }
	.ht-wash { opacity: 0; }
}
`;
