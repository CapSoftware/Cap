import { type NextRequest } from "next/server";
import { db } from "@cap/database";
import { s3Buckets } from "@cap/database/schema";
import { eq } from "drizzle-orm";
import { getCurrentUser } from "@cap/database/auth/session";
import { cookies } from "next/headers";

export async function DELETE(request: NextRequest) {
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

    // Delete the S3 configuration for the user
    await db.delete(s3Buckets).where(eq(s3Buckets.ownerId, user.id));

    return Response.json(
      { success: true },
      {
        headers: {
          "Access-Control-Allow-Origin": origin,
          "Access-Control-Allow-Credentials": "true",
        },
      }
    );
  } catch (error) {
    console.error("Error in S3 config delete route:", error);
    return Response.json(
      {
        error: "Failed to delete S3 configuration",
        details: error instanceof Error ? error.message : String(error),
      },
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
      "Access-Control-Allow-Methods": "DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Access-Control-Allow-Credentials": "true",
    },
  });
}
