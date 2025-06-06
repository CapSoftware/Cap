import { getServerSession, Session } from "next-auth";
import { eq, InferSelectModel } from "drizzle-orm";
import { authOptions } from "./auth-options";
import { db } from "../";
import { users } from "../schema";

export const getSession = async () => {
  const session = await getServerSession(authOptions());

  return session;
};

export const getCurrentUser = async (
  session?: Session
): Promise<InferSelectModel<typeof users> | null> => {
  const _session = session ?? (await getServerSession(authOptions()));

  if (!_session) return null;

  const [currentUser] = await db()
    .select()
    .from(users)
    .where(eq(users.id, _session?.user.id));

  return currentUser ?? null;
};

export const userSelectProps = users.$inferSelect;
