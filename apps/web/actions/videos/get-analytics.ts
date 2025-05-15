"use server";

import { dub } from "@/utils/dub";
import { ClicksCount } from "dub/models/components";

export async function getVideoAnalytics(videoId: string) {
  if (!videoId) {
    throw new Error("Video ID is required");
  }

  try {
    const response = await dub().analytics.retrieve({
      domain: "cap.link",
      key: videoId,
    });
    const { clicks: analytics } = response as ClicksCount;

    if (typeof analytics !== "number" || analytics === null) {
      return { count: 0 };
    }

    return { count: analytics };
  } catch (error: any) {
    if (error.code === "not_found") {
      // Return 0 views if link not found instead of throwing an error
      return { count: 0 };
    }
    console.error("Error fetching video analytics:", error);
    return { count: 0 };
  }
}
