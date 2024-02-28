import { type NextRequest } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@cap/database/auth/auth-options";
import { getToken, encode } from "next-auth/jwt";

export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions);
  const searchParams = req.nextUrl.searchParams;
  const port = searchParams.get("port") || "";

  const token = await getToken({
    req,
    secret: process.env.NEXTAUTH_SECRET ?? "",
  });

  if (!token) {
    return Response.redirect(
      `${process.env.NEXT_PUBLIC_URL}/login?next=api/desktop/session/request?port=${port}`
    );
  }

  const encodedToken = await encode({
    token: token,
    secret: process.env.NEXTAUTH_SECRET ?? "",
  });

  const returnUrl = new URL(
    `http://localhost:${port}?token=${encodedToken}&expires=${token?.exp}`
  );

  if (session) {
    return Response.redirect(returnUrl.href);
  } else {
    return Response.redirect(`${process.env.NEXT_PUBLIC_URL}/login`);
  }
}
