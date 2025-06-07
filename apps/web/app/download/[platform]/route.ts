import { NextRequest, NextResponse } from "next/server";

export const runtime = "edge";

// Disable caching to ensure users always get the latest download URL
export const revalidate = 0;

export async function GET(
  request: NextRequest,
  { params }: { params: { platform: string } }
) {
  const platform = params.platform.toLowerCase();

  // Define download URLs for different platforms
  const downloadUrls: Record<string, string> = {
    "apple-intel":
      "https://cdn.crabnebula.app/download/cap/cap/latest/platform/dmg-x86_64",
    intel:
      "https://cdn.crabnebula.app/download/cap/cap/latest/platform/dmg-x86_64", // Keep for backward compatibility
    mac: "https://cdn.crabnebula.app/download/cap/cap/latest/platform/dmg-aarch64", // Default to Apple Silicon
    macos:
      "https://cdn.crabnebula.app/download/cap/cap/latest/platform/dmg-aarch64", // Default to Apple Silicon
    "apple-silicon":
      "https://cdn.crabnebula.app/download/cap/cap/latest/platform/dmg-aarch64",
    aarch64:
      "https://cdn.crabnebula.app/download/cap/cap/latest/platform/dmg-aarch64",
    x86_64:
      "https://cdn.crabnebula.app/download/cap/cap/latest/platform/dmg-x86_64",
    windows:
      "https://cdn.crabnebula.app/download/cap/cap/latest/platform/nsis-x86_64",
    win: "https://cdn.crabnebula.app/download/cap/cap/latest/platform/nsis-x86_64",
  };

  // Get the download URL for the requested platform
  const downloadUrl = downloadUrls[platform];

  // If the platform is not supported, redirect to the main download page
  if (!downloadUrl) {
    return NextResponse.redirect(new URL("/download", request.url));
  }

  // Redirect to the appropriate download URL
  return NextResponse.redirect(downloadUrl);
}
