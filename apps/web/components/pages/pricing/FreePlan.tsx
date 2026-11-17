"use client";

import { classNames } from "@cap/utils/helpers";
import { useCurrency } from "hooks/useCurrency";
import { Check } from "lucide-react";
import { DownloadCtaLink } from "@/components/download/DownloadCtaLink";
import {
	BODY_TEXT,
	BTN_SECONDARY,
	MODE_THEME,
} from "@/components/pages/HomeTwo/theme";
import { homepageCopy } from "@/data/homepage-copy";

const copy = homepageCopy.pricing.free;
const theme = MODE_THEME.studio;

export const FreePlan = () => {
	const { symbol } = useCurrency();
	return (
		<article className="flex flex-col gap-6 rounded-[22px] bg-white p-6 shadow-[0_0_0_1px_rgba(17,17,17,0.06),0_24px_48px_-32px_rgba(17,17,17,0.28)] lg:flex-row lg:items-center lg:gap-10 lg:px-8 lg:py-7">
			<div className="lg:w-[300px] lg:shrink-0">
				<div className="flex items-center gap-3">
					<h2 className="text-[22px] font-normal leading-[1.1] tracking-[-0.02em] text-[#111111]">
						{copy.title}
					</h2>
					<span
						className="rounded-full px-2.5 py-[6px] text-[12px] font-medium leading-none tracking-[-0.01em]"
						style={{ background: theme.chip, color: theme.glyph }}
					>
						Personal use
					</span>
				</div>
				<p
					className={`${BODY_TEXT} mt-3 text-[15px] leading-[1.5] text-[rgba(17,17,17,0.72)]`}
				>
					{copy.description}
				</p>
			</div>

			<ul className="grid flex-1 gap-x-8 gap-y-3 sm:grid-cols-2">
				{copy.features.map((feature) => (
					<li key={feature} className="flex items-start gap-3">
						<span
							className="mt-px grid size-5 shrink-0 place-items-center rounded-full"
							style={{ background: theme.chip, color: theme.glyph }}
						>
							<Check className="size-3" strokeWidth={2.5} />
						</span>
						<span className="text-[14px] leading-snug text-[rgba(17,17,17,0.72)]">
							{feature}
						</span>
					</li>
				))}
			</ul>

			<div className="flex items-center justify-between gap-5 lg:shrink-0 lg:justify-end">
				<span className="whitespace-nowrap text-[34px] font-normal leading-none tracking-[-0.03em] tabular-nums text-[#111111]">
					{symbol}0
				</span>
				<DownloadCtaLink
					sourcePage="pricing"
					ctaLocation="free_plan"
					className={classNames(BTN_SECONDARY, "px-5")}
				>
					{copy.cta}
				</DownloadCtaLink>
			</div>
		</article>
	);
};
