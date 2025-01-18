import { type NextRequest } from "next/server";
import { db } from "@cap/database";
import { spaces } from "@cap/database/schema";
import { eq } from "drizzle-orm";

export async function GET(request: NextRequest) {
  console.log("[workspace/lookup] Received request");
  const searchParams = new URL(request.url).searchParams;
  const spaceId = searchParams.get("spaceId");

  if (!spaceId) {
    console.log("[workspace/lookup] Missing spaceId parameter");
    return Response.json(
      { error: "Space ID parameter is required" },
      { status: 400 }
    );
  }

  console.log("[workspace/lookup] Looking up space:", spaceId);
  const [space] = await db
    .select({
      workosOrganizationId: spaces.workosOrganizationId,
      workosConnectionId: spaces.workosConnectionId,
      name: spaces.name,
    })
    .from(spaces)
    .where(eq(spaces.id, spaceId));

  console.log("[workspace/lookup] Found space:", space);

  if (!space || !space.workosOrganizationId || !space.workosConnectionId) {
    console.log("[workspace/lookup] Space not found or missing SSO config");
    return Response.json(
      { error: "Space not found or SSO not configured" },
      { status: 404 }
    );
  }

  console.log("[workspace/lookup] Found space:", space.name);
  return Response.json(
    {
      organizationId: space.workosOrganizationId,
      connectionId: space.workosConnectionId,
      name: space.name,
    },
    { status: 200 }
  );
}
