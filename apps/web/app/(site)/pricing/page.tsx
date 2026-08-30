import type { Metadata } from "next";
import { PricingPage } from "@/components/pages/PricingPage";
import { buildMarketingMetadata } from "@/lib/og/url";

export const metadata: Metadata = buildMarketingMetadata({
	title: "Pricing — Cap",
	description:
		"Simple, flexible pricing. Cap Pro includes unlimited cloud sharing, team features, and SOC 2 Type II, ISO 27001 & HIPAA compliance, with a Desktop License for unlimited local recording and editing.",
	path: "/pricing",
	ogTitle: "Simple, transparent pricing",
	ogTag: "Pricing",
});

export default function App() {
	return <PricingPage />;
}
