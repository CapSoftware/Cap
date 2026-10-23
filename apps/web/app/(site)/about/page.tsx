import type { Metadata } from "next";
import { AboutPage } from "@/components/pages/about/AboutPage";
import { buildMarketingMetadata } from "@/lib/og/url";
import { formatStarCount, getGitHubStars } from "@/utils/github";
import { createBreadcrumbSchema } from "@/utils/web-schema";

export const metadata: Metadata = buildMarketingMetadata({
	title: "About — Cap",
	description:
		"Cap is the open source alternative to Loom. Learn why we started Cap and our commitment to privacy, transparency, and community-driven development.",
	path: "/about",
	ogTitle: "Why we started Cap",
	ogTag: "About",
});

const breadcrumb = createBreadcrumbSchema([
	{ name: "Home", url: "https://cap.so" },
	{ name: "About", url: "https://cap.so/about" },
]);

export default async function Page() {
	const stars = formatStarCount(await getGitHubStars());

	return (
		<>
			<script type="application/ld+json">
				{JSON.stringify(breadcrumb).replace(/</g, "\\u003c")}
			</script>
			<AboutPage stars={stars} />
		</>
	);
}
