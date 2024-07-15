import { dub } from "@/utils/dub";
import { ClicksCount } from "dub/models/components";
import { NextRequest } from "next/server";

export const revalidate = 300;

export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const videoId = searchParams.get("videoId");

  if (!videoId) {
    return new Response(JSON.stringify({ error: true }), {
      status: 401,
      headers: {
        "Content-Type": "application/json",
      },
    });
  }

  try {
    const response = await dub.analytics.retrieve({
      domain: "cap.link",
      key: videoId,
    });
    const { clicks: analytics } = response as ClicksCount;

    if (typeof analytics !== "number" || analytics === null) {
      return new Response(JSON.stringify({ error: true }), {
        status: 401,
        headers: {
          "Content-Type": "application/json",
        },
      });
    }

    return new Response(JSON.stringify({ count: analytics }), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
      },
    });
  } catch (error: any) {
    if (error.code === "not_found") {
      return new Response(
        JSON.stringify({
          error: true,
          message: "Video link not found.",
          docUrl: error.docUrl,
        }),
        {
          status: 404,
          headers: {
            "Content-Type": "application/json",
          },
        }
      );
    }
    return new Response(JSON.stringify({ error: true }), {
      status: 500,
      headers: {
        "Content-Type": "application/json",
      },
    });
  }
}
