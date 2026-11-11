import { Calculator } from "./Calculator";
import { ANCHORS, PRICE_ROWS, PRICES, usdWhole } from "./content";
import { Section, SectionHeading } from "./shared";

export const Pricing = () => (
	<Section id={ANCHORS.pricing} className="bg-[#EDF1F6]/60">
		<div className="grid gap-12 lg:grid-cols-[minmax(0,0.85fr)_minmax(0,1.15fr)] lg:gap-16">
			<SectionHeading title="Pay for minutes, not plans.">
				<p className="m-0">
					Encoding is free. You pay for what you store, what your viewers watch
					and what you transcribe. No minimums, no seats, no plans.
				</p>
				<p className="m-0 mt-4">
					Cap Pro subscribers get {usdWhole(PRICES.proMonthlyCredit)} of usage
					every month.
				</p>
			</SectionHeading>
			<table className="w-full min-w-0 border-collapse text-left">
				<caption className="sr-only">Cap Infra prices</caption>
				<thead className="sr-only">
					<tr>
						<th scope="col">Meter</th>
						<th scope="col">Price</th>
					</tr>
				</thead>
				<tbody>
					{PRICE_ROWS.map((row) => (
						<tr key={row.meter} className="border-b border-[#D9E1EA]">
							<th
								scope="row"
								className="whitespace-nowrap py-5 pr-4 align-top text-[16px] font-normal tracking-[-0.01em] text-[#111111] sm:text-[17px]"
							>
								{row.meter}
							</th>
							<td className="py-5 text-right align-top">
								<span className="block text-[22px] leading-none tracking-[-0.03em] text-[#111111] tabular-nums sm:text-[26px]">
									{row.price}
								</span>
								<span className="mt-2 block text-[13.5px] leading-[1.4] text-[rgba(17,17,17,0.58)]">
									{row.unit}
								</span>
								{row.note ? (
									<span className="mt-0.5 block text-[13.5px] leading-[1.4] text-[#2F6CB5]">
										{row.note}
									</span>
								) : null}
							</td>
						</tr>
					))}
				</tbody>
			</table>
		</div>
		<div className="mt-16 lg:mt-20">
			<h3 className="text-[22px] font-normal tracking-[-0.02em] text-[#111111] sm:text-[26px]">
				Estimate your month
			</h3>
			<div className="mt-6">
				<Calculator />
			</div>
		</div>
	</Section>
);
