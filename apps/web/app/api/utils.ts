import { getCurrentUser } from "@cap/database/auth/session";
import { cookies } from "next/headers";
import { createMiddleware } from "hono/factory";
import { buildEnv, serverEnv } from "@cap/env";
import { cors } from "hono/cors";
import { eq } from "drizzle-orm";
import { getServerSession, Session } from "next-auth";
import { authOptions } from "@cap/database/auth/auth-options";
import { Context } from "hono";
import { db } from "@cap/database";
import { authApiKeys, users } from "@cap/database/schema";

async function getAuth(c: Context) {
  const authHeader = c.req.header("authorization")?.split(" ")[1];

  let user;

  if (authHeader?.length === 36) {
    const res = await db()
      .select()
      .from(users)
      .leftJoin(authApiKeys, eq(users.id, authApiKeys.userId))
      .where(eq(authApiKeys.id, authHeader));
    user = res[0]?.users;
  } else {
    if (authHeader)
      cookies().set({
        name: "next-auth.session-token",
        value: authHeader,
        path: "/",
        sameSite: "none",
        secure: true,
        httpOnly: true,
      });

    user = await getCurrentUser();
  }

  if (!user) return;
  return { user };
}

export const withOptionalAuth = createMiddleware<{
  Variables: {
    user?: Awaited<ReturnType<typeof getCurrentUser>>;
  };
}>(async (c, next) => {
  const auth = await getAuth(c);

  if (auth) c.set("user", auth.user);

  await next();
});

export const withAuth = createMiddleware<{
  Variables: {
    user: NonNullable<Awaited<ReturnType<typeof getCurrentUser>>>;
  };
}>(async (c, next) => {
  console.log("withAuth", c.req);
  const auth = await getAuth(c);
  console.log("withAuth", { auth });
  if (!auth) return c.text("User not authenticated", 401);

  c.set("user", auth.user);

  await next();
});

const allowedOrigins = [
  buildEnv.NEXT_PUBLIC_WEB_URL,
  "http://localhost:3001",
  "http://localhost:3000",
  "tauri://localhost",
  "http://tauri.localhost",
  "https://tauri.localhost",
];

export const corsMiddleware = cors({
  origin: allowedOrigins,
  credentials: true,
  allowMethods: ["POST", "OPTIONS"],
  allowHeaders: ["Content-Type", "Authorization", "sentry-trace", "baggage"],
});
