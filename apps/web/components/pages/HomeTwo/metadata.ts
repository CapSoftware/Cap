import type { Metadata } from "next";
import { buildMarketingMetadata, ogImageUrl } from "@/lib/og/url";
import { homepageSeo } from "./seo";

export const homepageOgTitle = "Record. Edit. Share.";
export const homepageOgDescription =
	"The open source screen recorder for Mac, Windows, and Linux.";
export const homepageOgImageUrl = new URL(
	ogImageUrl({ title: homepageOgTitle, description: homepageOgDescription }),
	homepageSeo.url,
).toString();

export const homePageMetadata: Metadata = {
	...buildMarketingMetadata({
		title: homepageSeo.title,
		description: homepageSeo.description,
		path: homepageSeo.url,
		ogTitle: homepageOgTitle,
		ogDescription: homepageOgDescription,
	}),
	robots: {
		index: true,
		follow: true,
		googleBot: {
			index: true,
			follow: true,
			"max-image-preview": "large",
			"max-snippet": -1,
			"max-video-preview": -1,
		},
	},
};
