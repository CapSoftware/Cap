import Link from "next/link";
import {
	ANCHORS,
	DEFAULT_TIER,
	ENCODE_SECONDS_FOR_FIVE_MINUTES_OF_4K,
	LINKS,
	PRICES,
	usd,
} from "./content";
import { HeroArt } from "./Plain";
import styles from "./scene.module.css";
import { BODY, BTN_GHOST, BTN_PRIMARY, H_DISPLAY, MONO } from "./theme";

const PROOFS = [
	{
		href: `#${ANCHORS.compare}`,
		figure: usd(PRICES.deliveryPer1000Minutes[DEFAULT_TIER]),
		label: "per 1,000 minutes watched",
	},
	{
		href: `#${ANCHORS.speed}`,
		figure: `${ENCODE_SECONDS_FOR_FIVE_MINUTES_OF_4K} seconds`,
		label: "to encode five minutes of 4K",
	},
] as const;

export const Hero = () => (
	<section className={styles.hero}>
		<HeroArt />
		<div className="mx-auto flex h-full max-w-[1184px] flex-col px-5 sm:px-8 lg:justify-center lg:pb-[12vh]">
			<div className="max-w-[540px]">
				<h1
					className={`${H_DISPLAY} m-0 text-balance text-[clamp(33px,4vw,52px)]`}
				>
					The cheapest, fastest{" "}
					<span className="leading-[inherit] tracking-[inherit] lg:block">
						video infrastructure
					</span>{" "}
					<span className="leading-[inherit] tracking-[inherit] lg:block">
						on the planet.
					</span>
				</h1>
				<p
					className={`${BODY} mt-5 max-w-[420px] text-pretty text-[16px] leading-[1.6]`}
				>
					Upload a video, get back a stream. Adaptive HLS up to 4K, an MP4, a
					thumbnail and a transcript, encoded free on Cap's own GPUs.
				</p>
				<div className="mt-8 flex flex-wrap gap-2.5">
					<Link href={LINKS.start} className={BTN_PRIMARY}>
						Start building
					</Link>
					<Link href={LINKS.docs} className={BTN_GHOST}>
						Read the docs
					</Link>
				</div>
				<ul className="m-0 mt-10 flex max-w-[440px] list-none border-t border-[rgba(222,230,246,0.1)] p-0">
					{PROOFS.map((proof) => (
						<li
							key={proof.href}
							className="flex-1 border-l border-[rgba(222,230,246,0.1)] pl-5 pr-3 first:border-l-0 first:pl-0"
						>
							<a
								href={proof.href}
								className="group block rounded-[6px] pt-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[rgba(232,236,244,0.7)]"
							>
								<span
									className={`${MONO} block text-[15px] tracking-[-0.02em] text-[#E8ECF4]`}
								>
									{proof.figure}
								</span>
								<span className="mt-1 block text-pretty text-[13px] leading-[1.45] text-[rgba(232,236,244,0.46)] transition-colors duration-200 group-hover:text-[rgba(232,236,244,0.8)]">
									{proof.label}
								</span>
							</a>
						</li>
					))}
				</ul>
			</div>
		</div>
	</section>
);
