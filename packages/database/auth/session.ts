import { getServerSession } from "next-auth";
import { eq, InferSelectModel } from "drizzle-orm";
import { cache } from "react";

import { authOptions } from "./auth-options";
import { db } from "../";
import { users } from "../schema";

export const getSession = async () => {
  const session = await getServerSession(authOptions());

  return session;
};

export const getCurrentUser = cache(
  async (): Promise<InferSelectModel<typeof users> | null> => {
    const session = await getServerSession(authOptions());

    if (!session) return null;

    const [currentUser] = await db()
      .select()
      .from(users)
      .where(eq(users.id, session.user.id));

    return currentUser ?? null;
  }
);

export const userSelectProps = users.$inferSelect;
