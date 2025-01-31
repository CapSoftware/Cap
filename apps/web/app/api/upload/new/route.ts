import { type NextRequest } from "next/server";
import { getCurrentUser } from "@cap/database/auth/session";
import { uploadToS3 } from "@/utils/video/upload/helpers";
import { clientEnv } from "@cap/env";

export async function POST(request: NextRequest) {
  const user = await getCurrentUser();
  const formData = await request.formData();
  const filename = formData.get("filename");
  const videoId = formData.get("videoId");
  const blobData = formData.get("blobData") as Blob;
  const duration = formData.get("duration");
  const resolution = formData.get("resolution");
  const videoCodec = formData.get("videoCodec");
  const audioCodec = formData.get("audioCodec");

  const awsRegion = clientEnv.NEXT_PUBLIC_CAP_AWS_REGION;
  const awsBucket = clientEnv.NEXT_PUBLIC_CAP_AWS_BUCKET;

  if (!user || !awsRegion || !awsBucket || !filename || !blobData) {
    console.error("Missing required data in /api/upload/new/route.ts");

    return Response.json({ error: true }, { status: 401 });
  }

  const fullFilepath = `${user.id}/${videoId}/${filename}`;

  const upload = await uploadToS3({
    filename: fullFilepath,
    userId: user.id,
    blobData,
    duration: duration as string,
    resolution: resolution as string,
    videoCodec: videoCodec as string,
    audioCodec: audioCodec as string,
    awsBucket,
    awsRegion,
  });

  if (!upload) {
    console.error("Upload failed");

    return Response.json({ error: true }, { status: 500 });
  }

  console.log("Upload successful");

  return Response.json(true, { status: 200 });
}
