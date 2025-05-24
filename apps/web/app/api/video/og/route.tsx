import { NextRequest } from "next/server";
import { generateVideoOgImage } from "@/actions/videos/get-og-image";

export async function GET(req: NextRequest) {
  const videoId = req.nextUrl.searchParams.get("videoId") as string;
  return generateVideoOgImage(videoId);
}
