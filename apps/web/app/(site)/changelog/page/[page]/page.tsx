import type { Metadata } from "next";
import { notFound, permanentRedirect } from "next/navigation";
import { buildMarketingMetadata } from "@/lib/og/url";
import { getChangelogPageCount } from "@/utils/changelog";
import { ChangelogView } from "../../_components/ChangelogView";

export const dynamicParams = false;

export function generateStaticParams() {
	const pageCount = getChangelogPageCount();
	return Array.from({ length: pageCount }, (_, i) => ({
		page: String(i + 1),
	}));
}

interface PageProps {
	params: Promise<{ page: string }>;
}

export async function generateMetadata(props: PageProps): Promise<Metadata> {
	const params = await props.params;
	const page = Number(params.page);
	if (page <= 1) return {};

	return buildMarketingMetadata({
		title: `Changelog — Page ${page} — Cap`,
		description:
			"New features, improvements, and fixes across the Cap desktop app, web, mobile, and browser extension.",
		path: `/changelog/page/${page}`,
		ogTitle: "Cap Changelog",
		ogTag: "Changelog",
	});
}

export default async function Page(props: PageProps) {
	const params = await props.params;
	const page = Number(params.page);
	if (page === 1) permanentRedirect("/changelog");
	if (!Number.isInteger(page) || page < 1) notFound();

	return <ChangelogView page={page} />;
}
