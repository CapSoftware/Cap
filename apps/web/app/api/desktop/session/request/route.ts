import { type NextRequest } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@cap/database/auth/auth-options";
import { decode, encode } from "next-auth/jwt";
import { cookies } from "next/headers";

export async function GET(req: NextRequest) {
  const searchParams = req.nextUrl.searchParams;
  const session = await getServerSession(authOptions);
  const port = searchParams.get("port") || "";

  if (!session) {
    return Response.redirect(
      `${process.env.NEXT_PUBLIC_URL}/login?next=${process.env.NEXT_PUBLIC_URL}/api/desktop/session/request?port=${port}`
    );
  }

  const token = req.cookies.get("next-auth.session-token") ?? null;
  const tokenValue = token?.value ?? null;

  if (!tokenValue) {
    return Response.redirect(
      `${process.env.NEXT_PUBLIC_URL}/login?next=${process.env.NEXT_PUBLIC_URL}/api/desktop/session/request?port=${port}`
    );
  }

  const decodedToken = await decode({
    token: tokenValue,
    secret: process.env.NEXTAUTH_SECRET as string,
  });

  if (!decodedToken) {
    return Response.redirect(
      `${process.env.NEXT_PUBLIC_URL}/login?next=${process.env.NEXT_PUBLIC_URL}/api/desktop/session/request?port=${port}`
    );
  }

  console.log("decodedToken: ", decodedToken);

  const returnUrl = new URL(
    `http://localhost:${port}?token=${tokenValue}&expires=${decodedToken?.exp}`
  );

  return Response.redirect(returnUrl.href);
}
