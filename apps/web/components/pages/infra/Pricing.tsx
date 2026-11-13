import { INFRA_SPEECH_DOLLARS_PER_HOUR } from "@/lib/infra-pricing";
import { Calculator } from "./Calculator";
import {
	ANCHORS,
	DELIVERED_MINUTE,
	DELIVERY_RULE,
	PRICE_ROWS,
	STORAGE_RULE,
	TIER_LABEL,
	TIERS,
	usd,
} from "./content";
import { Section, SectionHeading } from "./shared";
import { MONO } from "./theme";

const ROW = "border-b border-[rgba(222,230,246,0.08)]";

const FIGURE = `${MONO} text-[13.5px] tabular-nums text-[#E8ECF4]`;

export const Pricing = () => (
	<Section id={ANCHORS.pricing} className="pt-24 lg:pt-32">
		<div className="grid gap-x-16 gap-y-10 lg:grid-cols-[minmax(0,340px)_minmax(0,1fr)]">
			<SectionHeading title="Pay for minutes, not plans.">
				<p>
					Three things are charged: stored video, delivered video and speech to
					text. Uploading and encoding are free. Credits are prepaid.
				</p>
			</SectionHeading>
			<div className="min-w-0">
				<table className="w-full table-fixed border-collapse text-left">
					<caption className="sr-only">Cap Infra prices by resolution</caption>
					<thead>
						<tr className={ROW}>
							<th scope="col" className="w-[40%] p-0 sm:w-[44%]">
								<span className="sr-only">Meter</span>
							</th>
							{TIERS.map((tier, i) => (
								<th
									key={tier}
									scope="col"
									className="pb-3 text-right align-bottom text-[13px] font-normal leading-[1.4] text-[rgba(232,236,244,0.46)]"
								>
									{i === 0 ? (
										<span className="hidden leading-[inherit] sm:inline">
											Up to{" "}
										</span>
									) : null}
									{TIER_LABEL[tier]}
								</th>
							))}
						</tr>
					</thead>
					<tbody>
						{PRICE_ROWS.map((row) => (
							<tr key={row.meter} className={ROW}>
								<th
									scope="row"
									className="py-3.5 pr-4 align-top text-[14.5px] font-normal leading-[1.4] text-[#E8ECF4]"
								>
									{row.meter}
									{row.unit ? (
										<span className="block text-pretty text-[13px] text-[rgba(232,236,244,0.46)]">
											{row.unit}
										</span>
									) : null}
								</th>
								{row.rates ? (
									TIERS.map((tier) => (
										<td
											key={tier}
											className={`${FIGURE} py-3.5 text-right align-top leading-[1.5]`}
										>
											{usd(row.rates?.[tier] ?? 0)}
										</td>
									))
								) : (
									<td colSpan={TIERS.length} className="py-3.5 align-top">
										<span className="flex flex-col-reverse items-end gap-x-3 text-right text-[13.5px] leading-[1.5] text-[rgba(232,236,244,0.46)] sm:flex-row sm:items-baseline sm:justify-end">
											{row.note ? (
												<span className="text-pretty leading-[inherit]">
													{row.note}
												</span>
											) : null}
											<span className={`${FIGURE} leading-[inherit]`}>
												{row.price}
											</span>
										</span>
									</td>
								)}
							</tr>
						))}
					</tbody>
				</table>
				<p className="m-0 mt-4 max-w-[560px] text-pretty text-[13px] leading-[1.6] text-[rgba(232,236,244,0.46)]">
					{STORAGE_RULE} A video is billed by its length and resolution tier.
					Videos are encoded up to 1080p by default, and 1440p and 4K are set
					per upload.
				</p>
				<p className="m-0 mt-3 max-w-[560px] text-pretty text-[13px] leading-[1.6] text-[rgba(232,236,244,0.46)]">
					{DELIVERED_MINUTE} {DELIVERY_RULE}
				</p>
				<dl className="m-0 mt-8 flex items-baseline justify-between gap-4 border-y border-[rgba(222,230,246,0.08)] py-3.5">
					<dt className="text-[14.5px] leading-[1.4] text-[#E8ECF4]">
						Speech to text
					</dt>
					<dd className="m-0 text-right text-[13.5px] leading-[1.5] text-[rgba(232,236,244,0.46)]">
						<span className={`${FIGURE} leading-[inherit]`}>
							{usd(INFRA_SPEECH_DOLLARS_PER_HOUR)}
						</span>{" "}
						per audio hour
					</dd>
				</dl>
			</div>
		</div>
		<div className="mt-14 lg:mt-20">
			<Calculator />
		</div>
	</Section>
);
