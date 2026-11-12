import type { CSSProperties } from "react";
import { ANCHORS, clock, LINKS, SPEED_LONG, SPEED_TESTS } from "./content";
import styles from "./scene.module.css";
import { Actions, Section, SectionHeading } from "./shared";
import { MONO } from "./theme";

const Figure = ({ value, label }: { value: number; label: string }) => (
	<div className="shrink-0">
		<p className="m-0 flex items-baseline gap-2 text-[14px] text-[rgba(232,236,244,0.5)]">
			about
			<span
				className={`${MONO} text-[clamp(34px,4vw,44px)] leading-none tracking-[-0.04em] text-[#E8ECF4]`}
			>
				{value}
			</span>
			seconds
		</p>
		<p className="m-0 mt-2 max-w-[160px] text-pretty text-[13px] sm:max-w-[220px] leading-[1.4] text-[rgba(232,236,244,0.46)]">
			{label}
		</p>
	</div>
);

const SCALE = `${MONO} relative h-4 text-[11.5px] leading-4 text-[rgba(232,236,244,0.4)]`;

const LIT = "text-[rgba(232,236,244,0.8)]";

export const Performance = () => (
	<Section id={ANCHORS.speed} className="pt-24 lg:pt-32">
		<div className="grid gap-x-16 gap-y-10 lg:grid-cols-[minmax(0,340px)_minmax(0,1fr)] lg:grid-rows-[auto_1fr] lg:gap-y-8">
			<SectionHeading title="Fast to first play.">
				<p>
					In our tests, a video was playable seconds after its upload finished.
				</p>
			</SectionHeading>
			<figure className="m-0 lg:col-start-2 lg:row-span-2 lg:row-start-1">
				<figcaption className="flex flex-col gap-x-8 gap-y-5 sm:flex-row sm:items-end sm:justify-between">
					<p className="m-0 text-[15px] leading-[1.5] text-[#E8ECF4]">
						From upload finished to playable
					</p>
					<div className="flex flex-wrap gap-x-8 gap-y-5 sm:gap-x-12">
						{SPEED_TESTS.map((test) => (
							<Figure
								key={test.source}
								value={test.seconds}
								label={`for ${test.source}`}
							/>
						))}
					</div>
				</figcaption>
				<div
					aria-hidden="true"
					style={
						{
							"--share": SPEED_LONG.seconds / SPEED_LONG.sourceSeconds,
						} as CSSProperties
					}
				>
					<div className={`${styles.measure} mt-8`}>
						<span className={styles.taken} />
					</div>
					<div className={`${SCALE} mt-3 flex justify-between`}>
						<span className={LIT}>{clock(SPEED_LONG.seconds)}</span>
						<span>{clock(SPEED_LONG.sourceSeconds)}</span>
					</div>
				</div>
				<p className="m-0 mt-6 max-w-[560px] text-pretty text-[13px] leading-[1.6] text-[rgba(232,236,244,0.46)]">
					Measured on production from a cloud machine. For short clips, the
					adaptive streaming renditions followed within seconds.
				</p>
			</figure>
			<Actions
				className="self-start lg:col-start-1 lg:row-start-2"
				secondary={{ label: "Read the docs", href: LINKS.docs }}
			/>
		</div>
	</Section>
);
