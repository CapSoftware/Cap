import { NextRequest, NextResponse } from "next/server";

export function middleware(request: NextRequest) {
  if (request.nextUrl.pathname.startsWith("/api/desktop/")) {
    const token = request.headers.get("authorization")?.split(" ")[1];
    const cookieIsSet = request.cookies.get("next-auth.session-token");

    if (cookieIsSet) {
      return NextResponse.next();
    }

    if (token && !cookieIsSet) {
      const response = NextResponse.next();
      response.cookies.set({
        name: "next-auth.session-token",
        value: token,
        path: "/",
      });
      return response;
    }
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/api/desktop/(.*)"],
};
