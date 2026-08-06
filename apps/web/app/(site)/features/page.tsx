import type { Metadata } from "next";
import { buildMarketingMetadata } from "@/lib/og/url";
import { FeaturesPage } from "./FeaturesPage";

export const metadata: Metadata = buildMarketingMetadata({
	title: "Features - Cap",
	description:
		"Discover all the powerful features Cap offers for screen recording, sharing, and collaboration. From AI-powered tools to advanced editing capabilities.",
	path: "/features",
	ogTitle: "Everything Cap can do",
	ogDescription:
		"Screen recording, sharing, and collaboration — from AI-powered tools to advanced editing.",
	ogTag: "Features",
});

export default function Page() {
	return <FeaturesPage />;
}
