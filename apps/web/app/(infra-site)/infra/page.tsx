import type { Metadata } from "next";
import {
	infraFaqs,
	infraSeo,
	infraSoftwareSchema,
} from "@/components/pages/infra/content";
import { InfraPage } from "@/components/pages/infra/InfraPage";
import { buildMarketingMetadata } from "@/lib/og/url";
import { createBreadcrumbSchema, createFAQSchema } from "@/utils/web-schema";

export const metadata: Metadata = {
	...buildMarketingMetadata({
		title: infraSeo.title,
		description: infraSeo.description,
		path: infraSeo.path,
		ogTitle: "Cap Infra",
		ogDescription: infraSeo.ogDescription,
		ogTag: "Infra",
	}),
	keywords: [...infraSeo.keywords],
	robots: {
		index: true,
		follow: true,
		googleBot: {
			index: true,
			follow: true,
			"max-image-preview": "large",
			"max-snippet": -1,
		},
	},
};

const schemas = [
	createBreadcrumbSchema([
		{ name: "Home", url: "https://cap.so" },
		{ name: "Cap Infra", url: infraSeo.url },
	]),
	createFAQSchema(
		infraFaqs.map((faq) => ({ question: faq.question, answer: faq.answer })),
	),
	infraSoftwareSchema,
];

export default function Page() {
	return (
		<>
			{schemas.map((schema) => (
				<script key={schema["@type"]} type="application/ld+json">
					{JSON.stringify(schema).replace(/</g, "\\u003c")}
				</script>
			))}
			<InfraPage />
		</>
	);
}
