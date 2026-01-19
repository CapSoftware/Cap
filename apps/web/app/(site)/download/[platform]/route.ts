import { type NextRequest, NextResponse } from "next/server";
import { getGitHubReleases } from "@/utils/releases";

export const runtime = "edge";

type FallbackPlatform = "macos-arm64" | "macos-x64" | "windows";

async function checkCrabNebulaDownload(
	url: string,
): Promise<{ ok: true; finalUrl: string } | { ok: false }> {
	try {
		const res = await fetch(url, {
			redirect: "follow",
			cache: "no-store",
			headers: {
				Range: "bytes=0-0",
			},
		});

		if (res.status >= 200 && res.status < 300) {
			return { ok: true, finalUrl: res.url };
		}
	} catch {}

	return { ok: false };
}

async function getGitHubFallbackDownloadUrl(
	platform: FallbackPlatform,
): Promise<string | null> {
	try {
		const releases = await getGitHubReleases();

		for (const release of releases) {
			const url =
				platform === "windows"
					? release.downloads.windows
					: platform === "macos-arm64"
						? release.downloads["macos-arm64"]
						: release.downloads["macos-x64"];

			if (url) return url;
		}
	} catch {}

	return null;
}

export async function GET(
	request: NextRequest,
	props: { params: Promise<{ platform: string }> },
) {
	const params = await props.params;
	const platform = params.platform.toLowerCase();

	const downloadUrls: Record<
		string,
		{ url: string; fallback: FallbackPlatform }
	> = {
		"apple-intel": {
			url: "https://cdn.crabnebula.app/download/cap/cap/latest/platform/dmg-x86_64",
			fallback: "macos-x64",
		},
		intel: {
			url: "https://cdn.crabnebula.app/download/cap/cap/latest/platform/dmg-x86_64",
			fallback: "macos-x64",
		},
		mac: {
			url: "https://cdn.crabnebula.app/download/cap/cap/latest/platform/dmg-aarch64",
			fallback: "macos-arm64",
		},
		macos: {
			url: "https://cdn.crabnebula.app/download/cap/cap/latest/platform/dmg-aarch64",
			fallback: "macos-arm64",
		},
		"apple-silicon": {
			url: "https://cdn.crabnebula.app/download/cap/cap/latest/platform/dmg-aarch64",
			fallback: "macos-arm64",
		},
		aarch64: {
			url: "https://cdn.crabnebula.app/download/cap/cap/latest/platform/dmg-aarch64",
			fallback: "macos-arm64",
		},
		x86_64: {
			url: "https://cdn.crabnebula.app/download/cap/cap/latest/platform/dmg-x86_64",
			fallback: "macos-x64",
		},
		windows: {
			url: "https://cdn.crabnebula.app/download/cap/cap/latest/platform/nsis-x86_64",
			fallback: "windows",
		},
		win: {
			url: "https://cdn.crabnebula.app/download/cap/cap/latest/platform/nsis-x86_64",
			fallback: "windows",
		},
	};

	const download = downloadUrls[platform];

	// If the platform is not supported, redirect to the main download page
	if (!download) {
		return NextResponse.redirect(new URL("/download", request.url));
	}

	const primary = await checkCrabNebulaDownload(download.url);
	if (primary.ok) {
		return NextResponse.redirect(primary.finalUrl);
	}

	const fallback = await getGitHubFallbackDownloadUrl(download.fallback);
	if (fallback) {
		return NextResponse.redirect(fallback);
	}

	return NextResponse.redirect(new URL("/download/versions", request.url));
}
