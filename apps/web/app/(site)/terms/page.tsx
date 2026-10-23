import type { Metadata } from "next";
import { TermsPage } from "@/components/pages/TermsPage";
import { buildMarketingMetadata } from "@/lib/og/url";

export const metadata: Metadata = buildMarketingMetadata({
	title: "Terms of Service — Cap",
	path: "/terms",
	ogTitle: "Terms of service",
	ogTag: "Legal",
});

export default function App() {
	return <TermsPage />;
}
