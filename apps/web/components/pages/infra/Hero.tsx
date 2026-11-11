import { COMPLIANCE_SEALS, ComplianceSeal } from "@/components/ComplianceSeals";
import {
	ANCHORS,
	BAA,
	COMPLIANCE,
	DEFAULT_TIER,
	HEADLINE_LINES,
	LINKS,
	PRICES,
	SPEED_MINUTES_TO_FULLY_PROCESSED,
	SPEED_SECONDS_TO_PLAYABLE,
	SPEED_VIDEO_MINUTES,
	usd,
} from "./content";
import { HeroArt } from "./Plain";
import styles from "./scene.module.css";
import { Actions } from "./shared";
import { BODY, H_DISPLAY, MONO } from "./theme";

const PROOFS = [
	{
		href: `#${ANCHORS.compare}`,
		figure: usd(PRICES.deliveryPer1000Minutes[DEFAULT_TIER]),
		label: "per 1,000 minutes watched",
	},
	{
		href: `#${ANCHORS.speed}`,
		figure: `Under ${SPEED_SECONDS_TO_PLAYABLE} seconds`,
		label: `until ${SPEED_VIDEO_MINUTES} minutes of 4K is playable`,
	},
	{
		href: `#${ANCHORS.speed}`,
		figure: `${SPEED_MINUTES_TO_FULLY_PROCESSED} minutes`,
		label: "until every resolution is ready",
	},
] as const;

const RULE = "border-[rgba(222,230,246,0.1)]";

export const Hero = () => (
	<section className={styles.hero}>
		<HeroArt />
		<div className="mx-auto flex h-full max-w-[1184px] flex-col px-5 sm:px-8 lg:justify-center lg:pb-[9vh]">
			<div className="max-w-[560px]">
				<h1
					className={`${H_DISPLAY} m-0 text-balance text-[clamp(33px,4vw,52px)]`}
				>
					{HEADLINE_LINES[0]}{" "}
					<span className="leading-[inherit] tracking-[inherit] lg:block">
						{HEADLINE_LINES[1]}
					</span>
				</h1>
				<p
					className={`${BODY} mt-5 max-w-[420px] text-pretty text-[16px] leading-[1.6]`}
				>
					Upload a video, get back a stream. Adaptive HLS up to 4K, an MP4, a
					thumbnail and a transcript, encoded free on Cap's own GPUs.
				</p>
				<Actions
					className="mt-8"
					secondary={{ label: "Read the docs", href: LINKS.docs }}
				/>
				<ul
					className={`m-0 mt-10 grid list-none border-t p-0 sm:grid-cols-[auto_auto_auto] ${RULE}`}
				>
					{PROOFS.map((proof) => (
						<li
							key={proof.label}
							className={`border-b sm:border-b-0 sm:border-l sm:pl-6 sm:pr-6 sm:first:border-l-0 sm:first:pl-0 sm:last:pr-0 ${RULE}`}
						>
							<a
								href={proof.href}
								className="group flex items-baseline justify-between gap-4 rounded-[6px] py-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[rgba(232,236,244,0.7)] sm:block sm:pb-0 sm:pt-4"
							>
								<span
									className={`${MONO} block shrink-0 text-[15px] tracking-[-0.02em] text-[#E8ECF4] sm:text-[17px]`}
								>
									{proof.figure}
								</span>
								<span className="block text-right text-[13px] leading-[1.45] text-[rgba(232,236,244,0.46)] transition-colors duration-200 group-hover:text-[rgba(232,236,244,0.8)] sm:mt-1 sm:max-w-[142px] sm:text-balance sm:text-left">
									{proof.label}
								</span>
							</a>
						</li>
					))}
				</ul>
				<a
					href={LINKS.trust}
					target="_blank"
					rel="noreferrer"
					aria-label={`${COMPLIANCE} ${BAA} View Cap's Trust Portal`}
					className="group mt-7 inline-flex items-center gap-4 rounded-[8px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[rgba(232,236,244,0.7)] sm:mt-8"
				>
					<span className="flex shrink-0 gap-2 text-[rgba(232,236,244,0.62)] transition-colors duration-200 group-hover:text-[#E8ECF4]">
						{COMPLIANCE_SEALS.map((seal) => (
							<ComplianceSeal
								key={seal.label}
								className="size-10 [&_circle]:[stroke-width:0.8] [&_text]:[font-weight:500]"
							>
								{seal.content}
							</ComplianceSeal>
						))}
					</span>
					<span className="max-w-[230px] text-pretty text-[13px] leading-[1.5] text-[rgba(232,236,244,0.5)] transition-colors duration-200 group-hover:text-[rgba(232,236,244,0.8)]">
						{COMPLIANCE} {BAA}
					</span>
				</a>
			</div>
		</div>
	</section>
);
