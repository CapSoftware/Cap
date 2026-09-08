import { fetch } from "@tauri-apps/plugin-http";

import { getConfiguredServerUrl } from "./web-api";

const CURRENCY_SYMBOLS: Record<string, string> = {
	usd: "$",
	gbp: "£",
	eur: "€",
};

export async function getPresentmentCurrencySymbol(): Promise<string> {
	try {
		const serverUrl = await getConfiguredServerUrl();
		const headers: Record<string, string> = {};
		const bypassSecret = import.meta.env.VITE_VERCEL_AUTOMATION_BYPASS_SECRET;
		if (bypassSecret) headers["x-vercel-protection-bypass"] = bypassSecret;

		const resp = await fetch(new URL("/api/currency", serverUrl).toString(), {
			headers,
		});
		if (!resp.ok) return "$";

		const body = (await resp.json()) as { currency?: string };
		return CURRENCY_SYMBOLS[body.currency ?? ""] ?? "$";
	} catch {
		return "$";
	}
}
