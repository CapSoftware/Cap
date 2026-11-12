import { buildEnv } from "@cap/env";
import type { CSSProperties } from "react";
import { COMPLIANCE_SEALS, ComplianceSeal } from "@/components/ComplianceSeals";
import { PLAIN } from "./art";
import {
	ANCHORS,
	BAA,
	COMPLIANCE,
	DEFAULT_TIER,
	HEADLINE_LINES,
	LINKS,
	PREVIEW_NOTE,
	PRICES,
	SPEED_LONG_MINUTES,
	SPEED_LONG_SECONDS,
	SPEED_SHORT_CLIP_SECONDS,
	usd,
} from "./content";
import { FilmButton } from "./Film";
import { filmFiles } from "./film-source";
import { HeroArt } from "./Plain";
import styles from "./scene.module.css";
import { Actions } from "./shared";
import { BODY, H_DISPLAY, MONO } from "./theme";

const PROOFS = [
	{
		href: `#${ANCHORS.pricing}`,
		figure: usd(PRICES.storagePer1000Minutes[DEFAULT_TIER]),
		label: "per 1,000 minutes stored, per month",
	},
	{
		href: `#${ANCHORS.speed}`,
		figure: `~${SPEED_SHORT_CLIP_SECONDS} sec`,
		label: "after upload until a short clip is playable, in our tests",
	},
	{
		href: `#${ANCHORS.speed}`,
		figure: `~${SPEED_LONG_SECONDS} sec`,
		label: `after upload until ${SPEED_LONG_MINUTES} minutes of 4K is playable, in our tests`,
	},
] as const;

const RULE = "border-[rgba(222,230,246,0.1)]";

const FILM_FILES = filmFiles(buildEnv.NEXT_PUBLIC_INFRA_FILM_URL);

export const Hero = () => (
	<section className={styles.hero}>
		<HeroArt />
		{FILM_FILES ? (
			<div
				className={styles.stage}
				style={
					{
						"--slab-base": PLAIN.slabBase,
					} as CSSProperties
				}
			>
				<FilmButton files={FILM_FILES} />
			</div>
		) : null}
		<div className="mx-auto flex h-full max-w-[1184px] flex-col px-5 sm:px-8 lg:justify-center lg:pb-[7vh]">
			<div className="max-w-[520px]">
				<h1
					className={`${H_DISPLAY} m-0 text-balance text-[clamp(33px,4vw,52px)]`}
				>
					{HEADLINE_LINES[0]}{" "}
					<span className="leading-[inherit] tracking-[inherit] lg:block">
						{HEADLINE_LINES[1]}
					</span>
				</h1>
				<p
					className={`${BODY} mt-5 max-w-[450px] text-pretty text-[16px] leading-[1.6]`}
				>
					Upload a video and get back an adaptive stream up to 4K, an MP4, a
					poster and a hosted player. Uploading and encoding are free.
				</p>
				<Actions
					className="mt-8"
					secondary={{ label: "Read the docs", href: LINKS.docs }}
				/>
				{PREVIEW_NOTE ? (
					<p className="m-0 mt-4 text-[13px] leading-[1.5] text-[rgba(232,236,244,0.5)]">
						{PREVIEW_NOTE}
					</p>
				) : null}
				<ul
					className={`m-0 mt-11 grid list-none border-t p-0 sm:grid-cols-3 sm:pt-6 ${RULE}`}
				>
					{PROOFS.map((proof) => (
						<li
							key={proof.label}
							className={`border-b sm:border-b-0 sm:border-l sm:pl-5 sm:first:border-l-0 sm:first:pl-0 ${RULE}`}
						>
							<a
								href={proof.href}
								className="group flex items-baseline justify-between gap-4 rounded-[6px] py-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[rgba(232,236,244,0.7)] sm:block sm:py-0"
							>
								<span
									className={`${MONO} block shrink-0 text-[17px] leading-none tracking-[-0.04em] text-white sm:text-[26px]`}
								>
									{proof.figure}
								</span>
								<span className="block text-right text-[13px] leading-[1.45] text-[rgba(232,236,244,0.5)] transition-colors duration-200 group-hover:text-[rgba(232,236,244,0.82)] sm:mt-2.5 sm:max-w-[136px] sm:text-pretty sm:text-left">
									{proof.label}
								</span>
							</a>
						</li>
					))}
				</ul>
				<div className={`mt-5 sm:mt-6 sm:border-t sm:pt-5 ${RULE}`}>
					<a
						href={LINKS.trust}
						target="_blank"
						rel="noreferrer"
						aria-label={`${COMPLIANCE} ${BAA} View Cap's Trust Portal`}
						className="group inline-flex items-center gap-3.5 rounded-[8px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[rgba(232,236,244,0.7)]"
					>
						<span className="flex shrink-0 gap-1.5 text-[rgba(232,236,244,0.62)] transition-colors duration-200 group-hover:text-[#E8ECF4]">
							{COMPLIANCE_SEALS.map((seal) => (
								<ComplianceSeal
									key={seal.label}
									className="size-8 [&_circle]:[stroke-width:0.8] [&_text]:[font-weight:500]"
								>
									{seal.content}
								</ComplianceSeal>
							))}
						</span>
						<span className="text-pretty text-[13px] leading-[1.5] text-[rgba(232,236,244,0.5)] transition-colors duration-200 group-hover:text-[rgba(232,236,244,0.82)]">
							{COMPLIANCE} {BAA}
						</span>
					</a>
				</div>
			</div>
		</div>
	</section>
);
