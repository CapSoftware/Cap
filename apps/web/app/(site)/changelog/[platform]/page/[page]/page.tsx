import type { Metadata } from "next";
import { notFound, permanentRedirect } from "next/navigation";
import { buildMarketingMetadata } from "@/lib/og/url";
import {
	CHANGELOG_PLATFORMS,
	type ChangelogPlatform,
	getChangelogPageCount,
} from "@/utils/changelog";
import { ChangelogView } from "../../../_components/ChangelogView";

export const dynamicParams = false;

const PLATFORM_TITLES: Record<ChangelogPlatform, string> = {
	desktop: "Desktop",
	web: "Web",
	mobile: "Mobile",
	extension: "Browser Extension",
};

export function generateStaticParams() {
	return CHANGELOG_PLATFORMS.flatMap((platform) => {
		const pageCount = getChangelogPageCount(platform);
		return Array.from({ length: pageCount }, (_, i) => ({
			platform,
			page: String(i + 1),
		}));
	});
}

interface PageProps {
	params: Promise<{ platform: string; page: string }>;
}

function resolvePlatform(value: string) {
	return CHANGELOG_PLATFORMS.find((platform) => platform === value);
}

export async function generateMetadata(props: PageProps): Promise<Metadata> {
	const params = await props.params;
	const platform = resolvePlatform(params.platform);
	const page = Number(params.page);
	if (!platform || page <= 1) return {};

	return buildMarketingMetadata({
		title: `${PLATFORM_TITLES[platform]} Changelog — Page ${page} — Cap`,
		description: `New features, improvements, and fixes in Cap for ${PLATFORM_TITLES[
			platform
		].toLowerCase()}.`,
		path: `/changelog/${platform}/page/${page}`,
		ogTitle: `Cap ${PLATFORM_TITLES[platform]} Changelog`,
		ogTag: "Changelog",
	});
}

export default async function Page(props: PageProps) {
	const params = await props.params;
	const platform = resolvePlatform(params.platform);
	if (!platform) notFound();
	const page = Number(params.page);
	if (page === 1) permanentRedirect(`/changelog/${platform}`);
	if (!Number.isInteger(page) || page < 1) notFound();

	return <ChangelogView platform={platform} page={page} />;
}
