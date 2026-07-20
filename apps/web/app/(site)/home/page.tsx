import type { Metadata } from "next";
import { HomePage } from "@/components/pages/HomePage";
import { buildMarketingMetadata } from "@/lib/og/url";

export const metadata: Metadata = {
	...buildMarketingMetadata({
		title: "Cap — Beautiful screen recordings, owned by you.",
		description:
			"Cap is the open source alternative to Loom. Lightweight, powerful, and cross-platform. Record and share in seconds.",
		ogTitle: "Beautiful screen recordings, owned by you",
	}),
	// Duplicate of the real homepage — keep it deduped and unindexed.
	alternates: { canonical: "https://cap.so/" },
	robots: {
		index: false,
		follow: false,
	},
};

export default async function Home() {
	return <HomePage />;
}
