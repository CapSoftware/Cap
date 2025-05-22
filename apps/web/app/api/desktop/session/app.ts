import { db } from "@cap/database";
import { authOptions } from "@cap/database/auth/auth-options";
import { getCurrentUser } from "@cap/database/auth/session";
import { authApiKeys } from "@cap/database/schema";
import { serverEnv } from "@cap/env";
import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import { getServerSession } from "next-auth";
import { decode } from "next-auth/jwt";
import { z } from "zod";

export const app = new Hono();

app.get(
  "/request",
  zValidator(
    "query",
    z.object({
      port: z.string().optional(),
      platform: z
        .union([z.literal("web"), z.literal("desktop")])
        .default("web"),
      type: z
        .union([z.literal("session"), z.literal("api_key")])
        .default("session"),
    })
  ),
  async (c) => {
    const { port, platform, type } = c.req.valid("query");

    const secret = serverEnv().NEXTAUTH_SECRET;

    const url = new URL(c.req.url);
    const loginRedirectUrl = `${serverEnv().WEB_URL}/login?next=${
      serverEnv().WEB_URL
    }${url.pathname}${url.search}`;

    const session = await getServerSession(authOptions());
    if (!session) return c.redirect(loginRedirectUrl);

    const user = await getCurrentUser(session);
    if (!user) return c.redirect(loginRedirectUrl);

    let data;

    if (type === "session") {
      const token = getCookie(c, "next-auth.session-token");
      if (token === undefined) return c.redirect(loginRedirectUrl);

      const decodedToken = await decode({ token, secret });

      if (!decodedToken) return c.redirect(loginRedirectUrl);

      data = {
        type: "token",
        token,
        expires: decodedToken.exp as string,
      };
    } else {
      const id = crypto.randomUUID();
      await db().insert(authApiKeys).values({ id, userId: user.id });

      data = { type: "api_key", api_key: id };
    }

    const params = new URLSearchParams({ ...data, user_id: user.id });

    const returnUrl = new URL(
      platform === "web"
        ? `http://127.0.0.1:${port}?${params}`
        : `cap-desktop://signin?${params}`
    );

    return Response.redirect(returnUrl.href);
  }
);
