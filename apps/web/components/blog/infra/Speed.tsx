import type { CSSProperties } from "react";
import {
	clock,
	SPEED_LONG,
	SPEED_TESTS,
} from "@/components/pages/infra/content";
import styles from "@/components/pages/infra/scene.module.css";
import { MONO } from "@/components/pages/infra/theme";
import { InfraStage, MUTED } from "./Stage";

export function InfraSpeed() {
	return (
		<InfraStage
			className="px-6 py-9 sm:px-12 sm:py-12"
			caption="Playback starts while the rest of the ladder encodes. Every rendition up to 4K follows in about 2 minutes."
		>
			<div>
				<div className="text-[15.5px] font-medium leading-[1.5] tracking-[-0.01em] text-[#E8ECF4]">
					From upload finished
				</div>
				<div className="mt-7 grid gap-y-6 sm:grid-cols-2 sm:gap-x-12">
					{SPEED_TESTS.map((test) => (
						<div key={test.label} className="shrink-0">
							<div className={`flex items-baseline gap-2 text-[14px] ${MUTED}`}>
								{test.qualifier}
								<span
									className={`${MONO} text-[clamp(34px,4vw,44px)] leading-none tracking-[-0.04em] text-[#E8ECF4]`}
								>
									{test.value}
								</span>
								{test.unit}
							</div>
							<div className="mt-2.5 text-pretty text-[14px] leading-[1.5] text-[rgba(232,236,244,0.46)]">
								{test.label}
							</div>
						</div>
					))}
				</div>
			</div>
			<div
				aria-hidden="true"
				style={
					{
						"--share": SPEED_LONG.seconds / SPEED_LONG.sourceSeconds,
					} as CSSProperties
				}
			>
				<div className={`${styles.measure} mt-10`}>
					<span className={styles.taken} />
				</div>
				<div
					className={`${MONO} mt-3 flex justify-between text-[11.5px] leading-4 text-[rgba(232,236,244,0.4)]`}
				>
					<span className="text-[rgba(232,236,244,0.8)]">
						{clock(SPEED_LONG.seconds)} to play
					</span>
					<span>{clock(SPEED_LONG.sourceSeconds)} of 4K</span>
				</div>
			</div>
		</InfraStage>
	);
}
