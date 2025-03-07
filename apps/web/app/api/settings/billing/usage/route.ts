import { getCurrentUser } from "@cap/database/auth/session";
import { NextRequest } from "next/server";
import { count, eq } from "drizzle-orm";
import { db } from "@cap/database";
import { videos } from "@cap/database/schema";
import { getIsUserPro } from "@/utils/instance/functions";

export async function GET(request: NextRequest) {
  const user = await getCurrentUser();

  if (!user) {
    return Response.json({ auth: false }, { status: 401 });
  }

  const numberOfVideos = await db
    .select({ count: count() })
    .from(videos)
    .where(eq(videos.ownerId, user.id));

  if (!numberOfVideos[0]) {
    return Response.json(
      { error: "Could not fetch video count" },
      { status: 500 }
    );
  }

  const isPro = await getIsUserPro({ userId: user.id });

  if (isPro) {
    return Response.json(
      {
        subscription: true,
        videoLimit: 0,
        videoCount: numberOfVideos[0].count,
      },
      { status: 200 }
    );
  } else {
    return Response.json(
      {
        subscription: false,
        videoLimit: 25,
        videoCount: numberOfVideos[0].count,
      },
      { status: 200 }
    );
  }
}
