import { type NextRequest } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@cap/database/auth/auth-options";
import { getToken, encode } from "next-auth/jwt";

export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions);
  const searchParams = req.nextUrl.searchParams;
  const redirectUrl = searchParams.get("redirectUrl") || "";

  const token = await getToken({
    req,
    secret: process.env.NEXTAUTH_SECRET ?? "",
  });

  if (!token) {
    return new Response(JSON.stringify({ isLoggedIn: false }), {
      status: 401,
      headers: {
        "Content-Type": "application/json",
      },
    });
  }

  const encodedToken = await encode({
    token: token,
    secret: process.env.NEXTAUTH_SECRET ?? "",
  });

  const returnUrl = new URL(
    `${redirectUrl}?token=${encodedToken}&expires=${token?.exp}`
  );

  if (session) {
    return Response.redirect(returnUrl);
  } else {
    return new Response(JSON.stringify({ isLoggedIn: false }), {
      status: 401,
      headers: {
        "Content-Type": "application/json",
      },
    });
  }
}
