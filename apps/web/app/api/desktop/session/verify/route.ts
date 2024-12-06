import { type NextRequest } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@cap/database/auth/auth-options";

export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions);

  if (session) {
    return Response.json(
      { isLoggedIn: true, user: session.user },
      { status: 200 }
    );
  } else return Response.json({ isLoggedIn: false }, { status: 401 });
}
