import { authOptions } from "@cap/database/auth/auth-options";
import { getCurrentUser } from "@cap/database/auth/session";
import { clientEnv, serverEnv } from "@cap/env";
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
    })
  ),
  async (c) => {
    const { port, platform } = c.req.valid("query");

    const secret = serverEnv.NEXTAUTH_SECRET;

    const url = new URL(c.req.url);
    const loginRedirectUrl = `${clientEnv.NEXT_PUBLIC_WEB_URL}/login?next=${clientEnv.NEXT_PUBLIC_WEB_URL}${url.pathname}${url.search}`;

    const session = await getServerSession(authOptions);
    if (!session) return c.redirect(loginRedirectUrl);

    const token = getCookie(c, "next-auth.session-token");
    const user = await getCurrentUser(session);

    if (token === undefined || !user) return c.redirect(loginRedirectUrl);

    const decodedToken = await decode({ token, secret });

    if (!decodedToken) return Response.redirect(loginRedirectUrl);

    const params = new URLSearchParams({
      token,
      expires: decodedToken.exp as string,
      user_id: user.id,
    });

    const returnUrl = new URL(
      platform === "web"
        ? `http://127.0.0.1:${port}?${params}`
        : `cap-desktop://signin?${params}`
    );

    return Response.redirect(returnUrl.href);
  }
);
