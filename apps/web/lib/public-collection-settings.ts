import type { PublicCollection } from "@cap/web-domain";

/**
 * Resolves a user-provided CTA link into a safe, absolute http(s) URL. Bare
 * hosts (e.g. `example.com`) are upgraded to `https://`, and anything that
 * isn't http/https (e.g. `javascript:`) is rejected so the public page can't be
 * turned into an injection vector.
 */
export function sanitizeCtaUrl(raw: string | null | undefined): string | null {
	const value = raw?.trim();
	if (!value) return null;

	const withProtocol = /^https?:\/\//i.test(value) ? value : `https://${value}`;

	try {
		const url = new URL(withProtocol);
		if (url.protocol !== "http:" && url.protocol !== "https:") return null;
		return url.toString();
	} catch {
		return null;
	}
}

/**
 * Static Tailwind class per grid density (kept as literal strings so the JIT
 * compiler keeps them). Applied at the `lg` breakpoint; smaller screens always
 * collapse to 1–2 columns.
 */
export const GRID_COLUMN_CLASS: Record<
	PublicCollection.PublicCollectionGridColumns,
	string
> = {
	2: "lg:grid-cols-2",
	3: "lg:grid-cols-3",
	4: "lg:grid-cols-4",
	5: "lg:grid-cols-5",
};

export const PUBLIC_LAYOUT_OPTIONS = [
	{ value: "grid" as const, label: "Grid" },
	{ value: "list" as const, label: "List" },
];

export const PUBLIC_LOGO_OPTIONS: {
	value: PublicCollection.PublicCollectionLogoMode;
	label: string;
}[] = [
	{ value: "cap", label: "Cap logo" },
	{ value: "organization", label: "Organization logo" },
	{ value: "custom", label: "Custom logo" },
	{ value: "none", label: "No logo" },
];

export const PUBLIC_GRID_COLUMN_OPTIONS: {
	value: PublicCollection.PublicCollectionGridColumns;
	label: string;
}[] = [
	{ value: 2, label: "2 per row" },
	{ value: 3, label: "3 per row" },
	{ value: 4, label: "4 per row" },
	{ value: 5, label: "5 per row" },
];
