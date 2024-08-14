import { type NextRequest } from "next/server";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

export const revalidate = 3500;

type FileKey = {
  type: "screen";
  key: string;
};

type ResponseObject = {
  screen: string | null;
};

export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const userId = searchParams.get("userId");
  const videoId = searchParams.get("videoId");

  if (!userId || !videoId) {
    return new Response(
      JSON.stringify({
        error: true,
        message: "userId or videoId not supplied",
      }),
      {
        status: 400,
        headers: { "Content-Type": "application/json" },
      }
    );
  }

  const s3Client = new S3Client({
    region: process.env.NEXT_PUBLIC_CAP_AWS_REGION || "",
    credentials: {
      accessKeyId: process.env.CAP_AWS_ACCESS_KEY || "",
      secretAccessKey: process.env.CAP_AWS_SECRET_KEY || "",
    },
  });

  const bucket = process.env.NEXT_PUBLIC_CAP_AWS_BUCKET;
  const fileKeys: FileKey[] = [
    {
      type: "screen",
      key: `${userId}/${videoId}/screenshot/screen-capture.jpg`,
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

  return new Response(JSON.stringify(responseObject), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
