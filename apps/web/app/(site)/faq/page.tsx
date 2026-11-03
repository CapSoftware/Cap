import type { Metadata } from "next";
import { FaqPage } from "@/components/pages/FaqPage";
import { buildMarketingMetadata } from "@/lib/og/url";

export const metadata: Metadata = buildMarketingMetadata({
	title: "FAQ — Cap",
	description:
		"Answers to common questions about Cap: who it's for, pricing, supported platforms, importing from Loom, self-hosting and SOC 2.",
	path: "/faq",
	ogTitle: "Frequently asked questions",
	ogTag: "FAQ",
});

export default function App() {
	return <FaqPage />;
}
