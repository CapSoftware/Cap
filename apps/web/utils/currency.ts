export const SUPPORTED_CURRENCIES = ["usd", "gbp", "eur"] as const;

export type SupportedCurrency = (typeof SUPPORTED_CURRENCIES)[number];

const GBP_COUNTRIES = new Set(["GB", "IM", "JE", "GG"]);

// Mirrors the countries Stripe Checkout's IP localization presents in EUR, so
// the displayed price matches what checkout charges. Non-euro EU countries
// (SE, PL, DK, ...) are deliberately absent and fall through to USD.
const EUR_COUNTRIES = new Set([
	"AD",
	"AT",
	"AX",
	"BE",
	"BL",
	"CY",
	"DE",
	"EE",
	"ES",
	"FI",
	"FR",
	"GF",
	"GP",
	"GR",
	"HR",
	"IE",
	"IT",
	"LT",
	"LU",
	"LV",
	"MC",
	"ME",
	"MF",
	"MT",
	"NL",
	"PM",
	"PT",
	"RE",
	"SI",
	"SK",
	"SM",
	"TF",
	"VA",
	"XK",
	"YT",
]);

const CURRENCY_SYMBOLS: Record<SupportedCurrency, string> = {
	usd: "$",
	gbp: "£",
	eur: "€",
};

export function isSupportedCurrency(
	value: string | null | undefined,
): value is SupportedCurrency {
	return SUPPORTED_CURRENCIES.includes(value as SupportedCurrency);
}

export function currencyForCountry(
	country: string | null | undefined,
): SupportedCurrency {
	if (!country) return "usd";

	const code = country.trim().toUpperCase();
	if (GBP_COUNTRIES.has(code)) return "gbp";
	if (EUR_COUNTRIES.has(code)) return "eur";
	return "usd";
}

// Billing surfaces render whatever currency Stripe returns, which may be a code
// we have no symbol for, so unknown codes degrade to a readable prefix.
export function currencySymbol(code: string): string {
	const normalized = code.toLowerCase();
	if (isSupportedCurrency(normalized)) return CURRENCY_SYMBOLS[normalized];
	return `${code.toUpperCase()} `;
}

export function formatAmount(amount: number, currency: string): string {
	try {
		return new Intl.NumberFormat("en", {
			style: "currency",
			currency,
		}).format(amount);
	} catch {
		return `${currencySymbol(currency)}${amount.toFixed(2)}`;
	}
}
