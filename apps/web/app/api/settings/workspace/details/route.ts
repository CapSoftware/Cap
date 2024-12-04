import { type NextRequest } from "next/server";
import { getCurrentUser } from "@cap/database/auth/session";
import { spaces } from "@cap/database/schema";
import { db } from "@cap/database";
import { eq } from "drizzle-orm";

export async function POST(request: NextRequest) {
  const user = await getCurrentUser();
  const { workspaceName, allowedEmailDomain, spaceId } = await request.json();

  if (!user) {
    return new Response(JSON.stringify({ error: true }), {
      status: 401,
      headers: {
        "Content-Type": "application/json",
      },
    });
  }


  const space = await db.select().from(spaces).where(eq(spaces.id, spaceId));

  if (!space) {
    return new Response(JSON.stringify({ error: true }), {
      status: 404,
      headers: {
        "Content-Type": "application/json",
      },
    });
  }

  if (space.length > 0 && space[0]?.ownerId !== user.id) {
    return new Response(JSON.stringify({ error: true }), {
      status: 403,
      headers: {
        "Content-Type": "application/json",
      },
    });
  }

  await db
    .update(spaces)
    .set({
      name: workspaceName,
      allowedEmailDomain: allowedEmailDomain || null,
    })
    .where(eq(spaces.id, spaceId));

  return new Response(
    JSON.stringify({
      status: 200,
      headers: {
        "Content-Type": "application/json",
      },
    })
  );
}
