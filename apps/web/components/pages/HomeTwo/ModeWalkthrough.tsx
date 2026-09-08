"use client";

import { classNames } from "@cap/utils/helpers";
import { Link2 } from "lucide-react";
import dynamic from "next/dynamic";
import { getImageProps } from "next/image";
import Link from "next/link";
import type { ComponentType } from "react";
import { useEffect, useState } from "react";
import {
	InstantIcon,
	ScreenshotIcon,
	StudioIcon,
} from "@/components/pages/HomePage/modeIcons";

import { htGeist } from "./fonts";
import { Fit, SCENES, STAGE } from "./scenes";
import { LazyMount } from "./scenes/engine";
import {
	BODY_TEXT,
	CARD_BG,
	grainBg,
	H_CARD,
	MODE_THEME,
	type ModeKey,
	meshStyle,
} from "./theme";

const DesktopDemo = dynamic(
	() => import("./demo/DesktopDemo").then((m) => m.DesktopDemo),
	{
		loading: () => <div className="h-[100svh] max-h-[860px] min-h-[660px]" />,
	},
);

const { props: wallpaper } = getImageProps({
	src: "/backgrounds/sf.webp",
	alt: "",
	fill: true,
	sizes: "1360px",
});

type Step = {
	key: ModeKey;
	label: string;
	heading: string;
	body: string;
	href: string;
	extraChip?: string;
	Icon: ComponentType<{ className?: string }>;
};

const STEPS: Step[] = [
	{
		key: "instant",
		label: "Instant Mode",
		heading: "Share your screen in seconds",
		body: "Hit record and Cap uploads as you go. The moment you stop, a share link is on your clipboard, ready to paste anywhere.",
		href: "/features",
		Icon: InstantIcon,
	},
	{
		key: "studio",
		label: "Studio Mode",
		heading: "Full quality, edited before you share",
		body: "Record locally in 4K with separate screen, camera, and mic tracks. Polish with backgrounds, automatic zoom, and cursor effects in the built in editor.",
		href: "/features",
		Icon: StudioIcon,
	},
	{
		key: "screenshot",
		label: "Screenshot Mode",
		heading: "Screenshots that look designed",
		body: "Capture any window with a hotkey, beautify it with one click, and copy it straight to your clipboard.",
		href: "/features",
		Icon: ScreenshotIcon,
	},
	{
		key: "share",
		label: "Share",
		heading: "One link does the rest",
		body: "Every capture gets a Cap page with comments, reactions, transcript, and chapters. Viewers watch in the browser. No download, no account.",
		href: "/features",
		extraChip: "Every mode",
		Icon: Link2,
	},
];

const LEARN_MORE =
	"mt-7 inline-flex items-center gap-1.5 rounded-sm text-[15.5px] font-normal text-[#111111] underline decoration-[rgba(17,17,17,0.3)] underline-offset-[6px] transition-colors duration-200 hover:decoration-[#111111] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#111111] focus-visible:ring-offset-4 focus-visible:ring-offset-[#F8FAFC]";

const StackedSteps = ({ className }: { className?: string }) => (
	<div className={classNames("px-3 pb-12 pt-2 sm:px-4", className)}>
		<div className="mx-auto flex max-w-[720px] flex-col gap-5">
			{STEPS.map((step) => {
				const theme = MODE_THEME[step.key];
				const scene = SCENES[step.key];
				return (
					<div
						key={step.key}
						className="overflow-hidden rounded-[20px] p-2.5"
						style={meshStyle(theme)}
					>
						<div className="rounded-[14px] p-6 sm:p-8" style={grainBg(CARD_BG)}>
							<div className="flex flex-wrap items-center gap-2">
								<span className="inline-flex items-center gap-2.5">
									<span
										className="grid size-8 shrink-0 place-items-center rounded-[8px]"
										style={{ background: theme.chip, color: theme.glyph }}
									>
										<step.Icon className="h-4 w-4" />
									</span>
									<span className="text-[15px] font-medium text-[#111111]">
										{step.label}
									</span>
								</span>
								{step.extraChip ? (
									<span className="rounded-full bg-[#E7EDF3] px-2.5 py-1 text-[12px] font-normal text-[rgba(17,17,17,0.55)]">
										{step.extraChip}
									</span>
								) : null}
							</div>

							<h3
								className={`${H_CARD} mt-6 max-w-[430px] text-balance text-[clamp(30px,3.1vw,42px)]`}
							>
								{step.heading}
							</h3>

							<p
								className={`${BODY_TEXT} mt-5 max-w-[420px] text-[16.5px] leading-[1.5] text-[rgba(17,17,17,0.78)]`}
							>
								{step.body}
							</p>

							<Link href={step.href} className={LEARN_MORE}>
								Learn more
								<span aria-hidden="true">→</span>
							</Link>

							<div className="mt-8">
								<LazyMount w={STAGE.w} h={STAGE.h} className="mx-auto">
									<Fit w={STAGE.w} h={STAGE.h} still>
										<scene.Scene
											chapter={0}
											playing={false}
											staticT={scene.poster}
										/>
									</Fit>
								</LazyMount>
							</div>
						</div>
					</div>
				);
			})}
		</div>
	</div>
);

export const ModeWalkthrough = () => {
	// `false` on the server and on the first client render, so the markup the
	// server produced (CSS-driven responsive split) hydrates identically.
	const [forceStacked, setForceStacked] = useState(false);
	const [desktop, setDesktop] = useState(false);
	const [startRequested, setStartRequested] = useState(false);

	useEffect(() => {
		const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
		const wide = window.matchMedia("(min-width: 768px)");
		const sync = () => {
			setForceStacked(reduced.matches);
			if (wide.matches && !reduced.matches) setDesktop(true);
		};
		sync();
		reduced.addEventListener("change", sync);
		wide.addEventListener("change", sync);
		return () => {
			reduced.removeEventListener("change", sync);
			wide.removeEventListener("change", sync);
		};
	}, []);

	useEffect(() => {
		const start = () => setStartRequested(true);
		window.addEventListener("ht-demo-start", start);
		return () => window.removeEventListener("ht-demo-start", start);
	}, []);

	return (
		// biome-ignore lint/correctness/useUniqueElementIds: stable anchor target for the hero's "See how it works" link
		<section
			id="modes"
			aria-labelledby="modes-heading"
			className={`${htGeist.variable} scroll-mt-[68px] lg:scroll-mt-[76px]`}
		>
			<link
				rel="preload"
				as="image"
				href={wallpaper.srcSet ? undefined : wallpaper.src}
				fetchPriority="high"
				imageSrcSet={wallpaper.srcSet}
				imageSizes={wallpaper.sizes}
				media="(min-width: 768px) and (prefers-reduced-motion: no-preference)"
			/>
			{/* biome-ignore lint/correctness/useUniqueElementIds: paired with the section's aria-labelledby above */}
			<h2 id="modes-heading" className="sr-only">
				How Cap works: Instant Mode, Studio Mode, and the editor
			</h2>

			<div className={forceStacked ? "hidden" : "hidden md:block"}>
				{desktop ? (
					<DesktopDemo startRequested={startRequested} />
				) : (
					<div className="h-[100svh] max-h-[860px] min-h-[660px]" />
				)}
			</div>

			<StackedSteps className={forceStacked ? "block" : "md:hidden"} />
		</section>
	);
};
