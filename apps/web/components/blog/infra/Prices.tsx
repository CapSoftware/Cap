import {
	DEFAULT_TIER,
	PRICE_ROWS,
	PRICES,
	TIER_LABEL,
	TIERS,
	usd,
} from "@/components/pages/infra/content";
import { MONO } from "@/components/pages/infra/theme";
import { HAIRLINE, InfraStage } from "./Stage";

const ROW = `border-b ${HAIRLINE}`;

/**
 * $0.95 per 1,000 delivered minutes at every resolution, billed from
 * 14 November 2026. Import INFRA_DELIVERY_DOLLARS_PER_1000_MINUTES from
 * lib/infra-pricing once the delivery debit PR replaces main's per-tier record
 * with this flat number.
 */
const DELIVERY_PER_1000_MINUTES = 0.95;

/** The landing page's rows, with delivery and speech in the same table. */
const ROWS = [
	...PRICE_ROWS.slice(0, 2),
	{
		meter: "Delivery",
		price: usd(DELIVERY_PER_1000_MINUTES),
		note: "per 1,000 minutes watched, any resolution",
	},
	{
		meter: "Speech to text",
		price: usd(PRICES.speechPerHour),
		note: "per audio hour",
	},
	...PRICE_ROWS.slice(2),
];

const FIGURE = `${MONO} text-[13.5px] tabular-nums text-[#E8ECF4]`;

/** The landing page's price card, straight from the same constants. */
export function InfraPrices() {
	return (
		<InfraStage
			className="px-6 py-8 sm:px-12 sm:py-11"
			caption="Videos are encoded up to 1080p by default. 1440p and 4K are set per upload."
		>
			<table className="m-0 w-full table-fixed border-collapse text-left">
				<caption className="sr-only">Cap Infra prices by resolution</caption>
				<thead>
					<tr className={ROW}>
						<th scope="col" className="w-[40%] p-0 sm:w-[46%]">
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
					{ROWS.map((row) => (
						<tr key={row.meter} className={ROW}>
							<th
								scope="row"
								className="py-4 pr-4 align-top text-[14.5px] font-normal leading-[1.4] text-[#E8ECF4]"
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
										className={`${FIGURE} py-4 text-right align-top leading-[1.5]`}
									>
										{usd(row.rates?.[tier] ?? 0)}
									</td>
								))
							) : (
								<td colSpan={TIERS.length} className="py-4 align-top">
									<span className="flex flex-col-reverse items-end gap-x-3 text-right text-[13.5px] leading-[1.5] text-[rgba(232,236,244,0.46)] sm:flex-row sm:items-baseline sm:justify-end">
										{row.note ? (
											<span className="text-pretty">{row.note}</span>
										) : null}
										<span className={FIGURE}>{row.price}</span>
									</span>
								</td>
							)}
						</tr>
					))}
				</tbody>
			</table>
		</InfraStage>
	);
}

const storage = (
	minutes: number,
	tier: keyof typeof PRICES.storagePer1000Minutes,
) => (minutes / 1000) * PRICES.storagePer1000Minutes[tier];

/**
 * Other providers' list prices, read from their own pricing pages on
 * 13 November 2026, before volume discounts and free allowances.
 * Mux: storage $0.003 a minute a month at 1080p and $0.0096 at 4K, delivery
 * $0.001 a minute at 1080p and $0.0032 at 4K, basic quality encoding free
 * (mux.com/docs/pricing/video). Cloudflare Stream: $5 per 1,000 minutes
 * stored a month and $1 per 1,000 minutes delivered, whatever the resolution,
 * encoding free (developers.cloudflare.com/stream/pricing).
 */
const PROVIDERS = ["Cap Infra", "Mux", "Cloudflare Stream"] as const;

const COMPARE = [
	{
		what: "Encoding",
		unit: null,
		prices: ["Free", "Free on basic", "Free"],
	},
	{
		what: "Storing 1080p",
		unit: "10,000 minutes for a month",
		prices: [usd(storage(10_000, DEFAULT_TIER)), usd(30), usd(50)],
	},
	{
		what: "Storing 4K",
		unit: "1,000 minutes for a month",
		prices: [usd(storage(1_000, "2160p")), usd(9.6), usd(5)],
	},
	{
		what: "Delivering 1080p",
		unit: "1,000 minutes watched",
		prices: [usd(DELIVERY_PER_1000_MINUTES), usd(1), usd(1)],
	},
	{
		what: "Delivering 4K",
		unit: "1,000 minutes watched",
		prices: [usd(DELIVERY_PER_1000_MINUTES), usd(3.2), usd(1)],
	},
] as const;

/** Cap Infra next to the other video APIs, on list prices. */
export function InfraCompare() {
	return (
		<InfraStage
			className="px-6 py-8 sm:px-12 sm:py-11"
			caption="List prices from each provider's pricing page on 13 November 2026, before volume discounts and free allowances."
		>
			<table className="m-0 w-full table-fixed border-collapse text-left">
				<caption className="sr-only">
					Cap Infra prices compared with other video APIs
				</caption>
				<thead>
					<tr className={ROW}>
						<th scope="col" className="w-[31%] p-0 sm:w-[40%]">
							<span className="sr-only">What</span>
						</th>
						{PROVIDERS.map((provider, i) => (
							<th
								key={provider}
								scope="col"
								className={`pb-3 text-right align-bottom text-[13px] font-normal leading-[1.4] ${i === 0 ? "text-[#E8ECF4]" : "text-[rgba(232,236,244,0.46)]"}`}
							>
								{provider}
							</th>
						))}
					</tr>
				</thead>
				<tbody>
					{COMPARE.map((row) => (
						<tr key={row.what} className={ROW}>
							<th
								scope="row"
								className="py-4 pr-4 align-top text-[14.5px] font-normal leading-[1.4] text-[#E8ECF4]"
							>
								{row.what}
								{row.unit ? (
									<span className="block text-pretty text-[13px] text-[rgba(232,236,244,0.46)]">
										{row.unit}
									</span>
								) : null}
							</th>
							{row.prices.map((price, i) => (
								<td
									key={PROVIDERS[i]}
									className={`py-4 pl-2 text-right align-top text-[13.5px] leading-[1.4] ${price.startsWith("$") ? `${MONO} tabular-nums` : ""} ${i === 0 ? "text-[#E8ECF4]" : "text-[rgba(232,236,244,0.56)]"}`}
								>
									{price}
								</td>
							))}
						</tr>
					))}
				</tbody>
			</table>
		</InfraStage>
	);
}
