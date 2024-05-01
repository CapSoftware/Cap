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

    return new Response(JSON.stringify({ error: true }), {
      status: 401,
      headers: {
        "Content-Type": "application/json",
      },
    });
  }

  await db
    .update(users)
    .set({
      name: firstName,
      lastName: lastName,
    })
    .where(eq(users.id, user.id));

  return new Response(
    JSON.stringify({
      status: 200,
      headers: {
        "Content-Type": "application/json",
      },
    })
  );
}
