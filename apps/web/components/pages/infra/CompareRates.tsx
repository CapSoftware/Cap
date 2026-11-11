"use client";

import {
	BUNNY_STANDARD_DELIVERY,
	DELIVERY_PER_1000_MINUTES,
	MUX_COLD_STORAGE,
	MUX_COLD_STORAGE_DAYS,
	MUX_VOLUME_DELIVERY,
	MUX_VOLUME_DELIVERY_MINUTES,
	PROVIDERS,
	STORAGE_PER_1000_MINUTES_PER_MONTH,
	type TieredRow,
} from "./comparison";
import { TIER_RANGE, usd } from "./content";
import { type RateRow, RateTable } from "./RateTable";
import { useTier } from "./TierSwitch";

const millions = (value: number) => `${value / 1_000_000} million`;

export const CompareRates = () => {
	const tier = useTier();

	const toRows = (rows: readonly TieredRow[]) => {
		const max = Math.max(...rows.map((row) => row.rates[tier]));
		return {
			max,
			rows: rows.map(
				(row): RateRow => ({
					key: row.provider,
					name: PROVIDERS[row.provider].name,
					marked: row.provider === "bunny",
					ours: row.provider === "cap",
					share: row.rates[tier] / max,
					figure: usd(row.rates[tier]),
				}),
			),
		};
	};

	const storage = toRows(STORAGE_PER_1000_MINUTES_PER_MONTH);
	const delivery = toRows(DELIVERY_PER_1000_MINUTES);

	return (
		<div className="grid gap-x-16 gap-y-14 lg:grid-cols-2">
			<RateTable
				steadyNote
				title="Storage"
				unit={`per 1,000 minutes a month, ${TIER_RANGE[tier]}`}
				rows={storage.rows}
				scale={{ from: "$0", to: usd(storage.max) }}
				note={`Mux falls to ${usd(MUX_COLD_STORAGE[tier])} for video not played in ${MUX_COLD_STORAGE_DAYS} days.`}
			/>
			<RateTable
				steadyNote
				title="Delivery"
				unit={`per 1,000 minutes watched, ${TIER_RANGE[tier]}`}
				rows={delivery.rows}
				scale={{ from: "$0", to: usd(delivery.max) }}
				note={`Mux falls to ${usd(MUX_VOLUME_DELIVERY[tier])} above ${millions(MUX_VOLUME_DELIVERY_MINUTES)} minutes a month. Bunny on its standard network is ${usd(BUNNY_STANDARD_DELIVERY[tier])}.`}
			/>
		</div>
	);
};
