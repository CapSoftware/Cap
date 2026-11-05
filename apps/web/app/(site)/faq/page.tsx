import type { Metadata } from "next";
import { FaqPage } from "@/components/pages/FaqPage";
import { buildMarketingMetadata } from "@/lib/og/url";

export const metadata: Metadata = buildMarketingMetadata({
	title: "FAQ — Cap",
	description:
		"Answers to frequently asked questions about Cap — open-source screen recording, Instant Mode, Studio Mode, self-hosting, pricing, and privacy.",
	path: "/faq",
	ogTitle: "Frequently asked questions",
	ogTag: "FAQ",
});

export default function App() {
	return <FaqPage />;
}
