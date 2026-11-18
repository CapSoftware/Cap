"use client";

import { useCurrency } from "hooks/useCurrency";
import { Claim } from "./Claim";
import { PRICE, TEAM_SIZES } from "./content";
import { CARD, DIM } from "./theme";

export function TeamPicks() {
	const { symbol } = useCurrency();

	return (
		<div className="grid gap-3 sm:grid-cols-3">
			{TEAM_SIZES.map((seats) => (
				<div
					key={seats}
					className={`${CARD} flex items-center justify-between gap-4 p-5 sm:flex-col sm:items-start sm:gap-5 sm:p-6`}
				>
					<div>
						<p className="text-[17px] font-medium">{seats} people</p>
						<p className={`mt-1 text-[15px] tabular-nums ${DIM}`}>
							<s className="mr-1.5 text-[rgba(245,241,234,0.45)]">
								{symbol}
								{PRICE.full * seats}
							</s>
							{symbol}
							{PRICE.now * seats} a year
						</p>
					</div>
					<Claim
						location={`team_${seats}`}
						seats={seats}
						small
						label={`Get ${seats} seats`}
					/>
				</div>
			))}
		</div>
	);
}
