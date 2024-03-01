import { NextResponse, type NextRequest } from "next/server";

export async function GET(req: NextRequest) {
  const searchParams = req.nextUrl.searchParams;
  const token = searchParams.get("token");
  const redirect = searchParams.get("redirect");

  console.log("Route.ts fired");

  console.log("Token: ", token);
  console.log("Redirect: ", redirect);

  if (!token) {
    return new Response(
      JSON.stringify({ error: true, message: "Token not supplied" }),
      {
        status: 401,
        headers: {
          "Content-Type": "application/json",
        },
      }
    );
  }

  const response = NextResponse.next();
  response.cookies.set({
    name: `next-auth.session-token`,
    value: token,
    path: "/",
  });

  return NextResponse.redirect(redirect || "/");
}
