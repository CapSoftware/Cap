import type { CSSProperties } from "react";
import { ANCHORS, clock, MEASUREMENTS } from "./content";
import styles from "./scene.module.css";
import { Section, SectionHeading } from "./shared";
import { MONO } from "./theme";

export const Performance = () => (
	<Section id={ANCHORS.speed} className="pt-28 lg:pt-40">
		<div className="grid gap-x-16 gap-y-12 lg:grid-cols-[minmax(0,340px)_minmax(0,1fr)]">
			<SectionHeading title="Ready in seconds.">
				<p>
					The pipeline runs on Cap's own GPUs and splits each video across them.
				</p>
			</SectionHeading>
			<div className="flex flex-col gap-12">
				{MEASUREMENTS.map((item) => (
					<figure key={item.key} className="m-0">
						<figcaption className="flex items-end justify-between gap-6">
							<p className="m-0 max-w-[260px] text-pretty text-[15px] leading-[1.5] text-[rgba(232,236,244,0.56)]">
								<span className="block text-[#E8ECF4]">{item.source}</span>
								{item.result}
							</p>
							<p className="m-0 flex shrink-0 items-baseline gap-2 text-[14px] text-[rgba(232,236,244,0.5)]">
								about
								<span
									className={`${MONO} text-[clamp(34px,4vw,44px)] leading-none tracking-[-0.04em] text-[#E8ECF4]`}
								>
									{item.seconds}
								</span>
								seconds
							</p>
						</figcaption>
						<div
							aria-hidden="true"
							className={`${styles.measure} mt-7`}
							style={
								{
									"--share": item.seconds / item.sourceSeconds,
								} as CSSProperties
							}
						>
							<span className={styles.taken} />
						</div>
						<div
							aria-hidden="true"
							className={`${MONO} mt-3 flex justify-between text-[11.5px] text-[rgba(232,236,244,0.4)]`}
						>
							<span className="text-[rgba(232,236,244,0.8)]">
								{clock(item.seconds)}
							</span>
							<span>{clock(item.sourceSeconds)}</span>
						</div>
					</figure>
				))}
			</div>
		</div>
	</Section>
);
