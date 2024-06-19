import { isUserOnProPlan } from "@cap/utils";
import { getCurrentUser } from "@cap/database/auth/session";
import { NextRequest } from "next/server";
import { count, eq } from "drizzle-orm";
import { db } from "@cap/database";
import { videos } from "@cap/database/schema";

export async function GET(request: NextRequest) {
  const user = await getCurrentUser();

  if (!user) {
    return new Response(JSON.stringify({ auth: false }), {
      status: 401,
      headers: {
        "Content-Type": "application/json",
      },
    });
  }

  const numberOfVideos = await db
    .select({ count: count() })
    .from(videos)
    .where(eq(videos.ownerId, user.id));

  if (
    isUserOnProPlan({
      subscriptionStatus: user.stripeSubscriptionStatus as string,
    })
  ) {
    return new Response(
      JSON.stringify({
        subscription: true,
        videoLimit: 0,
        videoCount: numberOfVideos[0].count,
      }),
      {
        status: 200,
        headers: {
          "Content-Type": "application/json",
        },
      }
    );
  } else {
    return new Response(
      JSON.stringify({
        subscription: false,
        videoLimit: 25,
        videoCount: numberOfVideos[0].count,
      }),
      {
        status: 200,
        headers: {
          "Content-Type": "application/json",
        },
      }
    );
  }
}
