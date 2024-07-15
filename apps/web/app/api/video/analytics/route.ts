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

  const { clicks: analytics } = (await dub.analytics.retrieve({
    domain: "cap.link",
    key: videoId,
  })) as ClicksCount;

  if (typeof analytics !== "number") {
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
}
