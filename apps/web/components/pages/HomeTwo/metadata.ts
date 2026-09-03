import type { Metadata } from "next";
import { buildMarketingMetadata } from "@/lib/og/url";
import { homepageSeo } from "./seo";

export const homePageMetadata: Metadata = {
	...buildMarketingMetadata({
		title: homepageSeo.title,
		description: homepageSeo.description,
		path: homepageSeo.url,
		ogTitle: "Record. Edit. Share.",
		ogDescription:
			"The open source screen recorder for Mac, Windows, and Linux.",
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
