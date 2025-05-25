import { NextRequest, NextResponse } from "next/server";
import { db } from "@cap/database";
import { videos } from "@cap/database/schema";
import { verifyPassword } from "@cap/database/crypto";
import { eq } from "drizzle-orm";

export async function POST(request: NextRequest) {
  const { videoId, password } = await request.json();

  if (!videoId || typeof password !== "string") {
    return NextResponse.json({ error: "Missing data" }, { status: 400 });
  }

  const [video] = await db().select().from(videos).where(eq(videos.id, videoId));
  if (!video || !video.password) {
    return NextResponse.json({ error: "No password" }, { status: 400 });
  }

  const valid = await verifyPassword(video.password, password);
  if (!valid) {
    return NextResponse.json({ success: false }, { status: 401 });
  }

  return NextResponse.json({ success: true });
}
