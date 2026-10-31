// Vercel's edge writes x-vercel-ip-country itself and overwrites any value the
// client sent, so the header is only a real location on Vercel. Anywhere else,
// or when the value is not a plain country code, the visitor is treated as
// unknown and pricing falls back to USD.
export function visitorCountry(
	header: string | null | undefined,
): string | null {
	if (process.env.VERCEL !== "1") return null;
	const code = header?.trim().toUpperCase();
	return code && /^[A-Z]{2}$/.test(code) ? code : null;
}
