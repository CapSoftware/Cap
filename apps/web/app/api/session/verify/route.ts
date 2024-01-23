import { type NextRequest } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@cap/database/auth/auth-options";

export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions);
  const searchParams = req.nextUrl.searchParams;
  const redirectUrl = searchParams.get("redirectUrl") || "";

  if (session) {
    return Response.redirect(redirectUrl);
  } else {
    // No active session
    return new Response(JSON.stringify({ isLoggedIn: false }), {
      status: 401,
      headers: {
        "Content-Type": "application/json",
      },
    });
  }
}
