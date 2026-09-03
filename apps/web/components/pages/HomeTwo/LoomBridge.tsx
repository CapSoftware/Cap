import { classNames } from "@cap/utils/helpers";
import { ArrowRight } from "lucide-react";
import Link from "next/link";
import { Eyebrow } from "./Eyebrow";
import {
	BAND,
	BODY_TEXT,
	BTN_PRIMARY,
	EYEBROW,
	grainBg,
	MODE_THEME,
} from "./theme";

export const LoomBridge = () => (
	<section className="px-5 pb-4 pt-2">
		<div
			className="mx-auto flex max-w-[1200px] flex-col items-start justify-between gap-8 rounded-[20px] p-8 lg:flex-row lg:items-center lg:p-12"
			style={grainBg(BAND)}
		>
			<div className="max-w-[560px]">
				<Eyebrow accent={MODE_THEME.instant.accent}>
					Switching from Loom
				</Eyebrow>
				<h2 className="mt-5 text-balance text-[clamp(28px,3.2vw,40px)] font-normal leading-[1.05] tracking-[-0.03em] text-[#111111]">
					Bring your whole Loom library with you
				</h2>
				<p
					className={`${BODY_TEXT} mt-4 max-w-[500px] text-[16px] leading-[1.5] text-[rgba(17,17,17,0.78)]`}
				>
					Import every video in one click and pick up where you left off. Your
					recordings land in storage you own, on a plan that stays free.
				</p>
			</div>

			<div className="flex flex-col items-start gap-3 lg:items-end">
				<Link href="/tools/loom-downloader" className={BTN_PRIMARY}>
					Import from Loom
					<ArrowRight className="ml-2 size-4" />
				</Link>
				<p
					className={classNames(
						EYEBROW,
						"text-[11px] text-[rgba(17,17,17,0.5)]",
					)}
				>
					MIGRATE20 · 20% off Pro, forever
				</p>
			</div>
		</div>
	</section>
);
