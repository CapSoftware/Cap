import { getServerSession } from "next-auth";
import { eq } from "drizzle-orm";
import { authOptions } from "./auth-options";
import { db } from "../";
import { users } from "../schema";

export const getSession = async () => {
  const session = await getServerSession(authOptions);

  return session;
};

export const userSelectProps = {
  userId: users.id,
  email: users.email,
  name: users.name,
  image: users.image,
  createdAt: users.created_at,
};

export const getCurrentUser = async () => {
  const session = await getServerSession(authOptions);

  if (!session) {
    return null;
  }

  const [currentUser] = await db
    .select(userSelectProps)
    .from(users)
    .where(eq(users.id, session?.user.id));

  return currentUser;
};
