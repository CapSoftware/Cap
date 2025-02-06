import { type NextRequest } from "next/server";
import { db } from "@cap/database";
import { s3Buckets } from "@cap/database/schema";
import { eq } from "drizzle-orm";
import { getCurrentUser } from "@cap/database/auth/session";
import { encrypt } from "@cap/database/crypto";
import { cookies } from "next/headers";
import { nanoId } from "@cap/database/helpers";

export async function POST(request: NextRequest) {
  try {
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

    const user = await getCurrentUser();
    const origin = request.headers.get("origin") as string;

    if (!user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: {
          "Access-Control-Allow-Origin": origin,
          "Access-Control-Allow-Credentials": "true",
        },
      });
    }

    const data = await request.json();

    // Encrypt the sensitive data
    const encryptedConfig = {
      id: nanoId(),
      provider: data.provider,
      accessKeyId: await encrypt(data.accessKeyId),
      secretAccessKey: await encrypt(data.secretAccessKey),
      endpoint: data.endpoint ? await encrypt(data.endpoint) : null,
      bucketName: await encrypt(data.bucketName),
      region: await encrypt(data.region),
      ownerId: user.id,
    };

    // Check if user already has a bucket config
    const [existingBucket] = await db
      .select()
      .from(s3Buckets)
      .where(eq(s3Buckets.ownerId, user.id));

    if (existingBucket) {
      // Update existing config
      await db
        .update(s3Buckets)
        .set(encryptedConfig)
        .where(eq(s3Buckets.id, existingBucket.id));
    } else {
      // Insert new config
      await db.insert(s3Buckets).values(encryptedConfig);
    }

    return new Response(JSON.stringify({ success: true }), {
      headers: {
        "Access-Control-Allow-Origin": origin,
        "Access-Control-Allow-Credentials": "true",
      },
    });
  } catch (error) {
    console.error("Error in S3 config route:", error);
    return new Response(
      JSON.stringify({
        error: "Failed to save S3 configuration",
        details: error instanceof Error ? error.message : String(error),
      }),
      {
        status: 500,
        headers: {
          "Access-Control-Allow-Origin": request.headers.get(
            "origin"
          ) as string,
          "Access-Control-Allow-Credentials": "true",
        },
      }
    );
  }
}

export async function OPTIONS(request: NextRequest) {
  return new Response(null, {
    status: 200,
    headers: {
      "Access-Control-Allow-Origin": request.headers.get("origin") as string,
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Access-Control-Allow-Credentials": "true",
    },
  });
}
