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
		.then((res) => {
			if (!res.ok) throw new Error("Currency lookup failed");
			return res.json();
		})
		.then((data: unknown) => {
			if (
				typeof data !== "object" ||
				data === null ||
				!("currency" in data) ||
				typeof data.currency !== "string" ||
				!isSupportedCurrency(data.currency)
			) {
				throw new Error("Invalid currency lookup response");
			}
			return data.currency;
		})
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
