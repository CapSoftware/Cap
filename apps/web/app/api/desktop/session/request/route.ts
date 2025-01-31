import { type NextRequest } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@cap/database/auth/auth-options";
import { decode } from "next-auth/jwt";
import { getCurrentUser } from "@cap/database/auth/session";
import { clientEnv, serverEnv } from "@cap/env";

export async function GET(req: NextRequest) {
  const searchParams = req.nextUrl.searchParams;
  const session = await getServerSession(authOptions);
  const port = searchParams.get("port") || "";
  const platform = searchParams.get("platform") || "web";

  const secret = serverEnv.NEXTAUTH_SECRET;

  const loginRedirectUrl = `${clientEnv.NEXT_PUBLIC_WEB_URL}/login?next=${clientEnv.NEXT_PUBLIC_WEB_URL}/api/desktop/session/request?port=${port}`;
  if (!session) {
    return Response.redirect(loginRedirectUrl);
  }

  const token = req.cookies.get("next-auth.session-token") ?? null;
  const tokenValue = token?.value ?? null;
  const user = await getCurrentUser();

  if (!tokenValue || !user) {
    return Response.redirect(loginRedirectUrl);
  }

  const decodedToken = await decode({
    token: tokenValue,
    secret: secret as string,
  });

  if (!decodedToken) {
    return Response.redirect(loginRedirectUrl);
  }

  const params = `token=${tokenValue}&expires=${decodedToken?.exp}&user_id=${user.id}`;

  const returnUrl = new URL(
    platform === "web"
      ? `http://127.0.0.1:${port}?${params}`
      : `cap-desktop://signin?${params}`
  );

  return Response.redirect(returnUrl.href);
}
