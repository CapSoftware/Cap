import { getCurrentUser } from "@cap/database/auth/session";
import { db } from "@cap/database";
import { organizations } from "@cap/database/schema";
import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";

export async function GET() {
  try {
    const user = await getCurrentUser();

    if (!user || !user.id) {
      return NextResponse.json({ success: false, error: "Unauthorized" });
    }

    const organizationsData = await db()
      .select({
        id: organizations.id,
        name: organizations.name,
      })
      .from(organizations)
      .where(eq(organizations.ownerId, user.id));
    return NextResponse.json({ success: true, data: organizationsData });
  } catch (error) {
    console.error("Error fetching organizations:", error);
    return NextResponse.json({
      success: false,
      error:
        error instanceof Error
          ? error.message
          : "Failed to fetch organizations",
    });
  }
}
