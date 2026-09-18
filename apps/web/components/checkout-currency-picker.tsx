"use client";

import { type FormEvent, useId, useState } from "react";
import type {
	ProCheckoutFlow,
	ProCheckoutPeriod,
} from "@/lib/pro-checkout-currency";
import {
	currencySymbol,
	isSupportedCurrency,
	type SupportedCurrency,
} from "@/utils/currency";

type CurrencyChoice = "auto" | SupportedCurrency;

export function CheckoutCurrencyPicker({
	priceId,
	quantity,
	flow,
	period,
	isOnBoarding,
	currencies,
}: {
	priceId: string;
	quantity: number;
	flow: ProCheckoutFlow;
	period: ProCheckoutPeriod;
	isOnBoarding: boolean;
	currencies: SupportedCurrency[];
}) {
	const currencyId = useId();
	const [choice, setChoice] = useState<CurrencyChoice>("auto");
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const submit = async (event: FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		setError(null);
		setLoading(true);
		try {
			const response = await fetch(
				flow === "guest"
					? "/api/settings/billing/guest-checkout"
					: "/api/settings/billing/subscribe",
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						priceId,
						quantity,
						continueCheckout: true,
						checkoutCurrency: choice,
						isOnBoarding,
					}),
				},
			);
			const result = (await response.json()) as {
				url?: unknown;
				message?: unknown;
				subscription?: unknown;
			};
			if (response.ok && typeof result.url === "string") {
				window.location.assign(result.url);
				return;
			}
			if (response.status === 401) {
				setError("Your sign-in expired. Sign in and start checkout again.");
			} else if (result.subscription === true) {
				setError("Your account is already on Cap Pro.");
			} else {
				setError(
					typeof result.message === "string"
						? result.message
						: "Checkout could not start. Please try again.",
				);
			}
		} catch {
			setError("Checkout could not start. Please try again.");
		} finally {
			setLoading(false);
		}
	};

	return (
		<main className="flex min-h-[70vh] items-center justify-center bg-[#EDF1F6] px-5 py-28 text-[#111111]">
			<div className="w-full max-w-[440px] rounded-[20px] border border-[#DDE4EB] bg-white p-7 shadow-[0_16px_60px_-32px_rgba(17,17,17,0.25)] sm:p-9">
				<p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[#4979A8]">
					Cap Pro checkout
				</p>
				<h1 className="mt-3 text-balance text-[30px] font-semibold leading-[1.15] tracking-[-0.03em]">
					Choose your billing currency
				</h1>
				<p className="mt-3 text-[14px] leading-relaxed text-[#626A73]">
					{quantity} {quantity === 1 ? "user" : "users"}, billed{" "}
					{period === "monthly" ? "monthly" : "annually"}. The final amount and
					any tax will appear at secure checkout.
				</p>
				<form onSubmit={submit} className="mt-8">
					<label
						htmlFor={currencyId}
						className="mb-2 block text-[13px] font-medium"
					>
						Currency
					</label>
					<select
						id={currencyId}
						value={choice}
						disabled={loading}
						onChange={(event) => {
							const value = event.currentTarget.value;
							if (value === "auto" || isSupportedCurrency(value))
								setChoice(value);
						}}
						className="h-11 w-full rounded-[10px] border border-[#DDE4EB] bg-[#F8FAFC] px-3 text-[14px] outline-none focus-visible:border-[#4979A8] focus-visible:ring-2 focus-visible:ring-[#B8D7F5] disabled:opacity-60"
					>
						<option value="auto">Automatic (based on location)</option>
						{currencies.map((currency) => (
							<option key={currency} value={currency}>
								{currency.toUpperCase()} ({currencySymbol(currency)})
							</option>
						))}
					</select>
					<p className="mt-2 text-[12px] leading-relaxed text-[#737B84]">
						{choice === "auto"
							? "Checkout will choose an available currency for your location."
							: `You will be charged in ${choice.toUpperCase()}.`}
					</p>
					{error && (
						<p role="alert" className="mt-4 text-[13px] text-[#B42318]">
							{error}
						</p>
					)}
					<button
						type="submit"
						disabled={loading}
						className="mt-7 h-11 w-full rounded-full bg-[#111111] px-5 text-[14px] font-medium text-white transition-colors hover:bg-[#303030] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#4979A8] focus-visible:ring-offset-2 disabled:cursor-wait disabled:opacity-60"
					>
						{loading ? "Opening checkout..." : "Continue to secure checkout"}
					</button>
				</form>
				<a
					href={isOnBoarding ? "/onboarding" : "/pricing"}
					className="mt-5 block text-center text-[13px] text-[#626A73] underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#4979A8]"
				>
					Back to plans
				</a>
			</div>
		</main>
	);
}
