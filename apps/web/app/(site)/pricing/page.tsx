import type { Metadata } from "next";
import { PricingPage } from "@/components/pages/PricingPage";
import { buildMarketingMetadata } from "@/lib/og/url";

export const metadata: Metadata = buildMarketingMetadata({
	title: "Pricing — Cap",
	description:
		"Simple, flexible pricing. Get a Desktop License for unlimited local recording and editing, or Cap Pro for unlimited cloud sharing and team features.",
	path: "/pricing",
	ogTitle: "Simple, transparent pricing",
	ogTag: "Pricing",
});

export default function App() {
	return <PricingPage />;
}
