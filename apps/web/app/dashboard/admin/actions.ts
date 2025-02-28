"use server";

import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { users, serverConfigTable } from "@cap/database/schema";
import { eq, like, inArray } from "drizzle-orm";
import { ServerConfigFormValues, SuperAdminUser } from "./server-config/schema";

export async function lookupUserById(data: FormData) {
  const currentUser = await getCurrentUser();
  if (!currentUser?.email.endsWith("@cap.so")) return;

  const [user] = await db
    .select()
    .from(users)
    .where(eq(users.id, data.get("id") as string));

  return user;
}

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

// Get current user ID
export async function getCurrentUserId() {
  const currentUser = await getCurrentUser();
  return currentUser?.id || null;
}

// Get server configuration
export async function getServerConfiguration() {
  if (!(await isSuperAdmin())) {
    throw new Error("Not authorized");
  }

  const serverConfig = await db.query.serverConfigTable.findFirst({
    where: eq(serverConfigTable.id, 1),
  });

  return serverConfig;
}

// Update server configuration with typed values
export async function updateServerConfiguration(
  values: ServerConfigFormValues
) {
  if (!(await isSuperAdmin())) {
    throw new Error("Not authorized");
  }

  // Prepare update data
  const updateData: Record<string, any> = {
    licenseKey: values.licenseKey,
    signupsEnabled: values.signupsEnabled,
    emailSendFromName: values.emailSendFromName,
    emailSendFromEmail: values.emailSendFromEmail,
  };

  await db
    .update(serverConfigTable)
    .set(updateData)
    .where(eq(serverConfigTable.id, 1));

  return await db.query.serverConfigTable.findFirst({
    where: eq(serverConfigTable.id, 1),
  });
}

// Search for users by email
export async function searchUsersByEmail(
  email: string
): Promise<SuperAdminUser[]> {
  if (!(await isSuperAdmin())) {
    throw new Error("Not authorized");
  }

  if (!email || email.trim().length < 3) {
    return [];
  }

  const searchResults = await db
    .select({
      id: users.id,
      name: users.name,
      email: users.email,
      image: users.image,
    })
    .from(users)
    .where(like(users.email, `%${email}%`))
    .limit(5);

  return searchResults;
}

// Add user to super admin list
export async function addSuperAdmin(userId: string) {
  if (!(await isSuperAdmin())) {
    throw new Error("Not authorized");
  }

  const serverConfig = await db.query.serverConfigTable.findFirst({
    where: eq(serverConfigTable.id, 1),
  });

  if (!serverConfig) {
    throw new Error("Server configuration not found");
  }

  // Check if user is already a super admin
  if (serverConfig.superAdminIds.includes(userId)) {
    return serverConfig;
  }

  // Add user to super admin list
  const updatedSuperAdminIds = [...serverConfig.superAdminIds, userId];

  await db
    .update(serverConfigTable)
    .set({ superAdminIds: updatedSuperAdminIds })
    .where(eq(serverConfigTable.id, 1));

  return await db.query.serverConfigTable.findFirst({
    where: eq(serverConfigTable.id, 1),
  });
}

// Remove user from super admin list
export async function removeSuperAdmin(userId: string) {
  if (!(await isSuperAdmin())) {
    throw new Error("Not authorized");
  }

  // Prevent removing yourself
  const currentUser = await getCurrentUser();
  if (!currentUser) {
    throw new Error("User not authenticated");
  }

  if (userId === currentUser.id) {
    throw new Error("You cannot remove yourself from super admins");
  }

  const serverConfig = await db.query.serverConfigTable.findFirst({
    where: eq(serverConfigTable.id, 1),
  });

  if (!serverConfig) {
    throw new Error("Server configuration not found");
  }

  // Remove user from super admin list
  const updatedSuperAdminIds = serverConfig.superAdminIds.filter(
    (id) => id !== userId
  );

  await db
    .update(serverConfigTable)
    .set({ superAdminIds: updatedSuperAdminIds })
    .where(eq(serverConfigTable.id, 1));

  return await db.query.serverConfigTable.findFirst({
    where: eq(serverConfigTable.id, 1),
  });
}

// Get super admin users with details
export async function getSuperAdminUsers(): Promise<SuperAdminUser[]> {
  if (!(await isSuperAdmin())) {
    throw new Error("Not authorized");
  }

  const serverConfig = await db.query.serverConfigTable.findFirst({
    where: eq(serverConfigTable.id, 1),
  });

  if (!serverConfig || !serverConfig.superAdminIds.length) {
    return [];
  }

  // Get user details for all super admins
  const superAdminUsers = await db
    .select({
      id: users.id,
      name: users.name,
      email: users.email,
      image: users.image,
    })
    .from(users)
    .where(inArray(users.id, serverConfig.superAdminIds));

  return superAdminUsers;
}
