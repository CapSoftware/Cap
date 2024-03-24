import { Octokit } from "@octokit/rest";

const octokit = new Octokit();

export const runtime = "edge";

export const revalidate = 0;

export async function GET(
  req: Request,
  {
    params,
  }: {
    params: {
      version: string;
      target: string;
      arch: string;
    };
  }
) {
  try {
    const { data: release } = await octokit.repos.getLatestRelease({
      owner: "capsoftware",
      repo: "cap",
    });

    const version = release.tag_name.replace("cap-v", "");
    const notes = release.body;
    const pub_date = release.published_at
      ? new Date(release.published_at).toISOString()
      : null;

    const asset = release.assets.find((asset) => {
      const isVersionMatch = asset.name.includes(version);
      const isArchMatch = asset.name.includes(params.arch);
      let isTargetMatch = false;

      switch (params.target) {
        case "mac":
          isTargetMatch = asset.name.endsWith(".dmg");
          break;
        case "linux":
          isTargetMatch = asset.name.endsWith(".tar.gz");
          break;
        case "windows":
          isTargetMatch = asset.name.endsWith(".exe");
      }

      return isVersionMatch && isArchMatch && isTargetMatch;
    });

    if (!asset) {
      return new Response(null, {
        status: 204,
      });
    }

    const url = asset.browser_download_url;

    console.log(release.assets);

    const signatureAsset = release.assets.find(
      ({ name }: any) => name.includes(params.arch) && name.endsWith(".sig")
    );
    if (!signatureAsset) {
      return new Response(null, {
        status: 204,
      });
    }

    const signature = await fetch(signatureAsset.browser_download_url).then(
      (r) => r.text()
    );

    return new Response(
      JSON.stringify({ version, notes, pub_date, url, signature }),
      {
        status: 200,
        headers: {
          "Content-Type": "application/json",
        },
      }
    );
  } catch (error) {
    console.error("Error fetching latest release:", error);
    return new Response(JSON.stringify({ error: "Missing required fields" }), {
      status: 400,
      headers: {
        "Content-Type": "application/json",
      },
    });
  }
}
