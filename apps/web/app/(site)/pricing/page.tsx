import type { Metadata } from "next";
import { PricingPage } from "@/components/pages/pricing/PricingPage";
import { PRICING } from "@/data/pricing";
import { buildMarketingMetadata } from "@/lib/og/url";
import { createBreadcrumbSchema } from "@/utils/web-schema";

export const metadata: Metadata = buildMarketingMetadata({
	title: "Pricing — Cap",
	description:
		"Self-serve Cap Pro for organizations with thousands of members, with SOC 2 Type II, ISO 27001 & HIPAA compliance. Add SAML SSO ($199/mo) or a signed BAA ($99/mo) from your dashboard. SCIM directory sync is available as a $200/mo add-on.",
	path: "/pricing",
	ogTitle: "Simple pricing",
	ogDescription:
		"Start free. Pay when you need commercial rights or the cloud, and cancel whenever you like.",
	ogTag: "Pricing",
});

const breadcrumbSchema = createBreadcrumbSchema([
	{ name: "Home", url: "https://cap.so" },
	{ name: "Pricing", url: "https://cap.so/pricing" },
]);

const offer = (name: string, price: number) => ({
	"@type": "Offer",
	name,
	price: `${price}`,
	priceCurrency: "USD",
	url: "https://cap.so/pricing",
});

const pricingPageSchema = {
	"@context": "https://schema.org",
	"@graph": [
		{
			"@type": "WebPage",
			"@id": "https://cap.so/pricing#webpage",
			url: "https://cap.so/pricing",
			name: "Cap pricing",
			isPartOf: { "@id": "https://cap.so/#website" },
			about: { "@id": "https://cap.so/#software" },
			inLanguage: "en",
		},
		{
			"@type": "SoftwareApplication",
			"@id": "https://cap.so/#software",
			name: "Cap",
			url: "https://cap.so",
			description:
				"Cap is an open source screen recorder with instant share links.",
			applicationCategory: "MultimediaApplication",
			operatingSystem: ["macOS", "Windows", "Linux"],
			downloadUrl: "https://cap.so/download",
			publisher: { "@id": "https://cap.so/#organization" },
			offers: [
				offer("Free", 0),
				offer(
					"Desktop License, per license per year",
					PRICING.commercial.yearly,
				),
				offer("Desktop License, lifetime", PRICING.commercial.lifetime),
				offer(
					"Cap Pro, per user per month billed monthly",
					PRICING.pro.monthly,
				),
				offer(
					"Cap Pro, per user per year billed annually",
					PRICING.pro.yearlyTotal,
				),
			],
		},
	],
};

export default function App() {
	return (
		<>
			<script type="application/ld+json">
				{JSON.stringify(breadcrumbSchema)}
			</script>
			<script type="application/ld+json">
				{JSON.stringify(pricingPageSchema)}
			</script>
			<PricingPage />
		</>
	);
}
