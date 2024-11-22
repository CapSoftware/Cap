import { type NextRequest } from "next/server";
import { db } from "@cap/database";
import { s3Buckets } from "@cap/database/schema";
import { getCurrentUser } from "@cap/database/auth/session";
import { eq } from "drizzle-orm";
import { cookies } from "next/headers";

const allowedOrigins = [
  process.env.NEXT_PUBLIC_URL,
  "http://localhost:3001",
  "http://localhost:3000",
  "tauri://localhost",
  "http://tauri.localhost",
  "https://tauri.localhost",
];

export async function OPTIONS(req: NextRequest) {
  const params = req.nextUrl.searchParams;
  const origin = params.get("origin") || null;
  const originalOrigin = req.nextUrl.origin;

  return new Response(null, {
    status: 200,
    headers: {
      "Access-Control-Allow-Origin":
        origin && allowedOrigins.includes(origin)
          ? origin
          : allowedOrigins.includes(originalOrigin)
          ? originalOrigin
          : "null",
      "Access-Control-Allow-Credentials": "true",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers":
        "Content-Type, Authorization, sentry-trace, baggage",
    },
  });
}

export async function GET(request: NextRequest) {
  const token = request.headers.get("authorization")?.split(" ")[1];
  if (token) {
    cookies().set({
      name: "next-auth.session-token",
      value: token,
      path: "/",
      sameSite: "none",
      secure: true,
      httpOnly: true,
    });
  }

  const params = request.nextUrl.searchParams;
  const origin = params.get("origin") || null;
  const originalOrigin = request.nextUrl.origin;

  try {
    const user = await getCurrentUser();
    if (!user) {
      return new Response(JSON.stringify({ error: "Not authenticated" }), {
        status: 401,
        headers: {
          "Access-Control-Allow-Origin":
            origin && allowedOrigins.includes(origin)
              ? origin
              : allowedOrigins.includes(originalOrigin)
              ? originalOrigin
              : "null",
          "Access-Control-Allow-Credentials": "true",
        },
      });
    }

    const config = await db
      .select({
        accessKeyId: s3Buckets.accessKeyId,
        secretAccessKey: s3Buckets.secretAccessKey,
        endpoint: s3Buckets.endpoint,
        bucketName: s3Buckets.bucketName,
        region: s3Buckets.region,
      })
      .from(s3Buckets)
      .where(eq(s3Buckets.ownerId, user.id));

    return new Response(
      JSON.stringify({
        config: config[0] || null,
      }),
      {
        status: 200,
        headers: {
          "Access-Control-Allow-Origin":
            origin && allowedOrigins.includes(origin)
              ? origin
              : allowedOrigins.includes(originalOrigin)
              ? originalOrigin
              : "null",
          "Access-Control-Allow-Credentials": "true",
        },
      }
    );
  } catch (error) {
    console.error("Error fetching S3 config:", error);
    return new Response(
      JSON.stringify({ error: "Failed to fetch S3 configuration" }),
      {
        status: 500,
        headers: {
          "Access-Control-Allow-Origin":
            origin && allowedOrigins.includes(origin)
              ? origin
              : allowedOrigins.includes(originalOrigin)
              ? originalOrigin
              : "null",
          "Access-Control-Allow-Credentials": "true",
        },
      }
    );
  }
} 