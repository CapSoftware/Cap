import { type NextRequest } from "next/server";
import { getCurrentUser } from "@cap/database/auth/session";
import { spaces } from "@cap/database/schema";
import { db } from "@cap/database";
import { eq } from "drizzle-orm";

export async function POST(request: NextRequest) {
  console.log("POST request received for workspace details update");
  const user = await getCurrentUser();
  const { workspaceName, spaceId } = await request.json();
  console.log(`Received workspaceName: ${workspaceName}, spaceId: ${spaceId}`);

  if (!user) {
    console.error("User not found");

    return new Response(JSON.stringify({ error: true }), {
      status: 401,
      headers: {
        "Content-Type": "application/json",
      },
    });
  }

  console.log(`User found: ${user.id}`);

  const space = await db.select().from(spaces).where(eq(spaces.id, spaceId));
  console.log(`Space query result:`, space);

  if (!space) {
    console.error(`Space not found for spaceId: ${spaceId}`);
    return new Response(JSON.stringify({ error: true }), {
      status: 404,
      headers: {
        "Content-Type": "application/json",
      },
    });
  }

  if (space.length > 0 && space[0]?.ownerId !== user.id) {
    console.error(`User ${user.id} is not the owner of space ${spaceId}`);
    return new Response(JSON.stringify({ error: true }), {
      status: 403,
      headers: {
        "Content-Type": "application/json",
      },
    });
  }

  console.log(`Updating space name to: ${workspaceName}`);
  await db
    .update(spaces)
    .set({
      name: workspaceName,
    })
    .where(eq(spaces.id, spaceId));

  console.log("Workspace details updated successfully");
  return new Response(
    JSON.stringify({
      status: 200,
      headers: {
        "Content-Type": "application/json",
      },
    })
  );
}
