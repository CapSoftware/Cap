import { createMiddlewareClient } from "@supabase/auth-helpers-nextjs";
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

// this middleware refreshes the user's session and must be run
// for any Server Component route that uses `createServerComponentSupabaseClient`
export async function middleware(req: NextRequest) {
  const res = NextResponse.next();

  const supabase = createMiddlewareClient({ req, res });

  const {
    data: { session },
  } = await supabase.auth.getSession();

  let redirectUrl = req.nextUrl.clone();

  // Auth condition not met, redirect to home page.
  if (!session && req.nextUrl.pathname.startsWith("/dashboard")) {
    redirectUrl.pathname = "/login";
    redirectUrl.searchParams.set(`redirectedFrom`, req.nextUrl.pathname);
    return NextResponse.redirect(redirectUrl);
  }

  if (session?.access_token && req.nextUrl.pathname === "/dashboard") {
    redirectUrl.pathname = "/dashboard/caps";
    return NextResponse.redirect(redirectUrl);
  }

  return res;
}
