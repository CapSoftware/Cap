import { NextRequest, NextResponse } from "next/server";

export const runtime = "edge";
export const revalidate = 0;

export async function GET(request: NextRequest) {
  // Get the user agent string
  const userAgent = request.headers.get("user-agent") || "";
  
  // Determine the platform based on the user agent
  let platform = "apple-silicon"; // Default to Apple Silicon
  
  if (userAgent.includes("Windows")) {
    platform = "windows";
  } else if (userAgent.includes("Mac")) {
    // Check for Intel Mac
    if (userAgent.includes("Intel")) {
      platform = "apple-intel";
    } else {
      // Assume Apple Silicon for newer Macs
      platform = "apple-silicon";
    }
  }
  
  // Redirect to the appropriate platform-specific download route
  return NextResponse.redirect(new URL(`/download/${platform}`, request.url));
} 