import type { Metadata } from "next";
import { PricingPage } from "@/components/pages/pricing/PricingPage";
import { buildMarketingMetadata } from "@/lib/og/url";

export const metadata: Metadata = buildMarketingMetadata({
	title: "Pricing — Cap",
	description:
		"Self-serve Cap Pro for organizations with thousands of members, with SOC 2 Type II, ISO 27001 & HIPAA compliance. Add SAML SSO ($199/mo) or a signed BAA ($99/mo) from your dashboard. SCIM can be arranged.",
	path: "/pricing",
	ogTitle: "Simple, honest pricing",
	ogDescription:
		"Start free. Pay when you need commercial rights or the cloud, and cancel whenever you like.",
	ogTag: "Pricing",
});

export default function App() {
	return <PricingPage />;
}
