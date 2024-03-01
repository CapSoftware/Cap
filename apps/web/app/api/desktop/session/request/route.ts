import { type NextRequest } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@cap/database/auth/auth-options";
import { GetTokenParams, JWT, decode, encode } from "next-auth/jwt";
import { SessionStore } from "next-auth/core/lib/cookie";

//Derived from getToken in next-auth/jwt
export async function customGetToken<R extends boolean = false>(
  params: GetTokenParams<R>
): Promise<R extends true ? string : JWT | null> {
  const {
    req,
    secureCookie = process.env.NEXTAUTH_URL?.startsWith("https://") ??
      !!process.env.VERCEL,
    cookieName = "next-auth.session-token",
    raw,
    decode: _decode = decode,
    logger = console,
    secret = process.env.NEXTAUTH_SECRET,
  } = params;

  if (!req) throw new Error("Must pass `req` to JWT getToken()");

  const sessionStore = new SessionStore(
    { name: cookieName, options: { secure: secureCookie } },
    { cookies: req.cookies, headers: req.headers },
    logger
  );

  let token = sessionStore.value;

  const authorizationHeader =
    req.headers instanceof Headers
      ? req.headers.get("authorization")
      : req.headers?.authorization;

  if (!token && authorizationHeader?.split(" ")[0] === "Bearer") {
    const urlEncodedToken = authorizationHeader.split(" ")[1];
    token = decodeURIComponent(urlEncodedToken);
  }

  // @ts-expect-error
  if (!token) return null;

  // @ts-expect-error
  if (raw) return token;

  try {
    // @ts-expect-error
    return await _decode({ token, secret });
  } catch {
    // @ts-expect-error
    return null;
  }
}

export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions);
  const searchParams = req.nextUrl.searchParams;
  const port = searchParams.get("port") || "";

  const token = await customGetToken({
    req,
    secret: process.env.NEXTAUTH_SECRET ?? "",
  });

  if (!token) {
    return Response.redirect(
      `${process.env.NEXT_PUBLIC_URL}/login?next=${process.env.NEXT_PUBLIC_URL}/api/desktop/session/request?port=${port}`
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
