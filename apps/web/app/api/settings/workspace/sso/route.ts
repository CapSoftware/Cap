import { type NextRequest } from "next/server";
import { getCurrentUser } from "@cap/database/auth/session";
import { spaces } from "@cap/database/schema";
import { db } from "@cap/database";
import { eq } from "drizzle-orm";

export async function POST(request: NextRequest) {
  const user = await getCurrentUser();
  const { spaceId, workosOrganizationId, workosConnectionId } =
    await request.json();

  if (!user) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const [space] = await db.select().from(spaces).where(eq(spaces.id, spaceId));

  if (!space || space.ownerId !== user.id) {
    return Response.json({ error: "Unauthorized" }, { status: 403 });
  }

  await db
    .update(spaces)
    .set({
      workosOrganizationId,
      workosConnectionId,
    })
    .where(eq(spaces.id, spaceId));

  return Response.json({ success: true }, { status: 200 });
}
