import { getProPlanBillingCycle } from "@cap/utils";
import { getCurrentUser } from "@cap/database/auth/session";
import { NextRequest } from "next/server";
import {
  generateCloudProStripeCheckoutSession,
  isWorkspacePro,
} from "@/utils/instance/functions";

export async function POST(request: NextRequest) {
  console.log("Starting subscription process");
  const user = await getCurrentUser();
  const { priceId } = await request.json();

  console.log("Received request with priceId:", priceId);
  console.log("Current user:", user?.id);

  if (!priceId) {
    console.error("Price ID not found");
    return Response.json({ error: true }, { status: 400 });
  }

  if (!user) {
    console.error("User not found");
    return Response.json({ error: true, auth: false }, { status: 401 });
  }

  const userActiveWorkspaceId = user.activeSpaceId;

  if (!userActiveWorkspaceId) {
    console.error("User has no active workspace");
    return Response.json({ error: true }, { status: 400 });
  }

  // get the current workspace pro status and return if it is already on pro
  const workspaceProStatus = await isWorkspacePro({
    workspaceId: userActiveWorkspaceId,
  });
  if (workspaceProStatus) {
    console.error("Workspace already has pro plan");
    return Response.json({ error: true, subscription: true }, { status: 400 });
  }

  const priceType = getProPlanBillingCycle(priceId);

  try {
    const checkoutLink = await generateCloudProStripeCheckoutSession({
      cloudWorkspaceId: userActiveWorkspaceId,
      cloudUserId: user.id,
      email: user.email,
      type: priceType,
    });

    if (!checkoutLink) {
      console.error("Failed to create checkout session");
      return Response.json({ error: true }, { status: 400 });
    }

    if (checkoutLink.checkoutLink) {
      console.log("Successfully created checkout session");
      return Response.json({ url: checkoutLink.checkoutLink }, { status: 200 });
    }

    console.error("Checkout session created but no URL returned");
    return Response.json({ error: true }, { status: 400 });
  } catch (error) {
    console.error("Error creating checkout session:", error);
    return Response.json({ error: true }, { status: 500 });
  }
}
