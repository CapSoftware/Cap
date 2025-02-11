import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { db } from '@cap/database';
import { spaces } from '@cap/database/schema';
import { eq } from 'drizzle-orm';

export async function middleware(request: NextRequest) {
  const hostname = request.headers.get('host');
  const path = request.nextUrl.pathname;

  if (!hostname) return NextResponse.next();

  // Skip for main domains
  if (hostname.includes('cap.so') || hostname.includes('cap.link') || hostname.includes('localhost')) {
    return NextResponse.next();
  }

  // We're on a custom domain at this point
  // Only allow /s/ routes for custom domains
  if (!path.startsWith('/s/')) {
    const url = new URL(request.url);
    url.hostname = 'cap.so';
    return NextResponse.redirect(url);
  }

  try {
    // Query the space with this custom domain
    const [space] = await db
      .select()
      .from(spaces)
      .where(eq(spaces.customDomain, hostname));

    if (!space || !space.domainVerified) {
      // If no verified custom domain found, redirect to main domain
      const url = new URL(request.url);
      url.hostname = 'cap.so';
      return NextResponse.redirect(url);
    }

    // Allow the request to continue to the destination
    return NextResponse.next();
  } catch (error) {
    console.error('Error in middleware:', error);
    return NextResponse.next();
  }
}

export const config = {
  matcher: ['/((?!api|_next/static|_next/image|favicon.ico).*)']
};