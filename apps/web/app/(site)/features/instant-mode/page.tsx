import type { Metadata } from "next";
import { buildMarketingMetadata } from "@/lib/og/url";
import { InstantModePage } from "./InstantModePage";

export const metadata: Metadata = buildMarketingMetadata({
	title: "Instant Mode - Quick Screen Recording & Sharing | Cap",
	description:
		"Record and share instantly with Cap's cloud-powered Instant Mode. Get automatic transcriptions, collaborative comments, shareable links, and team workspaces for fast feedback loops.",
	path: "/features/instant-mode",
	ogTitle: "Instant Mode — record & share in seconds",
	ogDescription:
		"Record and share instantly with automatic transcriptions, comments, and shareable links.",
	ogTag: "Features",
});

export default function Page() {
	return <InstantModePage />;
}
