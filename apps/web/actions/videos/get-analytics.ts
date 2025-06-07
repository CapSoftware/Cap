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
      return { count: 0 };
    }
    return { count: 0 };
  }
}
