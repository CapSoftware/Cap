import type { Metadata } from "next";
import { TermsPage } from "@/components/pages/TermsPage";
import { buildMarketingMetadata } from "@/lib/og/url";

export const metadata: Metadata = buildMarketingMetadata({
	title: "Terms of Service — Cap",
	description:
		"Read the Cap Software, Inc. Terms of Service governing your access to and use of the Cap screen recording application and services.",
	path: "/terms",
	ogTitle: "Terms of service",
	ogTag: "Legal",
});

export default function App() {
	return <TermsPage />;
}
