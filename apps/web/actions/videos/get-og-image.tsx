import { ImageResponse } from "next/og";
import { createBucketProvider } from "@/utils/s3";
import { db } from "@cap/database";
import { s3Buckets, videos } from "@cap/database/schema";
import { eq } from "drizzle-orm";

export async function generateVideoOgImage(videoId: string) {
  const videoData = await getData(videoId);

  if (!videoData) {
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

  const { video } = videoData;

  if (!video || video.public === false) {
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

  const bucket = await createBucketProvider(videoData.bucket);

  const screenshotKey = `${video.ownerId}/${video.id}/screenshot/screen-capture.jpg`;
  let screenshotUrl = null;

  try {
    screenshotUrl = await bucket.getSignedObjectUrl(screenshotKey);
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

async function getData(videoId: string) {
  const query = await db()
    .select({
      video: videos,
      bucket: s3Buckets,
    })
    .from(videos)
    .leftJoin(s3Buckets, eq(videos.bucket, s3Buckets.id))
    .where(eq(videos.id, videoId));

  const result = query[0];

  if (!result) return;

  return {
    video: result.video,
    bucket: result.bucket,
  };
}
