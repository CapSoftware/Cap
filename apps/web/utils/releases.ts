export interface ReleaseDownloads {
	"macos-arm64"?: string;
	"macos-x64"?: string;
	windows?: string;
}

export interface Release {
	version: string;
	tagName: string;
	publishedAt: string;
	body: string;
	htmlUrl: string;
	downloads: ReleaseDownloads;
}

interface GitHubRelease {
	tag_name: string;
	name: string;
	published_at: string;
	body: string;
	html_url: string;
	draft: boolean;
	prerelease: boolean;
}

function parseDownloadsFromBody(body: string): ReleaseDownloads {
	const downloads: ReleaseDownloads = {};

	const jsonMatch = body.match(/<!--\s*DOWNLOADS_JSON\s*(\{[^}]+\})\s*-->/);

	if (jsonMatch && jsonMatch[1]) {
		try {
			const parsed = JSON.parse(jsonMatch[1]);
			if (parsed["macos-arm64"])
				downloads["macos-arm64"] = parsed["macos-arm64"];
			if (parsed["macos-x64"]) downloads["macos-x64"] = parsed["macos-x64"];
			if (parsed.windows) downloads.windows = parsed.windows;
		} catch {}
	}

	return downloads;
}

function extractVersionFromTag(tagName: string): string {
	return tagName.replace(/^cap-v/, "").replace(/^v/, "");
}

export async function getGitHubReleases(): Promise<Release[]> {
	const response = await fetch(
		"https://api.github.com/repos/CapSoftware/Cap/releases?per_page=100",
		{
			headers: {
				Accept: "application/vnd.github.v3+json",
				"User-Agent": "Cap-Web",
			},
			next: {
				revalidate: 3600,
			},
		},
	);

	if (!response.ok) {
		throw new Error(`GitHub API error: ${response.status}`);
	}

	const data: GitHubRelease[] = await response.json();

	return data
		.filter((release) => !release.draft && !release.prerelease)
		.filter((release) => release.tag_name.startsWith("cap-v"))
		.map((release) => ({
			version: extractVersionFromTag(release.tag_name),
			tagName: release.tag_name,
			publishedAt: release.published_at,
			body: release.body || "",
			htmlUrl: release.html_url,
			downloads: parseDownloadsFromBody(release.body || ""),
		}));
}

export function hasDownloads(downloads: ReleaseDownloads): boolean {
	return !!(
		downloads["macos-arm64"] ||
		downloads["macos-x64"] ||
		downloads.windows
	);
}
