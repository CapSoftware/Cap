import type { Metadata } from "next";
import { UpdatesPage } from "@/components/pages/UpdatesPage";
import { buildMarketingMetadata } from "@/lib/og/url";

export const metadata: Metadata = buildMarketingMetadata({
	title: "Blog — Cap",
	description:
		"Product updates, guides, and insights from the team building Cap.",
	path: "/blog",
	ogTitle: "The Cap blog",
	ogTag: "Blog",
});

export default function App() {
	return <UpdatesPage />;
}
