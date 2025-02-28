import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { serverConfigTable } from "@cap/database/schema";
import { eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";

// Helper function to check if user is a super admin
async function isSuperAdmin() {
  const currentUser = await getCurrentUser();
  if (!currentUser) return false;

  const serverConfig = await db.query.serverConfigTable.findFirst({
    where: eq(serverConfigTable.id, 1),
  });

  if (!serverConfig) return false;

  return (
    serverConfig.superAdminIds.includes(currentUser.id) ||
    currentUser.email.endsWith("@cap.so")
  );
}

// GET handler to retrieve server configuration
export async function GET() {
  // Check if user is authorized
  if (!(await isSuperAdmin())) {
    return NextResponse.json({ error: "Not authorized" }, { status: 403 });
  }

  try {
    const serverConfig = await db.query.serverConfigTable.findFirst({
      where: eq(serverConfigTable.id, 1),
    });

    return NextResponse.json(serverConfig);
  } catch (error) {
    console.error("Error fetching server config:", error);
    return NextResponse.json(
      { error: "Failed to fetch server configuration" },
      { status: 500 }
    );
  }
}

// PUT handler to update server configuration
export async function PUT(request: NextRequest) {
  // Check if user is authorized
  if (!(await isSuperAdmin())) {
    return NextResponse.json({ error: "Not authorized" }, { status: 403 });
  }

  try {
    const body = await request.json();

    // Validate the request body
    const validFields = [
      "licenseKey",
      "signupsEnabled",
      "emailSendFromName",
      "emailSendFromEmail",
      "superAdminIds",
    ];

    const updateData: Record<string, any> = {};

    // Only include valid fields in the update
    for (const field of validFields) {
      if (body[field] !== undefined) {
        updateData[field] = body[field];
      }
    }

    // Update the server config
    await db
      .update(serverConfigTable)
      .set(updateData)
      .where(eq(serverConfigTable.id, 1));

    // Get the updated config
    const updatedConfig = await db.query.serverConfigTable.findFirst({
      where: eq(serverConfigTable.id, 1),
    });

    return NextResponse.json(updatedConfig);
  } catch (error) {
    console.error("Error updating server config:", error);
    return NextResponse.json(
      { error: "Failed to update server configuration" },
      { status: 500 }
    );
  }
}
