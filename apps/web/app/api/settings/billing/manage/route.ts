import { getCurrentUser } from "@cap/database/auth/session";
import { NextRequest, NextResponse } from "next/server";
import { generateCloudProStripePortalLink } from "@/utils/instance/functions";

export async function POST(request: NextRequest) {
  const user = await getCurrentUser();

  if (!user) {
    console.error("User not found");
    return Response.json({ error: true }, { status: 401 });
  }

  const userActiveWorkspaceId = user.activeSpaceId;

  if (!userActiveWorkspaceId) {
    console.error("User has no active workspace");
    return Response.json({ error: true }, { status: 400 });
  }

  const portalLink = await generateCloudProStripePortalLink({
    cloudWorkspaceId: userActiveWorkspaceId,
  });

  if (!portalLink) {
    console.error("Failed to generate checkout link");
    return Response.json({ error: true }, { status: 400 });
  }

  return NextResponse.json(portalLink.portalLink);
}
