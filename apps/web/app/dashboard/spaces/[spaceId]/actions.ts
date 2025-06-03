"use server";

import { db } from "@cap/database";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { spaceMembers } from "@cap/database/schema";
import { getCurrentUser } from "@cap/database/auth/session";
import { nanoIdLength } from "@cap/database/helpers";
import { eq } from "drizzle-orm";
import { v4 as uuidv4 } from "uuid";

const addSpaceMemberSchema = z.object({
  spaceId: z.string(),
  userId: z.string(),
  role: z.string(),
});

export async function addSpaceMember(data: z.infer<typeof addSpaceMemberSchema>) {
  const validation = addSpaceMemberSchema.safeParse(data);
  
  if (!validation.success) {
    throw new Error("Invalid input");
  }
  
  const currentUser = await getCurrentUser();
  
  if (!currentUser) {
    throw new Error("Unauthorized");
  }
  
  const { spaceId, userId, role } = validation.data;
  
  await db().insert(spaceMembers).values({
    id: uuidv4().substring(0, nanoIdLength),
    spaceId,
    userId,
    role,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  
  revalidatePath(`/dashboard/spaces/${spaceId}`);
  
  return { success: true };
}

const removeSpaceMemberSchema = z.object({
  memberId: z.string(),
});

export async function removeSpaceMember(data: z.infer<typeof removeSpaceMemberSchema>) {
  const validation = removeSpaceMemberSchema.safeParse(data);
  
  if (!validation.success) {
    throw new Error("Invalid input");
  }
  
  const currentUser = await getCurrentUser();
  
  if (!currentUser) {
    throw new Error("Unauthorized");
  }
  
  const { memberId } = validation.data;
  
  const member = await db()
    .select({ spaceId: spaceMembers.spaceId })
    .from(spaceMembers)
    .where(eq(spaceMembers.id, memberId))
    .limit(1);
    
  if (member.length === 0) {
    throw new Error("Member not found");
  }
  
  const spaceId = member[0]?.spaceId;
  
  if (!spaceId) {
    throw new Error("Space ID not found");
  }
  
  await db()
    .delete(spaceMembers)
    .where(eq(spaceMembers.id, memberId));
  
  revalidatePath(`/dashboard/spaces/${spaceId}`);
  
  return { success: true };
} 