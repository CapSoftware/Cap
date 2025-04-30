import { type NextRequest } from "next/server";
import { getCurrentUser } from "@cap/database/auth/session";
import { organizationMembers, organizations, users } from "@cap/database/schema";
import { db } from "@cap/database";
import { eq, or } from "drizzle-orm";
import { nanoId } from "@cap/database/helpers";

export async function POST(request: NextRequest) {
  const user = await getCurrentUser();
  const { firstName, lastName } = await request.json();

  if (!user) {
    console.error("User not found");

    return Response.json({ error: true }, { status: 401 });
  }

  await db
    .update(users)
    .set({
      name: firstName,
      lastName: lastName,
    })
    .where(eq(users.id, user.id));

  let fullName = firstName;
  if (lastName) {
    fullName += ` ${lastName}`;
  }

  const [organization] = await db
    .select()
    .from(organizations)
    .where(or(eq(organizations.ownerId, user.id), eq(organizationMembers.userId, user.id)))
    .leftJoin(organizationMembers, eq(organizations.id, organizationMembers.organizationId));

  if (!organization) {
    const organizationId = nanoId();

    await db.insert(organizations).values({
      id: organizationId,
      ownerId: user.id,
      name: `${fullName}'s Organization`,
    });

    await db.insert(organizationMembers).values({
      id: nanoId(),
      userId: user.id,
      role: "owner",
      organizationId,
    });

    await db
      .update(users)
      .set({ activeOrganizationId: organizationId })
      .where(eq(users.id, user.id));
  }

  return Response.json(
    { success: true, message: "Onboarding completed successfully" },
    { status: 200 }
  );
}
