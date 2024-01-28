import { type NextRequest } from "next/server";
import { getCurrentUser } from "@cap/database/auth/session";
import { uploadToS3 } from "@/utils/video/upload/helpers";

export async function POST(request: NextRequest) {
  const user = await getCurrentUser();
  const awsRegion = process.env.CAP_AWS_REGION;
  const awsBucket = process.env.CAP_AWS_BUCKET;
  const formData = await request.formData();
  const filename = formData.get("filename");
  const videoId = formData.get("videoId");
  const blobData = formData.get("blobData");

  console.log("filename:", filename);

  if (!user || !awsRegion || !awsBucket || !filename || !blobData) {
    console.error("Missing required data in /api/upload/new/route.ts");

    return new Response(JSON.stringify({ error: true }), {
      status: 401,
      headers: {
        "Content-Type": "application/json",
      },
    });
  }

  const fullFilepath = `${user.userId}/${videoId}/${filename}`;

  const upload = await uploadToS3(
    fullFilepath,
    blobData,
    user.userId,
    awsBucket,
    awsRegion
  );

  if (!upload) {
    console.error("Upload failed");

    return new Response(JSON.stringify({ error: true }), {
      status: 500,
      headers: {
        "Content-Type": "application/json",
      },
    });
  }

  console.log("Upload successful");

  return new Response(
    JSON.stringify({
      status: 200,
      headers: {
        "Content-Type": "application/json",
      },
    })
  );
}
