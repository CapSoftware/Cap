import { type NextRequest, NextResponse } from "next/server";
import { getGitHubReleases, type ReleaseDownloadKey } from "@/utils/releases";

export const runtime = "edge";

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
	platform: ReleaseDownloadKey,
): Promise<string | null> {
	try {
		const releases = await getGitHubReleases();

		for (const release of releases) {
			const url = release.downloads[platform];
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
		{ url: string; fallback: ReleaseDownloadKey }
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
		linux: {
			url: "https://cdn.crabnebula.app/download/cap/cap/latest/platform/deb-x86_64",
			fallback: "linux-deb",
		},
		"linux-deb": {
			url: "https://cdn.crabnebula.app/download/cap/cap/latest/platform/deb-x86_64",
			fallback: "linux-deb",
		},
		deb: {
			url: "https://cdn.crabnebula.app/download/cap/cap/latest/platform/deb-x86_64",
			fallback: "linux-deb",
		},
		debian: {
			url: "https://cdn.crabnebula.app/download/cap/cap/latest/platform/deb-x86_64",
			fallback: "linux-deb",
		},
		ubuntu: {
			url: "https://cdn.crabnebula.app/download/cap/cap/latest/platform/deb-x86_64",
			fallback: "linux-deb",
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
