interface GitHubRepoResponse {
	stargazers_count: number;
}

export async function getGitHubStars(): Promise<number> {
	const response = await fetch("https://api.github.com/repos/CapSoftware/Cap", {
		headers: {
			Accept: "application/vnd.github.v3+json",
			"User-Agent": "Cap-Web",
		},
		next: {
			revalidate: 172800,
		},
	});

	if (!response.ok) {
		return 0;
	}

	const data: GitHubRepoResponse = await response.json();
	return data.stargazers_count;
}

export function formatStarCount(count: number): string {
	if (count === 0) return "";
	if (count >= 1000) {
		const formatted = (count / 1000).toFixed(1);
		return formatted.endsWith(".0")
			? `${Math.floor(count / 1000)}k`
			: `${formatted}k`;
	}
	return count.toString();
}
