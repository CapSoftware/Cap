"use client";

import { useCurrency } from "hooks/useCurrency";
import { useState } from "react";
import { MAX_CHECKOUT_QUANTITY } from "@/lib/checkout-quantity";
import { Claim } from "./Claim";
import { CodeChip } from "./CodeChip";
import { Countdown } from "./Countdown";
import { INCLUDED, PRICE } from "./content";

const money = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(2));

const STEP =
	"grid size-8 place-items-center rounded-[9px] bg-[rgba(245,241,234,0.08)] text-[#F5F1EA] transition-colors duration-200 hover:enabled:bg-[rgba(245,241,234,0.16)] disabled:cursor-not-allowed disabled:opacity-35 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#F5F1EA]";

export function OfferCard() {
	const { symbol } = useCurrency();
	const [seats, setSeats] = useState(1);

	return (
		<div className="relative rounded-[24px] bg-[rgba(245,241,234,0.12)] p-px shadow-[0_40px_120px_-30px_rgba(0,0,0,0.8)]">
			<div className="grid gap-10 rounded-[23px] bg-[#121113] p-6 sm:p-10 lg:grid-cols-[1.05fr_1fr] lg:gap-14">
				<div className="flex flex-col">
					<h2 className="text-[30px] font-medium leading-[1.05] tracking-[-0.025em] sm:text-[38px]">
						Cap Pro Yearly, half price
					</h2>
					<div className="mt-7 flex items-end gap-3">
						<span className="text-[64px] font-medium leading-[0.9] tracking-[-0.04em] sm:text-[80px]">
							{symbol}
							{money(PRICE.now)}
						</span>
						<span className="pb-2 text-[15px] leading-tight text-[rgba(245,241,234,0.64)]">
							<s className="decoration-[rgba(245,241,234,0.6)] decoration-2">
								{symbol}
								{PRICE.full}
							</s>
							<br />
							per user, per year
						</span>
					</div>
					<p className="mt-3 text-[15px] text-[rgba(245,241,234,0.64)]">
						That's {symbol}
						{money(PRICE.perMonth)} a month, billed once a year.
					</p>

					<div className="mt-8 flex items-center justify-between gap-4 rounded-[14px] bg-[rgba(245,241,234,0.05)] px-4 py-3">
						<span className="text-[15px]">Seats</span>
						<div className="flex items-center gap-3">
							<button
								type="button"
								className={STEP}
								onClick={() => setSeats((n) => Math.max(1, n - 1))}
								disabled={seats <= 1}
								aria-label="One fewer seat"
							>
								<svg
									viewBox="0 0 16 16"
									aria-hidden="true"
									className="size-3.5"
								>
									<path
										d="M3.5 8h9"
										stroke="currentColor"
										strokeWidth="1.6"
										strokeLinecap="round"
									/>
								</svg>
							</button>
							<span
								className="w-6 text-center text-[16px] tabular-nums"
								aria-live="polite"
							>
								{seats}
							</span>
							<button
								type="button"
								className={STEP}
								onClick={() =>
									setSeats((n) => Math.min(MAX_CHECKOUT_QUANTITY, n + 1))
								}
								disabled={seats >= MAX_CHECKOUT_QUANTITY}
								aria-label="One more seat"
							>
								<svg
									viewBox="0 0 16 16"
									aria-hidden="true"
									className="size-3.5"
								>
									<path
										d="M3.5 8h9M8 3.5v9"
										stroke="currentColor"
										strokeWidth="1.6"
										strokeLinecap="round"
									/>
								</svg>
							</button>
						</div>
					</div>
					<div className="mt-3 flex items-baseline justify-between px-1 text-[15px]">
						<span className="text-[rgba(245,241,234,0.64)]">Total today</span>
						<span className="tabular-nums">
							<s className="mr-2 text-[rgba(245,241,234,0.62)]">
								{symbol}
								{money(PRICE.full * seats)}
							</s>
							{symbol}
							{money(PRICE.now * seats)}
						</span>
					</div>

					<Claim location="offer_card" seats={seats} className="mt-7 w-full" />
					<p className="mt-4 text-center text-[14px] text-[rgba(245,241,234,0.64)]">
						Code <CodeChip location="offer_card" /> is applied at checkout.{" "}
						<Countdown />.
					</p>
				</div>

				<div className="lg:border-l lg:border-[rgba(245,241,234,0.1)] lg:pl-14">
					<p className="text-[15px] text-[rgba(245,241,234,0.64)]">
						Everything in Cap Pro
					</p>
					<ul className="mt-5 flex flex-col gap-3.5">
						{INCLUDED.map((item) => (
							<li key={item} className="flex gap-3 text-[16px] leading-[1.4]">
								<svg
									viewBox="0 0 16 16"
									aria-hidden="true"
									className="mt-[3px] size-4 shrink-0 text-[rgba(245,241,234,0.5)]"
								>
									<path
										d="m3.5 8.4 2.9 2.9 6.1-6.6"
										fill="none"
										stroke="currentColor"
										strokeWidth="1.7"
										strokeLinecap="round"
										strokeLinejoin="round"
									/>
								</svg>
								{item}
							</li>
						))}
					</ul>
				</div>
			</div>
		</div>
	);
}
