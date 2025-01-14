import { type NextRequest } from "next/server";
import { db } from "@cap/database";
import { s3Buckets } from "@cap/database/schema";
import { eq } from "drizzle-orm";
import { getCurrentUser } from "@cap/database/auth/session";
import { decrypt } from "@cap/database/crypto";
import { cookies } from "next/headers";

export async function OPTIONS(request: NextRequest) {
  console.log("OPTIONS request received for S3 config");
  return new Response(null, {
    status: 200,
    headers: {
      "Access-Control-Allow-Origin": request.headers.get("origin") as string,
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Access-Control-Allow-Credentials": "true",
    },
  });
}

export async function GET(request: NextRequest) {
  console.log("GET request received for S3 config");
  try {
    const token = request.headers.get("authorization")?.split(" ")[1];
    if (token) {
      console.log("Token found in authorization header, setting cookie");
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
    console.log("Origin:", origin);

    if (!user) {
      console.log("User not found, returning 401");
      return Response.json(
        { error: "Unauthorized" },
        {
          status: 401,
          headers: {
            "Access-Control-Allow-Origin": origin,
            "Access-Control-Allow-Methods": "GET, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type, Authorization",
            "Access-Control-Allow-Credentials": "true",
          },
        }
      );
    }

    console.log("Fetching S3 bucket for user:", user.id);
    const [bucket] = await db
      .select()
      .from(s3Buckets)
      .where(eq(s3Buckets.ownerId, user.id));

    if (!bucket) {
      console.log("No S3 bucket found for user, returning default config");
      return Response.json(
        {
          config: {
            provider: "aws",
            accessKeyId: "",
            secretAccessKey: "",
            endpoint: "https://s3.amazonaws.com",
            bucketName: "",
            region: "us-east-1",
          },
        },
        {
          headers: {
            "Access-Control-Allow-Origin": origin,
            "Access-Control-Allow-Methods": "GET, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type, Authorization",
            "Access-Control-Allow-Credentials": "true",
          },
        }
      );
    }

    console.log("Decrypting S3 config for bucket:", bucket.id);
    const decryptedConfig = {
      provider: bucket.provider,
      accessKeyId: await decrypt(bucket.accessKeyId),
      secretAccessKey: await decrypt(bucket.secretAccessKey),
      endpoint: bucket.endpoint
        ? await decrypt(bucket.endpoint)
        : "https://s3.amazonaws.com",
      bucketName: await decrypt(bucket.bucketName),
      region: await decrypt(bucket.region),
    };

    console.log("Returning decrypted S3 config");
    return Response.json(
      { config: decryptedConfig },
      {
        headers: {
          "Access-Control-Allow-Origin": origin,
          "Access-Control-Allow-Methods": "GET, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization",
          "Access-Control-Allow-Credentials": "true",
        },
      }
    );
  } catch (error) {
    console.error("Error in S3 config get route:", error);
    return Response.json(
      {
        error: "Failed to fetch S3 configuration",
        details: error instanceof Error ? error.message : String(error),
      },
      {
        status: 500,
        headers: {
          "Access-Control-Allow-Origin": request.headers.get(
            "origin"
          ) as string,
          "Access-Control-Allow-Methods": "GET, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization",
          "Access-Control-Allow-Credentials": "true",
        },
      }
    );
  }
}
