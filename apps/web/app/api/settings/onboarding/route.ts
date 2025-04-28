import { type NextRequest } from "next/server";
import { getCurrentUser } from "@cap/database/auth/session";
import { spaceMembers, spaces, users } from "@cap/database/schema";
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

  const [space] = await db
    .select()
    .from(spaces)
    .where(or(eq(spaces.ownerId, user.id), eq(spaceMembers.userId, user.id)))
    .leftJoin(spaceMembers, eq(spaces.id, spaceMembers.spaceId));

  if (!space) {
    const spaceId = nanoId();

    await db()
      .insert(spaces)
      .values({
        id: spaceId,
        ownerId: user.id,
        name: `${fullName}'s Space`,
      });

    await db().insert(spaceMembers).values({
      id: nanoId(),
      userId: user.id,
      role: "owner",
      spaceId,
    });

    await db
      .update(users)
      .set({ activeSpaceId: spaceId })
      .where(eq(users.id, user.id));
  }

  // After updating user and creating space
  return Response.json(
    { success: true, message: "Onboarding completed successfully" },
    { status: 200 }
  );
}
