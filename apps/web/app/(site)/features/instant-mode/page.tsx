import type { Metadata } from "next";
import { buildMarketingMetadata } from "@/lib/og/url";
import { InstantModePage } from "./InstantModePage";

export const metadata: Metadata = buildMarketingMetadata({
	title: "Instant Mode: record your screen and share a link | Cap",
	description:
		"Instant Mode uploads while you record on Mac, Windows and Linux, so your share link is ready the moment you stop. Viewers can leave timestamped comments.",
	path: "/features/instant-mode",
	ogTitle: "Instant Mode: record your screen and share a link",
	ogDescription:
		"Uploads while you record, so your share link is ready the moment you stop. Viewers can leave timestamped comments.",
	ogTag: "Features",
});

export default function Page() {
	return <InstantModePage />;
}
