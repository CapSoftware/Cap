import { NextRequest } from "next/server";
import Mux from "@mux/mux-node";

const mux = new Mux({
  tokenId: process.env["MUX_TOKEN_ID"],
  tokenSecret: process.env["MUX_TOKEN_SECRET"],
});

export async function POST(request: NextRequest) {
  try {
    const { userId, videoId, fileKey } = await request.json();

    if (!userId || !fileKey || !videoId) {
      console.error("Missing required fields in /api/upload/mux/route.ts");

      return new Response(
        JSON.stringify({ error: "Missing required fields" }),
        {
          status: 400,
          headers: {
            "Content-Type": "application/json",
          },
        }
      );
    }

    let asset = await mux.Video.Assets.get(videoId).catch(async () => {
      const newAsset = await mux.Video.Assets.create({
        input: [],
        playback_policy: "public",
        passthrough: videoId,
      });
      return newAsset;
    });

    // Create a direct upload URL
    const upload = await mux.Video.Uploads.create({
      cors_origin: request.headers.get("origin") || "*",
      new_asset_settings: { playback_policy: "public", passthrough: asset.id },
    });

    // Respond with the upload URL and ID
    return new Response(
      JSON.stringify({
        videoId: videoId,
        userId: userId,
        uploadUrl: upload.url,
        uploadId: upload.id,
        assetId: asset.id,
      }),
      {
        status: 200,
        headers: {
          "Content-Type": "application/json",
        },
      }
    );
  } catch (error) {
    console.error("Error when uploading to Mux", error);
    return new Response(
      JSON.stringify({ error: "Error when uploading to Mux" }),
      {
        status: 500,
        headers: {
          "Content-Type": "application/json",
        },
      }
    );
  }
}
