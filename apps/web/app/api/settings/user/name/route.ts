import { type NextRequest } from "next/server";
import { getCurrentUser } from "@cap/database/auth/session";
import { users } from "@cap/database/schema";
import { db } from "@cap/database";
import { eq } from "drizzle-orm";

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

  return Response.json(true, {
    status: 200,
  });
}
