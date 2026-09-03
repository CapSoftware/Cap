"use client";

import { classNames } from "@cap/utils/helpers";
import { useRef } from "react";
import { Eyebrow } from "../Eyebrow";
import { Fit, LazyMount } from "../scenes/engine";
import {
	BAND,
	BODY_TEXT,
	grainBg,
	H_SECTION,
	MODE_THEME,
	meshStyle,
} from "../theme";
import { useInView, useReducedMotion } from "../visibility";
import { CARDS_A } from "./cardsA";
import { CARDS_B } from "./cardsB";
import { CANVAS, type StudioCard } from "./shared";

const ORDER = [
	"mask",
	"text",
	"scenes",
	"zoom",
	"captions",
	"three-d",
	"canvas",
	"grades",
	"clips",
];
const SPAN: Record<string, 1 | 2> = { mask: 2, scenes: 2, clips: 2 };
const ALL = [...CARDS_A, ...CARDS_B];
const CARDS = ORDER.flatMap((key) => {
	const card = ALL.find((item) => item.key === key);
	return card ? [{ ...card, span: SPAN[key] ?? 1 }] : [];
});

const Card = ({ card }: { card: StudioCard }) => {
	const ref = useRef<HTMLLIElement | null>(null);
	const inView = useInView(ref, "-5% 0px -5% 0px");
	const reduced = useReducedMotion();
	return (
		<li
			ref={ref}
			className={classNames(
				"flex flex-col rounded-[22px] p-3",
				card.span === 2 ? "lg:col-span-2" : undefined,
			)}
			style={grainBg(BAND)}
		>
			<div className="rounded-[16px] p-2" style={meshStyle(MODE_THEME.studio)}>
				<LazyMount
					w={CANVAS.w}
					h={CANVAS.h}
					grow={card.span === 2}
					className="mx-auto"
				>
					<Fit
						w={CANVAS.w}
						h={CANVAS.h}
						grow={card.span === 2}
						className="mx-auto"
					>
						<card.Visual playing={inView && !reduced} />
					</Fit>
				</LazyMount>
			</div>
			<div className="px-3 pb-3 pt-5">
				<h3 className="text-[19px] font-normal leading-[1.15] tracking-[-0.02em] text-[#111111]">
					{card.title}
				</h3>
				<p
					className={`${BODY_TEXT} mt-2 text-[14.5px] leading-[1.5] text-[rgba(17,17,17,0.72)]`}
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
			<div className="mx-auto flex max-w-[760px] flex-col items-center text-center">
				<Eyebrow accent={MODE_THEME.studio.accent}>
					Studio Mode · The editor
				</Eyebrow>
				<h2
					className={`${H_SECTION} mt-6 text-balance text-[clamp(38px,5vw,56px)]`}
				>
					Polish it before anyone sees it
				</h2>
				<p
					className={`${BODY_TEXT} mt-6 max-w-[620px] text-balance text-[16.5px] leading-[1.5] text-[rgba(17,17,17,0.78)] sm:text-[17.5px]`}
				>
					Studio Mode opens straight into an editor made for screen recordings.
					Blur what is private, switch scenes between screen and camera, add
					text and captions, grade the color, and export in 4K or as a link.
				</p>
			</div>

			<ul className="mt-14 grid gap-4 md:grid-cols-2 lg:grid-cols-3">
				{CARDS.map((card) => (
					<Card key={card.key} card={card} />
				))}
			</ul>
		</div>
	</section>
);
