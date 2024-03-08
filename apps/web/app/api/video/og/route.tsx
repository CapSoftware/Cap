import { db } from "@cap/database";
import { videos } from "@cap/database/schema";
import { eq } from "drizzle-orm";
import { ImageResponse } from "next/og";
import { NextRequest } from "next/server";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { Play } from "lucide-react";

export const runtime = "edge";

export async function GET(req: NextRequest) {
  const videoId = req.nextUrl.searchParams.get("videoId") as string;
  const query = await db.select().from(videos).where(eq(videos.id, videoId));

  type FileKey = {
    type: "screen";
    key: string;
  };

  type ResponseObject = {
    screen: string | null;
  };

  if (query.length === 0 || query?.[0]?.public === false) {
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
              "radial-gradient(90.01% 80.01% at 53.53% 49.99%,#d3e5ff 30.65%,#82c6f1 88.48%,#fff 100%)",
          }}
        >
          <h1 style={{ fontSize: "40px" }}>Video not found</h1>
        </div>
      ),
      {
        width: 1200,
        height: 630,
      }
    );
  }

  const video = query[0];

  const s3Client = new S3Client({
    region: process.env.CAP_AWS_REGION || "",
    credentials: {
      accessKeyId: process.env.CAP_AWS_ACCESS_KEY || "",
      secretAccessKey: process.env.CAP_AWS_SECRET_KEY || "",
    },
  });

  const bucket = process.env.CAP_AWS_BUCKET;
  const fileKeys: FileKey[] = [
    {
      type: "screen",
      key: `${video.ownerId}/${video.id}/screenshot/screen-capture.jpg`,
    },
  ];

  const responseObject: ResponseObject = {
    screen: null,
  };

  await Promise.all(
    fileKeys.map(async ({ type, key }) => {
      try {
        const url = await getSignedUrl(
          s3Client,
          new GetObjectCommand({ Bucket: bucket, Key: key }),
          { expiresIn: 3600 }
        );
        responseObject[type] = url;
      } catch (error) {
        console.error("Error generating URL for:", key, error);
        responseObject[type] = null;
      }
    })
  );

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
            "radial-gradient(90.01% 80.01% at 53.53% 49.99%,#d3e5ff 30.65%,#82c6f1 88.48%,#fff 100%)",
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
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <polygon points="6 3 20 12 6 21 6 3"></polygon>
            </svg>
          </div>
          {responseObject.screen && (
            <img
              style={{
                width: "100%",
                height: "100%",
                position: "absolute",
                objectFit: "cover",
                opacity: 0.4,
                zIndex: 1,
              }}
              src={responseObject.screen}
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
