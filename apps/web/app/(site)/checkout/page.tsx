import { stripe } from "@cap/utils";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { CheckoutCurrencyPicker } from "@/components/checkout-currency-picker";
import {
	availableCheckoutCurrencies,
	type ProCheckoutFlow,
	proCheckoutPeriod,
} from "@/lib/pro-checkout-currency";
import { isSupportedCurrency } from "@/utils/currency";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
	title: "Choose billing currency — Cap",
	robots: { index: false, follow: false },
};

export default async function CheckoutPage({
	searchParams,
}: {
	searchParams: Promise<{
		priceId?: string;
		quantity?: string;
		flow?: string;
		isOnBoarding?: string;
		checkoutCurrency?: string;
	}>;
}) {
	const params = await searchParams;
	const priceId = params.priceId ?? "";
	const quantity = Number(params.quantity);
	const period = proCheckoutPeriod(priceId);
	const flow: ProCheckoutFlow | null =
		params.flow === "account" || params.flow === "guest" ? params.flow : null;
	if (!period || !flow || !Number.isSafeInteger(quantity) || quantity < 1)
		notFound();

	const isOnBoarding = params.isOnBoarding === "true" && flow === "account";
	try {
		const price = await stripe().prices.retrieve(priceId, {
			expand: ["currency_options"],
		});
		const currencies = price.active ? availableCheckoutCurrencies(price) : [];
		if (currencies.length === 0) throw new Error("No checkout currencies");
		const initialChoice =
			isSupportedCurrency(params.checkoutCurrency) &&
			currencies.includes(params.checkoutCurrency)
				? params.checkoutCurrency
				: "auto";
		return (
			<CheckoutCurrencyPicker
				priceId={priceId}
				quantity={quantity}
				flow={flow}
				period={period}
				isOnBoarding={isOnBoarding}
				currencies={currencies}
				initialChoice={initialChoice}
			/>
		);
	} catch {
		const retry = new URLSearchParams({
			priceId,
			quantity: String(quantity),
			flow,
		});
		if (isOnBoarding) retry.set("isOnBoarding", "true");
		if (isSupportedCurrency(params.checkoutCurrency))
			retry.set("checkoutCurrency", params.checkoutCurrency);
		return (
			<main className="flex min-h-[70vh] items-center justify-center bg-[#EDF1F6] px-5 py-28 text-[#111111]">
				<div className="w-full max-w-[440px] rounded-[20px] border border-[#DDE4EB] bg-white p-7 text-center sm:p-9">
					<h1 className="text-[25px] font-semibold tracking-[-0.03em]">
						Checkout is temporarily unavailable
					</h1>
					<p className="mt-3 text-[14px] text-[#626A73]">
						We could not load the available currencies. Please try again.
					</p>
					<a
						href={`/checkout?${retry.toString()}`}
						className="mt-7 inline-flex h-10 items-center rounded-full bg-[#111111] px-5 text-[14px] font-medium text-white hover:bg-[#303030] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#4979A8]"
					>
						Try again
					</a>
				</div>
			</main>
		);
	}
}
