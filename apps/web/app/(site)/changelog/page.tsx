import type { Metadata } from "next";
import { buildMarketingMetadata } from "@/lib/og/url";
import { ChangelogView } from "./_components/ChangelogView";

export const metadata: Metadata = buildMarketingMetadata({
	title: "Changelog — Cap",
	description:
		"New features, improvements, and fixes across the Cap desktop app, web, mobile, and browser extension.",
	path: "/changelog",
	ogTitle: "Cap Changelog",
	ogTag: "Changelog",
});

export default function Page() {
	return <ChangelogView />;
}
