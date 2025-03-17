import { type NextRequest } from "next/server";
import { getCurrentUser } from "@cap/database/auth/session";
import { spaces } from "@cap/database/schema";
import { db } from "@cap/database";
import { eq } from "drizzle-orm";

export async function GET() {
  const user = await getCurrentUser();

  if (!user) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const userSpaces = await db
      .select()
      .from(spaces)
      .where(eq(spaces.ownerId, user.id));

    return Response.json({ workspaces: userSpaces }, { status: 200 });
  } catch (error) {
    console.error("Error fetching user workspaces:", error);
    return Response.json(
      { error: "Failed to fetch workspaces" },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  const user = await getCurrentUser();
  const { workspaceName, allowedEmailDomain, spaceId } = await request.json();

  if (!user) {
    return Response.json({ error: true }, { status: 401 });
  }

  const space = await db.select().from(spaces).where(eq(spaces.id, spaceId));

  if (!space) {
    return Response.json({ error: true }, { status: 404 });
  }

  if (space.length > 0 && space[0]?.ownerId !== user.id) {
    return Response.json({ error: true }, { status: 403 });
  }

  await db
    .update(spaces)
    .set({
      name: workspaceName,
      allowedEmailDomain: allowedEmailDomain || null,
    })
    .where(eq(spaces.id, spaceId));

  return Response.json(true, { status: 200 });
}
