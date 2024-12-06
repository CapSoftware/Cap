import { dub } from "@/utils/dub";
import { ClicksCount } from "dub/models/components";
import { NextRequest } from "next/server";

export const revalidate = 300;

export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const videoId = searchParams.get("videoId");

  if (!videoId) {
    return Response.json({ error: true }, { status: 401 });
  }

  try {
    const response = await dub.analytics.retrieve({
      domain: "cap.link",
      key: videoId,
    });
    const { clicks: analytics } = response as ClicksCount;

    if (typeof analytics !== "number" || analytics === null) {
      return Response.json({ error: true }, { status: 401 });
    }

    return Response.json({ count: analytics }, { status: 200 });
  } catch (error: any) {
    if (error.code === "not_found") {
      return Response.json(
        {
          error: true,
          message: "Video link not found.",
          docUrl: error.docUrl,
        },
        { status: 404 }
      );
    }
    return Response.json({ error: true }, { status: 500 });
  }
}
