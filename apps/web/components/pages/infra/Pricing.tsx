import { Calculator } from "./Calculator";
import { ANCHORS, PRICE_ROWS, PRICES, usdWhole } from "./content";
import { Section, SectionHeading } from "./shared";

export const Pricing = () => (
	<Section id={ANCHORS.pricing} className="pt-28 lg:pt-40">
		<div className="grid gap-x-16 gap-y-10 lg:grid-cols-[minmax(0,340px)_minmax(0,1fr)]">
			<SectionHeading title="Pay for minutes, not plans.">
				<p>
					Encoding is free. No minimums, no seats, no plans. Credits are
					prepaid, and Cap Pro subscribers get{" "}
					{usdWhole(PRICES.proMonthlyCredit)} of usage every month.
				</p>
			</SectionHeading>
			<table className="w-full min-w-0 border-collapse text-left">
				<caption className="sr-only">Cap Infra prices</caption>
				<thead className="sr-only">
					<tr>
						<th scope="col">Meter</th>
						<th scope="col">Price</th>
						<th scope="col">Unit</th>
					</tr>
				</thead>
				<tbody>
					{PRICE_ROWS.map((row) => (
						<tr
							key={row.meter}
							className="border-b border-[rgba(222,230,246,0.08)] first:border-t"
						>
							<th
								scope="row"
								className="w-[34%] py-3.5 pr-4 align-baseline text-[14.5px] font-normal text-[#E8ECF4] sm:w-[28%]"
							>
								{row.meter}
							</th>
							<td className="w-[84px] py-3.5 pr-4 align-baseline text-[14.5px] tabular-nums text-[#E8ECF4]">
								{row.price}
							</td>
							<td className="py-3.5 align-baseline text-[13.5px] leading-[1.45] text-[rgba(232,236,244,0.46)]">
								{row.unit}
								{row.note ? (
									<span className="block text-[rgba(232,236,244,0.72)] sm:ml-2 sm:inline">
										{row.note}
									</span>
								) : null}
							</td>
						</tr>
					))}
				</tbody>
			</table>
		</div>
		<div className="mt-12 lg:mt-16">
			<Calculator />
		</div>
	</Section>
);
