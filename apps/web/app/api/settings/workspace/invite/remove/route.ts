import { type NextRequest } from "next/server";
import { getCurrentUser } from "@cap/database/auth/session";
import { spaces, spaceInvites } from "@cap/database/schema";
import { db } from "@cap/database";
import { eq, and } from "drizzle-orm";
import { updateCloudWorkspaceUserCount } from "@/utils/instance/functions";

export async function POST(request: NextRequest) {
  console.log("POST request received for removing workspace invite");
  const user = await getCurrentUser();
  const { inviteId, spaceId } = await request.json();
  console.log(`Received inviteId: ${inviteId}, spaceId: ${spaceId}`);

  if (!user) {
    console.error("User not found");
    return Response.json({ error: true }, { status: 401 });
  }

  console.log(`User found: ${user.id}`);

  const space = await db
    .select()
    .from(spaces)
    .where(eq(spaces.id, spaceId))
    .limit(1);
  console.log(`Space query result:`, space);

  if (!space || space.length === 0) {
    console.error(`Space not found for spaceId: ${spaceId}`);
    return Response.json({ error: true }, { status: 404 });
  }

  if (space[0]?.ownerId !== user.id) {
    console.error(`User ${user.id} is not the owner of space ${spaceId}`);
    return Response.json({ error: true }, { status: 403 });
  }

  const result = await db
    .delete(spaceInvites)
    .where(
      and(eq(spaceInvites.id, inviteId), eq(spaceInvites.spaceId, spaceId))
    );

  if (result.rowsAffected === 0) {
    console.error(`No invite found with id ${inviteId} for space ${spaceId}`);
    return Response.json({ error: true }, { status: 404 });
  }

  // Update workspace user count
  await updateCloudWorkspaceUserCount({
    workspaceId: spaceId,
  });

  console.log("Workspace invite removed successfully");
  return Response.json({ success: true }, { status: 200 });
}
