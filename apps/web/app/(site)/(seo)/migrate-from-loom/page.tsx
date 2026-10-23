import { getCurrentUser } from "@cap/database/auth/session";
import type { Metadata } from "next";
import { MigrateFromLoomPage } from "@/components/pages/seo/MigrateFromLoomPage";
import {
	importSteps,
	migrateFaqs,
	migrateFromLoomSeo,
} from "@/components/pages/seo/migrate-from-loom-content";
import { buildMarketingMetadata } from "@/lib/og/url";
import {
	createBreadcrumbSchema,
	createFAQSchema,
	createHowToSchema,
} from "@/utils/web-schema";

export const metadata: Metadata = {
	...buildMarketingMetadata({
		title: migrateFromLoomSeo.title,
		description: migrateFromLoomSeo.description,
		path: migrateFromLoomSeo.path,
		ogTitle: "Import your Loom videos into Cap",
		ogDescription: "Paste a link or upload a CSV. Cap does the rest.",
		ogTag: "Migrate",
	}),
	keywords: [...migrateFromLoomSeo.keywords],
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
		{ name: "Migrate from Loom", url: migrateFromLoomSeo.url },
	]),
	createHowToSchema({
		name: "How to import Loom videos into Cap",
		description:
			"Move a single Loom video or your whole Loom library into Cap with the built-in importer.",
		totalTime: "PT5M",
		steps: importSteps.map((step) => ({ name: step.name, text: step.text })),
	}),
	createFAQSchema(
		migrateFaqs.map((faq) => ({
			question: faq.question,
			answer: faq.answer,
		})),
	),
];

export default async function Page() {
	const user = await getCurrentUser();

	return (
		<>
			{schemas.map((schema) => (
				<script key={schema["@type"]} type="application/ld+json">
					{JSON.stringify(schema).replace(/</g, "\\u003c")}
				</script>
			))}
			<MigrateFromLoomPage signedIn={Boolean(user)} />
		</>
	);
}
