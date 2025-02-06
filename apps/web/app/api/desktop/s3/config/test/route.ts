import { type NextRequest } from "next/server";
import { getCurrentUser } from "@cap/database/auth/session";
import { cookies } from "next/headers";
import { S3Client, HeadBucketCommand } from "@aws-sdk/client-s3";

const TIMEOUT_MS = 5000; // 5 second timeout

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

    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
      controller.abort();
    }, TIMEOUT_MS);

    const s3Client = new S3Client({
      endpoint: data.endpoint,
      region: data.region,
      credentials: {
        accessKeyId: data.accessKeyId,
        secretAccessKey: data.secretAccessKey,
      },
      requestHandler: {
        abortSignal: controller.signal,
      },
    });

    try {
      await s3Client.send(
        new HeadBucketCommand({
          Bucket: data.bucketName,
        })
      );

      clearTimeout(timeoutId);
    } catch (error) {
      clearTimeout(timeoutId);
      let errorMessage = "Failed to connect to S3";

      if (error instanceof Error) {
        if (error.name === "AbortError" || error.name === "TimeoutError") {
          errorMessage =
            "Connection timed out after 5 seconds. Please check the endpoint URL and your network connection.";
        } else if (error.name === "NoSuchBucket") {
          errorMessage = `Bucket '${data.bucketName}' does not exist`;
        } else if (error.name === "NetworkingError") {
          errorMessage =
            "Network error. Please check the endpoint URL and your network connection.";
        } else if (error.name === "InvalidAccessKeyId") {
          errorMessage = "Invalid Access Key ID";
        } else if (error.name === "SignatureDoesNotMatch") {
          errorMessage = "Invalid Secret Access Key";
        } else if (error.name === "AccessDenied") {
          errorMessage =
            "Access denied. Please check your credentials and bucket permissions.";
        } else if ((error as any).$metadata?.httpStatusCode === 301) {
          errorMessage =
            "Received 301 redirect. This usually means the endpoint URL is incorrect or the bucket is in a different region.";
        }
      }

      return new Response(
        JSON.stringify({
          error: errorMessage,
          details: error instanceof Error ? error.message : String(error),
          metadata: (error as any)?.$metadata,
        }),
        {
          status: 500,
          headers: {
            "Access-Control-Allow-Origin": origin,
            "Access-Control-Allow-Credentials": "true",
          },
        }
      );
    }

    return new Response(JSON.stringify({ success: true }), {
      headers: {
        "Access-Control-Allow-Origin": origin,
        "Access-Control-Allow-Credentials": "true",
      },
    });
  } catch (error) {
    return new Response(
      JSON.stringify({
        error: "Failed to connect to S3",
        details: error instanceof Error ? error.message : String(error),
        metadata: (error as any)?.$metadata,
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
