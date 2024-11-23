import { type NextRequest } from "next/server";
import { db } from "@cap/database";
import { s3Buckets } from "@cap/database/schema";
import { getCurrentUser } from "@cap/database/auth/session";
import { eq } from "drizzle-orm";
import { encrypt } from "@cap/database/crypto";
import { nanoId } from "@cap/database/helpers";
import { getCorsHeaders, getOptionsHeaders } from "@/utils/cors";
import { cookies } from "next/headers";

export async function OPTIONS(req: NextRequest) {
  console.log("[S3 Config] OPTIONS request received");
  const params = req.nextUrl.searchParams;
  const origin = params.get("origin") || null;
  const originalOrigin = req.nextUrl.origin;

  console.log("[S3 Config] Responding to OPTIONS request", { origin, originalOrigin });
  return new Response(null, {
    status: 200,
    headers: getOptionsHeaders(origin, originalOrigin, "POST, OPTIONS"),
  });
}

export async function POST(request: NextRequest) {
  console.log("[S3 Config] POST request received");
  const params = request.nextUrl.searchParams;
  const origin = params.get("origin") || null;
  const originalOrigin = request.nextUrl.origin;

  // Handle authentication token
  const token = request.headers.get("authorization")?.split(" ")[1];
  if (token) {
    console.log("[S3 Config] Setting auth token cookie");
    cookies().set({
      name: "next-auth.session-token",
      value: token,
      path: "/",
      sameSite: "none",
      secure: true,
      httpOnly: true,
    });
  } else {
    console.log("[S3 Config] No auth token provided");
  }

  try {
    const user = await getCurrentUser();
    if (!user) {
      console.log("[S3 Config] User not authenticated");
      return new Response(JSON.stringify({ error: "Not authenticated" }), {
        status: 401,
        headers: getCorsHeaders(origin, originalOrigin),
      });
    }

    console.log("[S3 Config] User authenticated", { userId: user.id });

    const { provider, accessKeyId, secretAccessKey, endpoint, bucketName, region } =
      await request.json();

    console.log("[S3 Config] Received S3 config data", {
      provider,
      hasAccessKeyId: !!accessKeyId,
      hasSecretKey: !!secretAccessKey,
      endpoint,
      bucketName,
      region
    });

    // Get existing bucket for this user
    const existingBucket = await db
      .select()
      .from(s3Buckets)
      .where(eq(s3Buckets.ownerId, user.id));

    console.log("[S3 Config] Existing bucket found:", { exists: existingBucket.length > 0 });

    // Encrypt sensitive data before storing
    const encryptedData = {
      id: existingBucket[0]?.id || nanoId(),
      provider,
      accessKeyId: encrypt(accessKeyId),
      secretAccessKey: encrypt(secretAccessKey),
      endpoint: endpoint ? encrypt(endpoint) : null,
      bucketName: encrypt(bucketName),
      region: encrypt(region),
      ownerId: user.id,
    };

    console.log("[S3 Config] Encrypted data prepared", { id: encryptedData.id });

    await db
      .insert(s3Buckets)
      .values(encryptedData)
      .onDuplicateKeyUpdate({
        set: {
          provider: encryptedData.provider,
          accessKeyId: encryptedData.accessKeyId,
          secretAccessKey: encryptedData.secretAccessKey,
          endpoint: encryptedData.endpoint,
          bucketName: encryptedData.bucketName,
          region: encryptedData.region,
        },
      });

    console.log("[S3 Config] Successfully saved S3 configuration");

    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: getCorsHeaders(origin, originalOrigin),
    });
  } catch (error) {
    console.error("[S3 Config] Error saving S3 config:", error);
    return new Response(
      JSON.stringify({ 
        error: "Failed to save S3 configuration",
        details: error instanceof Error ? error.message : 'Unknown error'
      }),
      {
        status: 500,
        headers: getCorsHeaders(origin, originalOrigin),
      }
    );
  }
}