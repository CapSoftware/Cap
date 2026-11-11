import type { CSSProperties, ReactNode } from "react";
import {
	ANCHORS,
	clock,
	LINKS,
	SPEED_MINUTES_TO_FULLY_PROCESSED,
	SPEED_SECONDS_TO_PLAYABLE,
	SPEED_SPEECH,
	SPEED_VIDEO,
} from "./content";
import styles from "./scene.module.css";
import { Actions, Section, SectionHeading } from "./shared";
import { MONO } from "./theme";

const Figure = ({
	lead,
	value,
	unit,
	label,
}: {
	lead: string;
	value: number;
	unit: string;
	label: string;
}) => (
	<div>
		<p className="m-0 flex items-baseline gap-2 text-[14px] text-[rgba(232,236,244,0.5)]">
			{lead}
			<span
				className={`${MONO} text-[clamp(34px,4vw,44px)] leading-none tracking-[-0.04em] text-[#E8ECF4]`}
			>
				{value}
			</span>
			{unit}
		</p>
		<p className="m-0 mt-2 text-[13px] leading-[1.4] text-[rgba(232,236,244,0.46)]">
			{label}
		</p>
	</div>
);

const Measured = ({
	source,
	figures,
	children,
}: {
	source: string;
	figures: ReactNode;
	children: ReactNode;
}) => (
	<figure className="m-0">
		<figcaption className="flex flex-col gap-x-8 gap-y-5 sm:flex-row sm:items-end sm:justify-between">
			<p className="m-0 text-[15px] leading-[1.5] text-[#E8ECF4]">{source}</p>
			<div className="flex gap-8 sm:gap-12">{figures}</div>
		</figcaption>
		{children}
	</figure>
);

const SCALE = `${MONO} relative h-4 text-[11.5px] leading-4 text-[rgba(232,236,244,0.4)]`;

const LIT = "text-[rgba(232,236,244,0.8)]";

export const Performance = () => (
	<Section id={ANCHORS.speed} className="pt-28 lg:pt-40">
		<div className="grid gap-x-16 gap-y-10 lg:grid-cols-[minmax(0,340px)_minmax(0,1fr)] lg:grid-rows-[auto_1fr] lg:gap-y-8">
			<SectionHeading title="Ready in seconds.">
				<p>
					The pipeline runs on Cap's own GPUs and splits each video across them.
				</p>
			</SectionHeading>
			<div className="flex flex-col gap-14 lg:col-start-2 lg:row-span-2 lg:row-start-1">
				<Measured
					source={SPEED_VIDEO.source}
					figures={
						<>
							<Figure
								lead="under"
								value={SPEED_SECONDS_TO_PLAYABLE}
								unit="seconds"
								label="until it is playable"
							/>
							<Figure
								lead="in"
								value={SPEED_MINUTES_TO_FULLY_PROCESSED}
								unit="minutes"
								label="fully downloadable"
							/>
						</>
					}
				>
					<div
						aria-hidden="true"
						style={
							{
								"--share":
									SPEED_VIDEO.playableSeconds / SPEED_VIDEO.sourceSeconds,
								"--reach":
									SPEED_VIDEO.processedSeconds / SPEED_VIDEO.sourceSeconds,
							} as CSSProperties
						}
					>
						<div className={`${SCALE} mt-8`}>
							<span className={LIT}>{clock(SPEED_VIDEO.playableSeconds)}</span>
						</div>
						<div className={`${styles.measure} mt-2.5`}>
							<span className={styles.reach} />
							<span className={styles.taken} />
						</div>
						<div className={`${SCALE} mt-3`}>
							<span className={`${styles.atReach} ${LIT}`}>
								{clock(SPEED_VIDEO.processedSeconds)}
							</span>
							<span className="absolute right-0">
								{clock(SPEED_VIDEO.sourceSeconds)}
							</span>
						</div>
					</div>
				</Measured>
				<Measured
					source={SPEED_SPEECH.source}
					figures={
						<Figure
							lead="about"
							value={SPEED_SPEECH.seconds}
							unit="seconds"
							label="until it is transcribed"
						/>
					}
				>
					<div
						aria-hidden="true"
						style={
							{
								"--share": SPEED_SPEECH.seconds / SPEED_SPEECH.sourceSeconds,
							} as CSSProperties
						}
					>
						<div className={`${styles.measure} mt-7`}>
							<span className={styles.taken} />
						</div>
						<div className={`${SCALE} mt-3 flex justify-between`}>
							<span className={LIT}>{clock(SPEED_SPEECH.seconds)}</span>
							<span>{clock(SPEED_SPEECH.sourceSeconds)}</span>
						</div>
					</div>
				</Measured>
			</div>
			<Actions
				className="self-start lg:col-start-1 lg:row-start-2"
				secondary={{ label: "Read the docs", href: LINKS.docs }}
			/>
		</div>
	</Section>
);
