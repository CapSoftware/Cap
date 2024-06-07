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
    params.arch = "arch";

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
      const isTargetMatch =
        asset.name.endsWith(".tar.gz") && !asset.name.endsWith(".tar.gz.sig");

      return isTargetMatch;
    });

    if (!asset) {
      return new Response(null, {
        status: 204,
      });
    }

    const url = asset.browser_download_url;

    const signatureAsset = release.assets.find(({ name }: any) =>
      name.endsWith(".sig")
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
