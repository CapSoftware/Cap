// Helpers for building dynamic OG image URLs + page metadata. Server-only
// (metadata consts and generateMetadata always run on the server): URLs are
// HMAC-signed so third parties can't render arbitrary text via /api/og.

import type { Metadata } from "next";
import { signOgParams } from "@/lib/og/signature";

export type OgImageParams = {
	/** Short display title rendered on the image (not the SEO <title>). */
	title: string;
	/** Optional category chip, e.g. "Pricing", "Blog", "Docs". */
	tag?: string;
	/** Optional one/two-line supporting copy. */
	description?: string;
};

export const OG_IMAGE_WIDTH = 1200;
export const OG_IMAGE_HEIGHT = 630;

export const ogImageUrl = ({ title, tag, description }: OgImageParams) => {
	const params = new URLSearchParams({ title });
	if (tag) params.set("tag", tag);
	if (description) params.set("description", description);
	params.set("s", signOgParams({ title, tag, description }));
	return `/api/og?${params.toString()}`;
};

type MarketingMetadataParams = {
	/** SEO <title>. */
	title: string;
	description?: string;
	/** Canonical path, e.g. "/pricing". */
	path?: string;
	/** Overrides for the image text; falls back to `title` / `description`. */
	ogTitle?: string;
	ogDescription?: string;
	ogTag?: string;
};

/**
 * Builds page metadata with a branded dynamic OG image. `ogTitle` should be
 * short display copy ("Pricing", "Cap for Agencies") rather than the
 * keyword-stuffed SEO title.
 */
export const buildMarketingMetadata = ({
	title,
	description,
	path,
	ogTitle,
	ogDescription,
	ogTag,
}: MarketingMetadataParams): Metadata => {
	const image = {
		url: ogImageUrl({
			title: ogTitle ?? title,
			tag: ogTag,
			description: ogDescription ?? description,
		}),
		width: OG_IMAGE_WIDTH,
		height: OG_IMAGE_HEIGHT,
		alt: ogTitle ?? title,
	};

	return {
		title,
		description,
		...(path && { alternates: { canonical: path } }),
		openGraph: {
			title,
			description,
			type: "website",
			...(path && { url: path }),
			siteName: "Cap",
			images: [image],
		},
		twitter: {
			card: "summary_large_image",
			title,
			description,
			images: [image.url],
		},
	};
};
