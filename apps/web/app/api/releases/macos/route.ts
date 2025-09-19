import { Octokit } from "@octokit/rest";

const octokit = new Octokit();

export const runtime = "edge";

export const revalidate = 0;

export async function GET(
	req: Request,
	props: {
		params: Promise<{
			version: string;
			target: string;
			arch: string;
		}>;
	},
) {
	const params = await props.params;
	try {
		if (params.arch === "x86_64") {
			params.arch = "x64";
		}

		const { data: release } = await octokit.repos.getLatestRelease({
			owner: "capsoftware",
			repo: "cap",
		});

		const version = release.tag_name.replace("cap-v", "");
		const notes = release.body;
		const pub_date = release.published_at
			? new Date(release.published_at).toISOString()
			: null;

		const asset = release.assets.find((asset) => asset.name.endsWith(".dmg"));

		if (!asset) {
			return new Response(null, {
				status: 204,
			});
		}

		const url = asset.browser_download_url;

		return Response.json({ version, notes, pub_date, url }, { status: 200 });
	} catch (error) {
		console.error("Error fetching latest release:", error);
		return Response.json({ error: "Missing required fields" }, { status: 400 });
	}
}
