"use client";

import { useEffect, useState } from "react";
import { normalizeUrlPromoCode, URL_PROMO_CODES } from "@/lib/promo-codes";

/**
 * Reads an allowlisted `?promo=` campaign code off the current URL.
 *
 * Deliberately reads `window.location` in an effect rather than using
 * `useSearchParams`, which would opt the statically rendered marketing pages
 * into client-side rendering and cost them their prerendered HTML.
 */
export function usePromoCode() {
	const [code, setCode] = useState<string | null>(null);

	useEffect(() => {
		const param = new URLSearchParams(window.location.search).get("promo");
		setCode(normalizeUrlPromoCode(param));
	}, []);

	return {
		promoCode: code,
		promoLabel: code ? URL_PROMO_CODES[code]?.label : undefined,
	};
}
