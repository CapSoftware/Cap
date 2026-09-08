"use client";

import { useRef } from "react";
import { Eyebrow } from "../Eyebrow";
import { Fit, LazyMount } from "../scenes/engine";
import { BAND, BODY_TEXT, grainBg, H_SECTION, MODE_THEME } from "../theme";
import { useInView, useReducedMotion } from "../visibility";
import { CARDS_A, CARDS_B } from "./catalog";
import { CANVAS, type StudioCard } from "./shared";

const ORDER = [
	"mask",
	"scenes",
	"zoom",
	"captions",
	"text",
	"three-d",
	"canvas",
	"grades",
	"clips",
];
const ALL = [...CARDS_A, ...CARDS_B];
const CARDS = ORDER.flatMap((key) => {
	const card = ALL.find((item) => item.key === key);
	return card ? [card] : [];
});

const Card = ({ card }: { card: StudioCard }) => {
	const ref = useRef<HTMLLIElement | null>(null);
	const inView = useInView(ref, "-5% 0px -5% 0px");
	const reduced = useReducedMotion();
	return (
		<li
			ref={ref}
			className="flex flex-col rounded-[18px] p-1.5 shadow-[0_0_0_1px_rgba(17,17,17,0.05)] md:last:col-span-2 lg:last:col-span-1"
			style={grainBg(BAND)}
		>
			<div className="overflow-hidden rounded-[13px] shadow-[0_0_0_1px_rgba(17,17,17,0.06)]">
				<LazyMount w={CANVAS.w} h={CANVAS.h} grow>
					<Fit w={CANVAS.w} h={CANVAS.h} grow>
						<card.Visual playing={inView && !reduced} />
					</Fit>
				</LazyMount>
			</div>
			<div className="px-3.5 pb-3.5 pt-3.5">
				<h3 className="text-[17px] font-medium leading-[1.2] tracking-[-0.02em] text-[#111111]">
					{card.title}
				</h3>
				<p
					className={`${BODY_TEXT} mt-1.5 text-[14px] leading-[1.5] text-[rgba(17,17,17,0.68)]`}
				>
					{card.body}
				</p>
			</div>
		</li>
	);
};

export const StudioFeatures = () => (
	<section className="px-5 py-16 lg:py-24">
		<div className="mx-auto max-w-[1200px]">
			<div className="mx-auto flex max-w-[720px] flex-col items-center text-center">
				<Eyebrow accent={MODE_THEME.studio.accent}>
					Studio Mode · The editor
				</Eyebrow>
				<h2
					className={`${H_SECTION} mt-6 text-balance text-[clamp(34px,4.4vw,48px)]`}
				>
					Polish it before anyone sees it
				</h2>
				<p
					className={`${BODY_TEXT} mt-5 max-w-[560px] text-balance text-[16px] leading-[1.5] text-[rgba(17,17,17,0.78)] sm:text-[17px]`}
				>
					Studio Mode opens straight into an editor made for screen recordings.
					Blur what is private, switch scenes between screen and camera, add
					text and captions, grade the color, and export in 4K or as a link.
				</p>
			</div>

			<ul className="mt-10 grid gap-3 md:grid-cols-2 lg:grid-cols-3">
				{CARDS.map((card) => (
					<Card key={card.key} card={card} />
				))}
			</ul>
		</div>
	</section>
);
