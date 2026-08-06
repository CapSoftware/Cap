import type { Metadata } from "next";
import { AboutPage } from "@/components/pages/AboutPage";
import { buildMarketingMetadata } from "@/lib/og/url";

export const metadata: Metadata = buildMarketingMetadata({
	title: "About — Cap",
	description:
		"Cap is the open source alternative to Loom. Learn why we started Cap and our commitment to privacy, transparency, and community-driven development.",
	path: "/about",
	ogTitle: "Why we started Cap",
	ogTag: "About",
});

export default function App() {
	return <AboutPage />;
}
