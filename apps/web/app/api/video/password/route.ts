import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@cap/database/auth/session";
import { db } from "@cap/database";
import { videos } from "@cap/database/schema";
import { hashPassword } from "@cap/database/crypto";
import { eq } from "drizzle-orm";

export async function POST(request: NextRequest) {
  const user = await getCurrentUser();
  const { videoId, password } = await request.json();

  if (!user || !videoId || typeof password !== "string") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const [video] = await db().select().from(videos).where(eq(videos.id, videoId));
  if (!video || video.ownerId !== user.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 403 });
  }

  const hashed = await hashPassword(password);
  await db().update(videos).set({ password: hashed }).where(eq(videos.id, videoId));

  return NextResponse.json({ success: true });
}

export async function DELETE(request: NextRequest) {
  const user = await getCurrentUser();
  const { searchParams } = request.nextUrl;
  const videoId = searchParams.get("videoId") || "";

  if (!user || !videoId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const [video] = await db().select().from(videos).where(eq(videos.id, videoId));
  if (!video || video.ownerId !== user.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 403 });
  }

  await db().update(videos).set({ password: null }).where(eq(videos.id, videoId));

  return NextResponse.json({ success: true });
}
