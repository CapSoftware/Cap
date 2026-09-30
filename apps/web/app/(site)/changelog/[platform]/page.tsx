import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { buildMarketingMetadata } from "@/lib/og/url";
import { CHANGELOG_PLATFORMS, type ChangelogPlatform } from "@/utils/changelog";
import { ChangelogView } from "../_components/ChangelogView";

export const dynamicParams = false;

export function generateStaticParams() {
	return CHANGELOG_PLATFORMS.map((platform) => ({ platform }));
}

const PLATFORM_TITLES: Record<ChangelogPlatform, string> = {
	desktop: "Desktop",
	web: "Web",
	mobile: "Mobile",
	extension: "Browser Extension",
};

interface PageProps {
	params: Promise<{ platform: string }>;
}

function resolvePlatform(value: string) {
	return CHANGELOG_PLATFORMS.find((platform) => platform === value);
}

export async function generateMetadata(props: PageProps): Promise<Metadata> {
	const params = await props.params;
	const platform = resolvePlatform(params.platform);
	if (!platform) return {};

	return buildMarketingMetadata({
		title: `${PLATFORM_TITLES[platform]} Changelog — Cap`,
		description: `New features, improvements, and fixes in Cap for ${PLATFORM_TITLES[platform].toLowerCase()}.`,
		path: `/changelog/${platform}`,
		ogTitle: `Cap ${PLATFORM_TITLES[platform]} Changelog`,
		ogTag: "Changelog",
	});
}

export default async function Page(props: PageProps) {
	const params = await props.params;
	const platform = resolvePlatform(params.platform);
	if (!platform) notFound();

	return <ChangelogView platform={platform} />;
}
