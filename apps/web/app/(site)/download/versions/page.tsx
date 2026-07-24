import { format, parseISO } from "date-fns";
import type { Metadata } from "next";
import Link from "next/link";
import { buildMarketingMetadata } from "@/lib/og/url";
import {
	getGitHubReleases,
	hasDownloads,
	type Release,
	type ReleaseDownloads,
} from "@/utils/releases";

export const metadata: Metadata = buildMarketingMetadata({
	title: "All Versions — Cap",
	description:
		"Download previous versions of Cap for macOS, Windows, and Linux.",
	path: "/download/versions",
	ogTitle: "All Cap versions",
	ogTag: "Download",
});

export const revalidate = 60;

function DownloadLinks({
	downloads,
	isLatest,
}: {
	downloads: ReleaseDownloads;
	isLatest: boolean;
}) {
	if (isLatest) {
		return (
			<div className="flex flex-wrap gap-2">
				<a
					href="/download/apple-silicon"
					className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-md bg-blue-600 text-white hover:bg-blue-700 transition-colors"
				>
					<AppleIcon />
					Apple Silicon
				</a>
				<a
					href="/download/apple-intel"
					className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-md bg-gray-3 text-gray-12 hover:bg-gray-4 transition-colors"
				>
					<AppleIcon />
					Intel
				</a>
				<a
					href="/download/windows"
					className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-md bg-gray-3 text-gray-12 hover:bg-gray-4 transition-colors"
				>
					<WindowsIcon />
					Windows
				</a>
				<a
					href="/download/linux-deb"
					className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-md bg-gray-3 text-gray-12 hover:bg-gray-4 transition-colors"
				>
					<LinuxIcon />
					Linux .deb
				</a>
			</div>
		);
	}

	if (!hasDownloads(downloads)) {
		return <span className="text-sm text-gray-9">Downloads not available</span>;
	}

	return (
		<div className="flex flex-wrap gap-2">
			{downloads["macos-arm64"] && (
				<a
					href={downloads["macos-arm64"]}
					className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-md bg-gray-3 text-gray-12 hover:bg-gray-4 transition-colors"
				>
					<AppleIcon />
					Apple Silicon
				</a>
			)}
			{downloads["macos-x64"] && (
				<a
					href={downloads["macos-x64"]}
					className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-md bg-gray-3 text-gray-12 hover:bg-gray-4 transition-colors"
				>
					<AppleIcon />
					Intel
				</a>
			)}
			{downloads.windows && (
				<a
					href={downloads.windows}
					className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-md bg-gray-3 text-gray-12 hover:bg-gray-4 transition-colors"
				>
					<WindowsIcon />
					Windows
				</a>
			)}
			{downloads["linux-deb"] && (
				<a
					href={downloads["linux-deb"]}
					className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-md bg-gray-3 text-gray-12 hover:bg-gray-4 transition-colors"
				>
					<LinuxIcon />
					Linux .deb
				</a>
			)}
		</div>
	);
}

function AppleIcon() {
	return (
		<svg
			aria-hidden="true"
			className="w-4 h-4"
			viewBox="0 0 24 24"
			fill="currentColor"
		>
			<path d="M18.71,19.5C17.88,20.74 17,21.95 15.66,21.97C14.32,22 13.89,21.18 12.37,21.18C10.84,21.18 10.37,21.95 9.1,22C7.79,22.05 6.8,20.68 5.96,19.47C4.25,17 2.94,12.45 4.7,9.39C5.57,7.87 7.13,6.91 8.82,6.88C10.1,6.86 11.32,7.75 12.11,7.75C12.89,7.75 14.37,6.68 15.92,6.84C16.57,6.87 18.39,7.1 19.56,8.82C19.47,8.88 17.39,10.1 17.41,12.63C17.44,15.65 20.06,16.66 20.09,16.67C20.06,16.74 19.67,18.11 18.71,19.5M13,3.5C13.73,2.67 14.94,2.04 15.94,2C16.07,3.17 15.6,4.35 14.9,5.19C14.21,6.04 13.07,6.7 11.95,6.61C11.8,5.46 12.36,4.26 13,3.5Z" />
		</svg>
	);
}

function WindowsIcon() {
	return (
		<svg
			aria-hidden="true"
			className="w-4 h-4"
			viewBox="0 0 24 24"
			fill="currentColor"
		>
			<path d="M0,0H11.377V11.372H0ZM12.623,0H24V11.372H12.623ZM0,12.623H11.377V24H0Zm12.623,0H24V24H12.623" />
		</svg>
	);
}

function LinuxIcon() {
	return (
		<svg
			aria-hidden="true"
			className="w-4 h-4"
			viewBox="0 0 24 24"
			fill="currentColor"
		>
			<path d="M12 2a4.5 4.5 0 0 0-4.5 4.5c0 1.35.4 2.4.84 3.52.24.62.5 1.27.7 2.02C6.53 13.5 5 16.14 5 19.5 5 21.16 6.34 22 8 22c1.16 0 2.26-.5 3.06-1.28.58.18 1.3.28 2.06.28s1.48-.1 2.06-.28C15.98 21.5 17.08 22 18.24 22 19.9 22 21 21.16 21 19.5c0-3.36-1.53-6-4.04-7.46.2-.75.46-1.4.7-2.02.44-1.12.84-2.17.84-3.52A4.5 4.5 0 0 0 14 2h-2Zm-1.5 4.75a.75.75 0 1 1-1.5 0 .75.75 0 0 1 1.5 0Zm4.5 0a.75.75 0 1 1-1.5 0 .75.75 0 0 1 1.5 0ZM10.2 9h3.6c-.27.47-.92 1-1.8 1s-1.53-.53-1.8-1ZM8 20.5c-.92 0-1.5-.36-1.5-1 0-2.5 1.02-4.55 2.76-5.72.2 1.66.58 3.6 1.24 5.08-.56.94-1.52 1.64-2.5 1.64Zm10.24 0c-.98 0-1.94-.7-2.5-1.64.66-1.48 1.04-3.42 1.24-5.08 1.74 1.17 2.52 3.22 2.52 5.72 0 .64-.34 1-1.26 1Z" />
		</svg>
	);
}

function ReleaseRow({
	release,
	isLatest,
}: {
	release: Release;
	isLatest: boolean;
}) {
	return (
		<div className="flex flex-col gap-3 p-4 rounded-lg border border-gray-5 bg-gray-1 md:flex-row md:items-center md:justify-between">
			<div className="flex flex-col gap-1">
				<div className="flex items-center gap-2">
					<span className="text-lg font-semibold text-gray-12">
						v{release.version}
					</span>
					{isLatest && (
						<span className="px-2 py-0.5 text-xs font-medium rounded-full bg-blue-600 text-white">
							Latest
						</span>
					)}
				</div>
				<div className="flex items-center gap-3 text-sm text-gray-10">
					<span>{format(parseISO(release.publishedAt), "MMMM d, yyyy")}</span>
					<a
						href={release.htmlUrl}
						target="_blank"
						rel="noopener noreferrer"
						className="hover:text-gray-12 hover:underline"
					>
						Release notes
					</a>
				</div>
			</div>
			<DownloadLinks downloads={release.downloads} isLatest={isLatest} />
		</div>
	);
}

export default async function VersionsPage() {
	let releases: Release[] = [];
	let error: string | null = null;

	try {
		releases = await getGitHubReleases();
	} catch (e) {
		error = e instanceof Error ? e.message : "Failed to fetch releases";
	}

	return (
		<div className="py-24 md:py-32 wrapper wrapper-sm">
			<div className="space-y-6">
				<div className="space-y-2">
					<Link
						href="/download"
						className="inline-flex items-center gap-1 text-sm text-gray-10 hover:text-gray-12"
					>
						<svg
							aria-hidden="true"
							className="w-4 h-4"
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							strokeWidth="2"
						>
							<path d="M19 12H5M12 19l-7-7 7-7" />
						</svg>
						Back to Download
					</Link>
					<h1 className="text-2xl font-semibold text-gray-12 md:text-3xl">
						All Versions
					</h1>
					<p className="text-gray-10">
						Download previous versions of Cap for macOS, Windows, and Linux.
					</p>
				</div>

				{error ? (
					<div className="p-4 rounded-lg border border-red-5 bg-red-2 text-red-11">
						{error}
					</div>
				) : releases.length === 0 ? (
					<div className="p-4 rounded-lg border border-gray-5 bg-gray-2 text-gray-11">
						No releases found.
					</div>
				) : (
					<div className="space-y-3">
						{releases.map((release, index) => (
							<ReleaseRow
								key={release.tagName}
								release={release}
								isLatest={index === 0}
							/>
						))}
					</div>
				)}
			</div>
		</div>
	);
}
