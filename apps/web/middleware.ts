import { NextRequest, NextResponse } from "next/server";

const VERCEL_DEPLOYMENT = !!process.env.VERCEL_URL;

export function middleware(request: NextRequest) {
  if (request.nextUrl.pathname.includes("/api/desktop/")) {
    const token = request.headers.get("authorization")?.split(" ")[1];

    const cookieIsSet = request.cookies.get(
      `${
        process.env.NEXT_PUBLIC_ENVIRONMENT === "development" ? "__Secure-" : ""
      }next-auth.session-token`
    );

    if (cookieIsSet) {
      console.log("Cookie is set");
      return NextResponse.next();
    }

    if (token && !cookieIsSet) {
      const response = NextResponse.next();
      response.cookies.set({
        name: `${VERCEL_DEPLOYMENT ? "__Secure-" : ""}next-auth.session-token`,
        value: token,
        path: "/",
        sameSite: "none",
        secure: VERCEL_DEPLOYMENT,
        httpOnly: true,
        domain: VERCEL_DEPLOYMENT ? ".cap.so" : undefined,
      });
      return response;
    }
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/api/desktop/(.*)"],
};
