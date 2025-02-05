import { ImageResponse } from "next/og";
import { NextRequest } from "next/server";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { createS3Client, getS3Bucket } from "@/utils/s3";
import { clientEnv } from "@cap/env";

export const runtime = "edge";

export async function GET(req: NextRequest) {
  const videoId = req.nextUrl.searchParams.get("videoId") as string;

  const response = await fetch(
    `${clientEnv.NEXT_PUBLIC_WEB_URL}/api/video/${videoId}`,
    {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
      },
    }
  );

  if (!response.ok) {
    return new ImageResponse(
      (
        <div
          style={{
            width: "100%",
            height: "100%",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            background:
              "radial-gradient(90.01% 80.01% at 53.53% 49.99%,#d3e5ff 30.65%,#4785ff 88.48%,#fff 100%)",
          }}
        >
          <h1 style={{ fontSize: "60px" }}>Cap not found</h1>
          <p style={{ fontSize: "30px" }}>
            The video you are looking for does not exist or has moved.
          </p>
        </div>
      ),
      {
        width: 1200,
        height: 630,
      }
    );
  }

  const { video, bucket } = await response.json();

  if (!video || !bucket || video.public === false) {
    return new ImageResponse(
      (
        <div
          style={{
            width: "100%",
            height: "100%",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            background:
              "radial-gradient(90.01% 80.01% at 53.53% 49.99%,#d3e5ff 30.65%,#4785ff 88.48%,#fff 100%)",
          }}
        >
          <h1 style={{ fontSize: "40px" }}>Video or bucket not found</h1>
        </div>
      ),
      {
        width: 1200,
        height: 630,
      }
    );
  }

  const s3Client = await createS3Client(bucket);
  const Bucket = await getS3Bucket(bucket);

  const screenshotKey = `${video.ownerId}/${video.id}/screenshot/screen-capture.jpg`;
  let screenshotUrl = null;

  try {
    screenshotUrl = await getSignedUrl(
      s3Client,
      new GetObjectCommand({ Bucket, Key: screenshotKey }),
      { expiresIn: 3600 }
    );
  } catch (error) {
    console.error("Error generating URL for screenshot:", error);
  }

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background:
            "radial-gradient(90.01% 80.01% at 53.53% 49.99%,#d3e5ff 30.65%,#4785ff 88.48%,#fff 100%)",
        }}
      >
        <div
          style={{
            width: "85%",
            height: "85%",
            display: "flex",
            borderRadius: "10px",
            overflow: "hidden",
            position: "relative",
            background: "#000",
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              width: "200px",
              height: "200px",
              position: "absolute",
              top: "50%",
              left: "50%",
              transform: "translate(-50%, -50%)",
              zIndex: 10,
            }}
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              style={{
                width: "100%",
                height: "100%",
                color: "#ffffff",
                display: "flex",
              }}
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <polygon points="6 3 20 12 6 21 6 3"></polygon>
            </svg>
          </div>
          {screenshotUrl && (
            <img
              style={{
                width: "100%",
                height: "100%",
                position: "absolute",
                objectFit: "cover",
                opacity: 0.4,
                zIndex: 1,
              }}
              src={screenshotUrl}
            />
          )}
        </div>
      </div>
    ),
    {
      width: 1200,
      height: 630,
    }
  );
}
