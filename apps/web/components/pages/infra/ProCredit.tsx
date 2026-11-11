import Link from "next/link";
import {
	ANCHORS,
	DEFAULT_TIER,
	LINKS,
	PRICES,
	PRO_CREDIT_COVERS,
	TIER_LABEL,
	usdWhole,
} from "./content";
import { Section, SectionHeading } from "./shared";
import { BTN_GHOST, BTN_PRIMARY, MONO } from "./theme";

const grouped = new Intl.NumberFormat("en-US");

const CREDIT = usdWhole(PRICES.proMonthlyCredit);

export const ProCredit = () => (
	<Section id={ANCHORS.pro} className="pt-28 lg:pt-40">
		<div className="grid gap-x-16 gap-y-10 lg:grid-cols-[minmax(0,340px)_minmax(0,1fr)] lg:grid-rows-[auto_1fr] lg:gap-y-8">
			<SectionHeading title={`${CREDIT} free every month with Cap Pro.`}>
				<p>
					Every Cap Pro subscription comes with {CREDIT} of Cap Infra credit
					each month. Your usage comes out of it first.
				</p>
			</SectionHeading>
			<figure className="m-0 min-w-0 lg:col-start-2 lg:row-span-2 lg:row-start-1">
				<figcaption className="text-pretty text-[15px] leading-[1.5] text-[rgba(232,236,244,0.56)]">
					<span className="block leading-[inherit] text-[#E8ECF4]">
						What {CREDIT} covers at {TIER_LABEL[DEFAULT_TIER]}
					</span>
					Any one of these, every month
				</figcaption>
				<dl className="m-0 mt-6 grid border-t border-[rgba(222,230,246,0.08)] sm:grid-cols-3 sm:pt-6">
					{PRO_CREDIT_COVERS.map((cover) => (
						<div
							key={cover.unit}
							className="flex items-baseline justify-between gap-4 border-b border-[rgba(222,230,246,0.08)] py-3 sm:flex-col-reverse sm:items-start sm:justify-end sm:gap-2.5 sm:border-b-0 sm:border-l sm:py-0 sm:pl-6 sm:first:border-l-0 sm:first:pl-0"
						>
							<dt className="text-[13.5px] leading-[1.3] text-[rgba(232,236,244,0.5)]">
								{cover.unit}
							</dt>
							<dd
								className={`${MONO} m-0 text-[17px] leading-none tracking-[-0.04em] tabular-nums text-white sm:text-[clamp(26px,3vw,36px)]`}
							>
								{grouped.format(cover.amount)}
							</dd>
						</div>
					))}
				</dl>
				<p className="m-0 mt-4 text-pretty text-[12.5px] leading-[1.65] text-[rgba(232,236,244,0.42)] sm:mt-5">
					Worked out from the prices above and rounded down.
				</p>
			</figure>
			<div className="flex flex-wrap gap-2.5 self-start lg:col-start-1 lg:row-start-2">
				<Link href={LINKS.start} className={BTN_PRIMARY}>
					Start building
				</Link>
				<Link href={LINKS.pro} className={BTN_GHOST}>
					See Cap Pro
				</Link>
			</div>
		</div>
	</Section>
);
