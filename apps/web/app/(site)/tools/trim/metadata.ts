import type { Metadata } from "next";
import { trimVideoContent } from "@/components/tools/content";
import { buildMarketingMetadata } from "@/lib/og/url";

export const metadata: Metadata = {
	...buildMarketingMetadata({
		title: trimVideoContent.title,
		description: trimVideoContent.description,
		path: "/tools/trim",
		ogTitle: "Trim videos online — free, in your browser",
		ogTag: "Tools",
	}),
	keywords: trimVideoContent.tags?.join(", "),
};
