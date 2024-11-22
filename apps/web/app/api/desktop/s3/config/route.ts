import { type NextRequest } from "next/server";
import { db } from "@cap/database";
import { s3Buckets, users } from "@cap/database/schema";
import { getCurrentUser } from "@cap/database/auth/session";
import { eq } from "drizzle-orm";
import { nanoId } from "@cap/database/helpers";
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

  console.log("Handling OPTIONS request");
  console.log("OPTIONS request params:", { origin, originalOrigin });

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
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers":
        "Content-Type, Authorization, sentry-trace, baggage",
    },
  });
}

export async function POST(request: NextRequest) {
  console.log("Handling POST request");
  
  const token = request.headers.get("authorization")?.split(" ")[1];
  if (token) {
    console.log("Setting session token cookie");
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

  console.log("POST request params:", { origin, originalOrigin });

  try {
    console.log("Attempting to save S3 configuration");
    const user = await getCurrentUser();
    if (!user) {
      console.log("User not authenticated");
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

    console.log("User authenticated:", user.id);

    const body = await request.json();
    const { accessKeyId, secretAccessKey, endpoint, bucketName, region } = body;

    console.log("Received S3 config request:", { endpoint, bucketName, region });

    // Validate required fields
    if (!accessKeyId || !secretAccessKey || !bucketName) {
      return new Response(
        JSON.stringify({ error: "Missing required fields" }),
        {
          status: 400,
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

    console.log("Checking for existing S3 configuration");
    const existingConfigs = await db
      .select()
      .from(s3Buckets)
      .where(eq(s3Buckets.ownerId, user.id));

    const existingConfig = existingConfigs[0];
    console.log("Existing config found:", !!existingConfig);

    let bucketId: string;
    if (existingConfig) {
      bucketId = existingConfig.id;
      console.log("Updating existing S3 configuration");
      await db
        .update(s3Buckets)
        .set({
          accessKeyId,
          secretAccessKey,
          endpoint,
          bucketName,
          region,
        })
        .where(eq(s3Buckets.id, bucketId));
    } else {
      console.log("Creating new S3 configuration for user:", user.id);
      bucketId = nanoId();
      await db.insert(s3Buckets).values({
        id: bucketId,
        ownerId: user.id,
        region: region || "us-east-1",
        endpoint,
        bucketName,
        accessKeyId,
        secretAccessKey,
      });
      console.log("Successfully created new S3 configuration");
    }

    console.log("Updating user's customBucket field");
    await db
      .update(users)
      .set({
        customBucket: bucketId,
      })
      .where(eq(users.id, user.id));

    console.log("S3 configuration saved successfully");
    return new Response(JSON.stringify({ success: true }), {
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
    });
  } catch (error) {
    console.error("Error saving S3 config:", error);
    return new Response(
      JSON.stringify({ error: "Failed to save S3 configuration" }),
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