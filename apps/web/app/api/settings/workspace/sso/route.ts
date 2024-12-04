import { type NextRequest } from "next/server";
import { getCurrentUser } from "@cap/database/auth/session";
import { spaces } from "@cap/database/schema";
import { db } from "@cap/database";
import { eq } from "drizzle-orm";

export async function POST(request: NextRequest) {
  const user = await getCurrentUser();
  const { spaceId, workosOrganizationId, workosConnectionId } = await request.json();

  if (!user) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: {
        "Content-Type": "application/json",
      },
    });
  }

  const [space] = await db
    .select()
    .from(spaces)
    .where(eq(spaces.id, spaceId));

  if (!space || space.ownerId !== user.id) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 403,
      headers: {
        "Content-Type": "application/json",
      },
    });
  }

  await db
    .update(spaces)
    .set({
      workosOrganizationId,
      workosConnectionId,
    })
    .where(eq(spaces.id, spaceId));

  return new Response(
    JSON.stringify({ success: true }),
    {
      status: 200,
      headers: {
        "Content-Type": "application/json",
      },
    }
  );
} 