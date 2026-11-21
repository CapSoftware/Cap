import type { Metadata } from "next";
import { TermsPage } from "@/components/pages/TermsPage";
import { buildMarketingMetadata } from "@/lib/og/url";

export const metadata: Metadata = buildMarketingMetadata({
	title: "Terms of Service — Cap",
	description:
		"The terms that govern your access to and use of Cap's website, software and services.",
	path: "/terms",
	ogTitle: "Terms of service",
	ogTag: "Legal",
});

export default function App() {
	return <TermsPage />;
}
