"use client";

import { useEffect, useState } from "react";
import {
	currencySymbol,
	isSupportedCurrency,
	type SupportedCurrency,
} from "@/utils/currency";

let currencyRequest: Promise<SupportedCurrency> | null = null;

function loadCurrency(): Promise<SupportedCurrency> {
	currencyRequest ??= fetch("/api/currency")
		.then((res) => res.json())
		.then((data: { currency?: string }) =>
			isSupportedCurrency(data.currency) ? data.currency : "usd",
		)
		.catch((): SupportedCurrency => {
			currencyRequest = null;
			return "usd";
		});

	return currencyRequest;
}

export function useCurrency() {
	// Starts at usd so SSR and the first client render agree; geo detection only
	// ever runs in the effect below.
	const [currency, setCurrency] = useState<SupportedCurrency>("usd");

	useEffect(() => {
		let active = true;
		loadCurrency().then((next) => {
			if (active) setCurrency(next);
		});
		return () => {
			active = false;
		};
	}, []);

	return { currency, symbol: currencySymbol(currency) };
}
