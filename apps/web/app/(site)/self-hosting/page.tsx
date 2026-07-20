import type { Metadata } from "next";
import { buildMarketingMetadata } from "@/lib/og/url";
import { SelfHostingPage } from "./SelfHostingPage";

export const metadata: Metadata = buildMarketingMetadata({
	title: "Self-hosting — Cap",
	description:
		"Deploy Cap on your own infrastructure with full control over your data. Ideal for enterprises and organizations with specific security requirements.",
	path: "/self-hosting",
	ogTitle: "Self-host Cap on your own infrastructure",
	ogTag: "Self-hosting",
});

export default async function SelfHosting() {
	return <SelfHostingPage />;
}
