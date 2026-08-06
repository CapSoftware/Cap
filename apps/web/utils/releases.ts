export interface ReleaseDownloads {
	"macos-arm64"?: string;
	"macos-x64"?: string;
	windows?: string;
	"linux-deb"?: string;
}

export const releasesRevalidateSeconds = 60;

export type ReleaseDownloadKey = keyof ReleaseDownloads;
type ReleaseDownloadJsonKey = ReleaseDownloadKey | "linux";

export const releaseDownloadKeys = [
	"macos-arm64",
	"macos-x64",
	"windows",
	"linux-deb",
] satisfies ReleaseDownloadKey[];

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

export function parseDownloadsFromBody(body: string): ReleaseDownloads {
	const downloads: ReleaseDownloads = {};

	const jsonMatch = body.match(/<!--\s*DOWNLOADS_JSON\s*(\{[^}]+\})\s*-->/);

	if (jsonMatch?.[1]) {
		try {
			const parsed: unknown = JSON.parse(jsonMatch[1]);
			if (!parsed || typeof parsed !== "object") return downloads;

			const values = parsed as Partial<Record<ReleaseDownloadJsonKey, unknown>>;
			for (const key of releaseDownloadKeys) {
				const value = values[key];
				if (typeof value === "string" && value.length > 0) {
					downloads[key] = value;
				}
			}

			const linuxValue = values.linux;
			if (
				!downloads["linux-deb"] &&
				typeof linuxValue === "string" &&
				linuxValue.length > 0
			) {
				downloads["linux-deb"] = linuxValue;
			}
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
				revalidate: releasesRevalidateSeconds,
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
	return releaseDownloadKeys.some((key) => !!downloads[key]);
}
