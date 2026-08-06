import type { Metadata } from "next";
import { MigrateFromLoomPage } from "@/components/pages/seo/MigrateFromLoomPage";
import { ogImageUrl } from "@/lib/og/url";

const ogImage = ogImageUrl({
	title: "Migrate from Loom to Cap",
	tag: "Compare",
});

export const metadata: Metadata = {
	title: "Migrate from Loom to Cap | Import Your Loom Videos in Minutes",
	description:
		"Switching from Loom? Cap's built-in importer brings your existing Loom videos across. Paste a single share link or bulk import your whole library from a CSV. Open source, privacy-first, and half the price of Loom.",
	openGraph: {
		title: "Migrate from Loom to Cap | Import Your Loom Videos in Minutes",
		description:
			"Cap's built-in Loom importer brings your existing recordings across, from a single share link or bulk import from CSV. Open source and half the price of Loom.",
		url: "https://cap.so/migrate-from-loom",
		siteName: "Cap",
		images: [
			{
				url: ogImage,
				width: 1200,
				height: 630,
				alt: "Migrate from Loom to Cap",
			},
		],
		locale: "en_US",
		type: "website",
	},
	twitter: {
		card: "summary_large_image",
		title: "Migrate from Loom to Cap",
		description:
			"Switching from Loom? Cap's built-in importer brings your existing Loom videos across in minutes.",
		images: [ogImage],
	},
	alternates: {
		canonical: "https://cap.so/migrate-from-loom",
	},
};

export default function Page() {
	return <MigrateFromLoomPage />;
}
